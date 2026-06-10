-- ----------------------------------------------------------------------------
-- Onboarding Import (Phase 1: structural rent roll).
--
-- A landlord uploads an arbitrary Excel/CSV. We recognize what's in it,
-- map it to our schema through an interactive LLM-assisted flow, PREVIEW the
-- result (dry-run transaction, rolled back), and COMMIT it -- preserving every
-- existing invariant (audit trail, money integrity, idempotency, RLS,
-- service-role quarantine). Money (charges/payments) is explicitly Phase 2 and
-- is NOT built here; this migration backs the structural spine only:
--   property -> area(kind=unit) -> unit_details -> tenant -> tenancy ->
--   tenancy_member -> lease (optional) -> rent_schedule.
--
-- Three tables:
--
--   import_sessions    One row per uploaded file. Holds parsed REGION METADATA
--                      (sheet/range/columns/<=5 samples/row count -- never the
--                      full rows), the LLM's recognition + suggested mapping,
--                      the user's confirmed mapping / parent resolutions, the
--                      chat transcript, and the preview/commit results. A small
--                      state machine (`status`) drives the UI.
--
--   import_rows        The parsed rows of the file, one DB row per source row,
--                      kept here so the user can exclude individual rows and the
--                      executor can iterate without re-parsing. RAW cell values
--                      live here and NEVER leave our trust boundary -- only
--                      column names + <=5 samples per column are ever sent to
--                      the LLM.
--
--   import_provenance  The rollback spine. Every entity the executor creates on
--                      COMMIT is tagged here with (session_id, entity_type,
--                      entity_id, source region/row). A committed import is thus
--                      traceable end-to-end and undoable.
--
-- These three are workflow/scratch tables, NOT evidence: they deliberately do
-- NOT carry the audit trigger. The ENTITIES the import creates (properties,
-- tenancies, ...) are audited by their own triggers, attributed to
-- actor = 'system:import:<sessionId>' which the executor sets via audit.actor
-- inside its transaction (auth.uid() is NULL on the raw pg connection, so
-- audit.actor wins per the Phase 4 actor-integrity rule).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 1. Tables
-- ============================================================================

create table public.import_sessions (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.accounts(id) on delete restrict,
  status             text not null check (status in (
                       'parsing',            -- file received, being parsed
                       'recognizing',        -- LLM classifying regions
                       'awaiting_mapping',   -- needs user to confirm mapping
                       'no_importable_data', -- nothing structural recognized
                       'preview_ready',      -- a dry-run has been computed
                       'importing',          -- commit in progress
                       'done',               -- committed
                       'failed'              -- parse/recognition/commit error
                     )),
  source_filename    text not null check (length(source_filename) between 1 and 400),
  source_mime        text,
  source_bytes       bigint check (source_bytes is null or source_bytes >= 0),
  -- Object name in the private 'source-imports' bucket. The raw upload is an
  -- archival/audit artifact, read ONLY server-side via the service-role client.
  source_path        text,
  -- Parsed region metadata: [{sheet, range, columns:[{name,samples[]}],
  -- total_rows}]. NOT the full rows (those are import_rows).
  regions            jsonb not null default '[]'::jsonb,
  -- LLM recognition result per region: [{region_index, importable,
  -- entity_types:[{entity_type,confidence}], summary}].
  recognition        jsonb not null default '[]'::jsonb,
  -- Confirmed/active mapping: [{region_index, entity_type,
  -- fields:[{target_field, source_column, constant, confidence}]}]. Seeded from
  -- the LLM suggestion; the user overrides via PATCH /mapping.
  mapping            jsonb not null default '[]'::jsonb,
  -- Required-parent resolutions, e.g.
  -- {default_property_id, property_overrides:{"<name>":{mode,id}}}.
  parent_resolutions jsonb not null default '{}'::jsonb,
  -- Optional running transcript for the LLM-assisted mapping chat.
  chat               jsonb not null default '[]'::jsonb,
  -- Dry-run output: {counts, blockers, rows_processed, ...}.
  preview_summary    jsonb,
  -- Commit output: {counts, created:{entity_type:[ids]}, ...}.
  result             jsonb,
  -- Human-readable failure reason when status='failed' (or blocker note).
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  -- Composite uniqueness so child tables can FK on (account_id, id) and
  -- thereby pin every child to the SAME account at the DB layer.
  unique (account_id, id)
);
create index import_sessions_account_id_idx on public.import_sessions (account_id);
create index import_sessions_status_idx     on public.import_sessions (status);

create table public.import_rows (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  session_id    uuid not null,
  region_index  int  not null check (region_index >= 0),
  row_index     int  not null check (row_index >= 0),
  -- Raw cell values keyed by source column name. Stays in our DB; never
  -- forwarded to the LLM.
  raw           jsonb not null default '{}'::jsonb,
  -- The user can exclude individual rows from the import.
  excluded      boolean not null default false,
  -- Per-row blockers found at preview: [{field, message}].
  blockers      jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Composite FK keeps account_id = session.account_id at the DB.
  foreign key (account_id, session_id)
    references public.import_sessions(account_id, id) on delete cascade,
  unique (session_id, region_index, row_index)
);
create index import_rows_account_id_idx on public.import_rows (account_id);
create index import_rows_session_id_idx on public.import_rows (session_id);

create table public.import_provenance (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  session_id    uuid not null,
  entity_type   text not null check (length(entity_type) between 1 and 50),
  entity_id     uuid not null,
  region_index  int,
  row_index     int,
  created_at    timestamptz not null default now(),
  foreign key (account_id, session_id)
    references public.import_sessions(account_id, id) on delete cascade
);
create index import_provenance_account_id_idx on public.import_provenance (account_id);
create index import_provenance_session_id_idx on public.import_provenance (session_id);
create index import_provenance_entity_idx     on public.import_provenance (entity_type, entity_id);

-- Note: like every other domain table in this schema, `updated_at` is set
-- explicitly by the writer (route handlers / the import executor), not by a
-- trigger -- there is no global moddatetime trigger in this codebase.

-- ============================================================================
-- 2. RLS -- same per-account access model as every other domain table.
--
-- The import executor writes via a raw pg connection that does
-- `SET LOCAL role = service_role` (BYPASSRLS), so FORCE row security here does
-- not block it; ordinary session/row reads + mapping/parent/exclusion updates
-- go through the user client under these policies.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array['import_sessions', 'import_rows', 'import_provenance']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format($f$create policy %I on public.%I
                       for all
                       using      (public.is_account_member(account_id))
                       with check (public.is_account_member(account_id))$f$,
                   t || '_member_all', t);
  end loop;
end $$;

-- ============================================================================
-- 3. Storage: private 'source-imports' bucket.
--
-- Path scheme: <account_id>/<session_id>/source.<ext>. Unlike 'attachments'
-- (which grants member-read), this bucket gets NO authenticated policies at
-- all: the raw upload is read ONLY server-side via the service-role client for
-- archival/audit; account members never download it directly. Conditional on
-- the `storage` schema existing so the ephemeral-postgres test tier (vanilla
-- postgres) skips it cleanly.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute
      $sql$ insert into storage.buckets (id, name, public)
            values ('source-imports', 'source-imports', false)
            on conflict (id) do nothing $sql$;
  end if;
end $$;
