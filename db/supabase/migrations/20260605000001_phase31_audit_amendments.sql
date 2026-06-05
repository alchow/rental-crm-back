-- ----------------------------------------------------------------------------
-- Phase 3.1 audit amendments.
--
-- Three correctness bugs / hardening items found in Phase 3 review:
--
--   (A) Canonical hash preimage was pipe-delimited:
--       prev_hex | account_id | entity_type | entity_id | event_type | payload::text | occurred_at::jsonb::text
--       That delimiter is ambiguous: payload is arbitrary jsonb whose text
--       form CAN contain '|'. Two different field-sets could collide on
--       preimage, defeating the tamper-evidence the chain exists for.
--       Fix: hash a jsonb_build_object(...) text. jsonb text is determ-
--       inistic (keys sorted), and JSON escaping makes inter-field
--       boundaries unambiguous. Also fold a fixed 32-zero-byte genesis
--       constant into the preimage so "no predecessor" is a distinguishable
--       value (not an empty string an attacker could synthesise).
--
--   (C) Chain ordering used (occurred_at, id). Both are wrong as ordering
--       keys:
--         - occurred_at is clock_timestamp(), which can move backward
--           under NTP correction;
--         - id is a random uuid, not monotonic.
--       Either could let a tampered chain be re-ordered into a passing
--       verification, or a real chain be mis-ordered into a false failure.
--       Fix: add events.account_seq bigint not null, assigned under the
--       same per-account advisory lock that already serialises writers.
--       Chain ordering is by account_seq only. Stored occurred_at stays
--       as-is for evidentiary value.
--
--   (F) Soft-delete reversal: clearing deleted_at on a row currently emits
--       a generic 'updated' event. A delete -> restore trail should be
--       legible in history; emit 'restored' instead. (No reject trigger
--       -- resurrection itself is allowed; it just needs to read clearly.)
--
-- Note on (B), actor integrity: deliberately deferred to Phase 4 where
-- JWT-derived auth.uid() lands as the authoritative actor and audit.actor
-- becomes an admin-only escape hatch. The trigger here still resolves
-- actor via the Phase 3 priority order.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 1. add account_seq + uniqueness + ordering index
-- ============================================================================

-- events is freshly created in 20260604000002_phase3_audit.sql and has no
-- rows at migration time (the seed runs after migrations). A simple NOT
-- NULL add is safe.
alter table public.events
  add column account_seq bigint not null;

alter table public.events
  add constraint events_account_seq_uk unique (account_id, account_seq);

-- (B-tree by sequence is the only ordering used by verify_chain.)
create index events_account_id_seq_idx
  on public.events (account_id, account_seq);

-- The old (account_id, occurred_at, id) index was for chain walks; no
-- longer the chain ordering key.
drop index if exists public.events_account_id_occurred_at_idx;

-- ============================================================================
-- 2. expand event_type check to allow 'restored'
-- ============================================================================
--
-- The original Phase 3 constraint is an inline column check; Postgres named
-- it events_event_type_check by convention, but be defensive and locate by
-- definition in case of name drift.

do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.events'::regclass
    and contype  = 'c'
    and pg_get_constraintdef(oid) ilike '%event_type%';
  if c is not null then
    execute format('alter table public.events drop constraint %I', c);
  end if;
end $$;

alter table public.events
  add constraint events_event_type_check
  check (event_type in ('inserted', 'updated', 'deleted', 'restored', 'hard_deleted'));

-- ============================================================================
-- 3. _emit_event(): rewritten for (A) jsonb canonical + genesis, (C) account_seq, (F) restored
-- ============================================================================

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
  v_account_seq  bigint;
  v_canonical    jsonb;
  v_hash         bytea;
  -- 32 zero bytes; the genesis predecessor for the first event per account.
  -- Inside the hashed preimage so "no predecessor" is a distinguishable
  -- value, not an empty string an attacker could synthesise.
  v_genesis      bytea := decode(repeat('00', 32), 'hex');
begin
  -- account_id (special-case accounts.id IS the account)
  if TG_TABLE_NAME = 'accounts' then
    v_account_id := case TG_OP when 'DELETE' then OLD.id else NEW.id end;
  else
    v_account_id := case TG_OP when 'DELETE' then OLD.account_id else NEW.account_id end;
  end if;

  -- entity_id (unit_details PK is area_id; everything else is id)
  if TG_TABLE_NAME = 'unit_details' then
    v_entity_id := case TG_OP when 'DELETE' then OLD.area_id else NEW.area_id end;
  else
    v_entity_id := case TG_OP when 'DELETE' then OLD.id else NEW.id end;
  end if;

  -- event_type + payload, including 'restored' on a deleted_at null<-non-null transition
  if TG_OP = 'INSERT' then
    v_event_type := 'inserted';
    v_payload    := jsonb_build_object('after', to_jsonb(NEW));
  elsif TG_OP = 'UPDATE' then
    if (to_jsonb(OLD) ? 'deleted_at') and (to_jsonb(NEW) ? 'deleted_at') then
      if      (to_jsonb(OLD) ->> 'deleted_at') is null     and (to_jsonb(NEW) ->> 'deleted_at') is not null then
        v_event_type := 'deleted';
      elsif   (to_jsonb(OLD) ->> 'deleted_at') is not null and (to_jsonb(NEW) ->> 'deleted_at') is null     then
        v_event_type := 'restored';
      else
        v_event_type := 'updated';
      end if;
    else
      v_event_type := 'updated';
    end if;
    v_payload := jsonb_build_object('before', to_jsonb(OLD), 'after', to_jsonb(NEW));
  else  -- DELETE
    v_event_type := 'hard_deleted';
    v_payload    := jsonb_build_object('before', to_jsonb(OLD));
  end if;

  -- actor (unchanged from Phase 3; Phase 4 inverts the priority)
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

  -- per-account advisory lock so concurrent writers serialise. The next two
  -- statements (read predecessor + insert) must be atomic per account.
  perform pg_advisory_xact_lock(
    hashtextextended('events_chain:' || v_account_id::text, 0)
  );

  -- Predecessor lookup. Order by account_seq -- the only valid order key,
  -- since (a) clock_timestamp() can move backward and (b) id is a random
  -- uuid. account_seq is assigned under THIS lock, so the latest row's
  -- account_seq is the true predecessor's position.
  select event_hash, account_seq
  into v_prev_hash, v_account_seq
  from public.events
  where account_id = v_account_id
  order by account_seq desc
  limit 1;

  if v_account_seq is null then
    v_account_seq := 1;
    v_prev_hash   := v_genesis;
  else
    v_account_seq := v_account_seq + 1;
  end if;

  -- Canonical preimage: jsonb. jsonb's text serialisation sorts keys alpha-
  -- betically and JSON-escapes strings -- so neither delimiter ambiguity
  -- nor field-boundary attacks are possible. The 'prev' value is always
  -- 64 hex chars (a real predecessor hash or the all-zero genesis).
  v_canonical := jsonb_build_object(
    'account_id',  v_account_id,
    'account_seq', v_account_seq,
    'entity_id',   v_entity_id,
    'entity_type', v_entity_type,
    'event_type',  v_event_type,
    'occurred_at', v_occurred_at,
    'payload',     v_payload,
    'prev',        encode(v_prev_hash, 'hex')
  );
  v_hash := digest(v_canonical::text, 'sha256');

  insert into public.events (
    account_id, account_seq, actor, entity_type, entity_id, event_type, payload,
    occurred_at, prev_event_hash, event_hash
  ) values (
    v_account_id, v_account_seq, v_actor, v_entity_type, v_entity_id, v_event_type, v_payload,
    v_occurred_at, v_prev_hash, v_hash
  );

  return null;
end;
$$;

-- ============================================================================
-- 4. verify_chain(): rewritten to walk by account_seq and use the same canonical
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
  v_prev     bytea := decode(repeat('00', 32), 'hex');
  v_canonical jsonb;
  v_expected bytea;
  v_n        bigint := 0;
begin
  for e in
    select id, account_id, account_seq, entity_type, entity_id, event_type, payload,
           occurred_at, prev_event_hash, event_hash
    from public.events
    where account_id = p_account_id
    order by account_seq asc
  loop
    v_n := v_n + 1;

    -- (i) account_seq must be gap-free starting at 1.
    if e.account_seq <> v_n then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := format('account_seq gap at position %s: row has account_seq %s', v_n, e.account_seq);
      return next; return;
    end if;

    -- (ii) prev_event_hash must match the previous walk-step's hash
    --      (or the genesis on the first event).
    if e.prev_event_hash is distinct from v_prev then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := 'prev_event_hash mismatch';
      return next; return;
    end if;

    -- (iii) recompute the canonical preimage and compare hashes.
    v_canonical := jsonb_build_object(
      'account_id',  e.account_id,
      'account_seq', e.account_seq,
      'entity_id',   e.entity_id,
      'entity_type', e.entity_type,
      'event_type',  e.event_type,
      'occurred_at', e.occurred_at,
      'payload',     e.payload,
      'prev',        encode(v_prev, 'hex')
    );
    v_expected := digest(v_canonical::text, 'sha256');

    if e.event_hash is distinct from v_expected then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := 'event_hash recomputation mismatch';
      return next; return;
    end if;

    v_prev := e.event_hash;
  end loop;

  ok := true; broken_at := null; broken_event_no := null; reason := null;
  return next;
end;
$$;
