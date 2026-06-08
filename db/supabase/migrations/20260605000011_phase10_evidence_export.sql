-- ----------------------------------------------------------------------------
-- Phase 10: evidence export bundle.
--
-- The product's reason to exist: a single PDF that holds up in a dispute.
-- It bundles, for a scoped slice of an account, everything that matters --
-- lease(s), full rent ledger, interactions, maintenance requests, inspections,
-- notices, attached photos (with chain of custody) and the audit trail for
-- all of the above. The bundle is itself a content-hashed attachment whose
-- bytes are stamped with generated_at; the act of generating it is recorded
-- on the evidence_exports table (and so is audited like every other row).
--
-- The export deliberately works on ENDED / moved-out / soft-deleted tenancies
-- -- that's precisely when disputes happen (deposit return, post-eviction).
-- The export builder DOES NOT filter deleted_at IS NULL on its scope tenancy.
--
-- The audit-chain verification result is embedded INSIDE the bundle (a
-- prominent "audit chain verified intact as of <generated_at>" banner --
-- or, if broken, exactly that). That verification line is what makes the
-- bundle credible: a clean-looking PDF over a tampered chain would be
-- worse than no PDF at all.
-- ----------------------------------------------------------------------------

create table public.evidence_exports (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.accounts(id) on delete restrict,
  -- Scope. tenancy_id is optional (an export can target only an area, or be
  -- an account-wide audit dump if both are null and we ever choose to allow
  -- that). At least one of tenancy_id / area_id MUST be set so a default-
  -- empty body is rejected by check, not by silently emitting the whole
  -- account.
  tenancy_id      uuid,
  area_id         uuid,
  from_date       date,
  to_date         date,

  -- generated_at is the timestamp the export was rendered. It is what the
  -- PDF's CreationDate / ModDate carry and what the bundle's "as of" line
  -- displays. Two exports of the same scope WILL differ byte-for-byte
  -- (different generated_at = different PDF info dict = different content
  -- hash) -- this is intentional and called out in the brief.
  generated_at    timestamptz not null default now(),

  -- Audit-chain verification result captured AT TIME OF EXPORT. We snapshot
  -- it here so the row is self-contained for forensics; the PDF also embeds
  -- a human-readable banner.
  chain_verified  boolean not null,
  chain_message   text not null,

  -- The bundle bytes live in the attachments table (entity_type='evidence_export')
  -- so the generic download proxy + storage RLS apply uniformly. We hold a
  -- pointer rather than denormalising bytes / hash / size; composite FK keeps
  -- the link same-account by construction.
  attachment_id   uuid not null,

  exporter        uuid, -- auth.users.id at export time (NOT a FK to users; that's a profile mirror)

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  -- Composite FKs keep cross-account integrity at the DB level.
  foreign key (account_id, tenancy_id)    references public.tenancies(account_id, id)   on delete set null,
  foreign key (account_id, area_id)       references public.areas(account_id, id)       on delete set null,
  foreign key (account_id, attachment_id) references public.attachments(account_id, id) on delete restrict,

  unique (account_id, id),

  check (
    -- date range, when set, must be coherent
    (from_date is null or to_date is null or to_date >= from_date)
  ),
  check (
    -- must scope SOMETHING; refuse blank-scope exports at the schema level
    tenancy_id is not null or area_id is not null
  )
);

create index evidence_exports_account_id_idx on public.evidence_exports (account_id);
create index evidence_exports_tenancy_id_idx on public.evidence_exports (tenancy_id) where tenancy_id is not null;
create index evidence_exports_area_id_idx on public.evidence_exports (area_id) where area_id is not null;
create index evidence_exports_generated_at_idx on public.evidence_exports (generated_at desc);

alter table public.evidence_exports enable row level security;
alter table public.evidence_exports force  row level security;

create policy evidence_exports_member_all on public.evidence_exports
  for all
  using      (public.is_account_member(account_id))
  with check (public.is_account_member(account_id));

-- Audited like every other domain table -- the export action shows up in
-- events with actor='user:<uuid>'. Note: the API path uses the admin
-- (service-role) client to bypass RLS, which makes auth.uid() NULL inside
-- the trigger; Phase 4 actor-integrity then falls back to current_setting
-- ('audit.actor'). The RPC below sets that GUC to 'user:<exporter>' BEFORE
-- the INSERTs so the audit trail records the operator, not 'system'.
create trigger evidence_exports_audit
  after insert or update or delete on public.evidence_exports
  for each row execute function public._emit_event();

-- ============================================================================
-- record_evidence_export RPC
-- ============================================================================
--
-- Atomic. Two writes in ONE transaction with audit.actor pinned at the
-- start: (i) attachment row that the download proxy will serve;
-- (ii) evidence_exports row whose audit event becomes the canonical record
-- of WHO exported WHAT WHEN.
--
-- We pass in pre-computed attachment_id / evidence_export_id so the
-- attachment's entity_id can point at the about-to-be-inserted
-- evidence_exports row (entity_id is uuid, not FK -- attachments is
-- polymorphic). Two-step inserts WITHIN one txn keeps the FK on
-- evidence_exports.attachment_id satisfiable.

create or replace function public.record_evidence_export(
  p_account_id        uuid,
  p_evidence_export_id uuid,
  p_attachment_id     uuid,
  p_storage_path      text,
  p_content_hash      text,
  p_size_bytes        bigint,
  p_tenancy_id        uuid,
  p_area_id           uuid,
  p_from_date         date,
  p_to_date           date,
  p_generated_at      timestamptz,
  p_chain_verified    boolean,
  p_chain_message     text,
  p_exporter          uuid
)
returns table (
  evidence_export_id uuid,
  attachment_id      uuid
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor text;
begin
  v_actor := case
    when p_exporter is not null then 'user:' || p_exporter::text
    else 'system'
  end;
  perform set_config('audit.actor', v_actor, true);

  -- Attachment first; its entity_id is the export row we'll insert next.
  insert into public.attachments
    (id, account_id, entity_type, entity_id, storage_path, content_hash,
     mime_type, size_bytes, uploaded_by)
  values
    (p_attachment_id, p_account_id, 'evidence_export', p_evidence_export_id,
     p_storage_path, p_content_hash, 'application/pdf', p_size_bytes, p_exporter);

  insert into public.evidence_exports
    (id, account_id, tenancy_id, area_id, from_date, to_date,
     generated_at, chain_verified, chain_message, attachment_id, exporter)
  values
    (p_evidence_export_id, p_account_id, p_tenancy_id, p_area_id, p_from_date, p_to_date,
     p_generated_at, p_chain_verified, p_chain_message, p_attachment_id, p_exporter);

  evidence_export_id := p_evidence_export_id;
  attachment_id      := p_attachment_id;
  return next;
end;
$$;

grant execute on function public.record_evidence_export(
  uuid, uuid, uuid, text, text, bigint, uuid, uuid, date, date,
  timestamptz, boolean, text, uuid
) to service_role;
