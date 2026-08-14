// Unit spec for the evidence-export ledger derivation. PDFKit output is not
// string-greppable, so the money arithmetic -- and the adoption's date gating,
// which decides whether a bundle states a pre-tracking balance at all -- is
// pinned here at the seam function.

import { describe, expect, it } from 'vitest';
import { deriveLedger } from '../src/admin/export-pdf/ledger';
import type { ExportData } from '../src/admin/export-pdf';

const CUR = 'USD';

function charge(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    type: 'rent',
    amount_cents: 100000,
    currency: CUR,
    due_date: '2026-06-01',
    voided_at: null,
    ...over,
  };
}

function payment(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    amount_cents: 100000,
    currency: CUR,
    received_at: '2026-06-02T00:00:00+00:00',
    method: 'transfer',
    voided_at: null,
    ...over,
  };
}

function alloc(chargeId: string, paymentId: string, amountCents: number): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    charge_id: chargeId,
    payment_id: paymentId,
    amount_cents: amountCents,
  };
}

function adoptionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adoption_date: '2026-01-01',
    opening_balance_cents: 50000,
    currency: CUR,
    balance_basis: 'landlord spreadsheet through 2025-12',
    needs_review: false,
    ...over,
  };
}

// Only the four collections deriveLedger reads; the rest of ExportData is
// rendering context this seam never touches.
function exportData(over: Partial<ExportData>): ExportData {
  return {
    charges: [],
    payments: [],
    allocations: [],
    adoption: null,
    ...over,
  } as unknown as ExportData;
}

// Two rent charges either side of July, one partial payment against the first.
function twoMonths(paidCents: number): {
  data: (adoption: Record<string, unknown> | null) => ExportData;
} {
  const june = charge({ due_date: '2026-06-01' });
  const july = charge({ due_date: '2026-07-01' });
  const pay = payment({ amount_cents: paidCents, received_at: '2026-06-02T00:00:00+00:00' });
  return {
    data: (adoption) =>
      exportData({
        charges: [june, july],
        payments: [pay],
        allocations: [alloc(june.id as string, pay.id as string, paidCents)],
        adoption,
      }),
  };
}

describe('deriveLedger', () => {
  it('states no adoption when the tenancy was never adopted', () => {
    const l = deriveLedger(twoMonths(100000).data(null), null, null);
    expect(l.rent_charges_in_range_cents).toBe(200000);
    expect(l.rent_payments_in_range_cents).toBe(100000);
    expect(l.closing_balance_cents).toBe(100000);
    expect(l.adoption_opening_balance_cents).toBe(0);
    expect(l.adoption_date).toBeNull();
    expect(l.adoption_needs_review).toBe(false);
    expect(l.adoption_balance_basis).toBeNull();
  });

  it('folds an in-range adoption into the closing balance and carries its flags', () => {
    const l = deriveLedger(
      twoMonths(100000).data(
        adoptionRow({ needs_review: true, balance_basis: 'prior manager handover' }),
      ),
      null,
      '2026-12-31',
    );
    expect(l.adoption_opening_balance_cents).toBe(50000);
    expect(l.adoption_date).toBe('2026-01-01');
    expect(l.adoption_needs_review).toBe(true);
    expect(l.adoption_balance_basis).toBe('prior manager handover');
    // Folded total, and the itemized figure the renderer derives from it.
    expect(l.closing_balance_cents).toBe(150000);
    expect(l.closing_balance_cents - l.adoption_opening_balance_cents).toBe(100000);
  });

  it('gates the adoption off entirely when to_date precedes it', () => {
    // Same rule as GET /ledger?as_of: an adoption dated after the cut did not
    // exist then, so the bundle must not print its balance.
    const data = twoMonths(60000).data(adoptionRow({ adoption_date: '2026-07-15' }));
    const l = deriveLedger(data, null, '2026-06-30');
    expect(l.adoption_opening_balance_cents).toBe(0);
    expect(l.adoption_date).toBeNull();
    expect(l.adoption_needs_review).toBe(false);
    expect(l.adoption_balance_basis).toBeNull();
    // June charge only, minus the June payment. Ungated this would be 90000.
    expect(l.closing_balance_cents).toBe(40000);
    // Ungated by to_date, the same adoption is present.
    expect(deriveLedger(data, null, '2026-07-31').adoption_opening_balance_cents).toBe(50000);
  });

  it('lets a negative adoption balance (a credit) reduce the closing balance', () => {
    const l = deriveLedger(
      twoMonths(100000).data(adoptionRow({ opening_balance_cents: -25000 })),
      null,
      null,
    );
    expect(l.adoption_opening_balance_cents).toBe(-25000);
    expect(l.closing_balance_cents).toBe(75000);
  });

  it('does not let from_date gate the adoption: a pre-range balance is carried in', () => {
    const l = deriveLedger(twoMonths(60000).data(adoptionRow()), '2026-07-01', null);
    expect(l.adoption_opening_balance_cents).toBe(50000);
    expect(l.adoption_date).toBe('2026-01-01');
    // June charge (100000) less the June payment (60000) carried in as the
    // row-derived opening, plus July's charge, plus the adoption balance.
    expect(l.opening_balance_cents).toBe(40000);
    expect(l.rent_charges_in_range_cents).toBe(100000);
    expect(l.rent_payments_in_range_cents).toBe(0);
    expect(l.closing_balance_cents).toBe(190000);
  });
});
