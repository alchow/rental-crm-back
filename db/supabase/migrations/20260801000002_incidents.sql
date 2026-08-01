-- ----------------------------------------------------------------------------
-- Incidents: first-class tenant-incident records ("pen in a bound notebook").
--
-- Data flow:
--   landlord observes problem -> POST /incidents (plain insert, no RPC)
--     -> incident row (testimony frozen by trigger)
--     -> POST /incidents/{id}/items cites existing evidence rows
--     -> incident_items pointer row (insert + soft-unlink only)
--     -> cited journal entries freeze while the citation is live
--
-- Immutability posture (user decision): an incident is testimony written in
-- pen. `description` / `occurred_at` are DB-frozen at write time; corrections
-- are appended as journal notes, never edits. Only classification and outcome
-- (`category`, `resolved_at`, `resolution_note`) stay mutable, because
-- deferred classification is a designed workflow. Dismissal is an audited
-- soft delete, so client roles get no DELETE grant anywhere in this file.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (1) incidents
-- ============================================================================

create table public.incidents (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null,
  tenancy_id      uuid not null,
  -- Nullable = not yet classified. Values from the top-20 use-case research.
  category        text check (category in (
                    'noise', 'nonpayment', 'property_damage',
                    'unauthorized_occupant', 'unauthorized_pet', 'smoking',
                    'illegal_activity', 'harassment', 'sanitation',
                    'unauthorized_sublet', 'access_refusal',
                    'unauthorized_alteration', 'injury_claim', 'abandonment',
                    'holdover', 'police_activity', 'hoa_violation', 'other'
                  )),
  description     text not null check (length(description) between 1 and 5000),
  occurred_at     timestamptz not null default now(),
  resolved_at     timestamptz,
  resolution_note text check (resolution_note is null
                              or length(resolution_note) between 1 and 2000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  -- Account-safe FK: a tenancy can never be cited across account lines.
  -- RESTRICT because an incident is evidence anchored to the tenancy record.
  foreign key (account_id, tenancy_id)
    references public.tenancies(account_id, id) on delete restrict,
  unique (account_id, id)
);

create index incidents_account_created_idx
  on public.incidents (account_id, created_at, id)
  where deleted_at is null;

-- Serves the recurrence read: same tenancy + same category inside a window.
create index incidents_recurrence_idx
  on public.incidents (account_id, tenancy_id, category, occurred_at)
  where deleted_at is null;

alter table public.incidents enable row level security;
alter table public.incidents force row level security;

create policy incidents_member_select
  on public.incidents
  for select
  using (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ));

create policy incidents_member_insert
  on public.incidents
  for insert
  with check (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ));

create policy incidents_member_update
  on public.incidents
  for update
  using (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ))
  with check (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ));

-- No DELETE for anyone: dismissal is a soft-delete UPDATE so the audit chain
-- keeps the 'deleted' event and the row body it refers to.
revoke all on public.incidents
  from public, anon, authenticated, service_role;
grant select, insert, update on public.incidents
  to authenticated, service_role;

-- Frozen-fields guard. Diff is computed by REMOVING the mutable columns, so
-- any column this migration does not explicitly declare mutable -- including
-- ones added later -- is frozen by default (fail closed, not fail open).
create or replace function public._reject_incident_frozen_field_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_mutable constant text[] :=
    array['category', 'resolved_at', 'resolution_note', 'updated_at', 'deleted_at'];
  v_frozen_old jsonb := to_jsonb(OLD) - v_mutable;
  v_frozen_new jsonb := to_jsonb(NEW) - v_mutable;
  v_field text;
begin
  if v_frozen_new is distinct from v_frozen_old then
    select k.key
      into v_field
      from jsonb_object_keys(v_frozen_new) as k(key)
     where v_frozen_new -> k.key is distinct from v_frozen_old -> k.key
     order by k.key
     limit 1;
    raise exception 'incident field % is frozen; append a journal note instead of editing testimony', v_field
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

create trigger incidents_frozen_fields
  before update on public.incidents
  for each row execute function public._reject_incident_frozen_field_mutation();

create trigger incidents_audit
  after insert or update or delete on public.incidents
  for each row execute function public._emit_event();

-- ============================================================================
-- (2) incident_items -- typed evidence citations
-- ============================================================================
--
-- Four typed FK slots instead of string polymorphism, so citations get real
-- referential integrity and account-safety. Exactly one slot per row.

create table public.incident_items (
  id                     uuid primary key default gen_random_uuid(),
  account_id             uuid not null,
  incident_id            uuid not null,
  interaction_id         uuid,
  maintenance_request_id uuid,
  notice_id              uuid,
  inspection_id          uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  foreign key (account_id, incident_id)
    references public.incidents(account_id, id) on delete restrict,
  foreign key (account_id, interaction_id)
    references public.interactions(account_id, id) on delete restrict,
  foreign key (account_id, maintenance_request_id)
    references public.maintenance_requests(account_id, id) on delete restrict,
  foreign key (account_id, notice_id)
    references public.notices(account_id, id) on delete restrict,
  foreign key (account_id, inspection_id)
    references public.inspections(account_id, id) on delete restrict,
  unique (account_id, id),
  -- Canonical slot list: interaction | maintenance_request | notice |
  -- inspection. Adding a slot type = 4 sites: this CHECK, route Zod refine,
  -- hydration, export renderer.
  check (num_nonnulls(interaction_id, maintenance_request_id,
                      notice_id, inspection_id) = 1)
);

-- Not partial: the items read has an ?include_unlinked mode, so unlinked rows
-- stay reachable through the same keyset path.
create index incident_items_account_incident_created_idx
  on public.incident_items (account_id, incident_id, created_at, id);

-- One LIVE citation per (incident, evidence row) and slot. Partial on
-- deleted_at so a mistaken link can be unlinked and later re-cited.
create unique index incident_items_live_interaction_key
  on public.incident_items (account_id, incident_id, interaction_id)
  where interaction_id is not null and deleted_at is null;

create unique index incident_items_live_maintenance_request_key
  on public.incident_items (account_id, incident_id, maintenance_request_id)
  where maintenance_request_id is not null and deleted_at is null;

create unique index incident_items_live_notice_key
  on public.incident_items (account_id, incident_id, notice_id)
  where notice_id is not null and deleted_at is null;

create unique index incident_items_live_inspection_key
  on public.incident_items (account_id, incident_id, inspection_id)
  where inspection_id is not null and deleted_at is null;

-- Serves the linked-evidence freeze probe below, which runs on EVERY
-- interactions UPDATE/DELETE and therefore must be an index-backed EXISTS.
create index incident_items_live_interaction_probe_idx
  on public.incident_items (account_id, interaction_id)
  where interaction_id is not null and deleted_at is null;

alter table public.incident_items enable row level security;
alter table public.incident_items force row level security;

create policy incident_items_member_select
  on public.incident_items
  for select
  using (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ));

create policy incident_items_member_insert
  on public.incident_items
  for insert
  with check (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ));

create policy incident_items_member_update
  on public.incident_items
  for update
  using (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ))
  with check (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ));

revoke all on public.incident_items
  from public, anon, authenticated, service_role;
grant select, insert, update on public.incident_items
  to authenticated, service_role;

-- A citation is a fact about what the record-keeper relied on. The only legal
-- update is the unlink itself (deleted_at null -> not null, plus the
-- updated_at stamp); re-pointing a citation would rewrite what was cited.
create or replace function public._incident_items_unlink_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if OLD.deleted_at is null
     and NEW.deleted_at is not null
     and (to_jsonb(NEW) - array['deleted_at', 'updated_at'])
         is not distinct from (to_jsonb(OLD) - array['deleted_at', 'updated_at'])
  then
    return NEW;
  end if;
  raise exception 'incident evidence links are append-only; unlink is the only permitted change'
    using errcode = 'check_violation';
end;
$$;

create trigger incident_items_unlink_only
  before update on public.incident_items
  for each row execute function public._incident_items_unlink_only();

-- Backstop against hard deletes (client roles have no DELETE grant, but a
-- future privileged path must not erase citation history either).
create or replace function public._reject_incident_item_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'incident evidence links cannot be deleted; unlink preserves the citation history'
    using errcode = 'check_violation';
end;
$$;

create trigger incident_items_no_delete
  before delete on public.incident_items
  for each row execute function public._reject_incident_item_delete();

create trigger incident_items_audit
  after insert or update or delete on public.incident_items
  for each row execute function public._emit_event();

-- ============================================================================
-- (3) Linked-evidence freeze on interactions
-- ============================================================================
--
-- Once a journal entry is cited by a LIVE incident link it is testimony the
-- incident record rests on, so its probative fields freeze -- the user-chosen
-- pen-not-pencil posture. Precedent: _reject_anchored_notice_mutation
-- (20260706000001_instrument_anchored_rent_changes.sql:581), where a notice
-- anchoring a live rent schedule becomes write-blocked.
--
-- Frozen while live-linked: body, occurred_at, party_type, party_id, channel,
-- direction, deleted_at (soft delete included -- unlink first if the citation
-- was a mistake). Everything else stays writable: the allowlist below names
-- every OTHER current interactions column, so confirm flows (confirmed_by /
-- confirmed_at), delivery/threading backfills (thread_id, rfc822_message_id,
-- references_interaction_id, external_ref) and updated_at keep working. A
-- column added to interactions later is frozen-by-default until it is
-- deliberately added here (fail closed).
create or replace function public._reject_linked_evidence_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_allowed constant text[] := array[
    'account_id', 'actor', 'approval_ref', 'approved_by', 'area_id',
    'attestation', 'author_type', 'confirmed_at', 'confirmed_by',
    'correction_kind', 'corrects_id', 'created_at', 'deleted_by',
    'deleted_reason', 'entry_type', 'external_ref', 'id', 'kind', 'logged_at',
    'maintenance_request_id', 'party_label', 'references_interaction_id',
    'rfc822_message_id', 'tenancy_id', 'thread_id', 'updated_at', 'vendor_id',
    'work_order_id'
  ];
begin
  -- Cheap EXISTS probe on every interactions write, served by
  -- incident_items_live_interaction_probe_idx.
  if not exists (
    select 1
      from public.incident_items li
     where li.account_id = OLD.account_id
       and li.interaction_id = OLD.id
       and li.deleted_at is null
  ) then
    if TG_OP = 'DELETE' then
      return OLD;
    end if;
    return NEW;
  end if;

  if TG_OP = 'DELETE' then
    raise exception 'journal entry is cited by an incident and cannot be deleted'
      using errcode = 'check_violation';
  end if;

  if (to_jsonb(NEW) - v_allowed) is distinct from (to_jsonb(OLD) - v_allowed) then
    raise exception 'journal entry is cited by an incident; testimony fields are frozen'
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

create trigger interactions_reject_linked_evidence_mutation
  before update or delete on public.interactions
  for each row execute function public._reject_linked_evidence_mutation();

-- Trigger functions are not application RPCs. Remove Supabase's default
-- EXECUTE grants explicitly; PostgreSQL trigger invocation does not need them.
revoke all on function public._reject_incident_frozen_field_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public._incident_items_unlink_only()
  from public, anon, authenticated, service_role;
revoke all on function public._reject_incident_item_delete()
  from public, anon, authenticated, service_role;
revoke all on function public._reject_linked_evidence_mutation()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
