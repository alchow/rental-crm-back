// ----------------------------------------------------------------------------
// account-flags integration tests (MT-3 ask 2 -- authoritative legal_hold).
//
// Covers:
//   (a) settings row auto-provisioned on signup; GET → 200 { legal_hold:false }.
//   (b) owner PATCH legal_hold:true → 200 { legal_hold:true }; GET reflects it.
//   (c) the AGENT principal can READ flags (its authoritative legal_hold read).
//   (d) the agent principal CANNOT write flags → 403 (read-only).
//   (e) a non-member cannot read another account's flags → 404.
//   (f) the legal_hold toggle is audited (hash-chained event emitted).
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

const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { buildApp } = await import('../src/app');
const { provisionRootSecret } = await import('../src/admin/agent-tokens');

const app = buildApp();

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface UserFixture { userId: string; accessToken: string; accountId: string }

async function setupUser(label: string): Promise<UserFixture> {
  const email = `af-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { user: { id: string }; account: { id: string }; session: { access_token: string } };
  return { userId: b.user.id, accessToken: b.session.access_token, accountId: b.account.id };
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.info(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`); }
}
function assertStatus(r: ApiResp, expected: number, ctx: string): unknown {
  if (r.status !== expected) {
    throw new Error(`${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`);
  }
  return r.body;
}
function flags(r: ApiResp): { legal_hold?: boolean } {
  return (r.body ?? {}) as { legal_hold?: boolean };
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('account-flags integration tests (MT-3 ask 2)');

  const owner = await setupUser('owner');
  const other = await setupUser('other');
  const base = `/v1/accounts/${owner.accountId}/account-flags`;

  // (a) auto-provisioned row + default read.
  await check('(a) GET account-flags → 200, default legal_hold=false', async () => {
    const r = await api('GET', base, { token: owner.accessToken });
    assertStatus(r, 200, 'GET flags');
    const body = flags(r);
    if (body.legal_hold !== false) throw new Error(`expected legal_hold=false, got ${body.legal_hold}`);
    // The row must actually exist (not the fail-safe default branch).
    const admin = getAdminClient();
    const { data } = await admin.from('account_settings').select('id').eq('account_id', owner.accountId).maybeSingle();
    if (!data) throw new Error('account_settings row was not auto-provisioned on signup');
  });

  // (b) owner write + read-back.
  await check('(b) owner PATCH legal_hold=true → 200, GET reflects it', async () => {
    const r = await api('PATCH', base, { token: owner.accessToken, body: { legal_hold: true } });
    assertStatus(r, 200, 'PATCH flags');
    const body = flags(r);
    if (body.legal_hold !== true) throw new Error(`PATCH returned legal_hold=${body.legal_hold}`);
    const g = await api('GET', base, { token: owner.accessToken });
    if (flags(g).legal_hold !== true) throw new Error(`GET after PATCH not true: ${JSON.stringify(g.body)}`);
  });

  // Provision an agent grant + mint a per-account agent session for this account.
  const grantResp = await api('POST', `/v1/accounts/${owner.accountId}/agent-grants`, { token: owner.accessToken });
  if (grantResp.status !== 201) {
    throw new Error(`setup: enable agent failed: ${grantResp.status} ${JSON.stringify(grantResp.body)}`);
  }
  const rootSecret = (await provisionRootSecret('default')).secret;
  const mintHeaders = { accept: 'application/json', 'content-type': 'application/json', 'x-agent-secret': rootSecret };
  const mintRes = await app.fetch(new Request('http://test/v1/agent/tokens', {
    method: 'POST', headers: mintHeaders, body: JSON.stringify({ account_id: owner.accountId }),
  }));
  const agentToken = ((await mintRes.json()) as { access_token: string }).access_token;
  if (!agentToken) throw new Error('failed to mint agent token');

  // (c) the agent principal can READ flags -- the whole point of ask 2.
  await check('(c) agent principal GET account-flags → 200, reads legal_hold=true', async () => {
    const r = await api('GET', base, { token: agentToken });
    assertStatus(r, 200, 'agent GET flags');
    const body = flags(r);
    if (body.legal_hold !== true) throw new Error(`agent read legal_hold=${body.legal_hold}, expected true`);
  });

  // (d) the agent principal CANNOT write flags.
  await check('(d) agent principal PATCH account-flags → 403 (read-only)', async () => {
    const r = await api('PATCH', base, { token: agentToken, body: { legal_hold: false } });
    assertStatus(r, 403, 'agent PATCH flags');
    // and the value is unchanged
    const g = await api('GET', base, { token: owner.accessToken });
    if (flags(g).legal_hold !== true) throw new Error('agent PATCH unexpectedly changed the flag');
  });

  // (e) a non-member cannot read another account's flags.
  await check('(e) non-member GET another account flags → 404', async () => {
    const r = await api('GET', base, { token: other.accessToken });
    assertStatus(r, 404, 'non-member GET flags');
  });

  // (f) the toggle is audited.
  await check('(f) legal_hold toggle emitted a hash-chained audit event', async () => {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('events')
      .select('event_type, entity_type')
      .eq('account_id', owner.accountId)
      .eq('entity_type', 'account_settings');
    if (error) throw new Error(`events query failed: ${error.message}`);
    const types = (data ?? []).map((e) => e.event_type);
    if (!types.includes('inserted')) throw new Error(`no 'inserted' event for account_settings (auto-provision)`);
    if (!types.includes('updated')) throw new Error(`no 'updated' event for the legal_hold PATCH`);
    // Chain integrity must hold after the writes.
    const { data: vc } = await admin.rpc('verify_chain', { p_account_id: owner.accountId });
    const row = (Array.isArray(vc) ? vc[0] : vc) as { ok?: boolean } | null;
    if (!row?.ok) throw new Error(`verify_chain not ok: ${JSON.stringify(row)}`);
  });

  if (failures.length) {
    console.error(`\nFAILED: ${failures.length} check(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.info('\nOK: account-flags (legal_hold) checks all green');
}

await main().catch((err) => { console.error(err); process.exit(1); });
