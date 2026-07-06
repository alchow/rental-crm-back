// ----------------------------------------------------------------------------
// Persona inbound capture integration tests (persona plan, phase 3).
// Exercised against a real Supabase stack (GoTrue + PostgREST + RLS).
//
// POST /accounts/{id}/comms/inbound-persona routes by SENDER identity:
//   * a known tenant (tenants.emails fallback → channel_identities learned)
//     with DMARC pass → 'matched': a bridged email thread is created
//     atomically (tenant token minted under the branded domain; landlord
//     participant = the owner; no landlord binding without an email identity)
//     and the message journals with a full cast;
//   * a second capture from the same sender RESUMES the thread;
//   * a channel_identities exact hit routes without touching tenants.emails;
//   * DMARC fail (known or unknown sender) → 'triaged', nothing journaled,
//     no ack — unauthenticated mail is never attributed;
//   * unknown sender + DMARC pass → 'triaged' + exactly ONE
//     system:persona_ack outbox intent (per-sender daily cap holds on a
//     second capture);
//   * two-door dedupe, persona-first: the same Message-ID later arriving on
//     the tenant's minted token → 'duplicate' pointing at the persona row;
//   * an opted-out known sender still journals, disposition 'opted_out';
//   * provider_msg_id replay is idempotent.
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
process.env.PORT = '8803';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

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
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
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
function iso(): string { return new Date().toISOString(); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function createAuthUser(label: string): Promise<{ id: string; email: string; password: string }> {
  const email = `pcap-${label}-${crypto.randomUUID()}@internal.test`;
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

// --- fixture ------------------------------------------------------------------

const SUB = `pc${SUFFIX}`;
const PERSONA = `riley@${SUB}.${PARENT}`;
const REPLY_DOMAIN = `${SUB}.${PARENT}`;
const AUTH_PASS = { spf: 'pass', dkim: 'pass', dmarc: 'pass' } as const;
const AUTH_FAIL = { spf: 'fail', dkim: 'fail', dmarc: 'fail' } as const;

const T1_EMAIL = `maria-${SUFFIX}@tenant.test`;
const T2_EMAIL = `bob-${SUFFIX}@tenant.test`;
const OPTED_EMAIL = `optout-${SUFFIX}@tenant.test`;
const STRANGER = `stranger-${SUFFIX}@somewhere.test`;
const STRANGER2 = `stranger2-${SUFFIX}@somewhere.test`;

interface CaptureShape {
  disposition: string;
  interaction_id: string | null;
  thread_id: string | null;
  participant: { id: string; party_type: string; party_id: string | null } | null;
  unmatched_id: string | null;
}

async function main(): Promise<void> {
  console.info('Persona inbound capture integration tests');

  // Account + owner + branding (subdomain + persona).
  const ownerEmail = `pcap-owner-${rnd()}@example.test`;
  const ownerPassword = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email: ownerEmail, password: ownerPassword, account_name: 'Persona Capture Acct' },
  });
  if (su.status !== 200) throw new Error(`signup: ${su.status} ${JSON.stringify(su.body)}`);
  const sub = su.body as { account: { id: string }; user: { id: string }; session: { access_token: string } };
  const accountId = sub.account.id;
  const landlordToken = sub.session.access_token;
  const base = `/v1/accounts/${accountId}/comms`;

  {
    const r = await api('PATCH', `/v1/accounts/${accountId}/email-branding`, {
      token: landlordToken,
      body: { email_subdomain: SUB, persona_local_part: 'riley' },
    });
    if (r.status !== 200) throw new Error(`branding: ${r.status} ${JSON.stringify(r.body)}`);
  }

  // The agent transport.
  const agentAuth = await createAuthUser('agent');
  {
    const { error } = await admin.from('account_members').insert({
      account_id: accountId, user_id: agentAuth.id, role: 'agent',
    });
    if (error) throw new Error(`agent membership: ${error.message}`);
  }
  const agentToken = await login(agentAuth.email, agentAuth.password);

  // Tenants: t1/opted with an email in the contact book only (fallback path);
  // t2 gets a channel_identities row (exact path).
  async function createTenant(name: string, email: string): Promise<string> {
    const r = await api('POST', `/v1/accounts/${accountId}/tenants`, {
      token: landlordToken, body: { full_name: name, emails: [email] },
    });
    if (r.status !== 201) throw new Error(`tenant ${name}: ${r.status} ${JSON.stringify(r.body)}`);
    return (r.body as { id: string }).id;
  }
  const t1Id = await createTenant('Maria Former-Tenant', T1_EMAIL);
  const t2Id = await createTenant('Bob Exact-Hit', T2_EMAIL);
  const optedId = await createTenant('Opted Out', OPTED_EMAIL);
  void optedId;
  {
    const { error } = await admin.from('channel_identities').insert({
      account_id: accountId, party_type: 'tenant', party_id: t2Id,
      channel: 'email', address: T2_EMAIL,
    });
    if (error) throw new Error(`t2 identity: ${error.message}`);
  }

  const personaCapture = (body: Record<string, unknown>) =>
    api('POST', `${base}/inbound-persona`, {
      token: agentToken,
      body: {
        provider: 'ses', provider_msg_id: `PS-${rnd()}`, persona_address: PERSONA,
        to_addresses: [], cc_addresses: [], received_at: iso(), auth_results: AUTH_PASS,
        ...body,
      },
    });

  // =========================================================================
  // (1) Known sender via the contact-book fallback → matched, thread created
  // =========================================================================
  let t1ThreadId = '';
  let t1FirstIid = '';
  const T1_FIRST_MSG = `PS-first-${rnd()}`;
  await check('known tenant (tenants.emails) + DMARC pass → matched; thread created with minted token', async () => {
    const r = await personaCapture({
      provider_msg_id: T1_FIRST_MSG,
      from_address: T1_EMAIL.toUpperCase(), // handler lowercases
      from_display_name: 'Maria',
      subject: 'Deposit for unit 4B',
      body: 'about my deposit',
      rfc822_message_id: `<Cold-${SUFFIX}@sender>`,
    });
    const res = assertStatus(r, 200, 'cold capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id !== null && res.interaction_id !== null, 'journaled into a thread');
    t1ThreadId = res.thread_id!;
    t1FirstIid = res.interaction_id!;
    assert(res.participant?.party_type === 'tenant' && res.participant.party_id === t1Id,
      `sender participant is the tenant: ${JSON.stringify(res.participant)}`);

    // Thread shape via the landlord read: email, bridged, subject seeded,
    // tenant binding = minted token under the branded domain; landlord
    // participant (owner) present but UNBOUND (no email identity on file).
    const d = assertStatus(
      await api('GET', `${base}/threads/${t1ThreadId}`, { token: landlordToken }),
      200, 'thread detail',
    ) as {
      channel: string; mode: string; kind: string; subject: string | null;
      participants: { party_type: string; party_id: string | null }[];
      bindings: { participant_address: string; reply_address: string | null }[];
    };
    assert(d.channel === 'email' && d.mode === 'bridged' && d.kind === 'bridged_tenant',
      `thread shape: ${d.channel}/${d.mode}/${d.kind}`);
    assert(d.subject === 'Deposit for unit 4B', `subject seed: ${d.subject}`);
    assert(d.participants.some((p) => p.party_type === 'landlord_user'), 'owner participant present');
    assert(d.bindings.length === 1, `one binding (tenant only): ${d.bindings.length}`);
    const b = d.bindings[0]!;
    assert(b.participant_address === T1_EMAIL.toLowerCase(), `bound address: ${b.participant_address}`);
    assert(
      new RegExp(`^t-[0-9a-f]{32}@${REPLY_DOMAIN.replace(/\./g, '\\.')}$`).test(b.reply_address ?? ''),
      `minted token under the branded domain: ${b.reply_address}`,
    );

    // The learning step: the address is now in channel_identities.
    const { data: ident } = await admin
      .from('channel_identities')
      .select('party_id')
      .eq('account_id', accountId).eq('channel', 'email').eq('address', T1_EMAIL.toLowerCase())
      .maybeSingle();
    assert(ident?.party_id === t1Id, 'channel_identities learned the address');
  });

  await check('second capture from the same sender RESUMES the thread (no new thread)', async () => {
    const r = await personaCapture({ from_address: T1_EMAIL, body: 'follow-up' });
    const res = assertStatus(r, 200, 'resume capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === t1ThreadId, `same thread: ${res.thread_id}`);
    assert(res.interaction_id !== t1FirstIid, 'new journal row');
  });

  await check('replay of the first provider_msg_id → identical result (idempotent)', async () => {
    const r = await personaCapture({
      provider_msg_id: T1_FIRST_MSG, from_address: T1_EMAIL, body: 'about my deposit',
    });
    const res = assertStatus(r, 200, 'replay') as CaptureShape;
    assert(res.disposition === 'matched', `replay disposition: ${res.disposition}`);
    assert(res.interaction_id === t1FirstIid, 'replay returns the original interaction');
  });

  // =========================================================================
  // (2) channel_identities exact hit
  // =========================================================================
  await check('known tenant via channel_identities exact hit → matched', async () => {
    const r = await personaCapture({ from_address: T2_EMAIL, body: 'exact hit' });
    const res = assertStatus(r, 200, 'exact capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.participant?.party_id === t2Id, `t2 participant: ${res.participant?.party_id}`);
    assert(res.thread_id !== t1ThreadId, 'own thread, not t1s');
  });

  // =========================================================================
  // (3) DMARC gates attribution
  // =========================================================================
  await check('KNOWN sender with DMARC fail → triaged, nothing journaled, no ack', async () => {
    const r = await personaCapture({ from_address: T1_EMAIL, body: 'spoof?', auth_results: AUTH_FAIL });
    const res = assertStatus(r, 200, 'dmarc-fail capture') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    assert(res.interaction_id === null && res.thread_id === null, 'nothing journaled');
    await sleep(300);
    const { count } = await admin
      .from('comm_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId).eq('to_address', T1_EMAIL.toLowerCase())
      .eq('approval_ref', 'system:persona_ack');
    assert((count ?? 0) === 0, `no ack for auth-failed mail: ${count}`);
  });

  // =========================================================================
  // (4) Unknown sender: triage + ONE ack
  // =========================================================================
  await check('unknown sender + DMARC pass → triaged + exactly one system:persona_ack intent', async () => {
    const r = await personaCapture({ from_address: STRANGER, body: 'hello?' });
    const res = assertStatus(r, 200, 'stranger capture') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);

    // The ack is fire-and-forget; poll briefly.
    let rows: { subject: string | null; author_type: string }[] = [];
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      await sleep(150);
      const { data } = await admin
        .from('comm_outbox')
        .select('subject, author_type')
        .eq('account_id', accountId).eq('to_address', STRANGER)
        .eq('approval_ref', 'system:persona_ack');
      rows = (data ?? []) as typeof rows;
    }
    assert(rows.length === 1, `one ack intent: ${rows.length}`);
    assert(rows[0]!.author_type === 'system', `system-authored: ${rows[0]!.author_type}`);
    assert(rows[0]!.subject === 'We received your message', `subject: ${rows[0]!.subject}`);
  });

  await check('second capture from the same stranger → per-sender daily cap holds (still one ack)', async () => {
    const r = await personaCapture({ from_address: STRANGER, body: 'hello again?' });
    assertStatus(r, 200, 'stranger capture 2');
    await sleep(600);
    const { count } = await admin
      .from('comm_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId).eq('to_address', STRANGER)
      .eq('approval_ref', 'system:persona_ack');
    assert((count ?? 0) === 1, `ack count after cap: ${count}`);
  });

  await check('unknown sender with DMARC fail → triaged, no ack', async () => {
    const r = await personaCapture({ from_address: STRANGER2, body: '??', auth_results: AUTH_FAIL });
    const res = assertStatus(r, 200, 'stranger dmarc-fail') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    await sleep(400);
    const { count } = await admin
      .from('comm_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId).eq('to_address', STRANGER2)
      .eq('approval_ref', 'system:persona_ack');
    assert((count ?? 0) === 0, `no ack: ${count}`);
  });

  // =========================================================================
  // (5) Two-door dedupe, persona-first
  // =========================================================================
  await check('persona-first two-door: same Message-ID later via the minted token → duplicate', async () => {
    const rfcId = `TwoDoor-${SUFFIX}@sender`;
    const first = assertStatus(await personaCapture({
      from_address: T1_EMAIL, body: 'two door', rfc822_message_id: `<${rfcId}>`,
    }), 200, 'persona door') as CaptureShape;
    assert(first.disposition === 'matched', `persona door: ${first.disposition}`);

    // Fetch t1's minted token and deliver the same email through it.
    const d = assertStatus(
      await api('GET', `${base}/threads/${t1ThreadId}`, { token: landlordToken }),
      200, 'thread read',
    ) as { bindings: { participant_address: string; reply_address: string | null }[] };
    const token = d.bindings.find((b) => b.participant_address === T1_EMAIL.toLowerCase())?.reply_address;
    assert(token, 'tenant token present');

    const second = assertStatus(await api('POST', `${base}/inbound`, {
      token: agentToken,
      body: {
        provider: 'ses', provider_msg_id: `PS-door2-${rnd()}`, to_number: token,
        from_address: T1_EMAIL, channel: 'email', body: 'two door', received_at: iso(),
        rfc822_message_id: rfcId.toUpperCase(),
      },
    }), 200, 'token door') as CaptureShape;
    assert(second.disposition === 'duplicate', `token door: ${second.disposition}`);
    assert(second.interaction_id === first.interaction_id, 'points at the persona-journaled original');
  });

  // =========================================================================
  // (6) Opt-out parity
  // =========================================================================
  await check('opted-out known sender → journaled with disposition opted_out', async () => {
    const reg = await api('POST', `${base}/opt-outs`, {
      token: agentToken,
      body: { channel: 'email', address: OPTED_EMAIL, keyword: 'UNSUBSCRIBE', source_ref: `src-${rnd()}` },
    });
    assertStatus(reg, 200, 'opt-out record');
    const r = await personaCapture({ from_address: OPTED_EMAIL, body: 'i opted out but wrote anyway' });
    const res = assertStatus(r, 200, 'opted capture') as CaptureShape;
    assert(res.disposition === 'opted_out', `disposition: ${res.disposition}`);
    assert(res.interaction_id !== null, 'journaled (the contact happened)');
  });

  // =========================================================================
  // (7) CC capture — journal-only landlord mail (phase 4)
  // =========================================================================
  const LL_EMAIL = `dave-${SUFFIX}@landlord.test`;
  {
    // The landlord's email identity: the CC arm's sender-recognition input.
    const { error } = await admin.from('channel_identities').insert({
      account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
      channel: 'email', address: LL_EMAIL,
    });
    if (error) throw new Error(`landlord identity: ${error.message}`);
  }

  await check('landlord CCs the persona on mail To a threaded tenant → cc_journaled outbound into the thread', async () => {
    const r = await personaCapture({
      from_address: LL_EMAIL,
      to_addresses: [T1_EMAIL],
      body: 'direct from my gmail',
      subject: 'Re: Deposit for unit 4B',
      rfc822_message_id: `<CC-${SUFFIX}@gmail>`,
    });
    const res = assertStatus(r, 200, 'cc capture') as CaptureShape;
    assert(res.disposition === 'cc_journaled', `disposition: ${res.disposition}`);
    assert(res.thread_id === t1ThreadId, `into the existing thread: ${res.thread_id}`);
    assert(res.participant?.party_id === t1Id, `participant = the counterparty: ${res.participant?.party_id}`);

    const { data: row, error } = await admin
      .from('interactions')
      .select('direction, author_type, party_type, party_id, actor, attestation')
      .eq('id', res.interaction_id!)
      .single();
    if (error) throw new Error(`cc journal read: ${error.message}`);
    assert(row.direction === 'outbound', `direction: ${row.direction}`);
    assert(row.author_type === 'landlord', `author_type: ${row.author_type}`);
    assert(row.party_type === 'tenant' && row.party_id === t1Id,
      `party = counterparty: ${row.party_type}/${row.party_id}`);
    assert(row.actor === 'system:comm-persona-cc', `actor: ${row.actor}`);
    assert(row.attestation === 'provider_verified', `attestation: ${row.attestation}`);

    // Cast: sender = landlord (his real address), recipient = the tenant's
    // real address, cc = the persona as the platform leg.
    const { data: cast } = await admin
      .from('interaction_participants')
      .select('role, party_type, address')
      .eq('interaction_id', res.interaction_id!);
    const roles = (cast ?? []) as { role: string; party_type: string; address: string | null }[];
    assert(roles.some((c) => c.role === 'sender' && c.party_type === 'landlord_user' && c.address === LL_EMAIL),
      `sender cast: ${JSON.stringify(roles)}`);
    assert(roles.some((c) => c.role === 'recipient' && c.party_type === 'tenant' && c.address === T1_EMAIL.toLowerCase()),
      `recipient cast: ${JSON.stringify(roles)}`);
    assert(roles.some((c) => c.role === 'cc' && c.party_type === 'platform' && c.address === PERSONA),
      `persona cc cast: ${JSON.stringify(roles)}`);
  });

  await check('reply-all two-door: the tenant reply-alls (token To + persona CC) → one journal + one duplicate', async () => {
    const rfcId = `ReplyAll-${SUFFIX}@sender`;
    // Door 1: her token (token capture path).
    const d = assertStatus(
      await api('GET', `${base}/threads/${t1ThreadId}`, { token: landlordToken }),
      200, 'thread read',
    ) as { bindings: { participant_address: string; reply_address: string | null }[] };
    const token = d.bindings.find((b) => b.participant_address === T1_EMAIL.toLowerCase())?.reply_address;
    const door1 = assertStatus(await api('POST', `${base}/inbound`, {
      token: agentToken,
      body: {
        provider: 'ses', provider_msg_id: `PS-ra1-${rnd()}`, to_number: token,
        from_address: T1_EMAIL, channel: 'email', body: 'reply all', received_at: iso(),
        rfc822_message_id: `<${rfcId}>`,
      },
    }), 200, 'token door') as CaptureShape;
    assert(door1.disposition === 'matched', `token door: ${door1.disposition}`);

    // Door 2: the persona CC copy of the same email (sender = the tenant).
    const door2 = assertStatus(await personaCapture({
      from_address: T1_EMAIL, cc_addresses: [LL_EMAIL],
      body: 'reply all', rfc822_message_id: `<${rfcId}>`,
    }), 200, 'persona door') as CaptureShape;
    assert(door2.disposition === 'duplicate', `persona door: ${door2.disposition}`);
    assert(door2.interaction_id === door1.interaction_id, 'points at the token-journaled original');
  });

  await check('landlord CC about a known-but-unthreaded tenant → outbound-cold thread created', async () => {
    const freshEmail = `fresh-${SUFFIX}@tenant.test`;
    const freshId = await createTenant('Fresh Tenant', freshEmail);
    const r = await personaCapture({
      from_address: LL_EMAIL, to_addresses: [freshEmail],
      subject: 'Welcome!', body: 'welcome aboard',
    });
    const res = assertStatus(r, 200, 'outbound-cold cc') as CaptureShape;
    assert(res.disposition === 'cc_journaled', `disposition: ${res.disposition}`);
    assert(res.thread_id !== null && res.thread_id !== t1ThreadId, 'a new thread');
    assert(res.participant?.party_id === freshId, `counterparty: ${res.participant?.party_id}`);

    // The initiating landlord is the thread's landlord participant, BOUND
    // with his own address (core knows it — it authenticated the mail).
    const d = assertStatus(
      await api('GET', `${base}/threads/${res.thread_id}`, { token: landlordToken }),
      200, 'cold-cc thread detail',
    ) as {
      participants: { party_type: string; party_id: string | null }[];
      bindings: { participant_address: string; reply_address: string | null }[];
    };
    assert(d.participants.some((p) => p.party_type === 'landlord_user' && p.party_id === sub.user.id),
      'initiating landlord is the participant');
    assert(d.bindings.some((b) => b.participant_address === LL_EMAIL && b.reply_address?.startsWith('t-')),
      `landlord bound with a minted token: ${JSON.stringify(d.bindings)}`);
    assert(d.bindings.some((b) => b.participant_address === freshEmail), 'tenant bound');
  });

  await check('landlord sender with DMARC fail → triaged, never landlord-attributed', async () => {
    const r = await personaCapture({
      from_address: LL_EMAIL, to_addresses: [T1_EMAIL],
      body: 'forged?', auth_results: AUTH_FAIL,
    });
    const res = assertStatus(r, 200, 'forged landlord') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    assert(res.interaction_id === null, 'nothing journaled');
  });

  await check('landlord CC about an unknown counterparty → triaged, and the landlord is NEVER acked', async () => {
    const r = await personaCapture({
      from_address: LL_EMAIL, to_addresses: [`nobody-${SUFFIX}@unknown.test`],
      body: 'who is this even about',
    });
    const res = assertStatus(r, 200, 'unknown-counterparty cc') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);

    // The stranger ack is for strangers: a recognized landlord landing in
    // triage (DMARC pass and all) must not receive the tenant-oriented
    // receipt. Poll-wait like the positive ack checks, then assert absence.
    await sleep(600);
    const { count } = await admin
      .from('comm_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId).eq('to_address', LL_EMAIL)
      .eq('approval_ref', 'system:persona_ack');
    assert((count ?? 0) === 0, `no ack to the landlord: ${count}`);
  });

  // =========================================================================
  // (8) Unknown-sender triage (phase 6)
  // =========================================================================
  let triageRowId = '';
  const LATER_EMAIL = `later-${SUFFIX}@somewhere.test`;

  await check('triaged capture returns unmatched_id; replay returns the same id', async () => {
    const msgId = `PS-triage-${rnd()}`;
    const r = await personaCapture({
      provider_msg_id: msgId, from_address: LATER_EMAIL,
      from_display_name: 'Lena Later', subject: 'About unit 4B',
      body: 'former tenant here, new address',
    });
    const res = assertStatus(r, 200, 'triage capture') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    assert(res.unmatched_id !== null, 'unmatched_id returned');
    triageRowId = res.unmatched_id!;

    const replay = assertStatus(await personaCapture({
      provider_msg_id: msgId, from_address: LATER_EMAIL,
      from_display_name: 'Lena Later', subject: 'About unit 4B',
      body: 'former tenant here, new address',
    }), 200, 'triage replay') as CaptureShape;
    assert(replay.disposition === 'triaged' && replay.unmatched_id === triageRowId,
      `replay resolves the same triage row: ${replay.unmatched_id}`);

    // The fire-and-forget ack stamps auto_acked_at on the triage row — the
    // FE's "we already replied" signal. Poll briefly like the ack checks.
    let acked: string | null = null;
    for (let i = 0; i < 20 && acked === null; i++) {
      await sleep(150);
      const { data } = await admin
        .from('comm_unmatched_inbound')
        .select('auto_acked_at')
        .eq('id', triageRowId)
        .maybeSingle();
      acked = (data?.auto_acked_at as string | null) ?? null;
    }
    assert(acked !== null, 'auto_acked_at stamped on the triage row');
  });

  await check('the triage queue lists pending rows with their stored copy + reason', async () => {
    const r = await api('GET', `${base}/unmatched?status=pending&limit=100`, { token: landlordToken });
    const rows = (assertStatus(r, 200, 'unmatched list') as { data: {
      id: string; from_address: string; subject: string | null; reason: string; status: string;
    }[] }).data;
    const mine = rows.find((x) => x.id === triageRowId);
    assert(mine, 'the new row is in the queue');
    assert(mine!.from_address === LATER_EMAIL && mine!.subject === 'About unit 4B',
      `stored copy: ${JSON.stringify(mine)}`);
    assert(mine!.reason === 'unknown_sender', `reason: ${mine!.reason}`);
    // The KNOWN-sender DMARC failure from (3) is flagged as the suspicious kind.
    assert(rows.some((x) => x.from_address === T1_EMAIL.toLowerCase() && x.reason === 'auth_failed'),
      'the known-sender DMARC failure carries reason=auth_failed');
  });

  await check('detail computes suggestions at read time (email_exact for a late-added tenant)', async () => {
    // The tenant is created AFTER the capture — stored-at-capture suggestions
    // would miss her; read-time ones must not.
    const lenaId = await createTenant('Lena Later', LATER_EMAIL);
    const r = await api('GET', `${base}/unmatched/${triageRowId}`, { token: landlordToken });
    const d = assertStatus(r, 200, 'unmatched detail') as {
      suggestions: { party_type: string; party_id: string; source: string }[];
    };
    assert(
      d.suggestions.some((s) => s.party_id === lenaId && s.source === 'email_exact'),
      `email_exact suggestion present: ${JSON.stringify(d.suggestions)}`,
    );

    // Link it: journals the STORED original + learns the address.
    const link = await api('POST', `${base}/unmatched/${triageRowId}/link`, {
      token: landlordToken, body: { party_type: 'tenant', party_id: lenaId },
    });
    const res = assertStatus(link, 200, 'link') as { thread_id: string; interaction_id: string };

    const { data: j } = await admin
      .from('interactions')
      .select('direction, party_type, party_id, attestation, body, thread_id')
      .eq('id', res.interaction_id)
      .single();
    assert(j!.direction === 'inbound' && j!.party_type === 'tenant' && j!.party_id === lenaId,
      `linked journal attribution: ${JSON.stringify(j)}`);
    assert(j!.attestation === 'provider_verified', `stored DMARC passed → ${j!.attestation}`);
    assert(j!.body === 'former tenant here, new address', 'journals the STORED original');
    assert(j!.thread_id === res.thread_id, 'journaled into the created thread');

    const { data: row } = await admin
      .from('comm_unmatched_inbound')
      .select('status, linked_interaction_id, linked_party_id')
      .eq('id', triageRowId)
      .single();
    assert(row!.status === 'linked' && row!.linked_interaction_id === res.interaction_id
      && row!.linked_party_id === lenaId, `row resolved: ${JSON.stringify(row)}`);

    // The learning step: her NEXT mail auto-resolves into the same thread.
    const next = assertStatus(await personaCapture({
      from_address: LATER_EMAIL, body: 'thanks for finding me',
    }), 200, 'post-link capture') as CaptureShape;
    assert(next.disposition === 'matched', `post-link disposition: ${next.disposition}`);
    assert(next.thread_id === res.thread_id, `same thread: ${next.thread_id}`);
  });

  await check('linking a resolved row → 409; dismiss is idempotent; agent → 403', async () => {
    const again = await api('POST', `${base}/unmatched/${triageRowId}/link`, {
      token: landlordToken, body: { party_type: 'tenant', party_id: t1Id },
    });
    assertStatus(again, 409, 'double link');

    // A fresh stranger row to dismiss.
    const r = assertStatus(await personaCapture({
      from_address: `dismiss-${SUFFIX}@somewhere.test`, body: 'spamish',
    }), 200, 'dismissable capture') as CaptureShape;
    const one = await api('POST', `${base}/unmatched/${r.unmatched_id}/dismiss`, { token: landlordToken });
    const dismissed = assertStatus(one, 200, 'dismiss') as { status: string };
    assert(dismissed.status === 'dismissed', `status: ${dismissed.status}`);
    const two = await api('POST', `${base}/unmatched/${r.unmatched_id}/dismiss`, { token: landlordToken });
    assertStatus(two, 200, 'dismiss replay');

    const agentList = await api('GET', `${base}/unmatched`, { token: agentToken });
    assertStatus(agentList, 403, 'agent list');
    const agentLink = await api('POST', `${base}/unmatched/${triageRowId}/link`, {
      token: agentToken, body: { party_type: 'tenant', party_id: t1Id },
    });
    assertStatus(agentLink, 403, 'agent link');
  });

  await check('linking an auth_failed row journals as attested (human vouches, provider could not)', async () => {
    const { data: failRow } = await admin
      .from('comm_unmatched_inbound')
      .select('id')
      .eq('account_id', accountId)
      .eq('from_address', T1_EMAIL.toLowerCase())
      .eq('reason', 'auth_failed')
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle();
    assert(failRow, 'the auth_failed row from (3) is pending');
    const link = await api('POST', `${base}/unmatched/${failRow!.id}/link`, {
      token: landlordToken, body: { party_type: 'tenant', party_id: t1Id },
    });
    const res = assertStatus(link, 200, 'link auth_failed') as { interaction_id: string };
    const { data: j } = await admin
      .from('interactions')
      .select('attestation')
      .eq('id', res.interaction_id)
      .single();
    assert(j!.attestation === 'attested', `attestation: ${j!.attestation}`);
  });

  // =========================================================================
  // (9) Attachment ingestion (phase 7)
  // =========================================================================
  const FILE_BYTES = new TextEncoder().encode(`fake-pdf-bytes-${SUFFIX}`);
  const FILE_B64 = Buffer.from(FILE_BYTES).toString('base64');
  let attachmentId = '';

  await check('transport stores an attachment on a persona-captured row; retry is idempotent', async () => {
    const path = `/v1/accounts/${accountId}/interactions/${t1FirstIid}/attachments`;
    const r = await api('POST', path, {
      token: agentToken,
      body: { filename: 'deposit-photos.pdf', content_type: 'application/pdf', data_b64: FILE_B64 },
    });
    const row = assertStatus(r, 201, 'attachment upload') as {
      id: string; filename: string | null; mime_type: string | null; content_hash: string;
    };
    assert(row.filename === 'deposit-photos.pdf', `filename: ${row.filename}`);
    assert(row.mime_type === 'application/pdf', `mime: ${row.mime_type}`);
    assert(/^[a-f0-9]{64}$/.test(row.content_hash), `hash: ${row.content_hash}`);
    attachmentId = row.id;

    const retry = await api('POST', path, {
      token: agentToken,
      body: { filename: 'deposit-photos.pdf', content_type: 'application/pdf', data_b64: FILE_B64 },
    });
    const again = assertStatus(retry, 201, 'attachment retry') as { id: string };
    assert(again.id === attachmentId, `retry returns the existing row: ${again.id}`);
  });

  await check('members list + download the stored bytes (headers forced)', async () => {
    const list = await api('GET', `/v1/accounts/${accountId}/interactions/${t1FirstIid}/attachments`, {
      token: landlordToken,
    });
    const rows = (assertStatus(list, 200, 'attachment list') as { data: { id: string }[] }).data;
    assert(rows.length === 1 && rows[0]!.id === attachmentId, `list: ${JSON.stringify(rows)}`);

    const res = await app.fetch(new Request(
      `http://test/v1/accounts/${accountId}/interactions/${t1FirstIid}/attachments/${attachmentId}/download`,
      { headers: { authorization: `Bearer ${landlordToken}` } },
    ));
    assert(res.status === 200, `download status: ${res.status}`);
    const got = new Uint8Array(await res.arrayBuffer());
    assert(Buffer.from(got).equals(Buffer.from(FILE_BYTES)), 'bytes round-trip');
    assert(res.headers.get('content-type') === 'application/pdf', `ct: ${res.headers.get('content-type')}`);
    assert((res.headers.get('content-disposition') ?? '').includes('deposit-photos.pdf'), 'disposition filename');
    assert(res.headers.get('x-content-type-options') === 'nosniff', 'nosniff forced');
  });

  await check('attachments are refused on non-capture rows and non-transport callers', async () => {
    // A manually-journaled row (actor user:*, attestation attested) takes none.
    const manual = await api('POST', `/v1/accounts/${accountId}/interactions`, {
      token: landlordToken,
      body: {
        kind: 'communication', channel: 'email', direction: 'inbound',
        party_type: 'tenant', party_id: t1Id, body: 'manual note of a call',
        occurred_at: iso(),
      },
    });
    const manualRow = assertStatus(manual, 201, 'manual journal') as { id: string };
    const refused = await api('POST', `/v1/accounts/${accountId}/interactions/${manualRow.id}/attachments`, {
      token: agentToken,
      body: { filename: 'x.pdf', content_type: 'application/pdf', data_b64: FILE_B64 },
    });
    assertStatus(refused, 400, 'non-capture upload');

    const landlordUpload = await api('POST', `/v1/accounts/${accountId}/interactions/${t1FirstIid}/attachments`, {
      token: landlordToken,
      body: { filename: 'x.pdf', content_type: 'application/pdf', data_b64: FILE_B64 },
    });
    assertStatus(landlordUpload, 403, 'landlord upload');
  });

  // =========================================================================
  // (10) Guards
  // =========================================================================
  await check('landlord calling the persona endpoint → 403 (transport only)', async () => {
    const r = await api('POST', `${base}/inbound-persona`, {
      token: landlordToken,
      body: {
        provider: 'ses', provider_msg_id: `PS-${rnd()}`, persona_address: PERSONA,
        from_address: T1_EMAIL, to_addresses: [], cc_addresses: [],
        received_at: iso(), auth_results: AUTH_PASS,
      },
    });
    assertStatus(r, 403, 'landlord persona capture');
  });

  await check('missing auth_results → 400 (verdicts are required here)', async () => {
    const r = await api('POST', `${base}/inbound-persona`, {
      token: agentToken,
      body: {
        provider: 'ses', provider_msg_id: `PS-${rnd()}`, persona_address: PERSONA,
        from_address: T1_EMAIL, to_addresses: [], cc_addresses: [], received_at: iso(),
      },
    });
    assertStatus(r, 400, 'missing verdicts');
  });

  // --- summary ---------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} persona-capture check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: persona-capture checks all green');
}

await main();
