import type { AppSupabaseClient } from '../../supabase/db-types';
import { readAllById } from '../../lib/postgrest-pages';
import { idChunks } from './chunks';

type ExportTable =
  | 'leases'
  | 'rent_schedules'
  | 'charges'
  | 'payments'
  | 'payment_allocations'
  | 'interactions'
  | 'maintenance_requests'
  | 'work_orders'
  | 'inspections'
  | 'inspection_items'
  | 'inspection_checks'
  | 'notices';

export async function loadScopedRows(
  admin: AppSupabaseClient,
  accountId: string,
  table: ExportTable,
  column: string,
  value: string,
): Promise<Record<string, unknown>[]> {
  return readAllById(
    () => admin.from(table).select('*').eq('account_id', accountId).eq(column, value),
    `${table} export`,
  );
}

export async function loadRelatedRows(
  admin: AppSupabaseClient,
  accountId: string,
  table: ExportTable,
  column: string,
  ids: Iterable<string>,
  liveOnly = false,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (const chunk of idChunks(ids)) {
    rows.push(
      ...(await readAllById(() => {
        let query = admin.from(table).select('*').eq('account_id', accountId).in(column, chunk);
        if (liveOnly) query = query.is('deleted_at', null);
        return query;
      }, `${table} export`)),
    );
  }
  return rows;
}

// Correction members can cross the date/tenancy filter, but never the account boundary.
export async function completeInteractionChains(
  admin: AppSupabaseClient,
  accountId: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const have = new Map(rows.map((row) => [String(row.id), row]));
  let frontier = [...have.keys()];
  while (frontier.length) {
    const missingParents = [...have.values()]
      .map((row) => (row.corrects_id ? String(row.corrects_id) : null))
      .filter((id): id is string => id !== null && !have.has(id));
    const [children, parents] = await Promise.all([
      loadRelatedRows(admin, accountId, 'interactions', 'corrects_id', frontier),
      loadRelatedRows(admin, accountId, 'interactions', 'id', missingParents),
    ]);
    frontier = [];
    for (const row of [...children, ...parents]) {
      const id = String(row.id);
      if (!have.has(id)) {
        have.set(id, row);
        frontier.push(id);
      }
    }
  }
  return [...have.values()];
}

export async function loadWindowedInteractions(
  admin: AppSupabaseClient,
  accountId: string,
  scope: {
    tenancyId: string | null;
    areaId: string | undefined;
    fromDate: string | null;
    toDate: string | null;
  },
): Promise<Record<string, unknown>[]> {
  if (!scope.tenancyId && !scope.areaId) return [];
  return readAllById(() => {
    let query = admin.from('interactions').select('*').eq('account_id', accountId);
    if (scope.tenancyId) query = query.eq('tenancy_id', scope.tenancyId);
    else query = query.eq('area_id', scope.areaId!);
    if (scope.fromDate) query = query.gte('occurred_at', scope.fromDate);
    if (scope.toDate) {
      const nextDay = new Date(`${scope.toDate}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      query = query.lt('occurred_at', nextDay.toISOString());
    }
    return query;
  }, 'interactions export');
}
