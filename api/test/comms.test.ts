// ----------------------------------------------------------------------------
// Comms ledger integration tests (comms build M2/M3).
//
// Exercises the /comms surface end-to-end against a real Supabase stack:
// threads + bindings, the outbox intent -> claim -> complete cycle (ADR-0007
// atomicity: journal appended exactly once, only on confirmed send), monotonic
// delivery, opt-out enforcement at the intent boundary, inbound capture with
// provider_msg_id idempotency, standing-policy provenance, principal gating
// (agent transport vs owner/manager vs viewer), idempotency-key replay, and
// events-feed surfacing of the new entity types.
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
const admin = getAdminClient();

async function createAuthUser(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = `comms-${label}-${crypto.randomUUID()}@internal.test`;
  const password = `pw-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data?.user) throw new Error(`createUser ${label}: ${error?.message}`);
  return { id: data.user.id, email, password };
}

const agentAuth = await createAuthUser('agent');
const viewerAuth = await createAuthUser('viewer');

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

// Direct PostgREST call with a member's real JWT — the threat model the DB
// triggers/RLS defend against (a member reaching past the API layer). Used to
// exercise the DB-layer hardening guards (F1 outbox capacity, F5 binding FK).
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

// --- fixture ------------------------------------------------------------------

// Randomized per run: platform numbers are globally unique and the opt-out
// register is global, so fixed values would make the suite single-shot
// against a persistent local stack.
const SUFFIX = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');
const PLATFORM_NUMBER = `+1202${SUFFIX}`;
const TENANT_ADDR = `+1303${SUFFIX}`;
const OTHER_ADDR = `+1404${SUFFIX}`;

interface Fixture {
  accountId: string;
  landlordToken: string;
  landlordId: string;
  agentToken: string;
  viewerToken: string;
  tenantId: string;
  tenancyId: string;
}

async function setup(): Promise<Fixture> {
  const email = `comms-landlord-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: 'Comms Acct' },
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
  const tenant = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, {
    full_name: 'Tessa Tenant',
  });

  // Memberships: the agent transport and a read-only viewer.
  for (const [userId, role] of [[agentAuth.id, 'agent'], [viewerAuth.id, 'viewer']] as const) {
    const { error } = await admin.from('account_members').insert({
      account_id: accountId, user_id: userId, role,
    });
    if (error) throw new Error(`membership ${role}: ${error.message}`);
  }

  // Ops-tier provisioning (service role, like prod): a platform number and
  // the tenant's sms identity.
  {
    const { error } = await admin.from('platform_numbers').insert({
      account_id: accountId, number: PLATFORM_NUMBER, provider: 'test', capabilities: ['sms'],
    });
    if (error) throw new Error(`platform number: ${error.message}`);
  }
  {
    const { error } = await admin.from('channel_identities').insert({
      account_id: accountId, party_type: 'tenant', party_id: tenant.id,
      channel: 'sms', address: TENANT_ADDR,
    });
    if (error) throw new Error(`channel identity: ${error.message}`);
  }

  return {
    accountId,
    landlordToken: token,
    landlordId: b.user.id,
    agentToken: await login(agentAuth.email, agentAuth.password),
    viewerToken: await login(viewerAuth.email, viewerAuth.password),
    tenantId: tenant.id,
    tenancyId: tenancy.id,
  };
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Comms ledger integration tests');
  const fx = await setup();
  const base = `/v1/accounts/${fx.accountId}/comms`;
  const L = (body: unknown, path: string, key?: string) =>
    api('POST', `${base}${path}`, { token: fx.landlordToken, body, idempotencyKey: key });
  const A = (body: unknown, path: string, key?: string) =>
    api('POST', `${base}${path}`, { token: fx.agentToken, body, idempotencyKey: key });

  // =========================================================================
  // Threads
  // =========================================================================
  let threadId = '';
  let tenantParticipantId = '';
  await check('landlord creates a bridged thread with binding', async () => {
    const r = await L({
      kind: 'bridged_tenant',
      channel: 'sms',
      tenancy_id: fx.tenancyId,
      participants: [
        { party_type: 'tenant', party_id: fx.tenantId },
        { party_type: 'landlord_user', party_id: fx.landlordId },
      ],
    }, '/threads');
    const t = assertStatus(r, 201, 'thread create') as {
      id: string; kind: string; status: string;
      participants: { id: string; party_type: string }[];
      bindings: { platform_number: string; participant_address: string; active: boolean }[];
      messages: unknown[];
    };
    threadId = t.id;
    assert(t.status === 'active', `status: ${t.status}`);
    assert(t.participants.length === 2, `participants: ${t.participants.length}`);
    tenantParticipantId = t.participants.find((p) => p.party_type === 'tenant')!.id;
    assert(t.bindings.length === 1, `bindings: ${t.bindings.length}`);
    assert(t.bindings[0]!.platform_number === PLATFORM_NUMBER, 'binding number');
    assert(t.bindings[0]!.participant_address === TENANT_ADDR, 'binding address (identity-resolved)');
  });

  await check('duplicate active binding for same counterparty+number → 409', async () => {
    const r = await L({
      kind: 'bridged_tenant',
      channel: 'sms',
      participants: [{ party_type: 'tenant', party_id: fx.tenantId }],
    }, '/threads');
    assertStatus(r, 409, 'dup binding');
    // The cleanup path must not leave a skeleton thread behind.
    const { data: orphans } = await admin
      .from('comm_threads').select('id').eq('account_id', fx.accountId);
    assert((orphans ?? []).length === 1, `expected 1 thread after failed create, got ${(orphans ?? []).length}`);
  });

  await check('viewer cannot create threads (403); agent cannot either', async () => {
    const body = { kind: 'bridged_tenant', channel: 'sms', participants: [{ party_type: 'tenant', party_id: fx.tenantId }] };
    const rv = await api('POST', `${base}/threads`, { token: fx.viewerToken, body });
    assertStatus(rv, 403, 'viewer thread create');
    const ra = await api('POST', `${base}/threads`, { token: fx.agentToken, body });
    assertStatus(ra, 403, 'agent thread create');
  });

  await check('unbuilt/unconfigured channel thread creation is refused (F7, updated for E2-A)', async () => {
    // voice bridging is still unbuilt -> 501. Email threads are REAL since
    // E2-A (covered by test/comms-email-threads.test.ts); this suite runs
    // without EMAIL_REPLY_DOMAIN, so the email path must refuse with a typed
    // 503 (not mis-send, not 500) — the F7 no-silent-mis-send guarantee.
    const v = await L({
      kind: 'bridged_tenant', channel: 'voice',
      participants: [{ party_type: 'tenant', party_id: fx.tenantId, address: '+15550000001' }],
    }, '/threads');
    assertStatus(v, 501, 'voice thread');
    if (errCode(v) !== 'not_implemented') throw new Error(`code: ${errCode(v)}`);

    const r = await L({
      kind: 'bridged_tenant', channel: 'email',
      participants: [{ party_type: 'tenant', party_id: fx.tenantId, address: 'tessa@example.test' }],
    }, '/threads');
    assertStatus(r, 503, 'email thread without EMAIL_REPLY_DOMAIN');
    if (errCode(r) !== 'service_unavailable') throw new Error(`code: ${errCode(r)}`);
  });

  // =========================================================================
  // Landlord-authored thread message -> outbox intents
  // =========================================================================
  let msgOutboxId = '';
  await check('thread message creates one queued intent per counterparty, self-approved', async () => {
    const r = await L({ body: 'Hi Tessa — checking in.' }, `/threads/${threadId}/messages`);
    const out = assertStatus(r, 201, 'thread message') as { data: {
      id: string; status: string; to_address: string; approval_ref: string;
      approved_by: string; author_type: string; thread_id: string;
    }[] };
    assert(out.data.length === 1, `intents: ${out.data.length}`);
    const row = out.data[0]!;
    msgOutboxId = row.id;
    assert(row.status === 'queued', `status: ${row.status}`);
    assert(row.to_address === TENANT_ADDR, `to: ${row.to_address}`);
    assert(row.approval_ref === `self:${fx.landlordId}`, `approval_ref: ${row.approval_ref}`);
    assert(row.approved_by === fx.landlordId, 'approved_by = caller');
    assert(row.author_type === 'landlord', `author_type: ${row.author_type}`);
  });

  // =========================================================================
  // Outbox create: provenance rules
  // =========================================================================
  await check('landlord direct intent must carry self: provenance', async () => {
    const bad = await L({
      channel: 'sms', to_address: TENANT_ADDR, body: 'x', approval_ref: 'grant:not-mine',
    }, '/outbox');
    assertStatus(bad, 400, 'landlord bad approval_ref');
    const good = await L({
      channel: 'sms', to_address: TENANT_ADDR, body: 'direct note',
      approval_ref: `self:${fx.landlordId}`,
    }, '/outbox');
    const row = assertStatus(good, 201, 'landlord direct intent') as { approved_by: string };
    assert(row.approved_by === fx.landlordId, 'approved_by stamped');
  });

  await check('viewer cannot create intents (403)', async () => {
    const r = await api('POST', `${base}/outbox`, {
      token: fx.viewerToken,
      body: { channel: 'sms', to_address: TENANT_ADDR, body: 'x', approval_ref: 'self:whatever' },
    });
    assertStatus(r, 403, 'viewer outbox');
  });

  // Standing policy for agent grant sends.
  let policyId = '';
  await check('policy create validates canonical rent_reminder params', async () => {
    const bad = await L({
      policy_kind: 'rent_reminder', channel: 'sms', params: { days_before: 3, typo_key: 1 },
    }, '/policies');
    assertStatus(bad, 400, 'bad params');
    const r = await L({
      policy_kind: 'rent_reminder', channel: 'sms',
      params: { days_before: 3, monthly_cap: 2 },
      quiet_hours: { start: '21:00', end: '08:00', timezone: 'America/Los_Angeles' },
    }, '/policies');
    const p = assertStatus(r, 201, 'policy create') as {
      id: string; status: string; approved_by: string;
    };
    policyId = p.id;
    assert(p.status === 'active', `status: ${p.status}`);
    assert(p.approved_by === fx.landlordId, 'creation is the approval act');
  });

  await check('agent intent under a live grant → 201 with honest provenance', async () => {
    const r = await A({
      channel: 'sms', to_address: TENANT_ADDR, body: 'Rent is due in 3 days.',
      approval_ref: `grant:${policyId}`,
    }, '/outbox');
    const row = assertStatus(r, 201, 'agent grant intent') as {
      approved_by: string | null; author_type: string;
    };
    assert(row.approved_by === null, 'approved_by stays null under a grant');
    assert(row.author_type === 'agent', `author_type: ${row.author_type}`);
  });

  await check('agent intent whose channel mismatches the grant → 403 (hardening F3)', async () => {
    // policyId is an sms rent_reminder grant; a voice send under it is refused.
    const r = await A({
      channel: 'voice', to_address: TENANT_ADDR, body: 'call reminder',
      approval_ref: `grant:${policyId}`,
    }, '/outbox');
    assertStatus(r, 403, 'grant channel mismatch');
  });

  await check('agent intent with dead/foreign grant or bare proposal ref → 403', async () => {
    const dead = await A({
      channel: 'sms', to_address: TENANT_ADDR, body: 'x',
      approval_ref: `grant:${crypto.randomUUID()}`,
    }, '/outbox');
    assertStatus(dead, 403, 'unknown grant');
    const bare = await A({
      channel: 'sms', to_address: TENANT_ADDR, body: 'x', approval_ref: 'proposal:123',
    }, '/outbox');
    assertStatus(bare, 403, 'proposal ref without approved_by');
    if (errCode(bare) !== 'agent_entry_type_forbidden') throw new Error(`code: ${errCode(bare)}`);
  });

  await check('agent proposal-approved intent (approved_by = landlord) → 201', async () => {
    const r = await A({
      channel: 'sms', to_address: TENANT_ADDR, body: 'Approved reply.',
      approval_ref: 'proposal:77', approved_by: fx.landlordId,
    }, '/outbox');
    assertStatus(r, 201, 'agent approved intent');
  });

  await check('Idempotency-Key replay returns the same intent, exactly one row', async () => {
    const key = `comms-replay-${rnd()}`;
    const body = {
      channel: 'sms', to_address: TENANT_ADDR, body: 'replay-me',
      approval_ref: `grant:${policyId}`,
    };
    const r1 = await A(body, '/outbox', key);
    const r2 = await A(body, '/outbox', key);
    const id1 = (assertStatus(r1, 201, 'first') as { id: string }).id;
    const id2 = (assertStatus(r2, 201, 'replay') as { id: string }).id;
    assert(id1 === id2, `ids differ: ${id1} vs ${id2}`);
    const { data } = await admin.from('comm_outbox')
      .select('id').eq('account_id', fx.accountId).eq('body', 'replay-me');
    assert((data ?? []).length === 1, `rows: ${(data ?? []).length}`);
  });

  // =========================================================================
  // Dispatch scan, claim, complete (ADR-0007 atomicity), delivery
  // =========================================================================
  await check('dispatch scan is transport-only and filters eligibility', async () => {
    const rl = await api('GET', `${base}/outbox?status=queued`, { token: fx.landlordToken });
    assertStatus(rl, 403, 'landlord scan');
    // A future-dated intent must not be eligible now.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const notYet = await A({
      channel: 'sms', to_address: TENANT_ADDR, body: 'later',
      approval_ref: `grant:${policyId}`, not_before: future,
    }, '/outbox');
    const notYetId = (assertStatus(notYet, 201, 'future intent') as { id: string }).id;
    const now = new Date().toISOString();
    const r = await api('GET', `${base}/outbox?status=queued&eligible_at=${encodeURIComponent(now)}`, {
      token: fx.agentToken,
    });
    const page = assertStatus(r, 200, 'scan') as { data: { id: string }[] };
    assert(page.data.some((x) => x.id === msgOutboxId), 'landlord msg intent in scan');
    assert(!page.data.some((x) => x.id === notYetId), 'future intent excluded');
  });

  await check("claim: delivery {status:'sending'} moves queued → sending", async () => {
    const r = await A({ status: 'sending', provider_ts: new Date().toISOString() },
      `/outbox/${msgOutboxId}/delivery`);
    const row = assertStatus(r, 200, 'claim') as { status: string };
    assert(row.status === 'sending', `status: ${row.status}`);
  });

  const SID = `SM-${rnd()}`;
  let journalId = '';
  await check('complete: marks sent + appends journal atomically', async () => {
    const r = await A({ provider: 'test', provider_sid: SID }, `/outbox/${msgOutboxId}/complete`);
    const body = assertStatus(r, 200, 'complete') as {
      interaction_id: string; outbox: { status: string; provider_sid: string; interaction_id: string };
    };
    journalId = body.interaction_id;
    assert(body.outbox.status === 'sent', `status: ${body.outbox.status}`);
    assert(body.outbox.provider_sid === SID, 'sid stored');
    assert(body.outbox.interaction_id === journalId, 'journal linked');

    const g = await api('GET', `/v1/accounts/${fx.accountId}/interactions/${journalId}`, {
      token: fx.landlordToken,
    });
    const j = assertStatus(g, 200, 'journal row') as Record<string, unknown>;
    assert(j.kind === 'communication' && j.channel === 'sms' && j.direction === 'outbound', 'journal shape');
    assert(j.external_ref === SID, `external_ref: ${j.external_ref}`);
    assert(j.author_type === 'landlord', `author_type survives transport completion: ${j.author_type}`);
    assert(j.approval_ref === `self:${fx.landlordId}`, 'provenance carried');
    assert(j.thread_id === threadId, 'thread linked');
    assert(j.party_type === 'tenant' && j.party_id === fx.tenantId, 'party attribution');
  });

  await check('complete replay with same sid is idempotent (exactly one journal row)', async () => {
    const r = await A({ provider: 'test', provider_sid: SID }, `/outbox/${msgOutboxId}/complete`);
    const body = assertStatus(r, 200, 'replay') as { interaction_id: string };
    assert(body.interaction_id === journalId, 'same interaction id');
    const { data } = await admin.from('interactions')
      .select('id').eq('account_id', fx.accountId).eq('external_ref', SID);
    assert((data ?? []).length === 1, `journal rows for sid: ${(data ?? []).length}`);
  });

  await check('fail: definitive rejection leaves NO journal row', async () => {
    const r = await A({
      channel: 'sms', to_address: TENANT_ADDR, body: 'will-fail',
      approval_ref: `grant:${policyId}`,
    }, '/outbox');
    const id = (assertStatus(r, 201, 'intent') as { id: string }).id;
    const f = await A({ error_code: 'rejected_21610', detail: 'carrier rejection' }, `/outbox/${id}/fail`);
    const row = assertStatus(f, 200, 'fail') as { status: string; interaction_id: string | null };
    assert(row.status === 'failed', `status: ${row.status}`);
    assert(row.interaction_id === null, 'no journal link');
    const { data } = await admin.from('interactions')
      .select('id').eq('account_id', fx.accountId).eq('body', 'will-fail');
    assert((data ?? []).length === 0, 'no journal row for a failed send');
    // Terminal: a later complete must 409.
    const c2 = await A({ provider: 'test', provider_sid: `SM-${rnd()}` }, `/outbox/${id}/complete`);
    assertStatus(c2, 409, 'complete after failed');
  });

  await check('needs_reconcile parks and is resolvable via complete', async () => {
    const r = await A({
      channel: 'sms', to_address: TENANT_ADDR, body: 'ambiguous',
      approval_ref: `grant:${policyId}`,
    }, '/outbox');
    const id = (assertStatus(r, 201, 'intent') as { id: string }).id;
    const park = await A({ error_code: 'timeout', reconcile: true }, `/outbox/${id}/fail`);
    assert((assertStatus(park, 200, 'park') as { status: string }).status === 'needs_reconcile', 'parked');
    const resolve = await A({ provider: 'test', provider_sid: `SM-${rnd()}` }, `/outbox/${id}/complete`);
    assertStatus(resolve, 200, 'manual resolve');
  });

  await check('delivery is monotonic; stale callbacks are ignored', async () => {
    const ts = new Date().toISOString();
    const d = await A({ status: 'delivered', provider_ts: ts }, `/outbox/${msgOutboxId}/delivery`);
    const row = assertStatus(d, 200, 'delivered') as { status: string; delivered_at: string | null };
    assert(row.status === 'delivered', `status: ${row.status}`);
    assert(row.delivered_at !== null, 'delivered_at set');
    const stale = await A({ status: 'sent', provider_ts: ts }, `/outbox/${msgOutboxId}/delivery`);
    const still = assertStatus(stale, 200, 'stale callback') as { status: string };
    assert(still.status === 'delivered', `regressed to: ${still.status}`);
  });

  await check('context linkage: complete copies tenancy_id onto the journal (item 3)', async () => {
    const r = await A({
      channel: 'sms', to_address: `+1810${SUFFIX}`, body: 'about your tenancy',
      approval_ref: `grant:${policyId}`, tenancy_id: fx.tenancyId,
    }, '/outbox');
    const row = assertStatus(r, 201, 'intent w/ context') as { id: string; tenancy_id: string | null };
    assert(row.tenancy_id === fx.tenancyId, 'outbox carries tenancy_id');
    const done = await A({ provider: 'test', provider_sid: `SM-${rnd()}` }, `/outbox/${row.id}/complete`);
    const jid = (assertStatus(done, 200, 'complete') as { interaction_id: string }).interaction_id;
    const g = await api('GET', `/v1/accounts/${fx.accountId}/interactions/${jid}`, { token: fx.landlordToken });
    const j = assertStatus(g, 200, 'journal') as { tenancy_id: string | null };
    assert(j.tenancy_id === fx.tenancyId, `journal tenancy_id: ${j.tenancy_id}`);
  });

  await check('relay: thread: provenance + no double-journal (items 1+2)', async () => {
    // An inbound tenant message, journaled once in the thread.
    const inMsgId = `IN-relay-${rnd()}`;
    const cap = await A({
      provider: 'test', provider_msg_id: inMsgId, to_number: PLATFORM_NUMBER,
      from_address: TENANT_ADDR, channel: 'sms', body: 'relay me',
      received_at: new Date().toISOString(),
    }, '/inbound');
    const capRes = assertStatus(cap, 200, 'inbound for relay') as { thread_id: string; interaction_id: string };
    assert(capRes.thread_id === threadId, 'inbound landed in the thread');
    const originalId = capRes.interaction_id;

    // thread: provenance is relay-only: without relay_of_interaction_id → 403.
    const noRelay = await A({
      channel: 'sms', to_address: `+1808${SUFFIX}`, body: 'forward', approval_ref: `thread:${threadId}`,
    }, '/outbox');
    assertStatus(noRelay, 403, 'thread ref without relay');
    // A relayed interaction not in the cited thread → 403.
    const foreign = await A({
      channel: 'sms', to_address: `+1808${SUFFIX}`, body: 'forward',
      approval_ref: `thread:${crypto.randomUUID()}`, relay_of_interaction_id: originalId,
    }, '/outbox');
    assertStatus(foreign, 403, 'foreign thread ref');

    // Valid relay intent under thread: provenance.
    const relay = await A({
      channel: 'sms', to_address: `+1808${SUFFIX}`, body: 'forward',
      approval_ref: `thread:${threadId}`, relay_of_interaction_id: originalId,
    }, '/outbox');
    const relayId = (assertStatus(relay, 201, 'relay intent') as { id: string }).id;

    // Completing a relay leg does NOT mint a second journal row; it links to
    // the original and returns its id.
    const before = await admin.from('interactions')
      .select('*', { count: 'exact', head: true }).eq('account_id', fx.accountId).eq('thread_id', threadId);
    const done = await A({ provider: 'test', provider_sid: `SM-relay-${rnd()}` }, `/outbox/${relayId}/complete`);
    const doneBody = assertStatus(done, 200, 'relay complete') as {
      interaction_id: string; outbox: { interaction_id: string; status: string };
    };
    assert(doneBody.interaction_id === originalId, 'relay completion returns the original interaction id');
    assert(doneBody.outbox.interaction_id === originalId, 'relay outbox links to the original');
    assert(doneBody.outbox.status === 'sent', 'relay leg marked sent');
    const after = await admin.from('interactions')
      .select('*', { count: 'exact', head: true }).eq('account_id', fx.accountId).eq('thread_id', threadId);
    assert(before.count === after.count, `no new journal row on relay (before ${before.count}, after ${after.count})`);
  });

  // =========================================================================
  // Inbound capture
  // =========================================================================
  const MSGID = `IN-${rnd()}`;
  await check('inbound from bound address matches, journals, and is idempotent', async () => {
    const body = {
      provider: 'test', provider_msg_id: MSGID, to_number: PLATFORM_NUMBER,
      from_address: TENANT_ADDR, channel: 'sms', body: 'The sink is fixed, thanks!',
      received_at: new Date().toISOString(),
    };
    const r1 = await A(body, '/inbound');
    const res = assertStatus(r1, 200, 'capture') as {
      disposition: string; interaction_id: string; thread_id: string;
      participant: { id: string; party_type: string } | null;
    };
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === threadId, 'routed to thread');
    assert(res.participant?.id === tenantParticipantId, 'participant resolved');

    const g = await api('GET', `/v1/accounts/${fx.accountId}/interactions/${res.interaction_id}`, {
      token: fx.landlordToken,
    });
    const j = assertStatus(g, 200, 'journal') as Record<string, unknown>;
    assert(j.direction === 'inbound' && j.author_type === 'tenant', 'inbound authorship');
    assert(j.external_ref === MSGID, 'provider_msg_id as external_ref');

    const r2 = await A(body, '/inbound', `replay-${rnd()}`);
    const res2 = assertStatus(r2, 200, 'replay') as { interaction_id: string };
    assert(res2.interaction_id === res.interaction_id, 'replay returns original');
    const { data } = await admin.from('interactions')
      .select('id').eq('account_id', fx.accountId).eq('external_ref', MSGID);
    assert((data ?? []).length === 1, `journal rows: ${(data ?? []).length}`);
  });

  await check('inbound from an unbound address is an orphan (raw only)', async () => {
    const r = await A({
      provider: 'test', provider_msg_id: `IN-${rnd()}`, to_number: PLATFORM_NUMBER,
      from_address: `+1505${SUFFIX}`, channel: 'sms', body: 'who dis',
      received_at: new Date().toISOString(),
    }, '/inbound');
    const res = assertStatus(r, 200, 'orphan capture') as {
      disposition: string; interaction_id: string | null;
    };
    assert(res.disposition === 'orphan', `disposition: ${res.disposition}`);
    assert(res.interaction_id === null, 'nothing journaled');
  });

  await check('inbound capture is transport-only', async () => {
    const r = await api('POST', `${base}/inbound`, {
      token: fx.landlordToken,
      body: {
        provider: 'test', provider_msg_id: `IN-${rnd()}`, to_number: PLATFORM_NUMBER,
        from_address: TENANT_ADDR, channel: 'sms', received_at: new Date().toISOString(),
      },
    });
    assertStatus(r, 403, 'landlord inbound');
  });

  // =========================================================================
  // Opt-outs
  // =========================================================================
  await check('opt-out: parks queued intents, blocks new ones at the boundary', async () => {
    // A queued intent that predates the opt-out.
    const pre = await A({
      channel: 'sms', to_address: TENANT_ADDR, body: 'pre-optout',
      approval_ref: `grant:${policyId}`,
    }, '/outbox');
    const preId = (assertStatus(pre, 201, 'pre intent') as { id: string }).id;

    const oo = await A({
      channel: 'sms', address: TENANT_ADDR, keyword: 'STOP', source_ref: `IN-${rnd()}`,
    }, '/opt-outs');
    const row = assertStatus(oo, 200, 'opt-out') as { channel: string; address: string; keyword: string };
    assert(row.address === TENANT_ADDR && row.keyword === 'STOP', 'register row');

    const { data: parked } = await admin.from('comm_outbox')
      .select('status, error_code').eq('id', preId).single();
    assert(parked?.status === 'undeliverable' && parked?.error_code === 'opted_out',
      `parked: ${JSON.stringify(parked)}`);

    const blocked = await L({ body: 'still there?' }, `/threads/${threadId}/messages`);
    assertStatus(blocked, 422, 'post-optout send');
    if (errCode(blocked) !== 'opted_out') throw new Error(`code: ${errCode(blocked)}`);

    // Inbound still journals, but the disposition warns the transport.
    const inb = await A({
      provider: 'test', provider_msg_id: `IN-${rnd()}`, to_number: PLATFORM_NUMBER,
      from_address: TENANT_ADDR, channel: 'sms', body: 'STOP',
      received_at: new Date().toISOString(),
    }, '/inbound');
    const res = assertStatus(inb, 200, 'inbound after optout') as { disposition: string; interaction_id: string | null };
    assert(res.disposition === 'opted_out', `disposition: ${res.disposition}`);
    assert(res.interaction_id !== null, 'contact still journaled');

    // Replay of the same opt-out is a no-op. The RPC does NOT echo the stored
    // keyword/source_ref for a pre-existing row (hardening F4 — the register is
    // global, so echoing would leak another account's recording metadata), but
    // the first recording IS kept intact (verified via the admin read).
    const again = await A({
      channel: 'sms', address: TENANT_ADDR, keyword: 'STOPALL', source_ref: `IN-${rnd()}`,
    }, '/opt-outs');
    const rowAgain = assertStatus(again, 200, 'opt-out replay') as { keyword: string | null; source_ref: string | null };
    assert(rowAgain.keyword === null && rowAgain.source_ref === null,
      'replay does not echo stored recording metadata');
    const { data: stored } = await admin.from('comm_opt_outs')
      .select('keyword').eq('channel', 'sms').eq('address', TENANT_ADDR).single();
    assert(stored?.keyword === 'STOP', 'first opt-out wins (original evidence kept)');
  });

  await check('landlord reads opt-outs scoped to known addresses; viewer/agent denied', async () => {
    const r = await api('GET', `${base}/opt-outs`, { token: fx.landlordToken });
    const page = assertStatus(r, 200, 'list') as { data: { address: string }[] };
    assert(page.data.some((x) => x.address === TENANT_ADDR), 'known address listed');
    assertStatus(await api('GET', `${base}/opt-outs`, { token: fx.viewerToken }), 403, 'viewer');
    assertStatus(await api('GET', `${base}/opt-outs`, { token: fx.agentToken }), 403, 'agent');
  });

  // =========================================================================
  // Thread reads
  // =========================================================================
  await check('thread detail carries messages with delivery state and relay legs', async () => {
    const r = await api('GET', `${base}/threads/${threadId}?limit=50`, { token: fx.landlordToken });
    const t = assertStatus(r, 200, 'detail') as {
      participants: unknown[]; bindings: unknown[];
      messages: { id: string; direction: string; delivery_status: string | null; relay_legs: unknown[] }[];
    };
    assert(t.participants.length === 2 && t.bindings.length === 1, 'structure');
    const outMsg = t.messages.find((m) => m.id === journalId);
    assert(outMsg !== undefined, 'completed send in thread');
    assert(outMsg!.delivery_status === 'delivered', `delivery_status: ${outMsg!.delivery_status}`);
    const inMsg = t.messages.find((m) => m.direction === 'inbound');
    assert(inMsg !== undefined && inMsg.delivery_status === null, 'inbound has no delivery state');

    // Messages page: limit=1 must yield a cursor and a second page.
    const p1 = await api('GET', `${base}/threads/${threadId}?limit=1`, { token: fx.landlordToken });
    const page1 = assertStatus(p1, 200, 'page1') as { messages: unknown[]; messages_next_cursor: string | null };
    assert(page1.messages.length === 1 && page1.messages_next_cursor !== null, 'cursor present');
    const p2 = await api('GET',
      `${base}/threads/${threadId}?limit=1&cursor=${encodeURIComponent(page1.messages_next_cursor!)}`,
      { token: fx.landlordToken });
    const page2 = assertStatus(p2, 200, 'page2') as { messages: { id: string }[] };
    assert(page2.messages.length === 1, 'second page');
    assert(page2.messages[0]!.id !== (page1.messages[0] as { id: string }).id, 'pages advance');
  });

  await check('thread list filters and gates', async () => {
    const r = await api('GET', `${base}/threads?status=active&tenancy_id=${fx.tenancyId}`, {
      token: fx.landlordToken,
    });
    const page = assertStatus(r, 200, 'list') as { data: { id: string; participants: unknown[] }[] };
    assert(page.data.some((t) => t.id === threadId), 'thread listed');
    assert(page.data[0]!.participants.length > 0, 'participants embedded');
    assertStatus(await api('GET', `${base}/threads`, { token: fx.viewerToken }), 403, 'viewer list');
  });

  // =========================================================================
  // Policy revoke
  // =========================================================================
  await check('revoke kills the grant and parks its queued sends', async () => {
    const p = await L({
      policy_kind: 'rent_reminder', channel: 'sms', params: { days_before: 5, monthly_cap: 1 },
    }, '/policies');
    const p2 = (assertStatus(p, 201, 'policy2') as { id: string }).id;
    // NOTE: TENANT_ADDR is opted out by now; use a second identity-free address.
    const intent = await A({
      channel: 'sms', to_address: OTHER_ADDR, body: 'reminder under p2',
      approval_ref: `grant:${p2}`,
    }, '/outbox');
    const intentId = (assertStatus(intent, 201, 'intent under p2') as { id: string }).id;

    const rv = await L({}, `/policies/${p2}/revoke`);
    const revoked = assertStatus(rv, 200, 'revoke') as { status: string; revoked_by: string };
    assert(revoked.status === 'revoked' && revoked.revoked_by === fx.landlordId, 'revocation provenance');

    const { data: parked } = await admin.from('comm_outbox')
      .select('status, error_code').eq('id', intentId).single();
    assert(parked?.status === 'undeliverable' && parked?.error_code === 'policy_revoked',
      `parked: ${JSON.stringify(parked)}`);

    const after = await A({
      channel: 'sms', to_address: OTHER_ADDR, body: 'x', approval_ref: `grant:${p2}`,
    }, '/outbox');
    assertStatus(after, 403, 'send under revoked grant');

    // Replayed revoke returns the row unchanged.
    const rv2 = await L({}, `/policies/${p2}/revoke`);
    assertStatus(rv2, 200, 'revoke replay');
  });

  // =========================================================================
  // Reconcile scan
  // =========================================================================
  await check('reconcile surfaces stale sending rows', async () => {
    const r = await A({
      channel: 'sms', to_address: OTHER_ADDR, body: 'stale',
      approval_ref: 'proposal:88', approved_by: fx.landlordId,
    }, '/outbox');
    const id = (assertStatus(r, 201, 'intent') as { id: string }).id;
    await A({ status: 'sending', provider_ts: new Date().toISOString() }, `/outbox/${id}/delivery`);
    // Backdate the claim (service role; updated_at is not an immutable field).
    const { error } = await admin.from('comm_outbox')
      .update({ updated_at: new Date(Date.now() - 7_200_000).toISOString() }).eq('id', id);
    if (error) throw new Error(`backdate: ${error.message}`);
    const scan = await api('GET', `${base}/reconcile?ttl_seconds=3600`, { token: fx.agentToken });
    const page = assertStatus(scan, 200, 'scan') as { data: { id: string }[] };
    assert(page.data.some((x) => x.id === id), 'stale row surfaced');
    assertStatus(await api('GET', `${base}/reconcile`, { token: fx.landlordToken }), 403, 'landlord scan');
  });

  // =========================================================================
  // Events feed + cross-account reads
  // =========================================================================
  await check('comms entity types surface on the events feed', async () => {
    const r = await api('GET', `/v1/accounts/${fx.accountId}/events?entity_type=comm_outbox&limit=5`, {
      token: fx.landlordToken,
    });
    const page = assertStatus(r, 200, 'events') as { data: { entity_type: string }[] };
    assert(page.data.length > 0, 'comm_outbox events present');
    const th = await api('GET', `/v1/accounts/${fx.accountId}/events?entity_type=comm_threads&limit=5`, {
      token: fx.landlordToken,
    });
    assert((assertStatus(th, 200, 'thread events') as { data: unknown[] }).data.length > 0, 'comm_threads events');
  });

  const other = await setupOther();

  await check('cross-account reads 404 through the account scope', async () => {
    const r = await api('GET', `/v1/accounts/${other.accountId}/comms/outbox/${msgOutboxId}`, {
      token: other.token,
    });
    assertStatus(r, 404, 'foreign outbox row');
    const t = await api('GET', `/v1/accounts/${other.accountId}/comms/threads/${threadId}`, {
      token: other.token,
    });
    assertStatus(t, 404, 'foreign thread');
  });

  // =========================================================================
  // Post-review hardening guards (adversarial DB-layer review of the ledger).
  // These exercise the threat model the API cannot see: a member reaching past
  // the app straight to PostgREST, and cross-account confusion in the RPCs.
  // =========================================================================

  await check('F1: agent cannot forge a landlord-authored outbox row via direct PostgREST', async () => {
    const forge = await pgrest('POST', 'comm_outbox', fx.agentToken, {
      account_id: fx.accountId, channel: 'sms', to_address: `+1717${SUFFIX}`,
      body: 'forged as landlord', approval_ref: `grant:${policyId}`, author_type: 'landlord',
    });
    assert(forge.status >= 400, `agent forging author_type=landlord must be rejected (got ${forge.status})`);
    // Control: the legitimate agent capability (author_type=agent) still works.
    const ok = await pgrest('POST', 'comm_outbox', fx.agentToken, {
      account_id: fx.accountId, channel: 'sms', to_address: `+1718${SUFFIX}`,
      body: 'honest agent row', approval_ref: `grant:${policyId}`, author_type: 'agent',
    });
    assert(ok.status < 300, `agent author_type=agent must be accepted (got ${ok.status}: ${JSON.stringify(ok.body)})`);
  });

  await check('F5: a member cannot bind another account\'s platform number', async () => {
    // other.platformNumber belongs to account B; account A binding it would
    // occupy B's global routing slot. The composite FK must refuse it.
    const bind = await pgrest('POST', 'thread_channel_bindings', fx.landlordToken, {
      account_id: fx.accountId, thread_id: threadId, participant_id: tenantParticipantId,
      platform_number: other.platformNumber, participant_address: `+1719${SUFFIX}`,
    });
    assert(bind.status >= 400, `binding a foreign platform number must be rejected (got ${bind.status})`);
  });

  await check('F2: capture_inbound will not return another account\'s cached result', async () => {
    // The agent is a transport for BOTH accounts. Capture a message id under B
    // (orphan is fine), then attempt the SAME id under A: the account-pinned
    // dedupe must refuse rather than leak B's ids or poison A's capture.
    const msgId = `IN-shared-${rnd()}`;
    const capB = await api('POST', `/v1/accounts/${other.accountId}/comms/inbound`, {
      token: other.agentToken,
      body: {
        provider: 'test', provider_msg_id: msgId, to_number: other.platformNumber,
        from_address: `+1720${SUFFIX}`, channel: 'sms', received_at: new Date().toISOString(),
      },
    });
    assertStatus(capB, 200, 'capture under B');
    const capA = await api('POST', `/v1/accounts/${fx.accountId}/comms/inbound`, {
      token: fx.agentToken,
      body: {
        provider: 'test', provider_msg_id: msgId, to_number: PLATFORM_NUMBER,
        from_address: TENANT_ADDR, channel: 'sms', received_at: new Date().toISOString(),
      },
    });
    assertStatus(capA, 409, 'same msg id under A refused, not leaked');
  });

  // --- summary ---------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} comms check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: comms ledger checks all green');
}

interface OtherAccount {
  accountId: string;
  token: string;
  agentToken: string;
  platformNumber: string;
}

async function setupOther(): Promise<OtherAccount> {
  const email = `comms-other-${rnd()}@example.test`;
  const password = `pw-${rnd()}-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: 'Other Acct' },
  });
  if (su.status !== 200) throw new Error(`other signup: ${su.status}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };
  const accountId = b.account.id;

  // The same agent identity serves this account too (an agent-role membership).
  const { error: memErr } = await admin.from('account_members').insert({
    account_id: accountId, user_id: agentAuth.id, role: 'agent',
  });
  if (memErr) throw new Error(`other agent membership: ${memErr.message}`);

  // A platform number owned by THIS account (used to prove account A cannot
  // bind it — hardening F5).
  const platformNumber = `+1616${SUFFIX}`;
  const { error: numErr } = await admin.from('platform_numbers').insert({
    account_id: accountId, number: platformNumber, provider: 'test', capabilities: ['sms'],
  });
  if (numErr) throw new Error(`other platform number: ${numErr.message}`);

  return {
    accountId,
    token: b.session.access_token,
    agentToken: await login(agentAuth.email, agentAuth.password),
    platformNumber,
  };
}

await main();
