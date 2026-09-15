import { describe, expect, it } from 'vitest';
import { ledgerRowsAt } from '../src/lib/ledger-history';

const correction = {
  id: 'replacement',
  due_date: '2026-09-01',
  created_at: '2026-09-14T15:00:00Z',
  corrects_charge_id: 'original',
  voided_at: null,
  void_reason: null,
};

describe('ledgerRowsAt charge corrections', () => {
  it('hides a backdated replacement before the correction date', () => {
    expect(ledgerRowsAt([correction], (row) => row.due_date, '2026-09-13')).toEqual([]);
  });

  it('shows the replacement on and after the correction date', () => {
    expect(ledgerRowsAt([correction], (row) => row.due_date, '2026-09-14')).toEqual([correction]);
    expect(ledgerRowsAt([correction], (row) => row.due_date, '2026-09-15')).toEqual([correction]);
  });

  it('restores the original before its correction-day void', () => {
    const original = {
      id: 'original',
      due_date: '2026-09-01',
      created_at: '2026-09-01T08:00:00Z',
      corrects_charge_id: null,
      voided_at: '2026-09-14T15:00:00Z',
      void_reason: 'corrected',
    };
    expect(ledgerRowsAt([original], (row) => row.due_date, '2026-09-13')).toEqual([
      { ...original, voided_at: null, void_reason: null },
    ]);
  });
});
