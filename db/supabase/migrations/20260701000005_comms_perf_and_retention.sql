-- ----------------------------------------------------------------------------
-- Comms ledger — performance indexes + inbound_raw retention janitor.
--
-- Post-deploy optimization pass (scalability/performance review). All changes
-- are expand-only and CONTRACT-NEUTRAL (no endpoint/schema change): index
-- swaps and a service-role housekeeping function only.
--
-- (A) Opt-out parking scan. record_opt_out (…03) parks queued sends with
--     `where status='queued' and channel=$ and to_address=$` — NO account_id,
--     because compliance is global. comm_outbox_pending_idx leads with
--     account_id (absent here), so every STOP keyword seq-scanned the whole
--     comm_outbox. A partial index on the parking predicate makes it a point
--     lookup and stays tiny (only live-queued rows).
--
-- (B) Dispatch-scan ordering. The transport's dispatch scan is
--     `account_id + status='queued' [+ not_before eligibility] ORDER BY
--     created_at, id LIMIT n+1` (keyset pagination). The old pending index
--     (account_id, status, not_before) served the filter but NOT the keyset
--     order, so every page added a Sort. Reorder it to
--     (account_id, status, created_at, id) so the scan is index-ordered and
--     incremental (keyset as intended). not_before becomes a cheap recheck
--     (the NULL-or-<= disjunction was never a clean index range anyway), and
--     reconcile_scan still gets its (account_id, status='sending') prefix.
--
-- (C) Redundant account_id indexes. Each of these tables also has
--     `unique(account_id, id)`, whose leading column already serves every
--     account_id-equality lookup, so the standalone (account_id) index only
--     added write-time maintenance — on comm_outbox, on the hottest write
--     path. Drop them.
--
-- (D) Retention: inbound_raw. inbound_raw stores the full jsonb payload of
--     every inbound message, is member-invisible, and is never read after its
--     match result is cached — pure write-and-forget bloat that grows with
--     total inbound volume. It is deliberately NOT audit-attached, so pruning
--     it emits no events. A TTL janitor prunes rows past a dedupe horizon
--     (default 90d — far beyond any real provider retry window, so replay
--     dedupe is unaffected). Mirrors the house cron-janitor pattern
--     (SECURITY DEFINER, service_role-only, scheduled operationally).
--
--     comm_outbox is intentionally NOT pruned here: it is audit-attached, so
--     a DELETE emits a hash-chained 'hard_deleted' event carrying the full
--     before-image (larger than the row removed) — pruning it would grow the
--     events chain MORE than it shrinks the outbox, the opposite of the goal.
--     With the partial indexes above, terminal outbox rows no longer cost the
--     hot queries anything; their storage is inherent to the audited
--     operational model. Bounding events/comm_outbox is a separate
--     (partitioning / checkpoint) design, tracked as a follow-up.
-- ----------------------------------------------------------------------------

-- (A) opt-out parking scan -> point lookup on live-queued rows.
create index comm_outbox_optout_park_idx
  on public.comm_outbox (channel, to_address)
  where status = 'queued';

-- (B) dispatch scan: index-ordered keyset pagination + reconcile prefix.
drop index public.comm_outbox_pending_idx;
create index comm_outbox_pending_idx
  on public.comm_outbox (account_id, status, created_at, id)
  where status in ('queued', 'sending', 'needs_reconcile');

-- (C) drop standalone (account_id) indexes redundant with unique(account_id, id).
drop index public.comm_outbox_account_id_idx;
drop index public.platform_numbers_account_id_idx;
drop index public.comm_threads_account_id_idx;
drop index public.comm_policies_account_id_idx;

-- (D) inbound_raw retention janitor.
--
-- SECURITY DEFINER + service_role-only, per the house cron-janitor convention
-- (generate_rent_charges / advance_tenancy_statuses / bump_ip_rate_bucket).
-- No audit.actor is set: inbound_raw is not audit-attached. Returns the number
-- of rows pruned. NOT scheduled in this migration (scheduling an unbounded
-- delete inside the deploy transaction is an availability risk); schedule
-- operationally after deploy, e.g.:
--
--   -- one-time / ad hoc:
--   select public.prune_inbound_raw();                 -- default 90 days
--   -- daily at 03:20 UTC:
--   select cron.schedule('prune-inbound-raw', '20 3 * * *',
--                         $$select public.prune_inbound_raw()$$);
create or replace function public.prune_inbound_raw(
  p_older_than interval default interval '90 days'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pruned integer;
begin
  delete from public.inbound_raw
   where received_at < now() - p_older_than;
  get diagnostics v_pruned = row_count;
  return v_pruned;
end;
$$;

revoke execute on function public.prune_inbound_raw(interval) from public;
revoke execute on function public.prune_inbound_raw(interval) from anon;
revoke execute on function public.prune_inbound_raw(interval) from authenticated;
grant  execute on function public.prune_inbound_raw(interval) to service_role;
