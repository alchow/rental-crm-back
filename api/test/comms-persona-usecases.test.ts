// ----------------------------------------------------------------------------
// Persona routing v2 — use-case conformance matrix (plan §7, use cases A–N).
// Exercised against a real Supabase stack (GoTrue + PostgREST + RLS).
//
// This suite is the plan-conformance matrix for
// docs/persona-email-routing-v2-plan.md §7: one labeled check per use case
// ('UC-<letter>: …') plus normalization/probe edge cases ('EDGE-…'). It
// deliberately STANDS ALONE: where a scenario also exists in
// comms-persona.test.ts (the v2()/claims() fixtures), it is re-asserted here
// in compact form so this file alone answers "does the shipped classifier
// still walk the plan?".
//
// USE CASE O (provider capabilities: Mailgun/SES persona + token, Resend
// token-only, unsupported persona recipients rejected loudly) is AGENT-side —
// it lives in the transport repo's provider-adapter tests, not here. SKIPPED
// by design in this suite.
//
// Data-flow under test, per §6:
//   managed persona recipient -> account (subdomain) -> DMARC gate ->
//   parent probe (In-Reply-To, then References newest->oldest) ->
//   parent recipients resolved by named tiers -> exactly one party + one
//   conversation -> journal; anything ambiguous fails closed into triage.
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
process.env.PORT = '8806';
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

interface Failure { name: string; detail: string }
const failures: Failure[] = [];
let passCount = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passCount += 1; console.info(`  PASS  ${name}`); }
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
  const email = `puc-${label}-${crypto.randomUUID()}@internal.test`;
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

// --- fixture ----------------------------------------------------------------

const SUB = `uc${SUFFIX}`;
const PERSONA = `riley@${SUB}.${PARENT}`;
const REPLY_DOMAIN = `${SUB}.${PARENT}`;
const AUTH_PASS = { spf: 'pass', dkim: 'pass', dmarc: 'pass' } as const;
const AUTH_FAIL = { spf: 'fail', dkim: 'fail', dmarc: 'fail' } as const;

// Synthetic addresses only (§8: no production addresses in fixtures).
const A_TENANT = `uc-a-tenant-${SUFFIX}@tenant.test`;   // UC-A/B/C/G/N + EDGE parent replies
const D_TENANT = `uc-d-tenant-${SUFFIX}@tenant.test`;   // UC-D/F/J/L cold tenant
const E_TENANT = `uc-e-tenant-${SUFFIX}@tenant.test`;   // UC-E counterparty
const H_ADDR   = `uc-h-dual-${SUFFIX}@dual.test`;       // UC-H parent leg (record email + landlord claim)
const H2_ADDR  = `uc-h2-dual-${SUFFIX}@dual.test`;      // UC-H no-parent leg (two same-tier claims)
const S_ADDR   = `uc-i-shared-${SUFFIX}@tenant.test`;   // UC-I shared inbox
const K_TENANT = `uc-k-tenant-${SUFFIX}@tenant.test`;   // UC-K legacy-parent tenant
const M_TENANT = `uc-m-tenant-${SUFFIX}@tenant.test`;   // UC-M closed-thread tenant
const E5_ADDR  = `uc-edge5-${SUFFIX}@somewhere.test`;   // EDGE unmatched replay stranger

interface CaptureShape {
  disposition: string;
  interaction_id: string | null;
  thread_id: string | null;
  participant: { id: string; party_type: string; party_id: string | null } | null;
  unmatched_id: string | null;
}

interface RoutingDecision {
  version: number;
  parent_match: string;
  parent_outbox_id: string | null;
  party_source: string | null;
  disposition: string;
  reason: string | null;
  conflict_party_type: string | null;
  conflict_party_id: string | null;
  selected_tenancy_id: string | null;
}

async function readDecision(providerMsgId: string): Promise<RoutingDecision> {
  const { data, error } = await admin
    .from('inbound_raw').select('payload').eq('provider_msg_id', providerMsgId).single();
  if (error) throw new Error(`inbound_raw read (${providerMsgId}): ${error.message}`);
  const decision = (data!.payload as { routing_decision?: RoutingDecision }).routing_decision;
  if (!decision) throw new Error(`no routing_decision on ${providerMsgId}`);
  return decision;
}

async function readTriageReason(unmatchedId: string): Promise<string> {
  const { data, error } = await admin
    .from('comm_unmatched_inbound').select('reason').eq('id', unmatchedId).single();
  if (error) throw new Error(`triage read (${unmatchedId}): ${error.message}`);
  return (data as { reason: string }).reason;
}

async function main(): Promise<void> {
  console.info('Persona routing v2 use-case conformance matrix (plan §7; UC-O is agent-side, skipped)');

  // Account + owner + branding (subdomain + persona).
  const ownerEmail = `puc-owner-${rnd()}@example.test`;
  const ownerPassword = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email: ownerEmail, password: ownerPassword, account_name: 'Persona UC Acct' },
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

  const personaCapture = (body: Record<string, unknown>) =>
    api('POST', `${base}/inbound-persona`, {
      token: agentToken,
      body: {
        provider: 'ses', provider_msg_id: `UC-${rnd()}`, persona_address: PERSONA,
        to_addresses: [PERSONA], cc_addresses: [], received_at: iso(), auth_results: AUTH_PASS,
        ...body,
      },
    });

  // Tenants / tenancies / claims ---------------------------------------------
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: landlordToken, body });
    if (r.status !== 201) throw new Error(`setup POST ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const createTenant = async (name: string, email: string): Promise<string> =>
    (await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, {
      full_name: name, emails: [email],
    })).id;

  const property = await post<{ id: string }>(`/v1/accounts/${accountId}/properties`, {
    name: 'UC Matrix Prop',
  });
  const unit = async (name: string) =>
    (await post<{ id: string }>(`/v1/accounts/${accountId}/areas`, {
      property_id: property.id, kind: 'unit', name,
    })).id;
  const tenancy = async (areaId: string) =>
    (await post<{ id: string }>(`/v1/accounts/${accountId}/tenancies`, {
      area_id: areaId, start_date: '2026-01-01', status: 'active',
    })).id;
  const member = async (tenancyId: string, tenantId: string) => {
    const r = await api('POST', `/v1/accounts/${accountId}/tenancies/${tenancyId}/members`, {
      token: landlordToken, body: { tenant_id: tenantId, role: 'primary' },
    });
    if (r.status !== 201) throw new Error(`member: ${r.status} ${JSON.stringify(r.body)}`);
  };

  const tenancyA = await tenancy(await unit('UC Unit A'));
  const tenancyH = await tenancy(await unit('UC Unit H'));
  const tenancyI1 = await tenancy(await unit('UC Unit I1'));
  const tenancyI2 = await tenancy(await unit('UC Unit I2'));
  const tenancyK = await tenancy(await unit('UC Unit K'));
  const tenancyM = await tenancy(await unit('UC Unit M'));

  const albaId = await createTenant('UC Alba', A_TENANT);
  await member(tenancyA, albaId);
  const danId = await createTenant('UC Dan', D_TENANT);
  const evaId = await createTenant('UC Eva', E_TENANT);
  const hanaId = await createTenant('UC Hana', H_ADDR); // H_ADDR IS her record email
  await member(tenancyH, hanaId);
  const idaId = await createTenant('UC Ida', `uc-ida-record-${SUFFIX}@tenant.test`);
  const ivyId = await createTenant('UC Ivy', `uc-ivy-record-${SUFFIX}@tenant.test`);
  await member(tenancyI1, idaId);
  await member(tenancyI2, ivyId);
  const kaiId = await createTenant('UC Kai', K_TENANT);
  await member(tenancyK, kaiId);
  const miaId = await createTenant('UC Mia', M_TENANT);
  await member(tenancyM, miaId);

  {
    // Claim seeds (admin — the DB shapes the plan describes):
    //  * UC-A incident: the tenant's address wrongly learned as the LANDLORD
    //    (pre-claims 'legacy' row);
    //  * UC-H parent leg: H_ADDR honestly dual — tenant via the record book
    //    (authoritative) + a learned landlord claim;
    //  * UC-H no-parent leg: H2_ADDR with two live claims at the SAME tier;
    //  * UC-I: one shared inbox, human-linked per tenancy (scoped claims).
    const { error } = await admin.from('channel_identities').insert([
      {
        account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
        channel: 'email', address: A_TENANT, source: 'legacy',
      },
      {
        account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
        channel: 'email', address: H_ADDR, source: 'provider_learned',
      },
      {
        account_id: accountId, party_type: 'landlord_user', party_id: sub.user.id,
        channel: 'email', address: H2_ADDR, source: 'provider_learned',
      },
      {
        account_id: accountId, party_type: 'tenant', party_id: hanaId,
        channel: 'email', address: H2_ADDR, source: 'provider_learned',
      },
      {
        account_id: accountId, party_type: 'tenant', party_id: idaId,
        channel: 'email', address: S_ADDR, source: 'human_link',
        scope_type: 'tenancy', scope_id: tenancyI1,
      },
      {
        account_id: accountId, party_type: 'tenant', party_id: ivyId,
        channel: 'email', address: S_ADDR, source: 'human_link',
        scope_type: 'tenancy', scope_id: tenancyI2,
      },
    ]);
    if (error) throw new Error(`claim seeds: ${error.message}`);
  }

  // A completed bare outbox row = a valid parent (sent, Message-ID stamped
  // unless withMsgid=false — the UC-K legacy shape).
  const makeParent = async (opts: {
    to: string; cc?: string[]; tenancyId?: string; withMsgid?: boolean;
  }) => {
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
    const row = assertStatus(sent, 201, 'parent intent') as { id: string };
    const msgid = `<uc-${row.id}@${REPLY_DOMAIN}>`;
    const done = await api('POST', `${base}/outbox/${row.id}/complete`, {
      token: agentToken,
      body: {
        provider: 'smtp2go',
        provider_sid: `uc-${rnd()}`,
        ...(opts.withMsgid === false ? {} : { rfc822_message_id: msgid }),
      },
    });
    assertStatus(done, 200, 'parent complete');
    return { id: row.id, msgid };
  };

  const parent1 = await makeParent({ to: A_TENANT, cc: [ownerEmail], tenancyId: tenancyA });

  // =========================================================================
  // UC-A — the incident: parent tenancy beats a bad learned landlord claim
  // =========================================================================
  let ucaThreadId = '';
  let ucaIid = '';
  const UCA_PROVIDER_ID = `UC-A-${rnd()}`;
  await check('UC-A: parent tenancy beats bad learned claim -> matched, filed under the parent tenancy', async () => {
    const r = await personaCapture({
      provider_msg_id: UCA_PROVIDER_ID,
      from_address: A_TENANT,
      cc_addresses: [ownerEmail],
      subject: 'Re: Inspection welcome',
      body: 'tenant reply through the persona',
      rfc822_message_id: `<uc-a-reply-${SUFFIX}@sender>`,
      in_reply_to: parent1.msgid,
      references: [parent1.msgid],
    });
    const res = assertStatus(r, 200, 'UC-A capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.participant?.party_type === 'tenant' && res.participant.party_id === albaId,
      `tenant wins from parent tenancy: ${JSON.stringify(res.participant)}`);
    ucaThreadId = res.thread_id!;
    ucaIid = res.interaction_id!;
    const { data: thr } = await admin
      .from('comm_threads').select('tenancy_id').eq('id', ucaThreadId).single();
    assert(thr!.tenancy_id === tenancyA, `thread tenancy = parent tenancy: ${thr!.tenancy_id}`);
    // The bad claim is outranked and RECORDED, never obeyed or deleted.
    const d = await readDecision(UCA_PROVIDER_ID);
    assert(d.version === 2, `routing_decision.version: ${d.version}`);
    assert(d.parent_match === 'unique' && d.parent_outbox_id === parent1.id,
      `parent recorded: ${JSON.stringify(d)}`);
    assert(d.party_source === 'tenancy_member', `party_source: ${d.party_source}`);
    assert(d.conflict_party_type === 'landlord_user', `conflict traced: ${JSON.stringify(d)}`);
    const { data: claims } = await admin
      .from('channel_identities').select('party_type, source, superseded_at')
      .eq('account_id', accountId).eq('channel', 'email').eq('address', A_TENANT);
    assert(
      (claims ?? []).some((x) => x.party_type === 'landlord_user' && x.source === 'legacy'
        && x.superseded_at === null),
      `bad claim untouched: ${JSON.stringify(claims)}`,
    );
  });

  // =========================================================================
  // UC-B — landlord replies from the visible Cc address
  // =========================================================================
  await check('UC-B: landlord Cc reply -> cc_journaled into the tenant conversation, relayed nothing', async () => {
    const r = await personaCapture({
      from_address: ownerEmail,
      body: 'landlord reply from the cc leg',
      rfc822_message_id: `<uc-b-reply-${SUFFIX}@sender>`,
      in_reply_to: parent1.msgid,
    });
    const res = assertStatus(r, 200, 'UC-B capture') as CaptureShape;
    assert(res.disposition === 'cc_journaled', `disposition: ${res.disposition}`);
    assert(res.thread_id === ucaThreadId, `into the tenant conversation: ${res.thread_id}`);
    assert(res.participant?.party_id === albaId, `counterparty = tenant: ${JSON.stringify(res.participant)}`);
    const { data: row } = await admin
      .from('interactions').select('direction, author_type')
      .eq('id', res.interaction_id!).single();
    assert(row!.direction === 'outbound' && row!.author_type === 'landlord',
      `landlord-authored outbound: ${row!.direction}/${row!.author_type}`);
  });

  // =========================================================================
  // UC-C — mobile Reply All strips the original To/Cc
  // =========================================================================
  await check('UC-C: persona-only headers (mobile reply) still resolve via the parent', async () => {
    const r = await personaCapture({
      from_address: A_TENANT,
      to_addresses: [PERSONA],
      cc_addresses: [],
      body: 'sent from my phone',
      rfc822_message_id: `<uc-c-reply-${SUFFIX}@sender>`,
      in_reply_to: parent1.msgid,
    });
    const res = assertStatus(r, 200, 'UC-C capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.thread_id === ucaThreadId, `same conversation: ${res.thread_id}`);
    assert(res.participant?.party_id === albaId, `tenant participant: ${JSON.stringify(res.participant)}`);
  });

  // =========================================================================
  // UC-D — known tenant writes a new email directly to the persona
  // =========================================================================
  let danThreadId = '';
  const UCD_PROVIDER_ID = `UC-D-${rnd()}`;
  await check('UC-D: known tenant cold email (no parent) -> matched into a found-or-created thread', async () => {
    const r = await personaCapture({
      provider_msg_id: UCD_PROVIDER_ID,
      from_address: D_TENANT,
      subject: 'A new question',
      body: 'cold but known',
      rfc822_message_id: `<uc-d-cold-${SUFFIX}@sender>`,
    });
    const res = assertStatus(r, 200, 'UC-D capture') as CaptureShape;
    assert(res.disposition === 'matched', `disposition: ${res.disposition}`);
    assert(res.participant?.party_type === 'tenant' && res.participant.party_id === danId,
      `tenant resolved: ${JSON.stringify(res.participant)}`);
    danThreadId = res.thread_id!;
    const d = await readDecision(UCD_PROVIDER_ID);
    assert(d.parent_match === 'none' && d.parent_outbox_id === null,
      `no parent involved: ${JSON.stringify(d)}`);
  });

  // =========================================================================
  // UC-E — landlord Ccs the persona on a NEW message to a tenant
  // =========================================================================
  await check('UC-E: landlord Ccs persona on a new message to a tenant -> cc_journaled (outbound-cold thread)', async () => {
    const r = await personaCapture({
      from_address: ownerEmail,
      to_addresses: [E_TENANT],
      subject: 'Welcome aboard',
      body: 'new outbound from my own inbox',
      rfc822_message_id: `<uc-e-cold-${SUFFIX}@sender>`,
    });
    const res = assertStatus(r, 200, 'UC-E capture') as CaptureShape;
    assert(res.disposition === 'cc_journaled', `disposition: ${res.disposition}`);
    assert(res.thread_id !== null && res.thread_id !== danThreadId, 'a new thread');
    assert(res.participant?.party_id === evaId, `counterparty: ${JSON.stringify(res.participant)}`);
    const { data: row } = await admin
      .from('interactions').select('direction, author_type')
      .eq('id', res.interaction_id!).single();
    assert(row!.direction === 'outbound' && row!.author_type === 'landlord',
      `landlord-authored outbound: ${row!.direction}/${row!.author_type}`);
  });

  // =========================================================================
  // UC-F — one Reply All reaches a token and the persona
  // =========================================================================
  await check('UC-F: token door + persona door, same Message-ID -> one journal + one duplicate', async () => {
    const rfcId = `uc-f-twodoor-${SUFFIX}@sender`;
    const d = assertStatus(
      await api('GET', `${base}/threads/${danThreadId}`, { token: landlordToken }),
      200, 'thread read',
    ) as { bindings: { participant_address: string; reply_address: string | null }[] };
    const token = d.bindings.find((b) => b.participant_address === D_TENANT)?.reply_address;
    assert(token, 'tenant token minted');

    const door1 = assertStatus(await api('POST', `${base}/inbound`, {
      token: agentToken,
      body: {
        provider: 'ses', provider_msg_id: `UC-F1-${rnd()}`, to_number: token,
        from_address: D_TENANT, channel: 'email', body: 'reply all', received_at: iso(),
        rfc822_message_id: `<${rfcId}>`,
      },
    }), 200, 'token door') as CaptureShape;
    assert(door1.disposition === 'matched', `token door: ${door1.disposition}`);

    const door2 = assertStatus(await personaCapture({
      from_address: D_TENANT, body: 'reply all', rfc822_message_id: `<${rfcId}>`,
    }), 200, 'persona door') as CaptureShape;
    assert(door2.disposition === 'duplicate', `persona door: ${door2.disposition}`);
    assert(door2.interaction_id === door1.interaction_id, 'points at the original journal row');
  });

  // =========================================================================
  // UC-G — valid parent but authentication fails (unverified-journal tier)
  // =========================================================================
  await check('UC-G: valid parent + failed DMARC from the KNOWN tenant -> journaled_unverified into the parent conversation; never trusted, never learned', async () => {
    const provId = `UC-G-${rnd()}`;
    const r = await personaCapture({
      provider_msg_id: provId,
      from_address: A_TENANT,
      body: 'this reply fails dmarc',
      rfc822_message_id: `<uc-g-reply-${SUFFIX}@sender>`,
      in_reply_to: parent1.msgid,
      auth_results: AUTH_FAIL,
    });
    const res = assertStatus(r, 200, 'UC-G capture') as CaptureShape;
    assert(res.disposition === 'journaled_unverified', `disposition: ${res.disposition}`);
    assert(res.thread_id === ucaThreadId, `RIGHT thread (the parent conversation): ${res.thread_id}`);
    assert(res.interaction_id !== null && res.unmatched_id === null, 'journaled, not triaged');
    assert(res.participant?.party_type === 'tenant' && res.participant.party_id === albaId,
      `claimed tenant attributed: ${JSON.stringify(res.participant)}`);
    const { data: j } = await admin
      .from('interactions').select('attestation, direction')
      .eq('id', res.interaction_id!).single();
    assert(j!.attestation === 'unverified' && j!.direction === 'inbound',
      `unverified inbound: ${JSON.stringify(j)}`);
    // Failed auth still never learns: the claim set is unchanged (the legacy
    // landlord row + UC-A's learned tenant row).
    const { data: claims } = await admin
      .from('channel_identities').select('party_type, source')
      .eq('account_id', accountId).eq('channel', 'email').eq('address', A_TENANT);
    assert((claims ?? []).length === 2, `no new claim rows: ${JSON.stringify(claims)}`);
    const d = await readDecision(provId);
    assert(d.disposition === 'journaled_unverified' && d.reason === 'unverified_single_claim',
      `decision: ${JSON.stringify(d)}`);
    assert(d.parent_match === 'unique' && d.parent_outbox_id === parent1.id,
      `parent recorded: ${JSON.stringify(d)}`);
  });

  await check('UC-G2: valid parent + failed DMARC from a STRANGER -> auth_failed triage (a parent never rescues DMARC)', async () => {
    const r = await personaCapture({
      from_address: `uc-g2-stranger-${SUFFIX}@somewhere.test`,
      body: 'forged reply from an unknown address',
      rfc822_message_id: `<uc-g2-reply-${SUFFIX}@sender>`,
      in_reply_to: parent1.msgid,
      auth_results: AUTH_FAIL,
    });
    const res = assertStatus(r, 200, 'UC-G2 capture') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    assert(res.interaction_id === null && res.thread_id === null, 'nothing journaled');
    assert(res.unmatched_id !== null, 'triage row returned');
    assert((await readTriageReason(res.unmatched_id!)) === 'auth_failed', 'reason auth_failed');
  });

  // =========================================================================
  // UC-H — one address legitimately has two roles
  // =========================================================================
  await check('UC-H: dual-role address — parent tenancy selects the tenant leg; no context -> identity_conflict', async () => {
    // With a parent: H_ADDR is BOTH tenancy H's member record email (tenant)
    // and a learned landlord alias. The parent's tenancy selects the tenant
    // role; the landlord claim is recorded as the conflict trace, not obeyed.
    const parentH = await makeParent({ to: H_ADDR, tenancyId: tenancyH });
    const withParentId = `UC-H1-${rnd()}`;
    const withParent = assertStatus(await personaCapture({
      provider_msg_id: withParentId,
      from_address: H_ADDR,
      body: 'reply on the tenant leg',
      rfc822_message_id: `<uc-h1-reply-${SUFFIX}@sender>`,
      in_reply_to: parentH.msgid,
    }), 200, 'UC-H parent reply') as CaptureShape;
    assert(withParent.disposition === 'matched', `with parent: ${withParent.disposition}`);
    assert(withParent.participant?.party_type === 'tenant' && withParent.participant.party_id === hanaId,
      `parent selects the tenant role: ${JSON.stringify(withParent.participant)}`);
    const d = await readDecision(withParentId);
    assert(d.party_source === 'tenancy_member' && d.conflict_party_type === 'landlord_user',
      `authoritative tier + conflict trace: ${JSON.stringify(d)}`);

    // Without parent/thread/tenancy: H2_ADDR carries two LIVE claims at the
    // same tier (tenant + landlord, both provider_learned) and no context
    // selects a role — never "whichever row was inserted first".
    const noParent = assertStatus(await personaCapture({
      from_address: H2_ADDR,
      body: 'who am i today',
      rfc822_message_id: `<uc-h2-cold-${SUFFIX}@sender>`,
    }), 200, 'UC-H cold capture') as CaptureShape;
    assert(noParent.disposition === 'triaged', `no context: ${noParent.disposition}`);
    assert((await readTriageReason(noParent.unmatched_id!)) === 'identity_conflict',
      'reason identity_conflict');
  });

  // =========================================================================
  // UC-I — two tenants share one inbox
  // =========================================================================
  await check('UC-I: shared inbox — parent tenancy selects its tenant; cold mail triages', async () => {
    const parentI = await makeParent({ to: S_ADDR, tenancyId: tenancyI1 });
    const r = assertStatus(await personaCapture({
      from_address: S_ADDR,
      body: 'reply from the shared inbox',
      rfc822_message_id: `<uc-i-reply-${SUFFIX}@sender>`,
      in_reply_to: parentI.msgid,
    }), 200, 'UC-I parent reply') as CaptureShape;
    assert(r.disposition === 'matched', `parent-scoped: ${r.disposition}`);
    assert(r.participant?.party_id === idaId,
      `tenancy I1's tenant selected: ${JSON.stringify(r.participant)}`);
    const { data: thr } = await admin
      .from('comm_threads').select('tenancy_id').eq('id', r.thread_id!).single();
    assert(thr!.tenancy_id === tenancyI1, `thread pinned to tenancy I1: ${thr!.tenancy_id}`);

    // Cold: neither tenancy-scoped claim applies; both tenants remain
    // possible -> triage, never a guess.
    const cold = assertStatus(await personaCapture({
      from_address: S_ADDR,
      body: 'no context this time',
      rfc822_message_id: `<uc-i-cold-${SUFFIX}@sender>`,
    }), 200, 'UC-I cold capture') as CaptureShape;
    assert(cold.disposition === 'triaged', `cold: ${cold.disposition}`);
    assert((await readTriageReason(cold.unmatched_id!)) === 'unknown_sender',
      'cold reason unknown_sender (scoped claims are invisible without context)');
  });

  // =========================================================================
  // UC-J — forwarded or forged parent reference
  // =========================================================================
  await check('UC-J: authenticated non-recipient citing a real parent -> parent_sender_mismatch', async () => {
    // Dan is a KNOWN tenant with an ACTIVE thread; the forged reference must
    // not route the mail into it.
    const r = await personaCapture({
      from_address: D_TENANT,
      body: 'i found this message id somewhere',
      rfc822_message_id: `<uc-j-reply-${SUFFIX}@sender>`,
      in_reply_to: parent1.msgid,
    });
    const res = assertStatus(r, 200, 'UC-J capture') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    assert(res.thread_id === null && res.interaction_id === null,
      `not routed into the sender's own thread (${danThreadId})`);
    assert((await readTriageReason(res.unmatched_id!)) === 'parent_sender_mismatch',
      'reason parent_sender_mismatch');
  });

  // =========================================================================
  // UC-K — legacy parent has no Message-ID
  // =========================================================================
  await check('UC-K: parent completed WITHOUT rfc822_message_id -> honest no-parent fallback', async () => {
    const parentK = await makeParent({ to: K_TENANT, tenancyId: tenancyK, withMsgid: false });
    const { data: ob } = await admin
      .from('comm_outbox').select('status, rfc822_message_id').eq('id', parentK.id).single();
    assert(ob!.status === 'sent' && ob!.rfc822_message_id === null,
      `legacy parent shape (sent, no msgid): ${JSON.stringify(ob)}`);

    // The reply cites the id the provider REALLY stamped — core never
    // recorded it, so no parent can match; the fallback must still route.
    const provId = `UC-K-${rnd()}`;
    const r = assertStatus(await personaCapture({
      provider_msg_id: provId,
      from_address: K_TENANT,
      body: 'replying to a pre-v2 send',
      rfc822_message_id: `<uc-k-reply-${SUFFIX}@sender>`,
      in_reply_to: `<uc-k-unrecorded-${SUFFIX}@${REPLY_DOMAIN}>`,
    }), 200, 'UC-K capture') as CaptureShape;
    assert(r.disposition === 'matched', `disposition: ${r.disposition}`);
    assert(r.participant?.party_id === kaiId, `tenant via fallback: ${JSON.stringify(r.participant)}`);
    const { data: thr } = await admin
      .from('comm_threads').select('tenancy_id').eq('id', r.thread_id!).single();
    assert(thr!.tenancy_id === tenancyK, `single active tenancy chosen: ${thr!.tenancy_id}`);
    const d = await readDecision(provId);
    assert(d.parent_match === 'none' && d.parent_outbox_id === null,
      `probe honestly found nothing: ${JSON.stringify(d)}`);
  });

  // =========================================================================
  // UC-L — cross-account and non-completed parents are invisible
  // =========================================================================
  await check('UC-L: cross-account + queued parents are invisible to the probe', async () => {
    // Account B with its own COMPLETED send.
    const su2 = await api('POST', '/v1/auth/signup', {
      body: {
        email: `puc-owner-b-${rnd()}@example.test`,
        password: `correct-horse-${rnd()}`,
        account_name: 'Persona UC Acct B',
      },
    });
    if (su2.status !== 200) throw new Error(`signup B: ${su2.status} ${JSON.stringify(su2.body)}`);
    const subB = su2.body as { account: { id: string }; user: { id: string } };
    const crossMsgid = `<uc-l-cross-${SUFFIX}@other-account>`;
    const { data: obRow, error: obErr } = await admin.from('comm_outbox').insert({
      account_id: subB.account.id, channel: 'email', to_address: D_TENANT,
      body: 'other account parent', approval_ref: `self:${subB.user.id}`,
      approved_by: subB.user.id, author_type: 'landlord',
      rfc822_message_id: crossMsgid,
    }).select('id').single();
    if (obErr) throw new Error(`account B parent seed: ${obErr.message}`);
    const { error: obUpErr } = await admin.from('comm_outbox')
      .update({ status: 'sent', provider: 'smtp2go', provider_sid: `uc-l-b-${rnd()}` })
      .eq('id', obRow!.id);
    if (obUpErr) throw new Error(`account B parent sent: ${obUpErr.message}`);

    // A QUEUED intent in account A that carries a Message-ID.
    const intent = await api('POST', `${base}/outbox`, {
      token: landlordToken,
      body: {
        channel: 'email', to_address: D_TENANT,
        subject: 'never sent', body: 'queued intent',
        approval_ref: `self:${sub.user.id}`,
      },
    });
    const qRow = assertStatus(intent, 201, 'queued intent') as { id: string };
    const queuedMsgid = `<uc-l-queued-${SUFFIX}@${REPLY_DOMAIN}>`;
    const { error: upErr } = await admin.from('comm_outbox')
      .update({ rfc822_message_id: queuedMsgid }).eq('id', qRow.id);
    if (upErr) throw new Error(`queued msgid stamp: ${upErr.message}`);

    // One reply citing BOTH: neither is a valid parent (§5.6/§5.7); the
    // known sender falls through to their own thread.
    const provId = `UC-L-${rnd()}`;
    const r = assertStatus(await personaCapture({
      provider_msg_id: provId,
      from_address: D_TENANT,
      body: 'reply citing foreign and queued ids',
      rfc822_message_id: `<uc-l-reply-${SUFFIX}@sender>`,
      in_reply_to: crossMsgid,
      references: [queuedMsgid],
    }), 200, 'UC-L capture') as CaptureShape;
    assert(r.disposition === 'matched', `disposition: ${r.disposition}`);
    assert(r.thread_id === danThreadId, `own thread, never via those parents: ${r.thread_id}`);
    const d = await readDecision(provId);
    assert(d.parent_match === 'none' && d.parent_outbox_id === null,
      `both rows invisible: ${JSON.stringify(d)}`);
  });

  // =========================================================================
  // UC-M — the parent's thread is closed
  // =========================================================================
  await check('UC-M: closed parent thread -> a NEW active thread in the same tenancy (never reopened)', async () => {
    // Build Mia's thread (tenancy M via her single active tenancy)…
    const seed = assertStatus(await personaCapture({
      from_address: M_TENANT, body: 'seed thread', rfc822_message_id: `<uc-m-seed-${SUFFIX}@sender>`,
    }), 200, 'UC-M seed') as CaptureShape;
    assert(seed.disposition === 'matched', `seed: ${seed.disposition}`);
    const closedThreadId = seed.thread_id!;

    // …bind a completed parent to it, then close the thread via its status.
    const parentMsgid = `<uc-m-parent-${SUFFIX}@${REPLY_DOMAIN}>`;
    const { data: pRow, error: pErr } = await admin.from('comm_outbox').insert({
      account_id: accountId, channel: 'email', to_address: M_TENANT,
      thread_id: closedThreadId, tenancy_id: tenancyM,
      body: 'thread-bound parent', approval_ref: `self:${sub.user.id}`,
      approved_by: sub.user.id, author_type: 'landlord',
      rfc822_message_id: parentMsgid,
    }).select('id').single();
    if (pErr) throw new Error(`UC-M parent seed: ${pErr.message}`);
    const { error: pUpErr } = await admin.from('comm_outbox')
      .update({ status: 'sent', provider: 'smtp2go', provider_sid: `uc-m-${rnd()}` })
      .eq('id', pRow!.id);
    if (pUpErr) throw new Error(`UC-M parent sent: ${pUpErr.message}`);
    const { error: closeErr } = await admin.from('comm_threads')
      .update({ status: 'closed' }).eq('id', closedThreadId);
    if (closeErr) throw new Error(`UC-M close: ${closeErr.message}`);

    const provId = `UC-M-${rnd()}`;
    const r = assertStatus(await personaCapture({
      provider_msg_id: provId,
      from_address: M_TENANT,
      body: 'reply after the thread closed',
      rfc822_message_id: `<uc-m-reply-${SUFFIX}@sender>`,
      in_reply_to: parentMsgid,
    }), 200, 'UC-M capture') as CaptureShape;
    assert(r.disposition === 'matched', `disposition: ${r.disposition}`);
    assert(r.thread_id !== null && r.thread_id !== closedThreadId,
      `not appended to the closed thread: ${r.thread_id}`);
    const { data: thr } = await admin
      .from('comm_threads').select('status, tenancy_id').eq('id', r.thread_id!).single();
    assert(thr!.status === 'active' && thr!.tenancy_id === tenancyM,
      `new ACTIVE thread in the SAME tenancy: ${JSON.stringify(thr)}`);
    const d = await readDecision(provId);
    assert(d.parent_outbox_id === pRow!.id, `parent retained in the decision: ${JSON.stringify(d)}`);
  });

  // =========================================================================
  // UC-N — duplicate provider replay with changed inputs
  // =========================================================================
  await check('UC-N: replay with changed From/auth/references returns the frozen original', async () => {
    const r = await personaCapture({
      provider_msg_id: UCA_PROVIDER_ID,
      from_address: D_TENANT,
      body: 'completely different content',
      rfc822_message_id: `<uc-n-replay-${SUFFIX}@sender>`,
      auth_results: AUTH_FAIL,
    });
    const res = assertStatus(r, 200, 'UC-N replay') as CaptureShape;
    assert(res.disposition === 'matched', `frozen disposition: ${res.disposition}`);
    assert(res.interaction_id === ucaIid, `frozen interaction: ${res.interaction_id}`);
    assert(res.thread_id === ucaThreadId, `frozen thread: ${res.thread_id}`);
    // The frozen decision still names the ORIGINAL route.
    const d = await readDecision(UCA_PROVIDER_ID);
    assert(d.disposition === 'matched' && d.conflict_party_type === 'landlord_user',
      `decision untouched by the replay: ${JSON.stringify(d)}`);
  });

  // =========================================================================
  // EDGE — normalization + probe mechanics
  // =========================================================================
  await check('EDGE-normalization: In-Reply-To without brackets, mixed case, still matches the parent', async () => {
    const inner = parent1.msgid.replace(/^<|>$/g, '');
    const provId = `UC-E1-${rnd()}`;
    const r = assertStatus(await personaCapture({
      provider_msg_id: provId,
      from_address: A_TENANT,
      body: 'client mangled the header casing',
      rfc822_message_id: `<uc-edge1-${SUFFIX}@sender>`,
      in_reply_to: inner.toUpperCase(), // no <>, uppercased
    }), 200, 'EDGE-1 capture') as CaptureShape;
    assert(r.disposition === 'matched', `disposition: ${r.disposition}`);
    assert(r.thread_id === ucaThreadId, `parent conversation: ${r.thread_id}`);
    const d = await readDecision(provId);
    assert(d.parent_match === 'unique' && d.parent_outbox_id === parent1.id,
      `normalized probe hit: ${JSON.stringify(d)}`);
  });

  await check('EDGE-references: In-Reply-To misses, References (newest-first) finds the target mid-array', async () => {
    const provId = `UC-E2-${rnd()}`;
    const r = assertStatus(await personaCapture({
      provider_msg_id: provId,
      from_address: A_TENANT,
      body: 'threading via references only',
      rfc822_message_id: `<uc-edge2-${SUFFIX}@sender>`,
      in_reply_to: `<uc-edge2-miss-${SUFFIX}@nowhere.test>`,
      references: [
        `<uc-edge2-noise-a-${SUFFIX}@nowhere.test>`,
        parent1.msgid,
        `<uc-edge2-noise-b-${SUFFIX}@nowhere.test>`,
      ],
    }), 200, 'EDGE-2 capture') as CaptureShape;
    assert(r.disposition === 'matched', `disposition: ${r.disposition}`);
    assert(r.thread_id === ucaThreadId, `parent conversation: ${r.thread_id}`);
    const d = await readDecision(provId);
    assert(d.parent_match === 'unique' && d.parent_outbox_id === parent1.id,
      `references probe (newest->oldest) hit: ${JSON.stringify(d)}`);
  });

  await check('EDGE-empty-references: references [] + no In-Reply-To -> clean no-parent route', async () => {
    const provId = `UC-E3-${rnd()}`;
    const r = assertStatus(await personaCapture({
      provider_msg_id: provId,
      from_address: K_TENANT,
      body: 'no threading headers at all',
      rfc822_message_id: `<uc-edge3-${SUFFIX}@sender>`,
      references: [],
    }), 200, 'EDGE-3 capture') as CaptureShape;
    assert(r.disposition === 'matched', `disposition: ${r.disposition}`);
    const d = await readDecision(provId);
    assert(d.parent_match === 'none' && d.parent_outbox_id === null,
      `probe returned none: ${JSON.stringify(d)}`);
  });

  await check('EDGE-self-echo: sender IS the persona address citing a real parent -> parent_sender_mismatch, never journaled as the tenant', async () => {
    // Deterministic outcome, documented: the persona address is never a
    // PHYSICAL recipient of its own outbound (parents carry the tenant To +
    // landlord Cc), so an authenticated self-echo lands in
    // parent_sender_mismatch triage — it must not journal as any party, and
    // the route handler additionally suppresses the stranger ack for
    // self-addressed persona mail.
    const r = await personaCapture({
      from_address: PERSONA,
      body: 'looped back to myself',
      rfc822_message_id: `<uc-edge4-${SUFFIX}@sender>`,
      in_reply_to: parent1.msgid,
    });
    const res = assertStatus(r, 200, 'EDGE-4 capture') as CaptureShape;
    assert(res.disposition === 'triaged', `disposition: ${res.disposition}`);
    assert(res.interaction_id === null && res.thread_id === null, 'nothing journaled');
    assert((await readTriageReason(res.unmatched_id!)) === 'parent_sender_mismatch',
      'reason parent_sender_mismatch');
  });

  await check('EDGE-unmatched-replay: a triaged capture replays to the SAME triage row', async () => {
    const provId = `UC-E5-${rnd()}`;
    const first = assertStatus(await personaCapture({
      provider_msg_id: provId, from_address: E5_ADDR,
      body: 'total stranger', rfc822_message_id: `<uc-edge5-${SUFFIX}@sender>`,
    }), 200, 'EDGE-5 capture') as CaptureShape;
    assert(first.disposition === 'triaged' && first.unmatched_id !== null,
      `first: ${JSON.stringify(first)}`);
    const replay = assertStatus(await personaCapture({
      provider_msg_id: provId, from_address: E5_ADDR,
      body: 'total stranger', rfc822_message_id: `<uc-edge5-${SUFFIX}@sender>`,
    }), 200, 'EDGE-5 replay') as CaptureShape;
    assert(replay.disposition === 'triaged' && replay.unmatched_id === first.unmatched_id,
      `replay resolves the same triage row: ${replay.unmatched_id}`);
  });

  // --- summary ---------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} use-case check(s) FAILED (${passCount} passed)`);
    process.exit(1);
  }
  console.info(`OK: all ${passCount} use-case checks green (UC-A..UC-N + EDGE; UC-O is agent-side)`);
}

await main();
