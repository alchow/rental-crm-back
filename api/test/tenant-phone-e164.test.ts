// ----------------------------------------------------------------------------
// Canonical E.164 tenant phones — integration tests (migration
// 20260723000008 + the write-time normalization in routes/tenants.ts).
// Same live-stack shape as tenant-email-uniqueness.test.ts: env from
// `supabase status`, drive /v1 via app.fetch, plus a direct PostgREST write
// to prove the DB trigger backstop.
//
// Covers: create normalizes every accepted spelling to E.164; two spellings
// of one number dedupe silently; an unresolvable value 422s as invalid_phone
// with fieldErrors.phones naming it (create AND patch); bare 10-digit input
// is refused (no country-code guessing server-side); empty/omitted phones
// pass through; and a member writing raw phones straight to PostgREST is
// stopped by the tenants_phone_e164_guard trigger.
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
  return {
    API_URL: get('API_URL'),
    ANON_KEY: get('ANON_KEY'),
    SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY'),
  };
}

const status = readSupabaseStatus();
process.env.NODE_ENV = 'test';
process.env.PORT = '8807';
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

// --- helpers (same idiom as tenant-email-uniqueness.test.ts) ----------------

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
  if (mutating && path.startsWith('/v1/accounts/'))
    headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

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
function errFieldErrors(r: ApiResp): Record<string, string[]> {
  return ((
    (r.body as { error?: { details?: { fieldErrors?: Record<string, string[]> } } })?.error
      ?.details ?? {}
  ).fieldErrors ?? {}) as Record<string, string[]>;
}
function tenantPhones(r: ApiResp): string[] {
  return ((r.body as { phones?: string[] })?.phones ?? []) as string[];
}
function tenantId(r: ApiResp): string {
  return (r.body as { id: string }).id;
}

interface Account {
  accountId: string;
  token: string;
}

async function signup(label: string): Promise<Account> {
  const ownerEmail = `tpe-${label}-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email: ownerEmail, password, account_name: `TPE ${label}` },
  });
  if (su.status !== 200)
    throw new Error(`signup ${label}: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };
  return { accountId: b.account.id, token: b.session.access_token };
}

async function createTenant(a: Account, body: unknown): Promise<ApiResp> {
  return api('POST', `/v1/accounts/${a.accountId}/tenants`, { token: a.token, body });
}

async function patchTenant(a: Account, id: string, body: unknown): Promise<ApiResp> {
  return api('PATCH', `/v1/accounts/${a.accountId}/tenants/${id}`, { token: a.token, body });
}

// --- suite -------------------------------------------------------------------

const acct = await signup('main');

await check('create normalizes accepted spellings to E.164', async () => {
  const r = await createTenant(acct, {
    full_name: `N ${rnd()}`,
    phones: ['1-617-555-0100', '+1 (505) 555-0101'],
  });
  assertStatus(r, 201, 'create');
  const phones = tenantPhones(r);
  assert(
    phones.length === 2 && phones[0] === '+16175550100' && phones[1] === '+15055550101',
    `stored ${JSON.stringify(phones)}`,
  );
});

await check('two spellings of one number dedupe silently, first-seen order', async () => {
  const r = await createTenant(acct, {
    full_name: `D ${rnd()}`,
    phones: ['+16175550102', '1 (617) 555-0102'],
  });
  assertStatus(r, 201, 'create');
  const phones = tenantPhones(r);
  assert(phones.length === 1 && phones[0] === '+16175550102', `stored ${JSON.stringify(phones)}`);
});

await check('unresolvable phone 422s as invalid_phone naming it (create)', async () => {
  const r = await createTenant(acct, { full_name: `B ${rnd()}`, phones: ['not-a-phone'] });
  assertStatus(r, 422, 'create');
  assert(errCode(r) === 'invalid_phone', `code=${errCode(r)}`);
  const fe = errFieldErrors(r).phones ?? [];
  assert(
    fe.some((m) => m.includes('not-a-phone')),
    `fieldErrors=${JSON.stringify(fe)}`,
  );
});

await check('bare 10-digit input is refused — no server-side country guess', async () => {
  const r = await createTenant(acct, { full_name: `B10 ${rnd()}`, phones: ['617-555-0103'] });
  assertStatus(r, 422, 'create');
  assert(errCode(r) === 'invalid_phone', `code=${errCode(r)}`);
});

await check('PATCH normalizes and rejects the same way', async () => {
  const c = await createTenant(acct, { full_name: `P ${rnd()}` });
  assertStatus(c, 201, 'create');
  const id = tenantId(c);
  const ok = await patchTenant(acct, id, { phones: ['1 (415) 555-0104'] });
  assertStatus(ok, 200, 'patch ok');
  assert(tenantPhones(ok)[0] === '+14155550104', `stored ${JSON.stringify(tenantPhones(ok))}`);
  const bad = await patchTenant(acct, id, { phones: ['nope'] });
  assertStatus(bad, 422, 'patch bad');
  assert(errCode(bad) === 'invalid_phone', `code=${errCode(bad)}`);
});

await check('omitted and empty phones pass through untouched', async () => {
  const none = await createTenant(acct, { full_name: `E ${rnd()}` });
  assertStatus(none, 201, 'create none');
  assert(tenantPhones(none).length === 0, 'expected empty');
  const empty = await patchTenant(acct, tenantId(none), { phones: [] });
  assertStatus(empty, 200, 'patch empty');
  assert(tenantPhones(empty).length === 0, 'expected still empty');
});

await check('DB trigger stops a member writing raw phones via PostgREST', async () => {
  const direct = await pgrest('POST', 'tenants', acct.token, {
    account_id: acct.accountId,
    full_name: `Raw ${rnd()}`,
    phones: ['617-555-0199'],
  });
  // PostgREST surfaces the trigger's check_violation as a 4xx, never a 2xx.
  assert(direct.status >= 400, `expected trigger rejection, got ${direct.status}`);
  const msg = JSON.stringify(direct.body);
  assert(msg.includes('E.164'), `unexpected error body: ${msg}`);
});

// --- summary -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.info('\nAll tenant-phone-e164 checks passed');
