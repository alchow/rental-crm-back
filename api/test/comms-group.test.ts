// ----------------------------------------------------------------------------
// Comms native group-MMS integration tests (work item GM-A, core side).
//
// Exercises the /comms surface for provider-native group threads against a real
// Supabase stack, alongside — and without regressing — the bridged 1:1 mode:
//   * group thread create: mode='group', a binding for EVERY addressed member
//     (the landlord's own phone included), and the request-shape guards
//     (no landlord_user / duplicate address / agent participant / >7 members).
//   * the landlord verified-phone gate: the landlord leg must be the CALLER's
//     own OTP-verified number (unverified / mismatched / another user → 409).
//   * group-SET uniqueness on (platform number, member set): an identical set
//     in any participant order collides (409); a different set is a new thread.
//   * a group send is ONE outbox row (to_address null, the full sorted member
//     set frozen in group_addresses, participant_id null, self-approved) and
//     journals exactly once on complete — idempotent across a provider_sid
//     replay; the thread's tenancy_id rides onto the journal row.
//   * direct POST /comms/outbox into a group thread (no to_address /
//     participant_ref / relay).
//   * inbound cc[] participant-SET capture: matched / order-insensitive /
//     idempotent replay / orphan on a non-matching set / cross-account pinned.
//   * any-member STOP parks the queued group send and refuses new group sends
//     at 422, while a 1:1 send to a non-opted-out member still goes.
//   * bridged 1:1 coexistence: a member holds a bridged thread on the same
//     number as their group thread; a no-cc inbound routes to the bridged leg;
//     a second bridged thread for the same (number, member) still 409s (the
//     rebuilt bridged-only routing index).
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
process.env.PORT = '8796';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const admin = getAdminClient();

async function createAuthUser(
  label: string,
): Promise<{ id: string; email: string; password: string }> {
  const email = `commsgrp-${label}-${crypto.randomUUID()}@internal.test`;
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
const viewerAuth = await createAuthUser('viewer');

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

// Byte-order sort — mirrors _comm_group_routing_key's `order by x collate "C"`
// and the API layer's JS code-unit sort. group_addresses is returned sorted.
function sortedAddrs(...a: string[]): string[] {
  return [...a].sort();
}
function sameArray(a: unknown, b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function login(email: string, password: string): Promise<string> {
  const r = await api('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return (r.body as { session: { access_token: string } }).session.access_token;
}

// Direct PostgREST call with a member's real JWT — the threat model the DB
// triggers defend against (a member reaching past the API layer). Used for
// the group-shape and thread_mode-stamp backstops, mirroring comms.test.ts's
// F1/F5 forge checks.
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

// Randomized per run: platform numbers are globally unique and the opt-out
// register is global, so fixed values would make the suite single-shot against
// a persistent local stack. Distinct area-code bands keep every member address
// unique. Account A carries the group thread under test; account B exists only
// to prove the inbound set-match is account-pinned.
const SUFFIX = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');

const PLATFORM_A = `+1909${SUFFIX}`;
const LL_A = `+1505${SUFFIX}`; // the landlord's own phone — a group member
const M1_A = `+1606${SUFFIX}`; // tenant1
const M2_A = `+1707${SUFFIX}`; // tenant2
const M3_A = `+1210${SUFFIX}`; // tenant3 — only in the "different set" thread

const PLATFORM_B = `+1808${SUFFIX}`;
const LL_B = `+1240${SUFFIX}`; // account B's landlord — B never creates a group

interface Fixture {
  accountId: string;
  landlordToken: string;
  landlordId: string;
  agentToken: string;
  viewerToken: string;
  tenant1Id: string;
  tenant2Id: string;
  tenant3Id: string;
  tenancyId: string;
}

async function setup(platformNumber: string, tag: string, landlordPhone: string): Promise<Fixture> {
  const email = `commsgrp-landlord-${tag}-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: 'Comms Group Acct' },
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
    name: 'Unit 1',
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
  const tenant3 = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, {
    full_name: 'Tenant Three',
  });

  // Memberships: the agent transport (member of BOTH accounts) and a viewer.
  for (const [userId, role] of [
    [agentAuth.id, 'agent'],
    [viewerAuth.id, 'viewer'],
  ] as const) {
    const { error } = await admin.from('account_members').insert({
      account_id: accountId,
      user_id: userId,
      role,
    });
    if (error) throw new Error(`membership ${role}: ${error.message}`);
  }

  // Ops-tier provisioning (service role, like prod): this account's platform
  // number. Member addresses are supplied explicitly on every thread create.
  {
    const { error } = await admin.from('platform_numbers').insert({
      account_id: accountId,
      number: platformNumber,
      provider: 'test',
      capabilities: ['sms'],
    });
    if (error) throw new Error(`platform number: ${error.message}`);
  }

  // Group create requires the caller's phone to be OTP-verified: a group text
  // exposes the landlord's personal number to a tenant, so core refuses to
  // build one around an unproven number. Prod writes this through
  // set_owner_phone_verified behind the SMS OTP; the fixture stamps it
  // directly, which is the only part of that flow this suite is not about.
  {
    const { error } = await admin
      .from('users')
      .update({ phone: landlordPhone, phone_verified_at: new Date().toISOString() })
      .eq('id', b.user.id);
    if (error) throw new Error(`verify landlord phone: ${error.message}`);
  }

  return {
    accountId,
    landlordToken: token,
    landlordId: b.user.id,
    agentToken: await login(agentAuth.email, agentAuth.password),
    viewerToken: await login(viewerAuth.email, viewerAuth.password),
    tenant1Id: tenant1.id,
    tenant2Id: tenant2.id,
    tenant3Id: tenant3.id,
    tenancyId: tenancy.id,
  };
}

// --- shapes -----------------------------------------------------------------

interface OutboxShape {
  id: string;
  status: string;
  to_address: string | null;
  group_addresses: string[] | null;
  participant_id: string | null;
  approval_ref: string;
  thread_id: string | null;
  provider_sid: string | null;
  interaction_id: string | null;
  error_code: string | null;
}
interface ParticipantShape {
  id: string;
  party_type: string;
  party_id: string | null;
}
interface BindingShape {
  participant_address: string;
  active: boolean;
}
interface MessageShape {
  id: string;
  direction: string;
  delivery_status: string | null;
  outbox_id: string | null;
  thread_id: string | null;
  tenancy_id: string | null;
}
interface ThreadDetailShape {
  id: string;
  mode: string;
  status: string;
  participants: ParticipantShape[];
  bindings: BindingShape[];
  messages: MessageShape[];
}
interface CaptureShape {
  disposition: string;
  interaction_id: string | null;
  thread_id: string | null;
  participant: ParticipantShape | null;
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Comms group-MMS integration tests');
  const fx = await setup(PLATFORM_A, 'a', LL_A);
  const base = `/v1/accounts/${fx.accountId}/comms`;
  const L = (body: unknown, path: string, key?: string) =>
    api('POST', `${base}${path}`, { token: fx.landlordToken, body, idempotencyKey: key });
  const A = (body: unknown, path: string, key?: string) =>
    api('POST', `${base}${path}`, { token: fx.agentToken, body, idempotencyKey: key });

  // Newest-first thread detail; the outbound journal legs it currently carries.
  const threadOutbound = async (threadId: string): Promise<MessageShape[]> => {
    const r = await api('GET', `${base}/threads/${threadId}?limit=100`, {
      token: fx.landlordToken,
    });
    const t = assertStatus(r, 200, 'thread detail') as { messages: MessageShape[] };
    return t.messages.filter((m) => m.direction === 'outbound');
  };
  const threadMessages = async (threadId: string): Promise<MessageShape[]> => {
    const r = await api('GET', `${base}/threads/${threadId}?limit=100`, {
      token: fx.landlordToken,
    });
    return (assertStatus(r, 200, 'thread detail') as { messages: MessageShape[] }).messages;
  };

  const groupBody = (participants: unknown[]) => ({
    kind: 'bridged_tenant',
    channel: 'sms',
    mode: 'group',
    tenancy_id: fx.tenancyId,
    participants,
  });
  const llPart = { party_type: 'landlord_user', party_id: fx.landlordId, address: LL_A };
  const t1Part = { party_type: 'tenant', party_id: fx.tenant1Id, address: M1_A };
  const t2Part = { party_type: 'tenant', party_id: fx.tenant2Id, address: M2_A };
  const t3Part = { party_type: 'tenant', party_id: fx.tenant3Id, address: M3_A };

  // =========================================================================
  // Group thread create + request-shape guards
  // =========================================================================
  let groupThreadId = '';
  let t1ParticipantId = '';
  await check(
    'group thread create: mode=group, binding for every member (landlord included)',
    async () => {
      const r = await L(groupBody([llPart, t1Part, t2Part]), '/threads');
      const t = assertStatus(r, 201, 'group create') as ThreadDetailShape;
      groupThreadId = t.id;
      assert(t.mode === 'group', `mode: ${t.mode}`);
      assert(t.status === 'active', `status: ${t.status}`);
      assert(t.participants.length === 3, `participants: ${t.participants.length}`);
      assert(t.bindings.length === 3, `bindings (landlord included): ${t.bindings.length}`);
      assert(
        sameArray(
          t.bindings.map((x) => x.participant_address).sort(),
          sortedAddrs(LL_A, M1_A, M2_A),
        ),
        `bound addresses: ${JSON.stringify(t.bindings.map((x) => x.participant_address))}`,
      );
      const t1 = t.participants.find((p) => p.party_id === fx.tenant1Id);
      assert(t1 !== undefined, 'tenant1 participant present');
      t1ParticipantId = t1!.id;
    },
  );

  await check('group create rejects: no landlord_user → 400', async () => {
    const r = await L(groupBody([t1Part, t2Part]), '/threads');
    assertStatus(r, 400, 'no landlord_user');
  });

  await check('group create rejects: duplicate member address → 400', async () => {
    const r = await L(
      groupBody([
        llPart,
        { party_type: 'tenant', party_id: fx.tenant1Id, address: LL_A }, // dup of landlord addr
        t2Part,
      ]),
      '/threads',
    );
    assertStatus(r, 400, 'duplicate address');
  });

  await check('group create rejects: agent participant → 400', async () => {
    const r = await L(
      groupBody([
        llPart,
        t1Part,
        { party_type: 'agent', party_id: crypto.randomUUID(), address: `+1240${SUFFIX}` },
      ]),
      '/threads',
    );
    assertStatus(r, 400, 'agent participant');
  });

  await check('group create rejects: >7 member addresses → 400', async () => {
    // 1 landlord + 7 tenants = 8 addressed members (over the 7-human cap).
    const bands = ['505', '606', '707', '210', '240', '260', '272', '281'];
    const tooMany = [
      { party_type: 'landlord_user', party_id: fx.landlordId, address: `+1${bands[0]}${SUFFIX}` },
      ...bands.slice(1).map((b) => ({
        party_type: 'tenant',
        party_id: crypto.randomUUID(),
        address: `+1${b}${SUFFIX}`,
      })),
    ];
    const r = await L(groupBody(tooMany), '/threads');
    assertStatus(r, 400, '>7 members');
  });

  // =========================================================================
  // Landlord verified-phone gate. A group text exposes the landlord's personal
  // number to a tenant and fans every reply out to it, so core refuses to build
  // one around a number nobody proved control of. This is enforced HERE (not in
  // the agent or the PWA) because the landlord holds a JWT and can POST this
  // route directly — core is the only chokepoint they cannot route around.
  // =========================================================================
  await check('group create rejects: landlord phone not verified → 409', async () => {
    const { error } = await admin
      .from('users')
      .update({ phone_verified_at: null })
      .eq('id', fx.landlordId);
    assert(!error, `unverify: ${error?.message}`);
    try {
      const r = await L(groupBody([llPart, t1Part, t3Part]), '/threads');
      assertStatus(r, 409, 'unverified landlord');
      assert(errCode(r) === 'conflict', `code: ${errCode(r)}`);
    } finally {
      await admin
        .from('users')
        .update({ phone_verified_at: new Date().toISOString() })
        .eq('id', fx.landlordId);
    }
  });

  await check('group create rejects: landlord address ≠ the verified phone → 409', async () => {
    // A mistyped landlord number is the failure this catches: the thread would
    // otherwise deliver the tenant's replies to whoever owns that phone.
    const wrong = {
      party_type: 'landlord_user',
      party_id: fx.landlordId,
      address: `+1231${SUFFIX}`,
    };
    const r = await L(groupBody([wrong, t1Part, t3Part]), '/threads');
    assertStatus(r, 409, 'mismatched landlord address');
  });

  await check('group create rejects: landlord participant is a different user → 409', async () => {
    // Enrolling a colleague's personal phone into a tenant-facing thread they
    // did not start is not something one member may do to another.
    const other = { party_type: 'landlord_user', party_id: viewerAuth.id, address: LL_A };
    const r = await L(groupBody([other, t1Part, t3Part]), '/threads');
    assertStatus(r, 409, 'landlord participant is not the caller');
  });

  // =========================================================================
  // Group-set uniqueness (order-insensitive)
  // =========================================================================
  await check('group-set uniqueness: identical member set in any order → 409', async () => {
    // Same {LL, M1, M2} set, reordered participants → same routing key → 409.
    const r = await L(groupBody([t2Part, llPart, t1Part]), '/threads');
    assertStatus(r, 409, 'duplicate group set');
  });

  await check('group-set uniqueness: a different member set → 201', async () => {
    const r = await L(groupBody([llPart, t1Part, t2Part, t3Part]), '/threads');
    const t = assertStatus(r, 201, 'different group set') as ThreadDetailShape;
    assert(t.mode === 'group', `mode: ${t.mode}`);
    assert(t.id !== groupThreadId, 'a distinct thread');
    assert(t.bindings.length === 4, `bindings: ${t.bindings.length}`);
  });

  // =========================================================================
  // Group send: ONE outbox row -> claim -> complete (journal exactly once)
  // =========================================================================
  let msgOutboxId = '';
  await check(
    'group thread message → exactly one outbox row (frozen sorted set, self-approved)',
    async () => {
      const r = await L(
        { body: 'Group ping — everyone here?' },
        `/threads/${groupThreadId}/messages`,
      );
      const out = assertStatus(r, 201, 'group message') as { data: OutboxShape[] };
      assert(out.data.length === 1, `intents: ${out.data.length}`);
      const row = out.data[0]!;
      msgOutboxId = row.id;
      assert(row.status === 'queued', `status: ${row.status}`);
      assert(
        row.to_address === null,
        `to_address must be null for a group send: ${row.to_address}`,
      );
      assert(row.participant_id === null, `participant_id must be null: ${row.participant_id}`);
      assert(
        sameArray(row.group_addresses, sortedAddrs(LL_A, M1_A, M2_A)),
        `group_addresses: ${JSON.stringify(row.group_addresses)}`,
      );
      assert(row.approval_ref === `self:${fx.landlordId}`, `approval_ref: ${row.approval_ref}`);
    },
  );

  const GRP_SID = `grp-${rnd()}`;
  let groupInteractionId = '';
  await check(
    'group send: claim → sending, complete → sent + exactly one outbound journal row',
    async () => {
      const claim = await A(
        { status: 'sending', provider_ts: new Date().toISOString() },
        `/outbox/${msgOutboxId}/delivery`,
      );
      assert(
        (assertStatus(claim, 200, 'claim') as { status: string }).status === 'sending',
        'claimed',
      );

      const done = await A(
        { provider: 'test', provider_sid: GRP_SID },
        `/outbox/${msgOutboxId}/complete`,
      );
      const body = assertStatus(done, 200, 'complete') as {
        interaction_id: string;
        outbox: OutboxShape;
      };
      groupInteractionId = body.interaction_id;
      assert(body.outbox.status === 'sent', `outbox status: ${body.outbox.status}`);
      assert(body.outbox.provider_sid === GRP_SID, 'provider_sid stored');
      assert(body.outbox.interaction_id === groupInteractionId, 'journal linked');
      assert(body.outbox.to_address === null, 'still a group row');
      assert(
        sameArray(body.outbox.group_addresses, sortedAddrs(LL_A, M1_A, M2_A)),
        'set survived completion',
      );

      const outbound = await threadOutbound(groupThreadId);
      assert(outbound.length === 1, `outbound rows in thread: ${outbound.length}`);
      const m = outbound[0]!;
      assert(m.id === groupInteractionId, 'the completed send is the journal row');
      assert(m.delivery_status === 'sent', `delivery_status: ${m.delivery_status}`);
      assert(m.outbox_id === msgOutboxId, 'outbox_id linked on the message');
      assert(m.thread_id === groupThreadId, 'thread linked');

      // Thread context (tenancy_id) copied onto the journal row.
      const g = await api(
        'GET',
        `/v1/accounts/${fx.accountId}/interactions/${groupInteractionId}`,
        {
          token: fx.landlordToken,
        },
      );
      const j = assertStatus(g, 200, 'journal row') as {
        tenancy_id: string | null;
        party_type: string;
        party_id: string | null;
      };
      assert(j.tenancy_id === fx.tenancyId, `journal tenancy_id: ${j.tenancy_id}`);
      // TWO tenant counterparties on this thread → no single honest "with";
      // attribution stays the unspecified sentinel (20260723000009 attributes
      // only the exactly-one-counterparty shape).
      assert(j.party_type === 'unspecified', `multi-counterparty party_type: ${j.party_type}`);
      assert(j.party_id === null, `multi-counterparty party_id: ${j.party_id}`);
    },
  );

  await check(
    'complete replay (same provider_sid) → same interaction_id, still one outbound row',
    async () => {
      const r = await A(
        { provider: 'test', provider_sid: GRP_SID },
        `/outbox/${msgOutboxId}/complete`,
      );
      const body = assertStatus(r, 200, 'replay') as { interaction_id: string };
      assert(body.interaction_id === groupInteractionId, 'same interaction id');
      const outbound = await threadOutbound(groupThreadId);
      assert(outbound.length === 1, `outbound rows after replay: ${outbound.length}`);
    },
  );

  // =========================================================================
  // Single-counterparty attribution (20260723000009): landlord + ONE tenant
  // — the move-in group-text shape — journals "with" the tenant, not the
  // needs-attribution 'unspecified' sentinel.
  // =========================================================================
  await check(
    'exact-2 group send journals party_type=tenant with the tenant party_id',
    async () => {
      const created = await L(groupBody([llPart, t3Part]), '/threads');
      const thread = assertStatus(created, 201, 'exact-2 group create') as ThreadDetailShape;
      const sent = await L({ body: 'Move-in link, just us two' }, `/threads/${thread.id}/messages`);
      const row = (assertStatus(sent, 201, 'exact-2 message') as { data: OutboxShape[] }).data[0]!;
      const done = await A(
        { provider: 'test', provider_sid: `grp2-${rnd()}` },
        `/outbox/${row.id}/complete`,
      );
      const body = assertStatus(done, 200, 'exact-2 complete') as { interaction_id: string };
      const g = await api(
        'GET',
        `/v1/accounts/${fx.accountId}/interactions/${body.interaction_id}`,
        {
          token: fx.landlordToken,
        },
      );
      const j = assertStatus(g, 200, 'exact-2 journal row') as {
        party_type: string;
        party_id: string | null;
        vendor_id: string | null;
      };
      assert(j.party_type === 'tenant', `party_type: ${j.party_type}`);
      assert(j.party_id === fx.tenant3Id, `party_id: ${j.party_id}`);
      assert(j.vendor_id === null, `vendor_id must stay null for a tenant: ${j.vendor_id}`);
    },
  );

  // =========================================================================
  // Direct POST /comms/outbox into a group thread
  // =========================================================================
  await check(
    'direct outbox with a group thread_id (no to_address/participant_ref) → 201 group row',
    async () => {
      const r = await L(
        {
          channel: 'sms',
          thread_id: groupThreadId,
          body: 'direct group note',
          approval_ref: `self:${fx.landlordId}`,
        },
        '/outbox',
      );
      const row = assertStatus(r, 201, 'direct group intent') as OutboxShape;
      assert(row.to_address === null, `to_address: ${row.to_address}`);
      assert(row.participant_id === null, `participant_id: ${row.participant_id}`);
      assert(row.thread_id === groupThreadId, 'thread linked');
      assert(
        sameArray(row.group_addresses, sortedAddrs(LL_A, M1_A, M2_A)),
        `group_addresses: ${JSON.stringify(row.group_addresses)}`,
      );
      assert(row.approval_ref === `self:${fx.landlordId}`, `approval_ref: ${row.approval_ref}`);
    },
  );

  await check(
    'direct group outbox rejects to_address / participant_ref / relay_of_interaction_id → 400',
    async () => {
      const withTo = await L(
        {
          channel: 'sms',
          thread_id: groupThreadId,
          to_address: M1_A,
          body: 'x',
          approval_ref: `self:${fx.landlordId}`,
        },
        '/outbox',
      );
      assertStatus(withTo, 400, 'group + to_address');
      const withPart = await L(
        {
          channel: 'sms',
          thread_id: groupThreadId,
          participant_ref: t1ParticipantId,
          body: 'x',
          approval_ref: `self:${fx.landlordId}`,
        },
        '/outbox',
      );
      assertStatus(withPart, 400, 'group + participant_ref');
      const withRelay = await L(
        {
          channel: 'sms',
          thread_id: groupThreadId,
          relay_of_interaction_id: groupInteractionId,
          body: 'x',
          approval_ref: `self:${fx.landlordId}`,
        },
        '/outbox',
      );
      assertStatus(withRelay, 400, 'group + relay');
    },
  );

  // =========================================================================
  // Inbound cc[] participant-SET capture
  // =========================================================================
  const MATCH_MSGID = `IN-grp-${rnd()}`;
  await check(
    'inbound cc set-match → matched to the group thread, sender participant, journaled',
    async () => {
      const r = await A(
        {
          provider: 'test',
          provider_msg_id: MATCH_MSGID,
          to_number: PLATFORM_A,
          from_address: M1_A,
          cc: [M2_A, LL_A],
          channel: 'sms',
          body: 'reply-all from tenant1',
          received_at: new Date().toISOString(),
        },
        '/inbound',
      );
      const res = assertStatus(r, 200, 'group inbound') as CaptureShape;
      assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
      assert(res.thread_id === groupThreadId, 'routed to the group thread');
      assert(res.participant?.id === t1ParticipantId, `sender participant: ${res.participant?.id}`);
      assert(res.interaction_id !== null, 'journaled');
      const inbound = (await threadMessages(groupThreadId)).find(
        (m) => m.id === res.interaction_id,
      );
      assert(
        inbound !== undefined && inbound.direction === 'inbound',
        'inbound row present in thread',
      );
    },
  );

  await check(
    'inbound cc in a different order → still matched (set match is order-insensitive)',
    async () => {
      const r = await A(
        {
          provider: 'test',
          provider_msg_id: `IN-grp-${rnd()}`,
          to_number: PLATFORM_A,
          from_address: M1_A,
          cc: [LL_A, M2_A],
          channel: 'sms',
          body: 'again, cc reordered',
          received_at: new Date().toISOString(),
        },
        '/inbound',
      );
      const res = assertStatus(r, 200, 'reordered cc') as CaptureShape;
      assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
      assert(res.thread_id === groupThreadId, 'still the group thread');
    },
  );

  await check('inbound cc replay (same provider_msg_id) → idempotent, same result', async () => {
    const r = await A(
      {
        provider: 'test',
        provider_msg_id: MATCH_MSGID,
        to_number: PLATFORM_A,
        from_address: M1_A,
        cc: [M2_A, LL_A],
        channel: 'sms',
        body: 'reply-all from tenant1',
        received_at: new Date().toISOString(),
      },
      '/inbound',
    );
    const res = assertStatus(r, 200, 'replay') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === groupThreadId, 'same thread');
    // No second inbound row for a replayed provider_msg_id.
    const { data } = await admin
      .from('interactions')
      .select('id')
      .eq('account_id', fx.accountId)
      .eq('external_ref', MATCH_MSGID);
    assert((data ?? []).length === 1, `journal rows for msg id: ${(data ?? []).length}`);
  });

  await check('inbound cc set matching no thread → orphan, nothing journaled', async () => {
    // Drop the landlord from the set: {M1, M2} matches no active group thread.
    const r = await A(
      {
        provider: 'test',
        provider_msg_id: `IN-grp-${rnd()}`,
        to_number: PLATFORM_A,
        from_address: M1_A,
        cc: [M2_A],
        channel: 'sms',
        body: 'partial set',
        received_at: new Date().toISOString(),
      },
      '/inbound',
    );
    const res = assertStatus(r, 200, 'orphan set') as CaptureShape;
    assert(res.disposition === 'orphan', `disposition: ${res.disposition}`);
    assert(res.interaction_id === null, 'nothing journaled');
    assert(res.thread_id === null, 'no thread');
  });

  // =========================================================================
  // Cross-account: the set match is account-pinned
  // =========================================================================
  const fxB = await setup(PLATFORM_B, 'b', LL_B);
  await check(
    "cross-account: A's set + A's number captured on account B → orphan (pinned)",
    async () => {
      // The same agent transports both accounts; A's exact group set on A's
      // number, but captured under B, must not leak A's thread.
      const r = await api('POST', `/v1/accounts/${fxB.accountId}/comms/inbound`, {
        token: fx.agentToken,
        body: {
          provider: 'test',
          provider_msg_id: `IN-xacct-${rnd()}`,
          to_number: PLATFORM_A,
          from_address: M1_A,
          cc: [M2_A, LL_A],
          channel: 'sms',
          body: 'wrong account',
          received_at: new Date().toISOString(),
        },
      });
      const res = assertStatus(r, 200, 'cross-account capture') as CaptureShape;
      assert(res.disposition === 'orphan', `disposition: ${res.disposition}`);
      assert(res.interaction_id === null, 'nothing leaked or journaled');
    },
  );

  // =========================================================================
  // Any-member STOP compliance
  // =========================================================================
  await check(
    'any-member STOP parks the queued group send and refuses new group sends (422)',
    async () => {
      // Queue a fresh group send (do NOT complete it).
      const queued = await L({ body: 'pre-STOP group ping' }, `/threads/${groupThreadId}/messages`);
      const qId = (assertStatus(queued, 201, 'queued group send') as { data: OutboxShape[] })
        .data[0]!.id;

      // A co-member (tenant2) opts out — the group MMS reaches everyone, so the
      // whole send is non-compliant.
      const oo = await A(
        {
          channel: 'sms',
          address: M2_A,
          keyword: 'STOP',
          source_ref: `m-${rnd()}`,
        },
        '/opt-outs',
      );
      assertStatus(oo, 200, 'record opt-out');

      // The queued group row is parked (read back with the agent/transport token).
      const back = await api('GET', `${base}/outbox/${qId}`, { token: fx.agentToken });
      const row = assertStatus(back, 200, 'parked row') as OutboxShape;
      assert(row.status === 'undeliverable', `status: ${row.status}`);
      assert(row.error_code === 'opted_out', `error_code: ${row.error_code}`);

      // A new group send attempt is refused at the boundary.
      const blocked = await L(
        { body: 'post-STOP group ping' },
        `/threads/${groupThreadId}/messages`,
      );
      assertStatus(blocked, 422, 'post-STOP group send');
      if (errCode(blocked) !== 'opted_out') throw new Error(`code: ${errCode(blocked)}`);
    },
  );

  await check(
    '1:1 direct send to a non-opted-out member still 201 after a co-member STOP',
    async () => {
      const r = await L(
        {
          channel: 'sms',
          to_address: M1_A,
          body: 'direct to tenant1',
          approval_ref: `self:${fx.landlordId}`,
        },
        '/outbox',
      );
      const row = assertStatus(r, 201, 'direct 1:1 send') as OutboxShape;
      assert(row.to_address === M1_A, `to_address: ${row.to_address}`);
      assert(row.group_addresses === null, 'a 1:1 row, not a group row');
    },
  );

  // =========================================================================
  // Bridged 1:1 coexistence + routing-invariant regression
  // =========================================================================
  let bridgedThreadId = '';
  await check(
    'bridged thread for a member coexists with the group thread on the same number (201)',
    async () => {
      const r = await L(
        {
          kind: 'bridged_tenant',
          channel: 'sms',
          participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: M1_A }],
        },
        '/threads',
      );
      const t = assertStatus(r, 201, 'bridged create') as ThreadDetailShape;
      bridgedThreadId = t.id;
      assert(t.mode === 'bridged', `mode: ${t.mode}`);
      assert(t.id !== groupThreadId, 'distinct from the group thread');
    },
  );

  await check('inbound without cc routes to the bridged thread, not the group', async () => {
    const r = await A(
      {
        provider: 'test',
        provider_msg_id: `IN-1to1-${rnd()}`,
        to_number: PLATFORM_A,
        from_address: M1_A,
        channel: 'sms',
        body: 'private 1:1 reply',
        received_at: new Date().toISOString(),
      },
      '/inbound',
    );
    const res = assertStatus(r, 200, 'no-cc inbound') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === bridgedThreadId, `routed to bridged, got: ${res.thread_id}`);
    assert(res.thread_id !== groupThreadId, 'not the group thread');
  });

  await check(
    'second bridged thread for the same (number, member) → 409 (routing-invariant regression)',
    async () => {
      const r = await L(
        {
          kind: 'bridged_tenant',
          channel: 'sms',
          participants: [{ party_type: 'tenant', party_id: fx.tenant1Id, address: M1_A }],
        },
        '/threads',
      );
      assertStatus(r, 409, 'second bridged binding');
    },
  );

  // =========================================================================
  // DB backstops: raw-PostgREST forges (the API never sends these shapes)
  // =========================================================================
  await check(
    'forge: raw PostgREST group row on a BRIDGED thread → rejected by the capacity trigger',
    async () => {
      const r = await pgrest('POST', 'comm_outbox', fx.landlordToken, {
        account_id: fx.accountId,
        channel: 'sms',
        to_address: null,
        group_addresses: [M1_A, M3_A],
        thread_id: bridgedThreadId,
        body: 'forged group row',
        approval_ref: `self:${fx.landlordId}`,
        approved_by: fx.landlordId,
        author_type: 'landlord',
      });
      assert(r.status >= 400, `forged group row accepted: ${r.status} ${JSON.stringify(r.body)}`);
    },
  );

  await check(
    'forge: raw PostgREST binding with thread_mode=bridged on the group thread is re-stamped group',
    async () => {
      // A forged 'bridged' tag would re-admit the binding to the 1:1 routing
      // index; the stamp trigger overwrites it from the thread row.
      const { data: parts } = await admin
        .from('comm_thread_participants')
        .select('id')
        .eq('thread_id', groupThreadId)
        .limit(1);
      const ins = await pgrest('POST', 'thread_channel_bindings', fx.landlordToken, {
        account_id: fx.accountId,
        thread_id: groupThreadId,
        participant_id: (parts ?? [])[0]!.id,
        platform_number: PLATFORM_A,
        participant_address: `+1260${SUFFIX}`,
        thread_mode: 'bridged',
      });
      assert(ins.status === 201, `binding insert: ${ins.status} ${JSON.stringify(ins.body)}`);
      const row = (ins.body as { id: string; thread_mode: string }[])[0]!;
      assert(row.thread_mode === 'group', `stamped mode: ${row.thread_mode}`);
      // Clean up so the extra address never perturbs later runs' set matching.
      await admin.from('thread_channel_bindings').delete().eq('id', row.id);
    },
  );

  // --- summary ---------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} comms group-MMS check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: comms group-MMS checks all green');
}

await main();
