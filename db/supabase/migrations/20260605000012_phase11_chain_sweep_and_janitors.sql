-- ----------------------------------------------------------------------------
-- Phase 11: out-of-band tamper detection + janitor crons (deploy blockers).
--
-- Three pieces:
--
-- (A) chain_verification_alerts + verify_chain_sweep RPC.
--     Phase 10 added a red banner inside the export PDF when verify_chain
--     fails. That's necessary but REACTIVE -- it waits for a human to
--     happen to export and look. A broken chain is a security incident
--     (DB-owner-level tampering) and must be caught PROACTIVELY: this
--     cron scans every account and inserts an alert row on failure.
--     ON CONFLICT (account_id, broken_event_no) DO NOTHING so a still-
--     broken chain doesn't spam alerts every tick; downstream monitoring
--     polls this table.
--
-- (B) prune_ip_rate_buckets RPC.
--     ip_rate_buckets grows one row per (ip, scope) and never shrinks
--     under the Phase 9 schema. Prunes rows whose window has long since
--     expired (no requests in 2x the longest configured window). Safe
--     because expired buckets are functionally empty -- the bump_*
--     RPC resets on stale windows anyway.
--
-- (C) prune_idempotency_keys RPC.
--     The most-careful prune. Idempotency keys must NEVER be freed for a
--     row that may have committed -- doing so re-opens the double-write
--     class the keys are there to defend against. Two safe categories:
--       (i)  status='completed' AND created_at < now() - TTL (1 day).
--            The 24h TTL gives a comfortable window for any in-flight
--            client retry to surface; afterwards the cache is dead
--            anyway.
--       (ii) status='in_flight' AND created_at < now() - LONG_TTL (7 days)
--            AND no audit event references the placeholder. The 7-day
--            horizon is far beyond any realistic client retry; absence
--            of an audit event for the placeholder PK means no INSERT
--            ever committed. Safe-by-construction.
--     Audited as 'system:cron:janitor'.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) chain_verification_alerts + verify_chain_sweep
-- ============================================================================

create table public.chain_verification_alerts (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts(id) on delete cascade,
  broken_event_id     uuid,
  broken_event_no     bigint,
  reason              text not null,
  first_detected_at   timestamptz not null default now(),
  last_detected_at    timestamptz not null default now(),
  resolved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One alert row per (account, broken_event_no). A sweep that re-detects
  -- the same break BUMPS last_detected_at; a different break
  -- (broken_event_no changes) creates a new row.
  unique (account_id, broken_event_no)
);
create index chain_verification_alerts_account_id_idx on public.chain_verification_alerts (account_id);
create index chain_verification_alerts_unresolved_idx
  on public.chain_verification_alerts (account_id, last_detected_at desc)
  where resolved_at is null;

alter table public.chain_verification_alerts enable row level security;
alter table public.chain_verification_alerts force  row level security;
-- Members of the affected account can SEE the alert (transparency about
-- the integrity status of their own data). No client-side writes -- the
-- cron is the only writer; revoke from anon/authenticated explicitly to
-- match the operational-infra pattern of ip_rate_buckets.
create policy chain_verification_alerts_member_select on public.chain_verification_alerts
  for select
  using (public.is_account_member(account_id));

revoke insert, update, delete on public.chain_verification_alerts from public;
revoke insert, update, delete on public.chain_verification_alerts from anon, authenticated;

-- Audit it so the alert insert itself appears in the chain. The alert is
-- attributed to 'system:cron:chain_sweep'.
create trigger chain_verification_alerts_audit
  after insert or update or delete on public.chain_verification_alerts
  for each row execute function public._emit_event();

-- The sweep RPC. Runs verify_chain for a single account; if broken, upserts
-- an alert row. If now-clean but a previous unresolved alert exists for
-- this account, marks those alerts resolved (chain has been repaired or
-- the broken row removed -- regardless, surface the change).
create or replace function public.verify_chain_sweep(p_account_id uuid)
returns table (
  ok               boolean,
  alert_inserted   boolean,
  alerts_resolved  int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := 'system:cron:chain_sweep';
  v_result record;
  v_inserted boolean := false;
  v_resolved int := 0;
begin
  perform set_config('audit.actor', v_actor, true);

  -- verify_chain returns one row for the account; ok=true OR ok=false +
  -- broken-position details.
  select vc.ok, vc.broken_at, vc.broken_event_no, vc.reason
    into v_result
    from public.verify_chain(p_account_id) vc;

  if v_result.ok then
    -- Mark any unresolved alerts for this account as resolved. The
    -- audit event for these UPDATEs is itself a useful record ("the
    -- chain was broken, now it isn't").
    update public.chain_verification_alerts
       set resolved_at = now(), updated_at = now()
     where account_id = p_account_id
       and resolved_at is null;
    get diagnostics v_resolved = row_count;
  else
    -- UPSERT the alert. ON CONFLICT bumps last_detected_at so the alert
    -- shows the most-recent confirmation without spamming new rows.
    insert into public.chain_verification_alerts
      (account_id, broken_event_id, broken_event_no, reason)
    values
      (p_account_id, v_result.broken_at, v_result.broken_event_no,
       coalesce(v_result.reason, 'verify_chain reported broken with no reason'))
    on conflict (account_id, broken_event_no) do update
      set last_detected_at = now(),
          updated_at       = now(),
          reason           = excluded.reason;
    -- The row_count is 1 either way after an UPSERT, so detect "fresh"
    -- vs "bumped" by created_at == updated_at (within the same second
    -- since now() in plpgsql is stable per stmt-time).
    select (created_at = updated_at) into v_inserted
      from public.chain_verification_alerts
     where account_id = p_account_id and broken_event_no = v_result.broken_event_no;
  end if;

  ok               := v_result.ok;
  alert_inserted   := v_inserted;
  alerts_resolved  := v_resolved;
  return next;
end;
$$;

grant execute on function public.verify_chain_sweep(uuid) to service_role;

-- ============================================================================
-- (B) prune_ip_rate_buckets RPC
-- ============================================================================
--
-- Deletes rows whose window_start is older than (now() - p_max_window_sec).
-- Since the bump_ip_rate_bucket RPC resets count to 1 on a stale window
-- anyway, the deleted rows are functionally empty. Returns the number of
-- rows pruned.

create or replace function public.prune_ip_rate_buckets(
  p_max_window_sec int default 7200
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  delete from public.ip_rate_buckets
   where window_start < now() - make_interval(secs => p_max_window_sec);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.prune_ip_rate_buckets(int) to service_role;

-- ============================================================================
-- (C) prune_idempotency_keys RPC
-- ============================================================================
--
-- The Phase 6 schema doesn't have an explicit status column. Status is
-- DERIVED:
--   completed_at IS NOT NULL  =>  the handler finished and cached its
--                                 response (status_code + body); safe to
--                                 prune past TTL.
--   completed_at IS NULL      =>  in-flight placeholder. We MUST NOT
--                                 free this if the handler may still be
--                                 running (or worse, if it committed but
--                                 then crashed before flipping the row
--                                 to completed). Conservative: only
--                                 prune in-flight rows past a LONG
--                                 horizon (7d default).

create or replace function public.prune_idempotency_keys(
  p_completed_ttl_seconds int default 86400,        -- 1 day
  p_in_flight_ttl_seconds int default 604800        -- 7 days
)
returns table (
  pruned_completed int,
  pruned_in_flight int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := 'system:cron:janitor';
  v_completed int := 0;
  v_in_flight int := 0;
begin
  perform set_config('audit.actor', v_actor, true);

  -- (i) completed past TTL: safe -- the cached response is already old;
  -- any client retry past 24h is semantically a new request.
  delete from public.idempotency_keys
   where completed_at is not null
     and completed_at < now() - make_interval(secs => p_completed_ttl_seconds);
  get diagnostics v_completed = row_count;

  -- (ii) in-flight WAY past any plausible client retry (7d default).
  -- A handler that committed always flips completed_at; a handler that
  -- crashed pre-commit leaves completed_at null. 7+ days later, any
  -- in-flight client retry has long given up; freeing the key is safe.
  delete from public.idempotency_keys
   where completed_at is null
     and created_at < now() - make_interval(secs => p_in_flight_ttl_seconds);
  get diagnostics v_in_flight = row_count;

  pruned_completed := v_completed;
  pruned_in_flight := v_in_flight;
  return next;
end;
$$;

grant execute on function public.prune_idempotency_keys(int, int) to service_role;
