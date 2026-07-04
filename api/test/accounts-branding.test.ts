// ----------------------------------------------------------------------------
// Per-account email-branding integration tests. Exercised against a real
// Supabase stack (GoTrue + PostgREST + RLS).
//
//   * GET /accounts/{id}/email-branding returns nulls before anything is set,
//     and reply_domain is null until a subdomain is minted.
//   * PATCH as an owner sets email_subdomain + sender_display_name; the response
//     echoes them and computes reply_domain = <subdomain>.<parent> (the parent
//     is EMAIL_PLATFORM_PARENT_DOMAIN, set at boot).
//   * PATCH as a viewer → 403 (owner/manager only; requireManager + RLS).
//   * an invalid label (bad chars) and a reserved word both → 422.
//   * the same subdomain on a SECOND account → 409 (global uniqueness).
//   * explicit null clears a field back to null (and reply_domain follows).
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
process.env.PORT = '8799';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

// The platform parent domain that branded reply subdomains hang under. Set at
// BOOT, before env/app snapshot it, so GET/PATCH can compute reply_domain.
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

async function createAuthUser(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = `branding-${label}-${crypto.randomUUID()}@internal.test`;
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

interface Signup { accountId: string; userId: string; token: string; email: string; password: string }
async function signup(name: string): Promise<Signup> {
  const email = `branding-owner-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', { body: { email, password, account_name: name } });
  if (su.status !== 200) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { user: { id: string }; account: { id: string }; session: { access_token: string } };
  return { accountId: b.account.id, userId: b.user.id, token: b.session.access_token, email, password };
}

interface BrandingShape {
  email_subdomain: string | null;
  sender_display_name: string | null;
  reply_domain: string | null;
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Per-account email-branding integration tests');

  const owner = await signup('Branding Acct A');
  const ownerB = await signup('Branding Acct B');
  const base = `/v1/accounts/${owner.accountId}/email-branding`;

  // A viewer member of account A (added via the admin/service-role path).
  const viewerUser = await createAuthUser('viewer');
  {
    const { error } = await admin.from('account_members').insert({
      account_id: owner.accountId, user_id: viewerUser.id, role: 'viewer',
    });
    if (error) throw new Error(`viewer membership: ${error.message}`);
  }
  const viewerToken = await login(viewerUser.email, viewerUser.password);

  // Unique-per-run subdomains (the DB uniqueness index is global; fixed values
  // would make the suite single-shot against a persistent local stack).
  const SUB = `acme${SUFFIX}`;
  const DUP = `dup${SUFFIX}`;

  await check('GET returns nulls before anything is set (reply_domain null)', async () => {
    const r = await api('GET', base, { token: owner.token });
    const b = assertStatus(r, 200, 'initial GET') as BrandingShape;
    assert(b.email_subdomain === null, `email_subdomain: ${b.email_subdomain}`);
    assert(b.sender_display_name === null, `sender_display_name: ${b.sender_display_name}`);
    assert(b.reply_domain === null, `reply_domain: ${b.reply_domain}`);
  });

  await check('PATCH as owner sets both fields; reply_domain = <sub>.<parent>', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { email_subdomain: SUB, sender_display_name: 'Acme Properties' },
    });
    const b = assertStatus(r, 200, 'owner PATCH') as BrandingShape;
    assert(b.email_subdomain === SUB, `email_subdomain: ${b.email_subdomain}`);
    assert(b.sender_display_name === 'Acme Properties', `sender_display_name: ${b.sender_display_name}`);
    assert(b.reply_domain === `${SUB}.${PARENT}`, `reply_domain: ${b.reply_domain}`);

    // Persisted: a fresh GET reads back the same.
    const g = await api('GET', base, { token: owner.token });
    const gb = assertStatus(g, 200, 'GET after PATCH') as BrandingShape;
    assert(gb.email_subdomain === SUB, `GET email_subdomain: ${gb.email_subdomain}`);
    assert(gb.reply_domain === `${SUB}.${PARENT}`, `GET reply_domain: ${gb.reply_domain}`);
  });

  await check('PATCH normalizes case + trims (Acme → acme)', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { email_subdomain: `  ${SUB.toUpperCase()}  ` },
    });
    const b = assertStatus(r, 200, 'normalize PATCH') as BrandingShape;
    assert(b.email_subdomain === SUB, `normalized email_subdomain: ${b.email_subdomain}`);
  });

  await check('PATCH as a viewer → 403', async () => {
    const r = await api('PATCH', base, {
      token: viewerToken,
      body: { sender_display_name: 'Nope' },
    });
    assertStatus(r, 403, 'viewer PATCH');
    if (errCode(r) !== 'forbidden') throw new Error(`code: ${errCode(r)}`);
  });

  await check('viewer may still GET (any member reads)', async () => {
    const r = await api('GET', base, { token: viewerToken });
    const b = assertStatus(r, 200, 'viewer GET') as BrandingShape;
    assert(b.email_subdomain === SUB, `viewer sees subdomain: ${b.email_subdomain}`);
  });

  await check('invalid label (underscore) → 422', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { email_subdomain: 'not_valid' },
    });
    assertStatus(r, 422, 'invalid label');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  await check('reserved word (mail) → 422', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { email_subdomain: 'mail' },
    });
    assertStatus(r, 422, 'reserved word');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  await check('display name with a newline → 422', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { sender_display_name: 'Acme\nBcc: evil@x' },
    });
    assertStatus(r, 422, 'newline display name');
  });

  await check('duplicate subdomain across two accounts → 409', async () => {
    // Claim DUP on account A first.
    const a = await api('PATCH', base, { token: owner.token, body: { email_subdomain: DUP } });
    assertStatus(a, 200, 'account A claims DUP');
    // Account B tries the same label → global-uniqueness 409.
    const b = await api('PATCH', `/v1/accounts/${ownerB.accountId}/email-branding`, {
      token: ownerB.token,
      body: { email_subdomain: DUP },
    });
    assertStatus(b, 409, 'account B duplicate');
    if (errCode(b) !== 'conflict') throw new Error(`code: ${errCode(b)}`);
  });

  await check('explicit null clears a field (reply_domain follows)', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { email_subdomain: null },
    });
    const b = assertStatus(r, 200, 'null clear') as BrandingShape;
    assert(b.email_subdomain === null, `cleared email_subdomain: ${b.email_subdomain}`);
    assert(b.reply_domain === null, `reply_domain after clear: ${b.reply_domain}`);
    // sender_display_name (untouched) is preserved.
    assert(b.sender_display_name === 'Acme Properties', `preserved display name: ${b.sender_display_name}`);
  });

  await check('empty PATCH body → 400 (at least one field required)', async () => {
    const r = await api('PATCH', base, { token: owner.token, body: {} });
    assertStatus(r, 400, 'empty PATCH');
  });

  // --- direct-PostgREST hardening (the branding UPDATE grant is column-scoped) -
  // The accounts_manager_update RLS policy is row-level; an owner/manager holds
  // a real GoTrue JWT and can hit PostgREST directly. These assert the column
  // grant + CHECK backstops added in the branding migration actually fence that
  // path — not just the API handler.
  async function directPatch(acctId: string, token: string, body: unknown): Promise<number> {
    const res = await fetch(`${status.API_URL}/rest/v1/accounts?id=eq.${acctId}`, {
      method: 'PATCH',
      headers: {
        apikey: status.ANON_KEY,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
    await res.text();
    return res.status;
  }
  async function readAccount(acctId: string): Promise<Record<string, unknown>> {
    const { data, error } = await admin
      .from('accounts')
      .select('name, deleted_at, email_subdomain')
      .eq('id', acctId)
      .single();
    if (error) throw new Error(`admin read: ${error.message}`);
    return data as Record<string, unknown>;
  }

  await check('direct PostgREST write to accounts.name is denied (column grant)', async () => {
    const before = await readAccount(owner.accountId);
    const st = directPatch(owner.accountId, owner.token, { name: 'HACKED VIA POSTGREST' });
    assert((await st) >= 400, `expected 4xx, got ${await st}`);
    const after = await readAccount(owner.accountId);
    assert(after.name === before.name, `name mutated: ${before.name} -> ${after.name}`);
  });

  await check('direct PostgREST write to accounts.deleted_at is denied (column grant)', async () => {
    const st = await directPatch(owner.accountId, owner.token, {
      deleted_at: new Date().toISOString(),
    });
    assert(st >= 400, `expected 4xx, got ${st}`);
    const after = await readAccount(owner.accountId);
    assert(after.deleted_at === null, `deleted_at mutated to ${after.deleted_at}`);
  });

  await check('direct PostgREST reserved subdomain is rejected by the CHECK backstop', async () => {
    // The column IS grantable, so this reaches the reserved-word CHECK, not the
    // grant — proving the reserved list is enforced in the DB, not just the API.
    const st = await directPatch(owner.accountId, owner.token, { email_subdomain: 'postmaster' });
    assert(st >= 400, `expected 4xx CHECK violation, got ${st}`);
    const after = await readAccount(owner.accountId);
    assert(after.email_subdomain !== 'postmaster', 'reserved subdomain slipped past the CHECK');
  });

  // --- summary ---------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} accounts-branding check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: accounts-branding checks all green');
}

await main();
