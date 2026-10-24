import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { fieldSpec } from '../src/admin/import-catalog';
import { importLease } from '../src/admin/import-executor/lease-import';
import { mapImportedLeaseTerms } from '../src/admin/import-executor/lease-terms';

const read = (fields: Record<string, string | undefined>) => (field: string) =>
  fields[field] ?? null;

describe('imported agreement terms', () => {
  it('preserves uncertainty instead of schedule-style defaults', () => {
    expect(mapImportedLeaseTerms(read({}))).toEqual({
      kind: 'valid',
      terms: {
        rent_due_rule: { kind: 'unknown' },
        grace_days: null,
        late_fee_policy: { kind: 'unknown' },
        deposit_knowledge: 'unknown',
        deposit_amount_cents: 0,
        terms_source: { kind: 'import' },
      },
    });
  });
  it('preserves exact day 31, zero grace, fixed fee cents and a separately denominated deposit', () => {
    expect(
      mapImportedLeaseTerms(
        read({
          rent_due_kind: 'day_of_month',
          rent_due_day: '31',
          grace_days: '0',
          late_fee_kind: 'fixed',
          late_fee_amount: '$50.25',
          late_fee_currency: 'USD',
          deposit_amount: '4400',
          deposit_currency: 'CAD',
        }),
      ),
    ).toEqual({
      kind: 'valid',
      terms: {
        rent_due_rule: { kind: 'day_of_month', day: 31 },
        grace_days: 0,
        late_fee_policy: { kind: 'fixed', amount_cents: 5025, currency: 'USD' },
        deposit_knowledge: 'amount',
        deposit_amount_cents: 440000,
        deposit_currency: 'CAD',
        terms_source: { kind: 'import' },
      },
    });
  });
  it('preserves written formulas and explicit no-deposit/no-fee statements', () => {
    const out = mapImportedLeaseTerms(
      read({
        rent_due_kind: 'other',
        rent_due_text: 'Every Friday',
        late_fee_kind: 'other',
        late_fee_text: '5% plus USD 10 per day',
        deposit_knowledge: 'none',
      }),
    );
    expect(out.kind).toBe('valid');
    if (out.kind !== 'valid') return;
    expect(out.terms.late_fee_policy).toEqual({ kind: 'other', text: '5% plus USD 10 per day' });
    expect(out.terms.deposit_knowledge).toBe('none');
    const none = mapImportedLeaseTerms(read({ late_fee_kind: 'none' }));
    expect(none.kind === 'valid' && none.terms.late_fee_policy).toEqual({ kind: 'none' });
  });
  it.each([
    { rent_due_kind: 'day_of_month', rent_due_day: '32' },
    { rent_due_day: '1' },
    { grace_days: '5 days' },
    { grace_days: '2.5' },
    { late_fee_kind: 'fixed', late_fee_amount: '5% of rent', late_fee_currency: 'USD' },
    { late_fee_kind: 'fixed', late_fee_amount: '50' },
    { deposit_amount: '1 month rent' },
    { deposit_amount: '50', deposit_knowledge: 'none', deposit_currency: 'USD' },
  ])('blocks ambiguous or malformed facts: %o', (fields) => {
    expect(mapImportedLeaseTerms(read(fields)).kind).toBe('invalid');
  });
  it('exposes all explicit terms to recognition and mapping', () => {
    for (const field of [
      'rent_due_kind',
      'rent_due_day',
      'rent_due_text',
      'grace_days',
      'late_fee_kind',
      'late_fee_amount',
      'late_fee_currency',
      'late_fee_text',
      'deposit_knowledge',
      'deposit_currency',
    ]) {
      expect(fieldSpec('lease', field)).toBeDefined();
    }
  });
});

function harness(fields: Record<string, string>) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rowCount: 0, rows: [] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'lease-new' }] });
  const block = vi.fn();
  const created = vi.fn();
  const recordDate = vi.fn();
  const args = {
    client: { query } as unknown as PoolClient,
    accountId: 'account',
    row: { id: 'row', region_index: 0, row_index: 1, raw: fields, excluded: false },
    tenancyId: '11111111-1111-4111-8111-111111111111',
    fields: [],
    getValue: read(fields),
    block,
    created,
    recordDate,
    reused: vi.fn(),
  };
  return { query, block, created, recordDate, args };
}

describe('lease import writes', () => {
  it('requires explicit rent currency rather than asserting USD', async () => {
    const h = harness({ rent_amount: '2200', term_start: '2026-11-01' });
    await importLease(h.args);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.block).toHaveBeenCalledWith(
      'rent_currency',
      'missing_required_field',
      expect.any(String),
    );
  });
  it('blocks a missing lease start without borrowing possession date', async () => {
    const h = harness({ rent_amount: '2200' });
    await importLease(h.args);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.block).toHaveBeenCalledWith(
      'term_start',
      'missing_required_field',
      expect.any(String),
    );
  });
  it('inserts the explicit contract with unknown end and missing terms', async () => {
    const h = harness({ rent_amount: '2200', rent_currency: 'USD', term_start: '2026-11-01' });
    await importLease(h.args);
    expect(h.block).not.toHaveBeenCalled();
    const [sql, values] = h.query.mock.calls[1]!;
    expect(sql).toContain('rent_due_rule, grace_days');
    expect(values.slice(2)).toEqual([
      '2026-11-01',
      null,
      220000,
      'USD',
      0,
      null,
      'active',
      '{"kind":"unknown"}',
      null,
      '{"kind":"unknown"}',
      'unknown',
      '{"kind":"import"}',
    ]);
    expect(h.created).toHaveBeenCalledWith('lease-new');
  });
  it('blocks reversed explicit dates before database access', async () => {
    const h = harness({ rent_amount: '2200', term_start: '2026-11-01', term_end: '2026-10-31' });
    await importLease(h.args);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.block).toHaveBeenCalledWith('term_end', 'date_order', expect.any(String));
  });
  it('reuses an exact explicit policy but never silently ignores conflicting terms', async () => {
    for (const existingDay of [31, 1]) {
      const h = harness({
        rent_amount: '2200',
        rent_currency: 'USD',
        term_start: '2026-11-01',
        rent_due_kind: 'day_of_month',
        rent_due_day: '31',
      });
      h.query
        .mockReset()
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              id: 'existing',
              rent_currency: 'USD',
              rent_due_rule: { day: existingDay, kind: 'day_of_month' },
            },
          ],
        });
      await importLease(h.args);
      expect(h.query).toHaveBeenCalledTimes(1);
      if (existingDay === 31) expect(h.args.reused).toHaveBeenCalledOnce();
      else expect(h.block).toHaveBeenCalledWith('term_start', 'invalid_value', expect.any(String));
    }
  });
});
