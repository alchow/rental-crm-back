// ----------------------------------------------------------------------------
// Phase 5 + 5b API-level cross-tenant isolation test.
//
// Runs against the FULL local Supabase stack (Postgres + GoTrue + PostgREST +
// Storage + Realtime) brought up via `supabase start`. The point of running
// against the real stack here -- not against ephemeral postgres with hand-
// minted JWTs -- is that test-vs-prod drift on the auth path is exactly where
// a cross-tenant leak would hide. Real GoTrue token issuance + real PostgREST
// claim handling means we are checking the actual code that ships.
//
// Setup:
//   - `supabase start` brings up the stack and auto-applies the migrations.
//   - We sign up two users via the API's own /v1/auth/signup (the signup RPC
//     atomically creates the public.users mirror + accounts row + owner
//     account_members row).
//   - For each user we then create the dependency chain: property -> unit
//     area + common area -> tenant -> tenancy, plus a vendor. These give us
//     real account-owned rows to assert against per resource.
//
// Assertions, for each account-scoped resource:
//
//   1. As A's token, GET on A's URL                              -> 200
//   2. A's create works on A's URL                                -> 201
//   3. As A's token, GET /v1/accounts/<B>/<resource>             -> 404
//   4. As A's token, GET /v1/accounts/<B>/<resource>/<B-row>     -> 404
//   5. As A's token, PATCH /v1/accounts/<B>/<resource>/<B-row>   -> 404
//   6. As A's token, DELETE /v1/accounts/<B>/<resource>/<B-row>  -> 404
//
// Note: there is no X-Account-Id header. The URL path is the ONLY source of
// account scope. We do not test header-based attack vectors because there is
// no code path that reads them -- a future "test" that the inert header is
// inert proves nothing. The leak surface is the path.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';

interface SupabaseStatus {
  API_URL: string;
  DB_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function readSupabaseStatus(): SupabaseStatus {
  const out = execSync(
    'supabase status --output env --workdir db',
    {
      cwd: process.cwd().endsWith('/api') ? '..' : '.',
      encoding: 'utf8',
    },
  );
  const lines = out.split('\n');
  const get = (k: string) => {
    const line = lines.find((l) => l.startsWith(k + '='));
    if (!line) throw new Error(`supabase status missing key: ${k}`);
    return line.slice(k.length + 1).replace(/^"|"$/g, '');
  };
  return {
    API_URL: get('API_URL'),
    DB_URL: get('DB_URL'),
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

// --- helpers -----------------------------------------------------------------
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
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { status: res.status, body };
}

function rnd(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface SignupResult {
  userId: string;
  email: string;
  accessToken: string;
  accountId: string;
}

async function signup(label: string): Promise<SignupResult> {
  const email = `iso-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const r = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Account ${label}` },
  });
  if (r.status !== 200) {
    throw new Error(`signup ${label} failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const b = r.body as {
    user: { id: string; email: string };
    account: { id: string };
    session: { access_token: string };
  };
  return {
    userId: b.user.id,
    email: b.user.email,
    accessToken: b.session.access_token,
    accountId: b.account.id,
  };
}

// Dependency chain per user. Each user gets a property + a unit area + a
// common area + a tenant + a tenancy + a vendor. The resource-specific
// CRUD assertions then use these to construct create-bodies that reference
// real, account-owned rows.
interface UserFixture extends SignupResult {
  propertyId: string;
  unitAreaId: string;
  commonAreaId: string;
  tenantId: string;
  tenancyId: string;
  vendorId: string;
  assetId: string;
  leaseId: string;
  memberId: string;
}

async function expectStatus(
  ctx: string,
  r: ApiCall,
  expected: number,
): Promise<unknown> {
  if (r.status !== expected) {
    throw new Error(
      `${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`,
    );
  }
  return r.body;
}

async function setupFixture(label: string): Promise<UserFixture> {
  const u = await signup(label);
  const t = u.accessToken;
  const ac = u.accountId;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const r = await api('POST', path, { token: t, body });
    if (r.status !== 201) {
      throw new Error(
        `setup ${label} POST ${path} failed: ${r.status} ${JSON.stringify(r.body)}`,
      );
    }
    return r.body as T;
  };

  const property = await post<{ id: string }>(
    `/v1/accounts/${ac}/properties`,
    { name: `${label} prop ${rnd()}` },
  );
  const unitArea = await post<{ id: string }>(
    `/v1/accounts/${ac}/areas`,
    { property_id: property.id, kind: 'unit', name: `${label} unit ${rnd()}` },
  );
  const commonArea = await post<{ id: string }>(
    `/v1/accounts/${ac}/areas`,
    { property_id: property.id, kind: 'hallway', name: `${label} hallway ${rnd()}` },
  );
  const tenant = await post<{ id: string }>(
    `/v1/accounts/${ac}/tenants`,
    { full_name: `${label} renter ${rnd()}` },
  );
  const tenancy = await post<{ id: string }>(
    `/v1/accounts/${ac}/tenancies`,
    { area_id: unitArea.id, start_date: '2026-01-01', status: 'active' },
  );
  const vendor = await post<{ id: string }>(
    `/v1/accounts/${ac}/vendors`,
    { name: `${label} vendor ${rnd()}` },
  );
  const asset = await post<{ id: string }>(
    `/v1/accounts/${ac}/assets`,
    { area_id: unitArea.id, name: `${label} heater ${rnd()}`, kind: 'water_heater' },
  );
  const lease = await post<{ id: string }>(
    `/v1/accounts/${ac}/leases`,
    {
      tenancy_id: tenancy.id,
      term_start: '2026-01-01',
      term_end: '2026-12-31',
      rent_amount_cents: 120000,
      rent_currency: 'USD',
      deposit_amount_cents: 120000,
      deposit_currency: 'USD',
      status: 'active',
    },
  );
  const member = await post<{ id: string }>(
    `/v1/accounts/${ac}/tenancies/${tenancy.id}/members`,
    { tenant_id: tenant.id, role: 'primary' },
  );

  return {
    ...u,
    propertyId: property.id,
    unitAreaId: unitArea.id,
    commonAreaId: commonArea.id,
    tenantId: tenant.id,
    tenancyId: tenancy.id,
    vendorId: vendor.id,
    assetId: asset.id,
    leaseId: lease.id,
    memberId: member.id,
  };
}

// --- per-resource isolation matrix -------------------------------------------
interface TopLevelResource {
  name: string;
  // The id on each user's fixture (e.g. 'propertyId').
  fixtureKey: keyof UserFixture;
  // PATCH body that should succeed against a row the caller doesn't own.
  // Used only for the cross-tenant PATCH attack -- it never gets applied.
  patchBody: Record<string, unknown>;
}

const topLevelResources: TopLevelResource[] = [
  { name: 'properties', fixtureKey: 'propertyId', patchBody: { name: 'evil' } },
  { name: 'vendors',    fixtureKey: 'vendorId',   patchBody: { name: 'evil' } },
  { name: 'tenants',    fixtureKey: 'tenantId',   patchBody: { full_name: 'evil' } },
  { name: 'areas',      fixtureKey: 'unitAreaId', patchBody: { name: 'evil' } },
  { name: 'tenancies',  fixtureKey: 'tenancyId',  patchBody: { status: 'ended' } },
  { name: 'leases',     fixtureKey: 'leaseId',    patchBody: { status: 'expired' } },
  { name: 'assets',     fixtureKey: 'assetId',    patchBody: { name: 'evil' } },
];

// --- runner ------------------------------------------------------------------
interface Failure {
  name: string;
  detail: string;
}
const failures: Failure[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.info(`  PASS  ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

async function main(): Promise<void> {
  console.info('Phase 5 + 5b API-level cross-tenant isolation');
  console.info(`  supabase API at ${status.API_URL}`);

  const A = await setupFixture('A');
  const B = await setupFixture('B');
  console.info(`  user A: ${A.userId} / account ${A.accountId}`);
  console.info(`  user B: ${B.userId} / account ${B.accountId}`);

  // -----------------------------------------------------------------------
  // Top-level resources: every URL path /v1/accounts/{accountId}/{resource}
  // -----------------------------------------------------------------------
  for (const r of topLevelResources) {
    const bId = B[r.fixtureKey] as string;
    const aId = A[r.fixtureKey] as string;
    const ownList    = `/v1/accounts/${A.accountId}/${r.name}`;
    const otherList  = `/v1/accounts/${B.accountId}/${r.name}`;
    const otherIdUrl = `/v1/accounts/${B.accountId}/${r.name}/${bId}`;

    await check(`${r.name}: A lists own account -> 200`, async () => {
      const res = await api('GET', ownList, { token: A.accessToken });
      await expectStatus('GET own list', res, 200);
    });

    await check(`${r.name}: A gets own row -> 200`, async () => {
      const res = await api(
        'GET',
        `/v1/accounts/${A.accountId}/${r.name}/${aId}`,
        { token: A.accessToken },
      );
      const body = (await expectStatus('GET own id', res, 200)) as { id: string; account_id: string };
      if (body.id !== aId) throw new Error(`wrong id: ${body.id}`);
      if (body.account_id !== A.accountId) throw new Error(`wrong account: ${body.account_id}`);
    });

    await check(`${r.name}: A listing B's account URL -> 404`, async () => {
      const res = await api('GET', otherList, { token: A.accessToken });
      await expectStatus('GET B list', res, 404);
    });

    await check(`${r.name}: A GET B's row by id -> 404`, async () => {
      const res = await api('GET', otherIdUrl, { token: A.accessToken });
      await expectStatus('GET B id', res, 404);
    });

    await check(`${r.name}: A PATCH B's row -> 404`, async () => {
      const res = await api('PATCH', otherIdUrl, {
        token: A.accessToken,
        body: r.patchBody,
      });
      await expectStatus('PATCH B id', res, 404);
    });

    await check(`${r.name}: A DELETE B's row -> 404`, async () => {
      const res = await api('DELETE', otherIdUrl, { token: A.accessToken });
      await expectStatus('DELETE B id', res, 404);
    });
  }

  // -----------------------------------------------------------------------
  // tenancy_members sub-resource:
  //   /v1/accounts/{accountId}/tenancies/{tenancyId}/members[/{id}]
  // Path has TWO scoping params -- accountId AND tenancyId. The attack
  // surface includes a cross-tenancy URL even within the right account.
  // -----------------------------------------------------------------------
  const mAOwnList = `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/members`;
  // Path with A's accountId but B's tenancyId. Resolver passes (A is in A);
  // RLS scopes to A's tenancies; query for tenancy_id=<B's> returns nothing.
  const mACrossList = `/v1/accounts/${A.accountId}/tenancies/${B.tenancyId}/members`;
  // Path with B's accountId entirely.
  const mBList = `/v1/accounts/${B.accountId}/tenancies/${B.tenancyId}/members`;
  const mBMemberUrl = `/v1/accounts/${B.accountId}/tenancies/${B.tenancyId}/members/${B.memberId}`;

  await check('tenancy-members: A lists own tenancy -> 200', async () => {
    const res = await api('GET', mAOwnList, { token: A.accessToken });
    const body = (await expectStatus('GET own members', res, 200)) as { data: unknown[] };
    if (!Array.isArray(body.data) || body.data.length < 1) {
      throw new Error(`expected at least one member in own tenancy; got ${JSON.stringify(body)}`);
    }
  });

  await check(
    "tenancy-members: A with A's accountId but B's tenancyId -> 200 with empty data",
    async () => {
      const res = await api('GET', mACrossList, { token: A.accessToken });
      // Path is well-formed for the resolver (A IS in account A). The
      // tenancy_id refers to B's tenancy; under RLS it's invisible, so the
      // list returns 200 with empty data. Crucially, NO member rows are
      // leaked.
      const body = (await expectStatus('GET cross-tenancy members', res, 200)) as {
        data: unknown[];
      };
      if (body.data.length !== 0) {
        throw new Error(`leak: got ${body.data.length} cross-tenancy members`);
      }
    },
  );

  await check("tenancy-members: A listing B's full account URL -> 404", async () => {
    const res = await api('GET', mBList, { token: A.accessToken });
    await expectStatus('GET B members list', res, 404);
  });

  await check("tenancy-members: A GET B's member by id -> 404", async () => {
    const res = await api('GET', mBMemberUrl, { token: A.accessToken });
    await expectStatus('GET B member by id', res, 404);
  });

  await check("tenancy-members: A PATCH B's member -> 404", async () => {
    const res = await api('PATCH', mBMemberUrl, {
      token: A.accessToken,
      body: { role: 'guarantor' },
    });
    await expectStatus('PATCH B member', res, 404);
  });

  await check("tenancy-members: A DELETE B's member -> 404", async () => {
    const res = await api('DELETE', mBMemberUrl, { token: A.accessToken });
    await expectStatus('DELETE B member', res, 404);
  });

  // -----------------------------------------------------------------------
  // unit_details sub-resource:
  //   /v1/accounts/{accountId}/areas/{areaId}/unit-details
  // -----------------------------------------------------------------------
  await check('unit_details: A can PUT own unit', async () => {
    const res = await api(
      'PUT',
      `/v1/accounts/${A.accountId}/areas/${A.unitAreaId}/unit-details`,
      { token: A.accessToken, body: { bedrooms: 2, bathrooms: 1.5, sqft: 720 } },
    );
    await expectStatus('PUT own unit_details', res, 200);
  });

  await check('unit_details: A can GET own unit', async () => {
    const res = await api(
      'GET',
      `/v1/accounts/${A.accountId}/areas/${A.unitAreaId}/unit-details`,
      { token: A.accessToken },
    );
    const body = (await expectStatus('GET own unit_details', res, 200)) as {
      account_id: string;
      bedrooms: number | null;
    };
    if (body.account_id !== A.accountId) throw new Error(`wrong account`);
    if (body.bedrooms !== 2) throw new Error(`PUT did not persist`);
  });

  await check(
    'unit_details: A cannot GET via B-area URL (cross-account) -> 404',
    async () => {
      const res = await api(
        'GET',
        `/v1/accounts/${B.accountId}/areas/${B.unitAreaId}/unit-details`,
        { token: A.accessToken },
      );
      await expectStatus('GET B unit_details (cross-account URL)', res, 404);
    },
  );

  await check(
    "unit_details: A cannot PUT via B-area URL (cross-account) -> 404",
    async () => {
      const res = await api(
        'PUT',
        `/v1/accounts/${B.accountId}/areas/${B.unitAreaId}/unit-details`,
        { token: A.accessToken, body: { bedrooms: 99 } },
      );
      await expectStatus('PUT B unit_details (cross-account URL)', res, 404);
    },
  );

  // -----------------------------------------------------------------------
  // Negative: posting an area into B's account via A's URL with B's
  // property_id must be rejected. (Composite FK refuses; resolver also
  // refuses to let A reach B's URL.)
  // -----------------------------------------------------------------------
  await check(
    "areas: A POST with B's property_id under A's URL -> 404",
    async () => {
      const res = await api('POST', `/v1/accounts/${A.accountId}/areas`, {
        token: A.accessToken,
        body: { property_id: B.propertyId, kind: 'unit', name: 'evil' },
      });
      await expectStatus('POST cross-account property_id', res, 404);
    },
  );

  await check(
    "tenancies: A POST with B's area_id under A's URL -> 404",
    async () => {
      const res = await api('POST', `/v1/accounts/${A.accountId}/tenancies`, {
        token: A.accessToken,
        body: { area_id: B.unitAreaId, start_date: '2026-01-01', status: 'active' },
      });
      await expectStatus('POST cross-account area_id', res, 404);
    },
  );

  await check(
    "leases: A POST with B's tenancy_id under A's URL -> 404",
    async () => {
      const res = await api('POST', `/v1/accounts/${A.accountId}/leases`, {
        token: A.accessToken,
        body: {
          tenancy_id: B.tenancyId,
          term_start: '2026-01-01',
          rent_amount_cents: 100000,
          rent_currency: 'USD',
          status: 'active',
        },
      });
      await expectStatus('POST cross-account tenancy_id', res, 404);
    },
  );

  // -----------------------------------------------------------------------
  // /v1/me sanity
  // -----------------------------------------------------------------------
  await check('/v1/me as A returns only A account', async () => {
    const res = await api('GET', '/v1/me', { token: A.accessToken });
    const body = (await expectStatus('GET /v1/me', res, 200)) as {
      user_id: string;
      accounts: Array<{ account_id: string }>;
    };
    if (body.user_id !== A.userId) throw new Error(`wrong user_id`);
    const ids = body.accounts.map((m) => m.account_id);
    if (!ids.includes(A.accountId)) throw new Error(`A's own account missing`);
    if (ids.includes(B.accountId)) throw new Error(`B's account leaked into A's /v1/me`);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} isolation failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: API-level cross-tenant isolation checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
