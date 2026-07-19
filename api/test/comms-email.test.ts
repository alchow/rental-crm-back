// ----------------------------------------------------------------------------
// Comms email-channel slice-1 integration tests (work item E1-A, core side).
//
// The email channel reuses the whole outbox->complete pipeline; this slice adds
// only what email needs that sms didn't. Exercised against a real Supabase
// stack, alongside the existing sms/group surface:
//   * comm_outbox.subject: email-only (1..998), frozen at intent time, echoed
//     on create + read; an sms row with a subject is rejected (400).
//   * the full send cycle for email: claim (sending) -> complete (resend) ->
//     the journal records the honest content 'Subject: <s>\n\n<body>', channel
//     'email', direction 'outbound'.
//   * system:<flow> provenance is fenced to core's service tier: an API caller
//     (agent 403, landlord 4xx) can never mint one, and a raw-PostgREST forge
//     with author_type='system' is rejected by the capacity trigger.
//   * HMAC unsubscribe (public, no auth, RFC 8058 one-click): POST parks the
//     queued intent (undeliverable/opted_out) + refuses new sends (422),
//     GET registers + returns the confirmation page, POST replay is idempotent,
//     tampered / garbage tokens 404.
//   * dispatch-scan channel filter: ?channel=email|sms partitions the queue.
//   * the inspection-capture renewal email (rides the comms ledger
//     unconditionally): the renewal writes a system:capture_renewal email intent
//     to the tenant's on-file address, and an opt-out on that address suppresses
//     the write (logged, not thrown) while the route stays a uniform 202.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

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
// E1-A: the HMAC unsubscribe secret (mint + verify must share it) must be set
// at BOOT, before the env/app modules snapshot it.
// Deliberately repetitive (low-entropy) so the gitleaks pre-commit scan
// never mistakes this test-only value for a real credential.
const UNSUB_SECRET = 'test-secret-test-secret-test-secret-test';
process.env.UNSUBSCRIBE_HMAC_SECRET = UNSUB_SECRET;

const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const admin = getAdminClient();

async function createAuthUser(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = `commsem-${label}-${crypto.randomUUID()}@internal.test`;
  const password = `pw-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data?.user) throw new Error(`createUser ${label}: ${error?.message}`);
  return { id: data.user.id, email, password };
}

const agentAuth = await createAuthUser('agent');

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { buildApp } = await import('../src/app');
// Exported by the renewal flow so tests can mint a fresh capture token
// directly (service-tier), the same call the renewal path uses internally.
const { mintCaptureTokenAdmin } = await import('../src/admin/inspection-capture');

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

// Raw response (no JSON.parse) — the unsubscribe GET returns an HTML page.
async function raw(
  method: string,
  path: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string; contentType: string }> {
  const res = await app.fetch(new Request(`http://test${path}`, { method, headers: opts.headers }));
  return {
    status: res.status,
    text: await res.text(),
    contentType: res.headers.get('content-type') ?? '',
  };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

// Direct PostgREST call with a member's real JWT — the threat model the DB
// triggers defend against (a member reaching past the API layer). Used for the
// system: provenance forge backstop, mirroring comms-group's F1/F5 forges.
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

// --- unsubscribe token (mirrors the broadcast/transport mint format) --------
const b64u = (b: Buffer): string => b.toString('base64url');
function unsubToken(address: string, secret = UNSUB_SECRET): string {
  const a = address.trim().toLowerCase();
  const mac = createHmac('sha256', secret).update('unsub:v1:email:' + a).digest();
  return `${b64u(Buffer.from(a, 'utf8'))}.${b64u(mac)}`;
}

// --- fixture ------------------------------------------------------------------

// Randomized per run: the opt-out register is GLOBAL on the persistent local
// stack, so email fixtures must be unique or the suite is single-shot.
const SUFFIX = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');

const EMAIL_A = `send-a-${SUFFIX}@e1.test`;      // subject/complete-cycle recipient
const EMAIL_B = `unsub-b-${SUFFIX}@e1.test`;     // one-click POST unsubscribe target
const EMAIL_C = `unsub-c-${SUFFIX}@e1.test`;     // GET-page unsubscribe target
const EMAIL_D = `scan-d-${SUFFIX}@e1.test`;      // dispatch-scan email row
const RENEWAL_EMAIL = `renew-${SUFFIX}@e1.test`; // renewal-email recipient
const RENEWAL_EMAIL2 = `renew2-${SUFFIX}@e1.test`; // opt-out-suppressed recipient
const SMS_PHONE = `+1914${SUFFIX}`;              // dispatch-scan sms row
const PLATFORM = `+1912${SUFFIX}`;

interface Fixture {
  accountId: string;
  landlordToken: string;
  landlordId: string;
  agentToken: string;
  tenant1Id: string;
  tenant2Id: string;
  tenancyId: string;
  unitId: string;
}

async function setup(platformNumber: string, tag: string): Promise<Fixture> {
  const email = `commsem-landlord-${tag}-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: 'Comms Email Acct' },
  });
  if (su.status !== 200) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { user: { id: string }; account: { id: string }; session: { access_token: string } };
  const accountId = b.account.id;
  const token = b.session.access_token;

  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token, body });
    if (r.status !== 201) throw new Error(`setup POST ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(`/v1/accounts/${accountId}/properties`, { name: 'Comms prop' });
  const unit = await post<{ id: string }>(`/v1/accounts/${accountId}/areas`, {
    property_id: property.id, kind: 'unit', name: 'Unit 1',
  });
  const tenancy = await post<{ id: string }>(`/v1/accounts/${accountId}/tenancies`, {
    area_id: unit.id, start_date: '2026-01-01', status: 'active',
  });
  const tenant1 = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, { full_name: 'Tenant One' });
  const tenant2 = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, { full_name: 'Tenant Two' });

  // The agent transport (member of the account).
  {
    const { error } = await admin.from('account_members').insert({
      account_id: accountId, user_id: agentAuth.id, role: 'agent',
    });
    if (error) throw new Error(`membership agent: ${error.message}`);
  }
  // Ops-tier provisioning (service role): the account's platform number.
  {
    const { error } = await admin.from('platform_numbers').insert({
      account_id: accountId, number: platformNumber, provider: 'test', capabilities: ['sms'],
    });
    if (error) throw new Error(`platform number: ${error.message}`);
  }

  return {
    accountId,
    landlordToken: token,
    landlordId: b.user.id,
    agentToken: await login(agentAuth.email, agentAuth.password),
    tenant1Id: tenant1.id,
    tenant2Id: tenant2.id,
    tenancyId: tenancy.id,
    unitId: unit.id,
  };
}

// --- shapes -----------------------------------------------------------------

interface OutboxShape {
  id: string;
  status: string;
  channel: string;
  to_address: string | null;
  subject: string | null;
  approval_ref: string;
  author_type: string;
  interaction_id: string | null;
  error_code: string | null;
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Comms email slice-1 integration tests');
  const fx = await setup(PLATFORM, 'a');
  const base = `/v1/accounts/${fx.accountId}/comms`;
  const self = `self:${fx.landlordId}`;
  const outbox = (body: unknown, token = fx.landlordToken) =>
    api('POST', `${base}/outbox`, { token, body });

  // =========================================================================
  // (A) subject: email-only, echoed on create
  // =========================================================================
  let emailAId = '';
  await check('email intent accepts subject (1..998), echoed, queued (201)', async () => {
    const r = await outbox({
      channel: 'email', to_address: EMAIL_A, subject: 'Hello there', body: 'line1', approval_ref: self,
    });
    const row = assertStatus(r, 201, 'email intent') as OutboxShape;
    emailAId = row.id;
    assert(row.channel === 'email', `channel: ${row.channel}`);
    assert(row.subject === 'Hello there', `subject: ${row.subject}`);
    assert(row.to_address === EMAIL_A, `to_address: ${row.to_address}`);
    assert(row.status === 'queued', `status: ${row.status}`);
  });

  await check('subject on an sms intent → 400 (email-only)', async () => {
    const r = await outbox({
      channel: 'sms', to_address: `+1913${SUFFIX}`, subject: 'nope', body: 'x', approval_ref: self,
    });
    assertStatus(r, 400, 'sms + subject');
  });

  // =========================================================================
  // (B) full send cycle: claim -> complete -> honest journal
  // =========================================================================
  await check('email send: claim → sending, complete → journal "Subject: …\\n\\n…", email/outbound', async () => {
    const claim = await api('POST', `${base}/outbox/${emailAId}/delivery`, {
      token: fx.agentToken, body: { status: 'sending', provider_ts: new Date().toISOString() },
    });
    assert((assertStatus(claim, 200, 'claim') as { status: string }).status === 'sending', 'claimed');

    const done = await api('POST', `${base}/outbox/${emailAId}/complete`, {
      token: fx.agentToken, body: { provider: 'resend', provider_sid: `em-${rnd()}` },
    });
    const body = assertStatus(done, 200, 'complete') as { interaction_id: string; outbox: OutboxShape };
    assert(body.outbox.status === 'sent', `outbox status: ${body.outbox.status}`);

    const j = await api('GET', `/v1/accounts/${fx.accountId}/interactions/${body.interaction_id}`, {
      token: fx.landlordToken,
    });
    const row = assertStatus(j, 200, 'journal row') as { body: string; channel: string; direction: string };
    assert(row.body === 'Subject: Hello there\n\nline1', `journal body: ${JSON.stringify(row.body)}`);
    assert(row.channel === 'email', `journal channel: ${row.channel}`);
    assert(row.direction === 'outbound', `journal direction: ${row.direction}`);
  });

  // =========================================================================
  // (C) system:<flow> provenance is service-tier-only
  // =========================================================================
  await check('agent intent with approval_ref=system:x → 403', async () => {
    const r = await outbox({
      channel: 'email', to_address: EMAIL_A, body: 'x', approval_ref: 'system:x',
    }, fx.agentToken);
    assert(r.status === 403, `expected 403, got ${r.status} body=${JSON.stringify(r.body)}`);
  });

  await check('landlord intent with approval_ref=system:x → 4xx and creates no row', async () => {
    const r = await outbox({
      channel: 'email', to_address: EMAIL_A, body: 'x', approval_ref: 'system:x',
    });
    assert(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
    const { data } = await admin.from('comm_outbox')
      .select('id').eq('account_id', fx.accountId).eq('approval_ref', 'system:x');
    assert((data ?? []).length === 0, `system:x rows created: ${(data ?? []).length}`);
  });

  await check('forge: raw PostgREST comm_outbox with author_type=system (JWT) → rejected by capacity trigger', async () => {
    const r = await pgrest('POST', 'comm_outbox', fx.landlordToken, {
      account_id: fx.accountId,
      channel: 'email',
      to_address: EMAIL_A,
      body: 'forged system row',
      subject: 'forged',
      approval_ref: 'system:forge',
      author_type: 'system',
    });
    assert(r.status >= 400, `forged system row accepted: ${r.status} ${JSON.stringify(r.body)}`);
  });

  // =========================================================================
  // (D) HMAC unsubscribe — public, no auth (RFC 8058 one-click)
  // =========================================================================
  let emailBId = '';
  await check('unsubscribe one-click POST (no auth, no body) → 200 {status:unsubscribed}', async () => {
    // Queue an email intent to EMAIL_B; do NOT complete it.
    const q = await outbox({ channel: 'email', to_address: EMAIL_B, body: 'pre-unsub', approval_ref: self });
    emailBId = (assertStatus(q, 201, 'queue EMAIL_B') as OutboxShape).id;

    const r = await api('POST', `/v1/unsubscribe/email/${unsubToken(EMAIL_B)}`);
    const body = assertStatus(r, 200, 'one-click unsubscribe') as { status: string };
    assert(body.status === 'unsubscribed', `status: ${body.status}`);
  });

  await check('the queued EMAIL_B intent is parked undeliverable/opted_out', async () => {
    const r = await api('GET', `${base}/outbox/${emailBId}`, { token: fx.agentToken });
    const row = assertStatus(r, 200, 'parked row') as OutboxShape;
    assert(row.status === 'undeliverable', `status: ${row.status}`);
    assert(row.error_code === 'opted_out', `error_code: ${row.error_code}`);
  });

  await check('a new email intent to EMAIL_B → 422 opted_out', async () => {
    const r = await outbox({ channel: 'email', to_address: EMAIL_B, body: 'post-unsub', approval_ref: self });
    assertStatus(r, 422, 'new intent to opted-out address');
    if (errCode(r) !== 'opted_out') throw new Error(`code: ${errCode(r)}`);
  });

  await check('unsubscribe GET → 200 HTML confirmation page containing the address; then new intent 422', async () => {
    const g = await raw('GET', `/v1/unsubscribe/email/${unsubToken(EMAIL_C)}`);
    assert(g.status === 200, `GET status: ${g.status}`);
    assert(g.contentType.includes('text/html'), `content-type: ${g.contentType}`);
    assert(g.text.includes(EMAIL_C), `page missing the address: ${g.text.slice(0, 200)}`);
    // GET registers immediately: a fresh intent is now refused.
    const r = await outbox({ channel: 'email', to_address: EMAIL_C, body: 'after GET', approval_ref: self });
    assertStatus(r, 422, 'intent after GET unsubscribe');
  });

  await check('unsubscribe POST replay (EMAIL_B) → 200 idempotent', async () => {
    const r = await api('POST', `/v1/unsubscribe/email/${unsubToken(EMAIL_B)}`);
    const body = assertStatus(r, 200, 'replay unsubscribe') as { status: string };
    assert(body.status === 'unsubscribed', `status: ${body.status}`);
  });

  await check('tampered token → 404; garbage token → 404', async () => {
    const valid = unsubToken(EMAIL_B);
    const [addr, mac] = valid.split('.');
    if (!addr || !mac) throw new Error(`unexpected token shape: ${valid}`);
    const flipped = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
    const tampered = await api('POST', `/v1/unsubscribe/email/${addr}.${flipped}`);
    assertStatus(tampered, 404, 'tampered mac');
    const garbage = await api('POST', `/v1/unsubscribe/email/not-a-token`);
    assertStatus(garbage, 404, 'structurally garbage token');
  });

  // =========================================================================
  // (E) dispatch-scan channel filter
  // =========================================================================
  let scanEmailId = '';
  await check('dispatch scan ?channel=email returns only email rows and includes the email intent', async () => {
    const smsIntent = await outbox({ channel: 'sms', to_address: SMS_PHONE, body: 'scan sms', approval_ref: self });
    assertStatus(smsIntent, 201, 'scan sms intent');
    const emailIntent = await outbox({
      channel: 'email', to_address: EMAIL_D, subject: 'scan', body: 'scan email', approval_ref: self,
    });
    scanEmailId = (assertStatus(emailIntent, 201, 'scan email intent') as OutboxShape).id;

    const r = await api('GET', `${base}/outbox?status=queued&channel=email`, { token: fx.agentToken });
    const rows = (assertStatus(r, 200, 'scan email') as { data: OutboxShape[] }).data;
    assert(rows.every((x) => x.channel === 'email'), `non-email row leaked: ${JSON.stringify(rows.map((x) => x.channel))}`);
    assert(rows.some((x) => x.id === scanEmailId), 'the email intent is in the email scan');
  });

  await check('dispatch scan ?channel=sms excludes the email row', async () => {
    const r = await api('GET', `${base}/outbox?status=queued&channel=sms`, { token: fx.agentToken });
    const rows = (assertStatus(r, 200, 'scan sms') as { data: OutboxShape[] }).data;
    assert(rows.every((x) => x.channel === 'sms'), `non-sms row leaked: ${JSON.stringify(rows.map((x) => x.channel))}`);
    assert(!rows.some((x) => x.id === scanEmailId), 'the email row must not appear in the sms scan');
  });

  // =========================================================================
  // (F) renewal email rides the comms ledger (unconditional)
  // =========================================================================
  // A capture token needs a live inspection tied to the tenancy. move_in
  // requires a tenancy_id and the inspection area to match the tenancy unit.
  let inspectionId = '';
  await check('setup: inspection + tenant email for the renewal flow', async () => {
    const r = await api('POST', `/v1/accounts/${fx.accountId}/inspections`, {
      token: fx.landlordToken, body: { area_id: fx.unitId, tenancy_id: fx.tenancyId, kind: 'move_in' },
    });
    inspectionId = (assertStatus(r, 201, 'create inspection') as { id: string }).id;
    const { error } = await admin.from('tenants').update({ emails: [RENEWAL_EMAIL] }).eq('id', fx.tenant1Id);
    if (error) throw new Error(`set tenant1 email: ${error.message}`);
  });

  await check('renewal request → 202 and writes a system:capture_renewal email intent to the on-file address', async () => {
    const minted = await mintCaptureTokenAdmin({
      accountId: fx.accountId, inspectionId, tenantId: fx.tenant1Id, ttlMinutes: 60,
    });
    const r = await api('POST', '/v1/inspection-capture/request-renewal', { body: { secret: minted.secret } });
    assertStatus(r, 202, 'request-renewal');

    // Fire-and-forget outbox write: poll (~2s) for the row.
    let row: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !row; i++) {
      const { data } = await admin.from('comm_outbox')
        .select('*')
        .eq('account_id', fx.accountId)
        .eq('approval_ref', 'system:capture_renewal')
        .eq('to_address', RENEWAL_EMAIL.toLowerCase());
      row = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (!row) await sleep(100);
    }
    assert(row !== undefined, 'no system:capture_renewal outbox row appeared');
    assert(row!.channel === 'email', `channel: ${String(row!.channel)}`);
    assert(row!.to_address === RENEWAL_EMAIL.toLowerCase(), `to_address: ${String(row!.to_address)}`);
    assert(row!.author_type === 'system', `author_type: ${String(row!.author_type)}`);
    assert(row!.subject === 'Your condition form link', `subject: ${String(row!.subject)}`);
    assert(String(row!.body).includes('/capture/'), `body missing /capture/: ${String(row!.body).slice(0, 120)}`);
    assert(row!.status === 'queued', `status: ${String(row!.status)}`);
    // The renewal path copies the inspection's tenancy onto the journal-context
    // field unconditionally, and the fixture's inspection carries one.
    assert(
      row!.tenancy_id === fx.tenancyId,
      `tenancy_id: ${String(row!.tenancy_id)} (expected ${fx.tenancyId})`,
    );
  });

  await check('renewal to an opted-out address is suppressed (no row) while the route still 202s', async () => {
    // Register the opt-out FIRST, then point the token's tenant at that address.
    const oo = await api('POST', `/v1/unsubscribe/email/${unsubToken(RENEWAL_EMAIL2)}`);
    assertStatus(oo, 200, 'opt-out RENEWAL_EMAIL2');
    const { error } = await admin.from('tenants').update({ emails: [RENEWAL_EMAIL2] }).eq('id', fx.tenant2Id);
    if (error) throw new Error(`set tenant2 email: ${error.message}`);

    // Pin the MECHANISM, not just the absence of a row: a zero-row assertion
    // alone passes for any unrelated early return (no tenant, no email, dead
    // token). Prove the two preconditions hold first, so the only remaining
    // explanation for zero rows is the P0004 opt-out refusal.
    const { data: optOut } = await admin.from('comm_opt_outs')
      .select('address').eq('channel', 'email').eq('address', RENEWAL_EMAIL2.toLowerCase()).maybeSingle();
    assert(optOut != null, `no comm_opt_outs row for ${RENEWAL_EMAIL2.toLowerCase()}`);
    const { data: tenant2 } = await admin.from('tenants').select('emails').eq('id', fx.tenant2Id).maybeSingle();
    assert(
      JSON.stringify(tenant2?.emails) === JSON.stringify([RENEWAL_EMAIL2]),
      `tenant2 emails: ${JSON.stringify(tenant2?.emails)} (expected ["${RENEWAL_EMAIL2}"])`,
    );

    const minted = await mintCaptureTokenAdmin({
      accountId: fx.accountId, inspectionId, tenantId: fx.tenant2Id, ttlMinutes: 60,
    });
    const r = await api('POST', '/v1/inspection-capture/request-renewal', { body: { secret: minted.secret } });
    assertStatus(r, 202, 'request-renewal (opted-out)');

    // The insert is refused by the opt-out trigger (logged, not thrown): no row.
    await sleep(1500);
    const { data } = await admin.from('comm_outbox')
      .select('id').eq('account_id', fx.accountId).eq('to_address', RENEWAL_EMAIL2.toLowerCase());
    assert((data ?? []).length === 0, `opted-out renewal wrote a row: ${(data ?? []).length}`);
  });

  // =========================================================================
  // (G) sanity: subject survives the outbox read path
  // =========================================================================
  await check('GET /comms/outbox/{id} for the email row carries subject', async () => {
    const r = await api('GET', `${base}/outbox/${emailAId}`, { token: fx.agentToken });
    const row = assertStatus(r, 200, 'read email row') as OutboxShape;
    assert(row.subject === 'Hello there', `subject: ${row.subject}`);
  });

  // --- summary ---------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} comms email slice-1 check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: comms email slice-1 checks all green');
}

await main();
