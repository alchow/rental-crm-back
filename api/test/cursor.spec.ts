// Unit spec for keysetPage ascending vs descending (Theme 4). Drives a stub of
// the supabase query-builder slice the helper uses -- no env, no DB.

import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, keysetPage, type KeysetQuery } from '../src/routes/_lib/cursor';

interface Row extends Record<string, unknown> {
  id: string;
  created_at?: string;
  granted_at?: string;
}
interface Recorded {
  or: string[];
  orders: Array<{ column: string; ascending: boolean }>;
}

// Records the .or() filter strings and .order() flags, then resolves to a fixed
// page. Cast to KeysetQuery because we only implement the slice keysetPage uses.
function stub(rows: Row[]): { q: KeysetQuery; calls: Recorded } {
  const calls: Recorded = { or: [], orders: [] };
  const q = {
    or(f: string) {
      calls.or.push(f);
      return q;
    },
    order(column: string, opts: { ascending: boolean }) {
      calls.orders.push({ column, ascending: opts.ascending });
      return q;
    },
    limit(_n: number) {
      return q;
    },
    then(onfulfilled: (v: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(onfulfilled);
    },
  } as unknown as KeysetQuery;
  return { q, calls };
}

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    created_at: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00+00:00`,
  }));
}

describe('keysetPage', () => {
  it('ascending: gt filter + ascending order, slices limit+1, round-trips next_cursor', async () => {
    const rows = makeRows(3); // limit 2 -> fetched 3 -> hasMore
    const { q, calls } = stub(rows);
    const page = await keysetPage<Row>(q, {
      cursor: encodeCursor({ created_at: rows[0]!.created_at!, id: rows[0]!.id }),
      limit: 2,
    });
    expect(calls.orders).toEqual([
      { column: 'created_at', ascending: true },
      { column: 'id', ascending: true },
    ]);
    expect(calls.or[0]).toContain('created_at.gt.');
    expect(calls.or[0]).toContain('id.gt.');
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).not.toBeNull();
    expect(decodeCursor(page.next_cursor as string)?.id).toBe(rows[1]!.id);
  });

  it('descending: lt filter + descending order; no next_cursor when page not full', async () => {
    const rows = makeRows(2); // limit 5 -> 2 rows -> no more
    const { q, calls } = stub(rows);
    const page = await keysetPage<Row>(q, {
      cursor: encodeCursor({ created_at: rows[0]!.created_at!, id: rows[0]!.id }),
      limit: 5,
      descending: true,
    });
    expect(calls.orders).toEqual([
      { column: 'created_at', ascending: false },
      { column: 'id', ascending: false },
    ]);
    expect(calls.or[0]).toContain('created_at.lt.');
    expect(calls.or[0]).toContain('id.lt.');
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  it('honours a custom keyset column', async () => {
    const rows: Row[] = [{ id: '00000000-0000-4000-8000-000000000000', granted_at: '2026-06-01T00:00:00+00:00' }];
    const { q, calls } = stub(rows);
    const page = await keysetPage<Row>(q, { limit: 5, column: 'granted_at', descending: true });
    expect(calls.orders[0]).toEqual({ column: 'granted_at', ascending: false });
    expect(page.items).toHaveLength(1);
  });

  it('rejects a structurally invalid cursor with 400', async () => {
    const { q } = stub(makeRows(1));
    await expect(keysetPage<Row>(q, { cursor: 'not-valid', limit: 5 })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
  });
});
