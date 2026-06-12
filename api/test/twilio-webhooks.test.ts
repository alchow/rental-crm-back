// ----------------------------------------------------------------------------
// Twilio webhook integration tests (agent-api plan Phase 5).
//
// Covers:
//   (a) inbound from tenant phone, valid signature → 200; journal interaction
//       exists: direction inbound, channel sms, author_type 'tenant', party_id=
//       tenant, external_ref=MessageSid, actor 'system:twilio-inbound'; raw row
//       matched.
//   (b) invalid signature → 403; no raw row, no interaction.
//   (c) duplicate MessageSid replay → 200; exactly one raw row + one interaction.
//   (d) unmatched number → 200; raw row 'unmatched'; no interaction; NO
//       tenant/vendor created (count before/after).
//   (e) ambiguous: second account shares same tenant phone → 'ambiguous'; no
//       interaction in either account.
//   (f) STOP from tenant phone → opt-out row exists; journal interaction
//       recorded; subsequent POST /messages send → 409 sms_opted_out; START →
//       opt-out cleared; send succeeds again (fake provider).
//   (g) vendor inbound → author_type 'vendor'.
//   (h) status callback: send via fake provider → POST /v1/twilio/status
//       (delivered) → outbox 'delivered' + delivered_at set; GET /interactions
//       delivery_status 'delivered'; late 'sent' callback → still 'delivered';
//       verify_chain ok.
//   (i) crash-window recovery: outbox row 'sending' with no provider_sid → status
//       callback 'sent' with MessageSid → complete_sms_send_system runs → outbox
//       'sent' + interaction appended with author_type preserved, actor
//       'system:twilio-status'.
//   (j) status callback unknown outbox_id → 200, no effect; malformed → 400.
//   (k) reconcile janitor: stale 'sending' row backdated 2h → reconcile →
//       'needs_reconcile'; fresh 'sending' row untouched.
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
const FAKE_AUTH_TOKEN = 'authtoken_fake_tw_00000000000';
const FAKE_BASE_URL   = 'https://test.example.com';

process.env.NODE_ENV                    = 'test';
process.env.PORT                        = '8796';
process.env.SUPABASE_URL                = status.API_URL;
process.env.SUPABASE_ANON_KEY           = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY   = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL           = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER         = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE       = 'authenticated';
process.env.TWILIO_ACCOUNT_SID          = 'ACfake00000000000000000000000tw';
process.env.TWILIO_AUTH_TOKEN           = FAKE_AUTH_TOKEN;
process.env.TWILIO_MESSAGING_SERVICE_SID = 'MGfake00000000000000000000000tw';
process.env.PUBLIC_BASE_URL             = FAKE_BASE_URL;

const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const admin = getAdminClient();

// Create agent auth user before imports.
const agentEmail    = `tw-agent-${crypto.randomUUID()}@internal.test`;
const agentPassword = `agent-pass-tw-${crypto.randomUUID()}`;
const { data: agentAuthData, error: agentCreateErr } = await admin.auth.admin.createUser({
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

// Inject fake messaging provider BEFORE app import.
import type { MessagingProvider, SendSmsArgs, SendSmsResult } from '../src/messaging/provider';
const { _setMessagingProviderForTests } = await import('../src/messaging/provider');

const calls: SendSmsArgs[] = [];
let fakeOutcome: (() => SendSmsResult) | (() => never) =
  () => ({ sid: `SM${crypto.randomUUID().replace(/-/g, '')}` });

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
// Helpers
// ---------------------------------------------------------------------------

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

async function api(
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: unknown;
    idempotencyKey?: string;
    formBody?: Record<string, string>;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.extraHeaders };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = opts.idempotencyKey ?? `tw-${crypto.randomUUID()}`;
  }

  let init: RequestInit = { method, headers };

  if (opts.formBody !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    init = {
      ...init,
      body: Object.entries(opts.formBody)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&'),
    };
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }

  const res = await app.fetch(new Request(`http://test${path}`, init));
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, headers: responseHeaders };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

/** Compute a valid Twilio X-Twilio-Signature for a URL + form params. */
function computeSig(url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let toSign = url;
  for (const key of sortedKeys) toSign += key + (params[key] ?? '');
  return createHmac('sha1', FAKE_AUTH_TOKEN).update(toSign, 'utf8').digest('base64');
}

/** POST to the inbound webhook with a correctly signed request. */
async function inbound(
  params: Record<string, string>,
  overrideSig?: string,
): Promise<ApiResp> {
  const path = '/v1/twilio/inbound';
  const url  = `${FAKE_BASE_URL}${path}`;
  const sig  = overrideSig ?? computeSig(url, params);
  return api('POST', path, {
    formBody: params,
    extraHeaders: { 'x-twilio-signature': sig },
  });
}

/** POST to the status callback webhook with a correctly signed request. */
async function statusCallback(
  outboxId: string,
  params: Record<string, string>,
  overrideSig?: string,
): Promise<ApiResp> {
  const path  = '/v1/twilio/status';
  const query = `outbox_id=${outboxId}`;
  const url   = `${FAKE_BASE_URL}${path}?${query}`;
  const sig   = overrideSig ?? computeSig(url, params);
  return api('POST', `${path}?${query}`, {
    formBody: params,
    extraHeaders: { 'x-twilio-signature': sig },
  });
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
  tenantId: string;
  vendorId: string;
  tenancyId: string;
}

async function setupUser(
  label: string,
  opts?: { tenantPhone?: string; vendorPhone?: string },
): Promise<UserFixture> {
  const email    = `tw-${label}-${rnd()}@example.test`;
  const password = `horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `TW Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label}: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  const token     = b.session.access_token;
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

  const tenantPhone = opts?.tenantPhone ?? '+15550001111';
  const tenant = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, {
    full_name: `${label} Tenant`,
    phones: tenantPhone ? [tenantPhone] : [],
  });

  const vendorPhone = opts?.vendorPhone ?? '+15553334444';
  const vendor = await post<{ id: string }>(`/v1/accounts/${accountId}/vendors`, {
    name: `${label} Vendor`,
    contact: vendorPhone ? { phone: vendorPhone } : {},
  });

  return {
    userId: b.user.id,
    accessToken: token,
    accountId,
    tenantId: tenant.id,
    vendorId: vendor.id,
    tenancyId: tenancy.id,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Generate a per-test-run unique E.164 phone number (NANP format). */
function uniquePhone(): string {
  // +1 NXX NXXXXXX: area code 555, exchange 2xx (avoids 555-0xxx reserved by
  // NANP for fiction). Last 4 digits from random to avoid cross-test collisions
  // when the shared Supabase DB retains rows from prior test runs.
  const r = () => Math.floor(Math.random() * 10);
  return `+1555${r()}${r()}${r()}${r()}${r()}${r()}${r()}`;
}

async function main(): Promise<void> {
  console.info('Twilio webhook integration tests');

  // Shared landlord fixture — phones unique per test run to avoid collision
  // with rows left by other test suites sharing the same Supabase instance.
  const TENANT_PHONE  = uniquePhone();
  const VENDOR_PHONE  = uniquePhone();
  const UNKNOWN_PHONE = uniquePhone();

  const landlord = await setupUser('landlord', { tenantPhone: TENANT_PHONE, vendorPhone: VENDOR_PHONE });
  const { accountId } = landlord;

  // Insert agent membership.
  const { error: memberErr } = await admin
    .from('account_members')
    .insert({ account_id: accountId, user_id: AGENT_USER_ID, role: 'agent' });
  if (memberErr) throw new Error(`agent membership: ${memberErr.message}`);

  // Obtain agent token.
  const loginResp = await api('POST', '/v1/auth/login', {
    body: { email: agentEmail, password: agentPassword },
  });
  if (loginResp.status !== 200) throw new Error(`agent login: ${loginResp.status}`);
  // agentToken reserved for future webhook tests that send as agent.
  void ((loginResp.body as { session: { access_token: string } }).session).access_token;

  const msgBase = `/v1/accounts/${accountId}/messages`;

  const resetCalls = () => { calls.length = 0; };
  const setSuccess = (sid?: string) => {
    const s = sid ?? `SM${crypto.randomUUID().replace(/-/g, '')}`;
    fakeOutcome = () => ({ sid: s });
    return s;
  };

  // =========================================================================
  // (a) inbound from tenant phone, valid signature → 200; journal written.
  // =========================================================================
  await check('(a) tenant inbound, valid sig → 200, matched, journal interaction', async () => {
    const sid = `SM${rnd()}${rnd()}${rnd()}${rnd()}`;
    const params = { MessageSid: sid, From: TENANT_PHONE, To: '+18005551234', Body: 'Hello landlord' };
    const r = await inbound(params);
    assertStatus(r, 200, 'inbound tenant');

    // Raw row: matched.
    const { data: raw } = await admin
      .from('twilio_inbound_raw')
      .select('*')
      .eq('provider_sid', sid)
      .single();
    if (!raw) throw new Error('raw row missing');
    if (raw.match_status !== 'matched') throw new Error(`match_status: ${raw.match_status}`);
    if (raw.matched_account_id !== accountId) throw new Error('matched_account_id wrong');
    if (!raw.matched_interaction_id) throw new Error('matched_interaction_id missing');

    // Journal interaction.
    const { data: interaction } = await admin
      .from('interactions')
      .select('*')
      .eq('id', raw.matched_interaction_id as string)
      .single();
    if (!interaction) throw new Error('interaction missing');
    if (interaction.direction !== 'inbound')    throw new Error(`direction: ${interaction.direction}`);
    if (interaction.channel !== 'sms')          throw new Error(`channel: ${interaction.channel}`);
    if (interaction.author_type !== 'tenant')   throw new Error(`author_type: ${interaction.author_type}`);
    if (interaction.party_id !== landlord.tenantId) throw new Error(`party_id: ${interaction.party_id}`);
    if (interaction.external_ref !== sid)        throw new Error(`external_ref: ${interaction.external_ref}`);
    if (interaction.actor !== 'system:twilio-inbound') throw new Error(`actor: ${interaction.actor}`);
  });

  // =========================================================================
  // (b) invalid signature → 403; no raw row, no interaction.
  // =========================================================================
  await check('(b) invalid signature → 403, no side effects', async () => {
    const sid = `SM${rnd()}${rnd()}${rnd()}${rnd()}`;
    const params = { MessageSid: sid, From: TENANT_PHONE, To: '+18005551234', Body: 'Tampered' };
    const r = await inbound(params, 'invalidsignature=');
    assertStatus(r, 403, 'invalid sig');

    const { data } = await admin.from('twilio_inbound_raw').select('id').eq('provider_sid', sid);
    if ((data ?? []).length > 0) throw new Error('raw row exists after 403');
  });

  // =========================================================================
  // (c) duplicate MessageSid replay → 200; exactly one raw row + one interaction.
  // =========================================================================
  await check('(c) duplicate MessageSid → 200; one raw row; one interaction', async () => {
    const sid = `SM${rnd()}${rnd()}${rnd()}${rnd()}`;
    const params = { MessageSid: sid, From: TENANT_PHONE, To: '+18005551234', Body: 'Hi again' };

    const r1 = await inbound(params);
    assertStatus(r1, 200, 'first inbound');

    // Send again with the same SID (Twilio retry).
    const r2 = await inbound(params);
    assertStatus(r2, 200, 'replay inbound');

    const { data: rows } = await admin
      .from('twilio_inbound_raw')
      .select('id, matched_interaction_id')
      .eq('provider_sid', sid);
    if ((rows ?? []).length !== 1) throw new Error(`raw rows: ${rows?.length}`);

    const iId = (rows ?? [])[0]!.matched_interaction_id as string;
    const { data: iRows } = await admin
      .from('interactions')
      .select('id')
      .eq('external_ref', sid);
    if ((iRows ?? []).length !== 1) throw new Error(`interactions: ${iRows?.length}`);
    if ((iRows ?? [])[0]!.id !== iId) throw new Error('interaction id mismatch');
  });

  // =========================================================================
  // (d) unmatched number → raw row 'unmatched'; no interaction; no new contacts.
  // =========================================================================
  await check('(d) unmatched number → 200; raw row unmatched; no interaction; no new contacts', async () => {
    const { data: before } = await admin.from('tenants').select('id');
    const beforeCount = (before ?? []).length;

    const sid = `SM${rnd()}${rnd()}${rnd()}${rnd()}`;
    const params = { MessageSid: sid, From: UNKNOWN_PHONE, To: '+18005551234', Body: 'Who is this?' };
    const r = await inbound(params);
    assertStatus(r, 200, 'unmatched inbound');

    const { data: raw } = await admin.from('twilio_inbound_raw').select('*').eq('provider_sid', sid).single();
    if (!raw) throw new Error('raw row missing');
    if (raw.match_status !== 'unmatched') throw new Error(`match_status: ${raw.match_status}`);
    if (raw.matched_interaction_id !== null) throw new Error('interaction should be null');

    const { data: after } = await admin.from('tenants').select('id');
    if ((after ?? []).length !== beforeCount) throw new Error('new tenant created');
  });

  // =========================================================================
  // (e) ambiguous: second account with same tenant phone → 'ambiguous'; no
  //     interaction in either account.
  // =========================================================================
  await check('(e) ambiguous match → 200; raw row ambiguous; no interaction', async () => {
    // Create a second account with the same tenant phone as the primary landlord.
    const second = await setupUser('second', { tenantPhone: TENANT_PHONE });

    const beforeA: { data: unknown[] | null } = { data: null };
    const beforeB: { data: unknown[] | null } = { data: null };
    { const r = await admin.from('interactions').select('id').eq('account_id', accountId); beforeA.data = r.data; }
    { const r = await admin.from('interactions').select('id').eq('account_id', second.accountId); beforeB.data = r.data; }

    const sid = `SM${rnd()}${rnd()}${rnd()}${rnd()}`;
    const params = { MessageSid: sid, From: TENANT_PHONE, To: '+18005551234', Body: 'Ambiguous' };
    const r = await inbound(params);
    assertStatus(r, 200, 'ambiguous inbound');

    const { data: raw } = await admin.from('twilio_inbound_raw').select('*').eq('provider_sid', sid).single();
    if (!raw) throw new Error('raw row missing');
    if (raw.match_status !== 'ambiguous') throw new Error(`match_status: ${raw.match_status}`);
    if (raw.matched_interaction_id !== null) throw new Error('interaction_id should be null');

    const afterA = await admin.from('interactions').select('id').eq('account_id', accountId);
    const afterB = await admin.from('interactions').select('id').eq('account_id', second.accountId);
    if ((afterA.data ?? []).length !== (beforeA.data ?? []).length) throw new Error('interaction created in account A');
    if ((afterB.data ?? []).length !== (beforeB.data ?? []).length) throw new Error('interaction created in account B');
  });

  // =========================================================================
  // (f) STOP → opt-out; journal recorded; send → 409; START → cleared; send ok.
  // =========================================================================
  await check('(f) STOP opt-out flow; journal recorded; send refused; START clears', async () => {
    // Fresh fixture with unique phones to avoid state bleed across test runs.
    const stopPhone = uniquePhone();
    const f = await setupUser('stop', { tenantPhone: stopPhone });

    // STOP inbound.
    const stopSid = `SM${rnd()}${rnd()}${rnd()}${rnd()}`;
    const stopParams = { MessageSid: stopSid, From: stopPhone, To: '+18005551234', Body: 'STOP' };
    const stopR = await inbound(stopParams);
    assertStatus(stopR, 200, 'STOP inbound');

    // Opt-out row exists.
    const { data: optOut } = await admin.from('sms_opt_outs').select('*').eq('phone', stopPhone).maybeSingle();
    if (!optOut) throw new Error('opt-out row missing after STOP');
    if (optOut.last_keyword !== 'STOP') throw new Error(`last_keyword: ${optOut.last_keyword}`);

    // Journal interaction created (STOP is consent-withdrawal evidence).
    const { data: stopRaw } = await admin.from('twilio_inbound_raw').select('*').eq('provider_sid', stopSid).single();
    if (!stopRaw) throw new Error('stop raw row missing');
    if (stopRaw.match_status !== 'matched') throw new Error(`stop match_status: ${stopRaw.match_status}`);
    if (!stopRaw.matched_interaction_id) throw new Error('stop interaction missing');

    // Subsequent send to that tenant → 409 sms_opted_out.
    resetCalls();
    const sendR = await api('POST', `/v1/accounts/${f.accountId}/messages`, {
      token: f.accessToken,
      body: { channel: 'sms', recipient_type: 'tenant', recipient_id: f.tenantId, body: 'You should not get this.' },
    });
    assertStatus(sendR, 409, 'send after STOP');
    if (errCode(sendR) !== 'sms_opted_out') throw new Error(`code: ${errCode(sendR)}`);
    if (calls.length !== 0) throw new Error('provider called after STOP');

    // START inbound → clears opt-out.
    const startSid = `SM${rnd()}${rnd()}${rnd()}${rnd()}`;
    const startParams = { MessageSid: startSid, From: stopPhone, To: '+18005551234', Body: 'START' };
    assertStatus(await inbound(startParams), 200, 'START inbound');

    const { data: gone } = await admin.from('sms_opt_outs').select('*').eq('phone', stopPhone).maybeSingle();
    if (gone) throw new Error('opt-out row still exists after START');

    // Send succeeds again.
    resetCalls();
    setSuccess();
    const sendR2 = await api('POST', `/v1/accounts/${f.accountId}/messages`, {
      token: f.accessToken,
      body: { channel: 'sms', recipient_type: 'tenant', recipient_id: f.tenantId, body: 'Welcome back!' },
    });
    assertStatus(sendR2, 201, 'send after START');
    if ((calls.length as number) !== 1) throw new Error(`calls after START: ${calls.length}`);
  });

  // =========================================================================
  // (g) vendor inbound → author_type 'vendor'.
  // =========================================================================
  await check('(g) vendor inbound → author_type vendor', async () => {
    // Use the shared landlord fixture's vendor phone.
    const sid = `SM${rnd()}${rnd()}${rnd()}${rnd()}`;
    const params = { MessageSid: sid, From: VENDOR_PHONE, To: '+18005551234', Body: 'Invoice sent' };
    const r = await inbound(params);
    assertStatus(r, 200, 'vendor inbound');

    const { data: raw } = await admin.from('twilio_inbound_raw').select('*').eq('provider_sid', sid).single();
    if (!raw) throw new Error('raw row missing');
    if (raw.match_status !== 'matched') throw new Error(`match_status: ${raw.match_status}`);

    const { data: interaction } = await admin
      .from('interactions')
      .select('author_type, party_type')
      .eq('id', raw.matched_interaction_id as string)
      .single();
    if (!interaction) throw new Error('interaction missing');
    if (interaction.author_type !== 'vendor') throw new Error(`author_type: ${interaction.author_type}`);
    if (interaction.party_type !== 'vendor')  throw new Error(`party_type: ${interaction.party_type}`);

    // ALSO assert through the API read path: the wire resolution must
    // surface 'vendor' verbatim, never rewrite it (a resolver that doesn't
    // know the value would degrade it to 'system' — false capacity).
    const apiR = await api('GET', `/v1/accounts/${landlord.accountId}/interactions/${raw.matched_interaction_id as string}`, {
      token: landlord.accessToken,
    });
    assertStatus(apiR, 200, 'vendor interaction via API');
    const wire = apiR.body as { author_type: string };
    if (wire.author_type !== 'vendor') throw new Error(`wire author_type: ${wire.author_type}`);
  });

  // =========================================================================
  // (h) status callback delivery flow: sent → delivered; late 'sent' → still
  //     'delivered'; chain ok.
  // =========================================================================
  await check('(h) status callback: sent → delivered; late sent ignored; chain ok', async () => {
    // Send a message to get an outbox row.
    resetCalls();
    const expectedSid = setSuccess();

    const sendR = await api('POST', msgBase, {
      token: landlord.accessToken,
      body: { channel: 'sms', recipient_type: 'tenant', recipient_id: landlord.tenantId, body: 'Hello h' },
    });
    const sendBody = assertStatus(sendR, 201, 'send') as Record<string, unknown>;
    const outboxId = sendBody.outbox_id as string;
    const interactionId = (sendBody.interaction as Record<string, unknown>).id as string;

    // Status callback: delivered.
    const deliveredR = await statusCallback(outboxId, {
      MessageSid: expectedSid,
      MessageStatus: 'delivered',
    });
    assertStatus(deliveredR, 200, 'delivered callback');

    // Outbox: delivered + delivered_at set.
    const { data: outbox } = await admin
      .from('message_outbox')
      .select('status, delivered_at')
      .eq('id', outboxId)
      .single();
    if (!outbox) throw new Error('outbox missing');
    if (outbox.status !== 'delivered') throw new Error(`outbox status: ${outbox.status}`);
    if (!outbox.delivered_at) throw new Error('delivered_at not set');

    // GET /interactions/{id}: delivery_status 'delivered'.
    const iGet = await api('GET', `/v1/accounts/${accountId}/interactions/${interactionId}`, {
      token: landlord.accessToken,
    });
    const iBody = assertStatus(iGet, 200, 'interaction GET') as Record<string, unknown>;
    if (iBody.delivery_status !== 'delivered') throw new Error(`delivery_status: ${iBody.delivery_status}`);

    // Late 'sent' callback → monotonic guard → still 'delivered'.
    await statusCallback(outboxId, { MessageSid: expectedSid, MessageStatus: 'sent' });
    const { data: outboxAfter } = await admin
      .from('message_outbox')
      .select('status')
      .eq('id', outboxId)
      .single();
    if (outboxAfter?.status !== 'delivered') throw new Error(`after late sent: ${outboxAfter?.status}`);

    // Chain ok.
    const { data: chain } = await admin.rpc('verify_chain', { p_account_id: accountId });
    const chainRow = Array.isArray(chain) ? chain[0] : chain;
    if (!(chainRow as { ok: boolean }).ok) throw new Error('chain broken after delivery callbacks');
  });

  // =========================================================================
  // (i) crash-window recovery: outbox 'sending' no provider_sid → status
  //     callback 'sent' → complete_sms_send_system runs → correct journal.
  // =========================================================================
  await check('(i) crash-window recovery: status callback completes sending row', async () => {
    // Insert a 'sending' outbox row directly via admin, simulating the crash
    // window (outbox committed; API crashed before complete_sms_send ran).
    const recoveryPhone = uniquePhone();
    const recoveryUser  = await setupUser('recovery', { tenantPhone: recoveryPhone });

    const { data: outboxRow, error: insErr } = await admin.from('message_outbox').insert({
      account_id:      recoveryUser.accountId,
      channel:         'sms',
      tenant_id:       recoveryUser.tenantId,
      to_phone:        recoveryPhone,
      body:            'Crash recovery test',
      status:          'sending',
      author_type:     'agent',
      created_by_actor: `user:${AGENT_USER_ID}`,
      approval_ref:    'crash-recovery-ref',
    }).select('id').single();
    if (insErr || !outboxRow) throw new Error(`outbox insert: ${insErr?.message}`);
    const outboxId = outboxRow.id as string;

    const recoverySid = `SM${rnd()}${rnd()}${rnd()}${rnd()}`;

    // Status callback: 'sent' with the SID.
    const cbR = await statusCallback(outboxId, {
      MessageSid: recoverySid,
      MessageStatus: 'sent',
    });
    assertStatus(cbR, 200, 'recovery callback');

    // Outbox: status='sent' + provider_sid set + interaction_id set.
    const { data: outbox } = await admin
      .from('message_outbox')
      .select('status, provider_sid, interaction_id, author_type')
      .eq('id', outboxId)
      .single();
    if (!outbox) throw new Error('outbox missing');
    if (outbox.status !== 'sent')           throw new Error(`outbox status: ${outbox.status}`);
    if (outbox.provider_sid !== recoverySid) throw new Error(`provider_sid: ${outbox.provider_sid}`);
    if (!outbox.interaction_id)              throw new Error('interaction_id not set');
    if (outbox.author_type !== 'agent')      throw new Error(`outbox author_type: ${outbox.author_type}`);

    // Journal interaction: author_type 'agent' (capacity preserved), actor 'system:twilio-status'.
    const { data: interaction } = await admin
      .from('interactions')
      .select('author_type, actor, approval_ref, external_ref')
      .eq('id', outbox.interaction_id as string)
      .single();
    if (!interaction) throw new Error('interaction missing');
    if (interaction.author_type !== 'agent')           throw new Error(`author_type: ${interaction.author_type}`);
    if (interaction.actor !== 'system:twilio-status')  throw new Error(`actor: ${interaction.actor}`);
    if (interaction.approval_ref !== 'crash-recovery-ref') throw new Error(`approval_ref: ${interaction.approval_ref}`);
    if (interaction.external_ref !== recoverySid)      throw new Error(`external_ref: ${interaction.external_ref}`);
  });

  // =========================================================================
  // (j) unknown outbox_id → 200; malformed → 400.
  // =========================================================================
  await check('(j) status callback: unknown outbox_id → 200; malformed → 400', async () => {
    const unknownId = crypto.randomUUID();
    const r1 = await statusCallback(unknownId, { MessageSid: 'SMunknown', MessageStatus: 'delivered' });
    assertStatus(r1, 200, 'unknown outbox_id');

    // Malformed (not a UUID) — check the query param directly without a valid sig.
    // Use a valid sig computed over the malformed path.
    const malformedPath = '/v1/twilio/status';
    const malformedQuery = 'outbox_id=not-a-uuid';
    const malformedUrl = `${FAKE_BASE_URL}${malformedPath}?${malformedQuery}`;
    const malformedParams = { MessageSid: 'SMbad', MessageStatus: 'delivered' };
    const malformedSig = computeSig(malformedUrl, malformedParams);

    const r2 = await api('POST', `${malformedPath}?${malformedQuery}`, {
      formBody: malformedParams,
      extraHeaders: { 'x-twilio-signature': malformedSig },
    });
    assertStatus(r2, 400, 'malformed outbox_id');
  });

  // =========================================================================
  // (k) reconcile janitor: stale 'sending' → needs_reconcile; fresh untouched.
  // =========================================================================
  await check('(k) reconcile_message_outbox: stale sending → needs_reconcile; fresh untouched', async () => {
    const reconPhone = uniquePhone();
    const reconcileUser = await setupUser('recon', { tenantPhone: reconPhone });

    // Insert two outbox rows.
    const { data: staleRow, error: e1 } = await admin.from('message_outbox').insert({
      account_id: reconcileUser.accountId,
      channel: 'sms',
      tenant_id: reconcileUser.tenantId,
      to_phone: reconPhone,
      body: 'stale',
      status: 'sending',
      author_type: 'landlord',
      created_by_actor: `user:${reconcileUser.userId}`,
    }).select('id').single();
    if (e1 || !staleRow) throw new Error(`stale insert: ${e1?.message}`);

    const { data: freshRow, error: e2 } = await admin.from('message_outbox').insert({
      account_id: reconcileUser.accountId,
      channel: 'sms',
      tenant_id: reconcileUser.tenantId,
      to_phone: reconPhone,
      body: 'fresh',
      status: 'sending',
      author_type: 'landlord',
      created_by_actor: `user:${reconcileUser.userId}`,
    }).select('id').single();
    if (e2 || !freshRow) throw new Error(`fresh insert: ${e2?.message}`);

    // Backdate the stale row's updated_at by 2 hours via admin.
    await admin
      .from('message_outbox')
      .update({ updated_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() })
      .eq('id', staleRow.id as string);

    // Run the janitor.
    const { data: result, error: rErr } = await admin.rpc('reconcile_message_outbox', {
      p_stale_seconds: 3600,
    });
    if (rErr) throw new Error(`reconcile_message_outbox: ${rErr.message}`);
    const row = Array.isArray(result) ? result[0] : result;
    if ((row as { parked: number }).parked < 1) throw new Error(`parked: ${(row as { parked: number }).parked}`);

    // Stale row → needs_reconcile.
    const { data: staleAfter } = await admin
      .from('message_outbox')
      .select('status')
      .eq('id', staleRow.id as string)
      .single();
    if (staleAfter?.status !== 'needs_reconcile') throw new Error(`stale status: ${staleAfter?.status}`);

    // Fresh row → still 'sending'.
    const { data: freshAfter } = await admin
      .from('message_outbox')
      .select('status')
      .eq('id', freshRow.id as string)
      .single();
    if (freshAfter?.status !== 'sending') throw new Error(`fresh status: ${freshAfter?.status}`);
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
