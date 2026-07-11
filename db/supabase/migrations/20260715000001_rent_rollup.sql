-- ----------------------------------------------------------------------------
-- Account-wide rent rollup (Field Log ask #4).
--
-- One row per tenancy in the requested statuses (default: the "current" set,
-- active + holdover): non-deposit balance, deposit balance, and unapplied
-- credit. Replaces the client's one-GET-/ledger-per-tenancy fan-out (capped
-- at 40 doors in the FE, which silently dropped rent-due indicators above
-- the cap).
--
-- The balance is still DERIVED ON READ — this function recomputes from
-- charges + payments + allocations on every call, exactly like the
-- per-tenancy ledger; nothing is stored. ("A stored balance is a lie
-- waiting to drift", api/src/routes/ledger.ts.)
--
-- SEMANTICS CONTRACT: this mirrors api/src/routes/ledger.ts totals, rule for
-- rule. Any change to the ledger's aggregation rules MUST update both and
-- keep the parity test green (api/test/rent-rollup.test.ts asserts
-- rollup == ledger per tenancy):
--   * voided / soft-deleted charges and payments are excluded;
--   * an allocation is ACTIVE only when its payment AND charge are both
--     live (non-voided, non-deleted) — and both sides sit in the same
--     tenancy (the write trigger enforces this; the join re-asserts it);
--   * rent_balance = all NON-DEPOSIT charge types (the ledger's legacy
--     rent_* semantics — see totals.by_type for the per-type split);
--   * deposit split on charges.type = 'deposit';
--   * unapplied_credit = sum(live payments) - sum(active allocations);
--   * currency mirrors the ledger's pick exactly: any NON-DELETED charge
--     first (voided included — the ledger reads chargeRows[0] before the
--     void filter), else any non-deleted payment. Single-currency
--     tenancies in practice; min() just makes the pick deterministic.
--
-- SECURITY INVOKER: RLS is the isolation boundary. The p_account_id
-- predicate is a planner hint and defense-in-depth, not the fence — a
-- caller passing another account's id gets zero rows because RLS hides the
-- rows themselves. (Pattern: search_entities, 20260620000001.)
-- ----------------------------------------------------------------------------

create or replace function public.rent_rollup(
  p_account_id uuid,
  p_statuses   text[] default array['active', 'holdover']
)
returns table (
  tenancy_id             uuid,
  status                 text,
  currency               text,
  rent_balance_cents     bigint,
  deposit_balance_cents  bigint,
  unapplied_credit_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with t as (
    select id, status
      from public.tenancies
     where account_id = p_account_id
       and deleted_at is null
       and status = any(coalesce(p_statuses, array['active', 'holdover']))
  ),
  live_charges as (
    select c.tenancy_id,
           sum(c.amount_cents) filter (where c.type <> 'deposit') as rent_charges,
           sum(c.amount_cents) filter (where c.type =  'deposit') as deposit_charges
      from public.charges c
      join t on t.id = c.tenancy_id
     where c.account_id = p_account_id
       and c.deleted_at is null
       and c.voided_at is null
     group by c.tenancy_id
  ),
  live_payments as (
    select p.tenancy_id,
           sum(p.amount_cents) as received
      from public.payments p
      join t on t.id = p.tenancy_id
     where p.account_id = p_account_id
       and p.deleted_at is null
       and p.voided_at is null
     group by p.tenancy_id
  ),
  -- Currency picked over NON-DELETED rows INCLUDING voided ones — the
  -- ledger reads its currency off chargeRows[0] before any void filter, so
  -- a tenancy whose only charge is voided still reports that currency.
  currencies as (
    select t.id as tenancy_id,
           (select min(c.currency) from public.charges c
             where c.account_id = p_account_id and c.tenancy_id = t.id
               and c.deleted_at is null) as charge_currency,
           (select min(p.currency) from public.payments p
             where p.account_id = p_account_id and p.tenancy_id = t.id
               and p.deleted_at is null) as payment_currency
      from t
  ),
  active_allocations as (
    select c.tenancy_id,
           sum(a.amount_cents) filter (where c.type <> 'deposit') as rent_allocated,
           sum(a.amount_cents) filter (where c.type =  'deposit') as deposit_allocated,
           sum(a.amount_cents)                                    as total_allocated
      from public.payment_allocations a
      join public.charges  c on c.account_id = a.account_id and c.id = a.charge_id
      join public.payments p on p.account_id = a.account_id and p.id = a.payment_id
      join t on t.id = c.tenancy_id
     where a.account_id = p_account_id
       and a.deleted_at is null
       and c.deleted_at is null and c.voided_at is null
       and p.deleted_at is null and p.voided_at is null
       and p.tenancy_id = c.tenancy_id
     group by c.tenancy_id
  )
  select t.id,
         t.status,
         coalesce(cu.charge_currency, cu.payment_currency),
         (coalesce(lc.rent_charges, 0)    - coalesce(aa.rent_allocated, 0))::bigint,
         (coalesce(lc.deposit_charges, 0) - coalesce(aa.deposit_allocated, 0))::bigint,
         (coalesce(lp.received, 0)        - coalesce(aa.total_allocated, 0))::bigint
    from t
    left join live_charges       lc on lc.tenancy_id = t.id
    left join live_payments      lp on lp.tenancy_id = t.id
    left join active_allocations aa on aa.tenancy_id = t.id
    left join currencies         cu on cu.tenancy_id = t.id
$$;

-- Default PostgREST-era ACLs would let anon call this; scope it to real
-- callers only (INVOKER + RLS make it safe regardless — belt and braces).
revoke execute on function public.rent_rollup(uuid, text[]) from public, anon;
grant  execute on function public.rent_rollup(uuid, text[]) to authenticated, service_role;
