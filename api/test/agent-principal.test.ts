// ----------------------------------------------------------------------------
// Agent principal integration tests (agent-api plan Workstream B + D).
//
// Covers:
//   (a) agent POST agent_event proposal_created → 201, author_type='agent',
//       entry_type persisted, chain event payload confirms author_type='agent'.
//   (b) agent kind='communication' → 403 agent_entry_type_forbidden.
//   (c) agent correction (corrects_id) → 403 agent_forbidden.
//   (d) agent note without approvals → 400; agent note with approved_by+ref → 201.
//   (e) agent note with approved_by=agent's own id → 400 (non-agent member rule).
//   (f) agent step_executed without entity ref → 400; with tenancy_id → 201.
//   (g) agent agent_event with 1001-char body → 400.
//   (h) landlord kind='agent_event' → 403 agent_only; landlord note with
//       approval_ref → 400.
//   (i) landlord plain communication and note → 201 with author_type='landlord';
//       response carries approved_by/approval_ref/entry_type/external_ref nulls.
//   (j) idempotency principal isolation: landlord POSTs a note with key K;
//       agent POSTs agent_event with the SAME key K → 409 conflict.
//   (k) agent invalid entry_type 'chat_message' → 400 (zod enum).
//   (l) landlord GET list: agent rows visible with author_type='agent'.
//   (m) legacy resolution: admin-direct interaction with actor='tenant:legacy-tok'
//       and author_type=null → GET by id resolves author_type='tenant'.
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
process.env.PORT = '8792';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

// Create the agent auth user via the admin client. The agent is classified by
// its role='agent' membership (ADR-0009), inserted below in main() -- not by
// any env var; we just need the user id here for that membership row.
const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const adminForSetup = getAdminClient();

const agentEmail = `agent-${crypto.randomUUID()}@internal.test`;
const agentPassword = `agent-pass-${crypto.randomUUID()}`;
const { data: agentAuthData, error: agentCreateErr } = await adminForSetup.auth.admin.createUser({
  email: agentEmail,
  password: agentPassword,
  email_confirm: true,
});
if (agentCreateErr || !agentAuthData?.user) {
  throw new Error(`Failed to create agent auth user: ${agentCreateErr?.message}`);
}
const agentUserId = agentAuthData.user.id;

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

interface UserFixture {
  userId: string;
  accessToken: string;
  accountId: string;
  tenancyId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `ap-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status}`);
  const b = su.body as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: b.session.access_token, body });
    if (r.status !== 201) throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(
    `/v1/accounts/${b.account.id}/properties`, { name: `${label} prop` },
  );
  const unitArea = await post<{ id: string }>(
    `/v1/accounts/${b.account.id}/areas`,
    { property_id: property.id, kind: 'unit', name: `${label} unit` },
  );
  const tenancy = await post<{ id: string }>(
    `/v1/accounts/${b.account.id}/tenancies`,
    { area_id: unitArea.id, start_date: '2026-01-01', status: 'active' },
  );
  return {
    userId: b.user.id,
    accessToken: b.session.access_token,
    accountId: b.account.id,
    tenancyId: tenancy.id,
  };
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
  if (r.status !== expected) throw new Error(
    `${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`,
  );
  return r.body;
}
function errCode(r: ApiResp): string {
  return ((r.body as { error?: { code?: string } })?.error?.code) ?? '';
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Agent principal integration tests');

  const landlord = await setupUser('landlord');
  const admin = getAdminClient();
  const base = `/v1/accounts/${landlord.accountId}/interactions`;

  // Insert the agent as an account member (role='agent') via the admin client.
  const { error: memberErr } = await admin.from('account_members').insert({
    account_id: landlord.accountId,
    user_id: agentUserId,
    role: 'agent',
  });
  if (memberErr) throw new Error(`Failed to insert agent membership: ${memberErr.message}`);

  // Obtain the agent's access token via the login endpoint.
  const loginResp = await api('POST', '/v1/auth/login', {
    body: { email: agentEmail, password: agentPassword },
  });
  if (loginResp.status !== 200) {
    throw new Error(`Agent login failed: ${loginResp.status} ${JSON.stringify(loginResp.body)}`);
  }
  const agentToken = ((loginResp.body as { session: { access_token: string } }).session).access_token;

  const agentPost = (body: Record<string, unknown>, key?: string): Promise<ApiResp> =>
    api('POST', base, { token: agentToken, body, idempotencyKey: key });
  const landlordPost = (body: Record<string, unknown>, key?: string): Promise<ApiResp> =>
    api('POST', base, { token: landlord.accessToken, body, idempotencyKey: key });

  const now = () => new Date().toISOString();

  // =========================================================================
  // (a) agent POST agent_event proposal_created → 201; author_type='agent',
  //     entry_type persisted; chain event payload->after->author_type='agent'.
  // =========================================================================
  let agentEventId = '';
  await check('(a) agent agent_event proposal_created → 201, author_type=agent', async () => {
    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'proposal_created',
      approval_ref: 'prop-1',
      occurred_at: now(),
    });
    const row = assertStatus(r, 201, 'agent_event create') as Record<string, unknown>;
    agentEventId = row.id as string;
    if (row.author_type !== 'agent') throw new Error(`author_type: ${row.author_type}`);
    if (row.entry_type !== 'proposal_created') throw new Error(`entry_type: ${row.entry_type}`);
    if (row.kind !== 'agent_event') throw new Error(`kind: ${row.kind}`);
    if (row.approval_ref !== 'prop-1') throw new Error(`approval_ref: ${row.approval_ref}`);

    // Verify the chain event carries author_type='agent' in the payload snapshot.
    const { data: events, error: evErr } = await admin
      .from('events')
      .select('payload')
      .eq('entity_type', 'interactions')
      .eq('entity_id', agentEventId)
      .order('account_seq', { ascending: false })
      .limit(1);
    if (evErr) throw new Error(`chain query: ${evErr.message}`);
    if (!events || events.length === 0) throw new Error('no chain event found for interaction');
    const payload = events[0]!.payload as { after: { author_type: string } };
    if (payload.after?.author_type !== 'agent') {
      throw new Error(`chain payload author_type: ${JSON.stringify(payload.after?.author_type)}`);
    }
  });

  // =========================================================================
  // (b) agent kind='communication' → 403 agent_entry_type_forbidden
  // =========================================================================
  await check('(b) agent communication → 403 agent_entry_type_forbidden', async () => {
    const r = await agentPost({
      kind: 'communication',
      channel: 'phone',
      direction: 'outbound',
      party_type: 'tenant',
      occurred_at: now(),
    });
    assertStatus(r, 403, 'agent communication');
    if (errCode(r) !== 'agent_entry_type_forbidden') throw new Error(`code: ${errCode(r)}`);
  });

  // Also test that default kind='communication' is blocked.
  await check('(b) agent default kind communication → 403', async () => {
    const r = await agentPost({
      channel: 'phone',
      direction: 'outbound',
      party_type: 'tenant',
      occurred_at: now(),
    });
    assertStatus(r, 403, 'agent default communication');
    if (errCode(r) !== 'agent_entry_type_forbidden') throw new Error(`code: ${errCode(r)}`);
  });

  // =========================================================================
  // (c) agent correction (corrects_id) → 403 agent_forbidden
  // =========================================================================
  // First create a landlord entry to correct.
  let landlordEntryId = '';
  {
    const r = await landlordPost({
      kind: 'note',
      occurred_at: now(),
      body: 'Inspected entry.',
    });
    if (r.status !== 201) throw new Error(`landlord note for correction target: ${r.status}`);
    landlordEntryId = (r.body as { id: string }).id;
  }

  await check('(c) agent correction → 403 agent_forbidden', async () => {
    const r = await agentPost({
      corrects_id: landlordEntryId,
      correction_kind: 'retract',
      body: 'retraction reason',
    });
    assertStatus(r, 403, 'agent correction');
    if (errCode(r) !== 'agent_forbidden') throw new Error(`code: ${errCode(r)}`);
  });

  // =========================================================================
  // (d) agent note without approvals → 400; with approved_by+ref → 201
  // =========================================================================
  await check('(d) agent note without approvals → 400', async () => {
    const r = await agentPost({
      kind: 'note',
      occurred_at: now(),
      body: 'Agent observation.',
    });
    assertStatus(r, 400, 'agent note no approvals');
  });

  await check('(d) agent note with landlord approved_by + approval_ref → 201', async () => {
    const r = await agentPost({
      kind: 'note',
      occurred_at: now(),
      body: 'Agent-logged note with approval.',
      approved_by: landlord.userId,
      approval_ref: 'approval-ref-123',
    });
    const row = assertStatus(r, 201, 'agent note with approval') as Record<string, unknown>;
    if (row.author_type !== 'agent') throw new Error(`author_type: ${row.author_type}`);
    if (row.approved_by !== landlord.userId) throw new Error(`approved_by: ${row.approved_by}`);
    if (row.approval_ref !== 'approval-ref-123') throw new Error(`approval_ref: ${row.approval_ref}`);
  });

  // =========================================================================
  // (e) agent note with approved_by = agent's own id → 400 (non-agent member rule)
  // =========================================================================
  await check('(e) agent note approved_by=agent self → 400', async () => {
    const r = await agentPost({
      kind: 'note',
      occurred_at: now(),
      body: 'Self-approval attempt.',
      approved_by: agentUserId,
      approval_ref: 'self-ref',
    });
    assertStatus(r, 400, 'agent self-approval');
    // The error should be about approved_by being an invalid approver.
    const code = errCode(r);
    if (code !== 'invalid_request') throw new Error(`code: ${code}`);
  });

  // =========================================================================
  // (f) agent step_executed without entity ref → 400; with tenancy_id → 201
  // =========================================================================
  await check('(f) agent step_executed without entity ref → 400', async () => {
    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'step_executed',
      approval_ref: 'step-ref-1',
      occurred_at: now(),
    });
    assertStatus(r, 400, 'step_executed no entity ref');
  });

  await check('(f) agent step_executed with tenancy_id → 201', async () => {
    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'step_executed',
      approval_ref: 'step-ref-2',
      occurred_at: now(),
      tenancy_id: landlord.tenancyId,
    });
    const row = assertStatus(r, 201, 'step_executed with tenancy') as Record<string, unknown>;
    if (row.entry_type !== 'step_executed') throw new Error(`entry_type: ${row.entry_type}`);
    if (row.author_type !== 'agent') throw new Error(`author_type: ${row.author_type}`);
  });

  // =========================================================================
  // (g) agent agent_event with 1001-char body → 400
  // =========================================================================
  await check('(g) agent_event body > 1000 chars → 400', async () => {
    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'proposal_created',
      approval_ref: 'prop-long',
      occurred_at: now(),
      body: 'x'.repeat(1001),
    });
    assertStatus(r, 400, 'oversized agent_event body');
  });

  // =========================================================================
  // (h) landlord kind='agent_event' → 403 agent_only;
  //     landlord note with approval_ref → 400
  // =========================================================================
  await check('(h) landlord kind=agent_event → 403 agent_only', async () => {
    const r = await landlordPost({
      kind: 'agent_event',
      entry_type: 'proposal_created',
      approval_ref: 'ref',
      occurred_at: now(),
    });
    assertStatus(r, 403, 'landlord agent_event');
    if (errCode(r) !== 'agent_only') throw new Error(`code: ${errCode(r)}`);
  });

  await check('(h) landlord note with approval_ref → 400', async () => {
    const r = await landlordPost({
      kind: 'note',
      occurred_at: now(),
      body: 'Landlord note.',
      approval_ref: 'sneaky-ref',
    });
    assertStatus(r, 400, 'landlord note with approval_ref');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  await check('(h) landlord note with approved_by → 400', async () => {
    const r = await landlordPost({
      kind: 'note',
      occurred_at: now(),
      body: 'Landlord note.',
      approved_by: landlord.userId,
    });
    assertStatus(r, 400, 'landlord note with approved_by');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  // =========================================================================
  // (i) landlord plain communication and note → 201 with author_type='landlord';
  //     response carries approved_by/approval_ref/entry_type/external_ref nulls.
  // =========================================================================
  await check('(i) landlord communication → 201, author_type=landlord, capacity nulls', async () => {
    const r = await landlordPost({
      kind: 'communication',
      channel: 'phone',
      direction: 'inbound',
      party_type: 'tenant',
      occurred_at: now(),
      body: 'Tenant called.',
      tenancy_id: landlord.tenancyId,
    });
    const row = assertStatus(r, 201, 'landlord communication') as Record<string, unknown>;
    if (row.author_type !== 'landlord') throw new Error(`author_type: ${row.author_type}`);
    if (row.approved_by !== null) throw new Error(`approved_by: ${row.approved_by}`);
    if (row.approval_ref !== null) throw new Error(`approval_ref: ${row.approval_ref}`);
    if (row.entry_type !== null) throw new Error(`entry_type: ${row.entry_type}`);
    if (row.external_ref !== null) throw new Error(`external_ref: ${row.external_ref}`);
  });

  await check('(i) landlord note → 201, author_type=landlord', async () => {
    const r = await landlordPost({
      kind: 'note',
      occurred_at: now(),
      body: 'Inspected roof.',
    });
    const row = assertStatus(r, 201, 'landlord note') as Record<string, unknown>;
    if (row.author_type !== 'landlord') throw new Error(`author_type: ${row.author_type}`);
    if (row.approved_by !== null) throw new Error(`approved_by not null: ${row.approved_by}`);
    if (row.approval_ref !== null) throw new Error(`approval_ref not null: ${row.approval_ref}`);
  });

  // =========================================================================
  // (j) idempotency principal isolation: landlord POSTs a note with key K;
  //     agent POSTs agent_event with SAME key K → 409 conflict.
  // =========================================================================
  await check('(j) idempotency principal isolation → 409 conflict on same key', async () => {
    const sharedKey = `iso-${crypto.randomUUID()}`;
    // Landlord claims the key with a note.
    const landlordR = await landlordPost({
      kind: 'note',
      occurred_at: now(),
      body: 'Landlord note.',
    }, sharedKey);
    assertStatus(landlordR, 201, 'landlord first claim');

    // Agent attempts the same key with an agent_event -- different fingerprint
    // (different userId in preimage) → 409 conflict.
    const agentR = await agentPost({
      kind: 'agent_event',
      entry_type: 'proposal_created',
      approval_ref: 'ref-x',
      occurred_at: now(),
    }, sharedKey);
    assertStatus(agentR, 409, 'agent same key conflict');
    if (errCode(agentR) !== 'conflict') throw new Error(`code: ${errCode(agentR)}`);
  });

  // =========================================================================
  // (k) agent invalid entry_type 'chat_message' → 400 (zod enum)
  // =========================================================================
  await check('(k) agent invalid entry_type → 400', async () => {
    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'chat_message',
      approval_ref: 'ref',
      occurred_at: now(),
    });
    assertStatus(r, 400, 'invalid entry_type');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
  });

  // =========================================================================
  // (l) landlord GET list: agent rows visible with author_type='agent'
  // =========================================================================
  await check('(l) landlord list shows agent rows with author_type=agent', async () => {
    const r = await api('GET', `${base}?limit=100`, { token: landlord.accessToken });
    assertStatus(r, 200, 'list');
    const data = (r.body as { data: Record<string, unknown>[] }).data;
    const agentRow = data.find((row) => row.id === agentEventId);
    if (!agentRow) throw new Error('agent_event row not found in list');
    if (agentRow.author_type !== 'agent') throw new Error(`author_type in list: ${agentRow.author_type}`);
  });

  // =========================================================================
  // (m) legacy resolution: admin-direct insert with actor='tenant:legacy-tok',
  //     author_type=null → GET by id resolves author_type='tenant'.
  // =========================================================================
  await check('(m) legacy actor resolution: tenant actor → author_type=tenant', async () => {
    const legacyOccurredAt = new Date().toISOString();
    const { data: inserted, error: insErr } = await admin
      .from('interactions')
      .insert({
        account_id: landlord.accountId,
        actor: 'tenant:legacy-tok',
        author_type: null,
        kind: 'communication',
        channel: 'phone',
        direction: 'inbound',
        party_type: 'tenant',
        party_id: null,
        party_label: null,
        occurred_at: legacyOccurredAt,
        body: 'legacy entry',
        corrects_id: null,
        correction_kind: null,
        tenancy_id: null,
        maintenance_request_id: null,
        area_id: null,
        work_order_id: null,
        vendor_id: null,
      })
      .select('id')
      .single();
    if (insErr) throw new Error(`legacy insert: ${insErr.message}`);
    const legacyId = (inserted as { id: string }).id;

    const r = await api('GET', `${base}/${legacyId}`, { token: landlord.accessToken });
    const row = assertStatus(r, 200, 'legacy get') as Record<string, unknown>;
    if (row.author_type !== 'tenant') throw new Error(`resolved author_type: ${row.author_type}`);
  });

  // =========================================================================
  // (n) new entry_types: proposal_failed → 201, author_type=agent, echoed
  // =========================================================================
  await check('(n) agent proposal_failed → 201, author_type=agent, entry_type echoed', async () => {
    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'proposal_failed',
      approval_ref: 'prop-proposal_failed',
      occurred_at: now(),
    });
    const row = assertStatus(r, 201, 'proposal_failed') as Record<string, unknown>;
    if (row.author_type !== 'agent') throw new Error(`author_type: ${row.author_type}`);
    if (row.entry_type !== 'proposal_failed') throw new Error(`entry_type: ${row.entry_type}`);
  });

  // =========================================================================
  // (o) new entry_types: proposal_blocked → 201, author_type=agent, echoed
  // =========================================================================
  await check('(o) agent proposal_blocked → 201, author_type=agent, entry_type echoed', async () => {
    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'proposal_blocked',
      approval_ref: 'prop-proposal_blocked',
      occurred_at: now(),
    });
    const row = assertStatus(r, 201, 'proposal_blocked') as Record<string, unknown>;
    if (row.author_type !== 'agent') throw new Error(`author_type: ${row.author_type}`);
    if (row.entry_type !== 'proposal_blocked') throw new Error(`entry_type: ${row.entry_type}`);
  });

  // =========================================================================
  // (p) new entry_types: resume_target_dead → 201, author_type=agent, echoed
  // =========================================================================
  await check('(p) agent resume_target_dead → 201, author_type=agent, entry_type echoed', async () => {
    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'resume_target_dead',
      approval_ref: 'prop-resume_target_dead',
      occurred_at: now(),
    });
    const row = assertStatus(r, 201, 'resume_target_dead') as Record<string, unknown>;
    if (row.author_type !== 'agent') throw new Error(`author_type: ${row.author_type}`);
    if (row.entry_type !== 'resume_target_dead') throw new Error(`entry_type: ${row.entry_type}`);
  });

  // =========================================================================
  // (q) new entry_types: proposal_superseded → 201, author_type=agent, echoed
  // =========================================================================
  await check('(q) agent proposal_superseded → 201, author_type=agent, entry_type echoed', async () => {
    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'proposal_superseded',
      approval_ref: 'prop-proposal_superseded',
      occurred_at: now(),
    });
    const row = assertStatus(r, 201, 'proposal_superseded') as Record<string, unknown>;
    if (row.author_type !== 'agent') throw new Error(`author_type: ${row.author_type}`);
    if (row.entry_type !== 'proposal_superseded') throw new Error(`entry_type: ${row.entry_type}`);
  });

  // =========================================================================
  // (r) step_executed with references_interaction_id → 201, field echoed back
  // =========================================================================
  await check('(r) agent step_executed with references_interaction_id → 201, field echoed', async () => {
    // Create a fresh landlord note to use as the anchor interaction.
    const anchorR = await landlordPost({
      kind: 'note',
      occurred_at: now(),
      body: 'Anchor note for references_interaction_id test.',
    });
    const anchorRow = assertStatus(anchorR, 201, 'anchor note') as Record<string, unknown>;
    const anchorId = anchorRow.id as string;

    const r = await agentPost({
      kind: 'agent_event',
      entry_type: 'step_executed',
      approval_ref: 'step-ref-3',
      occurred_at: now(),
      tenancy_id: landlord.tenancyId,
      references_interaction_id: anchorId,
    });
    const row = assertStatus(r, 201, 'step_executed with references_interaction_id') as Record<string, unknown>;
    if (row.author_type !== 'agent') throw new Error(`author_type: ${row.author_type}`);
    if (row.references_interaction_id !== anchorId) {
      throw new Error(`references_interaction_id: expected ${anchorId}, got ${row.references_interaction_id}`);
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
  console.info(`All checks passed.`);
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
