import { ApiError } from './error';

// Opaque cursor for keyset pagination on (created_at, id). created_at gives
// us creation-order; id breaks ties (uuid v4 is uniform-random but stable per
// row). The cursor is base64url-encoded JSON so it's URL-safe and trivially
// debug-printable in dev.
//
// We don't sign or encrypt the cursor: the only things it contains are the
// last row's created_at + id, which the client already saw in the previous
// page. There's no information disclosure to bind to a secret.
//
// We DO validate its shape strictly. Cursor values are interpolated into a
// PostgREST `.or()` filter string, so the timestamp/uuid regexes below are
// what keeps a hand-crafted cursor from smuggling filter syntax (commas,
// parens) into the query -- and what turns garbage into a clean 400 instead
// of a 500 from PostgREST.

export interface CursorPosition {
  created_at: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgREST timestamptz text: 2026-06-11T01:02:03.123456+00:00 (Z / no-frac /
// date-only variants included). Anything else -- in particular anything with
// PostgREST operator syntax -- is rejected.
const TS_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function encodeCursor(p: CursorPosition): string {
  return Buffer.from(JSON.stringify(p)).toString('base64url');
}

export function decodeCursor(s: string): CursorPosition | null {
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (
      typeof obj === 'object' &&
      obj !== null &&
      'created_at' in obj &&
      'id' in obj &&
      typeof (obj as { created_at: unknown }).created_at === 'string' &&
      typeof (obj as { id: unknown }).id === 'string' &&
      TS_RE.test((obj as { created_at: string }).created_at) &&
      UUID_RE.test((obj as { id: string }).id)
    ) {
      return obj as CursorPosition;
    }
    return null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// keysetPage: the one implementation of the list-endpoint pagination dance
// (decode cursor -> 400 on garbage -> .or() keyset filter -> fetch limit+1 ->
// slice -> encode next cursor). Previously copy-pasted across ~14 handlers.
// ----------------------------------------------------------------------------

// Structural slice of the supabase-js query builder: enough for the helper
// to filter/order/limit and await, without binding to postgrest-js generics.
interface KeysetResult {
  data: unknown[] | null;
  error: { message: string } | null;
}
export interface KeysetQuery extends PromiseLike<KeysetResult> {
  or(filters: string): KeysetQuery;
  order(column: string, opts: { ascending: boolean }): KeysetQuery;
  limit(n: number): KeysetQuery;
}

export interface KeysetPageOpts {
  cursor?: string | undefined;
  limit: number;
  /** Keyset column (default 'created_at'); interactions page on occurred_at. */
  column?: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * Run keyset pagination over a filtered query. The caller passes the base
 * query (table/select/filters applied, NO order/limit); the helper applies
 * the cursor filter, ordering, and limit+1 fetch.
 *
 * Throws ApiError(400) when a supplied cursor is structurally invalid --
 * silently restarting at page 1 (the old behavior) returns wrong data.
 */
export async function keysetPage<T extends Record<string, unknown>>(
  query: KeysetQuery,
  opts: KeysetPageOpts,
): Promise<Page<T>> {
  const col = opts.column ?? 'created_at';
  let q = query;
  if (opts.cursor !== undefined) {
    const cur = decodeCursor(opts.cursor);
    if (!cur) throw new ApiError(400, 'invalid_request', 'invalid cursor');
    // Keyset: col > X OR (col = X AND id > Y).
    q = q.or(`${col}.gt.${cur.created_at},and(${col}.eq.${cur.created_at},id.gt.${cur.id})`);
  }
  const { data, error } = await q
    .order(col, { ascending: true })
    .order('id', { ascending: true })
    .limit(opts.limit + 1);
  if (error) throw new ApiError(500, 'database_error', error.message);

  const rows = (data ?? []) as T[];
  const hasMore = rows.length > opts.limit;
  const items = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = items[items.length - 1];
  const next_cursor =
    hasMore && last
      ? encodeCursor({ created_at: String(last[col]), id: String(last.id) })
      : null;
  return { items, next_cursor };
}

// ----------------------------------------------------------------------------
// keysetPageIndexed: same dance for integer-pair keysets (the import-rows
// endpoint pages on (region_index, row_index) so page order matches the
// uploaded file). Cursor fields are named after the columns, preserving the
// pre-helper wire format.
// ----------------------------------------------------------------------------

export interface IndexedKeysetOpts {
  cursor?: string | undefined;
  limit: number;
  /** e.g. ['region_index', 'row_index'] */
  columns: [string, string];
}

export async function keysetPageIndexed<T extends Record<string, unknown>>(
  query: KeysetQuery,
  opts: IndexedKeysetOpts,
): Promise<Page<T>> {
  const [c0, c1] = opts.columns;
  let q = query;
  if (opts.cursor !== undefined) {
    let pos: { a: number; b: number } | null = null;
    try {
      const obj = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      const a = obj?.[c0];
      const b = obj?.[c1];
      if (
        typeof a === 'number' && Number.isInteger(a) && a >= 0 &&
        typeof b === 'number' && Number.isInteger(b) && b >= 0
      ) {
        pos = { a, b };
      }
    } catch {
      pos = null;
    }
    if (!pos) throw new ApiError(400, 'invalid_request', 'invalid cursor');
    q = q.or(`${c0}.gt.${pos.a},and(${c0}.eq.${pos.a},${c1}.gt.${pos.b})`);
  }
  const { data, error } = await q
    .order(c0, { ascending: true })
    .order(c1, { ascending: true })
    .limit(opts.limit + 1);
  if (error) throw new ApiError(500, 'database_error', error.message);

  const rows = (data ?? []) as T[];
  const hasMore = rows.length > opts.limit;
  const items = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = items[items.length - 1];
  const next_cursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ [c0]: last[c0], [c1]: last[c1] })).toString('base64url')
      : null;
  return { items, next_cursor };
}
