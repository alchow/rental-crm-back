import type { ExportData } from '../export-pdf';
import { dayBefore, ledgerRowsAt } from '../../lib/ledger-history';

export interface DerivedLedger {
  opening_balance_cents: number;
  rent_charges_in_range_cents: number;
  // Net application movement, including reversals; not cash received or taxable income.
  rent_payments_in_range_cents: number;
  closing_balance_cents: number;
  // Landlord-stated adoption balance is separate from row-derived opening debt.
  adoption_opening_balance_cents: number;
  adoption_date: string | null;
  adoption_needs_review: boolean;
  adoption_balance_basis: string | null;
  deposit_charges_cents: number;
  deposit_payments_cents: number;
  unapplied_credit_cents: number;
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
  const day = iso.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}

export function exportLedgerAt(data: ExportData, cutoff: string | null): ExportData {
  return {
    ...data,
    charges: ledgerRowsAt(data.charges, (row) => String(row.due_date), cutoff),
    payments: ledgerRowsAt(data.payments, (row) => String(row.received_at), cutoff),
    allocations: ledgerRowsAt(data.allocations, (row) => String(row.created_at), cutoff),
  };
}

export function paymentActivityInRange(
  payment: Record<string, unknown>,
  allocations: Array<Record<string, unknown>>,
  from: string | null,
  to: string | null,
): boolean {
  const within = (date: unknown) => typeof date === 'string' && inRangeISO(date, from, to);
  return (
    within(payment.received_at) ||
    within(payment.voided_at) ||
    allocations.some((row) => within(row.created_at) || within(row.voided_at))
  );
}

function totalsAt(data: ExportData, cutoff: string | null) {
  const snapshot = exportLedgerAt(data, cutoff);
  const charges = new Map(
    snapshot.charges.filter((row) => !row.voided_at).map((row) => [row.id, row]),
  );
  const payments = new Map(
    snapshot.payments.filter((row) => !row.voided_at).map((row) => [row.id, row]),
  );
  let charged = 0,
    applied = 0,
    depositCharged = 0,
    depositApplied = 0,
    received = 0;
  for (const row of charges.values()) {
    if (row.type === 'deposit') depositCharged += Number(row.amount_cents);
    else charged += Number(row.amount_cents);
  }
  for (const row of payments.values()) received += Number(row.amount_cents);
  for (const row of snapshot.allocations) {
    const charge = charges.get(row.charge_id);
    if (row.voided_at || !charge || !payments.has(row.payment_id)) continue;
    if (charge.type === 'deposit') depositApplied += Number(row.amount_cents);
    else applied += Number(row.amount_cents);
  }
  return {
    charged,
    applied,
    depositCharged,
    depositApplied,
    credit: received - applied - depositApplied,
  };
}

export function deriveLedger(
  data: ExportData,
  from: string | null,
  to: string | null,
): DerivedLedger {
  const end = totalsAt(data, to);
  const start = from ? totalsAt(data, dayBefore(from)) : { charged: 0, applied: 0 };
  const adoption =
    data.adoption && to && String(data.adoption.adoption_date) > to ? null : data.adoption;
  const adoptionOpening = Number(adoption?.opening_balance_cents ?? 0);
  return {
    opening_balance_cents: start.charged - start.applied,
    rent_charges_in_range_cents: end.charged - start.charged,
    rent_payments_in_range_cents: end.applied - start.applied,
    closing_balance_cents: adoptionOpening + end.charged - end.applied,
    adoption_opening_balance_cents: adoptionOpening,
    adoption_date: (adoption?.adoption_date as string | undefined) ?? null,
    adoption_needs_review: Boolean(adoption?.needs_review),
    adoption_balance_basis: (adoption?.balance_basis as string | null | undefined) ?? null,
    deposit_charges_cents: end.depositCharged,
    deposit_payments_cents: end.depositApplied,
    unapplied_credit_cents: end.credit,
    from_date: from,
    to_date: to,
    currency: (data.charges[0]?.currency ??
      data.payments[0]?.currency ??
      adoption?.currency ??
      null) as string | null,
  };
}
