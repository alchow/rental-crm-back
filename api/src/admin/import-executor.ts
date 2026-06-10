import type { PoolClient } from 'pg';
import { z } from 'zod';
import { getPool } from './db-pool';
import { ApiError } from '../routes/_lib/error';
import {
  ENTITY_ORDER,
  requiredFields,
  type EntityType,
  type FieldMapping,
  type RegionEntityMapping,
} from './import-catalog';

// ----------------------------------------------------------------------------
// The deterministic execution engine. This — never the LLM — is the sole write
// path. Preview (dry-run) and commit are ONE code path: the same writes run
// inside a transaction that is ROLLED BACK for preview and COMMITTED for
// confirm.
//
//   BEGIN
//   SET LOCAL ROLE service_role            -- BYPASSRLS; auth.uid() stays NULL
//   set audit.actor = 'system:import:<id>' -- so the audit trigger attributes
//   SAVEPOINT entity_writes
//     … resolve/create entities in topological order, tag provenance …
//   preview  → ROLLBACK TO SAVEPOINT entity_writes; persist summary; COMMIT
//   confirm  → (blockers ? ROLLBACK TO SAVEPOINT : keep); persist; COMMIT
//
// Invariants preserved by construction:
//   * audit trail — every entity INSERT fires its existing trigger, attributed
//     to the import session.
//   * money integrity — NOT touched (charges/payments are Phase 2).
//   * provenance — every created entity is tagged in import_provenance.
//   * no silent invention — a missing required parent/value becomes a blocker,
//     never a fabricated row. Confirm refuses to commit while blockers exist.
// ----------------------------------------------------------------------------

export interface ExecutionBlocker {
  scope: 'region' | 'row';
  region_index: number;
  row_index: number | null;
  entity_type: EntityType | null;
  field: string | null;
  message: string;
}

export interface EntityCounts {
  created: number;
  reused: number;
}

export interface ExecutionResult {
  /** True only when a confirm actually wrote rows. */
  committed: boolean;
  dry_run: boolean;
  rows_total: number;
  rows_excluded: number;
  rows_active: number;
  rows_blocked: number;
  rows_imported: number;
  counts: Record<string, EntityCounts>;
  created_ids: Record<string, string[]>;
  blockers: ExecutionBlocker[];
}

interface ParentResolutions {
  default_property_id?: string | null;
  property_overrides?: Record<string, { mode: 'existing' | 'create'; id?: string | null }>;
}

interface RawImportRow {
  id: string;
  region_index: number;
  row_index: number;
  raw: Record<string, string>;
  excluded: boolean;
}

// ----- validation schemas mirroring the DB constraints ----------------------

const zName = z.string().min(1).max(200);
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zProperty = z.object({ name: zName });
const zArea = z.object({ name: zName, kind: z.literal('unit') });
const zUnitDetails = z.object({
  bedrooms: z.number().int().min(0).nullable(),
  bathrooms: z.number().min(0).nullable(),
  sqft: z.number().int().min(0).nullable(),
});
const zTenant = z.object({ full_name: zName });
const zTenancy = z.object({
  start_date: zDate,
  end_date: zDate.nullable(),
  status: z.enum(['upcoming', 'active', 'ended', 'holdover']),
});
const zLease = z.object({
  term_start: zDate,
  term_end: zDate.nullable(),
  rent_amount_cents: z.number().int().min(0),
  rent_currency: z.string().length(3),
  deposit_amount_cents: z.number().int().min(0),
});
const zRentSchedule = z.object({
  amount_cents: z.number().int().min(0),
  currency: z.string().length(3),
  due_day: z.number().int().min(1).max(28),
  start_date: zDate,
  kind: z.string().min(1).max(50),
});

// ----- coercion helpers ------------------------------------------------------

function coerceDate(v: string | null): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isoIfValid(s);
  // US-style M/D/Y or M-D-Y.
  const us = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);
  if (us) {
    const [, mm, dd, yy] = us as unknown as [string, string, string, string];
    let year = parseInt(yy, 10);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const iso = `${year.toString().padStart(4, '0')}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    return isoIfValid(iso);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

function isoIfValid(iso: string): string | null {
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip guards against impossible dates like 2026-02-31.
  return d.toISOString().slice(0, 10) === iso ? iso : null;
}

function coerceInt(v: string | null): number | null {
  if (v == null) return null;
  const m = /-?\d+/.exec(v.replace(/,/g, ''));
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

function coerceDecimal(v: string | null): number | null {
  if (v == null) return null;
  const cleaned = v.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse a currency-ish amount to non-negative integer minor units (cents). */
function coerceMoney(v: string | null): number | null {
  if (v == null) return null;
  let s = v.trim();
  if (s === '') return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[^0-9.]/g, '');
  if (s === '') return null;
  const parts = s.split('.');
  const normalized = parts.length > 2 ? parts.slice(0, -1).join('') + '.' + parts[parts.length - 1] : s;
  const val = parseFloat(normalized);
  if (!Number.isFinite(val) || negative) return null;
  return Math.round(val * 100);
}

function coerceCurrency(v: string | null): string | null {
  if (v == null) return null;
  const s = v.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  const sym: Record<string, string> = { $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' };
  return sym[v.trim()] ?? null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ----- the per-run execution context ----------------------------------------

class ExecCtx {
  private byRegion = new Map<number, Map<EntityType, FieldMapping[]>>();
  private regionScope = new Map<number, Set<EntityType>>();

  private propertyCache = new Map<string, string>();
  private areaCache = new Map<string, string>();
  private tenantCache = new Map<string, string>();
  private tenancyCache = new Map<string, string>();
  private leaseCache = new Set<string>();
  private rentScheduleCache = new Set<string>();

  private counts: Record<string, EntityCounts> = {};
  private createdIds: Record<string, string[]> = {};
  readonly blockers: ExecutionBlocker[] = [];
  private rowBlockers = new Map<string, { field: string | null; message: string }[]>();
  private blockedRowIds = new Set<string>();

  constructor(
    private readonly client: PoolClient,
    private readonly accountId: string,
    private readonly sessionId: string,
    mapping: RegionEntityMapping[],
    private readonly parents: ParentResolutions,
  ) {
    for (const et of ENTITY_ORDER) {
      this.counts[et] = { created: 0, reused: 0 };
      this.createdIds[et] = [];
    }
    for (const m of mapping) {
      let em = this.byRegion.get(m.region_index);
      if (!em) {
        em = new Map();
        this.byRegion.set(m.region_index, em);
      }
      em.set(m.entity_type, m.fields);
    }
    // Decide, per region, which entities are in scope. An entity whose mapping
    // omits a required field is a REGION blocker — not silently dropped.
    for (const [ri, em] of this.byRegion) {
      const scope = new Set<EntityType>();
      for (const et of ENTITY_ORDER) {
        const fields = em.get(et);
        if (!fields || fields.length === 0) continue;
        const mapped = new Set(
          fields.filter((f) => f.source_column || (f.constant != null && f.constant !== '')).map((f) => f.target_field),
        );
        const missing = requiredFields(et).filter((r) => !mapped.has(r));
        if (missing.length > 0) {
          this.blockers.push({
            scope: 'region',
            region_index: ri,
            row_index: null,
            entity_type: et,
            field: missing.join(', '),
            message: `cannot import ${et}: required field(s) not mapped: ${missing.join(', ')}`,
          });
          continue;
        }
        scope.add(et);
      }
      this.regionScope.set(ri, scope);
    }
  }

  private getValue(fields: FieldMapping[] | undefined, target: string, raw: Record<string, string>): string | null {
    if (!fields) return null;
    const fm = fields.find((f) => f.target_field === target);
    if (!fm) return null;
    if (fm.source_column) {
      const v = raw[fm.source_column];
      return v == null || String(v).trim() === '' ? null : String(v).trim();
    }
    if (fm.constant != null && fm.constant !== '') return fm.constant;
    return null;
  }

  private recordCreated(et: EntityType, id: string): void {
    this.counts[et]!.created += 1;
    this.createdIds[et]!.push(id);
  }
  private recordReused(et: EntityType): void {
    this.counts[et]!.reused += 1;
  }

  private async provenance(et: EntityType, entityId: string, row: RawImportRow): Promise<void> {
    await this.client.query(
      `insert into import_provenance (account_id, session_id, entity_type, entity_id, region_index, row_index)
       values ($1, $2, $3, $4, $5, $6)`,
      [this.accountId, this.sessionId, et, entityId, row.region_index, row.row_index],
    );
  }

  private blockRow(row: RawImportRow, entity: EntityType, field: string | null, message: string): void {
    this.blockers.push({
      scope: 'row',
      region_index: row.region_index,
      row_index: row.row_index,
      entity_type: entity,
      field,
      message,
    });
    const list = this.rowBlockers.get(row.id) ?? [];
    list.push({ field, message });
    this.rowBlockers.set(row.id, list);
    this.blockedRowIds.add(row.id);
  }

  // -------- per-entity resolvers (cache -> existing DB row -> create) --------

  private buildAddress(fields: FieldMapping[] | undefined, raw: Record<string, string>): Record<string, string> {
    const map: Record<string, string> = {};
    const pairs: [string, string][] = [
      ['address_line1', 'line1'],
      ['address_line2', 'line2'],
      ['address_city', 'city'],
      ['address_state', 'state'],
      ['address_zip', 'zip'],
    ];
    for (const [target, key] of pairs) {
      const v = this.getValue(fields, target, raw);
      if (v) map[key] = v.slice(0, 200);
    }
    return map;
  }

  private async resolveProperty(row: RawImportRow, name: string, fields: FieldMapping[]): Promise<string | null> {
    const key = name.toLowerCase();
    const cached = this.propertyCache.get(key);
    if (cached) return cached;

    const override = this.parents.property_overrides?.[name];
    if (override?.mode === 'existing' && override.id) {
      this.propertyCache.set(key, override.id);
      this.recordReused('property');
      return override.id;
    }
    if (override?.mode !== 'create') {
      const ex = await this.client.query(
        `select id from properties where account_id = $1 and lower(name) = lower($2) and deleted_at is null limit 2`,
        [this.accountId, name],
      );
      if ((ex.rowCount ?? 0) > 1) {
        this.blockRow(row, 'property', 'name', `ambiguous property "${name}" (multiple matches); resolve via parents`);
        return null;
      }
      if (ex.rowCount === 1) {
        const id = ex.rows[0].id as string;
        this.propertyCache.set(key, id);
        this.recordReused('property');
        return id;
      }
    }
    const v = zProperty.safeParse({ name });
    if (!v.success) {
      this.blockRow(row, 'property', 'name', v.error.issues[0]?.message ?? 'invalid property');
      return null;
    }
    const address = this.buildAddress(fields, row.raw);
    const ins = await this.client.query(
      `insert into properties (account_id, name, address) values ($1, $2, $3::jsonb) returning id`,
      [this.accountId, name, JSON.stringify(address)],
    );
    const id = ins.rows[0].id as string;
    this.propertyCache.set(key, id);
    this.recordCreated('property', id);
    await this.provenance('property', id, row);
    return id;
  }

  private async resolveArea(row: RawImportRow, propertyId: string, name: string): Promise<string | null> {
    const key = `${propertyId}::${name.toLowerCase()}`;
    const cached = this.areaCache.get(key);
    if (cached) return cached;

    const ex = await this.client.query(
      `select id from areas where account_id = $1 and property_id = $2 and lower(name) = lower($3)
         and kind = 'unit' and deleted_at is null limit 2`,
      [this.accountId, propertyId, name],
    );
    if ((ex.rowCount ?? 0) > 1) {
      this.blockRow(row, 'area', 'name', `ambiguous unit "${name}" within its property`);
      return null;
    }
    if (ex.rowCount === 1) {
      const id = ex.rows[0].id as string;
      this.areaCache.set(key, id);
      this.recordReused('area');
      return id;
    }
    const v = zArea.safeParse({ name, kind: 'unit' });
    if (!v.success) {
      this.blockRow(row, 'area', 'name', v.error.issues[0]?.message ?? 'invalid unit');
      return null;
    }
    const ins = await this.client.query(
      `insert into areas (account_id, property_id, kind, name) values ($1, $2, 'unit', $3) returning id`,
      [this.accountId, propertyId, name],
    );
    const id = ins.rows[0].id as string;
    this.areaCache.set(key, id);
    this.recordCreated('area', id);
    await this.provenance('area', id, row);
    return id;
  }

  private async maybeCreateUnitDetails(row: RawImportRow, areaId: string, fields: FieldMapping[]): Promise<void> {
    const bedrooms = coerceInt(this.getValue(fields, 'bedrooms', row.raw));
    const bathrooms = coerceDecimal(this.getValue(fields, 'bathrooms', row.raw));
    const sqft = coerceInt(this.getValue(fields, 'sqft', row.raw));
    if (bedrooms === null && bathrooms === null && sqft === null) return;
    const v = zUnitDetails.safeParse({ bedrooms, bathrooms, sqft });
    if (!v.success) {
      this.blockRow(row, 'unit_details', null, v.error.issues[0]?.message ?? 'invalid unit details');
      return;
    }
    const ins = await this.client.query(
      `insert into unit_details (area_id, account_id, bedrooms, bathrooms, sqft)
       values ($1, $2, $3, $4, $5) on conflict (area_id) do nothing returning area_id`,
      [areaId, this.accountId, bedrooms, bathrooms, sqft],
    );
    if (ins.rowCount === 1) {
      this.recordCreated('unit_details', areaId);
      await this.provenance('unit_details', areaId, row);
    } else {
      this.recordReused('unit_details');
    }
  }

  private async resolveTenant(row: RawImportRow, name: string, fields: FieldMapping[]): Promise<string | null> {
    const key = name.toLowerCase();
    const cached = this.tenantCache.get(key);
    if (cached) return cached;

    const ex = await this.client.query(
      `select id from tenants where account_id = $1 and lower(full_name) = lower($2) and deleted_at is null
         order by created_at asc limit 1`,
      [this.accountId, name],
    );
    if (ex.rowCount === 1) {
      const id = ex.rows[0].id as string;
      this.tenantCache.set(key, id);
      this.recordReused('tenant');
      return id;
    }
    const v = zTenant.safeParse({ full_name: name });
    if (!v.success) {
      this.blockRow(row, 'tenant', 'full_name', v.error.issues[0]?.message ?? 'invalid tenant');
      return null;
    }
    const email = this.getValue(fields, 'email', row.raw);
    const phone = this.getValue(fields, 'phone', row.raw);
    const ins = await this.client.query(
      `insert into tenants (account_id, full_name, emails, phones) values ($1, $2, $3, $4) returning id`,
      [this.accountId, name, email ? [email] : [], phone ? [phone] : []],
    );
    const id = ins.rows[0].id as string;
    this.tenantCache.set(key, id);
    this.recordCreated('tenant', id);
    await this.provenance('tenant', id, row);
    return id;
  }

  private async resolveTenancy(
    row: RawImportRow,
    areaId: string,
    start: string,
    end: string | null,
  ): Promise<string | null> {
    const key = `${areaId}::${start}`;
    const cached = this.tenancyCache.get(key);
    if (cached) return cached;

    const ex = await this.client.query(
      `select id from tenancies where account_id = $1 and area_id = $2 and start_date = $3 and deleted_at is null limit 1`,
      [this.accountId, areaId, start],
    );
    if (ex.rowCount === 1) {
      const id = ex.rows[0].id as string;
      this.tenancyCache.set(key, id);
      this.recordReused('tenancy');
      return id;
    }
    const today = todayIso();
    const status = end && end < today ? 'ended' : start > today ? 'upcoming' : 'active';
    const v = zTenancy.safeParse({ start_date: start, end_date: end, status });
    if (!v.success) {
      this.blockRow(row, 'tenancy', 'start_date', v.error.issues[0]?.message ?? 'invalid tenancy');
      return null;
    }
    const ins = await this.client.query(
      `insert into tenancies (account_id, area_id, start_date, end_date, status) values ($1, $2, $3, $4, $5) returning id`,
      [this.accountId, areaId, start, end, status],
    );
    const id = ins.rows[0].id as string;
    this.tenancyCache.set(key, id);
    this.recordCreated('tenancy', id);
    await this.provenance('tenancy', id, row);
    return id;
  }

  private async maybeCreateMember(
    row: RawImportRow,
    tenancyId: string,
    tenantId: string,
    fields: FieldMapping[] | undefined,
  ): Promise<void> {
    const rawRole = (this.getValue(fields, 'role', row.raw) ?? 'primary').toLowerCase();
    const role = ['primary', 'occupant', 'guarantor'].includes(rawRole) ? rawRole : 'primary';
    const ins = await this.client.query(
      `insert into tenancy_tenants (account_id, tenancy_id, tenant_id, role) values ($1, $2, $3, $4)
       on conflict (tenancy_id, tenant_id, role) do nothing returning id`,
      [this.accountId, tenancyId, tenantId, role],
    );
    if (ins.rowCount === 1) {
      this.recordCreated('tenancy_member', ins.rows[0].id as string);
      await this.provenance('tenancy_member', ins.rows[0].id as string, row);
    } else {
      this.recordReused('tenancy_member');
    }
  }

  private async maybeCreateLease(
    row: RawImportRow,
    tenancyId: string,
    tenancyStart: string,
    tenancyEnd: string | null,
    fields: FieldMapping[],
  ): Promise<void> {
    const rentCents = coerceMoney(this.getValue(fields, 'rent_amount', row.raw));
    // A lease is optional; only materialize one when there's a rent figure for it.
    if (rentCents === null) return;
    const termStart = coerceDate(this.getValue(fields, 'term_start', row.raw)) ?? tenancyStart;
    const termEnd = coerceDate(this.getValue(fields, 'term_end', row.raw)) ?? tenancyEnd;
    const currency = coerceCurrency(this.getValue(fields, 'rent_currency', row.raw)) ?? 'USD';
    const depositCents = coerceMoney(this.getValue(fields, 'deposit_amount', row.raw)) ?? 0;

    const v = zLease.safeParse({
      term_start: termStart,
      term_end: termEnd,
      rent_amount_cents: rentCents,
      rent_currency: currency,
      deposit_amount_cents: depositCents,
    });
    if (!v.success) {
      this.blockRow(row, 'lease', null, v.error.issues[0]?.message ?? 'invalid lease');
      return;
    }
    const cacheKey = `${tenancyId}::${termStart}::${rentCents}`;
    if (this.leaseCache.has(cacheKey)) {
      this.recordReused('lease');
      return;
    }
    const ex = await this.client.query(
      `select id from leases where account_id = $1 and tenancy_id = $2 and term_start = $3
         and rent_amount_cents = $4 and deleted_at is null limit 1`,
      [this.accountId, tenancyId, termStart, rentCents],
    );
    if (ex.rowCount === 1) {
      this.leaseCache.add(cacheKey);
      this.recordReused('lease');
      return;
    }
    const today = todayIso();
    const status = termEnd && termEnd < today ? 'expired' : 'active';
    const ins = await this.client.query(
      `insert into leases
         (account_id, tenancy_id, term_start, term_end, rent_amount_cents, rent_currency,
          deposit_amount_cents, deposit_currency, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        this.accountId,
        tenancyId,
        termStart,
        termEnd,
        rentCents,
        currency,
        depositCents,
        depositCents > 0 ? currency : null,
        status,
      ],
    );
    const id = ins.rows[0].id as string;
    this.leaseCache.add(cacheKey);
    this.recordCreated('lease', id);
    await this.provenance('lease', id, row);
  }

  private async maybeCreateRentSchedule(
    row: RawImportRow,
    tenancyId: string,
    tenancyStart: string,
    fields: FieldMapping[],
  ): Promise<void> {
    const amountRaw = this.getValue(fields, 'amount', row.raw);
    const amountCents = coerceMoney(amountRaw);
    if (amountCents === null) {
      this.blockRow(row, 'rent_schedule', 'amount', amountRaw ? `unparseable rent amount "${amountRaw}"` : 'missing rent amount');
      return;
    }
    const currency = coerceCurrency(this.getValue(fields, 'currency', row.raw)) ?? 'USD';
    const dueDayRaw = coerceInt(this.getValue(fields, 'due_day', row.raw));
    const dueDay = dueDayRaw === null ? 1 : Math.min(28, Math.max(1, dueDayRaw));
    const startDate = coerceDate(this.getValue(fields, 'start_date', row.raw)) ?? tenancyStart;
    const kind = 'rent';

    const v = zRentSchedule.safeParse({
      amount_cents: amountCents,
      currency,
      due_day: dueDay,
      start_date: startDate,
      kind,
    });
    if (!v.success) {
      this.blockRow(row, 'rent_schedule', 'amount', v.error.issues[0]?.message ?? 'invalid rent schedule');
      return;
    }
    const cacheKey = `${tenancyId}::${kind}::${startDate}`;
    if (this.rentScheduleCache.has(cacheKey)) {
      this.recordReused('rent_schedule');
      return;
    }
    const ex = await this.client.query(
      `select id from rent_schedules where account_id = $1 and tenancy_id = $2 and kind = $3
         and start_date = $4 and deleted_at is null limit 1`,
      [this.accountId, tenancyId, kind, startDate],
    );
    if (ex.rowCount === 1) {
      this.rentScheduleCache.add(cacheKey);
      this.recordReused('rent_schedule');
      return;
    }
    const ins = await this.client.query(
      `insert into rent_schedules (account_id, tenancy_id, kind, amount_cents, currency, due_day, start_date)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [this.accountId, tenancyId, kind, amountCents, currency, dueDay, startDate],
    );
    const id = ins.rows[0].id as string;
    this.rentScheduleCache.add(cacheKey);
    this.recordCreated('rent_schedule', id);
    await this.provenance('rent_schedule', id, row);
  }

  // -------- the per-row driver, in topological order ------------------------

  async processRow(row: RawImportRow): Promise<void> {
    const regionMap = this.byRegion.get(row.region_index);
    const scope = this.regionScope.get(row.region_index);
    if (!regionMap || !scope) return;

    let propertyId: string | null = null;
    let areaId: string | null = null;
    let tenantId: string | null = null;
    let tenancyId: string | null = null;

    // property
    if (this.parents.default_property_id) {
      propertyId = this.parents.default_property_id;
    } else if (scope.has('property')) {
      const name = this.getValue(regionMap.get('property'), 'name', row.raw);
      if (!name) this.blockRow(row, 'property', 'name', 'missing property name');
      else propertyId = await this.resolveProperty(row, name, regionMap.get('property')!);
    }

    // area (unit) + unit_details
    if (scope.has('area')) {
      if (!propertyId) {
        this.blockRow(row, 'area', 'name', 'unit needs a property: map a property column or set a default property');
      } else {
        const unitName = this.getValue(regionMap.get('area'), 'name', row.raw);
        if (!unitName) this.blockRow(row, 'area', 'name', 'missing unit label');
        else {
          areaId = await this.resolveArea(row, propertyId, unitName);
          if (areaId && scope.has('unit_details')) {
            await this.maybeCreateUnitDetails(row, areaId, regionMap.get('unit_details')!);
          }
        }
      }
    }

    // tenant
    if (scope.has('tenant')) {
      const fullName = this.getValue(regionMap.get('tenant'), 'full_name', row.raw);
      if (!fullName) {
        if (scope.has('tenancy_member')) this.blockRow(row, 'tenant', 'full_name', 'missing tenant name');
      } else {
        tenantId = await this.resolveTenant(row, fullName, regionMap.get('tenant')!);
      }
    }

    // tenancy + members + lease + rent_schedule
    if (scope.has('tenancy')) {
      if (!areaId) {
        this.blockRow(row, 'tenancy', 'area', 'tenancy needs a unit');
      } else {
        const startRaw = this.getValue(regionMap.get('tenancy'), 'start_date', row.raw);
        const start = coerceDate(startRaw);
        if (!start) {
          this.blockRow(row, 'tenancy', 'start_date', startRaw ? `unparseable start date "${startRaw}"` : 'missing tenancy start date');
        } else {
          const endRaw = this.getValue(regionMap.get('tenancy'), 'end_date', row.raw);
          const end = endRaw ? coerceDate(endRaw) : null;
          if (endRaw && !end) {
            this.blockRow(row, 'tenancy', 'end_date', `unparseable end date "${endRaw}"`);
          } else if (end && end < start) {
            this.blockRow(row, 'tenancy', 'end_date', 'end date precedes start date');
          } else {
            tenancyId = await this.resolveTenancy(row, areaId, start, end);
            if (tenancyId) {
              if (scope.has('tenancy_member') && tenantId) {
                await this.maybeCreateMember(row, tenancyId, tenantId, regionMap.get('tenancy_member'));
              }
              if (scope.has('lease')) {
                await this.maybeCreateLease(row, tenancyId, start, end, regionMap.get('lease')!);
              }
              if (scope.has('rent_schedule')) {
                await this.maybeCreateRentSchedule(row, tenancyId, start, regionMap.get('rent_schedule')!);
              }
            }
          }
        }
      }
    }
  }

  buildResult(opts: { dryRun: boolean; rowsTotal: number; rowsExcluded: number; rowsActive: number }): ExecutionResult {
    return {
      committed: false,
      dry_run: opts.dryRun,
      rows_total: opts.rowsTotal,
      rows_excluded: opts.rowsExcluded,
      rows_active: opts.rowsActive,
      rows_blocked: this.blockedRowIds.size,
      rows_imported: opts.rowsActive - this.blockedRowIds.size,
      counts: this.counts,
      created_ids: this.createdIds,
      blockers: this.blockers,
    };
  }

  /** Persist per-row blockers for the UI (clears stale ones first). Runs after
   *  the savepoint rollback so it survives into the COMMIT. */
  async persistRowBlockers(): Promise<void> {
    await this.client.query(
      `update import_rows set blockers = '[]'::jsonb, updated_at = now()
         where session_id = $1 and account_id = $2 and blockers <> '[]'::jsonb`,
      [this.sessionId, this.accountId],
    );
    for (const [rowId, list] of this.rowBlockers) {
      await this.client.query(
        `update import_rows set blockers = $1::jsonb, updated_at = now() where id = $2 and session_id = $3`,
        [JSON.stringify(list), rowId, this.sessionId],
      );
    }
  }
}

/**
 * Run an import session as a preview (dryRun=true) or a commit (dryRun=false).
 * One transaction, one code path, branching only at the end.
 */
export async function runImport(sessionId: string, accountId: string, dryRun: boolean): Promise<ExecutionResult> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Bypass RLS (service_role has BYPASSRLS) while keeping auth.uid() NULL so
    // audit.actor wins attribution for every entity the import creates.
    await client.query('SET LOCAL ROLE service_role');
    await client.query(`select set_config('audit.actor', $1, true)`, [`system:import:${sessionId}`]);

    const sess = await client.query(
      `select mapping, parent_resolutions from import_sessions
         where id = $1 and account_id = $2 and deleted_at is null`,
      [sessionId, accountId],
    );
    if (sess.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new ApiError(404, 'not_found', 'import session not found');
    }
    const mapping = (sess.rows[0].mapping ?? []) as RegionEntityMapping[];
    const parents = (sess.rows[0].parent_resolutions ?? {}) as ParentResolutions;

    const rowsRes = await client.query(
      `select id, region_index, row_index, raw, excluded from import_rows
         where session_id = $1 and account_id = $2 order by region_index, row_index`,
      [sessionId, accountId],
    );
    const allRows = rowsRes.rows as RawImportRow[];
    const activeRows = allRows.filter((r) => !r.excluded);

    await client.query('SAVEPOINT entity_writes');

    const ctx = new ExecCtx(client, accountId, sessionId, mapping, parents);
    for (const row of activeRows) {
      await ctx.processRow(row);
    }
    const result = ctx.buildResult({
      dryRun,
      rowsTotal: allRows.length,
      rowsExcluded: allRows.length - activeRows.length,
      rowsActive: activeRows.length,
    });

    if (dryRun) {
      await client.query('ROLLBACK TO SAVEPOINT entity_writes');
      await ctx.persistRowBlockers();
      await client.query(
        `update import_sessions set preview_summary = $1::jsonb, status = 'preview_ready', error = null, updated_at = now()
           where id = $2 and account_id = $3`,
        [JSON.stringify(result), sessionId, accountId],
      );
      await client.query('COMMIT');
      return result;
    }

    // confirm: a blocker means we must not write anything.
    if (result.blockers.length > 0) {
      await client.query('ROLLBACK TO SAVEPOINT entity_writes');
      await ctx.persistRowBlockers();
      await client.query(
        `update import_sessions set preview_summary = $1::jsonb, status = 'preview_ready',
           error = 'import has unresolved blockers', updated_at = now()
           where id = $2 and account_id = $3`,
        [JSON.stringify(result), sessionId, accountId],
      );
      await client.query('COMMIT');
      return { ...result, committed: false };
    }

    const committed = { ...result, committed: true };
    await ctx.persistRowBlockers(); // clears any stale blockers from a prior preview
    await client.query(
      `update import_sessions set result = $1::jsonb, status = 'done', error = null, updated_at = now()
         where id = $2 and account_id = $3`,
      [JSON.stringify(committed), sessionId, accountId],
    );
    await client.query('COMMIT');
    return committed;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the transaction may already be aborted; ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
