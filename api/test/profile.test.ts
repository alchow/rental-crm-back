// ----------------------------------------------------------------------------
// Landlord profile (public.users) DoD checks — GET/PATCH /v1/profile.
//
// Covers:
//   (A) GET returns the caller's own row (id/display_name/phone); phone is
//       null until set.
//   (B) PATCH normalises a loosely-formatted number to E.164 and persists it;
//       a re-GET reads it back.
//   (C) An E.164 number passes through unchanged; a number that cannot be
//       normalised (e.g. bare 10-digit NANP, no country code) → 422
//       'invalid_phone' and nothing is written.
//   (D) phone:null clears the stored number; display_name updates leave the
//       phone untouched; an empty patch → 400 'invalid_request'.
//   (E) Self-scope: the row is keyed off auth.uid(), so user A setting a phone
//       never touches user B's profile, and an unauthenticated call → 401.
//
// Runs against the full local Supabase stack (see api-isolation.test.ts).
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';

interface SupabaseStatus {
  API_URL: string;
  DB_URL: string;
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
    DB_URL: get('DB_URL'),
    ANON_KEY: get('ANON_KEY'),
    SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY'),
  };
}

const status = readSupabaseStatus();
process.env.NODE_ENV = 'test';
process.env.PORT = '8795';
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

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface SignupResult { userId: string; accessToken: string }

async function signup(label: string): Promise<SignupResult> {
  const email = `prof-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { user: { id: string }; session: { access_token: string } };
  return { userId: b.user.id, accessToken: b.session.access_token };
}

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
function assertStatus(r: ApiResp, expected: number, ctx: string): unknown {
  if (r.status !== expected) throw new Error(
    `${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`,
  );
  return r.body;
}
function errCode(r: ApiResp): string {
  return ((r.body as { error?: { code?: string } })?.error?.code) ?? '';
}

interface ProfileRow { id: string; display_name: string | null; phone: string | null }

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  const A = await signup('a');
  const B = await signup('b');

  // (A) GET returns the caller's own row; phone is null until set.
  await check('GET /profile returns own row with null phone', async () => {
    const r = await api('GET', '/v1/profile', { token: A.accessToken });
    const p = assertStatus(r, 200, 'GET profile') as ProfileRow;
    if (p.id !== A.userId) throw new Error(`id mismatch: ${p.id} !== ${A.userId}`);
    if (p.phone !== null) throw new Error(`expected null phone, got ${JSON.stringify(p.phone)}`);
  });

  // (B) PATCH normalises a loosely-formatted NANP number to E.164 + persists.
  await check('PATCH normalises "1 (555) 123-4567" -> +15551234567 and persists', async () => {
    const r = await api('PATCH', '/v1/profile', { token: A.accessToken, body: { phone: '1 (555) 123-4567' } });
    const p = assertStatus(r, 200, 'PATCH phone') as ProfileRow;
    if (p.phone !== '+15551234567') throw new Error(`stored ${JSON.stringify(p.phone)}, expected +15551234567`);
    const g = await api('GET', '/v1/profile', { token: A.accessToken });
    if ((g.body as ProfileRow).phone !== '+15551234567') throw new Error('phone did not persist across GET');
  });

  // (C1) An already-E.164 number passes through unchanged.
  await check('PATCH accepts an E.164 number unchanged', async () => {
    const r = await api('PATCH', '/v1/profile', { token: A.accessToken, body: { phone: '+447911123456' } });
    const p = assertStatus(r, 200, 'PATCH e164') as ProfileRow;
    if (p.phone !== '+447911123456') throw new Error(`stored ${JSON.stringify(p.phone)}`);
  });

  // (C2) A bare 10-digit NANP number (no country code) cannot be normalised.
  //      normalizePhone deliberately refuses to guess a country code, so the
  //      handler must 422 'invalid_phone' and write nothing.
  await check('PATCH rejects un-normalisable phone with 422 invalid_phone', async () => {
    const r = await api('PATCH', '/v1/profile', { token: A.accessToken, body: { phone: '5551234567' } });
    assertStatus(r, 422, 'PATCH bad phone');
    if (errCode(r) !== 'invalid_phone') throw new Error(`code: ${errCode(r)}`);
    // The prior E.164 value must be untouched.
    const g = await api('GET', '/v1/profile', { token: A.accessToken });
    if ((g.body as ProfileRow).phone !== '+447911123456') throw new Error('rejected write must not clobber stored phone');
  });

  // (D1) phone:null clears the stored number.
  await check('PATCH phone:null clears the number', async () => {
    const r = await api('PATCH', '/v1/profile', { token: A.accessToken, body: { phone: null } });
    const p = assertStatus(r, 200, 'PATCH clear') as ProfileRow;
    if (p.phone !== null) throw new Error(`expected null, got ${JSON.stringify(p.phone)}`);
  });

  // (D2) display_name update leaves phone untouched.
  await check('PATCH display_name leaves phone untouched', async () => {
    await api('PATCH', '/v1/profile', { token: A.accessToken, body: { phone: '+15550009999' } });
    const r = await api('PATCH', '/v1/profile', { token: A.accessToken, body: { display_name: 'Jane Landlord' } });
    const p = assertStatus(r, 200, 'PATCH display_name') as ProfileRow;
    if (p.display_name !== 'Jane Landlord') throw new Error(`display_name: ${JSON.stringify(p.display_name)}`);
    if (p.phone !== '+15550009999') throw new Error(`phone changed: ${JSON.stringify(p.phone)}`);
  });

  // (D3) empty patch -> 400 invalid_request (the uniform validation envelope).
  await check('PATCH empty body -> 400 invalid_request', async () => {
    const r = await api('PATCH', '/v1/profile', { token: A.accessToken, body: {} });
    assertStatus(r, 400, 'PATCH empty');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  // (E1) Self-scope: A's writes never touched B's profile.
  await check('user B profile is independent of A', async () => {
    const r = await api('GET', '/v1/profile', { token: B.accessToken });
    const p = assertStatus(r, 200, 'GET B profile') as ProfileRow;
    if (p.id !== B.userId) throw new Error(`id mismatch: ${p.id} !== ${B.userId}`);
    if (p.phone !== null) throw new Error(`B phone should be null, got ${JSON.stringify(p.phone)}`);
  });

  // (E2) Unauthenticated -> 401.
  await check('GET /profile without a token -> 401', async () => {
    const r = await api('GET', '/v1/profile');
    assertStatus(r, 401, 'GET no-token');
  });

  // --- summary ---------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\n${failures.length} profile failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nAll profile checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
