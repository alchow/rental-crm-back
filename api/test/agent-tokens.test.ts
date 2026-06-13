// ----------------------------------------------------------------------------
// Agent token exchange integration tests (ADR-0009 Phase 3).
//
// Covers:
//   (a) GET /v1/agent/accounts with valid X-Agent-Secret → 200; granted
//       account_id present in data.
//   (b) POST /v1/agent/tokens {account_id} with valid secret → 200;
//       access_token, refresh_token non-empty, token_type='bearer',
//       account_id matches, scopes is an array.
//   (c) minted token works: GET interactions as Bearer → 200; POST agent_event
//       with minted token → 201, author_type='agent'.
//   (d) missing X-Agent-Secret → 401; wrong secret → 401 (both endpoints).
//   (e) POST /v1/agent/tokens for ungranted account → 403 ('forbidden').
//   (f) revoke grant → account no longer in GET list; POST token → 403.
//   (g) Phase-4 RLS-denial mapping: mint token, POST agent_event (cache),
//       revoke grant, reuse SAME token → 403 (42501→403, not 500).
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
process.env.PORT = '8794';
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

// Import provisionRootSecret after env is set so the admin client picks up the
// right credentials (admin client is lazily initialised on first call).
const { provisionRootSecret } = await import('../src/admin/agent-tokens');
const { getAnonClient } = await import('../src/supabase/anon-client');

const app = buildApp();

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

/**
 * Thin fetch wrapper. Automatically adds an idempotency-key for mutating
 * requests against /v1/accounts/ paths (mirroring the harness used by the
 * other integration tests). Agent paths (/v1/agent/*) are NOT under
 * /v1/accounts/, so they never get the idempotency-key injected — correct by
 * the helper's design. Pass `agentSecret` to inject X-Agent-Secret.
 */
async function api(
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: unknown;
    idempotencyKey?: string;
    agentSecret?: string;
  } = {},
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

interface UserFixture {
  userId: string;
  accessToken: string;
  accountId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `at-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status}`);
  const b = su.body as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  return {
    userId: b.user.id,
    accessToken: b.session.access_token,
    accountId: b.account.id,
  };
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

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Agent token exchange integration tests (ADR-0009 Phase 3)');

  const owner = await setupUser('owner');
  const admin = getAdminClient();
  const grantsBase = `/v1/accounts/${owner.accountId}/agent-grants`;

  // Provision the agent identity + grant for the owner's account.
  const grantResp = await api('POST', grantsBase, { token: owner.accessToken });
  if (grantResp.status !== 201) {
    throw new Error(`setup: POST agent-grants failed: ${grantResp.status} ${JSON.stringify(grantResp.body)}`);
  }
  const grantBody = grantResp.body as { id: string; agent_user_id: string };
  let grantId = grantBody.id;

  // Provision the root secret (stores hash in DB, returns plaintext once).
  const principal = await provisionRootSecret('default');
  const rootSecret = principal.secret;

  // =========================================================================
  // (a) GET /v1/agent/accounts → 200; owner's account_id in data.
  // =========================================================================
  await check('(a) GET /v1/agent/accounts with valid secret → 200, account present', async () => {
    const r = await api('GET', '/v1/agent/accounts', { agentSecret: rootSecret });
    const body = assertStatus(r, 200, 'agent/accounts') as { data: { account_id: string }[] };
    const found = body.data.find((g) => g.account_id === owner.accountId);
    if (!found) {
      throw new Error(`account_id ${owner.accountId} not found in data: ${JSON.stringify(body.data)}`);
    }
  });

  // =========================================================================
  // (b) POST /v1/agent/tokens → 200; session shape correct.
  // =========================================================================
  let mintedAccessToken = '';
  let mintedRefreshToken = '';
  await check('(b) POST /v1/agent/tokens → 200, session shape correct', async () => {
    const r = await api('POST', '/v1/agent/tokens', {
      agentSecret: rootSecret,
      body: { account_id: owner.accountId },
    });
    const body = assertStatus(r, 200, 'agent/tokens') as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      account_id: string;
      scopes: unknown[];
    };
    if (!body.access_token || typeof body.access_token !== 'string') {
      throw new Error(`access_token missing or wrong type: ${body.access_token}`);
    }
    if (!body.refresh_token || typeof body.refresh_token !== 'string') {
      throw new Error(`refresh_token missing or wrong type: ${body.refresh_token}`);
    }
    if (body.token_type !== 'bearer') {
      throw new Error(`token_type: expected 'bearer', got '${body.token_type}'`);
    }
    if (body.account_id !== owner.accountId) {
      throw new Error(`account_id: expected ${owner.accountId}, got ${body.account_id}`);
    }
    if (!Array.isArray(body.scopes)) {
      throw new Error(`scopes not an array: ${JSON.stringify(body.scopes)}`);
    }
    mintedAccessToken = body.access_token;
    mintedRefreshToken = body.refresh_token;
    // Stored for use in (c) and (f2).
  });

  // =========================================================================
  // (c) Minted token works as a real Bearer: GET interactions → 200; POST
  //     agent_event → 201 with author_type='agent'.
  // =========================================================================
  await check('(c) minted token: GET interactions → 200', async () => {
    const r = await api('GET', `/v1/accounts/${owner.accountId}/interactions`, {
      token: mintedAccessToken,
    });
    assertStatus(r, 200, 'minted token GET interactions');
  });

  await check('(c) minted token: POST agent_event → 201, author_type=agent', async () => {
    const r = await api('POST', `/v1/accounts/${owner.accountId}/interactions`, {
      token: mintedAccessToken,
      body: {
        kind: 'agent_event',
        entry_type: 'proposal_created',
        approval_ref: 'tok-1',
        occurred_at: new Date().toISOString(),
      },
      idempotencyKey: `tok-test-${crypto.randomUUID()}`,
    });
    const row = assertStatus(r, 201, 'minted token POST agent_event') as Record<string, unknown>;
    if (row.author_type !== 'agent') {
      throw new Error(`author_type: expected 'agent', got '${row.author_type}'`);
    }
  });

  // =========================================================================
  // (d) missing X-Agent-Secret → 401; wrong secret → 401.
  // =========================================================================
  await check('(d) GET /v1/agent/accounts — missing secret → 401', async () => {
    const r = await api('GET', '/v1/agent/accounts');
    assertStatus(r, 401, 'missing secret on GET accounts');
  });

  await check('(d) GET /v1/agent/accounts — wrong secret → 401', async () => {
    const r = await api('GET', '/v1/agent/accounts', { agentSecret: 'bogus' });
    assertStatus(r, 401, 'wrong secret on GET accounts');
  });

  await check('(d) POST /v1/agent/tokens — missing secret → 401', async () => {
    const r = await api('POST', '/v1/agent/tokens', {
      body: { account_id: owner.accountId },
    });
    assertStatus(r, 401, 'missing secret on POST tokens');
  });

  await check('(d) POST /v1/agent/tokens — wrong secret → 401', async () => {
    const r = await api('POST', '/v1/agent/tokens', {
      agentSecret: 'bogus',
      body: { account_id: owner.accountId },
    });
    assertStatus(r, 401, 'wrong secret on POST tokens');
  });

  // =========================================================================
  // (e) POST /v1/agent/tokens for an account the principal has no grant for
  //     → 403 ('forbidden').
  // =========================================================================
  await check('(e) POST /v1/agent/tokens for ungranted account → 403 forbidden', async () => {
    const randomAccountId = crypto.randomUUID();
    const r = await api('POST', '/v1/agent/tokens', {
      agentSecret: rootSecret,
      body: { account_id: randomAccountId },
    });
    assertStatus(r, 403, 'ungranted account token request');
    if (errCode(r) !== 'forbidden') throw new Error(`code: ${errCode(r)}`);
  });

  // =========================================================================
  // (f) Revoke the grant → account absent from GET /v1/agent/accounts;
  //     POST /v1/agent/tokens for that account → 403.
  // =========================================================================
  await check('(f) revoke grant → account no longer listed; POST tokens → 403', async () => {
    // Revoke the grant via the owner.
    const revokeResp = await api(
      'POST',
      `/v1/accounts/${owner.accountId}/agent-grants/${grantId}/revoke`,
      { token: owner.accessToken },
    );
    assertStatus(revokeResp, 200, 'revoke grant');

    // Account should no longer appear in the list.
    const listResp = await api('GET', '/v1/agent/accounts', { agentSecret: rootSecret });
    const listBody = assertStatus(listResp, 200, 'agent/accounts after revoke') as {
      data: { account_id: string }[];
    };
    const stillPresent = listBody.data.find((g) => g.account_id === owner.accountId);
    if (stillPresent) {
      throw new Error(`account_id ${owner.accountId} still listed after revoke`);
    }

    // Minting a token for the revoked account → 403.
    const tokenResp = await api('POST', '/v1/agent/tokens', {
      agentSecret: rootSecret,
      body: { account_id: owner.accountId },
    });
    assertStatus(tokenResp, 403, 'token after revoke');
    if (errCode(tokenResp) !== 'forbidden') throw new Error(`code: ${errCode(tokenResp)}`);
  });

  // =========================================================================
  // (f2) Refresh token dies on revoke: the refresh_token captured in (b) must
  //      no longer be exchangeable for a new session after the grant is revoked
  //      in (f). This is the regression guard for the best-effort GoTrue
  //      sign-out added to revokeAgentGrant (Goal 1, ADR-0009 SHOULD):
  //      WITHOUT that sign-out call, the GoTrue session would still be alive
  //      and refreshSession() would succeed here — proving the sign-out closed
  //      the refresh-token window.
  //
  //      RLS is the hard floor (data is already denied), but this asserts the
  //      belt-and-suspenders layer works: the refresh token itself is dead.
  // =========================================================================
  await check('(f2) refresh_token from (b) is dead after grant revoke in (f)', async () => {
    if (!mintedRefreshToken) {
      throw new Error('mintedRefreshToken not set (case (b) must pass first)');
    }
    const anonClient = getAnonClient();
    const { data, error } = await anonClient.auth.refreshSession({ refresh_token: mintedRefreshToken });
    // The refresh must fail: either an error is returned, or the session is null.
    // A successful refresh (data.session non-null and error null) means the
    // sign-out did NOT invalidate the refresh token -- that is the regression.
    if (!error && data?.session) {
      throw new Error(
        `refresh_token was still exchangeable after revoke (revokeAgentGrant sign-out regression): ` +
          `got session user=${data.session.user?.id}`,
      );
    }
  });

  // =========================================================================
  // (g) Phase-4 RLS-denial mapping: mint a fresh token (re-enable first), use
  //     it to POST an agent_event (establishes membership-cache hit in the
  //     middleware), then revoke the grant, then immediately reuse the SAME
  //     token to POST another agent_event → expect 403 (the DB's 42501
  //     permission denied is mapped to 403), not 500.
  //
  // NOTE: this relies on the membership-cache (default 45 s TTL) still holding
  // within the test, so the middleware admits the request while RLS denies the
  // DB write. If the cache TTL is ever reduced to zero, the middleware itself
  // will return 403 earlier (same observable status, stronger guarantee).
  // =========================================================================
  await check('(g) RLS-denial mapping: revoked grant + reused token → 403, not 500', async () => {
    // Re-enable the grant so we can mint a fresh token.
    const reenableResp = await api('POST', grantsBase, { token: owner.accessToken });
    assertStatus(reenableResp, 201, 're-enable for (g)');
    const reenableBody = reenableResp.body as { id: string };
    grantId = reenableBody.id;

    // Mint a fresh per-account session.
    const freshTokenResp = await api('POST', '/v1/agent/tokens', {
      agentSecret: rootSecret,
      body: { account_id: owner.accountId },
    });
    const freshToken = (
      assertStatus(freshTokenResp, 200, 'fresh token for (g)') as { access_token: string }
    ).access_token;

    // First POST: establishes the membership-cache entry.
    const firstPost = await api('POST', `/v1/accounts/${owner.accountId}/interactions`, {
      token: freshToken,
      body: {
        kind: 'agent_event',
        entry_type: 'proposal_created',
        approval_ref: 'rls-test-first',
        occurred_at: new Date().toISOString(),
      },
      idempotencyKey: `rls-first-${crypto.randomUUID()}`,
    });
    assertStatus(firstPost, 201, '(g) first POST succeeds');

    // Revoke the grant — the agent_user_id's membership is soft-deleted.
    const revokeResp2 = await api(
      'POST',
      `/v1/accounts/${owner.accountId}/agent-grants/${grantId}/revoke`,
      { token: owner.accessToken },
    );
    assertStatus(revokeResp2, 200, '(g) revoke for RLS test');

    // Immediately reuse the SAME token. The middleware may still admit the
    // request from the cache, but RLS denies the DB write (42501). The handler
    // must map that to 403, not 500.
    const secondPost = await api('POST', `/v1/accounts/${owner.accountId}/interactions`, {
      token: freshToken,
      body: {
        kind: 'agent_event',
        entry_type: 'proposal_created',
        approval_ref: 'rls-test-second',
        occurred_at: new Date().toISOString(),
      },
      idempotencyKey: `rls-second-${crypto.randomUUID()}`,
    });

    // Verify via admin that the revoked membership is gone, so the DB hit is RLS.
    const { data: membership, error: memErr } = await admin
      .from('account_members')
      .select('deleted_at')
      .eq('account_id', owner.accountId)
      .eq('user_id', grantBody.agent_user_id)
      .eq('role', 'agent')
      .maybeSingle();
    if (memErr) throw new Error(`admin membership query: ${memErr.message}`);
    if (!membership?.deleted_at) {
      throw new Error(`membership not soft-deleted as expected; RLS test premise broken`);
    }

    // The key assertion: 403 (not 500, not 200).
    if (secondPost.status !== 403) {
      throw new Error(
        `(g) expected 403 from RLS denial mapping, got ${secondPost.status} body=${JSON.stringify(secondPost.body)}`,
      );
    }
  });

  // --- done -----------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:`);
    for (const f of failures) {
      console.error(`  FAIL  ${f.name}: ${f.detail}`);
    }
    process.exit(1);
  }
  console.info('All checks passed.');
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
