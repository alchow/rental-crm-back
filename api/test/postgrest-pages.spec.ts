import { describe, expect, it } from 'vitest';
import { readAllById, type PageQuery } from '../src/lib/postgrest-pages';
import { paymentReceiptDates } from '../src/lib/payment-receipt-dates';
import type { AppSupabaseClient } from '../src/supabase/db-types';

const ids = Array.from({ length: 1203 }, (_, n) => `id-${String(n).padStart(5, '0')}`);

function fixture(failPage = -1) {
  const calls: Array<{ cursor?: string; ids?: string[]; limit?: number }> = [];
  const query = () => {
    const call: (typeof calls)[number] = {};
    const index = calls.push(call) - 1;
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      lt: () => builder,
      order: () => builder,
      limit: (size: number) => {
        call.limit = size;
        return builder;
      },
      gt: (_column: string, cursor: string) => {
        call.cursor = cursor;
        return builder;
      },
      in: (_column: string, selected: string[]) => {
        call.ids = selected;
        return builder;
      },
      then(resolve: (result: unknown) => void) {
        resolve(
          index === failPage
            ? { data: null, error: { message: 'read interrupted' } }
            : {
                data: ids
                  .filter(
                    (id) =>
                      (!call.cursor || id > call.cursor) && (!call.ids || call.ids.includes(id)),
                  )
                  .slice(0, Math.min(call.limit ?? 1000, 1000))
                  .map((id) => ({ id, received_at: null })),
                error: null,
              },
        );
      },
    };
    return builder;
  };
  return { calls, query };
}

describe('complete paged reads', () => {
  it('reads beyond the server cap with fresh ordered queries', async () => {
    const { calls, query } = fixture();
    const rows = await readAllById(query as unknown as () => PageQuery<{ id: string }>, 'facts');
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(calls).toEqual([
      { limit: 500 },
      { limit: 500, cursor: ids[499] },
      { limit: 500, cursor: ids[999] },
    ]);
  });

  it('fails instead of returning a partial history when a later page fails', async () => {
    const { query } = fixture(1);
    await expect(
      readAllById(query as unknown as () => PageQuery<{ id: string }>, 'facts'),
    ).rejects.toThrow('facts read failed: read interrupted');
  });

  it('rejects a repeated cursor instead of looping or duplicating facts', async () => {
    const query = () => ({
      order() {
        return this;
      },
      limit() {
        return this;
      },
      gt() {
        return this;
      },
      then(resolve: (result: unknown) => void) {
        resolve({ data: [{ id: 'same' }, { id: 'same' }], error: null });
      },
    });
    await expect(
      readAllById(query as unknown as () => PageQuery<{ id: string }>, 'facts'),
    ).rejects.toThrow('invalid page cursor');
  });

  it('resolves all receipt dates beyond 1,000 rows', async () => {
    const { query } = fixture();
    const result = await paymentReceiptDates(
      { from: query } as unknown as AppSupabaseClient,
      'account',
    );
    expect([...result.keys()]).toEqual(ids);
  });

  it('filters receipt IDs before the response cap and bounds each IN list', async () => {
    const { query, calls } = fixture();
    const selected = ids.slice(990);
    const result = await paymentReceiptDates(
      { from: query } as unknown as AppSupabaseClient,
      'account',
      'tenancy',
      null,
      selected,
    );
    expect([...result.keys()]).toEqual(selected);
    expect(calls.map((call) => call.ids?.length)).toEqual([100, 100, 13]);
  });

  it('does not read account-wide receipt dates for an empty payment page', async () => {
    const { query, calls } = fixture();
    expect(
      await paymentReceiptDates(
        { from: query } as unknown as AppSupabaseClient,
        'account',
        null,
        null,
        [],
      ),
    ).toEqual(new Map());
    expect(calls).toEqual([]);
  });
});
