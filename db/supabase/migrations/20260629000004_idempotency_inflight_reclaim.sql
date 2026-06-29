-- ----------------------------------------------------------------------------
-- Idempotency: bounded in-flight reclaim (claim_idempotency_key rewrite).
--
-- WHY: the middleware now bounds the post-handler completion write and the app
-- bounds total request time (25s). Both can leave a key `in_flight`
-- (completed_at IS NULL) AFTER the handler already committed -- breaking the old
-- invariant baked into prune_idempotency_keys ("in-flight ⟺ crashed pre-commit,
-- nothing committed"). Under that old model an abandoned in-flight key was only
-- freed by the janitor's 7-day prune, so a client following the documented
-- "retry with the same Idempotency-Key" guidance would get 409 idempotency_in_
-- flight for up to a week.
--
-- FIX: on a claim conflict, if the existing row is in-flight AND older than the
-- max request budget (90s > the 25s app timeout + margin), the row cannot
-- belong to a live request -- so a same-key retry atomically RECLAIMS it and
-- re-executes. Recovery shrinks from days to ~90s. The single
-- UPDATE ... WHERE ... is race-safe (at most one concurrent retry flips the
-- row). Completed keys are untouched (still replay for their 30-day retention);
-- prune_idempotency_keys stays as the janitor for never-retried abandoned keys.
--
-- SAFETY: reclaim re-executes, so if the original attempt DID commit, a redo is
-- possible -- the SAME property the system already had at the 7-day prune, just
-- reached sooner. Redo-tolerant ops (uploads dedupe by content_hash; soft-
-- deletes are no-ops on the second pass) are unaffected. Strict exactly-once for
-- non-idempotent writes (e.g. payments) wants the completion written inside the
-- handler's own transaction (in-flight ⟺ not-committed) -- tracked as a follow-up.
--
-- Behaviour matrix is otherwise UNCHANGED from 20260614000002. Same 3-arg
-- signature, so this replaces the function in place and the existing
-- `grant ... to authenticated` is preserved (re-affirmed below for clarity).
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
  -- (1) Fresh claim: insert the placeholder. The winner runs the handler.
  insert into public.idempotency_keys (account_id, key, request_fingerprint)
  values (p_account_id, p_key, p_fingerprint)
  on conflict (account_id, key) do nothing;
  if found then
    claimed := true; fingerprint_matches := true; in_flight := false;
    status_code := null; body := null;
    return next; return;
  end if;

  -- (2) Conflict -> try to RECLAIM an abandoned in-flight placeholder. A row
  -- still in-flight 90s+ after it was created cannot be a live request (the app
  -- caps requests at 25s), so a retry may take it over and re-execute. Race-safe:
  -- the predicate + single UPDATE means only one concurrent retry can win.
  update public.idempotency_keys
     set request_fingerprint = p_fingerprint,
         status_code         = null,
         body                = null,
         completed_at        = null,
         created_at          = now(),
         expires_at          = now() + interval '30 days'
   where account_id = p_account_id
     and key        = p_key
     and completed_at is null
     and created_at < now() - interval '90 seconds';
  if found then
    claimed := true; fingerprint_matches := true; in_flight := false;
    status_code := null; body := null;
    return next; return;
  end if;

  -- (3) A live row owns the key: inspect it (replay / in-flight / mismatch).
  select k.request_fingerprint, k.status_code, k.body, k.completed_at
    into v_row
    from public.idempotency_keys k
   where k.account_id = p_account_id and k.key = p_key;
  if v_row is null then
    -- Vanished between the conflicting insert and this read (e.g. janitor
    -- prune, or a concurrent reclaim that then completed). Surface as in-flight;
    -- the client retry will claim cleanly.
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
