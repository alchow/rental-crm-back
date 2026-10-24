import { describe, expect, it } from 'vitest';
import {
  completeInteractionChains,
  loadRelatedRows,
  loadScopedRows,
  loadWindowedInteractions,
} from '../src/admin/export-pdf/collection-rows';
import type { AppSupabaseClient } from '../src/supabase/db-types';

type Row = { id: string; account_id: string; [key: string]: unknown };
type Call = {
  table: string;
  equal: Record<string, unknown>;
  included: Record<string, string[]>;
  cursor?: string;
  limit?: number;
  before?: string;
};
function fakeClient(tables: Record<string, Row[]>, fail?: (call: Call) => boolean) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const call: Call = { table, equal: {}, included: {} };
      calls.push(call);
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          call.equal[column] = value;
          return query;
        },
        is: (column: string, value: unknown) => {
          call.equal[column] = value;
          return query;
        },
        in: (column: string, values: string[]) => {
          call.included[column] = values;
          return query;
        },
        order: () => query,
        gte: () => query,
        lte: () => query,
        lt: (_column: string, before: string) => {
          call.before = before;
          return query;
        },
        gt: (_column: string, cursor: string) => {
          call.cursor = cursor;
          return query;
        },
        limit: (count: number) => {
          call.limit = count;
          return query;
        },
        then(resolve: (value: { data: Row[] | null; error: { message: string } | null }) => void) {
          if (fail?.(call))
            return resolve({ data: null, error: { message: 'database unavailable' } });
          const rows = (tables[table] ?? [])
            .filter((row) =>
              Object.entries(call.equal).every(([column, value]) => row[column] === value),
            )
            .filter((row) =>
              Object.entries(call.included).every(([column, values]) =>
                values.includes(String(row[column])),
              ),
            )
            .filter((row) => !call.cursor || row.id > call.cursor)
            .filter(
              (row) =>
                !call.before || Date.parse(String(row.occurred_at)) < Date.parse(call.before),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, Math.min(call.limit ?? 1000, 1000));
          resolve({ data: rows, error: null });
        },
      };
      return query;
    },
  } as unknown as AppSupabaseClient;
  return { admin, calls };
}
const id = (n: number) => `id-${String(n).padStart(5, '0')}`;

describe('export collection reads', () => {
  it('loads every row beyond the server cap while retaining account and tenancy scope', async () => {
    const rows = Array.from({ length: 1101 }, (_, n) => ({
      id: id(n),
      account_id: 'account',
      tenancy_id: 'tenancy',
    }));
    const { admin, calls } = fakeClient({
      payments: [...rows, { id: 'other', account_id: 'other', tenancy_id: 'tenancy' }],
    });
    expect(await loadScopedRows(admin, 'account', 'payments', 'tenancy_id', 'tenancy')).toEqual(
      rows,
    );
    expect(calls).toHaveLength(3);
    expect(
      calls.every(
        (call) => call.equal.account_id === 'account' && call.equal.tenancy_id === 'tenancy',
      ),
    ).toBe(true);
  });

  it('paginates many children of one parent and chunks large parent sets', async () => {
    const rows = Array.from({ length: 1101 }, (_, n) => ({
      id: id(n),
      account_id: 'account',
      charge_id: 'charge',
      deleted_at: null,
    }));
    const { admin, calls } = fakeClient({ payment_allocations: rows });
    const ids = ['charge', ...Array.from({ length: 220 }, (_, n) => `charge-${n}`)];
    expect(
      await loadRelatedRows(admin, 'account', 'payment_allocations', 'charge_id', ids, true),
    ).toEqual(rows);
    expect(calls.every((call) => (call.included.charge_id?.length ?? 0) <= 100)).toBe(true);
    expect(calls.every((call) => call.equal.deleted_at === null)).toBe(true);
  });

  it('fails closed when a later page is unavailable', async () => {
    const rows = Array.from({ length: 1101 }, (_, n) => ({
      id: id(n),
      account_id: 'account',
      tenancy_id: 'tenancy',
    }));
    const { admin } = fakeClient({ charges: rows }, (call) => !!call.cursor);
    await expect(
      loadScopedRows(admin, 'account', 'charges', 'tenancy_id', 'tenancy'),
    ).rejects.toThrow('database unavailable');
  });

  it('restricts area-only interactions to the requested area', async () => {
    const scoped = { id: 'a', account_id: 'account', area_id: 'area' };
    const { admin } = fakeClient({
      interactions: [scoped, { id: 'b', account_id: 'account', area_id: 'other' }],
    });
    expect(
      await loadWindowedInteractions(admin, 'account', {
        tenancyId: null,
        areaId: 'area',
        fromDate: null,
        toDate: null,
      }),
    ).toEqual([scoped]);
  });

  it('includes the final fractional second of the requested UTC day', async () => {
    const last = {
      id: 'a',
      account_id: 'account',
      area_id: 'area',
      occurred_at: '2026-09-30T23:59:59.999999Z',
    };
    const { admin, calls } = fakeClient({
      interactions: [last, { ...last, id: 'b', occurred_at: '2026-10-01T00:00:00Z' }],
    });
    expect(
      await loadWindowedInteractions(admin, 'account', {
        tenancyId: null,
        areaId: 'area',
        fromDate: null,
        toDate: '2026-09-30',
      }),
    ).toEqual([last]);
    expect(calls[0]?.before).toBe('2026-10-01T00:00:00.000Z');
  });

  it('completes large correction families and parent chains without crossing accounts', async () => {
    const original = { id: 'parent', account_id: 'account', corrects_id: null };
    const children = Array.from({ length: 1101 }, (_, n) => ({
      id: id(n),
      account_id: 'account',
      corrects_id: 'parent',
    }));
    const { admin, calls } = fakeClient({
      interactions: [
        original,
        ...children,
        { id: 'foreign', account_id: 'other', corrects_id: 'parent' },
      ],
    });
    const rows = await completeInteractionChains(admin, 'account', [children[0]!]);
    expect(rows).toHaveLength(1102);
    expect(rows.some((row) => row.id === 'parent')).toBe(true);
    expect(
      calls.every((call) => Object.values(call.included).every((ids) => ids.length <= 100)),
    ).toBe(true);
  });

  it('does not render a partial correction chain after a query error', async () => {
    const original = { id: 'parent', account_id: 'account', corrects_id: null };
    const { admin } = fakeClient({ interactions: [original] }, () => true);
    await expect(completeInteractionChains(admin, 'account', [original])).rejects.toThrow(
      'database unavailable',
    );
  });
});
