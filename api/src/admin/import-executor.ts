import type { PoolClient } from 'pg';
import { getPool } from './db-pool';
import { ApiError } from '../routes/_lib/error';
import {
  ENTITY_ORDER,
  requiredFields,
  type BlockerCode,
  type EntityType,
  type FieldMapping,
  type RegionEntityMapping,
} from './import-catalog';
// The import path validates against the EXACT same Zod schemas the HTTP POST
// handlers use -- not a parallel copy -- so it can never persist anything an
// HTTP POST would reject (item 1 of the review). DB constraints/triggers/FKs
// (name lengths, currency length, amount>=0, due_day, dates, status/kind enums,
// area.kind, account-scoped composite FKs, immutability) fire on the raw pg
// connection identically; these schemas add the route-only checks the DB does
// NOT enforce: tenant email format, phone length, address sub-field lengths.
import type { z } from 'zod';
import { CreatePropertyBody } from '../routes/properties';
import { AreaKind, CreateAreaBody } from '../routes/areas';
import { PutUnitDetailsBody } from '../routes/unit-details';
import { CreateTenantBody } from '../routes/tenants';
import { CreateTenancyBody } from '../routes/tenancies';
import { AddMemberBody } from '../routes/tenancy-members';
import { CreateLeaseBody } from '../routes/leases';
import { CreateRentScheduleBody } from '../routes/rent-schedules';
import { CreateInteractionBody } from '../routes/interactions';

/** Concise first-issue message from a Zod safeParse error (no z import). */
function firstIssue(err: { issues?: { path: (string | number)[]; message: string }[] }): string {
  const i = err.issues?.[0];
  return i ? `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}` : 'validation failed';
}

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
  /** Stable machine-readable cause; the FE switches on this, never on message. */
  code: BlockerCode;
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
  /** raw->ISO date interpretations (deduped) so a locale misread is visible in
   *  the preview. `ambiguous` flags values like "01/02/2024" that are valid
   *  under both M/D/Y and D/M/Y; the importer reads them as M/D/Y. */
  date_interpretations: { field: string; raw: string; iso: string; interpreted_as: string; ambiguous: boolean }[];
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

/**
 * Normalize a mapped area-kind cell to the AreaKind enum. Empty/unmapped
 * defaults to 'unit'; anything else must normalize ("Exterior Grounds" ->
 * exterior_grounds) to an enum value or the row is blocked.
 */
function coerceAreaKind(v: string | null): z.infer<typeof AreaKind> | null {
  if (v == null || v.trim() === '') return 'unit';
  const normalized = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const parsed = AreaKind.safeParse(normalized);
  return parsed.success ? parsed.data : null;
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

/**
 * Extract a leading date prefix from a note: "6/2: Gardeners coming" or
 * "6/9/26 - canopy" -> ISO date. When the prefix has no year, the CURRENT
 * year is inferred (decision: imported journals are near-past; the full
 * original text is always kept as the body, so nothing is lost if the
 * inference is off). Returns null when there is no parseable prefix.
 */
function extractLeadingDate(text: string): string | null {
  const m = /^\s*(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\s*[:\u2013\u2014-]/.exec(text);
  if (!m) return null;
  const mm = m[1]!.padStart(2, '0');
  const dd = m[2]!.padStart(2, '0');
  let year: number;
  if (m[3]) {
    year = parseInt(m[3], 10);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
  } else {
    year = new Date().getUTCFullYear();
  }
  return isoIfValid(`${year}-${mm}-${dd}`);
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
  // Memoizes whether a user-supplied parent id actually belongs to THIS
  // account. The service_role connection bypasses RLS, so this manual scoping
  // is the isolation guard (defense-in-depth ahead of the composite FK).
  private verifiedProperties = new Map<string, boolean>();
  private defaultPropertyCounted = false;

  private counts: Record<string, EntityCounts> = {};
  private createdIds: Record<string, string[]> = {};
  readonly blockers: ExecutionBlocker[] = [];
  private rowBlockers = new Map<string, { field: string | null; code: BlockerCode; message: string }[]>();
  private blockedRowIds = new Set<string>();
  private dateSamples = new Map<string, ExecutionResult['date_interpretations'][number]>();

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
            code: 'unmapped_required_field',
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

  private recordDate(field: string, raw: string | null, iso: string | null): void {
    if (!raw || !iso) return;
    const key = `${field}|${raw}`;
    if (this.dateSamples.has(key) || this.dateSamples.size >= 50) return;
    const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.]\d{2,4}$/.exec(raw.trim());
    const ambiguous = !!m && Number(m[1]) <= 12 && Number(m[2]) <= 12 && m[1] !== m[2];
    this.dateSamples.set(key, { field, raw, iso, interpreted_as: 'US M/D/Y', ambiguous });
  }

  private blockRow(row: RawImportRow, entity: EntityType, field: string | null, code: BlockerCode, message: string): void {
    this.blockers.push({
      scope: 'row',
      region_index: row.region_index,
      row_index: row.row_index,
      entity_type: entity,
      field,
      code,
      message,
    });
    const list = this.rowBlockers.get(row.id) ?? [];
    list.push({ field, code, message });
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
      // Do NOT truncate -- CreatePropertyBody enforces the per-field max lengths
      // and an over-long value becomes a row blocker (parity with an HTTP POST,
      // which would 400 rather than silently truncate).
      if (v) map[key] = v;
    }
    return map;
  }

  /** True iff `id` is a live property in THIS account. Memoized. The only
   *  isolation guard on bound parent ids, since service_role bypasses RLS. */
  private async verifyPropertyInAccount(id: string): Promise<boolean> {
    const cached = this.verifiedProperties.get(id);
    if (cached !== undefined) return cached;
    const r = await this.client.query(
      `select 1 from properties where account_id = $1 and id = $2 and deleted_at is null limit 1`,
      [this.accountId, id],
    );
    const ok = (r.rowCount ?? 0) === 1;
    this.verifiedProperties.set(id, ok);
    return ok;
  }

  /** Resolve the session-wide default property, verifying account ownership. */
  private async resolveDefaultProperty(row: RawImportRow, id: string): Promise<string | null> {
    if (!(await this.verifyPropertyInAccount(id))) {
      this.blockRow(row, 'property', 'name', 'parent_not_found', `default property not found in this account: ${id}`);
      return null;
    }
    if (!this.defaultPropertyCounted) {
      this.recordReused('property');
      this.defaultPropertyCounted = true;
    }
    return id;
  }

  private async resolveProperty(row: RawImportRow, name: string, fields: FieldMapping[]): Promise<string | null> {
    const key = name.toLowerCase();
    const cached = this.propertyCache.get(key);
    if (cached) return cached;

    const override = this.parents.property_overrides?.[name];
    if (override?.mode === 'existing' && override.id) {
      // bind_existing: the id MUST belong to this account (RLS is bypassed here).
      if (!(await this.verifyPropertyInAccount(override.id))) {
        this.blockRow(row, 'property', 'name', 'parent_not_found', `bound property not found in this account: ${override.id}`);
        return null;
      }
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
        this.blockRow(row, 'property', 'name', 'ambiguous_match', `ambiguous property "${name}" (multiple matches); resolve via parents`);
        return null;
      }
      if (ex.rowCount === 1) {
        const id = ex.rows[0].id as string;
        this.propertyCache.set(key, id);
        this.recordReused('property');
        return id;
      }
    }
    const v = CreatePropertyBody.safeParse({ name, address: this.buildAddress(fields, row.raw) });
    if (!v.success) {
      this.blockRow(row, 'property', 'name', 'invalid_value', firstIssue(v.error));
      return null;
    }
    const ins = await this.client.query(
      `insert into properties (account_id, name, address) values ($1, $2, $3::jsonb) returning id`,
      [this.accountId, v.data.name, JSON.stringify(v.data.address ?? {})],
    );
    const id = ins.rows[0].id as string;
    this.propertyCache.set(key, id);
    this.recordCreated('property', id);
    await this.provenance('property', id, row);
    return id;
  }

  private async resolveArea(
    row: RawImportRow,
    propertyId: string,
    name: string,
    kind: z.infer<typeof AreaKind>,
  ): Promise<string | null> {
    const key = `${propertyId}::${kind}::${name.toLowerCase()}`;
    const cached = this.areaCache.get(key);
    if (cached) return cached;

    const ex = await this.client.query(
      `select id from areas where account_id = $1 and property_id = $2 and lower(name) = lower($3)
         and kind = $4 and deleted_at is null limit 2`,
      [this.accountId, propertyId, name, kind],
    );
    if ((ex.rowCount ?? 0) > 1) {
      this.blockRow(row, 'area', 'name', 'ambiguous_match', `ambiguous ${kind} "${name}" within its property`);
      return null;
    }
    if (ex.rowCount === 1) {
      const id = ex.rows[0].id as string;
      this.areaCache.set(key, id);
      this.recordReused('area');
      return id;
    }
    const v = CreateAreaBody.safeParse({ property_id: propertyId, kind, name });
    if (!v.success) {
      this.blockRow(row, 'area', 'name', 'invalid_value', firstIssue(v.error));
      return null;
    }
    const ins = await this.client.query(
      `insert into areas (account_id, property_id, kind, name) values ($1, $2, $3, $4) returning id`,
      [this.accountId, v.data.property_id, v.data.kind, v.data.name],
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
    const v = PutUnitDetailsBody.safeParse({ bedrooms, bathrooms, sqft });
    if (!v.success) {
      this.blockRow(row, 'unit_details', null, 'invalid_value', firstIssue(v.error));
      return;
    }
    const ins = await this.client.query(
      `insert into unit_details (area_id, account_id, bedrooms, bathrooms, sqft)
       values ($1, $2, $3, $4, $5) on conflict (area_id) do nothing returning area_id`,
      [areaId, this.accountId, v.data.bedrooms ?? null, v.data.bathrooms ?? null, v.data.sqft ?? null],
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
    const email = this.getValue(fields, 'email', row.raw);
    const phone = this.getValue(fields, 'phone', row.raw);
    const v = CreateTenantBody.safeParse({
      full_name: name,
      emails: email ? [email] : undefined,
      phones: phone ? [phone] : undefined,
    });
    if (!v.success) {
      // Closes the route-only gaps the DB doesn't enforce: email format + phone length.
      this.blockRow(row, 'tenant', 'full_name', 'invalid_value', firstIssue(v.error));
      return null;
    }
    const ins = await this.client.query(
      `insert into tenants (account_id, full_name, emails, phones) values ($1, $2, $3, $4) returning id`,
      [this.accountId, v.data.full_name, v.data.emails ?? [], v.data.phones ?? []],
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
    const v = CreateTenancyBody.safeParse({ area_id: areaId, start_date: start, end_date: end ?? null, status });
    if (!v.success) {
      this.blockRow(row, 'tenancy', 'start_date', 'invalid_value', firstIssue(v.error));
      return null;
    }
    const ins = await this.client.query(
      `insert into tenancies (account_id, area_id, start_date, end_date, status) values ($1, $2, $3, $4, $5) returning id`,
      [this.accountId, v.data.area_id, v.data.start_date, v.data.end_date ?? null, v.data.status],
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
    const v = AddMemberBody.safeParse({ tenant_id: tenantId, role });
    if (!v.success) {
      this.blockRow(row, 'tenancy_member', 'role', 'invalid_value', firstIssue(v.error));
      return;
    }
    const ins = await this.client.query(
      `insert into tenancy_tenants (account_id, tenancy_id, tenant_id, role) values ($1, $2, $3, $4)
       on conflict (tenancy_id, tenant_id, role) do nothing returning id`,
      [this.accountId, tenancyId, v.data.tenant_id, v.data.role],
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

    const today = todayIso();
    const status = termEnd && termEnd < today ? 'expired' : 'active';
    const v = CreateLeaseBody.safeParse({
      tenancy_id: tenancyId,
      term_start: termStart,
      term_end: termEnd ?? null,
      rent_amount_cents: rentCents,
      rent_currency: currency,
      deposit_amount_cents: depositCents,
      deposit_currency: depositCents > 0 ? currency : undefined,
      status,
    });
    if (!v.success) {
      this.blockRow(row, 'lease', null, 'invalid_value', firstIssue(v.error));
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
    const ins = await this.client.query(
      `insert into leases
         (account_id, tenancy_id, term_start, term_end, rent_amount_cents, rent_currency,
          deposit_amount_cents, deposit_currency, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        this.accountId,
        v.data.tenancy_id,
        v.data.term_start,
        v.data.term_end ?? null,
        v.data.rent_amount_cents,
        v.data.rent_currency,
        v.data.deposit_amount_cents ?? 0,
        v.data.deposit_currency ?? null,
        v.data.status,
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
      this.blockRow(row, 'rent_schedule', 'amount', amountRaw ? 'unparseable_value' : 'missing_required_field', amountRaw ? `unparseable rent amount "${amountRaw}"` : 'missing rent amount');
      return;
    }
    const currency = coerceCurrency(this.getValue(fields, 'currency', row.raw)) ?? 'USD';
    const dueDayRaw = coerceInt(this.getValue(fields, 'due_day', row.raw));
    const dueDay = dueDayRaw === null ? 1 : Math.min(28, Math.max(1, dueDayRaw));
    const startDate = coerceDate(this.getValue(fields, 'start_date', row.raw)) ?? tenancyStart;
    const kind = 'rent';

    const v = CreateRentScheduleBody.safeParse({
      tenancy_id: tenancyId,
      kind,
      amount_cents: amountCents,
      currency,
      due_day: dueDay,
      start_date: startDate,
    });
    if (!v.success) {
      this.blockRow(row, 'rent_schedule', 'amount', 'invalid_value', firstIssue(v.error));
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
      [this.accountId, v.data.tenancy_id, v.data.kind, v.data.amount_cents, v.data.currency, v.data.due_day, v.data.start_date],
    );
    const id = ins.rows[0].id as string;
    this.rentScheduleCache.add(cacheKey);
    this.recordCreated('rent_schedule', id);
    await this.provenance('rent_schedule', id, row);
  }

  // -------- the per-row driver, in topological order ------------------------

  /** One imported note per non-empty cell: channel='import', direction='none'. */
  private async createInteraction(
    row: RawImportRow,
    body: string,
    fields: FieldMapping[],
    areaId: string | null,
    tenancyId: string | null,
  ): Promise<void> {
    // Date precedence: mapped occurred_at column > leading "M/D[/Y]:" prefix
    // in the text (year inferred when absent) > the import date itself.
    const mappedRaw = this.getValue(fields, 'occurred_at', row.raw);
    const mapped = coerceDate(mappedRaw);
    this.recordDate('interaction.occurred_at', mappedRaw, mapped);
    const occurred = mapped ?? extractLeadingDate(body) ?? todayIso();

    const v = CreateInteractionBody.safeParse({
      party_type: 'other',
      channel: 'import',
      direction: 'none',
      body,
      occurred_at: `${occurred}T00:00:00.000Z`,
      area_id: areaId ?? undefined,
      tenancy_id: tenancyId ?? undefined,
    });
    if (!v.success) {
      this.blockRow(row, 'interaction', 'body', 'invalid_value', firstIssue(v.error));
      return;
    }
    const ins = await this.client.query(
      `insert into interactions
         (account_id, actor, party_type, channel, direction, body, occurred_at, area_id, tenancy_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        this.accountId,
        `system:import:${this.sessionId}`,
        v.data.party_type,
        v.data.channel,
        v.data.direction,
        v.data.body,
        v.data.occurred_at,
        v.data.area_id ?? null,
        v.data.tenancy_id ?? null,
      ],
    );
    const id = ins.rows[0].id as string;
    this.recordCreated('interaction', id);
    await this.provenance('interaction', id, row);
  }

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
      propertyId = await this.resolveDefaultProperty(row, this.parents.default_property_id);
    } else if (scope.has('property')) {
      const name = this.getValue(regionMap.get('property'), 'name', row.raw);
      if (!name) this.blockRow(row, 'property', 'name', 'missing_required_field', 'missing property name');
      else propertyId = await this.resolveProperty(row, name, regionMap.get('property')!);
    }

    // area (unit or common space) + unit_details
    if (scope.has('area')) {
      if (!propertyId) {
        this.blockRow(row, 'area', 'name', 'missing_parent_property', 'area needs a property: map a property column or set a default property');
      } else {
        const areaName = this.getValue(regionMap.get('area'), 'name', row.raw);
        if (!areaName) this.blockRow(row, 'area', 'name', 'missing_required_field', 'missing area label');
        else {
          const kindRaw = this.getValue(regionMap.get('area'), 'kind', row.raw);
          const kind = coerceAreaKind(kindRaw);
          if (!kind) {
            this.blockRow(row, 'area', 'kind', 'invalid_value', `unknown area kind "${kindRaw}"`);
          } else {
            areaId = await this.resolveArea(row, propertyId, areaName, kind);
            // unit_details is unit-only (DB trigger enforces area.kind='unit');
            // surface a blocker instead of letting the trigger abort the txn.
            if (areaId && scope.has('unit_details')) {
              if (kind !== 'unit') {
                const hasDetails =
                  this.getValue(regionMap.get('unit_details'), 'bedrooms', row.raw) ||
                  this.getValue(regionMap.get('unit_details'), 'bathrooms', row.raw) ||
                  this.getValue(regionMap.get('unit_details'), 'sqft', row.raw);
                if (hasDetails) this.blockRow(row, 'unit_details', null, 'details_on_non_unit', `unit details on a ${kind} area (units only)`);
              } else {
                await this.maybeCreateUnitDetails(row, areaId, regionMap.get('unit_details')!);
              }
            }
          }
        }
      }
    }

    // tenant
    if (scope.has('tenant')) {
      const fullName = this.getValue(regionMap.get('tenant'), 'full_name', row.raw);
      if (!fullName) {
        if (scope.has('tenancy_member')) this.blockRow(row, 'tenant', 'full_name', 'missing_required_field', 'missing tenant name');
      } else {
        tenantId = await this.resolveTenant(row, fullName, regionMap.get('tenant')!);
      }
    }

    // tenancy + members + lease + rent_schedule
    if (scope.has('tenancy')) {
      if (!areaId) {
        this.blockRow(row, 'tenancy', 'area', 'missing_parent_area', 'tenancy needs a unit');
      } else {
        const startRaw = this.getValue(regionMap.get('tenancy'), 'start_date', row.raw);
        const start = coerceDate(startRaw);
        this.recordDate('tenancy.start_date', startRaw, start);
        if (!start) {
          this.blockRow(row, 'tenancy', 'start_date', startRaw ? 'unparseable_value' : 'missing_required_field', startRaw ? `unparseable start date "${startRaw}"` : 'missing tenancy start date');
        } else {
          const endRaw = this.getValue(regionMap.get('tenancy'), 'end_date', row.raw);
          const end = endRaw ? coerceDate(endRaw) : null;
          this.recordDate('tenancy.end_date', endRaw, end);
          if (endRaw && !end) {
            this.blockRow(row, 'tenancy', 'end_date', 'unparseable_value', `unparseable end date "${endRaw}"`);
          } else if (end && end < start) {
            this.blockRow(row, 'tenancy', 'end_date', 'date_order', 'end date precedes start date');
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

    // interaction (imported note) — attaches to whatever parents this row
    // resolved (area and/or tenancy may be null; both are optional on the
    // table). An EMPTY note cell is simply no note: skip, never a blocker.
    if (scope.has('interaction')) {
      const fields = regionMap.get('interaction')!;
      const body = this.getValue(fields, 'body', row.raw);
      if (body) await this.createInteraction(row, body, fields, areaId, tenancyId);
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
      date_interpretations: [...this.dateSamples.values()],
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
