import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { getLogger } from '../../log';
import {
  ENTITY_ORDER,
  requiredFields,
  type BlockerCode,
  type EntityType,
  type FieldMapping,
  type RegionEntityMapping,
} from '../import-catalog';
import type {
  AreaKind} from '../../schemas/importable';
import {
  AddMemberBody,
  CreateAreaBody,
  CreateInteractionBody,
  CreateLeaseBody,
  CreatePropertyBody,
  CreateRentScheduleBody,
  CreateTenancyBody,
  CreateTenantBody,
  PutUnitDetailsBody,
} from '../../schemas/importable';
import {
  coerceAreaKind,
  coerceCurrency,
  coerceDate,
  coerceDecimal,
  coerceInt,
  coerceMoney,
  extractLeadingDate,
  firstIssue,
  todayIso,
} from './coercions';
import type {
  EntityCounts,
  ExecutionBlocker,
  ExecutionResult,
  ParentResolutions,
  RawImportRow,
} from './types';

// ----- the per-run execution context ----------------------------------------

// Sentinel for "this name matches MORE than one live row" in the prefetched
// lookup maps (Phase 2.3). Not a valid uuid, so it can never collide with a
// real id. Preserves the pre-batching `limit 2` ambiguity semantics exactly.
const AMBIGUOUS = '__ambiguous__';

export class ExecCtx {
  private byRegion = new Map<number, Map<EntityType, FieldMapping[]>>();
  private regionScope = new Map<number, Set<EntityType>>();

  private propertyCache = new Map<string, string>();
  private areaCache = new Map<string, string>();
  private tenantCache = new Map<string, string>();
  private tenancyCache = new Map<string, string>();
  private leaseCache = new Set<string>();
  private rentScheduleCache = new Set<string>();
  // Phase 2.3 prefetch: the account's LIVE rows snapshotted once per run
  // (inside the txn) so per-row existence SELECTs disappear. A value is an
  // id, or AMBIGUOUS when >1 live row shares the key. Rows the run itself
  // creates land in the per-run caches above, which are consulted first.
  private prefetchedProperties = new Map<string, string>(); // lower(name)
  private prefetchedAreas = new Map<string, string>(); // propertyId::kind::lower(name)
  private prefetchedTenants = new Map<string, string>(); // lower(full_name), first by created_at
  // Phase 2.3 provenance buffering: one unnest INSERT per 500 entities
  // instead of one INSERT per entity. runImport flushes after the row loop.
  private provenanceBuf: { et: EntityType; entityId: string; region: number; row: number }[] = [];
  // Memoizes whether a user-supplied parent id actually belongs to THIS
  // account. The service_role connection bypasses RLS, so this manual scoping
  // is the isolation guard (defense-in-depth ahead of the composite FK).
  private verifiedProperties = new Map<string, boolean>();
  private defaultPropertyCounted = false;

  private counts: Record<string, EntityCounts> = {};
  private createdIds: Record<string, string[]> = {};
  readonly blockers: ExecutionBlocker[] = [];
  private rowBlockers = new Map<
    string,
    { field: string | null; code: BlockerCode; message: string }[]
  >();
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
          fields
            .filter((f) => f.source_column || (f.constant != null && f.constant !== ''))
            .map((f) => f.target_field),
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

  private getValue(
    fields: FieldMapping[] | undefined,
    target: string,
    raw: Record<string, string>,
  ): string | null {
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

  /** Snapshot the account's live properties/areas/tenants into lookup maps.
   *  Runs inside the executor txn (service_role; manual account scoping is
   *  the isolation guard, same as every other query here). */
  async prefetch(): Promise<void> {
    const props = await this.client.query(
      `select id, lower(name) as k from properties where account_id = $1 and deleted_at is null`,
      [this.accountId],
    );
    for (const r of props.rows as { id: string; k: string }[]) {
      this.prefetchedProperties.set(r.k, this.prefetchedProperties.has(r.k) ? AMBIGUOUS : r.id);
    }
    const areas = await this.client.query(
      `select id, property_id, kind, lower(name) as k from areas where account_id = $1 and deleted_at is null`,
      [this.accountId],
    );
    for (const r of areas.rows as { id: string; property_id: string; kind: string; k: string }[]) {
      const key = `${r.property_id}::${r.kind}::${r.k}`;
      this.prefetchedAreas.set(key, this.prefetchedAreas.has(key) ? AMBIGUOUS : r.id);
    }
    // Tenants: the old per-row lookup took the FIRST match by created_at
    // (no ambiguity blocker for tenants) -- first-wins here reproduces it.
    const tenants = await this.client.query(
      `select id, lower(full_name) as k from tenants where account_id = $1 and deleted_at is null
        order by created_at asc`,
      [this.accountId],
    );
    for (const r of tenants.rows as { id: string; k: string }[]) {
      if (!this.prefetchedTenants.has(r.k)) this.prefetchedTenants.set(r.k, r.id);
    }
  }

  private async provenance(et: EntityType, entityId: string, row: RawImportRow): Promise<void> {
    this.provenanceBuf.push({ et, entityId, region: row.region_index, row: row.row_index });
    if (this.provenanceBuf.length >= 500) await this.flushProvenance();
  }

  /** Flush buffered provenance with one unnest INSERT. Must run after the
   *  row loop and BEFORE any savepoint rollback decision -- provenance is
   *  part of entity_writes and must roll back with them on preview. */
  async flushProvenance(): Promise<void> {
    if (this.provenanceBuf.length === 0) return;
    const buf = this.provenanceBuf;
    this.provenanceBuf = [];
    await this.client.query(
      `insert into import_provenance (account_id, session_id, entity_type, entity_id, region_index, row_index)
       select $1, $2, t.et, t.eid, t.ri, t.rj
         from unnest($3::text[], $4::uuid[], $5::int[], $6::int[]) as t(et, eid, ri, rj)`,
      [
        this.accountId,
        this.sessionId,
        buf.map((x) => x.et),
        buf.map((x) => x.entityId),
        buf.map((x) => x.region),
        buf.map((x) => x.row),
      ],
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

  private blockRow(
    row: RawImportRow,
    entity: EntityType,
    field: string | null,
    code: BlockerCode,
    message: string,
  ): void {
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

  private buildAddress(
    fields: FieldMapping[] | undefined,
    raw: Record<string, string>,
  ): Record<string, string> {
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
      this.blockRow(
        row,
        'property',
        'name',
        'parent_not_found',
        `default property not found in this account: ${id}`,
      );
      return null;
    }
    if (!this.defaultPropertyCounted) {
      this.recordReused('property');
      this.defaultPropertyCounted = true;
    }
    return id;
  }

  private async resolveProperty(
    row: RawImportRow,
    name: string,
    fields: FieldMapping[],
  ): Promise<string | null> {
    const key = name.toLowerCase();
    const cached = this.propertyCache.get(key);
    if (cached) return cached;

    const override = this.parents.property_overrides?.[name];
    if (override?.mode === 'existing' && override.id) {
      // bind_existing: the id MUST belong to this account (RLS is bypassed here).
      if (!(await this.verifyPropertyInAccount(override.id))) {
        this.blockRow(
          row,
          'property',
          'name',
          'parent_not_found',
          `bound property not found in this account: ${override.id}`,
        );
        return null;
      }
      this.propertyCache.set(key, override.id);
      this.recordReused('property');
      return override.id;
    }
    if (override?.mode !== 'create') {
      const pre = this.prefetchedProperties.get(key);
      if (pre === AMBIGUOUS) {
        this.blockRow(
          row,
          'property',
          'name',
          'ambiguous_match',
          `ambiguous property "${name}" (multiple matches); resolve via parents`,
        );
        return null;
      }
      if (pre) {
        this.propertyCache.set(key, pre);
        this.recordReused('property');
        return pre;
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

    const pre = this.prefetchedAreas.get(`${propertyId}::${kind}::${name.toLowerCase()}`);
    if (pre === AMBIGUOUS) {
      this.blockRow(
        row,
        'area',
        'name',
        'ambiguous_match',
        `ambiguous ${kind} "${name}" within its property`,
      );
      return null;
    }
    if (pre) {
      this.areaCache.set(key, pre);
      this.recordReused('area');
      return pre;
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

  private async maybeCreateUnitDetails(
    row: RawImportRow,
    areaId: string,
    fields: FieldMapping[],
  ): Promise<void> {
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
      [
        areaId,
        this.accountId,
        v.data.bedrooms ?? null,
        v.data.bathrooms ?? null,
        v.data.sqft ?? null,
      ],
    );
    if (ins.rowCount === 1) {
      this.recordCreated('unit_details', areaId);
      await this.provenance('unit_details', areaId, row);
    } else {
      this.recordReused('unit_details');
    }
  }

  private async resolveTenant(
    row: RawImportRow,
    name: string,
    fields: FieldMapping[],
  ): Promise<string | null> {
    const key = name.toLowerCase();
    const cached = this.tenantCache.get(key);
    if (cached) return cached;

    const pre = this.prefetchedTenants.get(key);
    if (pre) {
      this.tenantCache.set(key, pre);
      this.recordReused('tenant');
      return pre;
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
    // Per-account email uniqueness (migration 20260721000002). Pre-check via the
    // conflict oracle BEFORE the insert: the DB trigger would otherwise raise
    // 23505 on a tenant-holder collision and abort the whole import txn. This
    // runs in the executor's service_role txn (which has EXECUTE on the oracle;
    // the SECURITY DEFINER function reads auth.users for the account_user tier),
    // so it follows the existing raw-SQL query style — no admin-wrapper import.
    // Blocks BOTH classes (another tenant, or a landlord login email), naming the
    // holder; a blocked row is excluded, never thrown.
    if (v.data.emails && v.data.emails.length > 0) {
      // tenant holders first: when an address collides with BOTH a tenant and a
      // landlord login, the tenant holder is the actionable one to report.
      // DEGRADE OPEN on 42883 (function missing — code deployed before the prod
      // migration): skipping matches the pre-feature state, and the trigger that
      // would otherwise abort the whole import txn is equally absent then.
      let conflict: { rowCount: number | null; rows: unknown[] };
      try {
        conflict = await this.client.query(
          `select email, holder_kind, holder_name
             from public._tenant_email_conflicts($1, $2, null)
            order by (holder_kind = 'tenant') desc, email
            limit 1`,
          [this.accountId, v.data.emails],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '42883') {
          getLogger().warn(
            { account_id: this.accountId },
            '_tenant_email_conflicts missing (migration 20260721000002 not applied) — import skips the email conflict check',
          );
          conflict = { rowCount: 0, rows: [] };
        } else {
          throw err;
        }
      }
      if (conflict.rowCount && conflict.rowCount > 0) {
        const h = conflict.rows[0] as { email: string; holder_kind: string; holder_name: string };
        const who =
          h.holder_kind === 'account_user' ? `account user ${h.holder_name}` : h.holder_name;
        this.blockRow(
          row,
          'tenant',
          'emails',
          'duplicate_email',
          `email ${h.email} already belongs to ${who}`,
        );
        return null;
      }
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
    const v = CreateTenancyBody.safeParse({
      area_id: areaId,
      start_date: start,
      end_date: end ?? null,
      status,
    });
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
      this.blockRow(
        row,
        'rent_schedule',
        'amount',
        amountRaw ? 'unparseable_value' : 'missing_required_field',
        amountRaw ? `unparseable rent amount "${amountRaw}"` : 'missing rent amount',
      );
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
      [
        this.accountId,
        v.data.tenancy_id,
        v.data.kind,
        v.data.amount_cents,
        v.data.currency,
        v.data.due_day,
        v.data.start_date,
      ],
    );
    const id = ins.rows[0].id as string;
    this.rentScheduleCache.add(cacheKey);
    this.recordCreated('rent_schedule', id);
    await this.provenance('rent_schedule', id, row);
  }

  // -------- the per-row driver, in topological order ------------------------

  /** One imported note per non-empty cell: kind='note'. Import provenance
   *  lives in actor='system:import:<sessionId>' + the provenance row, not in
   *  the channel; channel='import' remains only on rows imported before
   *  kind existed. */
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
      kind: 'note',
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
         (account_id, actor, kind, party_type, channel, direction, body, occurred_at, area_id, tenancy_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [
        this.accountId,
        `system:import:${this.sessionId}`,
        v.data.kind,
        // The note sentinels the HTTP route fills server-side for
        // kind='note' (routes/interactions.ts) -- same stored shape either
        // path takes.
        'none',
        'note',
        'none',
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
      if (!name)
        this.blockRow(row, 'property', 'name', 'missing_required_field', 'missing property name');
      else propertyId = await this.resolveProperty(row, name, regionMap.get('property')!);
    }

    // area (unit or common space) + unit_details
    if (scope.has('area')) {
      if (!propertyId) {
        this.blockRow(
          row,
          'area',
          'name',
          'missing_parent_property',
          'area needs a property: map a property column or set a default property',
        );
      } else {
        const areaName = this.getValue(regionMap.get('area'), 'name', row.raw);
        if (!areaName)
          this.blockRow(row, 'area', 'name', 'missing_required_field', 'missing area label');
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
                if (hasDetails)
                  this.blockRow(
                    row,
                    'unit_details',
                    null,
                    'details_on_non_unit',
                    `unit details on a ${kind} area (units only)`,
                  );
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
        if (scope.has('tenancy_member'))
          this.blockRow(
            row,
            'tenant',
            'full_name',
            'missing_required_field',
            'missing tenant name',
          );
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
          this.blockRow(
            row,
            'tenancy',
            'start_date',
            startRaw ? 'unparseable_value' : 'missing_required_field',
            startRaw ? `unparseable start date "${startRaw}"` : 'missing tenancy start date',
          );
        } else {
          const endRaw = this.getValue(regionMap.get('tenancy'), 'end_date', row.raw);
          const end = endRaw ? coerceDate(endRaw) : null;
          this.recordDate('tenancy.end_date', endRaw, end);
          if (endRaw && !end) {
            this.blockRow(
              row,
              'tenancy',
              'end_date',
              'unparseable_value',
              `unparseable end date "${endRaw}"`,
            );
          } else if (end && end < start) {
            this.blockRow(row, 'tenancy', 'end_date', 'date_order', 'end date precedes start date');
          } else {
            tenancyId = await this.resolveTenancy(row, areaId, start, end);
            if (tenancyId) {
              if (scope.has('tenancy_member') && tenantId) {
                await this.maybeCreateMember(
                  row,
                  tenancyId,
                  tenantId,
                  regionMap.get('tenancy_member'),
                );
              }
              if (scope.has('lease')) {
                await this.maybeCreateLease(row, tenancyId, start, end, regionMap.get('lease')!);
              }
              if (scope.has('rent_schedule')) {
                await this.maybeCreateRentSchedule(
                  row,
                  tenancyId,
                  start,
                  regionMap.get('rent_schedule')!,
                );
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

  buildResult(opts: {
    dryRun: boolean;
    rowsTotal: number;
    rowsExcluded: number;
    rowsActive: number;
  }): ExecutionResult {
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
   *  the savepoint rollback so it survives into the COMMIT. One unnest UPDATE
   *  for all blocked rows (Phase 2.3) instead of one UPDATE per row. */
  async persistRowBlockers(): Promise<void> {
    await this.client.query(
      `update import_rows set blockers = '[]'::jsonb, updated_at = now()
         where session_id = $1 and account_id = $2 and blockers <> '[]'::jsonb`,
      [this.sessionId, this.accountId],
    );
    if (this.rowBlockers.size === 0) return;
    const ids: string[] = [];
    const lists: string[] = [];
    for (const [rowId, list] of this.rowBlockers) {
      ids.push(rowId);
      lists.push(JSON.stringify(list));
    }
    await this.client.query(
      `update import_rows r
          set blockers = v.b::jsonb, updated_at = now()
         from unnest($1::uuid[], $2::text[]) as v(id, b)
        where r.id = v.id and r.session_id = $3`,
      [ids, lists, this.sessionId],
    );
  }
}
