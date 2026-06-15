-- ----------------------------------------------------------------------------
-- advance_tenancy_statuses: daily idempotent upcoming→active transition.
--
-- WHY STORED STATUS (not derive-on-read)
-- ----------------------------------------
-- tenancies.status is intentionally stored rather than derived on every
-- read. Two reasons:
--
--   1. The end boundary is a HUMAN decision. 'holdover' means the lease
--      expired but the landlord has not yet acted; 'ended' means they chose
--      to close it. Neither can be inferred from dates alone. If we derived
--      status on read, we would have to treat every expired tenancy as
--      'ended', which would contradict a row whose stored status says
--      'holdover'. Result: split-brain (API says 'ended', DB says 'holdover').
--
--   2. status='ended' has a TRIGGER SIDE-EFFECT (_revoke_intake_on_tenancy_end
--      fires on the UPDATE, immediately revoking intake tokens). Derive-on-read
--      would produce the correct label in queries but would NEVER fire that
--      trigger. We cannot safely move that side-effect out of the trigger
--      without a much larger refactor -- so derive-on-read is ruled out.
--
-- The ONLY safe, unambiguous, date-driven transition is upcoming→active:
--   * It has no side-effects (no trigger listens for this transition).
--   * start_date is an objective fact; if it is in the past the tenancy has
--     started by definition.
--   * The inverse is not true: we cannot mechanically flip active→ended or
--     active→holdover.
--
-- IDEMPOTENCY
-- -----------
-- The UPDATE WHERE clause includes `status = 'upcoming'`. Once a row is
-- flipped to 'active' it no longer satisfies that predicate, so re-running
-- the function is a no-op (zero rows returned, zero rows changed). Concurrent
-- calls are also safe: the second one simply finds nothing to flip.
--
-- AUDIT ATTRIBUTION
-- -----------------
-- The function sets audit.actor='system:cron:tenancy' before the UPDATE.
-- The _emit_event() trigger resolves the actor from that GUC (auth.uid()
-- is null in a cron context, so the GUC wins). Every tenancy flip appears
-- in public.events attributed to 'system:cron:tenancy'.
--
-- OPERATIONAL: BACKFILL + SCHEDULING (NOT done in this migration)
-- ----------------------------------
-- This migration only DEFINES the function + supporting index. It deliberately
-- does NOT backfill or schedule inside the migration transaction: a backfill
-- across all accounts emits one audit-chain event per flipped row under a
-- per-account advisory lock, and running that unbounded inside the deploy
-- transaction is an availability risk. Run BOTH operationally after deploy
-- (same pattern as reconcile_message_outbox), with the connection in UTC so
-- p_as_of::date is deterministic:
--
--   -- one-time backfill (flips tenancies already started but stuck 'upcoming'):
--   select public.advance_tenancy_statuses();
--
--   -- daily schedule, e.g. 00:05 UTC:
--   select cron.schedule('advance-tenancy-statuses', '5 0 * * *',
--                         $$select public.advance_tenancy_statuses()$$);
-- ----------------------------------------------------------------------------

create or replace function public.advance_tenancy_statuses(
  p_as_of timestamptz default now()
)
returns table (
  o_tenancy_id uuid,
  o_account_id uuid,
  o_start_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := 'system:cron:tenancy';
begin
  perform set_config('audit.actor', v_actor, true);

  return query
    update public.tenancies t
       set status = 'active',
           updated_at = now()
     where t.status = 'upcoming'
       and t.deleted_at is null
       and t.start_date <= p_as_of::date
    returning t.id, t.account_id, t.start_date;
end;
$$;

grant execute on function public.advance_tenancy_statuses(timestamptz) to service_role;

-- Partial index supporting the sweep (the daily cron and the operational
-- backfill). The predicate mirrors the function's WHERE exactly; 'upcoming' is
-- a small, monotonically shrinking partition (rows leave it permanently once
-- flipped), so this index stays tiny and the sweep is an index range scan on
-- start_date rather than a scan of every upcoming row.
create index if not exists tenancies_upcoming_start_idx
  on public.tenancies (start_date)
  where status = 'upcoming' and deleted_at is null;
