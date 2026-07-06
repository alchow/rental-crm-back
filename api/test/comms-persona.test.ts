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
  // (7) Guards
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
