// ----------------------------------------------------------------------------
// Entity-search API test (GET /v1/accounts/{accountId}/search).
//
// Runs against the FULL local Supabase stack (same harness as
// api-isolation.test.ts): real GoTrue tokens + real PostgREST RLS, so the
// SECURITY INVOKER search_entities() RPC is exercised under genuine per-account
// row-level security -- which is the whole isolation guarantee for this feature.
//
// Proves:
//   1. A landlord searching their own account gets ranked matches across types.
//   2. CROSS-ACCOUNT ISOLATION: account B can never see account A's rows via
//      search (the agent's "which jon?" is bounded to the granted account).
//   3. narrow (?types=) and exclude (?exclude=) behave.
//   4. Multi-type results come back in one ranked list.
//   5. Validation: unknown entity type -> 400; q shorter than 2 chars -> 400.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';

interface SupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function readSupabaseStatus(): SupabaseStatus {
  const out = execSync('supabase status --output env --workdir db', {
    cwd: process.cwd().endsWith('/api') ? '..' : '.',
    encoding: 'utf8',
  });
  const lines = out.split('\n');
  const get = (k: string) => {
    const line = lines.find((l) => l.startsWith(k + '='));
    if (!line) throw new Error(`supabase status missing key: ${k}`);
    return line.slice(k.length + 1).replace(/^"|"$/g, '');
  };
  return {
    API_URL: get('API_URL'),
    ANON_KEY: get('ANON_KEY'),
    SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY'),
  };
}

const status = readSupabaseStatus();

process.env.NODE_ENV = 'test';
process.env.PORT = '8787';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { buildApp } = await import('../src/app');

const app = buildApp();

interface ApiCall {
  status: number;
  body: unknown;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiCall> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function rnd(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Tagged union (context.kind ∈ 'tenant' | 'area' | ...); loosely typed here so
// one shape covers every arm without re-deriving the discriminated union.
interface SearchContext {
  kind?: string;
  // tenant arm
  unit_name?: string | null;
  tenancy_id?: string | null;
  tenancy_status?: string | null;
  // area arm
  property_id?: string | null;
  area_id?: string | null;
  area_kind?: string | null;
  active_tenancy_id?: string | null;
  tenant_names?: string[];
  occupancy_status?: string | null;
  // tenant adds
  is_primary?: boolean;
  other_tenancies?: Array<{
    tenancy_id: string;
    unit_name: string | null;
    property_name: string | null;
    tenancy_status: string;
    is_primary: boolean;
  }>;
  // property arm
  unit_count?: number;
  // vendor arm
  contact?: string | null;
  last_used_at?: string | null;
  job_count?: number;
  // maintenance_request arm
  status?: string;
  severity?: string;
  created_at?: string;
  assigned_vendor_id?: string | null;
  // shared
  property_name?: string | null;
  address?: string | null;
}

interface SearchHit {
  entity_type: string;
  entity_id: string;
  title: string;
  subtitle: string | null;
  score: number;
  context: SearchContext | null;
}

interface Account {
  token: string;
  accountId: string;
  nonce: string;
  propertyId: string;
}

async function setup(label: string): Promise<Account> {
  const email = `search-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const s = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Search ${label}` },
  });
  if (s.status !== 200) throw new Error(`signup ${label}: ${s.status} ${JSON.stringify(s.body)}`);
  const b = s.body as { account: { id: string }; session: { access_token: string } };
  const token = b.session.access_token;
  const accountId = b.account.id;

  // A per-run nonce shared across this account's tenant/vendor/property so a
  // search for the nonce returns one hit of each type -- and so account A's
  // nonce is structurally absent from account B (isolation probe).
  const nonce = `zq${rnd()}`;
  const post = async (path: string, body: unknown): Promise<{ id: string }> => {
    const r = await api('POST', `/v1/accounts/${accountId}/${path}`, { token, body });
    if (r.status !== 201) throw new Error(`${label} POST ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { id: string };
  };
  // Build a tenant WITH a current unit + tenancy so the structured `context`
  // enrichment resolves: property -> unit (area) -> tenancy(active) -> member.
  const property = await post('properties', { name: `Property ${nonce}` });
  const unit = await post('areas', { property_id: property.id, kind: 'unit', name: `Unit ${nonce}` });
  const tenant = await post('tenants', { full_name: `Tenant ${nonce}`, emails: [`${nonce}@mail.test`] });
  const tenancy = await post('tenancies', { area_id: unit.id, start_date: '2026-01-01', status: 'active' });
  await post(`tenancies/${tenancy.id}/members`, { tenant_id: tenant.id, role: 'primary' });
  await post('vendors', { name: `Vendor ${nonce}`, contact: { email: `vendor-${nonce}@mail.test` } });
  // Second unit + an earlier tenancy for the SAME tenant -> the resolved/current
  // tenancy is the 2026 one on `unit`, and this one lands in other_tenancies.
  const unit2 = await post('areas', { property_id: property.id, kind: 'unit', name: `Unit2 ${nonce}` });
  const tenancy2 = await post('tenancies', { area_id: unit2.id, start_date: '2025-01-01', status: 'active' });
  await post(`tenancies/${tenancy2.id}/members`, { tenant_id: tenant.id, role: 'occupant' });
  // A maintenance request on the primary unit -> maintenance_request context.
  await post('maintenance-requests', { area_id: unit.id, title: `Leak ${nonce}`, severity: 'routine' });
  return { token, accountId, nonce, propertyId: property.id };
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.info(`  PASS  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function searchHits(
  account: Account,
  q: string,
  extra = '',
): Promise<{ status: number; hits: SearchHit[]; body: unknown }> {
  const r = await api(
    'GET',
    `/v1/accounts/${account.accountId}/search?q=${encodeURIComponent(q)}${extra}`,
    { token: account.token },
  );
  const hits = (r.body as { data?: SearchHit[] })?.data ?? [];
  return { status: r.status, hits, body: r.body };
}

async function main(): Promise<void> {
  console.info('Entity-search API test');
  const A = await setup('A');
  const B = await setup('B');

  await check('A finds own entities across types (multi-type ranked)', async () => {
    const { status: st, hits, body } = await searchHits(A, A.nonce);
    if (st !== 200) throw new Error(`expected 200, got ${st}: ${JSON.stringify(body)}`);
    const types = new Set(hits.map((h) => h.entity_type));
    for (const want of ['tenant', 'vendor', 'property']) {
      if (!types.has(want)) throw new Error(`missing ${want} in ${JSON.stringify(hits.map((h) => h.entity_type))}`);
    }
    if (!hits.every((h) => typeof h.score === 'number')) throw new Error('hit missing numeric score');
  });

  await check('CROSS-ACCOUNT: B cannot see A nonce; A cannot see B nonce', async () => {
    const bSeesA = await searchHits(B, A.nonce);
    if (bSeesA.hits.length !== 0) {
      throw new Error(`LEAK: B saw A's rows for "${A.nonce}": ${JSON.stringify(bSeesA.hits)}`);
    }
    const aSeesB = await searchHits(A, B.nonce);
    if (aSeesB.hits.length !== 0) {
      throw new Error(`LEAK: A saw B's rows for "${B.nonce}": ${JSON.stringify(aSeesB.hits)}`);
    }
    // ...but each DOES see its own.
    const aSeesA = await searchHits(A, A.nonce);
    if (aSeesA.hits.length === 0) throw new Error(`A should see its own "${A.nonce}"`);
  });

  await check('narrow ?types=tenant returns only tenants', async () => {
    const { hits } = await searchHits(A, A.nonce, '&types=tenant');
    if (hits.length === 0) throw new Error('expected at least the tenant hit');
    if (!hits.every((h) => h.entity_type === 'tenant')) {
      throw new Error(`non-tenant leaked: ${JSON.stringify(hits.map((h) => h.entity_type))}`);
    }
  });

  await check('exclude ?exclude=tenant omits tenants', async () => {
    const { hits } = await searchHits(A, A.nonce, '&exclude=tenant');
    if (hits.length === 0) throw new Error('expected vendor + property hits');
    if (hits.some((h) => h.entity_type === 'tenant')) {
      throw new Error(`tenant not excluded: ${JSON.stringify(hits.map((h) => h.entity_type))}`);
    }
  });

  await check('email-fragment search matches the tenant', async () => {
    const { hits } = await searchHits(A, A.nonce, '&types=tenant');
    const t = hits.find((h) => h.entity_type === 'tenant');
    if (!t) throw new Error('no tenant hit to check subtitle');
    if (!t.subtitle || !t.subtitle.includes(A.nonce)) {
      throw new Error(`tenant subtitle should carry email; got ${JSON.stringify(t.subtitle)}`);
    }
  });

  await check('tenant result carries STRUCTURED unit/property context', async () => {
    const { hits } = await searchHits(A, A.nonce, '&types=tenant');
    const t = hits.find((h) => h.entity_type === 'tenant');
    if (!t) throw new Error('no tenant hit');
    if (!t.context) throw new Error(`tenant context missing: ${JSON.stringify(t)}`);
    if (t.context.kind !== 'tenant') throw new Error(`expected context.kind=tenant, got ${t.context.kind}`);
    if (t.context.unit_name !== `Unit ${A.nonce}`) {
      throw new Error(`unit_name=${t.context.unit_name}`);
    }
    if (t.context.property_name !== `Property ${A.nonce}`) {
      throw new Error(`property_name=${t.context.property_name}`);
    }
    if (t.context.tenancy_status !== 'active') {
      throw new Error(`tenancy_status=${t.context.tenancy_status}`);
    }
    if (!t.context.area_id || !t.context.tenancy_id) {
      throw new Error(`missing ids in context: ${JSON.stringify(t.context)}`);
    }
    // PR2 adds: the resolved tenancy is the 2026 primary one; the 2025 occupant
    // tenancy on Unit2 lands in other_tenancies.
    if (t.context.is_primary !== true) throw new Error(`expected is_primary=true, got ${t.context.is_primary}`);
    const others = t.context.other_tenancies;
    if (!Array.isArray(others) || others.length < 1) {
      throw new Error(`other_tenancies should list the second tenancy: ${JSON.stringify(others)}`);
    }
    const u2 = others.find((o) => o.unit_name === `Unit2 ${A.nonce}`);
    if (!u2) throw new Error(`other_tenancies missing Unit2: ${JSON.stringify(others)}`);
    if (u2.is_primary !== false) throw new Error(`Unit2 membership should be non-primary, got ${u2.is_primary}`);
  });

  await check('property result carries STRUCTURED PropertyContext (address + unit_count)', async () => {
    const { hits } = await searchHits(A, A.nonce, '&types=property');
    const p = hits.find((h) => h.entity_type === 'property');
    if (!p || !p.context) throw new Error(`property context missing: ${JSON.stringify(hits)}`);
    if (p.context.kind !== 'property') throw new Error(`expected kind=property, got ${p.context.kind}`);
    if (p.context.unit_count !== 2) throw new Error(`expected unit_count=2 (Unit + Unit2), got ${p.context.unit_count}`);
  });

  await check('maintenance_request result carries STRUCTURED MR context', async () => {
    const { hits } = await searchHits(A, A.nonce, '&types=maintenance_request');
    const mr = hits.find((h) => h.entity_type === 'maintenance_request');
    if (!mr || !mr.context) throw new Error(`MR context missing: ${JSON.stringify(hits)}`);
    const c = mr.context;
    if (c.kind !== 'maintenance_request') throw new Error(`expected kind=maintenance_request, got ${c.kind}`);
    if (c.severity !== 'routine') throw new Error(`severity=${c.severity}`);
    if (c.unit_name !== `Unit ${A.nonce}`) throw new Error(`unit_name=${c.unit_name}`);
    if (c.property_name !== `Property ${A.nonce}`) throw new Error(`property_name=${c.property_name}`);
    if (!c.area_id) throw new Error('area_id should be set');
    if (typeof c.status !== 'string' || !c.status) throw new Error(`status should be set, got ${c.status}`);
    if (c.assigned_vendor_id != null) throw new Error(`assigned_vendor_id should be null (no work order), got ${c.assigned_vendor_id}`);
    if (!c.tenancy_id) throw new Error('derived tenancy_id (the unit’s active tenancy) should be set');
  });

  await check('area result carries STRUCTURED AreaContext (property + occupancy + handoff)', async () => {
    // The setup puts an active tenancy with member "Tenant <nonce>" on the unit
    // "Unit <nonce>" under "Property <nonce>" -- so the area context should be
    // occupied, name the property, expose area_kind, and carry the relational
    // active_tenancy_id + occupant names (the "tenant of this unit" handoff).
    const { hits } = await searchHits(A, A.nonce, '&types=area');
    const area = hits.find((h) => h.entity_type === 'area' && h.title === `Unit ${A.nonce}`);
    if (!area || !area.context) throw new Error(`area context missing: ${JSON.stringify(hits)}`);
    const c = area.context;
    if (c.kind !== 'area') throw new Error(`expected context.kind=area, got ${c.kind}`);
    if (c.property_name !== `Property ${A.nonce}`) throw new Error(`property_name=${c.property_name}`);
    if (!c.property_id) throw new Error('property_id should be set');
    if (c.area_kind !== 'unit') throw new Error(`area_kind=${c.area_kind}`);
    if (c.occupancy_status !== 'occupied') throw new Error(`occupancy_status=${c.occupancy_status}`);
    if (!c.active_tenancy_id) throw new Error('active_tenancy_id should be set for an occupied unit');
    if (!Array.isArray(c.tenant_names) || !c.tenant_names.includes(`Tenant ${A.nonce}`)) {
      throw new Error(`tenant_names should include the occupant: ${JSON.stringify(c.tenant_names)}`);
    }
  });

  await check('vendor result carries STRUCTURED VendorContext', async () => {
    const { hits } = await searchHits(A, A.nonce, '&types=vendor');
    const vendor = hits.find((h) => h.entity_type === 'vendor');
    if (!vendor || !vendor.context) throw new Error(`vendor context missing: ${JSON.stringify(hits)}`);
    const c = vendor.context;
    if (c.kind !== 'vendor') throw new Error(`expected kind=vendor, got ${c.kind}`);
    if (c.contact !== `vendor-${A.nonce}@mail.test`) throw new Error(`contact=${c.contact}`);
    if (c.job_count !== 0) throw new Error(`expected job_count=0 (no work orders), got ${c.job_count}`);
    if (c.last_used_at != null) throw new Error(`expected last_used_at=null, got ${c.last_used_at}`);
  });

  await check('synonym: "apt <nonce>" matches the "Unit <nonce>" area', async () => {
    // The setup names the unit area "Unit <nonce>"; searching the synonym
    // "apt <nonce>" must find it (apt -> unit normalization), end-to-end.
    const { hits } = await searchHits(A, `apt ${A.nonce}`, '&types=area');
    const area = hits.find((h) => h.entity_type === 'area');
    if (!area) throw new Error(`"apt ${A.nonce}" did not match the unit area: ${JSON.stringify(hits)}`);
    if (area.title !== `Unit ${A.nonce}`) throw new Error(`unexpected area title: ${area.title}`);
  });

  await check('validation: unknown type -> 400 invalid_request', async () => {
    const r = await api('GET', `/v1/accounts/${A.accountId}/search?q=${A.nonce}&types=banana`, {
      token: A.token,
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    if ((r.body as { error?: { code?: string } }).error?.code !== 'invalid_request') {
      throw new Error(`expected invalid_request, got ${JSON.stringify(r.body)}`);
    }
  });

  await check('validation: q shorter than 2 chars -> 400', async () => {
    const r = await api('GET', `/v1/accounts/${A.accountId}/search?q=a`, { token: A.token });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await check('unauthenticated -> 401', async () => {
    const r = await api('GET', `/v1/accounts/${A.accountId}/search?q=${A.nonce}`);
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.info('\nOK: entity-search API checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
