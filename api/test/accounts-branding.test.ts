// ----------------------------------------------------------------------------
// Per-account email-branding integration tests. Exercised against a real
// Supabase stack (GoTrue + PostgREST + RLS).
//
//   * GET /accounts/{id}/email-branding: sender_display_name DEFAULTS to the
//     account name at signup (20260707000001); subdomain/persona start null and
//     reply_domain/persona_address are null until their inputs are set.
//   * PATCH as an owner sets email_subdomain + sender_display_name; the response
//     echoes them and computes reply_domain = <subdomain>.<parent> (the parent
//     is EMAIL_PLATFORM_PARENT_DOMAIN, set at boot).
//   * PATCH as a viewer → 403 (owner/manager only; requireManager + RLS).
//   * an invalid label (bad chars) and a reserved word both → 422.
//   * the same subdomain on a SECOND account → 409 (global uniqueness).
//   * explicit null clears a field back to null (and reply_domain follows).
//   * persona_local_part: settable by an owner; persona_address computes only
//     when local part + subdomain + parent are ALL set; reserved names, the
//     t- token prefix, and bad formats → 422; the DB CHECK backstops the
//     direct-PostgREST path.
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
// The 422 branding envelope carries per-field reasons under
// error.details.fieldErrors.<field> (ApiError details -> onError -> body).
function fieldErr(r: ApiResp, field: string): string[] | undefined {
  return (r.body as { error?: { details?: { fieldErrors?: Record<string, string[]> } } })?.error
    ?.details?.fieldErrors?.[field];
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
  persona_local_part: string | null;
  persona_address: string | null;
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

  await check('GET before any PATCH: display name defaults to the account name; the rest null', async () => {
    const r = await api('GET', base, { token: owner.token });
    const b = assertStatus(r, 200, 'initial GET') as BrandingShape;
    assert(b.email_subdomain === null, `email_subdomain: ${b.email_subdomain}`);
    // Signup default (20260707000001): sender_display_name = account name.
    assert(b.sender_display_name === 'Branding Acct A', `sender_display_name: ${b.sender_display_name}`);
    assert(b.reply_domain === null, `reply_domain: ${b.reply_domain}`);
    assert(b.persona_local_part === null, `persona_local_part: ${b.persona_local_part}`);
    assert(b.persona_address === null, `persona_address: ${b.persona_address}`);
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

  await check('premium name (properties) → 422 with the exact premium reason', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { email_subdomain: 'properties' },
    });
    assertStatus(r, 422, 'premium subdomain');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
    // The frontend keys on this EXACT string to render a resale upsell.
    const fe = fieldErr(r, 'email_subdomain');
    assert(
      Array.isArray(fe) && fe[0] === 'is a premium name reserved by the platform',
      `premium fieldError: ${JSON.stringify(fe)}`,
    );
  });

  await check('ops name (smoke) → 422 reserved', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { email_subdomain: 'smoke' },
    });
    assertStatus(r, 422, 'ops subdomain');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
    const fe = fieldErr(r, 'email_subdomain');
    assert(
      Array.isArray(fe) && fe[0] === 'is a reserved name',
      `ops fieldError: ${JSON.stringify(fe)}`,
    );
  });

  await check('display name with a newline → 422', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { sender_display_name: 'Acme\nBcc: evil@x' },
    });
    assertStatus(r, 422, 'newline display name');
  });

  await check('punycode label (xn--) → 422', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { email_subdomain: 'xn--80ak6aa92e' },
    });
    assertStatus(r, 422, 'punycode label');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  await check('display name with a C1 control (U+0085 NEL) → 422', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { sender_display_name: 'Acme\u0085Bcc: evil@x' },
    });
    assertStatus(r, 422, 'C1 display name');
  });

  // --- persona local part -----------------------------------------------------
  // At this point the account still carries email_subdomain = SUB.

  await check('PATCH persona_local_part; persona_address = <local>@<sub>.<parent>', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { persona_local_part: '  Riley  ' }, // trims + lowercases
    });
    const b = assertStatus(r, 200, 'persona PATCH') as BrandingShape;
    assert(b.persona_local_part === 'riley', `persona_local_part: ${b.persona_local_part}`);
    assert(b.persona_address === `riley@${SUB}.${PARENT}`, `persona_address: ${b.persona_address}`);
  });

  await check('persona reserved local part (postmaster) → 422', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { persona_local_part: 'postmaster' },
    });
    assertStatus(r, 422, 'reserved persona');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  await check('persona t- prefix (token namespace) → 422', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { persona_local_part: 't-riley' },
    });
    assertStatus(r, 422, 't- persona');
  });

  await check('persona invalid format (spaces) → 422', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { persona_local_part: 'front desk' },
    });
    assertStatus(r, 422, 'bad persona format');
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

  await check('explicit null clears a field (reply_domain + persona_address follow)', async () => {
    const r = await api('PATCH', base, {
      token: owner.token,
      body: { email_subdomain: null },
    });
    const b = assertStatus(r, 200, 'null clear') as BrandingShape;
    assert(b.email_subdomain === null, `cleared email_subdomain: ${b.email_subdomain}`);
    assert(b.reply_domain === null, `reply_domain after clear: ${b.reply_domain}`);
    // sender_display_name (untouched) is preserved.
    assert(b.sender_display_name === 'Acme Properties', `preserved display name: ${b.sender_display_name}`);
    // The persona is branded-subdomain-only: the local part survives, but the
    // computed address goes null with the subdomain.
    assert(b.persona_local_part === 'riley', `preserved persona_local_part: ${b.persona_local_part}`);
    assert(b.persona_address === null, `persona_address after clear: ${b.persona_address}`);
  });

  await check('empty PATCH body → 400 (at least one field required)', async () => {
    const r = await api('PATCH', base, { token: owner.token, body: {} });
    assertStatus(r, 400, 'empty PATCH');
  });

  // --- email-branding suggestions --------------------------------------------
  // GET /email-branding/suggestions derives candidate subdomains from the
  // account NAME, filters the ones already taken (via the manager-only
  // existence oracle), and offers a display name + persona starters.

  await check('GET suggestions (owner) → 200 shape; a taken candidate is filtered out', async () => {
    // Per-run-unique name so its derived candidates are unique to this run (the
    // base is deterministic from the name, unlike the SUFFIX-salted subdomains
    // above which are randomized to survive the persistent local stack).
    const suggestAcct = await signup(`Zephyr${SUFFIX}`);
    const firstCandidate = `zephyr${SUFFIX}`; // top candidate (core join)

    // Pre-claim the top candidate on a DIFFERENT account so the oracle reports
    // it taken and the endpoint must drop it from the offered list.
    const claimant = await signup(`Claimant${SUFFIX}`);
    const claim = await api('PATCH', `/v1/accounts/${claimant.accountId}/email-branding`, {
      token: claimant.token,
      body: { email_subdomain: firstCandidate },
    });
    assertStatus(claim, 200, 'claimant claims the top candidate');

    const r = await api('GET', `/v1/accounts/${suggestAcct.accountId}/email-branding/suggestions`, {
      token: suggestAcct.token,
    });
    const b = assertStatus(r, 200, 'owner suggestions') as {
      suggested_subdomains: string[];
      suggested_display_name: string | null;
      suggested_persona_local_parts: string[];
    };
    assert(Array.isArray(b.suggested_subdomains), 'suggested_subdomains is an array');
    assert(
      b.suggested_subdomains.length > 0,
      `suggested_subdomains non-empty: ${JSON.stringify(b.suggested_subdomains)}`,
    );
    assert(b.suggested_subdomains.length <= 5, `at most 5: ${b.suggested_subdomains.length}`);
    // The taken filter: the pre-claimed candidate must NOT be offered.
    assert(
      !b.suggested_subdomains.includes(firstCandidate),
      `taken "${firstCandidate}" must be filtered: ${JSON.stringify(b.suggested_subdomains)}`,
    );
    // Display name defaults to the account name (signup default carried through).
    assert(
      b.suggested_display_name === `Zephyr${SUFFIX}`,
      `suggested_display_name: ${b.suggested_display_name}`,
    );
    // Persona starters all survive persona validation, in order.
    assert(
      JSON.stringify(b.suggested_persona_local_parts) ===
        JSON.stringify(['riley', 'assistant', 'office', 'hello']),
      `persona parts: ${JSON.stringify(b.suggested_persona_local_parts)}`,
    );
  });

  await check('GET suggestions (viewer) → 403 (requireManager confines the oracle)', async () => {
    const r = await api('GET', `${base}/suggestions`, { token: viewerToken });
    assertStatus(r, 403, 'viewer suggestions');
    if (errCode(r) !== 'forbidden') throw new Error(`code: ${errCode(r)}`);
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
      .select('name, deleted_at, email_subdomain, sender_display_name')
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

  await check('direct PostgREST reserved/token persona local part is rejected by the CHECKs', async () => {
    const reserved = await directPatch(owner.accountId, owner.token, { persona_local_part: 'abuse' });
    assert(reserved >= 400, `reserved: expected 4xx CHECK violation, got ${reserved}`);
    const token = await directPatch(owner.accountId, owner.token, { persona_local_part: 't-0123456789abcdef' });
    assert(token >= 400, `t- prefix: expected 4xx CHECK violation, got ${token}`);
  });

  await check('direct PostgREST punycode (xn--) subdomain is rejected by the CHECK backstop', async () => {
    // The API rejects `xn--…` labels; the DB backstop (migration 20260711000001)
    // must too, or a direct write could claim a homoglyph receiving subdomain.
    const punycode = 'xn--80ak6aa92e';
    const st = await directPatch(owner.accountId, owner.token, { email_subdomain: punycode });
    assert(st >= 400, `expected 4xx CHECK violation, got ${st}`);
    const after = await readAccount(owner.accountId);
    assert(after.email_subdomain !== punycode, 'punycode subdomain slipped past the CHECK');
  });

  await check('direct PostgREST C1 control char in sender_display_name is rejected by the CHECK backstop', async () => {
    // U+0085 (NEL) is a C1 control the API CONTROL_RE rejects; the widened DB
    // no-ctrl CHECK (migration 20260711000001) must reject it on the direct path.
    const before = await readAccount(owner.accountId);
    const st = await directPatch(owner.accountId, owner.token, {
      sender_display_name: 'Acme\u0085Bcc: evil@x',
    });
    assert(st >= 400, `expected 4xx CHECK violation, got ${st}`);
    const after = await readAccount(owner.accountId);
    assert(
      !String(after.sender_display_name ?? '').includes('\u0085'),
      'C1 control char slipped past the CHECK',
    );
    assert(
      after.sender_display_name === before.sender_display_name,
      `sender_display_name mutated: ${String(before.sender_display_name)} -> ${String(after.sender_display_name)}`,
    );
  });

  // --- premium/ops/em reserved backstop on the direct-PostgREST path ----------
  // The premium + ops reserved list is enforced by a BEFORE-WRITE trigger that
  // reads public.reserved_subdomain_labels (migration 20260721000001), NOT a
  // CHECK — so the config file can drive the DB without a migration. These prove
  // the trigger fences the direct column-granted write path (errcode 23514 →
  // PostgREST 4xx). At this point owner.email_subdomain is null (cleared above).

  await check('direct PostgREST premium subdomain is rejected by the reserved trigger', async () => {
    const st = await directPatch(owner.accountId, owner.token, { email_subdomain: 'rent' });
    assert(st >= 400, `expected 4xx trigger rejection, got ${st}`);
    const after = await readAccount(owner.accountId);
    assert(after.email_subdomain !== 'rent', 'premium subdomain slipped past the trigger');
  });

  await check('direct PostgREST ops subdomain (smoke) is rejected by the reserved trigger', async () => {
    const st = await directPatch(owner.accountId, owner.token, { email_subdomain: 'smoke' });
    assert(st >= 400, `expected 4xx trigger rejection, got ${st}`);
    const after = await readAccount(owner.accountId);
    assert(after.email_subdomain !== 'smoke', 'ops subdomain slipped past the trigger');
  });

  await check('direct PostgREST em<digits> subdomain is rejected by the reserved trigger', async () => {
    const st = await directPatch(owner.accountId, owner.token, { email_subdomain: 'em682356' });
    assert(st >= 400, `expected 4xx trigger rejection, got ${st}`);
    const after = await readAccount(owner.accountId);
    assert(after.email_subdomain !== 'em682356', 'em<digits> subdomain slipped past the trigger');
  });

  // --- premium-subdomain boot sync (config file → DB reconciliation) ----------
  // The premium rows in reserved_subdomain_labels are reconciled to the config
  // file on every API boot (admin/sync-premium-subdomains.ts). Exercise the full
  // sale-flow round-trip: no-op sync, release a premium label, claim it, re-sync
  // to restore, and confirm the migration-managed ops rows are never touched.
  const { syncPremiumSubdomainLabels } = await import('../src/admin/sync-premium-subdomains');

  async function reservedRow(label: string): Promise<{ label: string; kind: string } | null> {
    const { data, error } = await admin
      .from('reserved_subdomain_labels')
      .select('label, kind')
      .eq('label', label)
      .maybeSingle();
    if (error) throw new Error(`reserved read ${label}: ${error.message}`);
    return data;
  }
  async function opsRowCount(): Promise<number> {
    const { count, error } = await admin
      .from('reserved_subdomain_labels')
      .select('label', { count: 'exact', head: true })
      .eq('kind', 'ops');
    if (error) throw new Error(`ops count: ${error.message}`);
    return count ?? 0;
  }

  // A real premium label the API tests do not otherwise claim.
  const SALE_LABEL = 'brokerage';

  await check('sync is a no-op when the DB seed already matches the file', async () => {
    const res = await syncPremiumSubdomainLabels();
    assert(
      res.inserted === 0 && res.deleted === 0,
      `expected no-op sync, got ${JSON.stringify(res)}`,
    );
    const row = await reservedRow(SALE_LABEL);
    assert(row?.kind === 'premium', `${SALE_LABEL} should be a seeded premium row: ${JSON.stringify(row)}`);
  });

  await check('a released (sold) premium label becomes claimable; the next sync restores it', async () => {
    const opsBefore = await opsRowCount();

    // Sale: service-role-delete the premium label from the backstop.
    const { error: delErr } = await admin
      .from('reserved_subdomain_labels')
      .delete()
      .eq('label', SALE_LABEL)
      .eq('kind', 'premium');
    if (delErr) throw new Error(`release ${SALE_LABEL}: ${delErr.message}`);
    assert((await reservedRow(SALE_LABEL)) === null, 'label should be released from the backstop');

    // The owner can now claim it directly against PostgREST (trigger passes).
    const st = await directPatch(owner.accountId, owner.token, { email_subdomain: SALE_LABEL });
    assert(st < 400, `expected the released label to be claimable, got ${st}`);
    const afterClaim = await readAccount(owner.accountId);
    assert(afterClaim.email_subdomain === SALE_LABEL, `claim did not land: ${afterClaim.email_subdomain}`);

    // Re-sync from the file → the label is restored as premium.
    const res = await syncPremiumSubdomainLabels();
    assert(res.inserted >= 1, `sync should re-insert the released label, got ${JSON.stringify(res)}`);
    const restored = await reservedRow(SALE_LABEL);
    assert(restored?.kind === 'premium', `${SALE_LABEL} should be restored: ${JSON.stringify(restored)}`);

    // Ops rows are migration-managed — the sync must never touch them.
    assert((await opsRowCount()) === opsBefore, 'sync must not change ops rows');

    // Clean up: clear the account's subdomain. It now holds a re-reserved label
    // (grandfathered by the write-only trigger); null clears without tripping it.
    const clearSt = await directPatch(owner.accountId, owner.token, { email_subdomain: null });
    assert(clearSt < 400, `expected clear to succeed, got ${clearSt}`);
  });

  // --- taken-oracle is service_role-only (no direct-PostgREST RPC) ------------
  // _email_subdomains_taken is SECURITY DEFINER with a service_role-only grant
  // (migration 20260721000001; enforced by db/test/check_definer_grants.sql). A
  // signed-in user hitting the RPC directly off PostgREST with the anon key +
  // their JWT MUST be refused — this is the enumeration fence the API relies on
  // when it calls the oracle server-side via the admin client instead.
  await check('direct RPC _email_subdomains_taken as an authenticated user is DENIED', async () => {
    const res = await fetch(`${status.API_URL}/rest/v1/rpc/_email_subdomains_taken`, {
      method: 'POST',
      headers: {
        apikey: status.ANON_KEY,
        authorization: `Bearer ${owner.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_candidates: ['acme', 'rent'] }),
    });
    const text = await res.text();
    // The one thing it must NOT be is a 200 that returns data — that would mean
    // the oracle is callable by any user JWT. A denied SECURITY DEFINER function
    // surfaces as 42501 (PostgREST 401/403) or a 404 (function not exposed to
    // the role); accept any of those, reject a 200.
    assert(res.status !== 200, `oracle must not return 200 to a user JWT; body=${text}`);
    const denied =
      res.status === 401 ||
      res.status === 403 ||
      res.status === 404 ||
      text.includes('42501') ||
      text.toLowerCase().includes('permission');
    assert(denied, `expected a permission denial, got ${res.status} body=${text}`);
  });

  // --- reserved-label drift window → 422 (not 500) ---------------------------
  // A label released from premium-subdomains.json passes the file-based
  // validator immediately, but its DB backstop row lingers until the next boot
  // sync — so the accounts write-trigger can raise 23514 for a value the API
  // validator accepted. The handler must map that 23514 to the same friendly
  // 422 the validator would have produced, never a 500. Simulate the window
  // with a synthetic reserved row that is NOT in the config file.
  await check('reserved-label drift window: DB-only reserved row → PATCH 422 (not 500)', async () => {
    const DRIFT_LABEL = 'zz-drift-test'; // valid label; not in the config file
    const { error: insErr } = await admin
      .from('reserved_subdomain_labels')
      .insert({ label: DRIFT_LABEL, kind: 'premium' });
    if (insErr) throw new Error(`seed drift row: ${insErr.message}`);

    // Run the assertions, capturing any failure so cleanup ALWAYS happens
    // before we rethrow (a throw in `finally` trips no-unsafe-finally).
    let assertion: unknown = null;
    try {
      const r = await api('PATCH', base, {
        token: owner.token,
        body: { email_subdomain: DRIFT_LABEL },
      });
      assertStatus(r, 422, 'drift-window PATCH');
      if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
      const fe = fieldErr(r, 'email_subdomain');
      assert(
        Array.isArray(fe) && fe[0] === 'is a reserved name',
        `drift fieldError: ${JSON.stringify(fe)}`,
      );
    } catch (e) {
      assertion = e;
    }

    // Clean up the synthetic row so the table returns to config-parity. This
    // runs AFTER the sync round-trip tests above, so no later test depends on
    // the table state — the delete alone restores it.
    const { error: delErr } = await admin
      .from('reserved_subdomain_labels')
      .delete()
      .eq('label', DRIFT_LABEL);

    if (assertion) throw assertion;
    if (delErr) throw new Error(`cleanup drift row: ${delErr.message}`);
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
