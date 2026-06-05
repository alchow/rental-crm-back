-- ----------------------------------------------------------------------------
-- Phase 4: actor integrity (B from the Phase 3 review).
--
-- The Phase 3.1 trigger let audit.actor (a session-settable GUC) override
-- auth.uid() when both were set. On the user-facing path that's spoofable:
-- an authenticated user could run `select set_config('audit.actor', 'system',
-- true)` in their session and attribute writes to anyone. That defeats actor
-- attribution -- the whole point of the audit trail's WHO column.
--
-- Invert the priority: auth.uid() is AUTHORITATIVE whenever it's non-null
-- (i.e. on any user-facing connection that came in via PostgREST with a
-- verified JWT). audit.actor is only honoured when auth.uid() is null --
-- the admin/service path (cron jobs, evidence export, magic-link intake
-- in Phase 7) where the end user can't reach the GUC.
--
-- This is the only change to _emit_event; the canonical encoding, chain
-- ordering, advisory lock, and 'restored' detection from Phase 3.1 are
-- preserved verbatim.
-- ----------------------------------------------------------------------------

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
  v_authed_uid   uuid;
  v_occurred_at  timestamptz := clock_timestamp();
  v_prev_hash    bytea;
  v_account_seq  bigint;
  v_canonical    jsonb;
  v_hash         bytea;
  v_genesis      bytea := decode(repeat('00', 32), 'hex');
begin
  -- account_id
  if TG_TABLE_NAME = 'accounts' then
    v_account_id := case TG_OP when 'DELETE' then OLD.id else NEW.id end;
  else
    v_account_id := case TG_OP when 'DELETE' then OLD.account_id else NEW.account_id end;
  end if;

  -- entity_id
  if TG_TABLE_NAME = 'unit_details' then
    v_entity_id := case TG_OP when 'DELETE' then OLD.area_id else NEW.area_id end;
  else
    v_entity_id := case TG_OP when 'DELETE' then OLD.id else NEW.id end;
  end if;

  -- event_type + payload (incl. restored on deleted_at clear)
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

  -- ===================================================================
  -- B: actor priority -- auth.uid() is authoritative on user-facing path.
  -- ===================================================================
  v_authed_uid := auth.uid();
  if v_authed_uid is not null then
    -- The connection has a verified JWT. The JWT-derived uid is the
    -- only acceptable actor; audit.actor is IGNORED here so the user
    -- cannot attribute their own writes to anyone else.
    v_actor := 'user:' || v_authed_uid::text;
  else
    -- No authenticated user -- admin/service path or a direct DB write
    -- (no JWT claims set). audit.actor is honoured here; the admin path
    -- sets it to 'tenant:<token_id>' for tenant intake (Phase 7), or
    -- 'system:<job>' for cron-driven writes (Phase 9).
    begin
      v_actor := nullif(current_setting('audit.actor', true), '');
    exception when others then
      v_actor := null;
    end;
    v_actor := coalesce(v_actor, 'system');
  end if;

  -- per-account advisory lock + chain assembly (unchanged from Phase 3.1)
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
