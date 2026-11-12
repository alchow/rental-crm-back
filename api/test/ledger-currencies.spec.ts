import { describe, expect, it } from 'vitest';
import { ledgerCurrencyTotals, selectLedgerCurrency } from '../src/lib/ledger-currencies';
describe('ledger currency groups', () => {
  it('keeps rent, deposit, credit and reversed allocations in their own currency', () => {
    const charges = [
      { id: 'rent', currency: 'USD', amount_cents: 220000, type: 'rent', voided_at: null },
      { id: 'deposit', currency: 'EUR', amount_cents: 440000, type: 'deposit', voided_at: null },
      { id: 'void', currency: 'EUR', amount_cents: 900, type: 'rent', voided_at: '2026-01-01' },
    ];
    const payments = [
      { id: 'usd', currency: 'USD', amount_cents: 200000, voided_at: null },
      { id: 'eur', currency: 'EUR', amount_cents: 100000, voided_at: null },
    ];
    const groups = ledgerCurrencyTotals(charges, payments, [
      { charge_id: 'rent', payment_id: 'usd', amount_cents: 190000 },
      { charge_id: 'rent', payment_id: 'usd', amount_cents: 10000, voided_at: '2026-02-01' },
      { charge_id: 'deposit', payment_id: 'eur', amount_cents: 60000 },
      { charge_id: 'void', payment_id: 'eur', amount_cents: 900 },
    ]);
    expect(groups.USD?.rent_balance_cents).toBe(30000);
    expect(groups.USD?.unapplied_credit_cents).toBe(10000);
    expect(groups.USD?.deposit_charges_cents).toBe(0);
    expect(groups.EUR?.deposit_balance_cents).toBe(380000);
    expect(groups.EUR?.unapplied_credit_cents).toBe(40000);
    expect(groups.EUR?.rent_charges_cents).toBe(0);
  });
  it('makes setup credit available without adding to the cash received', () => {
    const charges = [
      { id: 'rent', currency: 'USD', amount_cents: 147500, type: 'rent', voided_at: null },
    ];
    const payments = [
      { id: 'starting', currency: 'USD', amount_cents: 65000, voided_at: null, entry_source: 'opening_credit' },
      { id: 'receipt', currency: 'USD', amount_cents: 10000, voided_at: null, entry_source: 'manual' },
    ];
    const groups = ledgerCurrencyTotals(charges, payments, [
      { charge_id: 'rent', payment_id: 'starting', amount_cents: 25000 },
    ]);
    expect(groups.USD).toMatchObject({
      rent_balance_cents: 122500,
      total_received_cents: 10000,
      opening_credit_cents: 65000,
      unapplied_credit_cents: 50000,
    });
  });
  it('refuses corrupt cross-currency allocations instead of summing them', () => {
    expect(() => ledgerCurrencyTotals([{ id:'a',currency:'USD',amount_cents:100,type:'rent',voided_at:null }],
      [{ id:'b',currency:'EUR',amount_cents:100,voided_at:null }],[{charge_id:'a',payment_id:'b',amount_cents:10}])).toThrow('crosses currencies');
  });
  it('uses an explicit currency, then the applicable rent currency, then deterministic available order', () => {
    expect(selectLedgerCurrency(['EUR','USD'],undefined,'USD')).toBe('USD');
    expect(selectLedgerCurrency(['EUR','USD'],'EUR','USD')).toBe('EUR');
    expect(selectLedgerCurrency(['EUR','USD'])).toBe('EUR');
    expect(selectLedgerCurrency([])).toBeNull();
    expect(selectLedgerCurrency([],'USD')).toBe('USD');
  });
});
