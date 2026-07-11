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
  headers: Headers;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiCall> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  // Phase 6 middleware requires Idempotency-Key on all mutating requests
  // under /v1/accounts/*. Generate a unique one per call by default;
  // tests that explicitly want to exercise replay-or-conflict pass their
  // own.
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = opts.idempotencyKey ?? `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { status: res.status, body, headers: res.headers };
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

// Dependency chain per user. Each user gets the full row-graph the tier-1
// resources reference so the cross-tenant assertions have real account-
// owned rows to point at. Phase 6 adds the money rows (rent_schedule,
// charge, payment).
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
  rentScheduleId: string;
  chargeId: string;
  paymentId: string;
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

  // Phase 6 money rows.
  const rentSchedule = await post<{ id: string }>(
    `/v1/accounts/${ac}/rent-schedules`,
    {
      tenancy_id: tenancy.id,
      kind: 'rent',
      amount_cents: 120000,
      currency: 'USD',
      due_day: 1,
      start_date: '2026-01-01',
    },
  );
  const charge = await post<{ id: string }>(
    `/v1/accounts/${ac}/charges`,
    {
      tenancy_id: tenancy.id,
      type: 'rent',
      amount_cents: 120000,
      currency: 'USD',
      due_date: '2026-02-01',
    },
  );
  const payment = await post<{ payment: { id: string } }>(
    `/v1/accounts/${ac}/payments`,
    {
      tenancy_id: tenancy.id,
      amount_cents: 70000,
      currency: 'USD',
      received_at: '2026-02-03T12:00:00Z',
      method: 'check',
    },
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
    rentScheduleId: rentSchedule.id,
    chargeId: charge.id,
    paymentId: payment.payment.id,
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
// Money resources don't have a PATCH endpoint (the brief: reversal-not-
// mutation -- corrections are voids + new rows, not edits). So the
// cross-tenant matrix is reduced: list / get / void-attempt where applicable.
interface MoneyResource {
  name: 'rent-schedules' | 'charges' | 'payments';
  fixtureKey: keyof UserFixture;
  voidPath?: (accountId: string, id: string) => string;
}
const moneyResources: MoneyResource[] = [
  { name: 'rent-schedules', fixtureKey: 'rentScheduleId' },
  {
    name: 'charges',
    fixtureKey: 'chargeId',
    voidPath: (a, id) => `/v1/accounts/${a}/charges/${id}/void`,
  },
  {
    name: 'payments',
    fixtureKey: 'paymentId',
    voidPath: (a, id) => `/v1/accounts/${a}/payments/${id}/void`,
  },
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
    "tenancy-members: A with A's accountId but B's tenancyId -> 404 (immediate-parent resolver)",
    async () => {
      // Phase 6 added the immediate-parent resolver: the tenancyId in the
      // URL must belong to the resolved account. Before P6 this returned
      // 200-with-empty (RLS-invisible rows, no leak); now it returns a
      // uniform 404 so cross-account refs in the PATH behave the same as
      // cross-account refs in a BODY (which already 404 via composite FK).
      const res = await api('GET', mACrossList, { token: A.accessToken });
      await expectStatus('GET cross-tenancy members', res, 404);
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
  // tenancy_members account-wide list:
  //   /v1/accounts/{accountId}/tenancy-members
  // Same table as the nested sub-resource above, but scoped only by
  // account_id -- no tenancyId in the path. A cross-account tenant_id /
  // tenancy_id query VALUE is just an RLS-invisible filter (empty 200),
  // unlike the nested route's path parent, which 404s.
  // -----------------------------------------------------------------------
  const acctMembersUrl = `/v1/accounts/${A.accountId}/tenancy-members`;

  await check('tenancy-members (account-wide): A lists own account -> 200', async () => {
    const res = await api('GET', acctMembersUrl, { token: A.accessToken });
    const body = (await expectStatus('GET account-wide members', res, 200)) as {
      data: Array<{ account_id: string }>;
    };
    if (!Array.isArray(body.data) || body.data.length < 1) {
      throw new Error(`expected at least one member; got ${JSON.stringify(body)}`);
    }
    for (const row of body.data) {
      if (row.account_id !== A.accountId) {
        throw new Error(`row leaked another account: ${JSON.stringify(row)}`);
      }
    }
  });

  await check(
    "tenancy-members (account-wide): A filters ?tenant_id=<B's tenant> -> 200 empty",
    async () => {
      const res = await api('GET', `${acctMembersUrl}?tenant_id=${B.tenantId}`, {
        token: A.accessToken,
      });
      const body = (await expectStatus('GET filtered by B tenant_id', res, 200)) as {
        data: unknown[];
      };
      if (body.data.length !== 0) {
        throw new Error(`expected empty page for cross-account tenant_id; got ${JSON.stringify(body)}`);
      }
    },
  );

  await check(
    "tenancy-members (account-wide): A filters ?tenant_id=<A's tenant> -> 200 matching rows",
    async () => {
      const res = await api('GET', `${acctMembersUrl}?tenant_id=${A.tenantId}`, {
        token: A.accessToken,
      });
      const body = (await expectStatus('GET filtered by A tenant_id', res, 200)) as {
        data: Array<{ tenant_id: string }>;
      };
      if (body.data.length < 1) {
        throw new Error(`expected at least one row; got ${JSON.stringify(body)}`);
      }
      for (const row of body.data) {
        if (row.tenant_id !== A.tenantId) {
          throw new Error(`row didn't match tenant_id filter: ${JSON.stringify(row)}`);
        }
      }
    },
  );

  await check(
    'tenancy-members (account-wide): ?tenancy_id= matches the nested route for the same tenancy',
    async () => {
      const wideRes = await api('GET', `${acctMembersUrl}?tenancy_id=${A.tenancyId}`, {
        token: A.accessToken,
      });
      const wideBody = (await expectStatus('GET filtered by A tenancy_id', wideRes, 200)) as {
        data: Array<{ id: string }>;
      };
      const nestedRes = await api('GET', mAOwnList, { token: A.accessToken });
      const nestedBody = (await expectStatus('GET nested list', nestedRes, 200)) as {
        data: Array<{ id: string }>;
      };
      const wideIds = wideBody.data.map((r) => r.id).sort();
      const nestedIds = nestedBody.data.map((r) => r.id).sort();
      if (JSON.stringify(wideIds) !== JSON.stringify(nestedIds)) {
        throw new Error(
          `tenancy_id-filtered account-wide list != nested list: ${JSON.stringify(wideIds)} vs ${JSON.stringify(nestedIds)}`,
        );
      }
    },
  );

  await check(
    'tenancy-members (account-wide): keyset pagination walks every row exactly once',
    async () => {
      // A already has one member (role=primary, from setupFixture). Add two
      // more on the SAME tenancy with different roles (the unique key is
      // (tenancy_id, tenant_id, role), so each new member also needs its own
      // tenant) to get three total rows to page through.
      const extraTenant = async (suffix: string): Promise<string> => {
        const r = await api('POST', `/v1/accounts/${A.accountId}/tenants`, {
          token: A.accessToken,
          body: { full_name: `A pagination tenant ${suffix} ${rnd()}` },
        });
        const body = (await expectStatus('POST extra tenant', r, 201)) as { id: string };
        return body.id;
      };
      const occupantTenantId = await extraTenant('occupant');
      const guarantorTenantId = await extraTenant('guarantor');
      for (const [tenant_id, role] of [
        [occupantTenantId, 'occupant'],
        [guarantorTenantId, 'guarantor'],
      ] as const) {
        const r = await api('POST', `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/members`, {
          token: A.accessToken,
          body: { tenant_id, role },
        });
        await expectStatus(`POST pagination member (${role})`, r, 201);
      }

      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        pages += 1;
        if (pages > 10) throw new Error('pagination did not terminate within 10 pages');
        const url = cursor
          ? `${acctMembersUrl}?limit=2&cursor=${encodeURIComponent(cursor)}`
          : `${acctMembersUrl}?limit=2`;
        const res = await api('GET', url, { token: A.accessToken });
        const body = (await expectStatus('GET pagination page', res, 200)) as {
          data: Array<{ id: string }>;
          next_cursor: string | null;
        };
        for (const row of body.data) {
          if (seen.has(row.id)) throw new Error(`row ${row.id} appeared twice across pages`);
          seen.add(row.id);
        }
        if (body.next_cursor === null) break;
        cursor = body.next_cursor;
      }
      if (seen.size !== 3) {
        throw new Error(`expected exactly 3 distinct rows across pages; got ${seen.size}`);
      }
    },
  );

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
  // Phase 6 money resources: list / get / cross-account 404.
  // -----------------------------------------------------------------------
  for (const r of moneyResources) {
    const bId = B[r.fixtureKey] as string;
    const aId = A[r.fixtureKey] as string;
    const otherList   = `/v1/accounts/${B.accountId}/${r.name}`;
    const otherIdUrl  = `/v1/accounts/${B.accountId}/${r.name}/${bId}`;
    const ownIdUrl    = `/v1/accounts/${A.accountId}/${r.name}/${aId}`;

    await check(`${r.name}: A gets own row -> 200`, async () => {
      const res = await api('GET', ownIdUrl, { token: A.accessToken });
      await expectStatus('GET own id', res, 200);
    });
    await check(`${r.name}: A listing B's account URL -> 404`, async () => {
      const res = await api('GET', otherList, { token: A.accessToken });
      await expectStatus('GET B list', res, 404);
    });
    await check(`${r.name}: A GET B's row by id -> 404`, async () => {
      const res = await api('GET', otherIdUrl, { token: A.accessToken });
      await expectStatus('GET B id', res, 404);
    });
    if (r.voidPath) {
      const voidUrl = r.voidPath(B.accountId, bId);
      await check(`${r.name}: A POST B's .../void -> 404`, async () => {
        const res = await api('POST', voidUrl, {
          token: A.accessToken,
          body: { void_reason: 'attack' },
        });
        await expectStatus('POST B void', res, 404);
      });
    }
  }

  // -----------------------------------------------------------------------
  // Cross-account creates that reference parent rows from the OTHER account
  // -- the DB allocation-integrity trigger / composite FK should reject.
  // -----------------------------------------------------------------------
  await check(
    "rent-schedules: A POST with B's tenancy_id under A's URL -> 404",
    async () => {
      const res = await api('POST', `/v1/accounts/${A.accountId}/rent-schedules`, {
        token: A.accessToken,
        body: {
          tenancy_id: B.tenancyId,
          kind: 'rent',
          amount_cents: 100000,
          currency: 'USD',
          due_day: 1,
          start_date: '2026-01-01',
        },
      });
      await expectStatus('POST cross-account rent-schedule', res, 404);
    },
  );
  await check(
    "charges: A POST with B's tenancy_id under A's URL -> 404",
    async () => {
      const res = await api('POST', `/v1/accounts/${A.accountId}/charges`, {
        token: A.accessToken,
        body: {
          tenancy_id: B.tenancyId,
          type: 'rent',
          amount_cents: 100000,
          currency: 'USD',
          due_date: '2026-02-01',
        },
      });
      await expectStatus('POST cross-account charge', res, 404);
    },
  );
  await check(
    "payments: A POST with B's tenancy_id under A's URL -> 404",
    async () => {
      const res = await api('POST', `/v1/accounts/${A.accountId}/payments`, {
        token: A.accessToken,
        body: {
          tenancy_id: B.tenancyId,
          amount_cents: 50000,
          currency: 'USD',
          received_at: '2026-02-03T12:00:00Z',
          method: 'check',
        },
      });
      await expectStatus('POST cross-account payment', res, 404);
    },
  );
  await check(
    "payments: A POST with allocation to B's charge under A's tenancy -> 400 (cross-tenancy/account)",
    async () => {
      const res = await api('POST', `/v1/accounts/${A.accountId}/payments`, {
        token: A.accessToken,
        body: {
          tenancy_id: A.tenancyId,
          amount_cents: 50000,
          currency: 'USD',
          received_at: '2026-02-03T12:00:00Z',
          method: 'check',
          allocations: [{ charge_id: B.chargeId, amount_cents: 50000 }],
        },
      });
      // The payment INSERT succeeds (it's account A's). The allocation
      // INSERT triggers _assert_allocation_integrity which rejects -- our
      // route maps to 400 ('cross-tenancy ... ' message) or 404 (FK).
      // Either way the operation is denied.
      if (res.status !== 400 && res.status !== 404) {
        throw new Error(`expected 400/404, got ${res.status}: ${JSON.stringify(res.body)}`);
      }
    },
  );

  // -----------------------------------------------------------------------
  // Per-tenancy ledger: cross-account / cross-tenancy paths 404 via the
  // immediate-parent resolver. Own ledger returns a derived view.
  // -----------------------------------------------------------------------
  const ownLedger   = `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/ledger`;
  const crossLedger = `/v1/accounts/${A.accountId}/tenancies/${B.tenancyId}/ledger`;
  const otherAccLedger = `/v1/accounts/${B.accountId}/tenancies/${B.tenancyId}/ledger`;

  await check('ledger: A reads own tenancy ledger -> 200', async () => {
    const res = await api('GET', ownLedger, { token: A.accessToken });
    const body = (await expectStatus('GET own ledger', res, 200)) as {
      tenancy_id: string;
      totals: {
        rent_charges_cents: number;
        rent_payments_cents: number;
        total_received_cents: number;
        total_allocated_cents: number;
        unapplied_credit_cents: number;
      };
      entries: unknown[];
    };
    if (body.tenancy_id !== A.tenancyId) throw new Error(`wrong tenancy_id`);
    if (body.totals.rent_charges_cents !== 120000) {
      throw new Error(`expected rent_charges 120000, got ${body.totals.rent_charges_cents}`);
    }
    // The fixture creates a $1200 charge and a $700 unallocated payment.
    // Unapplied credit is the full $700 because no allocations were made.
    if (body.totals.total_received_cents !== 70000) {
      throw new Error(`expected total_received 70000, got ${body.totals.total_received_cents}`);
    }
    if (body.totals.total_allocated_cents !== 0) {
      throw new Error(`expected total_allocated 0, got ${body.totals.total_allocated_cents}`);
    }
    if (body.totals.unapplied_credit_cents !== 70000) {
      throw new Error(
        `expected unapplied_credit 70000, got ${body.totals.unapplied_credit_cents}`,
      );
    }
  });

  await check(
    'ledger: unapplied credit reflects a void-after-allocation (real money still owed back)',
    async () => {
      // Create a charge, fully allocate a payment to it, then void the
      // charge. The allocation rows stay; the ledger should show the
      // payment as UNAPPLIED CREDIT because the target charge is gone.
      // This is exactly the dispute the ledger exists to prevent: a tenant
      // who paid, where the charge was later voided, has a balance the
      // landlord owes back -- and the ledger surfaces it.
      const ch = await api('POST', `/v1/accounts/${A.accountId}/charges`, {
        token: A.accessToken,
        body: {
          tenancy_id: A.tenancyId,
          type: 'rent',
          amount_cents: 100000,
          currency: 'USD',
          due_date: '2026-03-01',
        },
      });
      const chargeId = (ch.body as { id: string }).id;
      const pay = await api('POST', `/v1/accounts/${A.accountId}/payments`, {
        token: A.accessToken,
        body: {
          tenancy_id: A.tenancyId,
          amount_cents: 100000,
          currency: 'USD',
          received_at: '2026-03-03T00:00:00Z',
          method: 'check',
          allocations: [{ charge_id: chargeId, amount_cents: 100000 }],
        },
      });
      await expectStatus('void-after-alloc POST payment', pay, 201);
      // Void the charge -- allocations now don't count against it; the
      // payment becomes unapplied credit.
      const voidRes = await api(
        'POST',
        `/v1/accounts/${A.accountId}/charges/${chargeId}/void`,
        { token: A.accessToken, body: { void_reason: 'mistake' } },
      );
      await expectStatus('void-after-alloc POST void', voidRes, 200);

      const lr = await api('GET', ownLedger, { token: A.accessToken });
      const lb = (await expectStatus('GET ledger after void', lr, 200)) as {
        totals: {
          total_received_cents: number;
          total_allocated_cents: number;
          unapplied_credit_cents: number;
        };
      };
      // total_received counts non-voided payments; the $100k payment is not
      // voided, so it contributes. total_allocated excludes allocations
      // against voided charges, so the $100k allocation is dropped from
      // the count. The difference is real money owed back.
      if (lb.totals.unapplied_credit_cents < 100000) {
        throw new Error(
          `expected unapplied_credit >= 100000 after void, got ${lb.totals.unapplied_credit_cents}`,
        );
      }
    },
  );
  await check(
    "ledger: A with A's accountId but B's tenancyId -> 404 (immediate-parent)",
    async () => {
      const res = await api('GET', crossLedger, { token: A.accessToken });
      await expectStatus('GET cross-tenancy ledger', res, 404);
    },
  );
  await check("ledger: A on B's full account URL -> 404", async () => {
    const res = await api('GET', otherAccLedger, { token: A.accessToken });
    await expectStatus('GET B ledger', res, 404);
  });

  // -----------------------------------------------------------------------
  // Idempotency-Key contract:
  //   (1) Mutating endpoints REQUIRE the header (missing -> 400).
  //   (2) Same key + same body returns the cached response (no double-create),
  //       with the Idempotency-Replay: true header on the replay.
  //   (3) Same key + DIFFERENT body returns 409 (idempotency_conflict).
  // -----------------------------------------------------------------------
  await check('idempotency: missing Idempotency-Key on POST -> 400', async () => {
    // Drive the request directly so we can omit the header (the api()
    // helper auto-injects one).
    const req = new Request(`http://test/v1/accounts/${A.accountId}/properties`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${A.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'no idem' }),
    });
    const res = await app.fetch(req);
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code !== 'invalid_request') throw new Error(`wrong code: ${body.error?.code}`);
    if (!/idempotency-key/i.test(body.error?.message ?? '')) {
      throw new Error(`message did not mention idempotency-key: ${body.error?.message}`);
    }
  });

  await check(
    'idempotency: replay same key + same body -> cached response (no double-create)',
    async () => {
      const key = `replay-${crypto.randomUUID()}`;
      const body = { name: `idempotent-prop-${rnd()}` };
      const r1 = await api('POST', `/v1/accounts/${A.accountId}/properties`, {
        token: A.accessToken,
        body,
        idempotencyKey: key,
      });
      await expectStatus('first replay POST', r1, 201);
      const id1 = (r1.body as { id: string }).id;

      // Now list properties; capture the count BEFORE the replay so we can
      // assert no new row landed.
      const list1 = await api('GET', `/v1/accounts/${A.accountId}/properties`, {
        token: A.accessToken,
      });
      const before = (list1.body as { data: unknown[] }).data.length;

      const r2 = await api('POST', `/v1/accounts/${A.accountId}/properties`, {
        token: A.accessToken,
        body,
        idempotencyKey: key,
      });
      await expectStatus('replayed POST', r2, 201);
      const id2 = (r2.body as { id: string }).id;
      if (id1 !== id2) {
        throw new Error(`replay returned DIFFERENT id: ${id1} vs ${id2} (double-create)`);
      }
      // The replay must be flagged so the caller can distinguish an absorbed
      // retry from a fresh execution; the first response must NOT carry it.
      if (r2.headers.get('idempotency-replay') !== 'true') {
        throw new Error(`replay missing Idempotency-Replay: true header`);
      }
      if (r1.headers.get('idempotency-replay') !== null) {
        throw new Error(`first (non-replay) response should not carry Idempotency-Replay`);
      }

      const list2 = await api('GET', `/v1/accounts/${A.accountId}/properties`, {
        token: A.accessToken,
      });
      const after = (list2.body as { data: unknown[] }).data.length;
      if (after !== before) {
        throw new Error(`property count changed: ${before} -> ${after} (replay double-created)`);
      }
    },
  );

  await check(
    'idempotency: same key + DIFFERENT body -> 409 idempotency_conflict',
    async () => {
      const key = `mismatch-${crypto.randomUUID()}`;
      const r1 = await api('POST', `/v1/accounts/${A.accountId}/vendors`, {
        token: A.accessToken,
        body: { name: 'first' },
        idempotencyKey: key,
      });
      await expectStatus('first POST', r1, 201);
      const r2 = await api('POST', `/v1/accounts/${A.accountId}/vendors`, {
        token: A.accessToken,
        body: { name: 'second' }, // different body, same key
        idempotencyKey: key,
      });
      await expectStatus('mismatched replay', r2, 409);
      const body = r2.body as { error?: { code?: string } };
      if (body.error?.code !== 'idempotency_conflict') {
        throw new Error(`expected idempotency_conflict code, got ${body.error?.code}`);
      }
    },
  );

  // -----------------------------------------------------------------------
  // /v1/me sanity
  // -----------------------------------------------------------------------
  await check('/v1/me as A returns only A account', async () => {
    const res = await api('GET', '/v1/me', { token: A.accessToken });
    const body = (await expectStatus('GET /v1/me', res, 200)) as {
      user: { id: string };
      memberships: Array<{ account_id: string }>;
    };
    if (body.user.id !== A.userId) throw new Error(`wrong user id`);
    const ids = body.memberships.map((m) => m.account_id);
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
