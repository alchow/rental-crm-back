// ----------------------------------------------------------------------------
// Tenancy start_date correction path (usability finding C3).
//
// start_date was immutable after creation, which made a mis-entered move-in
// date permanent corruption in an evidence-grade record. The PATCH now
// accepts start_date under guards; these tests pin every guard:
//
//   * money-free tenancy: correction succeeds and persists.
//   * any non-voided charge OR payment: 409 tenancy_has_money.
//   * voiding the money row re-opens the correction path.
//   * a future start_date requires status='upcoming' in the same PATCH.
//   * start_date must not pass the effective end_date.
//   * PATCHes without start_date are untouched (regression).
//   * a no-op correction (same value) skips the money guard.
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
function errorCode(r: ApiResp): string | undefined {
  return (r.body as { error?: { code?: string } }).error?.code;
}

// --- fixture ------------------------------------------------------------------

const email = `startdate-${rnd()}@example.test`;
const su = await api('POST', '/v1/auth/signup', {
  body: { email, password: `correct-horse-battery-${rnd()}`, account_name: 'StartDate Acct' },
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
const patchTenancy = (id: string, body: unknown): Promise<ApiResp> =>
  api('PATCH', `/v1/accounts/${acct}/tenancies/${id}`, { token, body });

const property = await post<{ id: string }>('/properties', { name: 'StartDate prop' });
const area = await post<{ id: string }>('/areas', { property_id: property.id, kind: 'unit', name: 'Unit SD' });
// The Jordan Kim shape: created with the wrong (earlier) date, already active.
const tenancy = await post<{ id: string }>('/tenancies', {
  area_id: area.id, start_date: '2026-01-07', status: 'active',
});

// --- tests --------------------------------------------------------------------

console.info('tenancy start_date correction checks');

await check('(1) money-free correction succeeds and persists', async () => {
  const r = await patchTenancy(tenancy.id, { start_date: '2026-01-15' });
  assertEq(r.status, 200, 'patch status');
  const g = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancy.id}`, { token });
  assertEq((g.body as { start_date: string }).start_date, '2026-01-15', 'persisted start_date');
});

let chargeId = '';
await check('(2) non-voided charge blocks the correction with 409 tenancy_has_money', async () => {
  const charge = await post<{ id: string }>('/charges', {
    tenancy_id: tenancy.id, type: 'rent', amount_cents: 100000, currency: 'USD', due_date: '2026-02-01',
  });
  chargeId = charge.id;
  const r = await patchTenancy(tenancy.id, { start_date: '2026-01-20' });
  assertEq(r.status, 409, 'patch status');
  assertEq(errorCode(r), 'tenancy_has_money', 'error code');
});

await check('(3) no-op correction (same value) is allowed even with money', async () => {
  const r = await patchTenancy(tenancy.id, { start_date: '2026-01-15' });
  assertEq(r.status, 200, 'no-op patch status');
});

await check('(4) voiding the charge re-opens the correction path', async () => {
  const v = await api('POST', `/v1/accounts/${acct}/charges/${chargeId}/void`, {
    token, body: { void_reason: 'test void' },
  });
  assertEq(v.status, 200, 'void status');
  const r = await patchTenancy(tenancy.id, { start_date: '2026-01-20' });
  assertEq(r.status, 200, 'patch after void');
});

await check('(5) non-voided unallocated payment also blocks (409)', async () => {
  // Payment with no allocations: pure unapplied credit still anchors the timeline.
  await post('/payments', {
    tenancy_id: tenancy.id, amount_cents: 5000, currency: 'USD',
    received_at: '2026-02-02T00:00:00.000Z', method: 'cash',
  });
  const r = await patchTenancy(tenancy.id, { start_date: '2026-01-21' });
  assertEq(r.status, 409, 'patch status');
  assertEq(errorCode(r), 'tenancy_has_money', 'error code');
});

await check('(6) voiding the payment re-opens the correction path', async () => {
  const list = await api('GET', `/v1/accounts/${acct}/payments?tenancy_id=${tenancy.id}`, { token });
  const payments = (list.body as { data: { id: string; voided_at: string | null }[] }).data;
  const live = payments.find((p) => p.voided_at === null);
  if (!live) throw new Error('no live payment found');
  const v = await api('POST', `/v1/accounts/${acct}/payments/${live.id}/void`, {
    token, body: { void_reason: 'test void' },
  });
  assertEq(v.status, 200, 'void status');
  const r = await patchTenancy(tenancy.id, { start_date: '2026-01-21' });
  assertEq(r.status, 200, 'patch after void');
});

await check("(7) future start_date without status='upcoming' is a 400", async () => {
  const r = await patchTenancy(tenancy.id, { start_date: '2030-01-01' });
  assertEq(r.status, 400, 'patch status');
  assertEq(errorCode(r), 'invalid_request', 'error code');
  const fields = (r.body as { error: { details?: { fieldErrors?: Record<string, unknown> } } })
    .error.details?.fieldErrors;
  if (!fields?.start_date || !fields?.status) {
    throw new Error(`expected fieldErrors on start_date and status, got ${JSON.stringify(fields)}`);
  }
});

await check("(8) future start_date + status='upcoming' in the same PATCH succeeds", async () => {
  const r = await patchTenancy(tenancy.id, { start_date: '2030-01-01', status: 'upcoming' });
  assertEq(r.status, 200, 'patch status');
  const g = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancy.id}`, { token });
  const body = g.body as { start_date: string; status: string };
  assertEq(body.start_date, '2030-01-01', 'persisted start_date');
  assertEq(body.status, 'upcoming', 'persisted status');
});

await check('(9) start_date past the effective end_date is a 400', async () => {
  // Reset to an active past-dated tenancy with an end_date, then try to
  // push start_date beyond it.
  const setup = await patchTenancy(tenancy.id, {
    start_date: '2026-01-10', status: 'active', end_date: '2026-06-30',
  });
  assertEq(setup.status, 200, 'setup patch');
  // 2026-07-05 is in the past (so the future-date guard stays quiet) but
  // beyond the 2026-06-30 end_date — only the ordering guard can fire.
  const r = await patchTenancy(tenancy.id, { start_date: '2026-07-05' });
  assertEq(r.status, 400, 'patch status');
  assertEq(errorCode(r), 'invalid_request', 'error code');
  const fields = (r.body as { error: { details?: { fieldErrors?: Record<string, unknown> } } })
    .error.details?.fieldErrors;
  if (!fields?.start_date) throw new Error('expected fieldErrors.start_date on ordering guard');
});

await check('(10) regression: status/end_date-only PATCH is untouched by the guards', async () => {
  const r = await patchTenancy(tenancy.id, { end_date: null, status: 'active' });
  assertEq(r.status, 200, 'patch status');
});

if (failures.length > 0) {
  console.error(`\n${failures.length} start-date failure(s):`);
  for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.info('\nOK: tenancy start_date correction checks all green');
