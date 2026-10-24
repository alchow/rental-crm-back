export const READ_PAGE_SIZE = 500;

type PageResult<Row> = { data: Row[] | null; error: { message: string } | null };

export interface PageQuery<Row> extends PromiseLike<PageResult<Row>> {
  order(column: string, options?: { ascending?: boolean }): PageQuery<Row>;
  limit(count: number): PageQuery<Row>;
  gt(column: string, value: string): PageQuery<Row>;
}

// A fresh query per page avoids mutating a builder shared with another read.
export async function readAllPages<Row>(
  query: () => PageQuery<Row>,
  cursorColumn: string,
  key: (row: Row) => string,
  label: string,
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  for (;;) {
    let pageQuery = query().order(cursorColumn, { ascending: true }).limit(READ_PAGE_SIZE);
    if (cursor) pageQuery = pageQuery.gt(cursorColumn, cursor);
    const { data, error } = await pageQuery;
    if (error) throw new Error(`${label} read failed: ${error.message}`);
    const page = data ?? [];
    for (const row of page) {
      const next = key(row);
      if (!next || (cursor && next <= cursor)) {
        throw new Error(`${label} returned an invalid page cursor`);
      }
      cursor = next;
      rows.push(row);
    }
    if (page.length < READ_PAGE_SIZE) return rows;
  }
}

export function readAllById<Row extends { id: string }>(
  query: () => PageQuery<Row>,
  label: string,
): Promise<Row[]> {
  return readAllPages(query, 'id', (row) => row.id, label);
}
