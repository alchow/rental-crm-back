// ----------------------------------------------------------------------------
// Per-account tenant-email uniqueness integration tests (migration
// 20260721000002). Same shape as the other live-stack suites (comms.test.ts):
// assigns process.env from `supabase status` so the app under test — including
// the service-role admin client the tenants route now uses for its conflict
// oracle — sees the CI env, then drives the /v1 surface via app.fetch.
//
// Covers the product rule end-to-end: a per-account collision (another tenant,
// case/whitespace-insensitive) 409s and NAMES the holder; PATCH is guarded too;
// scope is per-account; a soft-deleted holder frees the address; intra-array
// duplicates 422; an owner/manager LOGIN email collides as kind 'account_user';
// and a member reaching past the API straight to PostgREST is stopped by the DB
// trigger (23505) for the tenant-holder class.
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
  const get = (k: string): string => {
    const line = lines.find((l) => l.startsWith(k + '='));
    if (!line) throw new Error(`supabase status missing: ${k}`);
    return line.slice(k.length + 1).replace(/^"|"$/g, '');
  };
  return { API_URL: get('API_URL'), ANON_KEY: get('ANON_KEY'), SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY') };
}

const status = readSupabaseStatus();
process.env.NODE_ENV = 'test';
process.env.PORT = '8801';
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

interface ApiResp {
  status: number;
  body: unknown;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Direct PostgREST write with a member's real JWT — the threat model the DB
// trigger defends against (a member reaching past the API layer).
async function pgrest(
  method: string,
  table: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${status.API_URL}/rest/v1/${table}`, {
    method,
    headers: {
      apikey: status.ANON_KEY,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function rnd(): string {
  return Math.random().toString(36).slice(2, 10);
}

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
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertStatus(r: ApiResp, expected: number, ctx: string): void {
  if (r.status !== expected) {
    throw new Error(`${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`);
  }
}
function errCode(r: ApiResp): string {
  return (r.body as { error?: { code?: string } })?.error?.code ?? '';
}
function errDetails(r: ApiResp): { conflicts?: unknown[]; fieldErrors?: Record<string, string[]> } {
  return ((r.body as { error?: { details?: unknown } })?.error?.details ?? {}) as {
    conflicts?: unknown[];
    fieldErrors?: Record<string, string[]>;
  };
}

interface Account {
  accountId: string;
  token: string;
  ownerEmail: string;
}

async function signup(label: string): Promise<Account> {
  const ownerEmail = `teu-${label}-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email: ownerEmail, password, account_name: `TEU ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label}: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };
  return { accountId: b.account.id, token: b.session.access_token, ownerEmail };
}

async function createTenant(a: Account, body: unknown): Promise<ApiResp> {
  return api('POST', `/v1/accounts/${a.accountId}/tenants`, { token: a.token, body });
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Tenant-email uniqueness integration tests');
  const A = await signup('a');
  const B = await signup('b');

  const E1 = `dup-${rnd()}@x.com`;
  const t1Name = 'Terry Tenant';

  await check('create tenant with email -> 201', async () => {
    const r = await createTenant(A, { full_name: t1Name, emails: [E1] });
    assertStatus(r, 201, 'create T1');
  });

  await check('duplicate email (case variant) same account -> 409 names holder', async () => {
    // Case variant only: the route's z.string().email() rejects surrounding
    // whitespace at validation (400) before normalization; case-insensitive
    // matching is the collision the oracle/trigger btrim+lower catches.
    const r = await createTenant(A, { full_name: 'Copy Cat', emails: [E1.toUpperCase()] });
    assertStatus(r, 409, 'create dup');
    assert(errCode(r) === 'conflict', `expected code conflict, got ${errCode(r)}`);
    const d = errDetails(r);
    const conflicts = (d.conflicts ?? []) as { holder_kind: string; holder_name: string; email: string }[];
    assert(conflicts.length > 0, 'expected details.conflicts');
    const tenantHit = conflicts.find((c) => c.holder_kind === 'tenant');
    assert(!!tenantHit, `expected a tenant-kind conflict, got ${JSON.stringify(conflicts)}`);
    assert(tenantHit!.holder_name === t1Name, `holder_name should name T1, got ${tenantHit!.holder_name}`);
    assert(Array.isArray(d.fieldErrors?.emails) && d.fieldErrors!.emails.length > 0, 'expected fieldErrors.emails');
  });

  await check('PATCH a second tenant with the taken email -> 409', async () => {
    const created = await createTenant(A, { full_name: 'Nora NoEmail' });
    assertStatus(created, 201, 'create T2');
    const id = (created.body as { id: string }).id;
    const r = await api('PATCH', `/v1/accounts/${A.accountId}/tenants/${id}`, {
      token: A.token,
      body: { emails: [E1] },
    });
    assertStatus(r, 409, 'patch dup');
    assert(errCode(r) === 'conflict', `expected conflict, got ${errCode(r)}`);
  });

  await check('same email in ANOTHER account -> 201 (scope is per-account)', async () => {
    const r = await createTenant(B, { full_name: 'Bill B', emails: [E1] });
    assertStatus(r, 201, 'create in account B');
  });

  await check('soft-deleted holder frees the email -> 201', async () => {
    const E2 = `free-${rnd()}@x.com`;
    const held = await createTenant(A, { full_name: 'Fred Freed', emails: [E2] });
    assertStatus(held, 201, 'create holder');
    const id = (held.body as { id: string }).id;
    const del = await api('DELETE', `/v1/accounts/${A.accountId}/tenants/${id}`, { token: A.token });
    assertStatus(del, 204, 'soft-delete holder');
    const reuse = await createTenant(A, { full_name: 'Reuser', emails: [E2] });
    assertStatus(reuse, 201, 'reuse after delete');
  });

  await check('intra-array duplicate -> 422', async () => {
    const E3 = `intra-${rnd()}@x.com`;
    const r = await createTenant(A, { full_name: 'Ivy Intra', emails: [E3, E3.toUpperCase()] });
    assertStatus(r, 422, 'intra-array dup');
    const d = errDetails(r);
    assert(Array.isArray(d.fieldErrors?.emails) && d.fieldErrors!.emails.length > 0, 'expected fieldErrors.emails');
  });

  await check("account user's login email -> 409 kind account_user", async () => {
    const r = await createTenant(A, { full_name: 'Alias Owner', emails: [A.ownerEmail] });
    assertStatus(r, 409, 'account_user collision');
    assert(errCode(r) === 'conflict', `expected conflict, got ${errCode(r)}`);
    const conflicts = (errDetails(r).conflicts ?? []) as { holder_kind: string }[];
    assert(
      conflicts.some((c) => c.holder_kind === 'account_user'),
      `expected an account_user conflict, got ${JSON.stringify(conflicts)}`,
    );
  });

  await check('direct PostgREST member write bypassing API -> trigger 23505 (tenant holder)', async () => {
    // E1 is still held by the live T1 in account A. A member reaching straight
    // to PostgREST must be stopped by the DB trigger, not just the API.
    const r = await pgrest('POST', 'tenants', A.token, {
      account_id: A.accountId,
      full_name: 'Sneaky Direct',
      emails: [E1],
    });
    assert(r.status === 409, `expected 409 from PostgREST, got ${r.status} body=${JSON.stringify(r.body)}`);
    assert(
      (r.body as { code?: string })?.code === '23505',
      `expected pg code 23505, got ${JSON.stringify(r.body)}`,
    );
  });

  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} tenant-email-uniqueness check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: tenant-email-uniqueness checks all green');
}

await main();
