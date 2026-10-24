export const CHARGE_TYPES = ['rent', 'late_fee', 'deposit', 'utility', 'parking', 'repair_chargeback', 'nsf_fee', 'other'] as const;
type ChargeType = (typeof CHARGE_TYPES)[number];
type TypeTotals = { charges_cents: number; allocated_cents: number; balance_cents: number };
export interface CurrencyTotals {
  rent_charges_cents: number; rent_payments_cents: number; rent_balance_cents: number;
  deposit_charges_cents: number; deposit_payments_cents: number; deposit_balance_cents: number;
  total_received_cents: number; total_allocated_cents: number; unapplied_credit_cents: number;
  by_type: Record<ChargeType, TypeTotals>;
}
interface Charge { id: string; currency: string; amount_cents: number; type: string; voided_at: string | null }
interface Payment { id: string; currency: string; amount_cents: number; voided_at: string | null }
interface Allocation { charge_id: string; payment_id: string; amount_cents: number; voided_at?: string | null }
export function emptyCurrencyTotals(): CurrencyTotals {
  return { rent_charges_cents: 0, rent_payments_cents: 0, rent_balance_cents: 0,
    deposit_charges_cents: 0, deposit_payments_cents: 0, deposit_balance_cents: 0,
    total_received_cents: 0, total_allocated_cents: 0, unapplied_credit_cents: 0,
    by_type: Object.fromEntries(CHARGE_TYPES.map((key) => [key, { charges_cents: 0, allocated_cents: 0, balance_cents: 0 }])) as CurrencyTotals['by_type'] };
}
const typeKey = (type: string): ChargeType => CHARGE_TYPES.includes(type as ChargeType) ? type as ChargeType : 'other';

// USD rent and EUR deposit keep independent amounts; allocations never convert currencies.
export function ledgerCurrencyTotals(charges: readonly Charge[], payments: readonly Payment[], allocations: readonly Allocation[]): Record<string, CurrencyTotals> {
  const groups: Record<string, CurrencyTotals> = {};
  const group = (currency: string) => groups[currency] ??= emptyCurrencyTotals();
  const chargeById = new Map(charges.map((charge) => [charge.id, charge]));
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  for (const charge of charges) {
    const totals = group(charge.currency);
    if (charge.voided_at) continue;
    if (charge.type === 'deposit') totals.deposit_charges_cents += charge.amount_cents;
    else totals.rent_charges_cents += charge.amount_cents;
    totals.by_type[typeKey(charge.type)].charges_cents += charge.amount_cents;
  }
  for (const payment of payments) {
    const totals = group(payment.currency);
    if (!payment.voided_at) totals.total_received_cents += payment.amount_cents;
  }
  for (const allocation of allocations) {
    const charge = chargeById.get(allocation.charge_id);
    const payment = paymentById.get(allocation.payment_id);
    if (allocation.voided_at || !charge || !payment || charge.voided_at || payment.voided_at) continue;
    if (charge.currency !== payment.currency) throw new Error('Ledger allocation crosses currencies');
    const totals = group(charge.currency);
    totals.total_allocated_cents += allocation.amount_cents;
    const key = typeKey(charge.type);
    if (key === 'deposit') totals.deposit_payments_cents += allocation.amount_cents;
    else totals.rent_payments_cents += allocation.amount_cents;
    totals.by_type[key].allocated_cents += allocation.amount_cents;
  }
  for (const totals of Object.values(groups)) {
    totals.rent_balance_cents = totals.rent_charges_cents - totals.rent_payments_cents;
    totals.deposit_balance_cents = totals.deposit_charges_cents - totals.deposit_payments_cents;
    totals.unapplied_credit_cents = totals.total_received_cents - totals.total_allocated_cents;
    for (const values of Object.values(totals.by_type)) values.balance_cents = values.charges_cents - values.allocated_cents;
  }
  return groups;
}

export function selectLedgerCurrency(available: readonly string[], requested?: string, rentCurrency?: string | null): string | null {
  return requested ?? (rentCurrency && available.includes(rentCurrency) ? rentCurrency : available[0] ?? null);
}
