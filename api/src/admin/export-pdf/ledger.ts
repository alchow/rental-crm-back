import type { ExportData } from '../export-pdf';

// ---- ledger derivation ------------------------------------------------------

export interface DerivedLedger {
  // Standing context (Phase 11 flag B): opening_balance is what's owed
  // entering the date range. With no from_date, opening_balance is 0
  // and rent_charges_in_range / rent_payments_in_range are the totals.
  opening_balance_cents: number;
  rent_charges_in_range_cents: number;
  rent_payments_in_range_cents: number;
  // Closing balance = opening + in-range charges - in-range payments.
  // This is the "balance you'd see if you looked just at the slice."
  closing_balance_cents: number;
  // Whole-history (deposits + unapplied credit don't care about the slice
  // -- a deposit was either taken or wasn't; an unapplied credit is real
  // money regardless of when it landed).
  deposit_charges_cents: number;
  deposit_payments_cents: number;
  unapplied_credit_cents: number;
  // The dates used; surfaced so the renderer can label the opening line.
  from_date: string | null;
  to_date: string | null;
  currency: string | null;
}

export function inRangeISO(
  iso: string | null | undefined,
  from: string | null,
  to: string | null,
): boolean {
  if (!iso) return false;
  // Compare lexically. Postgres dates render as YYYY-MM-DD; timestamps
  // render as YYYY-MM-DD... -- both compare correctly against ISO date
  // bounds at the prefix.
  if (from && iso < from) return false;
  if (to && iso > `${to}T23:59:59Z`) return false;
  return true;
}

export function deriveLedger(
  data: ExportData,
  from: string | null,
  to: string | null,
): DerivedLedger {
  const chargeIds = new Set(data.charges.map((c) => c.id as string));
  const paymentIds = new Set(data.payments.map((p) => p.id as string));
  const voidedCharges = new Set(data.charges.filter((c) => c.voided_at).map((c) => c.id as string));
  const voidedPayments = new Set(
    data.payments.filter((p) => p.voided_at).map((p) => p.id as string),
  );
  const tenancyAllocs = data.allocations.filter(
    (a) => chargeIds.has(a.charge_id as string) && paymentIds.has(a.payment_id as string),
  );

  // ---- whole-history aggregates (deposit + unapplied credit) -------------
  let depositChargesC = 0,
    depositPaymentsC = 0;
  for (const cr of data.charges) {
    if (cr.voided_at) continue;
    if (cr.type === 'deposit') depositChargesC += cr.amount_cents as number;
  }
  let totalAllocatedC = 0;
  for (const a of tenancyAllocs) {
    if (voidedPayments.has(a.payment_id as string)) continue;
    if (voidedCharges.has(a.charge_id as string)) continue;
    totalAllocatedC += a.amount_cents as number;
    const isDeposit = data.charges.find((c) => c.id === a.charge_id)?.type === 'deposit';
    if (isDeposit) depositPaymentsC += a.amount_cents as number;
  }
  let totalReceivedC = 0;
  for (const pr of data.payments) {
    if (pr.voided_at) continue;
    totalReceivedC += pr.amount_cents as number;
  }
  const unappliedCredit = Math.max(0, totalReceivedC - totalAllocatedC);

  // ---- opening balance + in-range slice ----------------------------------
  // Opening balance = rent charges due strictly BEFORE from_date minus the
  // RENT-charge-allocated portion of payments received before from_date.
  // (Deposit charges don't roll into the rent balance.)
  const isRentCharge = (id: string) =>
    data.charges.find((c) => c.id === id)?.type !== 'deposit' && !voidedCharges.has(id);

  let openingChargedC = 0;
  for (const cr of data.charges) {
    if (cr.voided_at) continue;
    if (cr.type === 'deposit') continue;
    if (from && (cr.due_date as string) < from) {
      openingChargedC += cr.amount_cents as number;
    }
  }
  let openingPaidC = 0;
  for (const a of tenancyAllocs) {
    const pay = data.payments.find((p) => p.id === a.payment_id);
    if (!pay) continue;
    if (pay.voided_at) continue;
    if (!isRentCharge(a.charge_id as string)) continue;
    if (from && (pay.received_at as string) < from) {
      openingPaidC += a.amount_cents as number;
    }
  }
  const openingBalanceC = from ? openingChargedC - openingPaidC : 0;

  let inRangeChargesC = 0;
  for (const cr of data.charges) {
    if (cr.voided_at) continue;
    if (cr.type === 'deposit') continue;
    const dd = cr.due_date as string;
    // due_date is a YYYY-MM-DD; treat the range bounds the same way.
    if (from && dd < from) continue;
    if (to && dd > to) continue;
    inRangeChargesC += cr.amount_cents as number;
  }
  let inRangePaymentsC = 0;
  for (const a of tenancyAllocs) {
    const pay = data.payments.find((p) => p.id === a.payment_id);
    if (!pay) continue;
    if (pay.voided_at) continue;
    if (!isRentCharge(a.charge_id as string)) continue;
    if (!inRangeISO(pay.received_at as string, from, to)) continue;
    inRangePaymentsC += a.amount_cents as number;
  }
  const closingBalanceC = openingBalanceC + inRangeChargesC - inRangePaymentsC;

  const currency =
    (data.charges[0]?.currency as string | undefined) ??
    (data.payments[0]?.currency as string | undefined) ??
    null;

  return {
    opening_balance_cents: openingBalanceC,
    rent_charges_in_range_cents: inRangeChargesC,
    rent_payments_in_range_cents: inRangePaymentsC,
    closing_balance_cents: closingBalanceC,
    deposit_charges_cents: depositChargesC,
    deposit_payments_cents: depositPaymentsC,
    unapplied_credit_cents: unappliedCredit,
    from_date: from,
    to_date: to,
    currency,
  };
}
