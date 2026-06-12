// ----------------------------------------------------------------------------
// Outbound messaging integration tests (agent-api plan Workstream E; ADR-0007).
//
// Covers:
//   (a) landlord send to tenant → 201; provider called once with E.164; outbox
//       'sent' + provider_sid; interaction channel/direction/party/author; GET
//       /interactions/{id} shows delivery_status 'sent'; chain has outbox+
//       interaction events.
//   (b) agent without approval_ref → 400; with → 201, interaction
//       author_type='agent', approval_ref persisted; outbox author_type='agent'.
//   (c) landlord with approval_ref → 400.
//   (d) recipient with no phone (tenant phones=[]) → 422 no_sms_destination;
//       provider NOT called; NO outbox row.
//   (e) opt-out: insert phone into sms_opt_outs → 409 sms_opted_out; no call; no outbox.
//   (f) idempotency: key K → 201; same key replay → identical body, provider
//       called exactly ONCE total; same key different body → 409.
//   (g) rejected provider error → 422 send_failed; outbox 'failed' with error
//       fields; NO interaction; chain intact.
//   (h) unknown provider error → 409 send_state_unknown; outbox stays
//       'sending'; replay same key → 409 from cache, provider called ONCE total.
//       GET /messages/{id} shows 'sending'.
//   (i) normalization: vendor send ('+1 (555) 222-3333' → '+15552223333');
//       tenant with '5551234567' (10 digits) → 422; '15551234567' → provider
//       receives '+15551234567'.
//   (j) honesty backstop: direct PostgREST insert via agent session:
//       author_type='landlord' → DB error; kind='communication' external_ref=null
//       → DB error; landlord direct insert → succeeds.
//   (k) messaging unconfigured: clear TWILIO_* env → 503 messaging_unconfigured.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

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
// Fake Twilio config so the send path does not 503 messaging_unconfigured.
process.env.TWILIO_ACCOUNT_SID = 'ACfake00000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'authtoken_fake_00000000000000000';
process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGfake0000000000000000000000000';
process.env.PUBLIC_BASE_URL = 'https://test.example.com';

// Create the agent auth user BEFORE importing app.
const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const adminForSetup = getAdminClient();

const agentEmail = `msg-agent-${crypto.randomUUID()}@internal.test`;
const agentPassword = `agent-pass-${crypto.randomUUID()}`;
const { data: agentAuthData, error: agentCreateErr } = await adminForSetup.auth.admin.createUser({
  email: agentEmail,
  password: agentPassword,
  email_confirm: true,
});
if (agentCreateErr || !agentAuthData?.user) {
  throw new Error(`Failed to create agent auth user: ${agentCreateErr?.message}`);
}
const AGENT_USER_ID = agentAuthData.user.id;
process.env.AGENT_USER_ID = AGENT_USER_ID;

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();

// Inject a fake provider BEFORE the app imports provider.ts.
import type { MessagingProvider, SendSmsArgs, SendSmsResult } from '../src/messaging/provider';
const { _setMessagingProviderForTests, ProviderError } = await import('../src/messaging/provider');

// Programmable fake provider.
const calls: SendSmsArgs[] = [];
let fakeOutcome: (() => SendSmsResult) | (() => never) = () => ({ sid: `SM${crypto.randomUUID().replace(/-/g, '')}` });

const fakeProvider: MessagingProvider = {
  async sendSms(args) {
    calls.push(args);
    return fakeOutcome();
  },
};
_setMessagingProviderForTests(fakeProvider);

const { buildApp } = await import('../src/app');
const app = buildApp();

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
    headers['idempotency-key'] = opts.idempotencyKey ?? `msg-${crypto.randomUUID()}`;
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
  if (r.status !== expected) {
    throw new Error(`${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`);
  }
  return r.body;
}
function errCode(r: ApiResp): string {
  return ((r.body as { error?: { code?: string } })?.error?.code) ?? '';
}

interface UserFixture {
  userId: string;
  accessToken: string;
  accountId: string;
  tenancyId: string;
  tenantId: string;
  vendorId: string;
}

async function setupUser(label: string, opts?: { tenantPhones?: string[]; vendorPhone?: string }): Promise<UserFixture> {
  const email = `msg-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Msg Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label}: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { user: { id: string }; account: { id: string }; session: { access_token: string } };
  const token = b.session.access_token;
  const accountId = b.account.id;

  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token, body });
    if (r.status !== 201) throw new Error(`setup POST ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };

  const property = await post<{ id: string }>(`/v1/accounts/${accountId}/properties`, { name: `${label} prop` });
  const unitArea = await post<{ id: string }>(`/v1/accounts/${accountId}/areas`, {
    property_id: property.id, kind: 'unit', name: `${label} unit`,
  });
  const tenancy = await post<{ id: string }>(`/v1/accounts/${accountId}/tenancies`, {
    area_id: unitArea.id, start_date: '2026-01-01', status: 'active',
  });

  const tenantPhones = opts?.tenantPhones ?? ['+15550001111'];
  const tenant = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, {
    full_name: `${label} Tenant`,
    phones: tenantPhones,
  });

  const vendorPhone = opts?.vendorPhone ?? '+1 (555) 222-3333';
  const vendor = await post<{ id: string }>(`/v1/accounts/${accountId}/vendors`, {
    name: `${label} Vendor`,
    contact: { phone: vendorPhone },
  });

  return { userId: b.user.id, accessToken: token, accountId, tenancyId: tenancy.id, tenantId: tenant.id, vendorId: vendor.id };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Outbound messaging integration tests');

  // Shared landlord + agent setup.
  const landlord = await setupUser('landlord');
  const { accountId } = landlord;
  const admin = getAdminClient();

  // Insert agent membership.
  const { error: memberErr } = await admin.from('account_members').insert({
    account_id: accountId,
    user_id: AGENT_USER_ID,
    role: 'agent',
  });
  if (memberErr) throw new Error(`Failed to insert agent membership: ${memberErr.message}`);

  // Obtain agent access token.
  const loginResp = await api('POST', '/v1/auth/login', { body: { email: agentEmail, password: agentPassword } });
  if (loginResp.status !== 200) throw new Error(`Agent login: ${loginResp.status} ${JSON.stringify(loginResp.body)}`);
  const agentToken = ((loginResp.body as { session: { access_token: string } }).session).access_token;

  const msgBase = `/v1/accounts/${accountId}/messages`;
  const iBase = `/v1/accounts/${accountId}/interactions`;

  const landlordSend = (body: Record<string, unknown>, key?: string) =>
    api('POST', msgBase, { token: landlord.accessToken, body, idempotencyKey: key });
  const agentSend = (body: Record<string, unknown>, key?: string) =>
    api('POST', msgBase, { token: agentToken, body, idempotencyKey: key });

  // Reset call log helper.
  const resetCalls = () => { calls.length = 0; };
  const setSuccess = (sid?: string) => {
    const s = sid ?? `SM${crypto.randomUUID().replace(/-/g, '')}`;
    fakeOutcome = () => ({ sid: s });
    return s;
  };
  const setRejected = (code: string, msg: string) => {
    fakeOutcome = () => { throw new ProviderError('rejected', code, msg); };
  };
  const setUnknown = (msg: string) => {
    fakeOutcome = () => { throw new ProviderError('unknown', null, msg); };
  };

  // =========================================================================
  // (a) landlord send to tenant → 201; provider called once with E.164;
  //     outbox 'sent' + provider_sid; interaction attrs; delivery_status; chain.
  // =========================================================================
  await check('(a) landlord send → 201, correct interaction, chain events', async () => {
    resetCalls();
    const expectedSid = setSuccess();

    const r = await landlordSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Hello from landlord.',
      tenancy_id: landlord.tenancyId,
    });
    const body = assertStatus(r, 201, 'landlord send') as Record<string, unknown>;

    if (calls.length !== 1) throw new Error(`provider calls: ${calls.length}`);
    if (calls[0]!.to !== '+15550001111') throw new Error(`to: ${calls[0]!.to}`);
    if (body.status !== 'sent') throw new Error(`status: ${body.status}`);
    if (body.provider_sid !== expectedSid) throw new Error(`provider_sid: ${body.provider_sid}`);

    const outboxId = body.outbox_id as string;
    const interaction = body.interaction as Record<string, unknown>;

    if (interaction.channel !== 'sms') throw new Error(`channel: ${interaction.channel}`);
    if (interaction.direction !== 'outbound') throw new Error(`direction: ${interaction.direction}`);
    if (interaction.party_type !== 'tenant') throw new Error(`party_type: ${interaction.party_type}`);
    if (interaction.party_id !== landlord.tenantId) throw new Error(`party_id: ${interaction.party_id}`);
    if (interaction.author_type !== 'landlord') throw new Error(`author_type: ${interaction.author_type}`);
    if (interaction.external_ref !== expectedSid) throw new Error(`external_ref: ${interaction.external_ref}`);
    if (interaction.approval_ref !== null) throw new Error(`approval_ref: ${interaction.approval_ref}`);

    // GET /interactions/{id} shows delivery_status='sent'.
    const iId = interaction.id as string;
    const iGet = await api('GET', `${iBase}/${iId}`, { token: landlord.accessToken });
    const iBody = assertStatus(iGet, 200, 'get interaction') as Record<string, unknown>;
    if (iBody.delivery_status !== 'sent') throw new Error(`delivery_status on interaction: ${iBody.delivery_status}`);

    // Chain: outbox insert + update events AND interaction insert event exist.
    const { data: events, error: evErr } = await admin
      .from('events')
      .select('entity_type, event_type')
      .eq('account_id', accountId)
      .order('occurred_at', { ascending: true });
    if (evErr) throw new Error(`events query: ${evErr.message}`);

    const outboxInserted = (events ?? []).some(
      (e) => e.entity_type === 'message_outbox' && e.event_type === 'inserted',
    );
    const outboxUpdated = (events ?? []).some(
      (e) => e.entity_type === 'message_outbox' && e.event_type === 'updated',
    );
    const interactionInserted = (events ?? []).some(
      (e) => e.entity_type === 'interactions' && e.event_type === 'inserted',
    );
    if (!outboxInserted) throw new Error('no outbox inserted event in chain');
    if (!outboxUpdated) throw new Error('no outbox updated event in chain');
    if (!interactionInserted) throw new Error('no interaction inserted event in chain');

    // Verify outbox GET.
    const outboxGet = await api('GET', `${msgBase}/${outboxId}`, { token: landlord.accessToken });
    const ob = assertStatus(outboxGet, 200, 'outbox GET') as Record<string, unknown>;
    if (ob.status !== 'sent') throw new Error(`outbox status: ${ob.status}`);
    if (ob.provider_sid !== expectedSid) throw new Error(`outbox provider_sid: ${ob.provider_sid}`);
  });

  // =========================================================================
  // (b) agent without approval_ref → 400; with → 201, author_type='agent',
  //     approval_ref persisted; outbox author_type='agent'.
  // =========================================================================
  await check('(b) agent without approval_ref → 400', async () => {
    const r = await agentSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Agent msg no ref.',
    });
    assertStatus(r, 400, 'agent no ref');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  await check('(b) agent with approval_ref → 201, author_type=agent', async () => {
    resetCalls();
    const sid = setSuccess();

    const r = await agentSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Agent authorised msg.',
      approval_ref: 'prop-agent-001',
    });
    const body = assertStatus(r, 201, 'agent send') as Record<string, unknown>;
    const interaction = body.interaction as Record<string, unknown>;

    if (interaction.author_type !== 'agent') throw new Error(`author_type: ${interaction.author_type}`);
    if (interaction.approval_ref !== 'prop-agent-001') throw new Error(`approval_ref: ${interaction.approval_ref}`);
    if (interaction.external_ref !== sid) throw new Error(`external_ref: ${interaction.external_ref}`);

    // Verify outbox author_type.
    const ob = await admin
      .from('message_outbox')
      .select('author_type, approval_ref')
      .eq('id', body.outbox_id as string)
      .single();
    if (ob.data?.author_type !== 'agent') throw new Error(`outbox author_type: ${ob.data?.author_type}`);
    if (ob.data?.approval_ref !== 'prop-agent-001') throw new Error(`outbox approval_ref: ${ob.data?.approval_ref}`);
  });

  // =========================================================================
  // (c) landlord with approval_ref → 400
  // =========================================================================
  await check('(c) landlord with approval_ref → 400', async () => {
    const r = await landlordSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Landlord msg with ref.',
      approval_ref: 'sneaky-ref',
    });
    assertStatus(r, 400, 'landlord with ref');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  // =========================================================================
  // (d) recipient with no usable phone → 422 no_sms_destination; no call; no outbox.
  // =========================================================================
  await check('(d) tenant with no phone → 422 no_sms_destination', async () => {
    // Create a tenant with empty phones array.
    const nophone = await setupUser('nophone', { tenantPhones: [] });
    resetCalls();

    // Use a member of THAT account (nophone landlord), not the shared one.
    const r = await api('POST', `/v1/accounts/${nophone.accountId}/messages`, {
      token: nophone.accessToken,
      body: {
        channel: 'sms',
        recipient_type: 'tenant',
        recipient_id: nophone.tenantId,
        body: 'No phone.',
      },
    });
    assertStatus(r, 422, 'no phone');
    if (errCode(r) !== 'no_sms_destination') throw new Error(`code: ${errCode(r)}`);
    if (calls.length !== 0) throw new Error(`provider called: ${calls.length}`);

    // No outbox row written.
    const { data: rows } = await admin
      .from('message_outbox')
      .select('id')
      .eq('account_id', nophone.accountId);
    if ((rows ?? []).length !== 0) throw new Error(`outbox rows exist: ${rows?.length}`);
  });

  // =========================================================================
  // (e) opt-out: insert phone into sms_opt_outs → 409 sms_opted_out; no call; no outbox.
  // =========================================================================
  await check('(e) opted-out phone → 409 sms_opted_out; no call; no outbox row', async () => {
    const optedPhone = '+15550001111'; // landlord.tenantId's phones[0]

    // Insert opt-out via admin (service-role bypasses the deny-all RLS).
    const { error: optErr } = await admin.from('sms_opt_outs').insert({ phone: optedPhone });
    if (optErr) throw new Error(`opt-out insert: ${optErr.message}`);

    resetCalls();
    const before = Date.now();

    try {
      const r = await landlordSend({
        channel: 'sms',
        recipient_type: 'tenant',
        recipient_id: landlord.tenantId,
        body: 'Opt-out test.',
      });
      assertStatus(r, 409, 'opted-out');
      if (errCode(r) !== 'sms_opted_out') throw new Error(`code: ${errCode(r)}`);
      if (calls.length !== 0) throw new Error(`provider called: ${calls.length}`);

      // No new outbox row after the opt-out check.
      const { data: rows } = await admin
        .from('message_outbox')
        .select('id, created_at')
        .eq('account_id', accountId);
      const newRows = (rows ?? []).filter(
        (row: { created_at: string }) => new Date(row.created_at).getTime() >= before,
      );
      if (newRows.length !== 0) throw new Error(`new outbox rows exist: ${newRows.length}`);
    } finally {
      // Clean up: remove the opt-out row so subsequent tests are not affected.
      await admin.from('sms_opt_outs').delete().eq('phone', optedPhone);
    }
  });

  // =========================================================================
  // (f) idempotency: same key → 201 replay; provider called ONCE total;
  //     same key different body → 409.
  // =========================================================================
  await check('(f) idempotency replay: same key returns original, provider called once', async () => {
    resetCalls();
    const idempotentSid = setSuccess();
    const key = `msg-idem-${crypto.randomUUID()}`;

    const r1 = await landlordSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Idempotent msg.',
    }, key);
    const b1 = assertStatus(r1, 201, 'first send') as Record<string, unknown>;
    if (calls.length !== 1) throw new Error(`first: provider calls ${calls.length}`);

    // Same key, same body → replay.
    const r2 = await landlordSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Idempotent msg.',
    }, key);
    const b2 = assertStatus(r2, 201, 'replay') as Record<string, unknown>;
    // Provider must not have been called again.
    if (calls.length !== 1) throw new Error(`replay: provider calls ${calls.length}`);
    // Key fields from the cached response must match the original.
    if (b1.outbox_id !== b2.outbox_id) throw new Error(`replay outbox_id mismatch: ${b1.outbox_id} vs ${b2.outbox_id}`);
    if (b1.provider_sid !== b2.provider_sid) throw new Error(`replay provider_sid mismatch: ${b1.provider_sid} vs ${b2.provider_sid}`);
    if (b1.status !== b2.status) throw new Error(`replay status mismatch: ${b1.status} vs ${b2.status}`);
    if ((b1.interaction as Record<string, unknown>).id !== (b2.interaction as Record<string, unknown>).id) {
      throw new Error('replay interaction.id mismatch');
    }
    // Confirm the SID matches what the provider returned.
    if (b1.provider_sid !== idempotentSid) throw new Error(`provider_sid: ${b1.provider_sid}`);
  });

  await check('(f) same key different body → 409 conflict', async () => {
    resetCalls();
    setSuccess();
    const key = `msg-diff-${crypto.randomUUID()}`;

    const r1 = await landlordSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Original body.',
    }, key);
    assertStatus(r1, 201, 'original');

    const r2 = await landlordSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Different body.',
    }, key);
    assertStatus(r2, 409, 'conflict');
    if (errCode(r2) !== 'conflict') throw new Error(`code: ${errCode(r2)}`);
  });

  // =========================================================================
  // (g) rejected provider error → 422 send_failed; outbox 'failed';
  //     NO interaction; chain intact.
  // =========================================================================
  await check('(g) rejected provider → 422 send_failed; outbox failed; no interaction', async () => {
    resetCalls();
    setRejected('21610', 'Attempt to send to unsubscribed recipient');

    const before = Date.now();
    const r = await landlordSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Will be rejected.',
    });
    assertStatus(r, 422, 'rejected');
    if (errCode(r) !== 'send_failed') throw new Error(`code: ${errCode(r)}`);

    // Outbox row should be 'failed'.
    const { data: rows } = await admin
      .from('message_outbox')
      .select('status, error_code, interaction_id, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1);
    const row = (rows ?? [])[0];
    if (!row) throw new Error('no outbox row found');
    if (new Date(row.created_at as string).getTime() < before) throw new Error('stale outbox row');
    if (row.status !== 'failed') throw new Error(`outbox status: ${row.status}`);
    if (row.error_code !== '21610') throw new Error(`outbox error_code: ${row.error_code}`);
    if (row.interaction_id !== null) throw new Error(`outbox interaction_id should be null: ${row.interaction_id}`);

    // Chain verification: verify_chain returns ok.
    const { data: chain } = await admin.rpc('verify_chain', { p_account_id: accountId });
    const chainRow = Array.isArray(chain) ? chain[0] : chain;
    if (!(chainRow as { ok: boolean }).ok) throw new Error('chain broken after rejected send');
  });

  // =========================================================================
  // (h) unknown provider error → 409 send_state_unknown; outbox 'sending';
  //     replay same key → 409 from cache; provider called ONCE;
  //     GET /messages/{id} → 'sending'.
  // =========================================================================
  await check('(h) unknown provider → 409 send_state_unknown; outbox stays sending; replay from cache', async () => {
    resetCalls();
    setUnknown('Connection timeout');

    const key = `msg-unknown-${crypto.randomUUID()}`;
    const before = Date.now();

    const r1 = await landlordSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Will timeout.',
    }, key);
    assertStatus(r1, 409, 'unknown first');
    if (errCode(r1) !== 'send_state_unknown') throw new Error(`code: ${errCode(r1)}`);
    if (calls.length !== 1) throw new Error(`first: provider calls ${calls.length}`);

    // Outbox stays 'sending'.
    const outboxId = ((r1.body as { error: { details: { outbox_id?: string } } }).error?.details?.outbox_id) ?? null;
    if (outboxId === null) {
      // Fall back to admin query.
    }

    const { data: rows } = await admin
      .from('message_outbox')
      .select('id, status, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1);
    const row = (rows ?? [])[0];
    if (!row) throw new Error('no outbox row');
    if (new Date(row.created_at as string).getTime() < before) throw new Error('stale outbox row');
    if (row.status !== 'sending') throw new Error(`outbox status: ${row.status}`);

    // GET /messages/{id} shows 'sending'.
    const obGet = await api('GET', `${msgBase}/${row.id as string}`, { token: landlord.accessToken });
    const obBody = assertStatus(obGet, 200, 'outbox GET') as Record<string, unknown>;
    if (obBody.status !== 'sending') throw new Error(`outbox GET status: ${obBody.status}`);

    // Replay: same key → cached 409 from idempotency middleware.
    const r2 = await landlordSend({
      channel: 'sms',
      recipient_type: 'tenant',
      recipient_id: landlord.tenantId,
      body: 'Will timeout.',
    }, key);
    assertStatus(r2, 409, 'unknown replay');
    // Provider NOT called again.
    if (calls.length !== 1) throw new Error(`replay: provider calls ${calls.length}`);
  });

  // =========================================================================
  // (i) normalization: vendor send; 10-digit NANP; 11-digit NANP.
  // =========================================================================
  await check('(i) vendor send: "+1 (555) 222-3333" normalises to "+15552223333"', async () => {
    resetCalls();
    setSuccess();

    const r = await landlordSend({
      channel: 'sms',
      recipient_type: 'vendor',
      recipient_id: landlord.vendorId,
      body: 'Vendor msg.',
    });
    assertStatus(r, 201, 'vendor send');
    if (calls.length !== 1) throw new Error(`calls: ${calls.length}`);
    if (calls[0]!.to !== '+15552223333') throw new Error(`vendor to: ${calls[0]!.to}`);
  });

  await check('(i) tenant with 10-digit phone ("5551234567") → 422 no_sms_destination', async () => {
    const u = await setupUser('10digit', { tenantPhones: ['5551234567'] });
    resetCalls();

    const r = await api('POST', `/v1/accounts/${u.accountId}/messages`, {
      token: u.accessToken,
      body: { channel: 'sms', recipient_type: 'tenant', recipient_id: u.tenantId, body: 'test' },
    });
    assertStatus(r, 422, '10-digit no-area-code');
    if (errCode(r) !== 'no_sms_destination') throw new Error(`code: ${errCode(r)}`);
    if (calls.length !== 0) throw new Error(`calls: ${calls.length}`);
  });

  await check('(i) tenant with "15551234567" (11-digit NANP) → provider receives "+15551234567"', async () => {
    const u = await setupUser('11digit', { tenantPhones: ['15551234567'] });
    resetCalls();
    setSuccess();

    const r = await api('POST', `/v1/accounts/${u.accountId}/messages`, {
      token: u.accessToken,
      body: { channel: 'sms', recipient_type: 'tenant', recipient_id: u.tenantId, body: 'test' },
    });
    assertStatus(r, 201, '11-digit send');
    if (calls.length !== 1) throw new Error(`calls: ${calls.length}`);
    if (calls[0]!.to !== '+15551234567') throw new Error(`to: ${calls[0]!.to}`);
  });

  // =========================================================================
  // (j) honesty backstop: direct PostgREST inserts.
  // =========================================================================
  await check('(j) agent direct insert author_type=landlord → DB error', async () => {
    // Get agent's session token for a raw supabase-js client.
    const agentClient = createClient(status.API_URL, status.ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: loginErr } = await agentClient.auth.signInWithPassword({
      email: agentEmail,
      password: agentPassword,
    });
    if (loginErr) throw new Error(`agent login: ${loginErr.message}`);

    // Direct insert: agent with author_type='landlord' — must be blocked.
    const { error } = await agentClient.from('interactions').insert({
      account_id: accountId,
      actor: `user:${AGENT_USER_ID}`,
      author_type: 'landlord', // invariant violation
      kind: 'note',
      channel: 'note',
      direction: 'none',
      party_type: 'none',
      party_id: null,
      party_label: null,
      occurred_at: new Date().toISOString(),
      body: 'Attempted bypass.',
    });
    if (!error) throw new Error('expected DB error, got success');
    // The error message should mention agent_capacity or the check_violation.
    if (!error.message.toLowerCase().includes('agent')) {
      throw new Error(`unexpected error message: ${error.message}`);
    }
  });

  await check('(j) agent direct insert kind=communication external_ref=null → DB error', async () => {
    const agentClient = createClient(status.API_URL, status.ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await agentClient.auth.signInWithPassword({ email: agentEmail, password: agentPassword });

    const { error } = await agentClient.from('interactions').insert({
      account_id: accountId,
      actor: `user:${AGENT_USER_ID}`,
      author_type: 'agent',
      kind: 'communication',
      channel: 'sms',
      direction: 'outbound',
      party_type: 'tenant',
      party_id: landlord.tenantId,
      party_label: null,
      occurred_at: new Date().toISOString(),
      body: 'Fake communication.',
      external_ref: null, // invariant violation: must have SID
    });
    if (!error) throw new Error('expected DB error, got success');
  });

  await check('(j) landlord direct insert kind=communication → succeeds (unchanged behavior)', async () => {
    const { data, error } = await admin.from('interactions').insert({
      account_id: accountId,
      actor: `user:${landlord.userId}`,
      author_type: 'landlord',
      kind: 'communication',
      channel: 'phone',
      direction: 'inbound',
      party_type: 'tenant',
      party_id: landlord.tenantId,
      party_label: null,
      occurred_at: new Date().toISOString(),
      body: 'Direct landlord insert.',
    }).select('id').single();
    if (error) throw new Error(`landlord direct insert: ${error.message}`);
    if (!data) throw new Error('no row returned');
  });

  // =========================================================================
  // (k) messaging unconfigured: clear TWILIO_* env → 503 messaging_unconfigured.
  // =========================================================================
  await check('(k) messaging unconfigured → 503', async () => {
    const { _resetEnvCacheForTests: resetEnv } = await import('../src/env');

    const savedSid = process.env.TWILIO_ACCOUNT_SID;
    const savedToken = process.env.TWILIO_AUTH_TOKEN;
    const savedMsgSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

    try {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_MESSAGING_SERVICE_SID;
      resetEnv();

      const r = await landlordSend({
        channel: 'sms',
        recipient_type: 'tenant',
        recipient_id: landlord.tenantId,
        body: 'Should 503.',
      });
      assertStatus(r, 503, 'unconfigured');
      if (errCode(r) !== 'messaging_unconfigured') throw new Error(`code: ${errCode(r)}`);
    } finally {
      process.env.TWILIO_ACCOUNT_SID = savedSid;
      process.env.TWILIO_AUTH_TOKEN = savedToken;
      process.env.TWILIO_MESSAGING_SERVICE_SID = savedMsgSid;
      resetEnv();
    }
  });

  // --- done -----------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:`);
    for (const f of failures) {
      console.error(`  FAIL  ${f.name}: ${f.detail}`);
    }
    process.exit(1);
  }
  console.info('All checks passed.');
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
