// ----------------------------------------------------------------------------
// REGRESSION: agent_grants <-> account_members invariant (incident 2026-06-25).
//
// Before the fix, request authorization keyed off account_members.deleted_at
// while discovery + token mint keyed off agent_grants.revoked_at, and nothing
// kept them consistent. A soft-deleted agent membership + an active grant left
// the agent in a permanent 404 loop (advertised + minting tokens, but 404 on
// every account-scoped read) with no self-recovery.
//
// Migration 20260625000001 makes agent_grants the single source of truth:
//   (A) a trigger projects the membership from the grant;
//   (B) a guard refuses an out-of-band soft-delete of an agent membership while
//       an active grant exists (the incident vector);
//   (C) a backfill reconciles existing rows.
//
// This test asserts the invariant. It FAILS on pre-fix code: the out-of-band
// soft-delete in step 2 would succeed and the agent reads would 404.
//
// Membership cache is OFF (MEMBERSHIP_CACHE_TTL_MS=0) so every read hits the DB
// live and assertions are deterministic.
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
process.env.MEMBERSHIP_CACHE_TTL_MS = '0';

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

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string; agentSecret?: string } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.agentSecret) headers['x-agent-secret'] = opts.agentSecret;
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
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface UserFixture { userId: string; accessToken: string; accountId: string }

async function setupUser(label: string): Promise<UserFixture> {
  const email = `div-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { user: { id: string }; account: { id: string }; session: { access_token: string } };
  return { userId: b.user.id, accessToken: b.session.access_token, accountId: b.account.id };
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

// --- test -------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Agent grant<->membership invariant (incident 2026-06-25 regression)');

  const owner = await setupUser('owner');
  const admin = getAdminClient();
  const base = `/v1/accounts/${owner.accountId}/agent-grants`;

  const grantResp = await api('GET', base, { token: owner.accessToken });
  if (grantResp.status !== 200) {
    throw new Error(`setup: GET agent-grants failed: ${grantResp.status} ${JSON.stringify(grantResp.body)}`);
  }
  const grant = (grantResp.body as { data: { id: string; agent_user_id: string; revoked_at: string | null }[] })
    .data.find((g) => g.revoked_at === null);
  if (!grant) throw new Error('setup: no active agent grant after signup');
  let grantId = grant.id;
  const agentUserId = grant.agent_user_id;

  const rootSecret = (await provisionRootSecret('default')).secret;

  const SEARCH = `/v1/accounts/${owner.accountId}/search?q=test`;
  const EVENTS = `/v1/accounts/${owner.accountId}/events`;

  async function mintAgentToken(ctx: string): Promise<string> {
    const r = await api('POST', '/v1/agent/tokens', {
      agentSecret: rootSecret,
      body: { account_id: owner.accountId },
    });
    return (assertStatus(r, 200, ctx) as { access_token: string }).access_token;
  }
  async function membershipDeletedAt(): Promise<string | null | undefined> {
    const { data, error } = await admin
      .from('account_members')
      .select('deleted_at')
      .eq('account_id', owner.accountId).eq('user_id', agentUserId).eq('role', 'agent')
      .maybeSingle();
    if (error) throw new Error(`admin membership query: ${error.message}`);
    return data?.deleted_at as string | null | undefined;
  }
  async function discoveryListsAccount(): Promise<boolean> {
    const r = await api('GET', '/v1/agent/accounts', { agentSecret: rootSecret });
    const body = assertStatus(r, 200, 'agent/accounts') as { data: { account_id: string }[] };
    return Boolean(body.data.find((g) => g.account_id === owner.accountId));
  }

  // 1) BASELINE — healthy: membership live, grant active.
  const agentToken = await mintAgentToken('baseline mint');
  await check('1) BASELINE agent token: /search and /events → 200; discovery lists account', async () => {
    assertStatus(await api('GET', SEARCH, { token: agentToken }), 200, 'agent /search baseline');
    assertStatus(await api('GET', EVENTS, { token: agentToken }), 200, 'agent /events baseline');
    if (!(await discoveryListsAccount())) throw new Error('account not listed at baseline');
  });

  // 2) GUARD — an out-of-band soft-delete of the agent membership while the
  //    grant is active is REFUSED. Pre-fix this succeeded and caused the 404
  //    loop; now it errors and the agent keeps reading.
  await check('2) GUARD: out-of-band membership soft-delete is rejected; reads stay 200', async () => {
    const nowIso = new Date().toISOString();
    const { error } = await admin
      .from('account_members')
      .update({ deleted_at: nowIso, updated_at: nowIso })
      .eq('account_id', owner.accountId).eq('user_id', agentUserId).eq('role', 'agent')
      .is('deleted_at', null);
    if (!error) {
      throw new Error('out-of-band soft-delete was NOT rejected (guard trigger missing) — this is the bug');
    }
    if ((await membershipDeletedAt()) != null) {
      throw new Error('membership was soft-deleted despite the guard');
    }
    // The divergence never formed, so the agent keeps reading.
    assertStatus(await api('GET', SEARCH, { token: agentToken }), 200, 'agent /search after blocked delete');
    assertStatus(await api('GET', EVENTS, { token: agentToken }), 200, 'agent /events after blocked delete');
  });

  // 3) SUPPORTED REVOKE breaks cleanly — authz and discovery now AGREE. The
  //    membership is soft-deleted (by the trigger) AND the account drops out of
  //    discovery, so the agent stops trying. A 404 here is correct (revoked),
  //    NOT a permanent loop: the agent is no longer told it serves the account.
  await check('3) revoke → membership soft-deleted (trigger) AND account drops from discovery', async () => {
    assertStatus(await api('POST', `${base}/${grantId}/revoke`, { token: owner.accessToken }), 200, 'revoke');
    if ((await membershipDeletedAt()) == null) {
      throw new Error('membership not soft-deleted by the agent_grants trigger after revoke');
    }
    assertStatus(await api('GET', SEARCH, { token: agentToken }), 404, 'agent /search after revoke');
    if (await discoveryListsAccount()) {
      throw new Error('account STILL listed after revoke — authz/discovery disagree (the loop)');
    }
  });

  // 4) RECOVERY — re-enable projects the membership live again (forward
  //    direction of the invariant); the agent reads 200 once more.
  await check('4) re-enable → membership live again (trigger), fresh token reads 200', async () => {
    const re = await api('POST', base, { token: owner.accessToken });
    assertStatus(re, 201, 're-enable');
    grantId = (re.body as { id: string }).id;
    if ((await membershipDeletedAt()) != null) {
      throw new Error('membership not re-activated after re-enable');
    }
    const freshToken = await mintAgentToken('fresh mint after re-enable');
    assertStatus(await api('GET', SEARCH, { token: freshToken }), 200, 'agent /search after re-enable');
    assertStatus(await api('GET', EVENTS, { token: freshToken }), 200, 'agent /events after re-enable');
  });

  // --- done -----------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  FAIL  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('All checks passed — the grant<->membership invariant holds.');
}

main().catch((e) => { console.error('Unexpected error:', e); process.exit(1); });
