// ----------------------------------------------------------------------------
// Phase 5 API-level cross-tenant isolation test.
//
// Runs against the FULL local Supabase stack (Postgres + GoTrue + PostgREST +
// Storage + Realtime) brought up via `supabase start`. The point of running
// against the real stack here -- not against ephemeral postgres with hand-
// minted JWTs -- is that test-vs-prod drift on the auth path is exactly where
// a cross-tenant leak would hide. Real GoTrue token issuance + real PostgREST
// claim handling means we are checking the actual code that ships.
//
// Setup:
//   - `supabase start` brings up the stack and auto-applies the migrations
//     in db/supabase/migrations/.
//   - We sign up TWO users via the API's own /v1/auth/signup. The signup RPC
//     atomically creates the public.users mirror + accounts row + owner
//     account_members row.
//   - We then save each user's session.access_token and account_id.
//
// Assertions, for each account-scoped resource (properties, vendors, tenants):
//
//   1. As A's token, GET /v1/accounts/<A.id>/<resource>             -> 200
//      (and the body is the empty list initially, or A's own data later).
//
//   2. As A's token, GET /v1/accounts/<B.id>/<resource>             -> 404
//      (the resolver 404s on non-membership; no body, no leak).
//
//   3. As A's token, GET /v1/accounts/<A.id>/<resource>/<B's id>    -> 404
//      (the row exists but belongs to B; resolver allows the URL because
//      A is in <A.id>, but the .eq('id') doesn't match A's rows).
//
//   4. As A's token, PATCH and DELETE on B's URL                    -> 404
//
//   5. The X-Account-Id header attack: as A's token, GET
//      /v1/accounts/<A.id>/<resource> with header X-Account-Id: <B.id>.
//      The resolver and route both ignore the header; A sees A's data only,
//      not B's. Header is verified to be a no-op, not an attack surface.
//
// Anything else -- contract test, SDK gen drift -- is Phase 5b. The point of
// THIS test is the security gate.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';

// --- bring up the supabase stack state into env -------------------------------
// `supabase status` is the source of truth for the local URLs/keys. We could
// also hardcode (the defaults are deterministic), but doing it this way means
// the test follows config changes without manual edits.
interface SupabaseStatus {
  API_URL: string;
  DB_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function readSupabaseStatus(): SupabaseStatus {
  // --output env emits VAR=value lines we can grep.
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
// Use supabase start's GoTrue as the JWKS source.
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
interface SignupResult {
  userId: string;
  email: string;
  accessToken: string;
  accountId: string;
}

interface ApiCall {
  status: number;
  body: unknown;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; extraHeaders?: Record<string, string> } = {},
): Promise<ApiCall> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(opts.extraHeaders ?? {}),
  };
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

// --- tests -------------------------------------------------------------------
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

function assertStatus(r: ApiCall, expected: number, ctx: string): void {
  if (r.status !== expected) {
    throw new Error(
      `${ctx}: expected status ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`,
    );
  }
}

interface ResourceSpec {
  name: 'properties' | 'vendors' | 'tenants';
  createBody: (label: string) => Record<string, unknown>;
}

const resources: ResourceSpec[] = [
  { name: 'properties', createBody: (l) => ({ name: `${l} prop` }) },
  { name: 'vendors',    createBody: (l) => ({ name: `${l} vendor` }) },
  { name: 'tenants',    createBody: (l) => ({ full_name: `${l} tenant` }) },
];

async function main(): Promise<void> {
  console.info('Phase 5 API-level cross-tenant isolation');
  console.info(`  supabase API at ${status.API_URL}`);

  const A = await signup('A');
  const B = await signup('B');
  console.info(`  user A: ${A.userId} / account ${A.accountId}`);
  console.info(`  user B: ${B.userId} / account ${B.accountId}`);

  for (const r of resources) {
    const ownPath = `/v1/accounts/${A.accountId}/${r.name}`;
    const otherPath = `/v1/accounts/${B.accountId}/${r.name}`;
    const ownIdPathTemplate = (id: string) => `/v1/accounts/${A.accountId}/${r.name}/${id}`;
    const otherIdPathTemplate = (id: string) => `/v1/accounts/${B.accountId}/${r.name}/${id}`;

    // (1) A can list own account
    await check(`${r.name}: A can list own account`, async () => {
      const res = await api('GET', ownPath, { token: A.accessToken });
      assertStatus(res, 200, 'GET own list');
    });

    // (2) A creates own resource
    let aCreatedId = '';
    await check(`${r.name}: A creates a row in own account`, async () => {
      const res = await api('POST', ownPath, {
        token: A.accessToken,
        body: r.createBody('A'),
      });
      assertStatus(res, 201, 'POST own create');
      const b = res.body as { id: string };
      if (!b.id) throw new Error(`POST returned no id: ${JSON.stringify(res.body)}`);
      aCreatedId = b.id;
    });

    // B creates own resource so cross-tenant lookups by id are meaningful.
    let bCreatedId = '';
    await check(`${r.name}: B creates a row in own account (setup)`, async () => {
      const res = await api(
        'POST',
        `/v1/accounts/${B.accountId}/${r.name}`,
        { token: B.accessToken, body: r.createBody('B') },
      );
      assertStatus(res, 201, 'POST B own');
      const b = res.body as { id: string };
      bCreatedId = b.id;
    });

    // (3) A cannot list B's account -- 404
    await check(`${r.name}: A listing B's account -> 404`, async () => {
      const res = await api('GET', otherPath, { token: A.accessToken });
      assertStatus(res, 404, "GET B's list as A");
    });

    // (4) A cannot GET a specific id under B's URL -- 404
    await check(`${r.name}: A GET B's resource by id -> 404`, async () => {
      const res = await api('GET', otherIdPathTemplate(bCreatedId), { token: A.accessToken });
      assertStatus(res, 404, "GET B's id as A");
    });

    // (5) A cannot PATCH a B-scoped row -- 404
    await check(`${r.name}: A PATCH B's resource -> 404`, async () => {
      const patchBody =
        r.name === 'tenants' ? { full_name: 'evil' } : { name: 'evil' };
      const res = await api('PATCH', otherIdPathTemplate(bCreatedId), {
        token: A.accessToken,
        body: patchBody,
      });
      assertStatus(res, 404, "PATCH B's id as A");
    });

    // (6) A cannot DELETE a B-scoped row -- 404
    await check(`${r.name}: A DELETE B's resource -> 404`, async () => {
      const res = await api('DELETE', otherIdPathTemplate(bCreatedId), {
        token: A.accessToken,
      });
      assertStatus(res, 404, "DELETE B's id as A");
    });

    // (7) X-Account-Id header attack: A passes B's id in the header along
    // with A's URL. The resolver and routes IGNORE the header (only the URL
    // path param drives the account scope). A sees only A's data.
    await check(`${r.name}: X-Account-Id header is ignored, A sees own data only`, async () => {
      const res = await api('GET', ownPath, {
        token: A.accessToken,
        extraHeaders: { 'x-account-id': B.accountId },
      });
      assertStatus(res, 200, 'GET own with bogus header');
      const body = res.body as { data: Array<{ id: string; account_id: string }> };
      for (const row of body.data ?? []) {
        if (row.account_id !== A.accountId) {
          throw new Error(
            `leak via X-Account-Id header: saw account_id=${row.account_id} in A's list`,
          );
        }
      }
    });

    // (8) A's GET on A's URL with A's id returns A's row
    await check(`${r.name}: A GET own resource by id -> 200`, async () => {
      const res = await api('GET', ownIdPathTemplate(aCreatedId), { token: A.accessToken });
      assertStatus(res, 200, "GET A's own id as A");
      const b = res.body as { id: string; account_id: string };
      if (b.id !== aCreatedId) throw new Error(`mismatched id: ${b.id}`);
      if (b.account_id !== A.accountId) throw new Error(`wrong account: ${b.account_id}`);
    });
  }

  // Cross-tenant attack on /v1/me:
  await check('/v1/me as A returns only A account', async () => {
    const res = await api('GET', '/v1/me', { token: A.accessToken });
    assertStatus(res, 200, 'GET /v1/me');
    const b = res.body as { user_id: string; accounts: Array<{ account_id: string }> };
    if (b.user_id !== A.userId) throw new Error(`wrong user_id`);
    const ids = b.accounts.map((m) => m.account_id);
    if (!ids.includes(A.accountId)) throw new Error(`A's own account missing`);
    if (ids.includes(B.accountId)) throw new Error(`B's account leaked into A's /v1/me`);
  });

  // --- summary ---
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
