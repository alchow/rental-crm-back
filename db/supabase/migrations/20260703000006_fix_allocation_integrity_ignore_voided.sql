-- ----------------------------------------------------------------------------
-- Fix: the allocation-integrity trigger must ignore voided counterparts.
--
-- BUG (reported by FE, reproduced at the DB): voiding a payment did not
-- release its charge allocation, so a later payment against the same charge
-- was rejected with "allocations (…) exceed charge amount (…)". A twin defect
-- affected the per-payment cap: after voiding a charge, re-allocating the
-- freed credit from the same payment was rejected with "exceed payment
-- amount (…)".
--
-- ROOT CAUSE: _assert_allocation_integrity() (20260605000005_phase6_money.sql)
-- computes two caps -- SUM(allocations against the charge) <= charge.amount and
-- SUM(allocations against the payment) <= payment.amount -- but each sum only
-- filtered `deleted_at is null`; NEITHER excluded allocations whose counterpart
-- row (the payment, resp. the charge) had been voided. The DERIVED ledger
-- (api/src/routes/ledger.ts) already defines an *active* allocation as one whose
-- payment AND charge are BOTH non-voided and excludes the rest, so the
-- write-time validator and the read-time ledger disagreed about which
-- allocations are live. A charge that ever had a voided payment became
-- un-payable even though the ledger showed it fully open.
--
-- FIX: bring the trigger in line with the ledger. Each cap sum now joins to the
-- counterpart row and excludes voided ones:
--   - per-charge sum  -> exclude allocations from voided PAYMENTS
--   - per-payment sum -> exclude allocations to voided CHARGES
-- This is history-preserving (allocation rows are NOT deleted on void; they are
-- simply not counted), matching the documented design in
-- api/src/routes/payments.ts.
--
-- Safety: excluding voided rows can only LOWER a counted sum, so this loosens an
-- over-strict check -- it can never permit over-allocation of live money.
-- Un-voiding is not a supported operation (voided_at is set once; the void
-- handler filters voided_at is null), so a released allocation cannot silently
-- come back and breach a cap. The per-payment / per-charge advisory locks are
-- unchanged, so concurrent writers still serialize.
--
-- This is create-or-replace of the function only; the existing
-- payment_allocations_integrity trigger binding is preserved.
-- ----------------------------------------------------------------------------

create or replace function public._assert_allocation_integrity()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_payment      record;
  v_charge       record;
  v_alloc_sum    bigint;
begin
  if NEW.amount_cents is null or NEW.amount_cents <= 0 then
    raise exception 'allocation amount_cents must be positive (got %)', NEW.amount_cents
      using errcode = 'check_violation';
  end if;

  -- Fetch the referenced payment and charge under the DEFINER's privileges
  -- (we're SECURITY DEFINER) so the trigger sees the real rows regardless
  -- of the caller's RLS context. We re-verify scoping below.
  select id, account_id, tenancy_id, amount_cents, currency, voided_at
    into v_payment
    from public.payments where id = NEW.payment_id;
  if v_payment.id is null then
    raise exception 'payment % not found', NEW.payment_id
      using errcode = 'foreign_key_violation';
  end if;

  select id, account_id, tenancy_id, amount_cents, currency, voided_at
    into v_charge
    from public.charges where id = NEW.charge_id;
  if v_charge.id is null then
    raise exception 'charge % not found', NEW.charge_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Same account_id throughout. The composite FK already enforces this for
  -- the (account_id, payment_id) and (account_id, charge_id) links, but we
  -- compare the bare account_id of payment and charge as belt-and-braces.
  if v_payment.account_id <> NEW.account_id then
    raise exception 'allocation/payment account mismatch (alloc=%, payment=%)',
      NEW.account_id, v_payment.account_id
      using errcode = 'check_violation';
  end if;
  if v_charge.account_id <> NEW.account_id then
    raise exception 'allocation/charge account mismatch (alloc=%, charge=%)',
      NEW.account_id, v_charge.account_id
      using errcode = 'check_violation';
  end if;

  -- Same tenancy_id between payment and charge. The attack the brief flags:
  -- allocate A's payment to a different tenancy's (or another account's)
  -- charge. Rejected at the DB, not in the handler.
  if v_payment.tenancy_id <> v_charge.tenancy_id then
    raise exception 'cross-tenancy allocation: payment.tenancy=% charge.tenancy=%',
      v_payment.tenancy_id, v_charge.tenancy_id
      using errcode = 'check_violation';
  end if;

  -- Same currency.
  if v_payment.currency <> v_charge.currency then
    raise exception 'currency mismatch in allocation: payment=% charge=%',
      v_payment.currency, v_charge.currency
      using errcode = 'check_violation';
  end if;

  -- Voided sources can't accept new allocations.
  if v_payment.voided_at is not null then
    raise exception 'cannot allocate from a voided payment'
      using errcode = 'check_violation';
  end if;
  if v_charge.voided_at is not null then
    raise exception 'cannot allocate to a voided charge'
      using errcode = 'check_violation';
  end if;

  -- Per-payment + per-charge advisory locks so two concurrent allocations
  -- against the same payment / same charge serialize. Without this, two
  -- parallel writers could each see the OLD sum and both pass the cap
  -- check.
  perform pg_advisory_xact_lock(
    hashtextextended('payment_alloc:' || NEW.payment_id::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('charge_alloc:'  || NEW.charge_id::text,  0)
  );

  -- Sum of allocations against this payment after this row. Allocations to a
  -- VOIDED charge are excluded: voiding the charge releases that allocation
  -- (the ledger surfaces it as unapplied credit), so its cents no longer
  -- consume this payment's capacity. Mirrors the ledger's "active allocation
  -- = payment AND charge both non-voided" rule.
  select coalesce(sum(pa.amount_cents), 0) into v_alloc_sum
    from public.payment_allocations pa
    join public.charges ch on ch.id = pa.charge_id
    where pa.payment_id = NEW.payment_id
      and (TG_OP = 'INSERT' or pa.id <> NEW.id)
      and pa.deleted_at is null
      and ch.voided_at is null;
  v_alloc_sum := v_alloc_sum + NEW.amount_cents;
  if v_alloc_sum > v_payment.amount_cents then
    raise exception 'allocations (%) exceed payment amount (%) for payment %',
      v_alloc_sum, v_payment.amount_cents, NEW.payment_id
      using errcode = 'check_violation';
  end if;

  -- Sum of allocations against this charge after this row. Allocations from a
  -- VOIDED payment are excluded: voiding the payment releases its allocation
  -- (the charge reads as open again in the ledger), so its cents no longer
  -- consume this charge's capacity. Without this, a charge that ever had a
  -- voided payment stayed un-payable.
  select coalesce(sum(pa.amount_cents), 0) into v_alloc_sum
    from public.payment_allocations pa
    join public.payments pm on pm.id = pa.payment_id
    where pa.charge_id = NEW.charge_id
      and (TG_OP = 'INSERT' or pa.id <> NEW.id)
      and pa.deleted_at is null
      and pm.voided_at is null;
  v_alloc_sum := v_alloc_sum + NEW.amount_cents;
  if v_alloc_sum > v_charge.amount_cents then
    raise exception 'allocations (%) exceed charge amount (%) for charge %',
      v_alloc_sum, v_charge.amount_cents, NEW.charge_id
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;
