// ----------------------------------------------------------------------------
// Account email identity — GET/PUT /v1/accounts/{id}/email-identity.
//
// Covers:
//   (A) GET as a member: slug null until set; email_domain reflects env;
//       from_address null while the slug is unset.
//   (B) PUT as OWNER sets the slug: input is trimmed + lowercased; the echo
//       carries the composed from_address ("Account Name <slug@domain>") and
//       a re-GET returns the same identity.
//   (C) Validation: reserved local part -> 422 invalid_email_slug; malformed
//       (bad chars / edge hyphens) -> 422; nothing is written on refusal.
//   (D) Global uniqueness: a second account claiming the same slug -> 409
//       conflict; a different slug succeeds.
//   (E) Authorization: viewer PUT -> 403 (the RPC's owner check, 42501);
//       agent PUT -> 403 (principal gate, before the RPC); viewer GET is fine
//       (any member may read). Non-member -> 404 on the account scope.
//   (F) PUT email_slug:null clears the identity (from_address null again).
//   (G) DB backstops past the API: a direct PostgREST UPDATE on accounts by
//       the owner is refused (select-only RLS -- the RPC is the only write
//       path), and a direct RPC call by a viewer raises the owner check.
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
process.env.PORT = '8797';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';
// The platform sending domain under test -- from_address composition is
// asserted against this exact value.
const MAIL_DOMAIN = 'mail.test';
process.env.ACCOUNT_EMAIL_DOMAIN = MAIL_DOMAIN;

const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const admin = getAdminClient();

async function createAuthUser(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = `acctmail-${label}-${crypto.randomUUID()}@internal.test`;
  const password = `pw-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data?.user) throw new Error(`createUser ${label}: ${error?.message}`);
  return { id: data.user.id, email, password };
}

const viewerAuth = await createAuthUser('viewer');
const agentAuth = await createAuthUser('agent');

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

// Direct PostgREST call with a member's real JWT — exercises the DB-layer
// guards (select-only RLS on accounts; the RPC's own owner check) that defend
// against a member reaching past the API.
async function pgrest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${status.API_URL}/rest/v1/${path}`, {
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
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function login(email: string, password: string): Promise<string> {
  const r = await api('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return (r.body as { session: { access_token: string } }).session.access_token;
}

interface Identity { email_slug: string | null; email_domain: string | null; from_address: string | null }

// --- fixture ------------------------------------------------------------------

interface Fixture {
  accountId: string;
  accountName: string;
  ownerToken: string;
  viewerToken: string;
  agentToken: string;
}

async function setup(label: string, withMembers: boolean): Promise<Fixture> {
  const accountName = `Mail Acct ${label}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: {
      email: `acctmail-owner-${label}-${rnd()}@example.test`,
      password: `correct-horse-${rnd()}`,
      account_name: accountName,
    },
  });
  if (su.status !== 200) throw new Error(`signup ${label}: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };

  if (withMembers) {
    for (const [userId, role] of [[viewerAuth.id, 'viewer'], [agentAuth.id, 'agent']] as const) {
      const { error } = await admin.from('account_members').insert({
        account_id: b.account.id, user_id: userId, role,
      });
      if (error) throw new Error(`membership ${role}: ${error.message}`);
    }
  }

  return {
    accountId: b.account.id,
    accountName,
    ownerToken: b.session.access_token,
    viewerToken: withMembers ? await login(viewerAuth.email, viewerAuth.password) : '',
    agentToken: withMembers ? await login(agentAuth.email, agentAuth.password) : '',
  };
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  const A = await setup('a', true);
  const B = await setup('b', false);
  const base = `/v1/accounts/${A.accountId}/email-identity`;
  // Randomized so the suite is re-runnable against a persistent local stack
  // (slugs are globally unique).
  const SLUG = `sunset-${rnd()}`;

  // (A) unset identity reads.
  await check('GET before any PUT: slug null, domain from env, from_address null', async () => {
    const r = await api('GET', base, { token: A.ownerToken });
    const id = assertStatus(r, 200, 'GET unset') as Identity;
    assert(id.email_slug === null, `slug: ${JSON.stringify(id.email_slug)}`);
    assert(id.email_domain === MAIL_DOMAIN, `domain: ${JSON.stringify(id.email_domain)}`);
    assert(id.from_address === null, `from: ${JSON.stringify(id.from_address)}`);
  });

  // (B) owner sets the slug; normalisation + composed From.
  await check('PUT as owner normalises and composes from_address; re-GET agrees', async () => {
    const r = await api('PUT', base, {
      token: A.ownerToken,
      body: { email_slug: `  ${SLUG.toUpperCase()} ` },
    });
    const id = assertStatus(r, 200, 'PUT set') as Identity;
    assert(id.email_slug === SLUG, `slug: ${JSON.stringify(id.email_slug)}`);
    assert(
      id.from_address === `${A.accountName} <${SLUG}@${MAIL_DOMAIN}>`,
      `from: ${JSON.stringify(id.from_address)}`,
    );
    const g = await api('GET', base, { token: A.ownerToken });
    const gid = assertStatus(g, 200, 're-GET') as Identity;
    assert(gid.email_slug === SLUG && gid.from_address === id.from_address, 'GET != PUT echo');
  });

  // (C1) reserved local parts are refused.
  await check('PUT reserved slug -> 422 invalid_email_slug, nothing written', async () => {
    const r = await api('PUT', base, { token: A.ownerToken, body: { email_slug: 'Postmaster' } });
    assertStatus(r, 422, 'PUT reserved');
    assert(errCode(r) === 'invalid_email_slug', `code: ${errCode(r)}`);
    const g = await api('GET', base, { token: A.ownerToken });
    assert((g.body as Identity).email_slug === SLUG, 'refused write must not clobber the slug');
  });

  // (C2) malformed shapes are refused.
  await check('PUT malformed slugs -> 422 invalid_email_slug', async () => {
    for (const bad of ['-sunset', 'sunset-', 'sun set', 'dot.ted', 'ünicode']) {
      const r = await api('PUT', base, { token: A.ownerToken, body: { email_slug: bad } });
      assertStatus(r, 422, `PUT ${JSON.stringify(bad)}`);
      assert(errCode(r) === 'invalid_email_slug', `${bad} code: ${errCode(r)}`);
    }
  });

  // (D) global uniqueness across accounts.
  await check('second account claiming the same slug -> 409; a fresh slug -> 200', async () => {
    const otherBase = `/v1/accounts/${B.accountId}/email-identity`;
    const dup = await api('PUT', otherBase, { token: B.ownerToken, body: { email_slug: SLUG } });
    assertStatus(dup, 409, 'PUT dup slug');
    assert(errCode(dup) === 'conflict', `code: ${errCode(dup)}`);
    const fresh = await api('PUT', otherBase, { token: B.ownerToken, body: { email_slug: `${SLUG}-2` } });
    const id = assertStatus(fresh, 200, 'PUT fresh slug') as Identity;
    assert(id.email_slug === `${SLUG}-2`, `slug: ${JSON.stringify(id.email_slug)}`);
  });

  // (E1) viewer: read ok, write refused by the RPC's owner check.
  await check('viewer GET -> 200; viewer PUT -> 403', async () => {
    const g = await api('GET', base, { token: A.viewerToken });
    assertStatus(g, 200, 'viewer GET');
    const r = await api('PUT', base, { token: A.viewerToken, body: { email_slug: `viewer-${rnd()}` } });
    assertStatus(r, 403, 'viewer PUT');
    assert(errCode(r) === 'forbidden', `code: ${errCode(r)}`);
  });

  // (E2) agent principal: refused before the RPC.
  await check('agent PUT -> 403 (identity is never agent-writable)', async () => {
    const r = await api('PUT', base, { token: A.agentToken, body: { email_slug: `agent-${rnd()}` } });
    assertStatus(r, 403, 'agent PUT');
    assert(errCode(r) === 'forbidden', `code: ${errCode(r)}`);
  });

  // (E3) non-member: the account scope 404s before the handler runs.
  await check('non-member GET -> 404 on the account scope', async () => {
    const r = await api('GET', base, { token: B.ownerToken });
    assertStatus(r, 404, 'foreign GET');
  });

  // (F) clearing.
  await check('PUT email_slug:null clears the identity', async () => {
    const r = await api('PUT', base, { token: A.ownerToken, body: { email_slug: null } });
    const id = assertStatus(r, 200, 'PUT clear') as Identity;
    assert(id.email_slug === null && id.from_address === null, `cleared: ${JSON.stringify(id)}`);
    // Restore so the DB backstop check below runs with a live slug.
    const restore = await api('PUT', base, { token: A.ownerToken, body: { email_slug: SLUG } });
    assertStatus(restore, 200, 'PUT restore');
  });

  // (G1) select-only RLS: the owner's direct PostgREST UPDATE writes nothing.
  await check('direct PostgREST UPDATE on accounts is a no-op (select-only RLS)', async () => {
    const r = await pgrest(
      'PATCH',
      `accounts?id=eq.${A.accountId}`,
      A.ownerToken,
      { email_slug: 'forged-slug' },
    );
    // PostgREST returns 200 with zero updated rows when RLS filters the
    // target set; the stored slug proves nothing was written.
    assert(r.status < 300, `unexpected status ${r.status}`);
    assert(Array.isArray(r.body) && r.body.length === 0, `RLS let the update through: ${JSON.stringify(r.body)}`);
    const g = await api('GET', base, { token: A.ownerToken });
    assert((g.body as Identity).email_slug === SLUG, 'slug changed via direct PostgREST');
  });

  // (G2) the RPC defends itself: a viewer calling it directly is refused.
  await check('direct RPC call by a viewer raises the owner check (42501)', async () => {
    const r = await pgrest('POST', 'rpc/set_account_email_slug', A.viewerToken, {
      p_account_id: A.accountId,
      p_slug: 'viewer-forge',
    });
    assert(r.status === 403 || r.status === 401, `expected refusal, got ${r.status} ${JSON.stringify(r.body)}`);
    const g = await api('GET', base, { token: A.ownerToken });
    assert((g.body as Identity).email_slug === SLUG, 'slug changed via direct RPC');
  });

  // (H) unauthenticated -> 401.
  await check('unauthenticated GET -> 401', async () => {
    const r = await api('GET', base);
    assertStatus(r, 401, 'anon GET');
  });

  // --- summary ---------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\n${failures.length} account-email failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nAll account-email checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
