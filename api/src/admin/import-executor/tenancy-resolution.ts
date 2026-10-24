import type { PoolClient } from 'pg';
import { CreateTenancyBody } from '../../schemas/importable';
import { firstIssue } from './coercions';
import type { EntityType, FieldMapping } from '../import-catalog';
import type { ParentResolutions, RawImportRow } from './types';
import { coerceAreaKind } from './coercions';

export interface ResolveTenancyInput {
  client: PoolClient;
  accountId: string;
  areaId: string;
  importedStartDate: string;
  importedEndDate: string | null;
  explicitTenancyId: string | null;
  create: {
    status: 'upcoming' | 'active' | 'ended';
    startDateBasis: 'legacy_unverified' | 'possession_entitlement';
    actualMoveInDate: string | null;
  };
}

export type TenancyResolution =
  | {
      kind: 'reused';
      id: string;
      startDate: string;
      endDate: string | null;
      matchedBy: 'explicit_id' | 'current_start' | 'corrected_start';
    }
  | { kind: 'created'; id: string; startDate: string; endDate: string | null }
  | { kind: 'ambiguous'; candidateIds: string[] }
  | { kind: 'explicit_scope_mismatch' }
  | { kind: 'invalid'; message: string };

interface CandidateRow {
  id: string;
  start_date: string;
  end_date: string | null;
  current_match: boolean;
  historical_match: boolean;
}

export async function preAcquireTenancyIdentityLocks(input: {
  client: PoolClient;
  accountId: string;
  rows: RawImportRow[];
  byRegion: Map<number, Map<EntityType, FieldMapping[]>>;
  regionScope: Map<number, Set<EntityType>>;
  parents: ParentResolutions;
  prefetchedProperties: Map<string, string>;
  prefetchedAreas: Map<string, string>;
  ambiguous: string;
  getValue: (
    fields: FieldMapping[] | undefined,
    target: string,
    raw: Record<string, string>,
  ) => string | null;
}): Promise<void> {
  const areaIds = new Set<string>();
  for (const row of input.rows) {
    const regionMap = input.byRegion.get(row.region_index);
    const scope = input.regionScope.get(row.region_index);
    if (!regionMap || !scope?.has('tenancy') || !scope.has('area')) continue;
    let propertyId: string | null = input.parents.default_property_id ?? null;
    if (!propertyId && scope.has('property')) {
      const name = input.getValue(regionMap.get('property'), 'name', row.raw);
      if (name) {
        const override = input.parents.property_overrides?.[name];
        if (override?.mode === 'existing' && override.id) propertyId = override.id;
        else if (override?.mode !== 'create') {
          const existing = input.prefetchedProperties.get(name.toLowerCase());
          if (existing && existing !== input.ambiguous) propertyId = existing;
        }
      }
    }
    if (!propertyId) continue;
    const areaName = input.getValue(regionMap.get('area'), 'name', row.raw);
    const kind = coerceAreaKind(input.getValue(regionMap.get('area'), 'kind', row.raw));
    if (!areaName || !kind) continue;
    const areaId = input.prefetchedAreas.get(`${propertyId}::${kind}::${areaName.toLowerCase()}`);
    if (areaId && areaId !== input.ambiguous) areaIds.add(areaId);
  }
  for (const areaId of [...areaIds].sort()) {
    await input.client.query(
      `select pg_advisory_xact_lock(hashtextextended('tenancy_identity:' || $1::text || ':' || $2::text, 0))`,
      [input.accountId, areaId],
    );
  }
}

/** DATA FLOW: account + unit lock -> candidate lookup -> row lock/recheck ->
 * stable tenancy id. The date-correction RPC uses the same advisory key. */
export async function resolveTenancyIdentity(
  input: ResolveTenancyInput,
): Promise<TenancyResolution> {
  const { client, accountId, areaId } = input;
  const valid = CreateTenancyBody.safeParse({
    area_id: areaId,
    start_date: input.importedStartDate,
    end_date: input.importedEndDate,
    status: input.create.status,
    start_date_basis: input.create.startDateBasis,
    actual_move_in_date: input.create.actualMoveInDate,
  });
  if (!valid.success) return { kind: 'invalid', message: firstIssue(valid.error) };
  await client.query(
    `select pg_advisory_xact_lock(hashtextextended('tenancy_identity:' || $1::text || ':' || $2::text, 0))`,
    [accountId, areaId],
  );

  if (input.explicitTenancyId) {
    const explicit = await client.query(
      `select id, start_date::text, end_date::text
         from tenancies
        where id = $1 and account_id = $2 and area_id = $3 and deleted_at is null
        for update`,
      [input.explicitTenancyId, accountId, areaId],
    );
    if (explicit.rowCount !== 1) return { kind: 'explicit_scope_mismatch' };
    const row = explicit.rows[0] as { id: string; start_date: string; end_date: string | null };
    return {
      kind: 'reused',
      id: row.id,
      startDate: row.start_date,
      endDate: row.end_date,
      matchedBy: 'explicit_id',
    };
  }

  const candidates = await client.query(
    `select t.id,
            t.start_date::text,
            t.end_date::text,
            (t.start_date = $3::date) as current_match,
            exists (
              select 1
                from tenancy_date_records r
               where r.account_id = $1
                 and r.tenancy_id = t.id
                 and r.kind = 'correction'
                 and r.before_facts ->> 'start_date' = $3::text
            ) as historical_match
       from tenancies t
      where t.account_id = $1
        and t.area_id = $2
        and t.deleted_at is null
        and (
          t.start_date = $3::date
          or exists (
            select 1
              from tenancy_date_records r
             where r.account_id = $1
               and r.tenancy_id = t.id
               and r.kind = 'correction'
               and r.before_facts ->> 'start_date' = $3::text
          )
        )
      order by t.id
      for update of t`,
    [accountId, areaId, input.importedStartDate],
  );
  const rows = candidates.rows as CandidateRow[];
  if (rows.length > 1) return { kind: 'ambiguous', candidateIds: rows.map((r) => r.id) };
  if (rows.length === 1) {
    const row = rows[0]!;
    return {
      kind: 'reused',
      id: row.id,
      startDate: row.start_date,
      endDate: row.end_date,
      matchedBy: row.current_match ? 'current_start' : 'corrected_start',
    };
  }

  const inserted = await client.query(
    `insert into tenancies
       (account_id, area_id, start_date, end_date, status, start_date_basis, actual_move_in_date)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, start_date::text, end_date::text`,
    [
      accountId,
      areaId,
      input.importedStartDate,
      input.importedEndDate,
      input.create.status,
      input.create.startDateBasis,
      input.create.actualMoveInDate,
    ],
  );
  const row = inserted.rows[0] as { id: string; start_date: string; end_date: string | null };
  return { kind: 'created', id: row.id, startDate: row.start_date, endDate: row.end_date };
}
