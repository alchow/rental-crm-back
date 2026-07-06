// ----------------------------------------------------------------------------
// Persona-address resolution integration tests (Phase 1 of the persona email
// plan). Exercised against a real Supabase stack (GoTrue + PostgREST + RLS).
//
// GET /v1/comms/resolve-persona-address?address=<local>@<sub>.<parent> is the
// transport's cold-inbound directory lookup: account-agnostic (mounted outside
// /accounts/*), agent-gated, uniform-404. These assert:
//   * the agent transport resolves a configured persona to its account_id;
//   * matching is trim+lowercase on the full address;
//   * unknown local parts, unknown subdomains, foreign domains, and
//     multi-label subdomains are all uniform 404s;
//   * a persona of an account the caller does NOT transport is a uniform 404
//     (RLS fence), and a landlord probing their own persona is a uniform 404
//     (role fence) — no oracle anywhere;
//   * an account with a subdomain but NO persona_local_part does not resolve.
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
process.env.PORT = '8802';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

// Persona resolution is branded-subdomain-only; the parent must be set at
// BOOT, before env/app snapshot it.
const SUFFIX = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');
process.env.EMAIL_PLATFORM_PARENT_DOMAIN = `mail-${SUFFIX}.test`;
const PARENT = process.env.EMAIL_PLATFORM_PARENT_DOMAIN;

const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const admin = getAdminClient();

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
function assertStatus(r: ApiResp, expected: number, ctx: string): unknown {
  if (r.status !== expected) throw new Error(
    `${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`,
  );
  return r.body;
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function createAuthUser(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = `persona-${label}-${crypto.randomUUID()}@internal.test`;
  const password = `pw-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data?.user) throw new Error(`createUser ${label}: ${error?.message}`);
  return { id: data.user.id, email, password };
}

async function login(email: string, password: string): Promise<string> {
  const r = await api('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return (r.body as { session: { access_token: string } }).session.access_token;
}

interface Signup { accountId: string; token: string }
async function signup(name: string): Promise<Signup> {
  const email = `persona-owner-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', { body: { email, password, account_name: name } });
  if (su.status !== 200) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };
  return { accountId: b.account.id, token: b.session.access_token };
}

const RESOLVE = '/v1/comms/resolve-persona-address';

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Persona-address resolution integration tests');

  // Account A: branded + persona; the agent transports it.
  const a = await signup('Persona Acct A');
  // Account B: branded + persona; the agent does NOT transport it.
  const b = await signup('Persona Acct B');
  // Account C: branded but NO persona; the agent transports it.
  const c = await signup('Persona Acct C');

  const SUB_A = `pa${SUFFIX}`;
  const SUB_B = `pb${SUFFIX}`;
  const SUB_C = `pc${SUFFIX}`;

  for (const [acct, sub, persona] of [
    [a, SUB_A, 'riley'],
    [b, SUB_B, 'riley'],
    [c, SUB_C, null],
  ] as const) {
    const body: Record<string, unknown> = { email_subdomain: sub };
    if (persona !== null) body.persona_local_part = persona;
    const r = await api('PATCH', `/v1/accounts/${acct.accountId}/email-branding`, {
      token: acct.token, body,
    });
    if (r.status !== 200) throw new Error(`branding setup ${sub}: ${r.status} ${JSON.stringify(r.body)}`);
  }

  // The agent transport: agent-role member of A and C only.
  const agentAuth = await createAuthUser('agent');
  for (const acctId of [a.accountId, c.accountId]) {
    const { error } = await admin.from('account_members').insert({
      account_id: acctId, user_id: agentAuth.id, role: 'agent',
    });
    if (error) throw new Error(`agent membership: ${error.message}`);
  }
  const agentToken = await login(agentAuth.email, agentAuth.password);

  const ADDR_A = `riley@${SUB_A}.${PARENT}`;

  await check('agent resolves a configured persona → 200 {account_id}', async () => {
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent(ADDR_A)}`, { token: agentToken });
    const body = assertStatus(r, 200, 'resolve A') as { account_id: string };
    assert(body.account_id === a.accountId, `account_id: ${body.account_id}`);
  });

  await check('matching is trim + lowercase on the full address', async () => {
    const noisy = `  RILEY@${SUB_A.toUpperCase()}.${PARENT.toUpperCase()}  `;
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent(noisy)}`, { token: agentToken });
    const body = assertStatus(r, 200, 'noisy resolve') as { account_id: string };
    assert(body.account_id === a.accountId, `account_id: ${body.account_id}`);
  });

  await check('unknown local part on a real subdomain → 404', async () => {
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent(`casey@${SUB_A}.${PARENT}`)}`, { token: agentToken });
    assertStatus(r, 404, 'unknown local part');
  });

  await check('unknown subdomain → 404', async () => {
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent(`riley@nope${SUFFIX}.${PARENT}`)}`, { token: agentToken });
    assertStatus(r, 404, 'unknown subdomain');
  });

  await check('domain outside the platform parent → 404', async () => {
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent('riley@example.com')}`, { token: agentToken });
    assertStatus(r, 404, 'foreign domain');
  });

  await check('multi-label subdomain under the parent → 404', async () => {
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent(`riley@x.${SUB_A}.${PARENT}`)}`, { token: agentToken });
    assertStatus(r, 404, 'multi-label');
  });

  await check('persona of an account the caller does not transport → uniform 404', async () => {
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent(`riley@${SUB_B}.${PARENT}`)}`, { token: agentToken });
    assertStatus(r, 404, 'foreign account');
  });

  await check('branded account WITHOUT a persona local part → 404', async () => {
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent(`riley@${SUB_C}.${PARENT}`)}`, { token: agentToken });
    assertStatus(r, 404, 'persona unset');
  });

  await check('a landlord probing their own persona → uniform 404 (role fence)', async () => {
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent(ADDR_A)}`, { token: a.token });
    assertStatus(r, 404, 'landlord probe');
  });

  await check('unauthenticated → 401', async () => {
    const r = await api('GET', `${RESOLVE}?address=${encodeURIComponent(ADDR_A)}`);
    assertStatus(r, 401, 'no token');
  });

  // --- summary ---------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} persona-resolve check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: persona-resolve checks all green');
}

await main();
