-- ----------------------------------------------------------------------------
-- Phase 2.4 (architecture plan): idempotency claim/complete RPCs.
--
-- The middleware's claim choreography was INSERT (claim) -> on conflict a
-- second SELECT (inspect the winner) -> after the handler an UPDATE
-- (complete): 2 PostgREST round trips per mutating request, 3 in the race
-- path. These SECURITY INVOKER functions collapse claim+inspect into one
-- call and keep RLS fully in force (the caller's own member policies on
-- idempotency_keys apply unchanged).
--
-- BEHAVIOR MATRIX (frozen -- ported verbatim from the middleware contract):
--   * claimed=true                    -> caller won; run the handler, then
--                                        complete_idempotency_key with the
--                                        response (2xx-4xx only; a 5xx
--                                        DELETEs the placeholder so retries
--                                        get a fresh attempt).
--   * fingerprint_matches=false      -> same key, DIFFERENT request body:
--                                        409, never overwrite or replay.
--   * in_flight=true                 -> original request still running:
--                                        409, client retries shortly.
--   * otherwise                      -> replay the cached (status_code,
--                                        body) verbatim.
-- ----------------------------------------------------------------------------

create or replace function public.claim_idempotency_key(
  p_account_id  uuid,
  p_key         text,
  p_fingerprint text
)
returns table (
  claimed             boolean,
  fingerprint_matches boolean,
  in_flight           boolean,
  status_code         int,
  body                jsonb
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row record;
begin
  insert into public.idempotency_keys (account_id, key, request_fingerprint)
  values (p_account_id, p_key, p_fingerprint)
  on conflict (account_id, key) do nothing;
  if found then
    claimed := true; fingerprint_matches := true; in_flight := false;
    status_code := null; body := null;
    return next; return;
  end if;

  select k.request_fingerprint, k.status_code, k.body, k.completed_at
    into v_row
    from public.idempotency_keys k
   where k.account_id = p_account_id and k.key = p_key;
  if v_row is null then
    -- Vanished between the conflicting insert and this read (e.g. janitor
    -- prune). Surface as in-flight; the client retry will claim cleanly.
    claimed := false; fingerprint_matches := true; in_flight := true;
    status_code := null; body := null;
    return next; return;
  end if;

  claimed := false;
  fingerprint_matches := (v_row.request_fingerprint = p_fingerprint);
  in_flight := (v_row.completed_at is null);
  status_code := v_row.status_code;
  body := v_row.body;
  return next;
end;
$$;

grant execute on function public.claim_idempotency_key(uuid, text, text) to authenticated;

create or replace function public.complete_idempotency_key(
  p_account_id uuid,
  p_key        text,
  p_status     int,
  p_body       jsonb
)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.idempotency_keys
     set status_code  = p_status,
         body         = p_body,
         completed_at = now()
   where account_id = p_account_id and key = p_key;
$$;

grant execute on function public.complete_idempotency_key(uuid, text, int, jsonb) to authenticated;
