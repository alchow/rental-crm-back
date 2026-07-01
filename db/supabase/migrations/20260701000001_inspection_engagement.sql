-- ----------------------------------------------------------------------------
-- Phase 28: tenant-engagement funnel for inspection capture.
--
-- Surfaces, on the landlord's inspection-detail read, how far a tenant has gotten
-- through a tenant-filled condition form:
--   link_delivered_at -> form_opened_at -> form_started_at -> submitted_at
-- plus per-room progress (rooms_done / rooms_total, both DERIVED at read time).
--
-- DESIGN
--   * The four timestamps are STORED nullable columns on `inspections`, each
--     SET-ONCE at its write site via a guarded `... WHERE <col> IS NULL AND
--     completed_at IS NULL` update. Storing (vs deriving from the events log)
--     is chosen because `form_opened_at` has no clean event (the form GET is a
--     read) and per-read MIN() scans over the fast-growing `events` table would
--     couple a hot landlord read path to audit-log size. The `completed_at IS
--     NULL` guard means no stamp can ever trip the completion lock
--     (_reject_completed_inspection_update, migration 20260628000001).
--   * Room progress is NOT stored: `rooms_total`/`rooms_done` are cheap
--     aggregates the detail handler computes over the inspection's items +
--     confirmations, so they can never drift out of sync with reality.
--   * A room counts toward `rooms_done` when the tenant did SOMETHING in it:
--     >=1 item has a `condition`, OR the tenant posted a "confirmed good" row
--     into `inspection_room_confirmations` (below) -- the latter lets a room the
--     tenant deliberately leaves untouched (because it is fine) count as done
--     instead of looking identical to a room they never reached.
--
-- SECURITY: the three new callable functions are SECURITY DEFINER (they write
-- rows the tenant has no RLS grant for and stamp the audit actor 'tenant:<tok>')
-- so, exactly like 20260628000007/08, they are REVOKEd from public + anon +
-- authenticated and granted ONLY to service_role -- the CI guard
-- db/test/check_definer_grants.sql fails the build otherwise.
-- ----------------------------------------------------------------------------

-- (1) Four set-once lifecycle timestamps. Additive/nullable/no-default: existing
-- rows read all-null (the FE renders a null field as "waiting"); no backfill.
alter table public.inspections
  add column link_delivered_at timestamptz,
  add column form_opened_at    timestamptz,
  add column form_started_at   timestamptz,
  add column submitted_at      timestamptz;

-- (2) Per-room "confirmed good" -- FUNNEL TELEMETRY ONLY. It bumps rooms_done;
-- it does NOT set item conditions and is NOT wired into the report PDF /
-- checkout-diff / evidence-export. (Proving the tenant actually reviewed every
-- item in a room -- vs leaving it default-good -- is a separate, larger change.)
create table public.inspection_room_confirmations (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  inspection_id uuid not null,
  -- null = the "ungrouped" bucket (items whose server group_label is null; the
  -- FE renders these as "General"). Keyed on SQL null, NOT the display string,
  -- so it can't collide with a real section a template happens to label "General".
  group_label   text check (group_label is null or length(group_label) between 1 and 200),
  confirmed_at  timestamptz not null default now(),
  confirmed_by  uuid references auth.users(id) on delete set null, -- null for tenant confirms
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (account_id, inspection_id) references public.inspections(account_id, id) on delete cascade,
  unique (account_id, id)
);
create index inspection_room_confirmations_account_id_idx    on public.inspection_room_confirmations (account_id);
create index inspection_room_confirmations_inspection_id_idx on public.inspection_room_confirmations (inspection_id);
-- One live confirmation per room -> makes the confirm idempotent. NULLS NOT
-- DISTINCT so the ungrouped bucket (group_label IS NULL) also dedupes to one
-- row (Postgres treats nulls as distinct in a unique index by default).
create unique index inspection_room_confirmations_inspection_group_uniq
  on public.inspection_room_confirmations (inspection_id, group_label)
  nulls not distinct
  where deleted_at is null;

-- RLS: ADR-0003 form B (initplan IN-subquery), copied from inspection_checks --
-- NOT the is_account_member helper (a per-row helper call re-adds the cost
-- ADR-0003 removed). Members read confirmations under their JWT; the tenant
-- write path uses the service-role client after verifying the secret.
alter table public.inspection_room_confirmations enable row level security;
alter table public.inspection_room_confirmations force  row level security;
create policy inspection_room_confirmations_member_all on public.inspection_room_confirmations
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

-- Audit: the phase-3 trigger loop predates this table, so attach explicitly
-- (same as documents.sql / inspection_checks). No completed-lock trigger:
-- confirms only ever arrive via the draft-guarded DEFINER RPC below, and this
-- is telemetry -- an inspection_checks-style immutability trigger is unneeded.
create trigger inspection_room_confirmations_audit
  after insert or update or delete on public.inspection_room_confirmations
  for each row execute function public._emit_event();

-- (3) link_delivered_at: stamp the parent inspection the FIRST time any capture
-- token is minted for it. One trigger covers BOTH mint paths -- landlord
-- POST .../capture-links and self-service request-renewal -- so a re-minted
-- (renewal) link KEEPS prior progress (set-once WHERE link_delivered_at IS
-- NULL). SECURITY DEFINER so the nested inspections update never depends on the
-- minting caller's RLS; the `completed_at IS NULL` guard keeps it clear of the
-- completion lock, and it touches neither kind/tenancy/area nor
-- baseline_inspection_id, so the coherence trigger does not fire.
create or replace function public._stamp_inspection_link_delivered()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.inspections
     set link_delivered_at = NEW.created_at, updated_at = now()
   where account_id = NEW.account_id and id = NEW.inspection_id
     and link_delivered_at is null and completed_at is null;
  return NEW;
end;
$$;

create trigger inspection_capture_tokens_stamp_delivered
  after insert on public.inspection_capture_tokens
  for each row execute function public._stamp_inspection_link_delivered();

-- (4) form_started_at set-once helper. Called (via perform) from every tenant
-- content-write RPC so "first tenant write" is stamped from ONE definition that
-- can't drift as write endpoints are added. Guarded => second+ writes are
-- no-ops (no write, no audit-event spam).
create or replace function public._tenant_stamp_form_started(
  p_account_id    uuid,
  p_inspection_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.inspections
     set form_started_at = now(), updated_at = now()
   where account_id = p_account_id and id = p_inspection_id
     and form_started_at is null and completed_at is null;
end;
$$;

-- (5) form_opened_at: stamped from the GET-form path ONLY (not the write paths,
-- which also verify the token) -- that is what distinguishes "opened" from
-- "used". Set-once + completed-lock-safe.
create or replace function public.tenant_mark_form_opened(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  update public.inspections
     set form_opened_at = now(), updated_at = now()
   where account_id = p_account_id and id = p_inspection_id and deleted_at is null
     and form_opened_at is null and completed_at is null;
end;
$$;

-- (6) tenant_confirm_inspection_room: tenant marks one section "confirmed good".
-- Confirm-only + idempotent (on-conflict-do-nothing => re-confirm is a no-op,
-- not an error). Same draft-editable guard + tenant audit actor as the other
-- tenant_* RPCs, and it counts as a tenant write so it stamps form_started_at.
-- p_group_label null/empty/whitespace => the ungrouped ("General") bucket,
-- stored as SQL null (see the table comment on why null, not the display string).
create or replace function public.tenant_confirm_inspection_room(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid,
  p_group_label   text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status       text;
  v_capture_mode text;
  v_completed    timestamptz;
  v_label        text := nullif(btrim(p_group_label), '');
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  select status, capture_mode, completed_at
    into v_status, v_capture_mode, v_completed
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is not null or v_status <> 'draft'
     or v_capture_mode not in ('tenant', 'collaborative') then
    raise exception 'not_editable_by_tenant' using errcode = 'check_violation';
  end if;

  insert into public.inspection_room_confirmations
    (account_id, inspection_id, group_label)
  values (p_account_id, p_inspection_id, v_label)
  on conflict (inspection_id, group_label) where deleted_at is null
  do nothing;

  perform public._tenant_stamp_form_started(p_account_id, p_inspection_id);
end;
$$;

-- (7) Re-create the four existing tenant content-write RPCs verbatim + one added
-- line: `perform public._tenant_stamp_form_started(...)` after a successful
-- write, so any of them being the tenant's first write stamps form_started_at.
-- (`create or replace` preserves the existing ACL; the revoke/grant at the end
-- re-asserts it unambiguously.)

-- tenant_update_inspection_item ----------------------------------------------
create or replace function public.tenant_update_inspection_item(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid,
  p_item_id       uuid,
  p_condition     text,
  p_notes         text
)
returns public.inspection_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status       text;
  v_capture_mode text;
  v_completed    timestamptz;
  v_row          public.inspection_items;
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  select status, capture_mode, completed_at
    into v_status, v_capture_mode, v_completed
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is not null or v_status <> 'draft'
     or v_capture_mode not in ('tenant', 'collaborative') then
    raise exception 'not_editable_by_tenant' using errcode = 'check_violation';
  end if;

  update public.inspection_items
     set condition = p_condition, notes = p_notes, updated_at = now()
   where account_id = p_account_id and inspection_id = p_inspection_id
     and id = p_item_id and deleted_at is null
  returning * into v_row;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  perform public._tenant_stamp_form_started(p_account_id, p_inspection_id);
  return v_row;
end;
$$;

-- tenant_upsert_inspection_checks --------------------------------------------
create or replace function public.tenant_upsert_inspection_checks(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid,
  p_checks        jsonb
)
returns setof public.inspection_checks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status       text;
  v_capture_mode text;
  v_completed    timestamptz;
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  select status, capture_mode, completed_at
    into v_status, v_capture_mode, v_completed
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is not null or v_status <> 'draft'
     or v_capture_mode not in ('tenant', 'collaborative') then
    raise exception 'not_editable_by_tenant' using errcode = 'check_violation';
  end if;

  perform public._tenant_stamp_form_started(p_account_id, p_inspection_id);

  return query
  insert into public.inspection_checks
    (account_id, inspection_id, field_key, label, group_label, value, sort_order, answered_at)
  select
    p_account_id, p_inspection_id,
    e->>'field_key',
    coalesce(e->>'label', e->>'field_key'),
    e->>'group_label',
    e->'value',
    nullif(e->>'sort_order', '')::int,
    now()
  from jsonb_array_elements(p_checks) as e
  where coalesce(e->>'field_key', '') <> ''
  on conflict (inspection_id, field_key) where deleted_at is null
  do update set
    label       = excluded.label,
    group_label = excluded.group_label,
    value       = excluded.value,
    sort_order  = excluded.sort_order,
    answered_at = excluded.answered_at,
    updated_at  = now()
  returning *;
end;
$$;

-- tenant_submit_inspection ----------------------------------------------------
-- Tenant attestation point: draft -> tenant_submitted (audit actor = tenant).
-- Idempotent: a second submit on an already-submitted inspection returns it.
-- submitted_at is set in the SAME update that flips the status, so it is
-- set-once (only the draft branch runs it) and equals that exact transition.
create or replace function public.tenant_submit_inspection(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid
)
returns public.inspections
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inspections;
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  update public.inspections
     set status = 'tenant_submitted', submitted_at = now(), updated_at = now()
   where account_id = p_account_id and id = p_inspection_id and deleted_at is null
     and completed_at is null and status = 'draft'
     and capture_mode in ('tenant', 'collaborative')
  returning * into v_row;
  if found then
    return v_row;
  end if;

  -- Not draft: re-fetch for idempotency / a precise error.
  select * into v_row
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_row.status = 'tenant_submitted' then
    return v_row; -- already submitted: idempotent
  end if;
  raise exception 'not_submittable' using errcode = 'check_violation';
end;
$$;

-- tenant_attach_inspection_item_photo ----------------------------------------
-- (verbatim from 20260628000008 + the form_started stamp after the guards)
create or replace function public.tenant_attach_inspection_item_photo(
  p_account_id      uuid,
  p_token_id        uuid,
  p_inspection_id   uuid,
  p_item_id         uuid,
  p_attachment_hash text,
  p_attachment_mime text,
  p_attachment_size bigint,
  p_attachment_path text,
  p_derivative_hash text   default null,
  p_derivative_mime text   default null,
  p_derivative_size bigint default null,
  p_derivative_path text   default null
)
returns table (
  attachment_id uuid,
  derivative_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status        text;
  v_capture_mode  text;
  v_completed     timestamptz;
  v_attachment_id uuid;
  v_derivative_id uuid;
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  select status, capture_mode, completed_at
    into v_status, v_capture_mode, v_completed
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is not null or v_status <> 'draft'
     or v_capture_mode not in ('tenant', 'collaborative') then
    raise exception 'not_editable_by_tenant' using errcode = 'check_violation';
  end if;

  perform 1
    from public.inspection_items
    where account_id = p_account_id and inspection_id = p_inspection_id
      and id = p_item_id and deleted_at is null;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  perform public._tenant_stamp_form_started(p_account_id, p_inspection_id);

  -- idempotency: identical bytes already attached to this item -> return the
  -- existing attachment (and its derivative, if any) without inserting.
  select id into v_attachment_id
    from public.attachments
    where account_id = p_account_id and entity_type = 'inspection_items'
      and entity_id = p_item_id and content_hash = p_attachment_hash
      and deleted_at is null
    limit 1;
  if found then
    select id into v_derivative_id
      from public.attachments
      where account_id = p_account_id and derived_from = v_attachment_id
        and deleted_at is null
      limit 1;
    attachment_id := v_attachment_id;
    derivative_id := v_derivative_id;
    return next;
    return;
  end if;

  insert into public.attachments
    (account_id, entity_type, entity_id, storage_path, content_hash,
     mime_type, size_bytes, uploaded_by)
  values
    (p_account_id, 'inspection_items', p_item_id, p_attachment_path,
     p_attachment_hash, p_attachment_mime, p_attachment_size, null)
  returning id into v_attachment_id;

  if p_derivative_hash is not null then
    insert into public.attachments
      (account_id, entity_type, entity_id, storage_path, content_hash,
       mime_type, size_bytes, uploaded_by, derived_from)
    values
      (p_account_id, 'inspection_items', p_item_id, p_derivative_path,
       p_derivative_hash, p_derivative_mime, p_derivative_size, null,
       v_attachment_id)
    returning id into v_derivative_id;
  end if;

  attachment_id := v_attachment_id;
  derivative_id := v_derivative_id;
  return next;
end;
$$;

-- tenant_upsert_inspection_items ----------------------------------------------
-- (verbatim from 20260628000008 + the form_started stamp)
create or replace function public.tenant_upsert_inspection_items(
  p_account_id    uuid,
  p_token_id      uuid,
  p_inspection_id uuid,
  p_items         jsonb
)
returns setof public.inspection_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status       text;
  v_capture_mode text;
  v_completed    timestamptz;
begin
  perform set_config('audit.actor', 'tenant:' || p_token_id::text, true);

  select status, capture_mode, completed_at
    into v_status, v_capture_mode, v_completed
    from public.inspections
    where account_id = p_account_id and id = p_inspection_id and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is not null or v_status <> 'draft'
     or v_capture_mode not in ('tenant', 'collaborative') then
    raise exception 'not_editable_by_tenant' using errcode = 'check_violation';
  end if;

  -- Stamp form_started_at ONLY when >=1 item actually changes (all-unknown
  -- item_keys are a silent no-op and must not flip the funnel). The stamp is a
  -- data-modifying CTE gated on `exists (select 1 from upd)`, so it stays
  -- atomic with the update and matches the single-item PATCH's "on real write"
  -- semantics. (The set-once/completed guards live in the stamp CTE's WHERE.)
  return query
  with upd as (
    update public.inspection_items it
       set condition   = case when e ? 'condition'   then e->>'condition'   else it.condition   end,
           notes       = case when e ? 'notes'       then e->>'notes'       else it.notes       end,
           updated_at  = now()
      from jsonb_array_elements(p_items) as e
     where it.account_id    = p_account_id
       and it.inspection_id = p_inspection_id
       and it.item_key      = e->>'item_key'
       and coalesce(e->>'item_key', '') <> ''
       and it.deleted_at is null
    returning it.*
  ),
  stamp as (
    update public.inspections
       set form_started_at = now(), updated_at = now()
     where account_id = p_account_id and id = p_inspection_id
       and form_started_at is null and completed_at is null
       and exists (select 1 from upd)
    returning 1
  )
  select * from upd;
end;
$$;

-- (8) Lock every new / replaced SECURITY DEFINER function to service_role only
-- (the verified magic-link path). `revoke ... from public` alone is a NO-OP on
-- Supabase (default ACL grants anon + authenticated explicitly), so revoke from
-- those roles too -- the CI guard db/test/check_definer_grants.sql enforces it.
revoke execute on function public._tenant_stamp_form_started(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.tenant_mark_form_opened(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.tenant_confirm_inspection_room(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.tenant_update_inspection_item(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.tenant_submit_inspection(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.tenant_attach_inspection_item_photo(uuid, uuid, uuid, uuid, text, text, bigint, text, text, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.tenant_upsert_inspection_items(uuid, uuid, uuid, jsonb) from public, anon, authenticated;

grant execute on function public._tenant_stamp_form_started(uuid, uuid) to service_role;
grant execute on function public.tenant_mark_form_opened(uuid, uuid, uuid) to service_role;
grant execute on function public.tenant_confirm_inspection_room(uuid, uuid, uuid, text) to service_role;
grant execute on function public.tenant_update_inspection_item(uuid, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.tenant_upsert_inspection_checks(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.tenant_submit_inspection(uuid, uuid, uuid) to service_role;
grant execute on function public.tenant_attach_inspection_item_photo(uuid, uuid, uuid, uuid, text, text, bigint, text, text, text, bigint, text) to service_role;
grant execute on function public.tenant_upsert_inspection_items(uuid, uuid, uuid, jsonb) to service_role;
