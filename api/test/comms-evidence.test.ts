// ----------------------------------------------------------------------------
// Comms evidence-hardening integration tests (work items EV-A / EV-B).
//
// Exercised against a real Supabase stack, alongside — and without regressing —
// the sms 1:1 / group / email thread surfaces.
//
//   * audience stamping (EV-A): every communication journal row carries the
//     frozen addressed set of THAT delivery — inbound {to, cc} (sms 1:1, group
//     MMS, email token), outbound {to: [dialed set]} (1:1 and group) — exposed
//     on the Interaction contract (thread detail included) and immutable at
//     the DB (guard trigger).
//   * verbatim-webhook archive (EV-B): server-side sha256, audit-anchored
//     inbound_provenance row (insert event carries the hash), bytes stored in
//     the private comm-evidence bucket; idempotent by provider_msg_id, a
//     conflicting body 409s (first archived claim wins), account-pinned
//     (another account's replay of the same id 409s), transport-only
//     (landlord/viewer 403), member SELECT scoped by RLS, ragged base64 400.
//   * legal holds: manager set/release (audited), agent + viewer 403 at the
//     API and RLS-denied at raw PostgREST, GET defaults for a never-held
//     account.
//   * retention janitor (runEvidenceRetention): hold gate (skipped, then
//     purged after release), purge stamps purged_at + removes the blob while
//     the provenance row survives, fresh rows untouched, shared-blob
//     conservatism (a recent row referencing the same bytes blocks removal).
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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
const SUFFIX = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');

process.env.NODE_ENV = 'test';
process.env.PORT = '8799';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';
// Unique per run so a persistent local stack's email token routing never
// collides across runs (same convention as comms-email-threads).
process.env.EMAIL_REPLY_DOMAIN = `ev-${SUFFIX}.example.test`;

const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const admin = getAdminClient();

async function createAuthUser(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = `commsev-${label}-${crypto.randomUUID()}@internal.test`;
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
const { runEvidenceRetention } = await import('../src/admin/evidence');

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

async function login(email: string, password: string): Promise<string> {
  const r = await api('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return (r.body as { session: { access_token: string } }).session.access_token;
}

// Direct PostgREST call with a member's real JWT — reads under RLS, and the
// raw-write threat model the DB defends against.
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

// --- fixture ------------------------------------------------------------------

const PLATFORM_A = `+1909${SUFFIX}`;
const LL_A = `+1505${SUFFIX}`;
const M1_A = `+1606${SUFFIX}`;
const M2_A = `+1707${SUFFIX}`;
const PLATFORM_B = `+1808${SUFFIX}`;

interface Fixture {
  accountId: string;
  landlordToken: string;
  landlordId: string;
  agentToken: string;
  viewerToken: string;
  tenant1Id: string;
  tenant2Id: string;
}

async function setup(platformNumber: string, tag: string): Promise<Fixture> {
  const email = `commsev-landlord-${tag}-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: 'Comms Evidence Acct' },
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
  const tenant1 = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, { full_name: 'Tenant One' });
  const tenant2 = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, { full_name: 'Tenant Two' });

  for (const [userId, role] of [[agentAuth.id, 'agent'], [viewerAuth.id, 'viewer']] as const) {
    const { error } = await admin.from('account_members').insert({
      account_id: accountId, user_id: userId, role,
    });
    if (error) throw new Error(`membership ${role}: ${error.message}`);
  }

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
    viewerToken: await login(viewerAuth.email, viewerAuth.password),
    tenant1Id: tenant1.id,
    tenant2Id: tenant2.id,
  };
}

// --- shapes -----------------------------------------------------------------

interface Audience { to: string | string[]; cc?: string[] }
interface CaptureShape {
  disposition: string;
  interaction_id: string | null;
  thread_id: string | null;
}
interface ProvenanceShape {
  id: string;
  account_id: string;
  provider: string;
  provider_msg_id: string;
  body_sha256: string;
  signature: string | null;
  signature_timestamp: string | null;
  storage_path: string;
  received_at: string;
  purged_at: string | null;
  created_at: string;
}
interface HoldShape {
  account_id: string;
  active: boolean;
  reason: string | null;
  set_by: string | null;
  set_at: string | null;
  released_at: string | null;
}
interface BindingShape { participant_address: string; reply_address: string | null }
interface ThreadShape { id: string; bindings: BindingShape[] }

async function journalAudience(fx: Fixture, interactionId: string): Promise<Audience | null> {
  const r = await pgrest(
    'GET',
    `interactions?id=eq.${interactionId}&select=id,audience`,
    fx.landlordToken,
  );
  if (r.status !== 200) throw new Error(`journal read: ${r.status} ${JSON.stringify(r.body)}`);
  const rows = r.body as { id: string; audience: Audience | null }[];
  if (rows.length !== 1) throw new Error(`journal read: expected 1 row, got ${rows.length}`);
  return rows[0]!.audience;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Comms evidence-hardening integration tests (EV-A / EV-B)');
  const fx = await setup(PLATFORM_A, 'a');
  const fxB = await setup(PLATFORM_B, 'b');
  const base = `/v1/accounts/${fx.accountId}/comms`;
  const baseB = `/v1/accounts/${fxB.accountId}/comms`;
  const L = (method: string, path: string, body?: unknown) =>
    api(method, `${base}${path}`, { token: fx.landlordToken, body });
  const A = (method: string, path: string, body?: unknown) =>
    api(method, `${base}${path}`, { token: fx.agentToken, body });

  // ==========================================================================
  // EV-A: audience stamping
  // ==========================================================================

  let groupThreadId = '';
  const groupMembers = [LL_A, M1_A, M2_A].sort();

  await check('fixture: bridged sms + group threads create', async () => {
    const b = await L('POST', '/threads', {
      kind: 'bridged_tenant',
      channel: 'sms',
      participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: M1_A }],
    });
    assertStatus(b, 201, 'bridged create');
    const g = await L('POST', '/threads', {
      kind: 'bridged_tenant',
      channel: 'sms',
      mode: 'group',
      participants: [
        { party_type: 'landlord_user', party_id: fx.landlordId, address: LL_A },
        { party_type: 'tenant', party_id: fx.tenant1Id, address: M1_A },
        { party_type: 'tenant', party_id: fx.tenant2Id, address: M2_A },
      ],
    });
    groupThreadId = (assertStatus(g, 201, 'group create') as ThreadShape).id;
  });

  await check('inbound 1:1 sms journals audience {to: platform, cc: []}', async () => {
    const r = await A('POST', '/inbound', {
      provider: 'test',
      provider_msg_id: `ev-${SUFFIX}-in-1to1`,
      to_number: PLATFORM_A,
      from_address: M1_A,
      channel: 'sms',
      body: 'when is rent due?',
      received_at: new Date().toISOString(),
    });
    const cap = assertStatus(r, 200, 'capture') as CaptureShape;
    assert(cap.disposition === 'matched', `disposition=${cap.disposition}`);
    const aud = await journalAudience(fx, cap.interaction_id!);
    assert(aud !== null, 'audience is null');
    assert(aud!.to === PLATFORM_A, `to=${JSON.stringify(aud!.to)}`);
    assert(JSON.stringify(aud!.cc) === '[]', `cc=${JSON.stringify(aud!.cc)}`);
  });

  let groupInboundInteraction = '';
  await check('inbound group MMS journals audience {to: platform, cc: [others]}', async () => {
    const r = await A('POST', '/inbound', {
      provider: 'test',
      provider_msg_id: `ev-${SUFFIX}-in-group`,
      to_number: PLATFORM_A,
      from_address: M1_A,
      cc: [LL_A, M2_A],
      channel: 'sms',
      body: 'pipe fixed',
      received_at: new Date().toISOString(),
    });
    const cap = assertStatus(r, 200, 'capture') as CaptureShape;
    assert(cap.disposition === 'matched', `disposition=${cap.disposition}`);
    assert(cap.thread_id === groupThreadId, 'routed to the group thread');
    groupInboundInteraction = cap.interaction_id!;
    const aud = await journalAudience(fx, groupInboundInteraction);
    assert(aud!.to === PLATFORM_A, `to=${JSON.stringify(aud!.to)}`);
    assert(JSON.stringify(aud!.cc) === JSON.stringify([LL_A, M2_A]), `cc=${JSON.stringify(aud!.cc)}`);
    // {from} ∪ cc == the frozen member set — the audience restates it per-row.
    const restated = [M1_A, ...(aud!.cc ?? [])].sort();
    assert(JSON.stringify(restated) === JSON.stringify(groupMembers), `set=${JSON.stringify(restated)}`);
  });

  await check('thread detail exposes audience on messages (contract surface)', async () => {
    const r = await L('GET', `/threads/${groupThreadId}?limit=10`);
    const t = assertStatus(r, 200, 'thread detail') as { messages: { id: string; audience: Audience | null }[] };
    const msg = t.messages.find((m) => m.id === groupInboundInteraction);
    assert(msg, 'group inbound row present in thread detail');
    assert(msg!.audience !== null && msg!.audience!.to === PLATFORM_A, `audience=${JSON.stringify(msg!.audience)}`);
  });

  await check('outbound 1:1 sms journals audience {to: [address]}', async () => {
    const cr = await L('POST', '/outbox', {
      channel: 'sms',
      to_address: M1_A,
      body: 'rent is due friday',
      approval_ref: `self:${fx.landlordId}`,
    });
    const row = assertStatus(cr, 201, 'intent') as { id: string };
    const done = await A('POST', `/outbox/${row.id}/complete`, {
      provider: 'test', provider_sid: `ev-${SUFFIX}-sid-1to1`,
    });
    const c = assertStatus(done, 200, 'complete') as { interaction_id: string };
    const aud = await journalAudience(fx, c.interaction_id);
    assert(JSON.stringify(aud!.to) === JSON.stringify([M1_A]), `to=${JSON.stringify(aud!.to)}`);
  });

  await check('outbound group send journals audience {to: [member set]}', async () => {
    const cr = await L('POST', `/threads/${groupThreadId}/messages`, { body: 'thanks all' });
    const rows = assertStatus(cr, 201, 'group intent') as { data: { id: string }[] };
    const done = await A('POST', `/outbox/${rows.data[0]!.id}/complete`, {
      provider: 'test', provider_sid: `ev-${SUFFIX}-sid-group`,
    });
    const c = assertStatus(done, 200, 'complete') as { interaction_id: string };
    const aud = await journalAudience(fx, c.interaction_id);
    assert(JSON.stringify(aud!.to) === JSON.stringify(groupMembers), `to=${JSON.stringify(aud!.to)}`);
  });

  await check('inbound email journals audience {to: reply token, cc: []}', async () => {
    const llEmail = `ll-${SUFFIX}@example.test`;
    const tEmail = `tenant1-${SUFFIX}@example.test`;
    const cr = await L('POST', '/threads', {
      kind: 'bridged_tenant',
      channel: 'email',
      subject: 'Leaky pipe',
      participants: [
        { party_type: 'landlord_user', party_id: fx.landlordId, address: llEmail },
        { party_type: 'tenant', party_id: fx.tenant1Id, address: tEmail },
      ],
    });
    const t = assertStatus(cr, 201, 'email thread create') as ThreadShape;
    const token = t.bindings.find((b) => b.participant_address === tEmail)?.reply_address;
    assert(token, 'tenant reply token minted');
    const r = await A('POST', '/inbound', {
      provider: 'test-email',
      provider_msg_id: `ev-${SUFFIX}-in-email`,
      to_number: token!,
      from_address: tEmail,
      channel: 'email',
      body: 'photo attached of the fixed pipe',
      received_at: new Date().toISOString(),
    });
    const cap = assertStatus(r, 200, 'capture') as CaptureShape;
    assert(cap.disposition === 'matched', `disposition=${cap.disposition}`);
    const aud = await journalAudience(fx, cap.interaction_id!);
    assert(aud!.to === token, `to=${JSON.stringify(aud!.to)}`);
    assert(JSON.stringify(aud!.cc) === '[]', `cc=${JSON.stringify(aud!.cc)}`);
  });

  await check('audience is immutable at the DB (guard trigger)', async () => {
    const { error } = await admin
      .from('interactions')
      .update({ audience: { to: 'forged' } })
      .eq('id', groupInboundInteraction);
    assert(error, 'expected the update to be rejected');
    assert(
      /immutable/i.test(error!.message) || error!.code === '23514',
      `unexpected rejection: code=${error!.code} msg=${error!.message}`,
    );
  });

  // ==========================================================================
  // EV-B: verbatim-webhook archive
  // ==========================================================================

  const rawBody = JSON.stringify({
    data: { event_type: 'message.received', id: `ev-${SUFFIX}-wh-1`, payload: { text: 'pipe fixed' } },
  });
  const rawSha = sha256Hex(rawBody);
  const msgId1 = `ev-${SUFFIX}-arch-1`;
  let archived: ProvenanceShape | null = null;

  await check('evidence archive: server-side sha256 + audit-anchored row + blob', async () => {
    const r = await A('POST', '/evidence', {
      provider: 'telnyx',
      provider_msg_id: msgId1,
      raw_body_b64: Buffer.from(rawBody, 'utf8').toString('base64'),
      signature: 'sig-ed25519-base64',
      signature_timestamp: '1783000000',
      received_at: new Date().toISOString(),
    });
    archived = assertStatus(r, 200, 'archive') as ProvenanceShape;
    assert(archived.body_sha256 === rawSha, `sha=${archived.body_sha256} expected=${rawSha}`);
    assert(
      archived.storage_path === `${fx.accountId}/${rawSha}.bin`,
      `path=${archived.storage_path}`,
    );
    assert(archived.purged_at === null, 'purged_at starts null');

    const dl = await admin.storage.from('comm-evidence').download(archived.storage_path);
    assert(!dl.error && dl.data, `download failed: ${dl.error?.message}`);
    const text = await dl.data!.text();
    assert(text === rawBody, 'blob bytes are the verbatim body');

    const ev = await admin
      .from('events')
      .select('event_type, payload')
      .eq('entity_type', 'inbound_provenance')
      .eq('entity_id', archived.id);
    assert(!ev.error, `events read: ${ev.error?.message}`);
    const inserted = (ev.data ?? []).find((e) => (e as { event_type: string }).event_type === 'inserted');
    assert(inserted, 'inserted audit event exists');
    const after = (inserted as { payload: { after: { body_sha256: string } } }).payload.after;
    assert(after.body_sha256 === rawSha, 'the body hash is inside the audit chain');
  });

  await check('evidence archive: idempotent replay returns the original row', async () => {
    const r = await A('POST', '/evidence', {
      provider: 'telnyx',
      provider_msg_id: msgId1,
      raw_body_b64: Buffer.from(rawBody, 'utf8').toString('base64'),
      signature: 'sig-ed25519-base64',
      signature_timestamp: '1783000000',
      received_at: new Date().toISOString(),
    });
    const row = assertStatus(r, 200, 'replay') as ProvenanceShape;
    assert(row.id === archived!.id, 'same row id');
  });

  await check('evidence archive: a DIFFERENT body for the same msg id is refused (409)', async () => {
    const r = await A('POST', '/evidence', {
      provider: 'telnyx',
      provider_msg_id: msgId1,
      raw_body_b64: Buffer.from(rawBody + 'tampered', 'utf8').toString('base64'),
      received_at: new Date().toISOString(),
    });
    assertStatus(r, 409, 'conflicting body');
  });

  await check('evidence archive: account-pinned (another account replaying the id 409s)', async () => {
    const r = await api('POST', `${baseB}/evidence`, {
      token: fxB.agentToken,
      body: {
        provider: 'telnyx',
        provider_msg_id: msgId1,
        raw_body_b64: Buffer.from(rawBody, 'utf8').toString('base64'),
        received_at: new Date().toISOString(),
      },
    });
    assertStatus(r, 409, 'foreign-account replay');
  });

  await check('evidence archive: transport-only (landlord and viewer 403)', async () => {
    const body = {
      provider: 'telnyx',
      provider_msg_id: `ev-${SUFFIX}-arch-denied`,
      raw_body_b64: Buffer.from('x', 'utf8').toString('base64'),
      received_at: new Date().toISOString(),
    };
    assertStatus(await L('POST', '/evidence', body), 403, 'landlord');
    assertStatus(
      await api('POST', `${base}/evidence`, { token: fx.viewerToken, body }),
      403,
      'viewer',
    );
  });

  await check('evidence archive: ragged base64 is a 400', async () => {
    const r = await A('POST', '/evidence', {
      provider: 'telnyx',
      provider_msg_id: `ev-${SUFFIX}-arch-b64`,
      raw_body_b64: 'abcde', // length % 4 !== 0
      received_at: new Date().toISOString(),
    });
    assertStatus(r, 400, 'ragged base64');
  });

  await check('provenance rows: member SELECT is account-scoped (RLS)', async () => {
    const mine = await pgrest(
      'GET',
      `inbound_provenance?provider_msg_id=eq.${msgId1}&select=id`,
      fx.landlordToken,
    );
    assert(mine.status === 200 && (mine.body as unknown[]).length === 1, `own read: ${JSON.stringify(mine.body)}`);
    const foreign = await pgrest(
      'GET',
      `inbound_provenance?provider_msg_id=eq.${msgId1}&select=id`,
      fxB.landlordToken,
    );
    assert(foreign.status === 200 && (foreign.body as unknown[]).length === 0, `foreign read: ${JSON.stringify(foreign.body)}`);
  });

  // ==========================================================================
  // Legal holds
  // ==========================================================================

  await check('legal hold: GET defaults to inactive for a never-held account', async () => {
    const r = await L('GET', '/legal-hold');
    const h = assertStatus(r, 200, 'get') as HoldShape;
    assert(h.active === false && h.set_at === null && h.set_by === null, JSON.stringify(h));
  });

  await check('legal hold: agent and viewer PUT are 403; raw agent write is RLS-denied', async () => {
    const body = { active: true, reason: 'forged' };
    assertStatus(await api('PUT', `${base}/legal-hold`, { token: fx.agentToken, body }), 403, 'agent');
    assertStatus(await api('PUT', `${base}/legal-hold`, { token: fx.viewerToken, body }), 403, 'viewer');
    const raw = await pgrest('POST', 'account_legal_holds', fx.agentToken, {
      account_id: fx.accountId, active: true, reason: 'forged',
    });
    assert(raw.status >= 400, `raw insert should be denied, got ${raw.status}`);
  });

  await check('legal hold: manager set is recorded + audited', async () => {
    const r = await L('PUT', '/legal-hold', { active: true, reason: 'deposit dispute demand letter' });
    const h = assertStatus(r, 200, 'set') as HoldShape;
    assert(h.active === true && h.set_by === fx.landlordId && h.set_at !== null, JSON.stringify(h));
    const again = await L('GET', '/legal-hold');
    assert((again.body as HoldShape).active === true, 'GET reflects the hold');
    const ev = await admin
      .from('events')
      .select('event_type')
      .eq('entity_type', 'account_legal_holds')
      .eq('account_id', fx.accountId);
    assert(!ev.error && (ev.data ?? []).length >= 1, `audit events: ${JSON.stringify(ev.data)}`);
  });

  // ==========================================================================
  // Retention janitor (runs while fx holds an ACTIVE hold — the gate test)
  // ==========================================================================

  const oldReceivedAt = '2018-01-01T00:00:00.000Z'; // far past any horizon
  const oldBody = JSON.stringify({ data: { id: `ev-${SUFFIX}-old` } });
  const oldMsgId = `ev-${SUFFIX}-arch-old`;
  let oldRow: ProvenanceShape | null = null;

  await check('retention: an active hold blocks the purge', async () => {
    const r = await A('POST', '/evidence', {
      provider: 'telnyx',
      provider_msg_id: oldMsgId,
      raw_body_b64: Buffer.from(oldBody, 'utf8').toString('base64'),
      received_at: oldReceivedAt,
    });
    oldRow = assertStatus(r, 200, 'archive old') as ProvenanceShape;
    const result = await runEvidenceRetention();
    assert(result.skipped_held >= 1, `skipped_held=${result.skipped_held}`);
    const after = await admin
      .from('inbound_provenance')
      .select('purged_at')
      .eq('id', oldRow.id)
      .single();
    assert(after.data?.purged_at === null, `purged_at=${after.data?.purged_at}`);
  });

  await check('retention: release the hold → blob purged, row survives, audited', async () => {
    const rel = await L('PUT', '/legal-hold', { active: false });
    const h = assertStatus(rel, 200, 'release') as HoldShape;
    assert(h.active === false && h.released_at !== null, JSON.stringify(h));

    const result = await runEvidenceRetention();
    assert(result.purged >= 1, `purged=${result.purged}`);

    const after = await admin
      .from('inbound_provenance')
      .select('purged_at, provider_msg_id, body_sha256')
      .eq('id', oldRow!.id)
      .single();
    assert(after.data?.purged_at !== null, 'purged_at stamped');
    assert(after.data?.provider_msg_id === oldMsgId, 'anchor row survives the purge');

    const dl = await admin.storage.from('comm-evidence').download(oldRow!.storage_path);
    assert(dl.error, 'blob is gone');

    const ev = await admin
      .from('events')
      .select('event_type, payload')
      .eq('entity_type', 'inbound_provenance')
      .eq('entity_id', oldRow!.id);
    const updated = (ev.data ?? []).find((e) => (e as { event_type: string }).event_type === 'updated');
    assert(updated, 'the destruction is an audited event');
  });

  await check('retention: fresh rows are untouched', async () => {
    const after = await admin
      .from('inbound_provenance')
      .select('purged_at')
      .eq('id', archived!.id)
      .single();
    assert(after.data?.purged_at === null, `fresh row purged_at=${after.data?.purged_at}`);
  });

  await check('retention: a recent row sharing the same bytes blocks blob removal', async () => {
    const sharedBody = JSON.stringify({ data: { id: `ev-${SUFFIX}-shared` } });
    const b64 = Buffer.from(sharedBody, 'utf8').toString('base64');
    const oldShared = await A('POST', '/evidence', {
      provider: 'telnyx',
      provider_msg_id: `ev-${SUFFIX}-shared-old`,
      raw_body_b64: b64,
      received_at: oldReceivedAt,
    });
    const oldSharedRow = assertStatus(oldShared, 200, 'archive shared-old') as ProvenanceShape;
    const recentShared = await A('POST', '/evidence', {
      provider: 'telnyx',
      provider_msg_id: `ev-${SUFFIX}-shared-new`,
      raw_body_b64: b64,
      received_at: new Date().toISOString(),
    });
    assertStatus(recentShared, 200, 'archive shared-new');

    const result = await runEvidenceRetention();
    assert(result.skipped_shared_blob >= 1, `skipped_shared_blob=${result.skipped_shared_blob}`);
    const dl = await admin.storage.from('comm-evidence').download(oldSharedRow.storage_path);
    assert(!dl.error, 'shared blob still present');
  });

  // --- summary ----------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} comms evidence check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: comms evidence-hardening checks all green');
}

await main();
