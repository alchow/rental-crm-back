// ----------------------------------------------------------------------------
// Multi-status list filters (Field Log ask #2). The tenancies and
// maintenance-requests list endpoints accept a comma-separated `status` set in
// addition to a single value. Covers:
//   (a) single status stays byte-compatible on BOTH resources (back-compat);
//   (b) a two-value set ('active,holdover' / 'open,triaged') returns the union
//       and nothing else;
//   (c) a bogus member is a 400 with fieldErrors.status (parseCsvEnum);
//   (d) a keyset walk under a multi-status filter returns every row exactly
//       once (the IN filter composes with keysetPage correctly).
//
// Requires the local Supabase stack (`supabase start` in db/), same as the
// other integration suites.
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
    if (!line) throw new Error(`supabase status missing: ${k}`);
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
process.env.PORT = '8804';
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

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase()) && path.startsWith('/v1/accounts/')) {
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

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface Failure { name: string; detail: string }
const failures: Failure[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.info(`  PASS  ${name}`); }
  catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}
function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

// --- fixture ----------------------------------------------------------------

const email = `msf-${rnd()}@example.test`;
const su = await api('POST', '/v1/auth/signup', {
  body: { email, password: `correct-horse-battery-${rnd()}`, account_name: 'MSF Acct' },
});
if (su.status !== 200) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.body)}`);
const sub = su.body as { account: { id: string }; session: { access_token: string } };
const token = sub.session.access_token;
const acct = sub.account.id;

const post = async <T>(p: string, body: unknown): Promise<T> => {
  const r = await api('POST', `/v1/accounts/${acct}${p}`, { token, body });
  if (r.status !== 201) throw new Error(`POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
};
const patch = async <T>(p: string, body: unknown): Promise<T> => {
  const r = await api('PATCH', `/v1/accounts/${acct}${p}`, { token, body });
  if (r.status !== 200) throw new Error(`PATCH ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
};

const property = await post<{ id: string }>('/properties', { name: 'MSF prop' });
const newUnit = async (): Promise<string> =>
  (await post<{ id: string }>('/areas', { property_id: property.id, kind: 'unit', name: `U-${rnd()}` })).id;

// Tenancies across statuses (each on its own unit to avoid occupancy clashes).
interface Row { id: string; status: string }
const mkTenancy = async (st: string): Promise<Row> =>
  post<Row>('/tenancies', { area_id: await newUnit(), start_date: '2026-01-01', status: st });

const tActive1 = await mkTenancy('active');
const tActive2 = await mkTenancy('active');
const tHoldover = await mkTenancy('holdover');
const tUpcoming = await mkTenancy('upcoming');

const listTenancies = async (qs: string): Promise<Row[]> => {
  const r = await api('GET', `/v1/accounts/${acct}/tenancies${qs}`, { token });
  if (r.status !== 200) throw new Error(`list ${qs}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { data: Row[] }).data;
};

// Maintenance requests: create starts at 'open'; PATCH forward for others.
const mkMr = async (): Promise<Row> => {
  const area = await newUnit();
  return post<Row>('/maintenance-requests', { area_id: area, title: `MR ${rnd()}`, severity: 'routine' });
};
const mrOpen = await mkMr();
const mrTriaged = await mkMr();
await patch(`/maintenance-requests/${mrTriaged.id}`, { status: 'triaged' });
const mrInProgress = await mkMr();
await patch(`/maintenance-requests/${mrInProgress.id}`, { status: 'in_progress' });

const listMrs = async (qs: string): Promise<Row[]> => {
  const r = await api('GET', `/v1/accounts/${acct}/maintenance-requests${qs}`, { token });
  if (r.status !== 200) throw new Error(`list ${qs}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { data: Row[] }).data;
};

// --- tests ------------------------------------------------------------------

await check('(a) tenancies single status back-compat (?status=holdover)', async () => {
  const rows = await listTenancies('?status=holdover');
  assertEq(rows.length, 1, 'count');
  assertEq(rows[0]?.id, tHoldover.id, 'id');
  assertEq(rows.every((r) => r.status === 'holdover'), true, 'all holdover');
});

await check('(a) maintenance single status back-compat (?status=triaged)', async () => {
  const rows = await listMrs('?status=triaged');
  assertEq(rows.length, 1, 'count');
  assertEq(rows[0]?.id, mrTriaged.id, 'id');
});

await check("(b) tenancies ?status=active,holdover returns the union only", async () => {
  const rows = await listTenancies('?status=active,holdover');
  const ids = new Set(rows.map((r) => r.id));
  assertEq(ids.has(tActive1.id) && ids.has(tActive2.id) && ids.has(tHoldover.id), true, 'has all three');
  assertEq(ids.has(tUpcoming.id), false, 'excludes upcoming');
  assertEq(rows.every((r) => r.status === 'active' || r.status === 'holdover'), true, 'only active/holdover');
});

await check("(b) maintenance ?status=open,triaged returns both", async () => {
  const rows = await listMrs('?status=open,triaged');
  const ids = new Set(rows.map((r) => r.id));
  assertEq(ids.has(mrOpen.id) && ids.has(mrTriaged.id), true, 'has open + triaged');
  assertEq(ids.has(mrInProgress.id), false, 'excludes in_progress');
});

await check('(b) de-dup + whitespace tolerated (?status=active, active , holdover)', async () => {
  const rows = await listTenancies(`?status=${encodeURIComponent('active, active , holdover')}`);
  assertEq(rows.every((r) => r.status === 'active' || r.status === 'holdover'), true, 'only union');
  const ids = new Set(rows.map((r) => r.id));
  assertEq(ids.has(tActive1.id) && ids.has(tHoldover.id), true, 'has both');
});

await check('(c) tenancies bogus status -> 400 fieldErrors.status', async () => {
  const r = await api('GET', `/v1/accounts/${acct}/tenancies?status=active,bogus`, { token });
  assertEq(r.status, 400, 'status');
  const b = r.body as { error?: { code?: string; details?: { fieldErrors?: { status?: string[] } } } };
  assertEq(b.error?.code, 'invalid_request', 'code');
  assertEq(b.error?.details?.fieldErrors?.status?.includes('bogus'), true, 'fieldErrors.status has bogus');
});

await check('(c) maintenance bogus status -> 400 fieldErrors.status', async () => {
  const r = await api('GET', `/v1/accounts/${acct}/maintenance-requests?status=nope`, { token });
  assertEq(r.status, 400, 'status');
  const b = r.body as { error?: { code?: string; details?: { fieldErrors?: { status?: string[] } } } };
  assertEq(b.error?.code, 'invalid_request', 'code');
  assertEq(b.error?.details?.fieldErrors?.status?.includes('nope'), true, 'fieldErrors.status has nope');
});

await check('(c) empty status (?status=,) -> 400', async () => {
  const r = await api('GET', `/v1/accounts/${acct}/tenancies?status=${encodeURIComponent(',')}`, { token });
  assertEq(r.status, 400, 'status');
  assertEq((r.body as { error?: { code?: string } }).error?.code, 'invalid_request', 'code');
});

await check('(d) keyset walk under a multi-status filter: each row exactly once', async () => {
  // Add more active/holdover tenancies so the walk spans multiple pages.
  await mkTenancy('active');
  await mkTenancy('holdover');
  await mkTenancy('active');
  const seen = new Set<string>();
  let cursor: string | null = null;
  let guard = 0;
  do {
    const qs: string = cursor
      ? `?status=active,holdover&limit=2&cursor=${encodeURIComponent(cursor)}`
      : '?status=active,holdover&limit=2';
    const r = await api('GET', `/v1/accounts/${acct}/tenancies${qs}`, { token });
    assertEq(r.status, 200, 'page status');
    const page = r.body as { data: Row[]; next_cursor: string | null };
    for (const row of page.data) {
      if (seen.has(row.id)) throw new Error(`row ${row.id} returned twice`);
      if (row.status !== 'active' && row.status !== 'holdover') throw new Error(`leaked status ${row.status}`);
      seen.add(row.id);
    }
    cursor = page.next_cursor;
    guard += 1;
  } while (cursor && guard < 20);
  // Fixture: 2 active + 1 holdover = 3. Added here: 2 active + 1 holdover = 3.
  assertEq(seen.size, 6, 'total active+holdover rows across pages');
});

// --- summary -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n${failures.length} multi-status-filter failure(s):`);
  for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.info('\nOK: multi-status filter checks all green');
