-- ----------------------------------------------------------------------------
-- Phase 5: qualify pgcrypto for both local-stack and ephemeral-postgres environments.
--
-- Surfaced by the API-level isolation test against `supabase start`:
--   error: function digest(text, unknown) does not exist
--
-- pgcrypto's digest() is installed to a different schema depending on the
-- environment:
--   - supabase start / Supabase prod: schema `extensions`
--   - ephemeral postgres + supabase_compat.sql: schema `public`
--
-- The Phase 3 / 3.1 / 4 trigger functions set `search_path = public`, which
-- works for the ephemeral test but NOT for a real Supabase project. The
-- failure mode is silent until the first audit event tries to insert.
--
-- Fix: re-create _emit_event and verify_chain with `search_path = public,
-- extensions`. The unqualified `digest(...)` call now resolves in both
-- environments. No other behaviour change.
-- ----------------------------------------------------------------------------

create or replace function public._emit_event()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_account_id   uuid;
  v_entity_type  text := TG_TABLE_NAME;
  v_entity_id    uuid;
  v_event_type   text;
  v_payload      jsonb;
  v_actor        text;
  v_authed_uid   uuid;
  v_occurred_at  timestamptz := clock_timestamp();
  v_prev_hash    bytea;
  v_account_seq  bigint;
  v_canonical    jsonb;
  v_hash         bytea;
  v_genesis      bytea := decode(repeat('00', 32), 'hex');
begin
  if TG_TABLE_NAME = 'accounts' then
    v_account_id := case TG_OP when 'DELETE' then OLD.id else NEW.id end;
  else
    v_account_id := case TG_OP when 'DELETE' then OLD.account_id else NEW.account_id end;
  end if;

  if TG_TABLE_NAME = 'unit_details' then
    v_entity_id := case TG_OP when 'DELETE' then OLD.area_id else NEW.area_id end;
  else
    v_entity_id := case TG_OP when 'DELETE' then OLD.id else NEW.id end;
  end if;

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
  else
    v_event_type := 'hard_deleted';
    v_payload    := jsonb_build_object('before', to_jsonb(OLD));
  end if;

  v_authed_uid := auth.uid();
  if v_authed_uid is not null then
    v_actor := 'user:' || v_authed_uid::text;
  else
    begin
      v_actor := nullif(current_setting('audit.actor', true), '');
    exception when others then
      v_actor := null;
    end;
    v_actor := coalesce(v_actor, 'system');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('events_chain:' || v_account_id::text, 0)
  );

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
set search_path = public, extensions
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

    if e.account_seq <> v_n then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := format('account_seq gap at position %s: row has account_seq %s', v_n, e.account_seq);
      return next; return;
    end if;

    if e.prev_event_hash is distinct from v_prev then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := 'prev_event_hash mismatch';
      return next; return;
    end if;

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
