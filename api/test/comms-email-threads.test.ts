// ----------------------------------------------------------------------------
// Comms email inbound + email threads integration tests (work item E2-A, core
// side). Exercised against a real Supabase stack, alongside — and without
// regressing — the sms/group thread surface.
//
// Email needs no shared-number disambiguation: every (thread, participant) gets
// a UNIQUE tokenized reply address (`t-<token>@<EMAIL_REPLY_DOMAIN>`, minted by
// the API at thread creation; the receiving domain is global env config). Both
// the tenant AND the landlord reply natively from their own inboxes; inbound
// routing is by the token — never by content, never by the sender address. The
// sender address is a VERIFICATION input, not a routing key.
//   * email thread create: channel='email' + subject seed frozen, TWO bindings
//     (landlord included), each channel='email', platform_number null, a minted
//     reply token (distinct per binding), participant addresses lowercased.
//   * create-shape guards: subject on an sms thread (400), an email thread
//     without a landlord_user (400) or with an agent participant (400), a
//     duplicate participant address (400), channel='voice' (501), and
//     mode='group'+channel='email' (501, group email is a future slice).
//   * the landlord's email defaults from the signup JWT when its participant
//     carries no explicit address (tolerated 422 if the claim is unwired).
//   * token-routed inbound capture: matched -> thread routed + journaled;
//     case-normalized (uppercase token / spaced+cased sender still match);
//     unknown token -> orphan; account-pinned (A's token under B -> orphan).
//   * sender_mismatch honesty: the token resolved but the sender is not the
//     bound participant -> journaled into the thread as party_type='unspecified'
//     + the actual sender as the label, author_type keeps the slot's capacity;
//     idempotent on replay.
//   * email relay: a relay leg links to the ORIGINAL inbound interaction on
//     complete (no second journal row).
//   * channel-aware landlord thread message (one intent, channel='email',
//     to_address the tenant email, no subject on the outbox row).
//   * sms/email coexistence: a bridged sms thread for the same tenant routes a
//     no-cc sms inbound to the sms leg while the email token still routes to the
//     email thread.
//   * email opt-out enforcement: a registered opt-out refuses a new send (422)
//     and marks an inbound to the opted-out address 'opted_out' (still
//     journaled — evidence).
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
process.env.PORT = '8798';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

// E2-A: the receiving domain the API mints per-(thread,participant) reply
// tokens into. It must be set at BOOT, before the env/app modules snapshot it,
// and be unique per run so a persistent local stack's reply-address routing
// index never collides across runs. SUFFIX (defined here) also fingerprints
// every fixture address below.
const SUFFIX = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');
process.env.EMAIL_REPLY_DOMAIN = `reply-${SUFFIX}.test`;
// E2-branding: the platform parent domain that per-account branded reply
// subdomains hang under. Set at BOOT alongside EMAIL_REPLY_DOMAIN so an account
// WITH an email_subdomain mints under `<sub>.<parent>` while an account without
// one still falls back to EMAIL_REPLY_DOMAIN. Fingerprinted per run.
process.env.EMAIL_PLATFORM_PARENT_DOMAIN = `brand-${SUFFIX}.test`;

const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const admin = getAdminClient();

async function createAuthUser(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = `commset-${label}-${crypto.randomUUID()}@internal.test`;
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
function iso(): string { return new Date().toISOString(); }

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

// Every address is fingerprinted with SUFFIX: email opt-outs are a GLOBAL
// register and platform numbers are globally unique, so fixed values would make
// the suite single-shot against a persistent local stack.
const LL_EMAIL = `ll-${SUFFIX}@e2.test`;        // landlord (a bound participant)
const T1_EMAIL = `t1-${SUFFIX}@e2.test`;        // tenant1 (thread-1 counterparty)
const T2_EMAIL = `t2-${SUFFIX}@e2.test`;        // tenant2 (opt-out thread)
const T3_EMAIL = `t3-${SUFFIX}@e2.test`;        // tenant3 (JWT-default thread)
const STRANGER = `stranger-${SUFFIX}@evil.test`; // sender_mismatch probe (lowercase)
const T1_PHONE = `+1917${SUFFIX}`;              // tenant1's phone (sms coexistence)
const VOICE_PHONE = `+1918${SUFFIX}`;           // channel=voice reject probe
const SMS_SUBJ_PHONE = `+1930${SUFFIX}`;        // subject-on-sms reject probe
const PLATFORM_A = `+1912${SUFFIX}`;
const PLATFORM_B = `+1913${SUFFIX}`;
const PLATFORM_C = `+1914${SUFFIX}`;        // branded-subdomain account

const REPLY_RE = new RegExp(`^t-[0-9a-f]{32}@reply-${SUFFIX}\\.test$`);

interface Fixture {
  accountId: string;
  landlordToken: string;
  landlordId: string;
  landlordEmail: string;
  agentToken: string;
  tenant1Id: string;
  tenant2Id: string;
  tenancyId: string;
}

async function setup(platformNumber: string, tag: string): Promise<Fixture> {
  const email = `commset-landlord-${tag}-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: 'Comms Email Threads Acct' },
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
    property_id: property.id, kind: 'unit', name: 'Unit 4',
  });
  const tenancy = await post<{ id: string }>(`/v1/accounts/${accountId}/tenancies`, {
    area_id: unit.id, start_date: '2026-01-01', status: 'active',
  });
  const tenant1 = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, { full_name: 'Tenant One' });
  const tenant2 = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, { full_name: 'Tenant Two' });

  // The agent transport (member of the account; of BOTH accounts, for the
  // cross-account pinning check).
  {
    const { error } = await admin.from('account_members').insert({
      account_id: accountId, user_id: agentAuth.id, role: 'agent',
    });
    if (error) throw new Error(`membership agent: ${error.message}`);
  }
  // Ops-tier provisioning (service role): the account's platform number. Email
  // threads ride minted reply tokens (no platform number), but the number is
  // declared sms+email-capable so either resolution path is satisfied.
  {
    const { error } = await admin.from('platform_numbers').insert({
      account_id: accountId, number: platformNumber, provider: 'test', capabilities: ['sms', 'email'],
    });
    if (error) throw new Error(`platform number: ${error.message}`);
  }

  return {
    accountId,
    landlordToken: token,
    landlordId: b.user.id,
    landlordEmail: email,
    agentToken: await login(agentAuth.email, agentAuth.password),
    tenant1Id: tenant1.id,
    tenant2Id: tenant2.id,
    tenancyId: tenancy.id,
  };
}

// --- shapes -----------------------------------------------------------------

interface ParticipantShape { id: string; party_type: string; party_id: string | null }
interface BindingShape {
  id: string;
  participant_id: string;
  channel: string;
  platform_number: string | null;
  participant_address: string;
  reply_address: string | null;
  active: boolean;
}
interface MessageShape { id: string; direction: string; thread_id: string | null }
interface ThreadDetailShape {
  id: string;
  channel: string;
  mode: string;
  subject: string | null;
  status: string;
  participants: ParticipantShape[];
  bindings: BindingShape[];
  messages: MessageShape[];
  sender_display_name: string | null;
}
interface CaptureShape {
  disposition: string;
  interaction_id: string | null;
  thread_id: string | null;
  participant: ParticipantShape | null;
}
interface OutboxShape {
  id: string;
  status: string;
  channel: string;
  to_address: string | null;
  subject: string | null;
  participant_id: string | null;
  thread_id: string | null;
  interaction_id: string | null;
  error_code: string | null;
  approval_ref: string;
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Comms email inbound + email threads integration tests');
  const fx = await setup(PLATFORM_A, 'a');
  const base = `/v1/accounts/${fx.accountId}/comms`;
  const self = `self:${fx.landlordId}`;

  const createThread = (body: unknown, token = fx.landlordToken) =>
    api('POST', `${base}/threads`, { token, body });
  const capture = (body: unknown, accountId = fx.accountId, token = fx.agentToken) =>
    api('POST', `/v1/accounts/${accountId}/comms/inbound`, { token, body });
  const threadDetail = async (threadId: string): Promise<ThreadDetailShape> => {
    const r = await api('GET', `${base}/threads/${threadId}?limit=100`, { token: fx.landlordToken });
    return assertStatus(r, 200, 'thread detail') as ThreadDetailShape;
  };
  const outboundCount = async (threadId: string): Promise<number> =>
    (await threadDetail(threadId)).messages.filter((m) => m.direction === 'outbound').length;

  const llPart = { party_type: 'landlord_user', party_id: fx.landlordId, address: LL_EMAIL };
  const t1Part = { party_type: 'tenant', party_id: fx.tenant1Id, address: T1_EMAIL };

  // Shared state threaded across checks.
  let thread1Id = '';
  let landlordParticipantId = '';
  let tenant1ParticipantId = '';
  let tenant1Token = '';   // the tenant's minted reply address (thread-1)
  let landlordToken = '';  // the landlord's minted reply address (thread-1)
  let tenantInboundIid = ''; // the matched tenant inbound interaction (relay source)

  // =========================================================================
  // (0) Landlord JWT-email fallback — must run BEFORE any thread stores the
  // landlord's explicit address as a channel identity (resolution order is
  // explicit -> identity -> caller-JWT email; only the last tier is exercised
  // while no identity exists yet).
  // =========================================================================
  await check('landlord_user address omitted, no identity on file → defaults from the signup JWT email', async () => {
    const t0 = await api('POST', `/v1/accounts/${fx.accountId}/tenants`, {
      token: fx.landlordToken, body: { full_name: 'Tenant Zero' },
    });
    const tenant0Id = (assertStatus(t0, 201, 'create tenant0') as { id: string }).id;
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'email', subject: 'JWT default thread',
      participants: [
        { party_type: 'landlord_user', party_id: fx.landlordId }, // no address
        { party_type: 'tenant', party_id: tenant0Id, address: `t0-${SUFFIX}@e2.test` },
      ],
    });
    const t = assertStatus(r, 201, 'jwt-default create') as ThreadDetailShape;
    const llp = t.participants.find((p) => p.party_type === 'landlord_user');
    assert(llp !== undefined, 'landlord participant present');
    const llb = t.bindings.find((b) => b.participant_id === llp!.id);
    assert(llb !== undefined, 'landlord binding present');
    assert(
      llb!.participant_address === fx.landlordEmail.toLowerCase(),
      `landlord JWT-default address: ${llb!.participant_address} (expected ${fx.landlordEmail.toLowerCase()})`,
    );
  });

  // =========================================================================
  // (1) Email thread create — tokenized bindings for landlord AND tenant
  // =========================================================================
  await check('email thread create → channel/mode/subject + two tokenized email bindings', async () => {
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'email', subject: 'Unit 4 lease renewal',
      tenancy_id: fx.tenancyId, participants: [llPart, t1Part],
    });
    const t = assertStatus(r, 201, 'email thread create') as ThreadDetailShape;
    thread1Id = t.id;
    assert(t.channel === 'email', `channel: ${t.channel}`);
    assert(t.mode === 'bridged', `mode: ${t.mode}`);
    assert(t.subject === 'Unit 4 lease renewal', `subject: ${t.subject}`);
    assert(t.participants.length === 2, `participants: ${t.participants.length}`);
    assert(t.bindings.length === 2, `bindings (landlord included): ${t.bindings.length}`);

    const llp = t.participants.find((p) => p.party_type === 'landlord_user');
    const t1p = t.participants.find((p) => p.party_type === 'tenant' && p.party_id === fx.tenant1Id);
    assert(llp !== undefined, 'landlord participant present');
    assert(t1p !== undefined, 'tenant participant present');
    landlordParticipantId = llp!.id;
    tenant1ParticipantId = t1p!.id;

    const llb = t.bindings.find((b) => b.participant_id === llp!.id);
    const t1b = t.bindings.find((b) => b.participant_id === t1p!.id);
    assert(llb !== undefined && t1b !== undefined, 'a binding for each participant');
    for (const [label, bnd, addr] of [['landlord', llb!, LL_EMAIL], ['tenant', t1b!, T1_EMAIL]] as const) {
      assert(bnd.channel === 'email', `${label} binding channel: ${bnd.channel}`);
      assert(bnd.platform_number == null, `${label} binding platform_number must be null: ${bnd.platform_number}`);
      assert(bnd.reply_address !== null && REPLY_RE.test(bnd.reply_address), `${label} reply_address: ${bnd.reply_address}`);
      assert(bnd.participant_address === addr.toLowerCase(), `${label} participant_address: ${bnd.participant_address}`);
    }
    landlordToken = llb!.reply_address!;
    tenant1Token = t1b!.reply_address!;
    assert(landlordToken !== tenant1Token, 'per-binding reply tokens are distinct');
  });

  // =========================================================================
  // (2) Create-shape guards
  // =========================================================================
  await check('subject on an sms thread create → 400', async () => {
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'sms', subject: 'nope',
      participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: SMS_SUBJ_PHONE }],
    });
    assertStatus(r, 400, 'sms + subject');
  });

  await check('email thread without a landlord_user participant → 400', async () => {
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'email',
      participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: T1_EMAIL }],
    });
    assertStatus(r, 400, 'email without landlord_user');
  });

  await check('email thread with an agent participant → 400', async () => {
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'email',
      participants: [llPart, t1Part, { party_type: 'agent', party_id: crypto.randomUUID(), address: `agent-${SUFFIX}@e2.test` }],
    });
    assertStatus(r, 400, 'email + agent participant');
  });

  await check('channel=voice thread create → 501', async () => {
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'voice',
      participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: VOICE_PHONE }],
    });
    assertStatus(r, 501, 'voice thread');
  });

  await check('mode=group + channel=email → 501 (group email is a future slice)', async () => {
    const r = await createThread({
      kind: 'bridged_tenant', mode: 'group', channel: 'email',
      participants: [llPart, t1Part],
    });
    assertStatus(r, 501, 'group email');
  });

  await check('duplicate participant addresses on an email thread → 400', async () => {
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'email',
      participants: [llPart, { party_type: 'tenant', party_id: fx.tenant1Id, address: LL_EMAIL }],
    });
    assertStatus(r, 400, 'duplicate email addresses');
  });

  // =========================================================================
  // (3) Landlord email defaults from the signup JWT when address omitted
  // =========================================================================
  await check('landlord_user address omitted → resolves from the stored channel identity (identity outranks the JWT claim)', async () => {
    // Check (1)'s explicit landlord address was remembered as a channel
    // identity, so the resolution chain (explicit -> identity -> JWT email)
    // now stops at the identity tier — the account's address book wins over
    // the caller's login email. The pure-JWT tier is covered by check (0).
    const t3 = await api('POST', `/v1/accounts/${fx.accountId}/tenants`, {
      token: fx.landlordToken, body: { full_name: 'Tenant Three' },
    });
    const tenant3Id = (assertStatus(t3, 201, 'create tenant3') as { id: string }).id;
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'email', subject: 'Second thread', tenancy_id: fx.tenancyId,
      participants: [
        { party_type: 'landlord_user', party_id: fx.landlordId }, // no address — resolve
        { party_type: 'tenant', party_id: tenant3Id, address: T3_EMAIL },
      ],
    });
    const t = assertStatus(r, 201, 'identity-resolved create') as ThreadDetailShape;
    const llp = t.participants.find((p) => p.party_type === 'landlord_user');
    assert(llp !== undefined, 'landlord participant present');
    const llb = t.bindings.find((b) => b.participant_id === llp!.id);
    assert(llb !== undefined, 'landlord binding present');
    assert(
      llb!.participant_address === LL_EMAIL,
      `landlord identity-resolved address: ${llb!.participant_address} (expected ${LL_EMAIL})`,
    );
  });

  // =========================================================================
  // (4) Inbound token capture — matched, routed, journaled
  // =========================================================================
  await check('inbound to the tenant reply token from the tenant → matched, routed, journaled', async () => {
    const r = await capture({
      provider: 'resend', provider_msg_id: `IN-em-${rnd()}`, to_number: tenant1Token,
      from_address: T1_EMAIL, channel: 'email', body: 'reply from tenant', received_at: iso(),
    });
    const res = assertStatus(r, 200, 'email inbound') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === thread1Id, `routed to email thread: ${res.thread_id}`);
    assert(res.participant?.id === tenant1ParticipantId, `sender participant: ${res.participant?.id}`);
    assert(res.interaction_id !== null, 'journaled');
    tenantInboundIid = res.interaction_id!;
    const inbound = (await threadDetail(thread1Id)).messages.find((m) => m.id === res.interaction_id);
    assert(inbound !== undefined && inbound.direction === 'inbound', 'inbound row present in the thread');
  });

  await check('inbound token + sender are case/space normalized → still matched', async () => {
    const r = await capture({
      provider: 'resend', provider_msg_id: `IN-em-${rnd()}`, to_number: tenant1Token.toUpperCase(),
      from_address: '  ' + T1_EMAIL.toUpperCase(), channel: 'email', body: 'cased reply', received_at: iso(),
    });
    const res = assertStatus(r, 200, 'normalized inbound') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === thread1Id, `still the email thread: ${res.thread_id}`);
    assert(res.participant?.id === tenant1ParticipantId, `sender participant: ${res.participant?.id}`);
  });

  // =========================================================================
  // (5) Sender mismatch — journaled honestly, idempotent
  // =========================================================================
  await check('inbound to the tenant token from a stranger → sender_mismatch, journaled as unspecified', async () => {
    const msgId = `IN-mm-${rnd()}`;
    const r = await capture({
      provider: 'resend', provider_msg_id: msgId, to_number: tenant1Token,
      from_address: STRANGER, channel: 'email', body: 'not the tenant', received_at: iso(),
    });
    const res = assertStatus(r, 200, 'sender mismatch') as CaptureShape;
    assert(res.disposition === 'sender_mismatch', `disposition: ${res.disposition}`);
    assert(res.thread_id === thread1Id, `thread_id set: ${res.thread_id}`);
    assert(res.interaction_id !== null, 'interaction_id set (contact happened)');

    // The journal row is attributed honestly: identity unresolved, but the
    // message entered the tenant's channel slot.
    const j = await api('GET', `/v1/accounts/${fx.accountId}/interactions/${res.interaction_id}`, {
      token: fx.landlordToken,
    });
    const row = assertStatus(j, 200, 'mismatch journal row') as {
      party_type: string; party_label: string | null; author_type: string; direction: string;
    };
    assert(row.party_type === 'unspecified', `party_type: ${row.party_type}`);
    assert(row.party_label === STRANGER, `party_label: ${row.party_label}`);
    assert(row.author_type === 'tenant', `author_type (slot capacity): ${row.author_type}`);
    assert(row.direction === 'inbound', `direction: ${row.direction}`);

    // Replay: identical disposition + interaction.
    const replay = await capture({
      provider: 'resend', provider_msg_id: msgId, to_number: tenant1Token,
      from_address: STRANGER, channel: 'email', body: 'not the tenant', received_at: iso(),
    });
    const rr = assertStatus(replay, 200, 'mismatch replay') as CaptureShape;
    assert(rr.disposition === 'sender_mismatch', `replay disposition: ${rr.disposition}`);
    assert(rr.interaction_id === res.interaction_id, 'replay is idempotent (same interaction)');
  });

  // =========================================================================
  // (6) Landlord token capture — the landlord replies natively too
  // =========================================================================
  await check('inbound to the LANDLORD reply token from the landlord → matched, landlord participant', async () => {
    const r = await capture({
      provider: 'resend', provider_msg_id: `IN-ll-${rnd()}`, to_number: landlordToken,
      from_address: LL_EMAIL, channel: 'email', body: 'landlord reply', received_at: iso(),
    });
    const res = assertStatus(r, 200, 'landlord inbound') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === thread1Id, `routed to the email thread: ${res.thread_id}`);
    assert(res.participant?.id === landlordParticipantId, `landlord participant: ${res.participant?.id}`);
  });

  // =========================================================================
  // (7) Orphan on an unknown token
  // =========================================================================
  await check('inbound to an unknown reply token → orphan, nothing journaled', async () => {
    const r = await capture({
      provider: 'resend', provider_msg_id: `IN-orphan-${rnd()}`,
      to_number: `t-${'0'.repeat(32)}@reply-${SUFFIX}.test`,
      from_address: T1_EMAIL, channel: 'email', body: 'to nowhere', received_at: iso(),
    });
    const res = assertStatus(r, 200, 'orphan token') as CaptureShape;
    assert(res.disposition === 'orphan', `disposition: ${res.disposition}`);
    assert(res.interaction_id === null, 'nothing journaled');
    assert(res.thread_id === null, 'no thread');
  });

  // =========================================================================
  // (8) Cross-account: the token is account-pinned
  // =========================================================================
  const fxB = await setup(PLATFORM_B, 'b');
  await check("cross-account: A's tenant token captured under account B → orphan (pinned)", async () => {
    const r = await capture(
      {
        provider: 'resend', provider_msg_id: `IN-xacct-${rnd()}`, to_number: tenant1Token,
        from_address: T1_EMAIL, channel: 'email', body: 'wrong account', received_at: iso(),
      },
      fxB.accountId,
    );
    const res = assertStatus(r, 200, 'cross-account capture') as CaptureShape;
    assert(res.disposition === 'orphan', `disposition: ${res.disposition}`);
    assert(res.interaction_id === null, 'nothing leaked or journaled');
  });

  // =========================================================================
  // (9) Email relay — links to the original inbound, journal-once
  // =========================================================================
  await check('email relay of the tenant inbound → completes onto the ORIGINAL interaction, no new journal row', async () => {
    const outboundBefore = await outboundCount(thread1Id);
    const intent = await api('POST', `${base}/outbox`, {
      token: fx.agentToken,
      body: {
        channel: 'email', thread_id: thread1Id, participant_ref: landlordParticipantId,
        relay_of_interaction_id: tenantInboundIid, body: 'relayed body', approval_ref: `thread:${thread1Id}`,
      },
    });
    const row = assertStatus(intent, 201, 'relay intent') as OutboxShape;
    assert(row.to_address === LL_EMAIL.toLowerCase(), `relay to_address (landlord email): ${row.to_address}`);

    const claim = await api('POST', `${base}/outbox/${row.id}/delivery`, {
      token: fx.agentToken, body: { status: 'sending', provider_ts: iso() },
    });
    assert((assertStatus(claim, 200, 'relay claim') as { status: string }).status === 'sending', 'claimed');
    const done = await api('POST', `${base}/outbox/${row.id}/complete`, {
      token: fx.agentToken, body: { provider: 'resend', provider_sid: `em-${rnd()}` },
    });
    const body = assertStatus(done, 200, 'relay complete') as { interaction_id: string };
    assert(body.interaction_id === tenantInboundIid, `relay links to the original inbound: ${body.interaction_id}`);
    const outboundAfter = await outboundCount(thread1Id);
    assert(outboundAfter === outboundBefore, `outbound journal count grew: ${outboundBefore} -> ${outboundAfter}`);
  });

  // =========================================================================
  // (10) Channel-aware landlord in-app message on the email thread
  // =========================================================================
  await check('landlord thread message on the email thread → one email intent to the tenant, no subject on the row', async () => {
    const r = await api('POST', `${base}/threads/${thread1Id}/messages`, {
      token: fx.landlordToken, body: { body: 'from the app' },
    });
    const out = assertStatus(r, 201, 'thread message') as { data: OutboxShape[] };
    assert(out.data.length === 1, `intents (one counterparty): ${out.data.length}`);
    const row = out.data[0]!;
    assert(row.channel === 'email', `channel: ${row.channel}`);
    assert(row.to_address === T1_EMAIL.toLowerCase(), `to_address: ${row.to_address}`);
    assert(row.subject === null, `subject on the outbox row must be null (transport renders "Re: …"): ${row.subject}`);
    assert(row.approval_ref === self, `approval_ref: ${row.approval_ref}`);
  });

  // =========================================================================
  // (11) sms/email coexistence
  // =========================================================================
  let smsThreadId = '';
  await check('bridged sms thread for the same tenant coexists with their email thread (201)', async () => {
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'sms',
      participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: T1_PHONE }],
    });
    const t = assertStatus(r, 201, 'sms thread create') as ThreadDetailShape;
    smsThreadId = t.id;
    assert(t.channel === 'sms', `channel: ${t.channel}`);
    assert(t.mode === 'bridged', `mode: ${t.mode}`);
    assert(t.id !== thread1Id, 'distinct from the email thread');
  });

  await check('no-cc sms inbound from the tenant phone routes to the sms thread', async () => {
    const r = await capture({
      provider: 'test', provider_msg_id: `IN-sms-${rnd()}`, to_number: PLATFORM_A,
      from_address: T1_PHONE, channel: 'sms', body: 'sms reply', received_at: iso(),
    });
    const res = assertStatus(r, 200, 'sms inbound') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === smsThreadId, `routed to sms thread: ${res.thread_id}`);
    assert(res.thread_id !== thread1Id, 'not the email thread');
  });

  await check('the email reply token still routes to the email thread (channels do not cross)', async () => {
    const r = await capture({
      provider: 'resend', provider_msg_id: `IN-em2-${rnd()}`, to_number: tenant1Token,
      from_address: T1_EMAIL, channel: 'email', body: 'still email', received_at: iso(),
    });
    const res = assertStatus(r, 200, 'email inbound after sms thread') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === thread1Id, `routed to email thread: ${res.thread_id}`);
  });

  // =========================================================================
  // (12) Email opt-out enforcement (a THIRD email thread, tenant2)
  // =========================================================================
  let thread3Id = '';
  let tenant2Token = '';
  await check('setup: a third email thread for tenant2 + register an email opt-out for their address', async () => {
    const r = await createThread({
      kind: 'bridged_tenant', channel: 'email', subject: 'Opt-out thread', tenancy_id: fx.tenancyId,
      participants: [llPart, { party_type: 'tenant', party_id: fx.tenant2Id, address: T2_EMAIL }],
    });
    const t = assertStatus(r, 201, 'thread3 create') as ThreadDetailShape;
    thread3Id = t.id;
    const t2p = t.participants.find((p) => p.party_type === 'tenant' && p.party_id === fx.tenant2Id);
    assert(t2p !== undefined, 'tenant2 participant present');
    const t2b = t.bindings.find((b) => b.participant_id === t2p!.id);
    assert(t2b !== undefined && t2b.reply_address !== null, 'tenant2 reply token present');
    tenant2Token = t2b!.reply_address!;

    const oo = await api('POST', `${base}/opt-outs`, {
      token: fx.agentToken,
      body: { channel: 'email', address: T2_EMAIL, keyword: 'unsubscribe', source_ref: 'm-1' },
    });
    assertStatus(oo, 200, 'register opt-out');
  });

  await check('landlord thread message to the opted-out tenant2 → 422 opted_out', async () => {
    const r = await api('POST', `${base}/threads/${thread3Id}/messages`, {
      token: fx.landlordToken, body: { body: 'should be refused' },
    });
    assertStatus(r, 422, 'message to opted-out address');
    if (errCode(r) !== 'opted_out') throw new Error(`code: ${errCode(r)}`);
  });

  await check('inbound from the opted-out tenant2 to their token → opted_out, still journaled (evidence)', async () => {
    const r = await capture({
      provider: 'resend', provider_msg_id: `IN-oo-${rnd()}`, to_number: tenant2Token,
      from_address: T2_EMAIL, channel: 'email', body: 'reply after opting out', received_at: iso(),
    });
    const res = assertStatus(r, 200, 'opted-out inbound') as CaptureShape;
    assert(res.disposition === 'opted_out', `disposition: ${res.disposition}`);
    assert(res.thread_id === thread3Id, `routed to thread3: ${res.thread_id}`);
    assert(res.interaction_id !== null, 'still journaled (the contact is evidence)');
  });

  // =========================================================================
  // (13) E2-A2: transport token-resolve read + threads channel filter
  // =========================================================================
  await check('resolve-reply-address: agent resolves an active token (case-normalized) → ids', async () => {
    const r = await api(
      'GET',
      `/v1/comms/resolve-reply-address?address=${encodeURIComponent(tenant1Token.toUpperCase())}`,
      { token: fx.agentToken },
    );
    const res = assertStatus(r, 200, 'resolve') as {
      account_id: string; thread_id: string; participant_id: string;
    };
    assert(res.account_id === fx.accountId, `account: ${res.account_id}`);
    assert(res.thread_id === thread1Id, `thread: ${res.thread_id}`);
    assert(res.participant_id === tenant1ParticipantId, `participant: ${res.participant_id}`);
  });

  await check('resolve-reply-address: landlord (member, not agent) → 404 (uniform)', async () => {
    const r = await api(
      'GET',
      `/v1/comms/resolve-reply-address?address=${encodeURIComponent(tenant1Token)}`,
      { token: fx.landlordToken },
    );
    assertStatus(r, 404, 'landlord probe');
  });

  await check("resolve-reply-address: an agent of ANOTHER account only → 404 for A's token", async () => {
    // A fresh transport identity serving ONLY account B: RLS never shows it
    // account A's binding, so the foreign token is indistinguishable from an
    // unknown one.
    const foreignAgent = await createAuthUser('foreign-agent');
    const { error } = await admin.from('account_members').insert({
      account_id: fxB.accountId, user_id: foreignAgent.id, role: 'agent',
    });
    if (error) throw new Error(`foreign agent membership: ${error.message}`);
    const foreignToken = await login(foreignAgent.email, foreignAgent.password);
    const r = await api(
      'GET',
      `/v1/comms/resolve-reply-address?address=${encodeURIComponent(tenant1Token)}`,
      { token: foreignToken },
    );
    assertStatus(r, 404, 'foreign transport');
  });

  await check('resolve-reply-address: unknown token → 404; deactivated binding → 404', async () => {
    const unknown = await api(
      'GET',
      `/v1/comms/resolve-reply-address?address=${encodeURIComponent(`t-${'0'.repeat(32)}@${process.env.EMAIL_REPLY_DOMAIN}`)}`,
      { token: fx.agentToken },
    );
    assertStatus(unknown, 404, 'unknown token');

    // Deactivate tenant2's binding (suite end — nothing downstream uses it)
    // and confirm the resolve read stops answering for it.
    const { error } = await admin
      .from('thread_channel_bindings')
      .update({ active: false })
      .eq('account_id', fx.accountId)
      .eq('reply_address', tenant2Token);
    if (error) throw new Error(`deactivate binding: ${error.message}`);
    const revoked = await api(
      'GET',
      `/v1/comms/resolve-reply-address?address=${encodeURIComponent(tenant2Token)}`,
      { token: fx.agentToken },
    );
    assertStatus(revoked, 404, 'deactivated token');
  });

  await check('threads list ?channel= filters email vs sms threads', async () => {
    const em = await api('GET', `${base}/threads?channel=email&limit=100`, { token: fx.landlordToken });
    const emRows = (assertStatus(em, 200, 'email list') as { data: { id: string; channel: string }[] }).data;
    assert(emRows.every((t) => t.channel === 'email'), 'only email threads');
    assert(emRows.some((t) => t.id === thread1Id), 'email thread present');
    assert(!emRows.some((t) => t.id === smsThreadId), 'sms thread absent');

    const sms = await api('GET', `${base}/threads?channel=sms&limit=100`, { token: fx.landlordToken });
    const smsRows = (assertStatus(sms, 200, 'sms list') as { data: { id: string; channel: string }[] }).data;
    assert(smsRows.every((t) => t.channel === 'sms'), 'only sms threads');
    assert(smsRows.some((t) => t.id === smsThreadId), 'sms thread present');
  });

  // =========================================================================
  // (14) Per-account branding — subdomain-scoped reply tokens + display name.
  // A fresh account sets a branded subdomain via the owner endpoint; its email
  // threads then mint reply tokens under `<sub>.<parent>` and carry the account
  // sender_display_name. thread1 (account fx, no subdomain) is the control: it
  // stays on EMAIL_REPLY_DOMAIN with a null display name.
  // =========================================================================
  await check('account WITHOUT a subdomain mints under EMAIL_REPLY_DOMAIN, display name null', async () => {
    const d = await threadDetail(thread1Id);
    for (const b of d.bindings) {
      if (b.channel === 'email' && b.reply_address) {
        assert(REPLY_RE.test(b.reply_address), `fallback reply_address: ${b.reply_address}`);
        assert(
          b.reply_address.endsWith(`@${process.env.EMAIL_REPLY_DOMAIN}`),
          `ends with the shared reply domain: ${b.reply_address}`,
        );
      }
    }
    assert(d.sender_display_name === null, `no branding set → null display name: ${d.sender_display_name}`);
  });

  await check('account WITH an email_subdomain mints reply tokens under <sub>.<parent> + carries the display name', async () => {
    const fxC = await setup(PLATFORM_C, 'c');
    const sub = `brand${SUFFIX}`;
    const branded = `${sub}.brand-${SUFFIX}.test`;
    const BRAND_RE = new RegExp(`^t-[0-9a-f]{32}@${sub}\\.brand-${SUFFIX}\\.test$`);

    // Set branding via the owner (landlord) endpoint — exercises the PATCH path.
    const patch = await api('PATCH', `/v1/accounts/${fxC.accountId}/email-branding`, {
      token: fxC.landlordToken,
      body: { email_subdomain: sub, sender_display_name: 'Brand Co' },
    });
    const pb = assertStatus(patch, 200, 'set branding') as { email_subdomain: string; reply_domain: string };
    assert(pb.email_subdomain === sub, `patched subdomain: ${pb.email_subdomain}`);
    assert(pb.reply_domain === branded, `patched reply_domain: ${pb.reply_domain}`);

    const r = await api('POST', `/v1/accounts/${fxC.accountId}/comms/threads`, {
      token: fxC.landlordToken,
      body: {
        kind: 'bridged_tenant', channel: 'email', subject: 'Branded lease notice',
        participants: [
          { party_type: 'landlord_user', party_id: fxC.landlordId, address: `llc-${SUFFIX}@e2.test` },
          { party_type: 'tenant', party_id: fxC.tenant1Id, address: `t1c-${SUFFIX}@e2.test` },
        ],
      },
    });
    const t = assertStatus(r, 201, 'branded thread create') as ThreadDetailShape;
    assert(t.bindings.length === 2, `bindings: ${t.bindings.length}`);
    for (const b of t.bindings) {
      assert(
        b.reply_address !== null && BRAND_RE.test(b.reply_address),
        `branded reply_address under ${branded}: ${b.reply_address}`,
      );
    }
    assert(t.sender_display_name === 'Brand Co', `sender_display_name on create: ${t.sender_display_name}`);

    // getThread carries the account display name too (transport reads it there).
    const g = await api('GET', `/v1/accounts/${fxC.accountId}/comms/threads/${t.id}?limit=10`, {
      token: fxC.landlordToken,
    });
    const gd = assertStatus(g, 200, 'branded thread detail') as ThreadDetailShape;
    assert(gd.sender_display_name === 'Brand Co', `sender_display_name on read: ${gd.sender_display_name}`);
  });

  // --- summary ---------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} comms email-threads check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: comms email-threads checks all green');
}

await main();
