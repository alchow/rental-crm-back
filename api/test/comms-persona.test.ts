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
      channel: 'email', address: T2_EMAIL, source: 'provider_learned',
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
  const LL_GMAIL = `persona.owner.${SUFFIX}@gmail.com`;
  const LL_GMAIL_PHONE = `personaowner${SUFFIX}+phone@gmail.com`;
  const LL_GMAIL_UNVERIFIED = `personaowner${SUFFIX}+unverified@gmail.com`;
  const LL_GMAIL_REPLAY = `personaowner${SUFFIX}+replay@gmail.com`;
  const LL_GMAIL_CONFLICT = `personaowner${SUFFIX}+conflict@gmail.com`;
  {
    // The landlord's email identity: the CC arm's sender-recognition input.
    const { error } = await admin.from('channel_identities').insert({
      account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
      channel: 'email', address: LL_EMAIL, source: 'provider_learned',
    });
    if (error) throw new Error(`landlord identity: ${error.message}`);
  }
  {
    const { error } = await admin.from('channel_identities').insert({
      account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
      channel: 'email', address: LL_GMAIL, source: 'provider_learned',
    });
    if (error) throw new Error(`gmail landlord identity: ${error.message}`);
  }
  {
    const { error } = await admin.from('channel_identities').insert({
      account_id: accountId, party_type: 'tenant', party_id: t1Id,
      channel: 'email', address: LL_GMAIL_CONFLICT, source: 'provider_learned',
    });
    if (error) throw new Error(`gmail conflict identity: ${error.message}`);
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

  await check('phone Gmail alias replies only to persona → parent outbox restores the tenant', async () => {
    const sent = await api('POST', `${base}/outbox`, {
      token: landlordToken,
      body: {
        channel: 'email',
        to_address: T2_EMAIL,
        cc_addresses: [LL_GMAIL],
        subject: 'Inspection follow-up',
        body: 'Please review this inspection.',
        approval_ref: `self:${sub.user.id}`,
      },
    });
    const outbox = assertStatus(sent, 201, 'gmail-cc parent intent') as { id: string };
    const parentMessageId = `<${outbox.id}@${REPLY_DOMAIN}>`;

    const completed = await api('POST', `${base}/outbox/${outbox.id}/complete`, {
      token: agentToken,
      body: {
        provider: 'smtp2go',
        provider_sid: `smtp2go-${rnd()}`,
        rfc822_message_id: parentMessageId,
      },
    });
    assertStatus(completed, 200, 'gmail-cc parent complete');

    const replayProviderId = `PS-gmail-replay-${rnd()}`;
    const unverified = await personaCapture({
      provider_msg_id: replayProviderId,
      from_address: LL_GMAIL_UNVERIFIED,
      to_addresses: [PERSONA],
      cc_addresses: [],
      subject: 'Re: Inspection follow-up',
      body: 'This must not be attributed.',
      rfc822_message_id: `<unverified-reply-${SUFFIX}@gmail.com>`,
      in_reply_to: parentMessageId,
      references: [parentMessageId],
      auth_results: AUTH_FAIL,
    });
    const unverifiedRes = assertStatus(
      unverified,
      200,
      'unverified phone alias persona reply',
    ) as CaptureShape;
    assert(unverifiedRes.disposition === 'triaged', `unverified: ${unverifiedRes.disposition}`);
    const { count: unverifiedIdentityCount } = await admin
      .from('channel_identities')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('channel', 'email')
      .eq('address', LL_GMAIL_UNVERIFIED);
    assert((unverifiedIdentityCount ?? 0) === 0, 'failed DMARC never teaches an alias');

    const changedReplay = await personaCapture({
      provider_msg_id: replayProviderId,
      from_address: LL_GMAIL_REPLAY,
      to_addresses: [PERSONA],
      cc_addresses: [],
      subject: 'Re: Inspection follow-up',
      body: 'Changed replay inputs must be ignored.',
      rfc822_message_id: `<changed-replay-${SUFFIX}@gmail.com>`,
      in_reply_to: parentMessageId,
      references: [parentMessageId],
    });
    const changedReplayRes = assertStatus(
      changedReplay,
      200,
      'changed replay persona reply',
    ) as CaptureShape;
    assert(changedReplayRes.disposition === 'triaged', 'replay keeps the original disposition');
    const { count: replayIdentityCount } = await admin
      .from('channel_identities')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('channel', 'email')
      .eq('address', LL_GMAIL_REPLAY);
    assert((replayIdentityCount ?? 0) === 0, 'changed replay never teaches an alias');

    const reply = await personaCapture({
      from_address: LL_GMAIL_PHONE,
      to_addresses: [PERSONA],
      cc_addresses: [],
      subject: 'Re: Inspection follow-up',
      body: 'Replying from my phone.',
      rfc822_message_id: `<phone-reply-${SUFFIX}@gmail.com>`,
      in_reply_to: parentMessageId,
      references: [parentMessageId],
    });
    const res = assertStatus(reply, 200, 'phone alias persona reply') as CaptureShape;
    assert(res.disposition === 'cc_journaled', `disposition: ${res.disposition}`);
    assert(res.participant?.party_id === t2Id, `parent tenant restored: ${res.participant?.party_id}`);
    assert(res.interaction_id !== null, 'phone reply journaled');

    const { data: learned, error } = await admin
      .from('channel_identities')
      .select('party_type, party_id')
      .eq('account_id', accountId)
      .eq('channel', 'email')
      .eq('address', LL_GMAIL_PHONE)
      .single();
    if (error) throw new Error(`phone alias identity read: ${error.message}`);
    assert(
      learned.party_type === 'landlord_user' && learned.party_id === sub.user.id,
      `authenticated phone alias learned: ${JSON.stringify(learned)}`,
    );

    const conflicted = await personaCapture({
      from_address: LL_GMAIL_CONFLICT,
      to_addresses: [PERSONA],
      cc_addresses: [],
      subject: 'Re: Inspection follow-up',
      body: 'A conflicting identity must not be reassigned.',
      rfc822_message_id: `<conflict-reply-${SUFFIX}@gmail.com>`,
      in_reply_to: parentMessageId,
      references: [parentMessageId],
    });
    const conflictedRes = assertStatus(conflicted, 200, 'conflicting phone alias') as CaptureShape;
    assert(conflictedRes.disposition === 'triaged', 'conflicting alias is triaged');
    const conflictUnmatchedId = conflictedRes.unmatched_id;
    if (conflictUnmatchedId === null) throw new Error('conflicting alias has no triage record');
    const { data: conflictTriage, error: conflictTriageError } = await admin
      .from('comm_unmatched_inbound')
      .select('reason, dmarc')
      .eq('account_id', accountId)
      .eq('id', conflictUnmatchedId)
      .single();
    if (conflictTriageError) throw new Error(`conflict triage read: ${conflictTriageError.message}`);
    assert(
      conflictTriage.reason === 'identity_conflict' && conflictTriage.dmarc === 'pass',
      `conflict evidence preserved: ${JSON.stringify(conflictTriage)}`,
    );
    const { data: conflictIdentity, error: conflictError } = await admin
      .from('channel_identities')
      .select('party_type, party_id')
      .eq('account_id', accountId)
      .eq('channel', 'email')
      .eq('address', LL_GMAIL_CONFLICT)
      .single();
    if (conflictError) throw new Error(`conflict identity read: ${conflictError.message}`);
    assert(
      conflictIdentity.party_type === 'tenant' && conflictIdentity.party_id === t1Id,
      'first identity binding remains unchanged',
    );
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
  // (7b) Parent-first routing v2 (persona routing v2, PR 1 — plan §6.4/§6.5)
  // =========================================================================
  // Data flow under test: a completed outbox row (the parent) carries the
  // authoritative conversation context — its tenancy, its physical To/Cc
  // addresses — and an authenticated reply whose In-Reply-To names that parent
  // must be routed from THAT context, never from an account-wide learned
  // channel_identities claim.

  const PV2_TENANT_EMAIL = `pv2-tenant-${SUFFIX}@tenant.test`;
  const PV2_UNKNOWN_EMAIL = `pv2-unknown-${SUFFIX}@somewhere.test`;
  const PV2_OTHER_EMAIL = `pv2-other-${SUFFIX}@tenant.test`;
  const PV2_DUAL_EMAIL = `pv2-dual-${SUFFIX}@tenant.test`;
  const PV2_TWOTEN_EMAIL = `pv2-twoten-${SUFFIX}@tenant.test`;

  const pv2Post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: landlordToken, body });
    if (r.status !== 201) throw new Error(`pv2 setup POST ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  // Property + three units; tenancy A is the incident tenancy, C/D are the
  // two-tenancy pin fixture (D is the newer one the OLD code would pick).
  const pv2Property = await pv2Post<{ id: string }>(`/v1/accounts/${accountId}/properties`, {
    name: 'PV2 Parent-Routing Prop',
  });
  const pv2Unit = async (name: string) =>
    (await pv2Post<{ id: string }>(`/v1/accounts/${accountId}/areas`, {
      property_id: pv2Property.id, kind: 'unit', name,
    })).id;
  const pv2UnitA = await pv2Unit('PV2 Unit A');
  const pv2UnitC = await pv2Unit('PV2 Unit C');
  const pv2UnitD = await pv2Unit('PV2 Unit D');
  const pv2Tenancy = async (areaId: string, start: string) =>
    (await pv2Post<{ id: string }>(`/v1/accounts/${accountId}/tenancies`, {
      area_id: areaId, start_date: start, status: 'active',
    })).id;
  const tenancyAId = await pv2Tenancy(pv2UnitA, '2026-01-01');
  const tenancyCId = await pv2Tenancy(pv2UnitC, '2026-01-01');
  const tenancyDId = await pv2Tenancy(pv2UnitD, '2026-03-01');
  const pv2Member = async (tenancyId: string, tenantId: string) => {
    const r = await api('POST', `/v1/accounts/${accountId}/tenancies/${tenancyId}/members`, {
      token: landlordToken, body: { tenant_id: tenantId, role: 'primary' },
    });
    if (r.status !== 201) throw new Error(`pv2 member: ${r.status} ${JSON.stringify(r.body)}`);
  };
  const ptAId = await createTenant('Parent Reply Tenant', PV2_TENANT_EMAIL);
  await pv2Member(tenancyAId, ptAId);
  const pv2OtherId = await createTenant('Other Known Tenant', PV2_OTHER_EMAIL);
  // The dual tenant's RECORD email is a different address on purpose: the
  // conflict below must come from two live CLAIMS at the same tier, not from
  // the authoritative record book (which would outrank a learned claim).
  const pv2DualId = await createTenant('Dual Role Tenant', `pv2-dual-record-${SUFFIX}@tenant.test`);
  const pv2TwoTenId = await createTenant('Two Tenancy Tenant', PV2_TWOTEN_EMAIL);
  await pv2Member(tenancyCId, pv2TwoTenId);
  await pv2Member(tenancyDId, pv2TwoTenId);
  // The incident's bad account-wide claim: the tenant's address learned as the
  // LANDLORD (a pre-claims 'legacy' row). Parent tenancy context must beat
  // it; capture must not delete or supersede it.
  {
    const { error } = await admin.from('channel_identities').insert({
      account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
      channel: 'email', address: PV2_TENANT_EMAIL, source: 'legacy',
    });
    if (error) throw new Error(`pv2 bad claim seed: ${error.message}`);
  }
  // Dual-role fixture (PR 2 shape): the same address carries TWO LIVE CLAIMS
  // at the same tier — landlord and tenant, both provider_learned. Neither
  // outranks the other, so a no-context capture must conflict honestly.
  {
    const { error } = await admin.from('channel_identities').insert([
      {
        account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
        channel: 'email', address: PV2_DUAL_EMAIL, source: 'provider_learned',
      },
      {
        account_id: accountId, party_type: 'tenant', party_id: pv2DualId,
        channel: 'email', address: PV2_DUAL_EMAIL, source: 'provider_learned',
      },
    ]);
    if (error) throw new Error(`pv2 dual claim seed: ${error.message}`);
  }

  // A completed bare outbox row = a valid parent (sent, Message-ID stamped).
  const pv2Parent = async (opts: { to: string; cc?: string[]; tenancyId?: string }) => {
    const sent = await api('POST', `${base}/outbox`, {
      token: landlordToken,
      body: {
        channel: 'email',
        to_address: opts.to,
        ...(opts.cc ? { cc_addresses: opts.cc } : {}),
        ...(opts.tenancyId ? { tenancy_id: opts.tenancyId } : {}),
        subject: 'Inspection welcome',
        body: 'synthetic parent send',
        approval_ref: `self:${sub.user.id}`,
      },
    });
    const row = assertStatus(sent, 201, 'pv2 parent intent') as { id: string };
    const msgid = `<pv2-${row.id}@${REPLY_DOMAIN}>`;
    const done = await api('POST', `${base}/outbox/${row.id}/complete`, {
      token: agentToken,
      body: { provider: 'smtp2go', provider_sid: `pv2-${rnd()}`, rfc822_message_id: msgid },
    });
    assertStatus(done, 200, 'pv2 parent complete');
    return { id: row.id, msgid };
  };
  const pv2Parent1 = await pv2Parent({
    to: PV2_TENANT_EMAIL, cc: [ownerEmail], tenancyId: tenancyAId,
  });
  const pv2Parent2 = await pv2Parent({ to: PV2_UNKNOWN_EMAIL });
  const pv2Parent3 = await pv2Parent({ to: PV2_TWOTEN_EMAIL, tenancyId: tenancyCId });

  // The mismatch fixture needs a KNOWN tenant with an ACTIVE thread — the
  // forged parent reference must NOT route into it.
  let pv2OtherThreadId = '';
  {
    const r = await personaCapture({ from_address: PV2_OTHER_EMAIL, body: 'unrelated thread seed' });
    const res = assertStatus(r, 200, 'pv2 other-tenant seed') as CaptureShape;
    if (res.disposition !== 'matched' || res.thread_id === null) {
      throw new Error(`pv2 other-tenant seed not matched: ${JSON.stringify(res)}`);
    }
    pv2OtherThreadId = res.thread_id;
    void pv2OtherId;
  }

  let pv2ThreadId = '';
  let pv2FirstIid = '';
  const PV2_INCIDENT_PROVIDER_ID = `PS-pv2-incident-${rnd()}`;

  await check('v2(1) parent tenancy beats a bad learned landlord claim → matched (the incident)', async () => {
    const r = await personaCapture({
      provider_msg_id: PV2_INCIDENT_PROVIDER_ID,
      from_address: PV2_TENANT_EMAIL,
      to_addresses: [PERSONA],
      cc_addresses: [ownerEmail],
      subject: 'Re: Inspection welcome',
      body: 'tenant reply through the persona',
      rfc822_message_id: `<pv2-reply1-${SUFFIX}@sender>`,
      in_reply_to: pv2Parent1.msgid,
      references: [pv2Parent1.msgid],
    });
    const res = assertStatus(r, 200, 'incident capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.participant?.party_type === 'tenant' && res.participant.party_id === ptAId,
      `tenant wins from parent tenancy: ${JSON.stringify(res.participant)}`);
    assert(res.thread_id !== null && res.interaction_id !== null, 'journaled into a thread');
    pv2ThreadId = res.thread_id!;
    pv2FirstIid = res.interaction_id!;

    // The conversation is filed under the PARENT's tenancy.
    const { data: thr, error: thrErr } = await admin
      .from('comm_threads').select('tenancy_id').eq('id', pv2ThreadId).single();
    if (thrErr) throw new Error(`pv2 thread read: ${thrErr.message}`);
    assert(thr!.tenancy_id === tenancyAId, `thread tenancy = parent tenancy: ${thr!.tenancy_id}`);

    // The contradictory claim is preserved (repair is a later, audited step)
    // AND the route's own learning is now recorded per-party (PR 2): the
    // tenant's provider_learned claim lives ALONGSIDE the bad landlord row
    // instead of being swallowed by the old one-row-per-address key.
    const { data: claims, error: claimErr } = await admin
      .from('channel_identities')
      .select('party_type, party_id, source, superseded_at')
      .eq('account_id', accountId).eq('channel', 'email').eq('address', PV2_TENANT_EMAIL);
    if (claimErr) throw new Error(`pv2 claim read: ${claimErr.message}`);
    const claimRows = (claims ?? []) as {
      party_type: string; party_id: string; source: string; superseded_at: string | null;
    }[];
    assert(claimRows.length === 2, `two live claims recorded: ${JSON.stringify(claimRows)}`);
    assert(
      claimRows.some((x) => x.party_type === 'landlord_user' && x.source === 'legacy'
        && x.superseded_at === null),
      `bad claim untouched: ${JSON.stringify(claimRows)}`,
    );
    assert(
      claimRows.some((x) => x.party_type === 'tenant' && x.party_id === ptAId
        && x.source === 'provider_learned' && x.superseded_at === null),
      `tenant claim learned per-party: ${JSON.stringify(claimRows)}`,
    );

    // …and recorded in the frozen routing decision (v2 drift-guard smoke).
    const { data: raw, error: rawErr } = await admin
      .from('inbound_raw').select('payload')
      .eq('provider_msg_id', PV2_INCIDENT_PROVIDER_ID).single();
    if (rawErr) throw new Error(`pv2 raw read: ${rawErr.message}`);
    const decision = (raw!.payload as {
      routing_decision?: {
        version: number; parent_match: string; parent_outbox_id: string | null;
        party_source: string | null; conflict_party_type: string | null;
      };
    }).routing_decision;
    assert(decision?.version === 2, `routing_decision.version: ${JSON.stringify(decision)}`);
    assert(decision!.parent_match === 'unique' && decision!.parent_outbox_id === pv2Parent1.id,
      `parent recorded: ${JSON.stringify(decision)}`);
    assert(decision!.party_source === 'tenancy_member', `party_source: ${decision!.party_source}`);
    assert(decision!.conflict_party_type === 'landlord_user',
      `contradictory claim traced: ${JSON.stringify(decision)}`);
  });

  await check('v2(2) landlord replies from the visible Cc address → cc_journaled into the tenant conversation', async () => {
    const r = await personaCapture({
      from_address: ownerEmail,
      to_addresses: [PERSONA],
      body: 'landlord reply from the cc leg',
      rfc822_message_id: `<pv2-reply2-${SUFFIX}@sender>`,
      in_reply_to: pv2Parent1.msgid,
    });
    const res = assertStatus(r, 200, 'cc reply capture') as CaptureShape;
    assert(res.disposition === 'cc_journaled', `disposition: ${res.disposition}`);
    assert(res.thread_id === pv2ThreadId, `into the tenant's conversation: ${res.thread_id}`);
    assert(res.participant?.party_id === ptAId, `counterparty = tenant: ${JSON.stringify(res.participant)}`);
    const { data: row, error } = await admin
      .from('interactions').select('direction, author_type, party_type, party_id')
      .eq('id', res.interaction_id!).single();
    if (error) throw new Error(`cc journal read: ${error.message}`);
    assert(row!.direction === 'outbound' && row!.author_type === 'landlord',
      `landlord-authored outbound: ${row!.direction}/${row!.author_type}`);
    assert(row!.party_type === 'tenant' && row!.party_id === ptAId,
      `party = counterparty: ${row!.party_type}/${row!.party_id}`);
  });

  await check('v2(3) mobile reply strips To/Cc: persona-only headers still resolve via the parent', async () => {
    const r = await personaCapture({
      from_address: PV2_TENANT_EMAIL,
      to_addresses: [PERSONA],
      cc_addresses: [],
      body: 'sent from my phone',
      rfc822_message_id: `<pv2-reply3-${SUFFIX}@sender>`,
      in_reply_to: pv2Parent1.msgid,
    });
    const res = assertStatus(r, 200, 'mobile reply capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === pv2ThreadId, `same conversation: ${res.thread_id}`);
    assert(res.participant?.party_id === ptAId, `tenant participant: ${JSON.stringify(res.participant)}`);
  });

  await check('v2(4) authenticated non-recipient replying to a real parent → parent_sender_mismatch', async () => {
    // The sender IS a known tenant with an active thread; a forwarded/forged
    // parent reference must not route the mail into that unrelated thread.
    const r = await personaCapture({
      from_address: PV2_OTHER_EMAIL,
      to_addresses: [PERSONA],
      body: 'i found this message id somewhere',
      rfc822_message_id: `<pv2-reply4-${SUFFIX}@sender>`,
      in_reply_to: pv2Parent1.msgid,
    });
    const res = assertStatus(r, 200, 'mismatch capture') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    assert(res.thread_id === null && res.interaction_id === null,
      `not routed into the sender's own thread (${pv2OtherThreadId}): ${JSON.stringify(res)}`);
    assert(res.unmatched_id !== null, 'triage row returned');
    const { data: u, error } = await admin
      .from('comm_unmatched_inbound').select('reason').eq('id', res.unmatched_id!).single();
    if (error) throw new Error(`mismatch triage read: ${error.message}`);
    assert(u!.reason === 'parent_sender_mismatch', `reason: ${u!.reason}`);
  });

  await check('v2(5) valid parent but failed authentication → auth_failed (a parent never rescues DMARC)', async () => {
    const r = await personaCapture({
      from_address: PV2_UNKNOWN_EMAIL,
      to_addresses: [PERSONA],
      body: 'this reply fails dmarc',
      rfc822_message_id: `<pv2-reply5-${SUFFIX}@sender>`,
      in_reply_to: pv2Parent2.msgid,
      auth_results: AUTH_FAIL,
    });
    const res = assertStatus(r, 200, 'auth-fail capture') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    assert(res.interaction_id === null, 'nothing journaled');
    const { data: u, error } = await admin
      .from('comm_unmatched_inbound').select('reason').eq('id', res.unmatched_id!).single();
    if (error) throw new Error(`auth-fail triage read: ${error.message}`);
    assert(u!.reason === 'auth_failed', `reason: ${u!.reason}`);
    const { count } = await admin
      .from('channel_identities').select('id', { count: 'exact', head: true })
      .eq('account_id', accountId).eq('channel', 'email').eq('address', PV2_UNKNOWN_EMAIL);
    assert((count ?? 0) === 0, 'failed auth never learns an identity');
  });

  await check('v2(6) dual-role sender, no parent, no context → identity_conflict (not unknown_sender)', async () => {
    // PR 2: the conflict comes from two LIVE claims at the same tier.
    const r = await personaCapture({
      from_address: PV2_DUAL_EMAIL,
      body: 'who am i today',
      rfc822_message_id: `<pv2-reply6-${SUFFIX}@sender>`,
    });
    const res = assertStatus(r, 200, 'dual-role capture') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    assert(res.unmatched_id !== null, 'triage row returned');
    const { data: u, error } = await admin
      .from('comm_unmatched_inbound').select('reason').eq('id', res.unmatched_id!).single();
    if (error) throw new Error(`dual-role triage read: ${error.message}`);
    assert(u!.reason === 'identity_conflict', `reason: ${u!.reason}`);

    // Conflict never auto-deletes or supersedes a claim (§8): both stay live.
    const { data: dualClaims } = await admin
      .from('channel_identities').select('party_type, superseded_at')
      .eq('account_id', accountId).eq('channel', 'email').eq('address', PV2_DUAL_EMAIL);
    const live = ((dualClaims ?? []) as { party_type: string; superseded_at: string | null }[])
      .filter((x) => x.superseded_at === null);
    assert(live.length === 2, `both claims still live: ${JSON.stringify(dualClaims)}`);
  });

  await check('v2(7) thread-less parent with a tenancy pins the thread to THAT tenancy, and reuses it', async () => {
    const first = assertStatus(await personaCapture({
      from_address: PV2_TWOTEN_EMAIL,
      to_addresses: [PERSONA],
      body: 'reply about the older tenancy',
      rfc822_message_id: `<pv2-reply7a-${SUFFIX}@sender>`,
      in_reply_to: pv2Parent3.msgid,
    }), 200, 'two-tenancy first reply') as CaptureShape;
    assert(first.disposition === 'matched', `disposition: ${first.disposition}`);
    const { data: thr, error } = await admin
      .from('comm_threads').select('tenancy_id').eq('id', first.thread_id!).single();
    if (error) throw new Error(`two-tenancy thread read: ${error.message}`);
    assert(thr!.tenancy_id === tenancyCId,
      `parent tenancy (${tenancyCId}) pinned, not the newest (${tenancyDId}): ${thr!.tenancy_id}`);

    const second = assertStatus(await personaCapture({
      from_address: PV2_TWOTEN_EMAIL,
      to_addresses: [PERSONA],
      body: 'follow-up in the same conversation',
      rfc822_message_id: `<pv2-reply7b-${SUFFIX}@sender>`,
      in_reply_to: pv2Parent3.msgid,
    }), 200, 'two-tenancy second reply') as CaptureShape;
    assert(second.disposition === 'matched', `disposition: ${second.disposition}`);
    assert(second.thread_id === first.thread_id, `thread reused: ${second.thread_id}`);
  });

  await check('v2(8) replay with changed From/auth/references returns the frozen original', async () => {
    const r = await personaCapture({
      provider_msg_id: PV2_INCIDENT_PROVIDER_ID,
      from_address: PV2_OTHER_EMAIL,
      body: 'completely different content',
      rfc822_message_id: `<pv2-reply8-${SUFFIX}@sender>`,
      auth_results: AUTH_FAIL,
    });
    const res = assertStatus(r, 200, 'changed replay') as CaptureShape;
    assert(res.disposition === 'matched', `frozen disposition: ${res.disposition}`);
    assert(res.interaction_id === pv2FirstIid, `frozen interaction: ${res.interaction_id}`);
    assert(res.thread_id === pv2ThreadId, `frozen thread: ${res.thread_id}`);
  });

  await check('v2(9) reply-all across token and persona doors with parent headers → one journal + one duplicate', async () => {
    const rfcId = `pv2-twodoor-${SUFFIX}@sender`;
    const d = assertStatus(
      await api('GET', `${base}/threads/${pv2ThreadId}`, { token: landlordToken }),
      200, 'pv2 thread read',
    ) as {
      participants: { id: string; party_type: string; party_id: string | null }[];
      bindings: { participant_id: string; participant_address: string; reply_address: string | null }[];
    };
    // Address the TENANT participant's binding explicitly — the bad landlord
    // claim can leave the landlord bound under the same address.
    const tenantPart = d.participants.find((p) => p.party_type === 'tenant' && p.party_id === ptAId);
    const token = d.bindings.find((b) => b.participant_id === tenantPart?.id)?.reply_address;
    assert(token, 'tenant token minted on the parent-routed thread');

    const door1 = assertStatus(await api('POST', `${base}/inbound`, {
      token: agentToken,
      body: {
        provider: 'ses', provider_msg_id: `PS-pv2-door1-${rnd()}`, to_number: token,
        from_address: PV2_TENANT_EMAIL, channel: 'email', body: 'reply all', received_at: iso(),
        rfc822_message_id: `<${rfcId}>`,
      },
    }), 200, 'token door') as CaptureShape;
    assert(door1.disposition === 'matched', `token door: ${door1.disposition}`);

    const door2 = assertStatus(await personaCapture({
      from_address: PV2_TENANT_EMAIL,
      to_addresses: [PERSONA],
      body: 'reply all',
      rfc822_message_id: `<${rfcId}>`,
      in_reply_to: pv2Parent1.msgid,
    }), 200, 'persona door') as CaptureShape;
    assert(door2.disposition === 'duplicate', `persona door: ${door2.disposition}`);
    assert(door2.interaction_id === door1.interaction_id, 'points at the token-journaled original');
  });

  await check('v2(10) a completed parent in ANOTHER account is invisible to the probe', async () => {
    // Account B with its own completed send; a reply into account A reusing
    // B's Message-ID must not see it (invariant §5.6, use case L).
    const su2 = await api('POST', '/v1/auth/signup', {
      body: {
        email: `pcap-owner-b-${rnd()}@example.test`,
        password: `correct-horse-${rnd()}`,
        account_name: 'Persona Capture Acct B',
      },
    });
    if (su2.status !== 200) throw new Error(`signup B: ${su2.status} ${JSON.stringify(su2.body)}`);
    const subB = su2.body as { account: { id: string }; user: { id: string } };
    const crossMsgid = `<pv2-cross-${SUFFIX}@other-account>`;
    const { data: obRow, error: obErr } = await admin.from('comm_outbox').insert({
      account_id: subB.account.id, channel: 'email', to_address: PV2_OTHER_EMAIL,
      body: 'other account parent', approval_ref: `self:${subB.user.id}`,
      approved_by: subB.user.id, author_type: 'landlord',
      rfc822_message_id: crossMsgid,
    }).select('id').single();
    if (obErr) throw new Error(`account B parent seed: ${obErr.message}`);
    const { error: obUpErr } = await admin.from('comm_outbox')
      .update({ status: 'sent', provider: 'smtp2go', provider_sid: `pv2-b-${rnd()}` })
      .eq('id', obRow!.id);
    if (obUpErr) throw new Error(`account B parent sent: ${obUpErr.message}`);

    const r = await personaCapture({
      provider_msg_id: `PS-pv2-cross-${rnd()}`,
      from_address: PV2_OTHER_EMAIL,
      to_addresses: [PERSONA],
      body: 'reply quoting a foreign message id',
      rfc822_message_id: `<pv2-reply10-${SUFFIX}@sender>`,
      in_reply_to: crossMsgid,
    });
    const res = assertStatus(r, 200, 'cross-account capture') as CaptureShape;
    // The sender is a known single-claim tenant in account A: the capture must
    // fall through to the NO-PARENT path (their own thread), never B's parent.
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === pv2OtherThreadId, `own thread, not via parent: ${res.thread_id}`);
    const { data: raws, error: rawsErr } = await admin
      .from('inbound_raw').select('payload')
      .eq('matched_interaction_id', res.interaction_id!)
      .order('received_at', { ascending: false }).limit(1);
    if (rawsErr) throw new Error(`raw read: ${rawsErr.message}`);
    const decision = (raws?.[0]?.payload as {
      routing_decision?: { parent_match: string; parent_outbox_id: string | null };
    }).routing_decision;
    assert(decision?.parent_match === 'none' && decision.parent_outbox_id === null,
      `probe saw no parent: ${JSON.stringify(decision)}`);
  });

  await check('v2(11) a non-completed (queued) parent is invisible to the probe', async () => {
    // A queued intent in account A that somehow carries a Message-ID must not
    // be a parent (invariant §5.7: only sent/delivered rows qualify).
    const intent = await api('POST', `${base}/outbox`, {
      token: landlordToken,
      body: {
        channel: 'email', to_address: PV2_OTHER_EMAIL,
        subject: 'never sent', body: 'queued intent',
        approval_ref: `self:${sub.user.id}`,
      },
    });
    const row = assertStatus(intent, 201, 'queued intent') as { id: string };
    const queuedMsgid = `<pv2-queued-${SUFFIX}@${REPLY_DOMAIN}>`;
    const { error: upErr } = await admin.from('comm_outbox')
      .update({ rfc822_message_id: queuedMsgid }).eq('id', row.id);
    if (upErr) throw new Error(`queued msgid stamp: ${upErr.message}`);

    const r = await personaCapture({
      from_address: PV2_OTHER_EMAIL,
      to_addresses: [PERSONA],
      body: 'reply to a message that was never sent',
      rfc822_message_id: `<pv2-reply11-${SUFFIX}@sender>`,
      in_reply_to: queuedMsgid,
    });
    const res = assertStatus(r, 200, 'queued-parent capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === pv2OtherThreadId, `own thread, not via queued parent: ${res.thread_id}`);
    const { data: raws, error: rawsErr } = await admin
      .from('inbound_raw').select('payload')
      .eq('matched_interaction_id', res.interaction_id!)
      .order('received_at', { ascending: false }).limit(1);
    if (rawsErr) throw new Error(`raw read: ${rawsErr.message}`);
    const decision = (raws?.[0]?.payload as {
      routing_decision?: { parent_match: string; parent_outbox_id: string | null };
    }).routing_decision;
    assert(decision?.parent_match === 'none' && decision.parent_outbox_id === null,
      `probe ignored the queued row: ${JSON.stringify(decision)}`);
  });

  // =========================================================================
  // (7c) Conflict-aware identity claims (persona routing v2, PR 2 — plan §9.2)
  // =========================================================================
  // Data flow under test: channel_identities is now one row per CLAIM
  // (address + party + scope, with a named source and a supersession stamp).
  // Resolution walks named tiers over LIVE, scope-applicable claims; a human
  // link supersedes learned claims and actually takes effect afterwards.

  // Two tenants share one inbox (use case I): tenancy-scoped human claims.
  const SHARED_EMAIL = `pv2-shared-${SUFFIX}@tenant.test`;
  const shUnitA = await pv2Unit('PV2 Shared Unit A');
  const shUnitB = await pv2Unit('PV2 Shared Unit B');
  const shTenancyA = await pv2Tenancy(shUnitA, '2026-01-01');
  const shTenancyB = await pv2Tenancy(shUnitB, '2026-01-01');
  const shTenantA = await createTenant('Shared Inbox A', `pv2-shared-a-${SUFFIX}@tenant.test`);
  const shTenantB = await createTenant('Shared Inbox B', `pv2-shared-b-${SUFFIX}@tenant.test`);
  await pv2Member(shTenancyA, shTenantA);
  await pv2Member(shTenancyB, shTenantB);
  {
    const { error } = await admin.from('channel_identities').insert([
      {
        account_id: accountId, party_type: 'tenant', party_id: shTenantA,
        channel: 'email', address: SHARED_EMAIL, source: 'human_link',
        scope_type: 'tenancy', scope_id: shTenancyA,
      },
      {
        account_id: accountId, party_type: 'tenant', party_id: shTenantB,
        channel: 'email', address: SHARED_EMAIL, source: 'human_link',
        scope_type: 'tenancy', scope_id: shTenancyB,
      },
    ]);
    if (error) throw new Error(`shared inbox claim seed: ${error.message}`);
  }

  await check('claims(1) shared inbox: parent tenancy context selects its tenant; cold mail stays triaged', async () => {
    const parent = await pv2Parent({ to: SHARED_EMAIL, tenancyId: shTenancyA });
    const sharedMsg = `PS-shared-${rnd()}`;
    const r = await personaCapture({
      provider_msg_id: sharedMsg,
      from_address: SHARED_EMAIL,
      to_addresses: [PERSONA],
      subject: 'Re: Inspection welcome',
      body: 'reply from the shared inbox',
      rfc822_message_id: `<pv2-shared-1-${SUFFIX}@sender>`,
      in_reply_to: parent.msgid,
    });
    const res = assertStatus(r, 200, 'shared parent reply') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.participant?.party_id === shTenantA,
      `tenancy A's tenant selected: ${JSON.stringify(res.participant)}`);
    const { data: thr } = await admin
      .from('comm_threads').select('tenancy_id').eq('id', res.thread_id!).single();
    assert(thr!.tenancy_id === shTenancyA, `thread pinned to tenancy A: ${thr!.tenancy_id}`);
    const { data: raw } = await admin
      .from('inbound_raw').select('payload').eq('provider_msg_id', sharedMsg).single();
    const decision = (raw!.payload as {
      routing_decision?: { party_source: string | null };
    }).routing_decision;
    assert(decision?.party_source === 'verified_identity',
      `selected via the scoped human claim: ${JSON.stringify(decision)}`);

    // A cold email with NO conversation context: neither tenancy-scoped claim
    // applies, both tenants remain possible -> honest triage.
    const cold = assertStatus(await personaCapture({
      from_address: SHARED_EMAIL,
      body: 'no context this time',
      rfc822_message_id: `<pv2-shared-2-${SUFFIX}@sender>`,
    }), 200, 'shared cold capture') as CaptureShape;
    assert(cold.disposition === 'triaged', `cold disposition: ${cold.disposition}`);
    const { data: u } = await admin
      .from('comm_unmatched_inbound').select('reason').eq('id', cold.unmatched_id!).single();
    assert(u!.reason === 'unknown_sender', `cold reason: ${u!.reason}`);
  });

  // A human claim outranks a provider-learned claim within its scope, and
  // provider learning can never replace the human claim.
  const HV_EMAIL = `pv2-hv-${SUFFIX}@dual.test`;
  const hvTenantId = await createTenant('Human Claimed', `pv2-hv-record-${SUFFIX}@tenant.test`);
  {
    const { error } = await admin.from('channel_identities').insert([
      {
        account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
        channel: 'email', address: HV_EMAIL, source: 'provider_learned',
      },
      {
        account_id: accountId, party_type: 'tenant', party_id: hvTenantId,
        channel: 'email', address: HV_EMAIL, source: 'human_link',
      },
    ]);
    if (error) throw new Error(`human-vs-learned seed: ${error.message}`);
  }

  await check('claims(2) human claim outranks provider-learned; capture learning never replaces it', async () => {
    const hvMsg = `PS-hv-${rnd()}`;
    const r = await personaCapture({
      provider_msg_id: hvMsg,
      from_address: HV_EMAIL,
      body: 'the human said i am the tenant',
      rfc822_message_id: `<pv2-hv-1-${SUFFIX}@sender>`,
    });
    const res = assertStatus(r, 200, 'human-tier capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.participant?.party_type === 'tenant' && res.participant.party_id === hvTenantId,
      `human claim wins: ${JSON.stringify(res.participant)}`);
    const { data: raw } = await admin
      .from('inbound_raw').select('payload').eq('provider_msg_id', hvMsg).single();
    const decision = (raw!.payload as {
      routing_decision?: { party_source: string | null };
    }).routing_decision;
    assert(decision?.party_source === 'human_link', `party_source: ${JSON.stringify(decision)}`);

    // Capture's learning is additive-only: the human row is not downgraded,
    // the contradicting learned landlord row is not superseded, nothing new
    // appears (the same-party insert collides on the claim key).
    const { data: rows } = await admin
      .from('channel_identities').select('party_type, source, superseded_at')
      .eq('account_id', accountId).eq('channel', 'email').eq('address', HV_EMAIL);
    const hv = (rows ?? []) as { party_type: string; source: string; superseded_at: string | null }[];
    assert(hv.length === 2, `still exactly two claims: ${JSON.stringify(hv)}`);
    assert(hv.every((x) => x.superseded_at === null), `capture superseded nothing: ${JSON.stringify(hv)}`);
    assert(hv.some((x) => x.party_type === 'tenant' && x.source === 'human_link'),
      `human claim intact: ${JSON.stringify(hv)}`);
    assert(hv.some((x) => x.party_type === 'landlord_user' && x.source === 'provider_learned'),
      `learned claim intact: ${JSON.stringify(hv)}`);

    // And the next capture still routes by the human tier.
    const again = assertStatus(await personaCapture({
      from_address: HV_EMAIL, body: 'still the tenant',
      rfc822_message_id: `<pv2-hv-2-${SUFFIX}@sender>`,
    }), 200, 'human-tier capture 2') as CaptureShape;
    assert(again.disposition === 'matched' && again.participant?.party_id === hvTenantId,
      `still the human-claimed tenant: ${JSON.stringify(again.participant)}`);
  });

  // The incident's learning bug, regression-pinned: a dual-role address is
  // human-linked as the tenant; the link SUPERSEDES the learned landlord
  // claim (stamped, not deleted) and the next inbound resolves as the tenant.
  const SUP_EMAIL = `pv2-sup-${SUFFIX}@dual.test`;
  const supTenantId = await createTenant('Sup Linked', `pv2-sup-record-${SUFFIX}@tenant.test`);
  {
    const { error } = await admin.from('channel_identities').insert([
      {
        account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
        channel: 'email', address: SUP_EMAIL, source: 'provider_learned',
      },
      {
        account_id: accountId, party_type: 'tenant', party_id: supTenantId,
        channel: 'email', address: SUP_EMAIL, source: 'provider_learned',
      },
    ]);
    if (error) throw new Error(`supersession seed: ${error.message}`);
  }

  await check('claims(3) human link supersedes the learned claim and TAKES EFFECT (incident regression)', async () => {
    const first = assertStatus(await personaCapture({
      from_address: SUP_EMAIL, body: 'dual role, no context',
      rfc822_message_id: `<pv2-sup-1-${SUFFIX}@sender>`,
    }), 200, 'dual capture') as CaptureShape;
    assert(first.disposition === 'triaged', `pre-link disposition: ${first.disposition}`);
    const { data: u } = await admin
      .from('comm_unmatched_inbound').select('reason').eq('id', first.unmatched_id!).single();
    assert(u!.reason === 'identity_conflict', `pre-link reason: ${u!.reason}`);

    const link = await api('POST', `${base}/unmatched/${first.unmatched_id}/link`, {
      token: landlordToken, body: { party_type: 'tenant', party_id: supTenantId },
    });
    const linked = assertStatus(link, 200, 'human link') as { thread_id: string };

    // The learned landlord claim is SUPERSEDED (stamped, still queryable);
    // the tenant claim is upgraded to a live human_link claim.
    const { data: rows } = await admin
      .from('channel_identities').select('party_type, source, superseded_at')
      .eq('account_id', accountId).eq('channel', 'email').eq('address', SUP_EMAIL);
    const sup = (rows ?? []) as { party_type: string; source: string; superseded_at: string | null }[];
    assert(sup.length === 2, `superseded claim retained as evidence: ${JSON.stringify(sup)}`);
    assert(
      sup.some((x) => x.party_type === 'landlord_user' && x.superseded_at !== null),
      `landlord claim superseded, not deleted: ${JSON.stringify(sup)}`,
    );
    assert(
      sup.some((x) => x.party_type === 'tenant' && x.source === 'human_link'
        && x.superseded_at === null),
      `tenant claim live as human_link: ${JSON.stringify(sup)}`,
    );

    // THE regression: the link is in effect — new mail from the address now
    // resolves as the tenant into the linked conversation (before PR 2 the
    // link's learning silently no-opped against the landlord row).
    const next = assertStatus(await personaCapture({
      from_address: SUP_EMAIL, body: 'me again, post-link',
      rfc822_message_id: `<pv2-sup-2-${SUFFIX}@sender>`,
    }), 200, 'post-link capture') as CaptureShape;
    assert(next.disposition === 'matched', `post-link disposition: ${next.disposition}`);
    assert(next.participant?.party_id === supTenantId,
      `resolves as the linked tenant: ${JSON.stringify(next.participant)}`);
    assert(next.thread_id === linked.thread_id, `into the linked thread: ${next.thread_id}`);
  });

  // Two humans who disagree are reconciled by humans: linking against a
  // DIFFERENT party's live human claim fails loudly and changes nothing.
  const HC_EMAIL = `pv2-hc-${SUFFIX}@dual.test`;
  const hcTenantX = await createTenant('Human Claim X', `pv2-hc-x-${SUFFIX}@tenant.test`);
  const hcTenantY = await createTenant('Human Claim Y', `pv2-hc-y-${SUFFIX}@tenant.test`);
  {
    const { error } = await admin.from('channel_identities').insert({
      account_id: accountId, party_type: 'tenant', party_id: hcTenantX,
      channel: 'email', address: HC_EMAIL, source: 'human_link',
    });
    if (error) throw new Error(`human-conflict seed: ${error.message}`);
  }

  await check('claims(4) linking against a different human claim → 409 conflicting human claim', async () => {
    // An auth-failed capture from the human-claimed address triages (the
    // claim makes it auth_failed, not unknown) — giving a linkable row.
    const r = assertStatus(await personaCapture({
      from_address: HC_EMAIL, body: 'could not authenticate',
      rfc822_message_id: `<pv2-hc-1-${SUFFIX}@sender>`, auth_results: AUTH_FAIL,
    }), 200, 'auth-fail capture') as CaptureShape;
    assert(r.disposition === 'triaged', `disposition: ${r.disposition}`);
    const { data: u } = await admin
      .from('comm_unmatched_inbound').select('reason').eq('id', r.unmatched_id!).single();
    assert(u!.reason === 'auth_failed', `reason: ${u!.reason}`);

    const bad = await api('POST', `${base}/unmatched/${r.unmatched_id}/link`, {
      token: landlordToken, body: { party_type: 'tenant', party_id: hcTenantY },
    });
    assertStatus(bad, 409, 'link against a human claim');
    assert(JSON.stringify(bad.body).includes('conflicting human claim'),
      `explicit error: ${JSON.stringify(bad.body)}`);

    // The claim is untouched, and linking to the SAME human-claimed party
    // still works (attested — the stored verdicts failed).
    const { data: claim } = await admin
      .from('channel_identities').select('party_id, source, superseded_at')
      .eq('account_id', accountId).eq('channel', 'email').eq('address', HC_EMAIL)
      .single();
    assert(claim!.party_id === hcTenantX && claim!.source === 'human_link'
      && claim!.superseded_at === null, `claim untouched: ${JSON.stringify(claim)}`);
    const ok = await api('POST', `${base}/unmatched/${r.unmatched_id}/link`, {
      token: landlordToken, body: { party_type: 'tenant', party_id: hcTenantX },
    });
    const okRes = assertStatus(ok, 200, 'link to the claimed party') as { interaction_id: string };
    const { data: j } = await admin
      .from('interactions').select('attestation').eq('id', okRes.interaction_id).single();
    assert(j!.attestation === 'attested', `attestation: ${j!.attestation}`);
  });

  // Mixed-case addresses normalize to one lookup key at the door.
  const MC_EMAIL_LOWER = `pv2-mixed-${SUFFIX}@tenant.test`;
  const mcTenantId = await createTenant('Mixed Case', `pv2-mc-record-${SUFFIX}@tenant.test`);

  await check('claims(5) mixed-case writes normalize to one claim; resolution hits it', async () => {
    {
      const { error } = await admin.from('channel_identities').insert({
        account_id: accountId, party_type: 'tenant', party_id: mcTenantId,
        channel: 'email', address: `  PV2-Mixed-${SUFFIX}@Tenant.TEST `, source: 'provider_learned',
      });
      if (error) throw new Error(`mixed-case seed: ${error.message}`);
    }
    const { data: stored } = await admin
      .from('channel_identities').select('address')
      .eq('account_id', accountId).eq('channel', 'email')
      .eq('party_type', 'tenant').eq('party_id', mcTenantId);
    assert(stored?.length === 1 && stored[0]!.address === MC_EMAIL_LOWER,
      `stored normalized: ${JSON.stringify(stored)}`);

    // Re-upserting the same claim under a different casing collides on the
    // claim key instead of minting a second row.
    const { error: dupErr } = await admin.from('channel_identities').upsert(
      {
        account_id: accountId, party_type: 'tenant', party_id: mcTenantId,
        channel: 'email', address: `PV2-MIXED-${SUFFIX}@tenant.test`, source: 'provider_learned',
      },
      {
        onConflict: 'account_id,channel,address,party_type,party_id,scope_type,scope_id',
        ignoreDuplicates: true,
      },
    );
    assert(!dupErr, `dup upsert: ${dupErr?.message}`);
    const { count } = await admin
      .from('channel_identities').select('id', { count: 'exact', head: true })
      .eq('account_id', accountId).eq('channel', 'email').eq('address', MC_EMAIL_LOWER);
    assert(count === 1, `one claim after case-variant upsert: ${count}`);

    const r = assertStatus(await personaCapture({
      from_address: MC_EMAIL_LOWER, body: 'case folded',
      rfc822_message_id: `<pv2-mc-1-${SUFFIX}@sender>`,
    }), 200, 'mixed-case capture') as CaptureShape;
    assert(r.disposition === 'matched' && r.participant?.party_id === mcTenantId,
      `one lookup key: ${JSON.stringify(r.participant)}`);
  });

  // Snapshot resolution records the selected source and ignores superseded
  // claims.
  const SS_EMAIL = `pv2-snap-${SUFFIX}@dual.test`;
  const ssTenantId = await createTenant('Snap Human', `pv2-snap-record-${SUFFIX}@tenant.test`);
  {
    const { error } = await admin.from('channel_identities').insert([
      {
        account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
        channel: 'email', address: SS_EMAIL, source: 'provider_learned',
        superseded_at: iso(),
      },
      {
        account_id: accountId, party_type: 'tenant', party_id: ssTenantId,
        channel: 'email', address: SS_EMAIL, source: 'human_link',
      },
    ]);
    if (error) throw new Error(`snapshot seed: ${error.message}`);
  }

  await check('claims(6) outbox snapshot stamps the winning claim tier; superseded claims are invisible', async () => {
    const sent = await api('POST', `${base}/outbox`, {
      token: landlordToken,
      body: {
        channel: 'email',
        to_address: SS_EMAIL,
        subject: 'Claim-resolved send',
        body: 'snapshot source probe',
        approval_ref: `self:${sub.user.id}`,
      },
    });
    const row = assertStatus(sent, 201, 'snapshot intent') as { id: string };
    const { data: snapRow } = await admin
      .from('comm_outbox').select('recipient_snapshot').eq('id', row.id).single();
    const snap = (snapRow!.recipient_snapshot ?? []) as Array<{
      party_type: string; party_id: string | null; resolution_source?: string;
    }>;
    assert(snap[0]!.party_type === 'tenant' && snap[0]!.party_id === ssTenantId,
      `live human claim resolved (superseded landlord ignored): ${JSON.stringify(snap)}`);
    assert(snap[0]!.resolution_source === 'human_link',
      `winning tier stamped: ${JSON.stringify(snap)}`);
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
    const disposition = res.headers.get('content-disposition') ?? '';
    assert(disposition.startsWith('attachment;'), `disposition attachment: ${disposition}`);
    assert(disposition.includes('deposit-photos.pdf'), 'disposition filename');
    assert(res.headers.get('x-content-type-options') === 'nosniff', 'nosniff forced');
    assert(res.headers.get('cache-control') === 'private, no-store', `cache-control: ${res.headers.get('cache-control')}`);
    assert(
      (res.headers.get('content-security-policy') ?? '').includes('sandbox'),
      `csp sandbox: ${res.headers.get('content-security-policy')}`,
    );
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

  await check('control characters in filename → 400', async () => {
    // A CR/LF in the filename would be rendered into the download's
    // content-disposition header; undici throws on such a value. Reject at
    // ingest rather than store an un-downloadable attachment.
    const r = await api('POST', `/v1/accounts/${accountId}/interactions/${t1FirstIid}/attachments`, {
      token: agentToken,
      body: { filename: 'evil\r\nx.pdf', content_type: 'application/pdf', data_b64: FILE_B64 },
    });
    assertStatus(r, 400, 'control-char filename');
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
