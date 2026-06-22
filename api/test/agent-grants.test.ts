// ----------------------------------------------------------------------------
// Agent grant integration tests (ADR-0009 Phase 2).
//
// Covers:
//   (a) owner enables agent → 201; agent_user_id is a uuid, granted_by ==
//       owner's userId, revoked_at === null.
//   (b) GET list → 200, the active grant present.
//   (c) owner re-enables while active → 409 ('conflict').
//   (d) via admin client, assert role='agent' membership exists with
//       deleted_at null. Capture agent_user_id.
//   (e) owner revokes grant → 200, revoked_at non-null. Assert role='agent'
//       membership now has deleted_at set.
//   (f) owner re-enables after revoke → 201; new grant's agent_user_id ===
//       captured user_id from (d) (identity reuse).
//   (g) viewer member attempts enable → 403 ('forbidden').
//   (h) non-member (second account owner) attempts enable on first account
//       → 404 (membership middleware).
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
process.env.PORT = '8793';
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

const app = buildApp();

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

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
  const email = `ag-${label}-${rnd()}@example.test`;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Agent grant integration tests');

  const owner = await setupUser('owner');
  const admin = getAdminClient();
  const base = `/v1/accounts/${owner.accountId}/agent-grants`;

  let grantId = '';
  let capturedAgentUserId = '';

  // =========================================================================
  // (a) signup auto-enables the agent (default-on): the new account already
  //     has exactly one active grant, granted_by=owner, revoked_at=null,
  //     uuid agent_user_id -- no owner POST required.
  // =========================================================================
  await check('(a) signup auto-enabled agent → one active grant, shape correct', async () => {
    const r = await api('GET', base, { token: owner.accessToken });
    assertStatus(r, 200, 'list');
    const { data } = r.body as { data: Record<string, unknown>[] };
    const active = data.filter((g) => g.revoked_at === null);
    if (active.length !== 1) {
      throw new Error(`expected exactly 1 active grant after signup, got ${active.length}`);
    }
    const grant = active[0]!;
    grantId = grant.id as string;
    if (!UUID_RE.test(grant.agent_user_id as string)) {
      throw new Error(`agent_user_id not a uuid: ${grant.agent_user_id}`);
    }
    if (grant.granted_by !== owner.userId) {
      throw new Error(`granted_by: expected ${owner.userId}, got ${grant.granted_by}`);
    }
    if (grant.revoked_at !== null) {
      throw new Error(`revoked_at should be null, got ${grant.revoked_at}`);
    }
  });

  // =========================================================================
  // (b) GET list → 200, active grant present.
  // =========================================================================
  await check('(b) GET list → 200, active grant present', async () => {
    const r = await api('GET', base, { token: owner.accessToken });
    assertStatus(r, 200, 'list');
    const { data } = r.body as { data: Record<string, unknown>[] };
    const found = data.find((g) => g.id === grantId);
    if (!found) throw new Error(`grant ${grantId} not found in list`);
    if (found.revoked_at !== null) throw new Error(`grant in list has revoked_at set`);
  });

  // =========================================================================
  // (c) owner re-enables while active → 409 ('conflict').
  // =========================================================================
  await check('(c) re-enable while active → 409 conflict', async () => {
    const r = await api('POST', base, { token: owner.accessToken });
    assertStatus(r, 409, 're-enable conflict');
    if (errCode(r) !== 'conflict') throw new Error(`code: ${errCode(r)}`);
  });

  // =========================================================================
  // (d) via admin client, role='agent' membership exists with deleted_at null.
  //     Capture agent_user_id.
  // =========================================================================
  await check('(d) agent membership active in DB, capture agent_user_id', async () => {
    // Fetch the grant to get agent_user_id.
    const r = await api('GET', base, { token: owner.accessToken });
    assertStatus(r, 200, 'list for (d)');
    const { data } = r.body as { data: Record<string, unknown>[] };
    const grant = data.find((g) => g.id === grantId);
    if (!grant) throw new Error(`grant not in list`);
    capturedAgentUserId = grant.agent_user_id as string;

    const { data: membership, error } = await admin
      .from('account_members')
      .select('user_id, deleted_at')
      .eq('account_id', owner.accountId)
      .eq('user_id', capturedAgentUserId)
      .eq('role', 'agent')
      .maybeSingle();
    if (error) throw new Error(`admin query: ${error.message}`);
    if (!membership) throw new Error(`role=agent membership not found`);
    if (membership.deleted_at !== null) {
      throw new Error(`membership deleted_at should be null, got ${membership.deleted_at}`);
    }
  });

  // =========================================================================
  // (e) owner revokes grant → 200, revoked_at non-null. Membership
  //     deleted_at set.
  // =========================================================================
  await check('(e) owner revokes → 200, revoked_at set, membership soft-deleted', async () => {
    const r = await api('POST', `${base}/${grantId}/revoke`, { token: owner.accessToken });
    const result = assertStatus(r, 200, 'revoke') as Record<string, unknown>;
    if (result.id !== grantId) throw new Error(`id mismatch: ${result.id}`);
    if (!result.revoked_at || typeof result.revoked_at !== 'string') {
      throw new Error(`revoked_at not set: ${result.revoked_at}`);
    }

    // Membership should now be soft-deleted.
    const { data: membership, error } = await admin
      .from('account_members')
      .select('deleted_at')
      .eq('account_id', owner.accountId)
      .eq('user_id', capturedAgentUserId)
      .eq('role', 'agent')
      .maybeSingle();
    if (error) throw new Error(`admin membership query: ${error.message}`);
    if (!membership) throw new Error(`role=agent membership not found after revoke`);
    if (!membership.deleted_at) {
      throw new Error(`membership deleted_at should be set after revoke`);
    }
  });

  // =========================================================================
  // (f) owner re-enables after revoke → 201; new grant's agent_user_id
  //     equals the one captured in (d) (identity reuse).
  // =========================================================================
  await check('(f) re-enable after revoke → 201, same agent_user_id (identity reuse)', async () => {
    const r = await api('POST', base, { token: owner.accessToken });
    const grant = assertStatus(r, 201, 're-enable') as Record<string, unknown>;
    if (grant.agent_user_id !== capturedAgentUserId) {
      throw new Error(
        `identity reuse failed: expected ${capturedAgentUserId}, got ${grant.agent_user_id}`,
      );
    }
    if (grant.revoked_at !== null) throw new Error(`revoked_at should be null`);
    // Update grantId for any future use.
    grantId = grant.id as string;
  });

  // =========================================================================
  // (g) viewer member attempts enable → 403 ('forbidden').
  //     Create a fresh user and insert them as a viewer member of the first
  //     account via the admin client.
  // =========================================================================
  await check('(g) viewer member enable → 403 forbidden', async () => {
    const viewerEmail = `ag-viewer-${rnd()}@example.test`;
    const viewerPassword = `correct-horse-battery-${rnd()}`;
    const { data: viewerAuth, error: viewerErr } = await admin.auth.admin.createUser({
      email: viewerEmail,
      password: viewerPassword,
      email_confirm: true,
    });
    if (viewerErr || !viewerAuth?.user) {
      throw new Error(`Failed to create viewer user: ${viewerErr?.message}`);
    }
    const viewerUserId = viewerAuth.user.id;

    // Insert viewer membership in the first account.
    const { error: memErr } = await admin.from('account_members').insert({
      account_id: owner.accountId,
      user_id: viewerUserId,
      role: 'viewer',
    });
    if (memErr) throw new Error(`Failed to insert viewer membership: ${memErr.message}`);

    // Log in as viewer.
    const loginResp = await api('POST', '/v1/auth/login', {
      body: { email: viewerEmail, password: viewerPassword },
    });
    if (loginResp.status !== 200) {
      throw new Error(`Viewer login failed: ${loginResp.status} ${JSON.stringify(loginResp.body)}`);
    }
    const viewerToken = (
      (loginResp.body as { session: { access_token: string } }).session
    ).access_token;

    const r = await api('POST', base, { token: viewerToken });
    assertStatus(r, 403, 'viewer enable');
    if (errCode(r) !== 'forbidden') throw new Error(`code: ${errCode(r)}`);
  });

  // =========================================================================
  // (h) non-member (second account's owner) attempts enable on first account
  //     → 404 (membership middleware returns 404 for non-members).
  // =========================================================================
  await check('(h) non-member enable → 404', async () => {
    const nonMember = await setupUser('nonmember');
    const r = await api('POST', base, { token: nonMember.accessToken });
    assertStatus(r, 404, 'non-member enable');
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
  console.info(`All checks passed.`);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
