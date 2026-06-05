-- ----------------------------------------------------------------------------
-- Phase 3: audit spine.
--
-- The data spine is records-as-evidence. To hold up in front of a court or a
-- code inspector, those records must be:
--
--   1. unforgeable in normal operation -- written by the DB itself, not by
--      the app, so a developer mis-step can't omit an event.
--   2. unmutable after the fact       -- editing the audit log is a security
--      incident, not a UX option.
--   3. tamper-evident                  -- if an attacker with DB access does
--      reach in and edit history, the chain breaks visibly.
--
-- Shape:
--   - events table (per-account hash chain, append-only)
--   - one generic AFTER INSERT/UPDATE/DELETE trigger function, attached to
--     every domain table (so even a direct postgres write produces an event)
--   - interactions.logged_at made overwrite-impossible via a BEFORE-UPDATE
--     reject trigger
--   - verify_chain(account_id) and entity_history(...) read functions
-- ----------------------------------------------------------------------------

-- digest() comes from pgcrypto, which Phase 2 already enables. Repeating
-- the create here for migration idempotency on a fresh DB.
create extension if not exists pgcrypto;

-- ============================================================================
-- 1. events: append-only, per-account hash chain
-- ============================================================================

create table public.events (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null,
  -- 'user:<uuid>' | 'tenant:<token_id>' | 'system' | 'other:<label>'
  actor            text not null check (length(actor) between 1 and 200),
  entity_type      text not null check (length(entity_type) between 1 and 100),
  entity_id        uuid not null,
  event_type       text not null check (event_type in ('inserted', 'updated', 'deleted', 'hard_deleted')),
  payload          jsonb not null,
  -- Server-set; the trigger sets occurred_at = now() and never lets the
  -- caller override. Any UPDATE on this column would also break the chain
  -- and be caught by verify_chain.
  occurred_at      timestamptz not null default now(),
  prev_event_hash  bytea,
  event_hash       bytea not null,
  -- Cheap protection against accidental double-insert of the same event.
  unique (account_id, event_hash)
);
create index events_account_id_idx
  on public.events (account_id);
create index events_account_id_occurred_at_idx
  on public.events (account_id, occurred_at, id);
create index events_entity_idx
  on public.events (entity_type, entity_id, occurred_at);

-- RLS: read-only for account members. NO insert/update/delete policy is
-- written; with RLS enabled, "no policy" means "deny" for non-owner roles.
-- Crucially we do NOT `force` row level security, so the table owner
-- (postgres) bypasses RLS -- that's how the SECURITY DEFINER trigger
-- function gets to insert.
alter table public.events enable row level security;

create policy events_member_select on public.events
  for select using (public.is_account_member(account_id));

-- Belt-and-braces on top of RLS: revoke the grants the supabase_compat /
-- default-privilege blanket may have handed to authenticated/anon (the
-- Supabase prod environment grants similar defaults). Service_role has
-- BYPASSRLS, so for service-role we rely on this table-grant revoke for
-- the "events have no UPDATE/DELETE" guarantee.
revoke insert, update, delete, truncate on public.events from public;
revoke insert, update, delete, truncate on public.events
  from anon, authenticated, service_role;

-- ============================================================================
-- 2. _emit_event: the trigger function attached to every domain table
-- ============================================================================
--
-- One function, dispatched on TG_OP and TG_TABLE_NAME. SECURITY DEFINER so
-- it can bypass the events-table RLS while still being called from a user
-- transaction. SET search_path locks down the function definition.

create or replace function public._emit_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id   uuid;
  v_entity_type  text := TG_TABLE_NAME;
  v_entity_id    uuid;
  v_event_type   text;
  v_payload      jsonb;
  v_actor        text;
  v_occurred_at  timestamptz := clock_timestamp();
  v_prev_hash    bytea;
  v_hash         bytea;
  v_canonical    text;
begin
  -- ----- account_id -------------------------------------------------------
  -- accounts.id IS the account_id; every other audited table carries it.
  if TG_TABLE_NAME = 'accounts' then
    v_account_id := case TG_OP when 'DELETE' then OLD.id else NEW.id end;
  else
    v_account_id := case TG_OP when 'DELETE' then OLD.account_id else NEW.account_id end;
  end if;

  -- ----- entity_id --------------------------------------------------------
  -- Every audited table uses an `id uuid` PK in Phase 2; unit_details is
  -- the one exception (its PK is area_id). Resolve dynamically.
  if TG_TABLE_NAME = 'unit_details' then
    v_entity_id := case TG_OP when 'DELETE' then OLD.area_id else NEW.area_id end;
  else
    v_entity_id := case TG_OP when 'DELETE' then OLD.id else NEW.id end;
  end if;

  -- ----- event_type + payload --------------------------------------------
  if TG_OP = 'INSERT' then
    v_event_type := 'inserted';
    v_payload    := jsonb_build_object('after', to_jsonb(NEW));
  elsif TG_OP = 'UPDATE' then
    -- Soft-delete (deleted_at flipping null -> non-null) is a 'deleted'
    -- event -- the tombstone the brief asks for. Everything else is 'updated'.
    if (to_jsonb(OLD) ? 'deleted_at')
       and (to_jsonb(OLD) ->> 'deleted_at') is null
       and (to_jsonb(NEW) ->> 'deleted_at') is not null then
      v_event_type := 'deleted';
    else
      v_event_type := 'updated';
    end if;
    v_payload := jsonb_build_object('before', to_jsonb(OLD), 'after', to_jsonb(NEW));
  else -- DELETE
    v_event_type := 'hard_deleted';
    v_payload    := jsonb_build_object('before', to_jsonb(OLD));
  end if;

  -- ----- actor ------------------------------------------------------------
  -- Priority:
  --   1. `audit.actor` session var if set (e.g., the API admin path sets
  --      this when service-role does work on behalf of a tenant token).
  --   2. auth.uid() -> 'user:<uuid>' (the authenticated PostgREST path).
  --   3. fallback: 'system' (a direct DB write or a background job).
  begin
    v_actor := nullif(current_setting('audit.actor', true), '');
  exception when others then
    v_actor := null;
  end;
  if v_actor is null then
    if auth.uid() is not null then
      v_actor := 'user:' || auth.uid()::text;
    else
      v_actor := 'system';
    end if;
  end if;

  -- ----- per-account advisory lock ---------------------------------------
  -- Two concurrent writes on the same account must serialise so each one
  -- computes its hash from the OTHER one's committed event_hash. Different
  -- accounts get different lock keys and never block each other.
  perform pg_advisory_xact_lock(
    hashtextextended('events_chain:' || v_account_id::text, 0)
  );

  -- ----- read previous hash for this account ----------------------------
  -- Under the advisory lock, we are the only writer for this account, so
  -- the latest committed row IS the predecessor of the event we are about
  -- to insert.
  select event_hash into v_prev_hash
  from public.events
  where account_id = v_account_id
  order by occurred_at desc, id desc
  limit 1;

  -- ----- canonical hash --------------------------------------------------
  -- Pipe-delimited canonical form. payload::text uses jsonb's canonical key
  -- ordering. occurred_at is serialised via to_jsonb(...)::text which gives
  -- a session-stable ISO 8601 form.
  v_canonical :=
        encode(coalesce(v_prev_hash, ''::bytea), 'hex')
    || '|' || v_account_id::text
    || '|' || v_entity_type
    || '|' || v_entity_id::text
    || '|' || v_event_type
    || '|' || v_payload::text
    || '|' || to_jsonb(v_occurred_at)::text;
  v_hash := digest(v_canonical, 'sha256');

  insert into public.events (
    account_id, actor, entity_type, entity_id, event_type, payload,
    occurred_at, prev_event_hash, event_hash
  ) values (
    v_account_id, v_actor, v_entity_type, v_entity_id, v_event_type, v_payload,
    v_occurred_at, v_prev_hash, v_hash
  );

  return null;  -- AFTER triggers: return value ignored
end;
$$;

-- The SECURITY DEFINER function bypasses RLS only when it has the
-- privileges of the function owner. Postgres' SECURITY DEFINER doc says
-- "executes with the privileges of the user that owns it." Make sure the
-- owner can insert into events; the table owner (postgres / supabase_admin
-- in their respective envs) can.

-- ============================================================================
-- 3. interactions.logged_at lock-down
-- ============================================================================
--
-- Phase 2 set the column NOT NULL with a default of now(). Nothing yet
-- prevents an UPDATE from rewriting it. The audit spine catches the change
-- after the fact, but the value litigants will scrutinise is logged_at
-- itself -- so refuse the write at the source.

create or replace function public._reject_logged_at_change()
returns trigger
language plpgsql
as $$
begin
  if NEW.logged_at is distinct from OLD.logged_at then
    raise exception 'interactions.logged_at is immutable (attempted % -> %)',
      OLD.logged_at, NEW.logged_at
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

create trigger interactions_logged_at_immutable
  before update on public.interactions
  for each row execute function public._reject_logged_at_change();

-- ============================================================================
-- 4. Attach _emit_event() to every domain table
-- ============================================================================
--
-- Every public table except events itself and users (the profile mirror;
-- it has no account_id and is not evidentiary). This loop deliberately
-- enumerates rather than introspects: if a new domain table is added in a
-- future phase, the explicit list will fail loudly during a code-review,
-- which is what we want -- a missing audit trigger should never be silent.

do $$
declare
  t text;
  tables text[] := array[
    -- identity (accounts is audited; users is excluded by design)
    'accounts', 'account_members',
    -- places
    'properties', 'areas', 'unit_details',
    -- occupancy
    'tenants', 'tenancies', 'tenancy_tenants', 'leases',
    -- ops
    'vendors', 'assets',
    'maintenance_requests', 'work_orders',
    'inspection_templates', 'inspections', 'inspection_items',
    -- evidence
    'attachments', 'interactions',
    -- workflow
    'notices', 'scheduled_tasks',
    -- ledger
    'rent_schedules', 'charges', 'payments', 'payment_allocations'
  ];
begin
  foreach t in array tables loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I '
      'for each row execute function public._emit_event()',
      t || '_audit', t
    );
  end loop;
end $$;

-- ============================================================================
-- 5. verify_chain(account_id): recompute and detect tampering
-- ============================================================================

create or replace function public.verify_chain(p_account_id uuid)
returns table (
  ok               boolean,
  broken_at        uuid,
  broken_event_no  bigint,
  reason           text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  e          record;
  v_prev     bytea := null;
  v_canonical text;
  v_expected bytea;
  v_n        bigint := 0;
begin
  for e in
    select id, account_id, entity_type, entity_id, event_type, payload,
           occurred_at, prev_event_hash, event_hash
    from public.events
    where account_id = p_account_id
    order by occurred_at asc, id asc
  loop
    v_n := v_n + 1;

    -- (a) prev_event_hash must match the actual previous event's hash.
    if e.prev_event_hash is distinct from v_prev then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := 'prev_event_hash mismatch';
      return next;
      return;
    end if;

    -- (b) event_hash must match a re-hash of the canonical form.
    v_canonical :=
          encode(coalesce(v_prev, ''::bytea), 'hex')
      || '|' || e.account_id::text
      || '|' || e.entity_type
      || '|' || e.entity_id::text
      || '|' || e.event_type
      || '|' || e.payload::text
      || '|' || to_jsonb(e.occurred_at)::text;
    v_expected := digest(v_canonical, 'sha256');

    if e.event_hash is distinct from v_expected then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := 'event_hash recomputation mismatch';
      return next;
      return;
    end if;

    v_prev := e.event_hash;
  end loop;

  ok := true; broken_at := null; broken_event_no := null; reason := null;
  return next;
end;
$$;

-- ============================================================================
-- 6. entity_history(entity_type, entity_id): read the audit log for a row
-- ============================================================================
--
-- Returns the full chronological event stream for one entity. RLS on the
-- events table still applies (security invoker), so a caller only sees
-- history for entities in accounts they belong to.

create or replace function public.entity_history(
  p_entity_type text,
  p_entity_id   uuid
)
returns setof public.events
language sql
stable
security invoker
set search_path = public
as $$
  select *
  from public.events
  where entity_type = p_entity_type
    and entity_id   = p_entity_id
  order by occurred_at asc, id asc;
$$;
