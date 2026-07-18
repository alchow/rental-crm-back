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

async function createAuthUser(
  label: string,
): Promise<{ id: string; email: string; password: string }> {
  const email = `commset-${label}-${crypto.randomUUID()}@internal.test`;
  const password = `pw-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
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

interface ApiResp {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

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
  res.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
}

function rnd(): string {
  return Math.random().toString(36).slice(2, 10);
}
function iso(): string {
  return new Date().toISOString();
}

interface Failure {
  name: string;
  detail: string;
}
const failures: Failure[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.info(`  PASS  ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}
function assertStatus(r: ApiResp, expected: number, ctx: string): unknown {
  if (r.status !== expected)
    throw new Error(`${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`);
  return r.body;
}
function errCode(r: ApiResp): string {
  return (r.body as { error?: { code?: string } })?.error?.code ?? '';
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
const LL_EMAIL = `ll-${SUFFIX}@e2.test`; // landlord (a bound participant)
const T1_EMAIL = `t1-${SUFFIX}@e2.test`; // tenant1 (thread-1 counterparty)
const T2_EMAIL = `t2-${SUFFIX}@e2.test`; // tenant2 (opt-out thread)
const T3_EMAIL = `t3-${SUFFIX}@e2.test`; // tenant3 (JWT-default thread)
const STRANGER = `stranger-${SUFFIX}@evil.test`; // sender_mismatch probe (lowercase)
const T1_PHONE = `+1917${SUFFIX}`; // tenant1's phone (sms coexistence)
const VOICE_PHONE = `+1918${SUFFIX}`; // channel=voice reject probe
const SMS_SUBJ_PHONE = `+1930${SUFFIX}`; // subject-on-sms reject probe
const PLATFORM_A = `+1912${SUFFIX}`;
const PLATFORM_B = `+1913${SUFFIX}`;
const PLATFORM_C = `+1914${SUFFIX}`; // branded-subdomain account

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
  const b = su.body as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  const accountId = b.account.id;
  const token = b.session.access_token;

  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token, body });
    if (r.status !== 201) throw new Error(`setup POST ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(`/v1/accounts/${accountId}/properties`, {
    name: 'Comms prop',
  });
  const unit = await post<{ id: string }>(`/v1/accounts/${accountId}/areas`, {
    property_id: property.id,
    kind: 'unit',
    name: 'Unit 4',
  });
  const tenancy = await post<{ id: string }>(`/v1/accounts/${accountId}/tenancies`, {
    area_id: unit.id,
    start_date: '2026-01-01',
    status: 'active',
  });
  const tenant1 = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, {
    full_name: 'Tenant One',
  });
  const tenant2 = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, {
    full_name: 'Tenant Two',
  });

  // The agent transport (member of the account; of BOTH accounts, for the
  // cross-account pinning check).
  {
    const { error } = await admin.from('account_members').insert({
      account_id: accountId,
      user_id: agentAuth.id,
      role: 'agent',
    });
    if (error) throw new Error(`membership agent: ${error.message}`);
  }
  // Ops-tier provisioning (service role): the account's platform number. Email
  // threads ride minted reply tokens (no platform number), but the number is
  // declared sms+email-capable so either resolution path is satisfied.
  {
    const { error } = await admin.from('platform_numbers').insert({
      account_id: accountId,
      number: platformNumber,
      provider: 'test',
      capabilities: ['sms', 'email'],
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

interface ParticipantShape {
  id: string;
  party_type: string;
  party_id: string | null;
  is_cc: boolean;
}
interface BindingShape {
  id: string;
  participant_id: string;
  channel: string;
  platform_number: string | null;
  participant_address: string;
  reply_address: string | null;
  active: boolean;
}
interface MessageShape {
  id: string;
  direction: string;
  thread_id: string | null;
}
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
  cc_addresses: string[] | null;
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
    const r = await api('GET', `${base}/threads/${threadId}?limit=100`, {
      token: fx.landlordToken,
    });
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
  let tenant1Token = ''; // the tenant's minted reply address (thread-1)
  let landlordToken = ''; // the landlord's minted reply address (thread-1)
  let tenantInboundIid = ''; // the matched tenant inbound interaction (relay source)

  // =========================================================================
  // (0) Landlord JWT-email fallback — must run BEFORE any thread stores the
  // landlord's explicit address as a channel identity (resolution order is
  // explicit -> identity -> caller-JWT email; only the last tier is exercised
  // while no identity exists yet).
  // =========================================================================
  await check(
    'landlord_user address omitted, no identity on file → defaults from the signup JWT email',
    async () => {
      const t0 = await api('POST', `/v1/accounts/${fx.accountId}/tenants`, {
        token: fx.landlordToken,
        body: { full_name: 'Tenant Zero' },
      });
      const tenant0Id = (assertStatus(t0, 201, 'create tenant0') as { id: string }).id;
      const r = await createThread({
        kind: 'bridged_tenant',
        channel: 'email',
        subject: 'JWT default thread',
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
    },
  );

  // =========================================================================
  // (1) Email thread create — tokenized bindings for landlord AND tenant
  // =========================================================================
  await check(
    'email thread create → channel/mode/subject + two tokenized email bindings',
    async () => {
      const r = await createThread({
        kind: 'bridged_tenant',
        channel: 'email',
        subject: 'Unit 4 lease renewal',
        tenancy_id: fx.tenancyId,
        participants: [llPart, t1Part],
      });
      const t = assertStatus(r, 201, 'email thread create') as ThreadDetailShape;
      thread1Id = t.id;
      assert(t.channel === 'email', `channel: ${t.channel}`);
      assert(t.mode === 'bridged', `mode: ${t.mode}`);
      assert(t.subject === 'Unit 4 lease renewal', `subject: ${t.subject}`);
      assert(t.participants.length === 2, `participants: ${t.participants.length}`);
      assert(t.bindings.length === 2, `bindings (landlord included): ${t.bindings.length}`);

      const llp = t.participants.find((p) => p.party_type === 'landlord_user');
      const t1p = t.participants.find(
        (p) => p.party_type === 'tenant' && p.party_id === fx.tenant1Id,
      );
      assert(llp !== undefined, 'landlord participant present');
      assert(t1p !== undefined, 'tenant participant present');
      landlordParticipantId = llp!.id;
      tenant1ParticipantId = t1p!.id;

      const llb = t.bindings.find((b) => b.participant_id === llp!.id);
      const t1b = t.bindings.find((b) => b.participant_id === t1p!.id);
      assert(llb !== undefined && t1b !== undefined, 'a binding for each participant');
      for (const [label, bnd, addr] of [
        ['landlord', llb!, LL_EMAIL],
        ['tenant', t1b!, T1_EMAIL],
      ] as const) {
        assert(bnd.channel === 'email', `${label} binding channel: ${bnd.channel}`);
        assert(
          bnd.platform_number == null,
          `${label} binding platform_number must be null: ${bnd.platform_number}`,
        );
        assert(
          bnd.reply_address !== null && REPLY_RE.test(bnd.reply_address),
          `${label} reply_address: ${bnd.reply_address}`,
        );
        assert(
          bnd.participant_address === addr.toLowerCase(),
          `${label} participant_address: ${bnd.participant_address}`,
        );
      }
      landlordToken = llb!.reply_address!;
      tenant1Token = t1b!.reply_address!;
      assert(landlordToken !== tenant1Token, 'per-binding reply tokens are distinct');
    },
  );

  // =========================================================================
  // (2) Create-shape guards
  // =========================================================================
  await check('subject on an sms thread create → 400', async () => {
    const r = await createThread({
      kind: 'bridged_tenant',
      channel: 'sms',
      subject: 'nope',
      participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: SMS_SUBJ_PHONE }],
    });
    assertStatus(r, 400, 'sms + subject');
  });

  await check('email thread without a landlord_user participant → 400', async () => {
    const r = await createThread({
      kind: 'bridged_tenant',
      channel: 'email',
      participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: T1_EMAIL }],
    });
    assertStatus(r, 400, 'email without landlord_user');
  });

  await check('email thread with an agent participant → 400', async () => {
    const r = await createThread({
      kind: 'bridged_tenant',
      channel: 'email',
      participants: [
        llPart,
        t1Part,
        { party_type: 'agent', party_id: crypto.randomUUID(), address: `agent-${SUFFIX}@e2.test` },
      ],
    });
    assertStatus(r, 400, 'email + agent participant');
  });

  await check('channel=voice thread create → 501', async () => {
    const r = await createThread({
      kind: 'bridged_tenant',
      channel: 'voice',
      participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: VOICE_PHONE }],
    });
    assertStatus(r, 501, 'voice thread');
  });

  await check('mode=group + channel=email → 501 (group email is a future slice)', async () => {
    const r = await createThread({
      kind: 'bridged_tenant',
      mode: 'group',
      channel: 'email',
      participants: [llPart, t1Part],
    });
    assertStatus(r, 501, 'group email');
  });

  await check('duplicate participant addresses on an email thread → 400', async () => {
    const r = await createThread({
      kind: 'bridged_tenant',
      channel: 'email',
      participants: [llPart, { party_type: 'tenant', party_id: fx.tenant1Id, address: LL_EMAIL }],
    });
    assertStatus(r, 400, 'duplicate email addresses');
  });

  // =========================================================================
  // (3) Landlord email defaults from the signup JWT when address omitted
  // =========================================================================
  await check(
    'landlord_user address omitted → resolves from the stored channel identity (identity outranks the JWT claim)',
    async () => {
      // Check (1)'s explicit landlord address was remembered as a channel
      // identity, so the resolution chain (explicit -> identity -> JWT email)
      // now stops at the identity tier — the account's address book wins over
      // the caller's login email. The pure-JWT tier is covered by check (0).
      const t3 = await api('POST', `/v1/accounts/${fx.accountId}/tenants`, {
        token: fx.landlordToken,
        body: { full_name: 'Tenant Three' },
      });
      const tenant3Id = (assertStatus(t3, 201, 'create tenant3') as { id: string }).id;
      const r = await createThread({
        kind: 'bridged_tenant',
        channel: 'email',
        subject: 'Second thread',
        tenancy_id: fx.tenancyId,
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
    },
  );

  // =========================================================================
  // (3b) Landlord CC arm (outbound) — is_cc persists at create; a tenant-leg
  // intent freezes the flagged participant's REAL email as cc_addresses; the
  // flagged participant's OWN leg is never self-CC'd; sms threads refuse the
  // flag outright. Self-contained thread + fresh addresses so nothing here
  // leaks into the shared thread-1 state.
  // =========================================================================
  const LLCC_EMAIL = `llcc-${SUFFIX}@e2.test`;
  const T1CC_EMAIL = `t1cc-${SUFFIX}@e2.test`;
  await check(
    'landlord CC arm: is_cc persists; tenant-leg intent freezes cc_addresses; own leg is not self-CCd',
    async () => {
      const r = await createThread({
        kind: 'bridged_tenant',
        channel: 'email',
        subject: 'CC arm probe',
        tenancy_id: fx.tenancyId,
        participants: [
          {
            party_type: 'landlord_user',
            party_id: fx.landlordId,
            address: LLCC_EMAIL,
            is_cc: true,
          },
          { party_type: 'tenant', party_id: fx.tenant1Id, address: T1CC_EMAIL },
        ],
      });
      const t = assertStatus(r, 201, 'cc thread create') as ThreadDetailShape;
      const llp = t.participants.find((p) => p.party_type === 'landlord_user');
      const t1p = t.participants.find((p) => p.party_type === 'tenant');
      assert(llp !== undefined && t1p !== undefined, 'both participants present');
      assert(llp!.is_cc === true, `landlord is_cc persisted: ${llp!.is_cc}`);
      assert(t1p!.is_cc === false, `tenant is_cc defaults false: ${t1p!.is_cc}`);

      // Agent intent to the TENANT leg (proposal-approved shape) → the flagged
      // landlord's real email is frozen as the visible-Cc set at intent time.
      const tenantLeg = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          thread_id: t.id,
          participant_ref: t1p!.id,
          body: 'cc probe to tenant',
          approval_ref: 'proposal:cc-arm',
          approved_by: fx.landlordId,
        },
      });
      const row = assertStatus(tenantLeg, 201, 'tenant-leg intent') as OutboxShape;
      assert(row.to_address === T1CC_EMAIL, `tenant leg to_address: ${row.to_address}`);
      assert(
        JSON.stringify(row.cc_addresses) === JSON.stringify([LLCC_EMAIL]),
        `cc_addresses frozen with the landlord email: ${JSON.stringify(row.cc_addresses)}`,
      );

      // Intent to the FLAGGED participant's own leg → never self-CC'd.
      const landlordLeg = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          thread_id: t.id,
          participant_ref: llp!.id,
          body: 'cc probe to landlord',
          approval_ref: 'proposal:cc-arm',
          approved_by: fx.landlordId,
        },
      });
      const llRow = assertStatus(landlordLeg, 201, 'landlord-leg intent') as OutboxShape;
      assert(
        llRow.cc_addresses === null,
        `own leg is not self-CCd: ${JSON.stringify(llRow.cc_addresses)}`,
      );
    },
  );

  await check('landlord CC arm: is_cc on an sms thread create → 400 (email-only)', async () => {
    const r = await createThread({
      kind: 'bridged_tenant',
      channel: 'sms',
      participants: [
        { party_type: 'landlord_user', party_id: fx.landlordId, is_cc: true },
        { party_type: 'tenant', party_id: fx.tenant1Id, address: T1_PHONE },
      ],
    });
    assertStatus(r, 400, 'is_cc on sms thread');
  });

  await check(
    'landlord CC arm: is_cc on a non-landlord participant → 400 (landlord-only)',
    async () => {
      const r = await createThread({
        kind: 'bridged_tenant',
        channel: 'email',
        subject: 'CC guard probe',
        participants: [
          {
            party_type: 'landlord_user',
            party_id: fx.landlordId,
            address: `llg-${SUFFIX}@e2.test`,
          },
          {
            party_type: 'tenant',
            party_id: fx.tenant1Id,
            address: `t1g-${SUFFIX}@e2.test`,
            is_cc: true,
          },
        ],
      });
      assertStatus(r, 400, 'is_cc on tenant participant');
    },
  );

  // Shared state for the CC-arm checks below.
  let ccThreadId = '';
  let ccTenantPartId = '';
  let ccTenantToken = '';
  await check(
    'landlord CC arm: fan-out parity — landlord-composed thread message carries the Cc',
    async () => {
      // Fresh CC thread (fresh addresses; the earlier CC thread's state is not
      // reused so these checks stay independent).
      const LL2 = `llcc2-${SUFFIX}@e2.test`;
      const T2CC = `t1cc2-${SUFFIX}@e2.test`;
      const r = await createThread({
        kind: 'bridged_tenant',
        channel: 'email',
        subject: 'CC fan-out probe',
        tenancy_id: fx.tenancyId,
        participants: [
          { party_type: 'landlord_user', party_id: fx.landlordId, address: LL2, is_cc: true },
          { party_type: 'tenant', party_id: fx.tenant1Id, address: T2CC },
        ],
      });
      const t = assertStatus(r, 201, 'cc fan-out thread create') as ThreadDetailShape;
      ccThreadId = t.id;
      const t1p = t.participants.find((p) => p.party_type === 'tenant');
      assert(t1p !== undefined, 'tenant participant present');
      ccTenantPartId = t1p!.id;
      const t1b = t.bindings.find((b) => b.participant_id === t1p!.id);
      assert(t1b?.reply_address != null, 'tenant reply token present');
      ccTenantToken = t1b!.reply_address!;

      const msg = await api('POST', `${base}/threads/${t.id}/messages`, {
        token: fx.landlordToken,
        body: { body: 'composed in-app' },
      });
      const legs = (assertStatus(msg, 201, 'thread message') as { data: OutboxShape[] }).data;
      assert(legs.length === 1, `one tenant leg: ${legs.length}`);
      assert(
        JSON.stringify(legs[0]!.cc_addresses) === JSON.stringify([LL2]),
        `fan-out leg carries the Cc: ${JSON.stringify(legs[0]!.cc_addresses)}`,
      );
    },
  );

  await check(
    'landlord CC arm: relaying the flagged landlord’s OWN inbound does not Cc them (echo exclusion)',
    async () => {
      // The landlord writes into the CC thread from their real inbox (via their
      // reply token? No — the LANDLORD's inbound arrives on THEIR token). Here we
      // capture an inbound FROM the landlord on the landlord's token, then relay
      // it to the tenant leg. The flagged landlord is the relayed sender, so the
      // relay must NOT Cc them their own words.
      const detail = await threadDetail(ccThreadId);
      const llp = detail.participants.find((p) => p.party_type === 'landlord_user');
      const llb = detail.bindings.find((b) => b.participant_id === llp!.id);
      assert(llb?.reply_address != null, 'landlord reply token present');
      const cap = await capture({
        provider: 'resend',
        provider_msg_id: `IN-ccecho-${rnd()}`,
        to_number: llb!.reply_address,
        from_address: `llcc2-${SUFFIX}@e2.test`,
        channel: 'email',
        body: 'from the landlord inbox',
        received_at: iso(),
      });
      const res = assertStatus(cap, 200, 'landlord inbound') as CaptureShape;
      assert(res.disposition === 'matched', `landlord inbound matched: ${res.disposition}`);

      const relay = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          thread_id: ccThreadId,
          participant_ref: ccTenantPartId,
          relay_of_interaction_id: res.interaction_id,
          body: 'relayed to tenant',
          approval_ref: `thread:${ccThreadId}`,
        },
      });
      const row = assertStatus(relay, 201, 'relay intent') as OutboxShape;
      assert(
        row.cc_addresses === null,
        `relay of the landlord's own words is not self-CCd: ${JSON.stringify(row.cc_addresses)}`,
      );
    },
  );

  await check(
    'landlord CC arm: relaying the TENANT’s inbound to the tenant leg still carries the Cc',
    async () => {
      const cap = await capture({
        provider: 'resend',
        provider_msg_id: `IN-cctenant-${rnd()}`,
        to_number: ccTenantToken,
        from_address: `t1cc2-${SUFFIX}@e2.test`,
        channel: 'email',
        body: 'from the tenant',
        received_at: iso(),
      });
      const res = assertStatus(cap, 200, 'tenant inbound') as CaptureShape;
      assert(res.disposition === 'matched', `tenant inbound matched: ${res.disposition}`);
      // A hypothetical second counterparty leg would carry the Cc; the tenant's
      // own leg is the only counterparty here, so relay to it (echo of the
      // TENANT's message back to the tenant is not a real flow, but the CC
      // resolution is identical for any non-sender counterparty leg): the
      // flagged landlord is NOT the relayed sender, so the Cc must survive.
      const relay = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          thread_id: ccThreadId,
          participant_ref: ccTenantPartId,
          relay_of_interaction_id: res.interaction_id,
          body: 'relayed onward',
          approval_ref: `thread:${ccThreadId}`,
        },
      });
      const row = assertStatus(relay, 201, 'relay intent') as OutboxShape;
      assert(
        JSON.stringify(row.cc_addresses) === JSON.stringify([`llcc2-${SUFFIX}@e2.test`]),
        `non-sender Cc survives on relay: ${JSON.stringify(row.cc_addresses)}`,
      );
    },
  );

  await check(
    'landlord CC arm: landlord plain-reply to the TENANT’s token re-attributes as matched (no black-hole)',
    async () => {
      // A CC'd landlord plain-replies from their real inbox to the tenant leg's
      // copy — so the inbound lands on the TENANT's reply token but its FROM is
      // the landlord's verified address. Cross-participant re-attribution routes
      // it to the landlord participant and dispositions it 'matched' (previously a
      // sender_mismatch black-hole).
      const cap = await capture({
        provider: 'resend',
        provider_msg_id: `IN-ccreply-${rnd()}`,
        to_number: ccTenantToken,
        from_address: `llcc2-${SUFFIX}@e2.test`,
        channel: 'email',
        body: 'plain reply from the landlord inbox',
        received_at: iso(),
      });
      const res = assertStatus(cap, 200, 'landlord plain-reply inbound') as CaptureShape;
      assert(res.disposition === 'matched', `re-attributed disposition: ${res.disposition}`);
      assert(res.participant !== null, 'participant hydrated on re-attribution');
      assert(
        res.participant!.party_type === 'landlord_user',
        `re-attributed party_type: ${res.participant?.party_type}`,
      );
      assert(res.participant!.is_cc === true, `re-attributed is_cc: ${res.participant?.is_cc}`);
      assert(res.thread_id === ccThreadId, `re-attributed thread: ${res.thread_id}`);

      // Prove relayability end-to-end: relay the landlord's re-attributed reply to
      // the tenant leg. It reaches the tenant, and the echo exclusion (keyed on
      // the journal row's party_id, which re-attribution set to the landlord's
      // user id) drops the landlord from the Cc — no self-CC of their own words.
      const relay = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          thread_id: ccThreadId,
          participant_ref: ccTenantPartId,
          relay_of_interaction_id: res.interaction_id,
          body: 'relayed reply',
          approval_ref: `thread:${ccThreadId}`,
        },
      });
      const row = assertStatus(relay, 201, 'relay to tenant leg') as OutboxShape;
      assert(row.to_address === `t1cc2-${SUFFIX}@e2.test`, `relay to_address: ${row.to_address}`);
      assert(
        row.cc_addresses === null,
        `relay of the landlord's own words is not self-CCd: ${JSON.stringify(row.cc_addresses)}`,
      );
    },
  );

  await check(
    'landlord CC arm: a stranger on the tenant token still parks as sender_mismatch (re-attribution is participants-only)',
    async () => {
      const cap = await capture({
        provider: 'resend',
        provider_msg_id: `IN-ccstranger-${rnd()}`,
        to_number: ccTenantToken,
        from_address: `nobody-${SUFFIX}@evil.test`,
        channel: 'email',
        body: 'plain reply from the landlord inbox',
        received_at: iso(),
      });
      const res = assertStatus(cap, 200, 'stranger inbound') as CaptureShape;
      assert(res.disposition === 'sender_mismatch', `stranger disposition: ${res.disposition}`);
    },
  );

  await check(
    'landlord CC arm: completed CC send journals the copied party as role=cc in the cast',
    async () => {
      // Complete a fresh agent tenant-leg send on the CC thread, then assert the
      // journal cast (interaction_participants) records the landlord as role='cc'
      // — the evidentiary "who was copied" record.
      const intent = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          thread_id: ccThreadId,
          participant_ref: ccTenantPartId,
          body: 'cast probe',
          approval_ref: 'proposal:cc-cast',
          approved_by: fx.landlordId,
        },
      });
      const row = assertStatus(intent, 201, 'cast-probe intent') as OutboxShape;
      const claim = await api('POST', `${base}/outbox/${row.id}/delivery`, {
        token: fx.agentToken,
        body: { status: 'sending', provider_ts: iso() },
      });
      assertStatus(claim, 200, 'cast-probe claim');
      const done = await api('POST', `${base}/outbox/${row.id}/complete`, {
        token: fx.agentToken,
        body: { provider: 'resend', provider_sid: `em-cast-${rnd()}` },
      });
      const body = assertStatus(done, 200, 'cast-probe complete') as { interaction_id: string };

      const { data: cast, error } = await admin
        .from('interaction_participants')
        .select('role, party_type, address')
        .eq('interaction_id', body.interaction_id);
      assert(!error, `cast read: ${error?.message}`);
      const cc = (cast ?? []).filter((p) => p.role === 'cc');
      assert(cc.length === 1, `one cc cast row: ${JSON.stringify(cast)}`);
      assert(cc[0]!.address === `llcc2-${SUFFIX}@e2.test`, `cc cast address: ${cc[0]!.address}`);
      assert(cc[0]!.party_type === 'landlord_user', `cc cast party_type: ${cc[0]!.party_type}`);
      const primary = (cast ?? []).filter((p) => p.role === 'recipient');
      assert(
        primary.length === 1 && primary[0]!.address === `t1cc2-${SUFFIX}@e2.test`,
        `primary cast row intact: ${JSON.stringify(primary)}`,
      );
    },
  );

  // --- bare/system email sends (thread-less) --------------------------------
  // Hard gate (product decision 2026-07-17): a bare EMAIL intent requires
  // complete branding (persona_address computable) — otherwise the transport
  // would fall back to the platform noreply@, whose replies are dropped.
  // Thread legs (the whole corpus above) stay exempt.

  await check(
    'bare email intent on an unbranded account → 422 hard gate (stable message)',
    async () => {
      const r = await api('POST', `${base}/outbox`, {
        token: fx.landlordToken,
        body: {
          channel: 'email',
          to_address: `bare-gate-${SUFFIX}@e2.test`,
          subject: 'Gate probe',
          body: 'no branding yet',
          approval_ref: self,
        },
      });
      assertStatus(r, 422, 'unbranded bare email');
      const msg = (r.body as { error?: { message?: string } })?.error?.message;
      assert(msg === 'email branding is not configured', `stable gate message: ${msg}`);

      // The AGENT principal hits the same gate — and, more importantly, its
      // RLS read of the accounts row must survive (is_account_member is
      // role-agnostic today; this pins it so a future policy tightening that
      // filtered the agent's row would fail loudly here, not silently 404
      // every agent bare send in prod).
      const agent = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          to_address: `bare-gate-agent-${SUFFIX}@e2.test`,
          body: 'agent probe, no branding yet',
          approval_ref: 'proposal:gate-probe',
          approved_by: fx.landlordId,
        },
      });
      assertStatus(agent, 422, 'unbranded agent bare email (not 404: RLS row visible)');
      const agentMsg = (agent.body as { error?: { message?: string } })?.error?.message;
      assert(agentMsg === 'email branding is not configured', `agent gate message: ${agentMsg}`);
    },
  );

  // Brand the fixture account so the bare-send corpus below clears the gate
  // (the 20260721000003 trigger auto-fills persona 'manager'). The subdomain
  // is cleared again after the last bare check, so later thread-minting
  // checks keep exercising the shared reply domain.
  await check(
    'branding the account (subdomain only) → persona defaults to manager, gate opens',
    async () => {
      const r = await api('PATCH', `/v1/accounts/${fx.accountId}/email-branding`, {
        token: fx.landlordToken,
        body: { email_subdomain: `bare${SUFFIX}` },
      });
      const b = assertStatus(r, 200, 'brand fx account') as { persona_local_part: string | null };
      assert(b.persona_local_part === 'manager', `defaulted persona: ${b.persona_local_part}`);

      // Branded: the agent principal's bare send now clears the gate (201) —
      // the positive half of the RLS pin above.
      const agent = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          to_address: `bare-gate-agent-ok-${SUFFIX}@e2.test`,
          body: 'agent probe, branded',
          approval_ref: 'proposal:gate-probe-ok',
          approved_by: fx.landlordId,
        },
      });
      assertStatus(agent, 201, 'branded agent bare email');
    },
  );

  await check(
    'landlord CC arm (bare): explicit cc_addresses on a thread-less email intent freezes verbatim',
    async () => {
      const r = await api('POST', `${base}/outbox`, {
        token: fx.landlordToken,
        body: {
          channel: 'email',
          to_address: `bare-t-${SUFFIX}@e2.test`,
          cc_addresses: [`Bare-LL-${SUFFIX}@e2.test`], // mixed case → lowercased
          subject: 'Inspection link',
          body: 'bare send',
          approval_ref: self,
        },
      });
      const row = assertStatus(r, 201, 'bare cc intent') as OutboxShape;
      assert(
        JSON.stringify(row.cc_addresses) === JSON.stringify([`bare-ll-${SUFFIX}@e2.test`]),
        `bare cc frozen lowercased: ${JSON.stringify(row.cc_addresses)}`,
      );

      // No context on this intent (no tenancy_id, addresses unknown to the
      // account): both entries must stay 'unknown' — the context tiers may
      // never guess.
      const { data: snapRow, error } = await admin
        .from('comm_outbox')
        .select('recipient_snapshot')
        .eq('id', row.id)
        .single();
      assert(!error, `snapshot read: ${error?.message}`);
      const snap = (snapRow!.recipient_snapshot ?? []) as Array<{
        party_type: string;
        party_id: string | null;
        resolution_source?: string;
      }>;
      assert(
        snap.length === 2 && snap.every((e) => e.party_type === 'unknown' && e.party_id === null),
        `context-less bare snapshot stays unknown: ${JSON.stringify(snap)}`,
      );
      assert(
        snap.every((e) => e.resolution_source === 'unknown'),
        `unknown entries carry resolution_source=unknown: ${JSON.stringify(snap)}`,
      );
    },
  );

  await check(
    'bare send with tenancy context: snapshot resolves To→tenant member, Cc→landlord_user; journal files under the unit',
    async () => {
      // A member tenant whose stored email (mixed case) matches the dialed To —
      // the tenancy-member tier, not the address book, must resolve it.
      const T_RES = `bare-res-t-${SUFFIX}@e2.test`;
      const t3 = await api('POST', `/v1/accounts/${fx.accountId}/tenants`, {
        token: fx.landlordToken,
        body: { full_name: 'Bare Res Tenant', emails: [`Bare-Res-T-${SUFFIX}@E2.test`] },
      });
      const t3Id = (assertStatus(t3, 201, 'resolvable tenant') as { id: string }).id;
      const mem = await api(
        'POST',
        `/v1/accounts/${fx.accountId}/tenancies/${fx.tenancyId}/members`,
        {
          token: fx.landlordToken,
          body: { tenant_id: t3Id, role: 'occupant' },
        },
      );
      assertStatus(mem, 201, 'tenancy member add');

      const r = await api('POST', `${base}/outbox`, {
        token: fx.landlordToken,
        body: {
          channel: 'email',
          to_address: T_RES,
          cc_addresses: [fx.landlordEmail],
          tenancy_id: fx.tenancyId,
          subject: 'Inspection link',
          body: 'context probe',
          approval_ref: self,
        },
      });
      const row = assertStatus(r, 201, 'context intent') as OutboxShape;

      const { data: snapRow, error } = await admin
        .from('comm_outbox')
        .select('recipient_snapshot')
        .eq('id', row.id)
        .single();
      assert(!error, `snapshot read: ${error?.message}`);
      const snap = (snapRow!.recipient_snapshot ?? []) as Array<{
        role?: string;
        party_type: string;
        party_id: string | null;
        address: string;
        label: string | null;
        resolution_source?: string;
      }>;
      const primary = snap.find((e) => (e.role ?? 'recipient') !== 'cc');
      assert(
        primary?.party_type === 'tenant' && primary?.party_id === t3Id,
        `To resolved via the tenancy: ${JSON.stringify(snap)}`,
      );
      assert(
        primary?.label === 'Bare Res Tenant',
        `resolved label from _party_display_name: ${primary?.label}`,
      );
      assert(
        primary?.resolution_source === 'tenancy_member',
        `To resolution source stamped: ${primary?.resolution_source}`,
      );
      const ccEntry = snap.find((e) => e.role === 'cc');
      assert(
        ccEntry?.party_type === 'landlord_user' && ccEntry?.party_id === fx.landlordId,
        `Cc resolved to the account owner: ${JSON.stringify(snap)}`,
      );
      assert(
        ccEntry?.resolution_source === 'account_member',
        `Cc resolution source stamped: ${ccEntry?.resolution_source}`,
      );

      // Complete → the journal headline/cast carry the linked parties, and the
      // row files under the tenancy's unit (area_id stored, property_id derived).
      const claim = await api('POST', `${base}/outbox/${row.id}/delivery`, {
        token: fx.agentToken,
        body: { status: 'sending', provider_ts: iso() },
      });
      assertStatus(claim, 200, 'context claim');
      const done = await api('POST', `${base}/outbox/${row.id}/complete`, {
        token: fx.agentToken,
        body: { provider: 'resend', provider_sid: `em-ctx-${rnd()}` },
      });
      const doneBody = assertStatus(done, 200, 'context complete') as { interaction_id: string };

      const ten = await api('GET', `/v1/accounts/${fx.accountId}/tenancies/${fx.tenancyId}`, {
        token: fx.landlordToken,
      });
      const unitId = (assertStatus(ten, 200, 'tenancy read') as { area_id: string }).area_id;
      const area = await api('GET', `/v1/accounts/${fx.accountId}/areas/${unitId}`, {
        token: fx.landlordToken,
      });
      const propertyId = (assertStatus(area, 200, 'area read') as { property_id: string })
        .property_id;

      const j = await api(
        'GET',
        `/v1/accounts/${fx.accountId}/interactions/${doneBody.interaction_id}`,
        {
          token: fx.landlordToken,
        },
      );
      const ji = assertStatus(j, 200, 'journal read') as {
        party_type: string;
        party_id: string | null;
        area_id: string | null;
        property_id: string | null;
        participants?: Array<{ role: string; party_type: string; party_id: string | null }>;
      };
      assert(
        ji.party_type === 'tenant' && ji.party_id === t3Id,
        `journal headline linked: ${ji.party_type}/${ji.party_id}`,
      );
      assert(ji.area_id === unitId, `journal filed under the unit: ${ji.area_id}`);
      assert(ji.property_id === propertyId, `property derived from area: ${ji.property_id}`);
      const jcc = (ji.participants ?? []).find((p) => p.role === 'cc');
      assert(
        jcc?.party_type === 'landlord_user' && jcc?.party_id === fx.landlordId,
        `journal cast cc linked: ${JSON.stringify(ji.participants)}`,
      );
    },
  );

  await check(
    'bare send context tiers PREEMPT the address book (tenancy context outranks channel_identities)',
    async () => {
      // Persona routing v2 (plan §9.1.3): the address book says this address
      // is Tenant One, but the intent's own tenancy says the new member
      // tenant. Explicit bare-intent context is authoritative — the unverified
      // account-wide learned identity must NOT preempt it. (This check
      // previously enshrined the opposite precedence; that was the incident.)
      const ADDR = `learned-${SUFFIX}@e2.test`;
      const t5 = await api('POST', `/v1/accounts/${fx.accountId}/tenants`, {
        token: fx.landlordToken,
        body: { full_name: 'Shadow Tenant', emails: [ADDR] },
      });
      const t5Id = (assertStatus(t5, 201, 'shadow tenant') as { id: string }).id;
      const mem = await api(
        'POST',
        `/v1/accounts/${fx.accountId}/tenancies/${fx.tenancyId}/members`,
        {
          token: fx.landlordToken,
          body: { tenant_id: t5Id, role: 'occupant' },
        },
      );
      assertStatus(mem, 201, 'shadow member add');
      {
        const { error } = await admin.from('channel_identities').insert({
          account_id: fx.accountId,
          channel: 'email',
          address: ADDR,
          party_type: 'tenant',
          party_id: fx.tenant1Id,
          label: 'Learned One',
          source: 'provider_learned',
        });
        assert(!error, `identity seed: ${error?.message}`);
      }

      const r = await api('POST', `${base}/outbox`, {
        token: fx.landlordToken,
        body: {
          channel: 'email',
          to_address: ADDR,
          tenancy_id: fx.tenancyId,
          body: 'precedence probe',
          approval_ref: self,
        },
      });
      const row = assertStatus(r, 201, 'precedence intent') as OutboxShape;
      const { data: snapRow, error } = await admin
        .from('comm_outbox')
        .select('recipient_snapshot')
        .eq('id', row.id)
        .single();
      assert(!error, `snapshot read: ${error?.message}`);
      const snap = (snapRow!.recipient_snapshot ?? []) as Array<{
        party_type: string;
        party_id: string | null;
        resolution_source?: string;
      }>;
      assert(
        snap[0]!.party_type === 'tenant' && snap[0]!.party_id === t5Id,
        `tenancy context wins over the address book: ${JSON.stringify(snap)}`,
      );
      assert(
        snap[0]!.resolution_source === 'tenancy_member',
        `resolution source stamped: ${JSON.stringify(snap)}`,
      );
    },
  );

  await check(
    'landlord CC arm (bare): guards — sms 400, with thread_id 400, invalid entry 422',
    async () => {
      const sms = await api('POST', `${base}/outbox`, {
        token: fx.landlordToken,
        body: {
          channel: 'sms',
          to_address: T1_PHONE,
          cc_addresses: [`x-${SUFFIX}@e2.test`],
          body: 'nope',
          approval_ref: self,
        },
      });
      assertStatus(sms, 400, 'cc on sms intent');

      const withThread = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          thread_id: ccThreadId,
          participant_ref: ccTenantPartId,
          cc_addresses: [`x-${SUFFIX}@e2.test`],
          body: 'nope',
          approval_ref: 'proposal:cc-guard',
          approved_by: fx.landlordId,
        },
      });
      assertStatus(withThread, 400, 'explicit cc on a thread leg');

      const invalid = await api('POST', `${base}/outbox`, {
        token: fx.landlordToken,
        body: {
          channel: 'email',
          to_address: `bare-t2-${SUFFIX}@e2.test`,
          cc_addresses: ['not-an-email'],
          body: 'nope',
          approval_ref: self,
        },
      });
      assertStatus(invalid, 422, 'invalid cc entry');
    },
  );

  await check(
    'landlord CC arm: an opted-out CC address is SCRUBBED at insert (send still 201, no Cc)',
    async () => {
      const OPTED = `optcc-${SUFFIX}@e2.test`;
      const oo = await api('POST', `${base}/opt-outs`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          address: OPTED,
          keyword: 'unsubscribe',
          source_ref: `m-cc-${SUFFIX}`,
        },
      });
      assertStatus(oo, 200, 'register cc opt-out');

      const r = await api('POST', `${base}/outbox`, {
        token: fx.landlordToken,
        body: {
          channel: 'email',
          to_address: `bare-t3-${SUFFIX}@e2.test`,
          cc_addresses: [OPTED, `keepcc-${SUFFIX}@e2.test`],
          body: 'scrub probe',
          approval_ref: self,
        },
      });
      const row = assertStatus(r, 201, 'scrubbed cc intent') as OutboxShape;
      assert(
        JSON.stringify(row.cc_addresses) === JSON.stringify([`keepcc-${SUFFIX}@e2.test`]),
        `opted-out cc scrubbed, other kept: ${JSON.stringify(row.cc_addresses)}`,
      );
    },
  );

  // --- explicit caller party intent (persona routing v2 PR 3) ---------------
  // The account is still branded here (`bare<SUFFIX>`), so the bare-send gate
  // is open and the persona reply below can resolve a receiving domain. to_party
  // / cc_parties let the caller STATE the party it already knows; core
  // re-verifies each hint independently before freezing it as
  // resolution_source='caller_intent'.

  // A FOREIGN account + tenant — proves account scoping (wrong-account 422 and
  // the forged-hint trigger backstop below).
  let foreignTenantId = '';
  {
    const fEmail = `commset-foreign-${rnd()}@example.test`;
    const fPw = `correct-horse-${rnd()}`;
    const fsu = await api('POST', '/v1/auth/signup', {
      body: { email: fEmail, password: fPw, account_name: 'Foreign Acct' },
    });
    const fb = assertStatus(fsu, 200, 'foreign signup') as {
      account: { id: string };
      session: { access_token: string };
    };
    const ft = await api('POST', `/v1/accounts/${fb.account.id}/tenants`, {
      token: fb.session.access_token,
      body: { full_name: 'Foreign Tenant', emails: [`foreign-t-${SUFFIX}@e2.test`] },
    });
    foreignTenantId = (assertStatus(ft, 201, 'foreign tenant') as { id: string }).id;
  }

  // The account persona (subdomain `bare<SUFFIX>`, persona defaulted 'manager').
  const CI_PERSONA = `manager@bare${SUFFIX}.brand-${SUFFIX}.test`;
  const CI_AUTH_PASS = { spf: 'pass', dkim: 'pass', dmarc: 'pass' } as const;

  await check(
    'to_party + cc_parties + tenancy_id → 201; both snapshot entries frozen caller_intent; a persona reply routes via the parent',
    async () => {
      // The primary recipient: a tenant whose stored email is the To address and
      // who is a member of the intent's tenancy.
      const CI_TO = `ci-tenant-${SUFFIX}@e2.test`;
      const ct = await api('POST', `/v1/accounts/${fx.accountId}/tenants`, {
        token: fx.landlordToken,
        body: { full_name: 'Caller Intent Tenant', emails: [CI_TO] },
      });
      const ciTenantId = (assertStatus(ct, 201, 'ci tenant') as { id: string }).id;
      const mem = await api(
        'POST',
        `/v1/accounts/${fx.accountId}/tenancies/${fx.tenancyId}/members`,
        { token: fx.landlordToken, body: { tenant_id: ciTenantId, role: 'occupant' } },
      );
      assertStatus(mem, 201, 'ci tenancy member');

      const r = await api('POST', `${base}/outbox`, {
        token: fx.landlordToken,
        body: {
          channel: 'email',
          to_address: CI_TO,
          to_party: { party_type: 'tenant', party_id: ciTenantId },
          cc_addresses: [fx.landlordEmail],
          cc_parties: [
            {
              address: fx.landlordEmail.toLowerCase(),
              party_type: 'landlord_user',
              party_id: fx.landlordId,
            },
          ],
          tenancy_id: fx.tenancyId,
          subject: 'Inspection link',
          body: 'caller intent probe',
          approval_ref: self,
        },
      });
      const row = assertStatus(r, 201, 'caller intent intent') as OutboxShape;

      // Both snapshot entries are frozen from the caller's stated party.
      const { data: snapRow, error } = await admin
        .from('comm_outbox')
        .select('recipient_snapshot')
        .eq('id', row.id)
        .single();
      assert(!error, `snapshot read: ${error?.message}`);
      const snap = (snapRow!.recipient_snapshot ?? []) as Array<{
        role?: string;
        party_type: string;
        party_id: string | null;
        resolution_source?: string;
      }>;
      const primary = snap.find((e) => (e.role ?? 'recipient') !== 'cc');
      assert(
        primary?.party_type === 'tenant' &&
          primary?.party_id === ciTenantId &&
          primary?.resolution_source === 'caller_intent',
        `To frozen from caller intent: ${JSON.stringify(snap)}`,
      );
      const ccEntry = snap.find((e) => e.role === 'cc');
      assert(
        ccEntry?.party_type === 'landlord_user' &&
          ccEntry?.party_id === fx.landlordId &&
          ccEntry?.resolution_source === 'caller_intent',
        `Cc frozen from caller intent: ${JSON.stringify(snap)}`,
      );

      // Complete → the row is a valid parent (sent, Message-ID stamped).
      const parentMsgId = `<ci-parent-${SUFFIX}@sender>`;
      const done = await api('POST', `${base}/outbox/${row.id}/complete`, {
        token: fx.agentToken,
        body: { provider: 'resend', provider_sid: `ci-${rnd()}`, rfc822_message_id: parentMsgId },
      });
      assertStatus(done, 200, 'caller intent parent complete');

      // The tenant replies through the persona; In-Reply-To names the parent.
      const reply = await api(`POST`, `/v1/accounts/${fx.accountId}/comms/inbound-persona`, {
        token: fx.agentToken,
        body: {
          provider: 'ses',
          provider_msg_id: `CI-reply-${rnd()}`,
          persona_address: CI_PERSONA,
          from_address: CI_TO,
          to_addresses: [CI_PERSONA],
          cc_addresses: [],
          subject: 'Re: Inspection link',
          body: 'tenant reply via persona',
          rfc822_message_id: `<ci-reply-${SUFFIX}@sender>`,
          in_reply_to: parentMsgId,
          references: [parentMsgId],
          auth_results: CI_AUTH_PASS,
          received_at: iso(),
        },
      });
      const res = assertStatus(reply, 200, 'caller intent reply') as CaptureShape;
      assert(res.disposition === 'matched', `reply matched: ${res.disposition}`);
      assert(
        res.participant?.party_type === 'tenant' && res.participant.party_id === ciTenantId,
        `reply routed to the parent's tenant: ${JSON.stringify(res.participant)}`,
      );
    },
  );

  await check('caller intent: wrong-account party id → 422', async () => {
    const r = await api('POST', `${base}/outbox`, {
      token: fx.landlordToken,
      body: {
        channel: 'email',
        to_address: `ci-wrong-${SUFFIX}@e2.test`,
        to_party: { party_type: 'tenant', party_id: foreignTenantId },
        body: 'x',
        approval_ref: self,
      },
    });
    assertStatus(r, 422, 'wrong-account to_party');
    assert(errCode(r) === 'invalid_request', `code: ${errCode(r)}`);
  });

  await check('caller intent: tenant not a member of the supplied tenancy → 422', async () => {
    const CI_NM = `ci-nonmember-${SUFFIX}@e2.test`;
    const t = await api('POST', `/v1/accounts/${fx.accountId}/tenants`, {
      token: fx.landlordToken,
      body: { full_name: 'Non-member', emails: [CI_NM] },
    });
    const tId = (assertStatus(t, 201, 'non-member tenant') as { id: string }).id;
    const r = await api('POST', `${base}/outbox`, {
      token: fx.landlordToken,
      body: {
        channel: 'email',
        to_address: CI_NM,
        to_party: { party_type: 'tenant', party_id: tId },
        tenancy_id: fx.tenancyId,
        body: 'x',
        approval_ref: self,
      },
    });
    assertStatus(r, 422, 'tenant not in tenancy');
  });

  await check('caller intent: address does not resolve to the hinted party → 422', async () => {
    const CI_A = `ci-hasmail-${SUFFIX}@e2.test`;
    const t = await api('POST', `/v1/accounts/${fx.accountId}/tenants`, {
      token: fx.landlordToken,
      body: { full_name: 'Has Mail', emails: [CI_A] },
    });
    const tId = (assertStatus(t, 201, 'address tenant') as { id: string }).id;
    const mem = await api(
      'POST',
      `/v1/accounts/${fx.accountId}/tenancies/${fx.tenancyId}/members`,
      { token: fx.landlordToken, body: { tenant_id: tId, role: 'occupant' } },
    );
    assertStatus(mem, 201, 'address tenant member');
    // The party is real and in the tenancy, but the To address is a DIFFERENT
    // address that resolves to nobody — the hint must not be trusted.
    const r = await api('POST', `${base}/outbox`, {
      token: fx.landlordToken,
      body: {
        channel: 'email',
        to_address: `ci-other-${SUFFIX}@e2.test`,
        to_party: { party_type: 'tenant', party_id: tId },
        tenancy_id: fx.tenancyId,
        body: 'x',
        approval_ref: self,
      },
    });
    assertStatus(r, 422, 'address does not verify');
  });

  await check('caller intent: cc_parties entry with no matching cc_addresses → 400', async () => {
    const r = await api('POST', `${base}/outbox`, {
      token: fx.landlordToken,
      body: {
        channel: 'email',
        to_address: `ci-t-${SUFFIX}@e2.test`,
        cc_addresses: [fx.landlordEmail],
        cc_parties: [
          {
            address: `ci-notcc-${SUFFIX}@e2.test`,
            party_type: 'landlord_user',
            party_id: fx.landlordId,
          },
        ],
        body: 'x',
        approval_ref: self,
      },
    });
    assertStatus(r, 400, 'cc_parties without a matching cc_addresses entry');
  });

  await check('caller intent: to_party with thread_id → 400', async () => {
    const r = await api('POST', `${base}/outbox`, {
      token: fx.landlordToken,
      body: {
        channel: 'email',
        thread_id: thread1Id,
        to_party: { party_type: 'tenant', party_id: fx.tenant1Id },
        body: 'x',
        approval_ref: self,
      },
    });
    assertStatus(r, 400, 'to_party is bare-only');
  });

  await check('caller intent: one address claimed by two different parties → 409', async () => {
    const r = await api('POST', `${base}/outbox`, {
      token: fx.landlordToken,
      body: {
        channel: 'email',
        to_address: `ci-conf-${SUFFIX}@e2.test`,
        cc_addresses: [fx.landlordEmail],
        cc_parties: [
          {
            address: fx.landlordEmail.toLowerCase(),
            party_type: 'landlord_user',
            party_id: fx.landlordId,
          },
          {
            address: fx.landlordEmail.toLowerCase(),
            party_type: 'landlord_user',
            party_id: crypto.randomUUID(),
          },
        ],
        body: 'x',
        approval_ref: self,
      },
    });
    assertStatus(r, 409, 'duplicate address, two parties');
  });

  await check(
    'caller intent backstop: a FORGED hint on a direct admin insert is REJECTED by the trigger',
    async () => {
      // The API pre-check never runs here; the snapshot trigger independently
      // re-verifies and RAISEs on a party from another account.
      const { error } = await admin.from('comm_outbox').insert({
        account_id: fx.accountId,
        channel: 'email',
        to_address: `ci-forged-${SUFFIX}@e2.test`,
        to_party_type: 'tenant',
        to_party_id: foreignTenantId,
        body: 'forged',
        approval_ref: self,
        author_type: 'landlord',
      });
      assert(error !== null, 'trigger must reject a forged caller-intent hint');
      assert(
        /to_party hint failed verification/.test(error!.message),
        `rejected for the RIGHT reason (hint verification), got: ${error!.message}`,
      );
    },
  );

  // NOTE: the fixture account STAYS branded (`bare<SUFFIX>`) through the
  // inbound/Message-ID sections below — thread legs are gate-exempt and the
  // headed-intent check (rfc822_message_id stamping) rides a bare send, which
  // needs the gate open. The re-arm check after it clears the subdomain.

  // =========================================================================
  // (4) Inbound token capture — matched, routed, journaled
  // =========================================================================
  await check(
    'inbound to the tenant reply token from the tenant → matched, routed, journaled',
    async () => {
      const r = await capture({
        provider: 'resend',
        provider_msg_id: `IN-em-${rnd()}`,
        to_number: tenant1Token,
        from_address: T1_EMAIL,
        channel: 'email',
        body: 'reply from tenant',
        received_at: iso(),
      });
      const res = assertStatus(r, 200, 'email inbound') as CaptureShape;
      assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
      assert(res.thread_id === thread1Id, `routed to email thread: ${res.thread_id}`);
      assert(
        res.participant?.id === tenant1ParticipantId,
        `sender participant: ${res.participant?.id}`,
      );
      assert(res.interaction_id !== null, 'journaled');
      tenantInboundIid = res.interaction_id!;
      const inbound = (await threadDetail(thread1Id)).messages.find(
        (m) => m.id === res.interaction_id,
      );
      assert(
        inbound !== undefined && inbound.direction === 'inbound',
        'inbound row present in the thread',
      );
    },
  );

  await check('inbound token + sender are case/space normalized → still matched', async () => {
    const r = await capture({
      provider: 'resend',
      provider_msg_id: `IN-em-${rnd()}`,
      to_number: tenant1Token.toUpperCase(),
      from_address: '  ' + T1_EMAIL.toUpperCase(),
      channel: 'email',
      body: 'cased reply',
      received_at: iso(),
    });
    const res = assertStatus(r, 200, 'normalized inbound') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === thread1Id, `still the email thread: ${res.thread_id}`);
    assert(
      res.participant?.id === tenant1ParticipantId,
      `sender participant: ${res.participant?.id}`,
    );
  });

  // =========================================================================
  // (5) Sender mismatch — journaled honestly, idempotent
  // =========================================================================
  await check(
    'inbound to the tenant token from a stranger → sender_mismatch, journaled as unspecified',
    async () => {
      const msgId = `IN-mm-${rnd()}`;
      const r = await capture({
        provider: 'resend',
        provider_msg_id: msgId,
        to_number: tenant1Token,
        from_address: STRANGER,
        channel: 'email',
        body: 'not the tenant',
        received_at: iso(),
      });
      const res = assertStatus(r, 200, 'sender mismatch') as CaptureShape;
      assert(res.disposition === 'sender_mismatch', `disposition: ${res.disposition}`);
      assert(res.thread_id === thread1Id, `thread_id set: ${res.thread_id}`);
      assert(res.interaction_id !== null, 'interaction_id set (contact happened)');

      // The journal row is attributed honestly: identity unresolved, but the
      // message entered the tenant's channel slot.
      const j = await api(
        'GET',
        `/v1/accounts/${fx.accountId}/interactions/${res.interaction_id}`,
        {
          token: fx.landlordToken,
        },
      );
      const row = assertStatus(j, 200, 'mismatch journal row') as {
        party_type: string;
        party_label: string | null;
        author_type: string;
        direction: string;
      };
      assert(row.party_type === 'unspecified', `party_type: ${row.party_type}`);
      assert(row.party_label === STRANGER, `party_label: ${row.party_label}`);
      assert(row.author_type === 'tenant', `author_type (slot capacity): ${row.author_type}`);
      assert(row.direction === 'inbound', `direction: ${row.direction}`);

      // Replay: identical disposition + interaction.
      const replay = await capture({
        provider: 'resend',
        provider_msg_id: msgId,
        to_number: tenant1Token,
        from_address: STRANGER,
        channel: 'email',
        body: 'not the tenant',
        received_at: iso(),
      });
      const rr = assertStatus(replay, 200, 'mismatch replay') as CaptureShape;
      assert(rr.disposition === 'sender_mismatch', `replay disposition: ${rr.disposition}`);
      assert(rr.interaction_id === res.interaction_id, 'replay is idempotent (same interaction)');
    },
  );

  // =========================================================================
  // (6) Landlord token capture — the landlord replies natively too
  // =========================================================================
  await check(
    'inbound to the LANDLORD reply token from the landlord → matched, landlord participant',
    async () => {
      const r = await capture({
        provider: 'resend',
        provider_msg_id: `IN-ll-${rnd()}`,
        to_number: landlordToken,
        from_address: LL_EMAIL,
        channel: 'email',
        body: 'landlord reply',
        received_at: iso(),
      });
      const res = assertStatus(r, 200, 'landlord inbound') as CaptureShape;
      assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
      assert(res.thread_id === thread1Id, `routed to the email thread: ${res.thread_id}`);
      assert(
        res.participant?.id === landlordParticipantId,
        `landlord participant: ${res.participant?.id}`,
      );
    },
  );

  // =========================================================================
  // (7) Orphan on an unknown token
  // =========================================================================
  await check('inbound to an unknown reply token → orphan, nothing journaled', async () => {
    const r = await capture({
      provider: 'resend',
      provider_msg_id: `IN-orphan-${rnd()}`,
      to_number: `t-${'0'.repeat(32)}@reply-${SUFFIX}.test`,
      from_address: T1_EMAIL,
      channel: 'email',
      body: 'to nowhere',
      received_at: iso(),
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
  await check(
    "cross-account: A's tenant token captured under account B → orphan (pinned)",
    async () => {
      const r = await capture(
        {
          provider: 'resend',
          provider_msg_id: `IN-xacct-${rnd()}`,
          to_number: tenant1Token,
          from_address: T1_EMAIL,
          channel: 'email',
          body: 'wrong account',
          received_at: iso(),
        },
        fxB.accountId,
      );
      const res = assertStatus(r, 200, 'cross-account capture') as CaptureShape;
      assert(res.disposition === 'orphan', `disposition: ${res.disposition}`);
      assert(res.interaction_id === null, 'nothing leaked or journaled');
    },
  );

  // =========================================================================
  // (9) Email relay — links to the original inbound, journal-once
  // =========================================================================
  await check(
    'email relay of the tenant inbound → completes onto the ORIGINAL interaction, no new journal row',
    async () => {
      const outboundBefore = await outboundCount(thread1Id);
      const intent = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          thread_id: thread1Id,
          participant_ref: landlordParticipantId,
          relay_of_interaction_id: tenantInboundIid,
          body: 'relayed body',
          approval_ref: `thread:${thread1Id}`,
        },
      });
      const row = assertStatus(intent, 201, 'relay intent') as OutboxShape;
      assert(
        row.to_address === LL_EMAIL.toLowerCase(),
        `relay to_address (landlord email): ${row.to_address}`,
      );

      const claim = await api('POST', `${base}/outbox/${row.id}/delivery`, {
        token: fx.agentToken,
        body: { status: 'sending', provider_ts: iso() },
      });
      assert(
        (assertStatus(claim, 200, 'relay claim') as { status: string }).status === 'sending',
        'claimed',
      );
      const done = await api('POST', `${base}/outbox/${row.id}/complete`, {
        token: fx.agentToken,
        body: { provider: 'resend', provider_sid: `em-${rnd()}` },
      });
      const body = assertStatus(done, 200, 'relay complete') as { interaction_id: string };
      assert(
        body.interaction_id === tenantInboundIid,
        `relay links to the original inbound: ${body.interaction_id}`,
      );
      const outboundAfter = await outboundCount(thread1Id);
      assert(
        outboundAfter === outboundBefore,
        `outbound journal count grew: ${outboundBefore} -> ${outboundAfter}`,
      );
    },
  );

  // =========================================================================
  // (9b) RFC822 headers + duplicate detection (persona plan, phase 2)
  // =========================================================================
  // The email's own Message-ID (not the provider receipt id) identifies it
  // across delivery doors: same account + same normalized Message-ID + same
  // thread → 'duplicate', pointing at the ORIGINAL journal row.
  let msgidInboundIid = '';
  const RFC_ID = `Dup-${SUFFIX}@sender.test`; // stored normalized: lowercased

  await check(
    'email capture with Message-ID/subject/auth_results → matched; journal carries the normalized id',
    async () => {
      const r = await capture({
        provider: 'resend',
        provider_msg_id: `IN-hdr-${rnd()}`,
        to_number: tenant1Token,
        from_address: T1_EMAIL,
        channel: 'email',
        body: 'headed reply',
        received_at: iso(),
        subject: 'About the sink',
        rfc822_message_id: `<${RFC_ID}>`,
        in_reply_to: '<prior@sender.test>',
        references: ['<root@sender.test>', '<prior@sender.test>'],
        auth_results: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      });
      const res = assertStatus(r, 200, 'headed capture') as CaptureShape;
      assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
      msgidInboundIid = res.interaction_id!;
      const { data: row, error } = await admin
        .from('interactions')
        .select('rfc822_message_id, body')
        .eq('id', msgidInboundIid)
        .single();
      if (error) throw new Error(`journal read: ${error.message}`);
      assert(
        row.rfc822_message_id === RFC_ID.toLowerCase(),
        `normalized id on the journal: ${row.rfc822_message_id}`,
      );
      // Subject is NOT folded into the journal body (phase-2 contract).
      assert(row.body === 'headed reply', `journal body unchanged: ${row.body}`);
    },
  );

  await check(
    'same Message-ID again via the SAME token (new receipt id) → duplicate, original ids returned',
    async () => {
      const r = await capture({
        provider: 'resend',
        provider_msg_id: `IN-hdr-${rnd()}`,
        to_number: tenant1Token,
        from_address: T1_EMAIL,
        channel: 'email',
        body: 'headed reply',
        received_at: iso(),
        rfc822_message_id: RFC_ID.toUpperCase(), // no brackets, different case → same normalized id
      });
      const res = assertStatus(r, 200, 'same-door duplicate') as CaptureShape;
      assert(res.disposition === 'duplicate', `disposition: ${res.disposition}`);
      assert(
        res.interaction_id === msgidInboundIid,
        `points at the original: ${res.interaction_id}`,
      );
      assert(res.thread_id === thread1Id, `thread: ${res.thread_id}`);
    },
  );

  await check(
    "two-door delivery: the same Message-ID via the LANDLORD's token (same thread) → duplicate",
    async () => {
      const doorTwo = `IN-hdr-${rnd()}`;
      const r = await capture({
        provider: 'resend',
        provider_msg_id: doorTwo,
        to_number: landlordToken,
        from_address: LL_EMAIL,
        channel: 'email',
        body: 'headed reply',
        received_at: iso(),
        rfc822_message_id: `<${RFC_ID}>`,
      });
      const res = assertStatus(r, 200, 'two-door duplicate') as CaptureShape;
      assert(res.disposition === 'duplicate', `disposition: ${res.disposition}`);
      assert(
        res.interaction_id === msgidInboundIid,
        `points at the original: ${res.interaction_id}`,
      );

      // Replay of the duplicate receipt answers identically from the raw cache.
      const replay = await capture({
        provider: 'resend',
        provider_msg_id: doorTwo,
        to_number: landlordToken,
        from_address: LL_EMAIL,
        channel: 'email',
        body: 'headed reply',
        received_at: iso(),
        rfc822_message_id: `<${RFC_ID}>`,
      });
      const rr = assertStatus(replay, 200, 'duplicate replay') as CaptureShape;
      assert(rr.disposition === 'duplicate', `replay disposition: ${rr.disposition}`);
      assert(rr.interaction_id === msgidInboundIid, 'replay returns the original id');
    },
  );

  await check('no Message-ID → never dedupes (two captures journal twice)', async () => {
    const a = assertStatus(
      await capture({
        provider: 'resend',
        provider_msg_id: `IN-noid-${rnd()}`,
        to_number: tenant1Token,
        from_address: T1_EMAIL,
        channel: 'email',
        body: 'no id',
        received_at: iso(),
      }),
      200,
      'no-id capture 1',
    ) as CaptureShape;
    const b = assertStatus(
      await capture({
        provider: 'resend',
        provider_msg_id: `IN-noid-${rnd()}`,
        to_number: tenant1Token,
        from_address: T1_EMAIL,
        channel: 'email',
        body: 'no id',
        received_at: iso(),
      }),
      200,
      'no-id capture 2',
    ) as CaptureShape;
    assert(
      a.disposition === 'matched' && b.disposition === 'matched',
      `dispositions: ${a.disposition}/${b.disposition}`,
    );
    assert(a.interaction_id !== b.interaction_id, 'distinct journal rows without a Message-ID');
  });

  await check('too-short Message-ID degrades to null (capture still journals)', async () => {
    // '<a>' is raw length 3 (passes the API's min(3) on the bracketed value) but
    // normalizes to a 1-char 'a' the destination CHECK (3..998) would reject —
    // it must degrade to null, never abort the evidentiary capture.
    const r = await capture({
      provider: 'resend',
      provider_msg_id: `IN-short-${rnd()}`,
      to_number: tenant1Token,
      from_address: T1_EMAIL,
      channel: 'email',
      body: 'short id',
      received_at: iso(),
      rfc822_message_id: '<a>',
    });
    const res = assertStatus(r, 200, 'too-short id capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.interaction_id !== null, 'still journaled');
    const { data: row, error } = await admin
      .from('interactions')
      .select('rfc822_message_id')
      .eq('id', res.interaction_id!)
      .single();
    if (error) throw new Error(`journal read: ${error.message}`);
    assert(
      row.rfc822_message_id === null,
      `degraded to null on the journal: ${row.rfc822_message_id}`,
    );
  });

  await check(
    'a mismatched sender citing a known Message-ID still journals as sender_mismatch',
    async () => {
      // The stranger cites RFC_ID (already journaled earlier) but from the wrong
      // address: the sender_mismatch evidence MUST win over dedupe, else the
      // unresolved-sender queue never sees the attempt.
      const r = await capture({
        provider: 'resend',
        provider_msg_id: `IN-mm-hdr-${rnd()}`,
        to_number: tenant1Token,
        from_address: STRANGER,
        channel: 'email',
        body: 'stranger cites a known id',
        received_at: iso(),
        rfc822_message_id: `<${RFC_ID}>`,
      });
      const res = assertStatus(r, 200, 'mismatch citing known id') as CaptureShape;
      assert(
        res.disposition === 'sender_mismatch',
        `disposition (mismatch beats dedupe): ${res.disposition}`,
      );
      assert(res.interaction_id !== null, 'evidence journaled');
      assert(
        res.interaction_id !== msgidInboundIid,
        `distinct from the original journal row: ${res.interaction_id}`,
      );
    },
  );

  await check('header fields on an sms capture → 400 (email-only)', async () => {
    const r = await capture({
      provider: 'telnyx',
      provider_msg_id: `IN-sms-${rnd()}`,
      to_number: PLATFORM_A,
      from_address: T1_PHONE,
      channel: 'sms',
      body: 'hi',
      received_at: iso(),
      rfc822_message_id: `<${RFC_ID}>`,
    });
    assertStatus(r, 400, 'sms with rfc822_message_id');
  });

  await check(
    'complete with rfc822_message_id → stamped (normalized) on the outbox row + journal entry',
    async () => {
      const intent = await api('POST', `${base}/outbox`, {
        token: fx.landlordToken,
        body: {
          channel: 'email',
          to_address: T1_EMAIL,
          body: 'sent with an id',
          subject: 'Receipt',
          approval_ref: self,
        },
      });
      const row = assertStatus(intent, 201, 'headed intent') as OutboxShape;
      const done = await api('POST', `${base}/outbox/${row.id}/complete`, {
        token: fx.agentToken,
        body: {
          provider: 'resend',
          provider_sid: `em-${rnd()}`,
          rfc822_message_id: `<Sent-${SUFFIX}@resend>`,
        },
      });
      const body = assertStatus(done, 200, 'headed complete') as {
        interaction_id: string;
        outbox: OutboxShape & { rfc822_message_id: string | null };
      };
      assert(
        body.outbox.rfc822_message_id === `sent-${SUFFIX}@resend`,
        `outbox sent id (normalized): ${body.outbox.rfc822_message_id}`,
      );
      const { data: j, error } = await admin
        .from('interactions')
        .select('rfc822_message_id')
        .eq('id', body.interaction_id)
        .single();
      if (error) throw new Error(`sent journal read: ${error.message}`);
      assert(
        j.rfc822_message_id === `sent-${SUFFIX}@resend`,
        `journal sent id: ${j.rfc822_message_id}`,
      );
    },
  );

  await check('clearing the subdomain re-arms the bare-send gate', async () => {
    const clear = await api('PATCH', `/v1/accounts/${fx.accountId}/email-branding`, {
      token: fx.landlordToken,
      body: { email_subdomain: null },
    });
    assertStatus(clear, 200, 'unbrand fx account');

    const r = await api('POST', `${base}/outbox`, {
      token: fx.landlordToken,
      body: {
        channel: 'email',
        to_address: `bare-gate2-${SUFFIX}@e2.test`,
        body: 'gate again',
        approval_ref: self,
      },
    });
    assertStatus(r, 422, 're-armed gate');
  });

  await check(
    'email relay leg exposes relay_source_rfc822_message_id (the inbound original)',
    async () => {
      const intent = await api('POST', `${base}/outbox`, {
        token: fx.agentToken,
        body: {
          channel: 'email',
          thread_id: thread1Id,
          participant_ref: landlordParticipantId,
          relay_of_interaction_id: msgidInboundIid,
          body: 'relayed headed body',
          approval_ref: `thread:${thread1Id}`,
        },
      });
      const row = assertStatus(intent, 201, 'headed relay intent') as OutboxShape;
      const read = await api('GET', `${base}/outbox/${row.id}`, { token: fx.agentToken });
      const got = assertStatus(read, 200, 'relay read') as {
        relay_source_rfc822_message_id?: string | null;
      };
      assert(
        got.relay_source_rfc822_message_id === RFC_ID.toLowerCase(),
        `relay source id: ${got.relay_source_rfc822_message_id}`,
      );
    },
  );

  // =========================================================================
  // (10) Channel-aware landlord in-app message on the email thread
  // =========================================================================
  await check(
    'landlord thread message on the email thread → one email intent to the tenant, no subject on the row',
    async () => {
      const r = await api('POST', `${base}/threads/${thread1Id}/messages`, {
        token: fx.landlordToken,
        body: { body: 'from the app' },
      });
      const out = assertStatus(r, 201, 'thread message') as { data: OutboxShape[] };
      assert(out.data.length === 1, `intents (one counterparty): ${out.data.length}`);
      const row = out.data[0]!;
      assert(row.channel === 'email', `channel: ${row.channel}`);
      assert(row.to_address === T1_EMAIL.toLowerCase(), `to_address: ${row.to_address}`);
      assert(
        row.subject === null,
        `subject on the outbox row must be null (transport renders "Re: …"): ${row.subject}`,
      );
      assert(row.approval_ref === self, `approval_ref: ${row.approval_ref}`);
    },
  );

  // Native threading (view refresh 20260710000001): thread detail messages
  // expose rfc822_message_id on both sides of the conversation — the transport
  // derives In-Reply-To/References for thread-leg sends from these, reading
  // the thread as the agent.
  await check(
    'thread detail messages expose rfc822_message_id (inbound + completed send)',
    async () => {
      const make = await api('POST', `${base}/threads/${thread1Id}/messages`, {
        token: fx.landlordToken,
        body: { body: 'threaded reply from the app' },
      });
      const intent = (assertStatus(make, 201, 'thread message') as { data: OutboxShape[] })
        .data[0]!;
      const claim = await api('POST', `${base}/outbox/${intent.id}/delivery`, {
        token: fx.agentToken,
        body: { status: 'sending', provider_ts: iso() },
      });
      assertStatus(claim, 200, 'claim');
      const SENT_ID = `thread-sent-${SUFFIX}@resend`; // pre-normalized (lowercase)
      const done = await api('POST', `${base}/outbox/${intent.id}/complete`, {
        token: fx.agentToken,
        body: {
          provider: 'resend',
          provider_sid: `em-${rnd()}`,
          rfc822_message_id: `<${SENT_ID}>`,
        },
      });
      const sentIid = (
        assertStatus(done, 200, 'headed thread complete') as { interaction_id: string }
      ).interaction_id;

      const r = await api('GET', `${base}/threads/${thread1Id}?limit=50`, { token: fx.agentToken });
      const detail = assertStatus(r, 200, 'thread detail (agent)') as {
        messages: { id: string; rfc822_message_id?: string | null }[];
      };
      const inboundMsg = detail.messages.find((m) => m.id === msgidInboundIid);
      assert(inboundMsg !== undefined, 'headed inbound present in thread read');
      assert(
        inboundMsg!.rfc822_message_id === RFC_ID.toLowerCase(),
        `inbound Message-ID on thread read: ${inboundMsg!.rfc822_message_id}`,
      );
      const sentMsg = detail.messages.find((m) => m.id === sentIid);
      assert(sentMsg !== undefined, 'completed send present in thread read');
      assert(
        sentMsg!.rfc822_message_id === SENT_ID,
        `sent Message-ID on thread read: ${sentMsg!.rfc822_message_id}`,
      );
    },
  );

  // =========================================================================
  // (11) sms/email coexistence
  // =========================================================================
  let smsThreadId = '';
  await check(
    'bridged sms thread for the same tenant coexists with their email thread (201)',
    async () => {
      const r = await createThread({
        kind: 'bridged_tenant',
        channel: 'sms',
        participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: T1_PHONE }],
      });
      const t = assertStatus(r, 201, 'sms thread create') as ThreadDetailShape;
      smsThreadId = t.id;
      assert(t.channel === 'sms', `channel: ${t.channel}`);
      assert(t.mode === 'bridged', `mode: ${t.mode}`);
      assert(t.id !== thread1Id, 'distinct from the email thread');
    },
  );

  await check('no-cc sms inbound from the tenant phone routes to the sms thread', async () => {
    const r = await capture({
      provider: 'test',
      provider_msg_id: `IN-sms-${rnd()}`,
      to_number: PLATFORM_A,
      from_address: T1_PHONE,
      channel: 'sms',
      body: 'sms reply',
      received_at: iso(),
    });
    const res = assertStatus(r, 200, 'sms inbound') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === smsThreadId, `routed to sms thread: ${res.thread_id}`);
    assert(res.thread_id !== thread1Id, 'not the email thread');
  });

  await check(
    'the email reply token still routes to the email thread (channels do not cross)',
    async () => {
      const r = await capture({
        provider: 'resend',
        provider_msg_id: `IN-em2-${rnd()}`,
        to_number: tenant1Token,
        from_address: T1_EMAIL,
        channel: 'email',
        body: 'still email',
        received_at: iso(),
      });
      const res = assertStatus(r, 200, 'email inbound after sms thread') as CaptureShape;
      assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
      assert(res.thread_id === thread1Id, `routed to email thread: ${res.thread_id}`);
    },
  );

  // =========================================================================
  // (12) Email opt-out enforcement (a THIRD email thread, tenant2)
  // =========================================================================
  let thread3Id = '';
  let tenant2Token = '';
  await check(
    'setup: a third email thread for tenant2 + register an email opt-out for their address',
    async () => {
      const r = await createThread({
        kind: 'bridged_tenant',
        channel: 'email',
        subject: 'Opt-out thread',
        tenancy_id: fx.tenancyId,
        participants: [llPart, { party_type: 'tenant', party_id: fx.tenant2Id, address: T2_EMAIL }],
      });
      const t = assertStatus(r, 201, 'thread3 create') as ThreadDetailShape;
      thread3Id = t.id;
      const t2p = t.participants.find(
        (p) => p.party_type === 'tenant' && p.party_id === fx.tenant2Id,
      );
      assert(t2p !== undefined, 'tenant2 participant present');
      const t2b = t.bindings.find((b) => b.participant_id === t2p!.id);
      assert(t2b !== undefined && t2b.reply_address !== null, 'tenant2 reply token present');
      tenant2Token = t2b!.reply_address!;

      const oo = await api('POST', `${base}/opt-outs`, {
        token: fx.agentToken,
        body: { channel: 'email', address: T2_EMAIL, keyword: 'unsubscribe', source_ref: 'm-1' },
      });
      assertStatus(oo, 200, 'register opt-out');
    },
  );

  await check('landlord thread message to the opted-out tenant2 → 422 opted_out', async () => {
    const r = await api('POST', `${base}/threads/${thread3Id}/messages`, {
      token: fx.landlordToken,
      body: { body: 'should be refused' },
    });
    assertStatus(r, 422, 'message to opted-out address');
    if (errCode(r) !== 'opted_out') throw new Error(`code: ${errCode(r)}`);
  });

  await check(
    'inbound from the opted-out tenant2 to their token → opted_out, still journaled (evidence)',
    async () => {
      const r = await capture({
        provider: 'resend',
        provider_msg_id: `IN-oo-${rnd()}`,
        to_number: tenant2Token,
        from_address: T2_EMAIL,
        channel: 'email',
        body: 'reply after opting out',
        received_at: iso(),
      });
      const res = assertStatus(r, 200, 'opted-out inbound') as CaptureShape;
      assert(res.disposition === 'opted_out', `disposition: ${res.disposition}`);
      assert(res.thread_id === thread3Id, `routed to thread3: ${res.thread_id}`);
      assert(res.interaction_id !== null, 'still journaled (the contact is evidence)');
    },
  );

  // =========================================================================
  // (13) E2-A2: transport token-resolve read + threads channel filter
  // =========================================================================
  await check(
    'resolve-reply-address: agent resolves an active token (case-normalized) → ids',
    async () => {
      const r = await api(
        'GET',
        `/v1/comms/resolve-reply-address?address=${encodeURIComponent(tenant1Token.toUpperCase())}`,
        { token: fx.agentToken },
      );
      const res = assertStatus(r, 200, 'resolve') as {
        account_id: string;
        thread_id: string;
        participant_id: string;
      };
      assert(res.account_id === fx.accountId, `account: ${res.account_id}`);
      assert(res.thread_id === thread1Id, `thread: ${res.thread_id}`);
      assert(res.participant_id === tenant1ParticipantId, `participant: ${res.participant_id}`);
    },
  );

  await check('resolve-reply-address: landlord (member, not agent) → 404 (uniform)', async () => {
    const r = await api(
      'GET',
      `/v1/comms/resolve-reply-address?address=${encodeURIComponent(tenant1Token)}`,
      { token: fx.landlordToken },
    );
    assertStatus(r, 404, 'landlord probe');
  });

  await check(
    "resolve-reply-address: an agent of ANOTHER account only → 404 for A's token",
    async () => {
      // A fresh transport identity serving ONLY account B: RLS never shows it
      // account A's binding, so the foreign token is indistinguishable from an
      // unknown one.
      const foreignAgent = await createAuthUser('foreign-agent');
      const { error } = await admin.from('account_members').insert({
        account_id: fxB.accountId,
        user_id: foreignAgent.id,
        role: 'agent',
      });
      if (error) throw new Error(`foreign agent membership: ${error.message}`);
      const foreignToken = await login(foreignAgent.email, foreignAgent.password);
      const r = await api(
        'GET',
        `/v1/comms/resolve-reply-address?address=${encodeURIComponent(tenant1Token)}`,
        { token: foreignToken },
      );
      assertStatus(r, 404, 'foreign transport');
    },
  );

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
    const em = await api('GET', `${base}/threads?channel=email&limit=100`, {
      token: fx.landlordToken,
    });
    const emRows = (
      assertStatus(em, 200, 'email list') as { data: { id: string; channel: string }[] }
    ).data;
    assert(
      emRows.every((t) => t.channel === 'email'),
      'only email threads',
    );
    assert(
      emRows.some((t) => t.id === thread1Id),
      'email thread present',
    );
    assert(!emRows.some((t) => t.id === smsThreadId), 'sms thread absent');

    const sms = await api('GET', `${base}/threads?channel=sms&limit=100`, {
      token: fx.landlordToken,
    });
    const smsRows = (
      assertStatus(sms, 200, 'sms list') as { data: { id: string; channel: string }[] }
    ).data;
    assert(
      smsRows.every((t) => t.channel === 'sms'),
      'only sms threads',
    );
    assert(
      smsRows.some((t) => t.id === smsThreadId),
      'sms thread present',
    );
  });

  // =========================================================================
  // (14) Per-account branding — subdomain-scoped reply tokens + display name.
  // A fresh account sets a branded subdomain via the owner endpoint; its email
  // threads then mint reply tokens under `<sub>.<parent>` and carry the account
  // sender_display_name. thread1 (account fx, no subdomain) is the control: it
  // stays on EMAIL_REPLY_DOMAIN with the SIGNUP-DEFAULT display name (the
  // account name — 20260707000001 stamps it at creation; never null anymore).
  // =========================================================================
  await check(
    'account WITHOUT a subdomain mints under EMAIL_REPLY_DOMAIN, display name = signup default',
    async () => {
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
      assert(
        d.sender_display_name === 'Comms Email Threads Acct',
        `unbranded account carries the signup-default display name: ${d.sender_display_name}`,
      );
    },
  );

  await check(
    'account WITH an email_subdomain mints reply tokens under <sub>.<parent> + carries the display name',
    async () => {
      const fxC = await setup(PLATFORM_C, 'c');
      const sub = `brand${SUFFIX}`;
      const branded = `${sub}.brand-${SUFFIX}.test`;
      const BRAND_RE = new RegExp(`^t-[0-9a-f]{32}@${sub}\\.brand-${SUFFIX}\\.test$`);

      // Set branding via the owner (landlord) endpoint — exercises the PATCH path.
      const patch = await api('PATCH', `/v1/accounts/${fxC.accountId}/email-branding`, {
        token: fxC.landlordToken,
        body: { email_subdomain: sub, sender_display_name: 'Brand Co' },
      });
      const pb = assertStatus(patch, 200, 'set branding') as {
        email_subdomain: string;
        reply_domain: string;
      };
      assert(pb.email_subdomain === sub, `patched subdomain: ${pb.email_subdomain}`);
      assert(pb.reply_domain === branded, `patched reply_domain: ${pb.reply_domain}`);

      const r = await api('POST', `/v1/accounts/${fxC.accountId}/comms/threads`, {
        token: fxC.landlordToken,
        body: {
          kind: 'bridged_tenant',
          channel: 'email',
          subject: 'Branded lease notice',
          participants: [
            {
              party_type: 'landlord_user',
              party_id: fxC.landlordId,
              address: `llc-${SUFFIX}@e2.test`,
            },
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
      assert(
        t.sender_display_name === 'Brand Co',
        `sender_display_name on create: ${t.sender_display_name}`,
      );

      // getThread carries the account display name too (transport reads it there).
      const g = await api('GET', `/v1/accounts/${fxC.accountId}/comms/threads/${t.id}?limit=10`, {
        token: fxC.landlordToken,
      });
      const gd = assertStatus(g, 200, 'branded thread detail') as ThreadDetailShape;
      assert(
        gd.sender_display_name === 'Brand Co',
        `sender_display_name on read: ${gd.sender_display_name}`,
      );
    },
  );

  // =========================================================================
  // (15) Mismatch hygiene (persona plan, phase 5): the unresolved-sender
  // queue + rebind. Runs LAST — rebinding tenant1's leg to the stranger
  // changes capture semantics for every later T1_EMAIL send.
  // =========================================================================
  await check('interactions ?party_type=unspecified lists the sender_mismatch rows', async () => {
    const r = await api(
      'GET',
      `/v1/accounts/${fx.accountId}/interactions?party_type=unspecified&limit=100`,
      { token: fx.landlordToken },
    );
    const rows = (
      assertStatus(r, 200, 'unspecified list') as {
        data: { party_type: string; party_label: string | null }[];
      }
    ).data;
    assert(rows.length > 0, 'at least the mismatch row');
    assert(
      rows.every((x) => x.party_type === 'unspecified'),
      'filter holds',
    );
    assert(
      rows.some((x) => x.party_label === STRANGER),
      'the stranger mismatch is in the queue',
    );
  });

  await check(
    'rebind the tenant leg to the new address → future replies verify; identity learned',
    async () => {
      const d = await threadDetail(thread1Id);
      const tenantBinding = d.bindings.find(
        (b) => b.channel === 'email' && b.participant_address === T1_EMAIL.toLowerCase(),
      );
      assert(tenantBinding, 'tenant binding present');

      const r = await api(
        'POST',
        `${base}/threads/${thread1Id}/bindings/${tenantBinding!.id}/rebind`,
        { token: fx.landlordToken, body: { address: STRANGER.toUpperCase() } },
      );
      const updated = assertStatus(r, 200, 'rebind') as {
        participant_address: string;
        reply_address: string | null;
      };
      assert(
        updated.participant_address === STRANGER,
        `rebound address: ${updated.participant_address}`,
      );
      assert(updated.reply_address === tenantBinding!.reply_address, 'reply token untouched');

      // The formerly-mismatching sender now verifies on the same token.
      const cap = await capture({
        provider: 'resend',
        provider_msg_id: `IN-rebind-${rnd()}`,
        to_number: tenant1Token,
        from_address: STRANGER,
        channel: 'email',
        body: 'me again, new address',
        received_at: iso(),
      });
      const res = assertStatus(cap, 200, 'post-rebind capture') as CaptureShape;
      assert(res.disposition === 'matched', `post-rebind disposition: ${res.disposition}`);
      assert(res.participant?.id === tenant1ParticipantId, 'attributed to the tenant participant');

      // Learned as a THREAD-scoped thread_rebind claim (PR 2: rebind no
      // longer writes an account-wide first-writer-wins row).
      const { data: ident } = await admin
        .from('channel_identities')
        .select('party_id, party_type')
        .eq('account_id', fx.accountId)
        .eq('channel', 'email')
        .eq('address', STRANGER)
        .maybeSingle();
      assert(
        ident?.party_type === 'tenant' && ident.party_id === fx.tenant1Id,
        `identity learned: ${JSON.stringify(ident)}`,
      );
    },
  );

  await check('rebind guards: sms binding → 400; agent principal → 403', async () => {
    const sms = await threadDetail(smsThreadId);
    const smsBinding = sms.bindings.find((b) => b.channel === 'sms');
    assert(smsBinding, 'sms binding present');
    const bad = await api(
      'POST',
      `${base}/threads/${smsThreadId}/bindings/${smsBinding!.id}/rebind`,
      { token: fx.landlordToken, body: { address: 'x@y.test' } },
    );
    assertStatus(bad, 400, 'sms rebind');

    const d = await threadDetail(thread1Id);
    const anyBinding = d.bindings[0]!;
    const agent = await api(
      'POST',
      `${base}/threads/${thread1Id}/bindings/${anyBinding.id}/rebind`,
      { token: fx.agentToken, body: { address: 'x@y.test' } },
    );
    assertStatus(agent, 403, 'agent rebind');
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
