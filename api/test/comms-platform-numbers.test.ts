// ----------------------------------------------------------------------------
// Platform-number registration integration tests (per-account provisioning).
//
// The behavior under test is a write door that must be open to exactly one
// caller. platform_numbers is force-RLS with a SELECT-only member policy, so
// registration goes through a SECURITY DEFINER RPC that re-asserts the agent
// principal. What this suite pins down:
//   * READ is transport + owner/manager; a viewer is denied and a foreign
//     account's numbers are invisible.
//   * WRITE is transport ONLY. An owner is 403 — a landlord must not be able
//     to claim a number the platform pays for, and that is enforced twice
//     (route guard, then the RPC's own membership assert).
//   * registration is idempotent on (account, number): the agent calls it from
//     a durable workflow step that replays after a crash, so a second identical
//     call is a no-op that still returns the row, leaving exactly ONE row.
//   * a released number comes back active on re-registration (we re-provisioned
//     it), but the same number under a DIFFERENT account is a 409 — silently
//     reassigning would cross-wire two landlords' conversations.
//   * omitted/empty capabilities default to {sms}; an empty set would make the
//     number invisible to POST /comms/threads and so unusable.
//   * a registered active number satisfies the thread-create gate that
//     otherwise 409s ("no active platform number with sms capability").
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
process.env.PORT = '8797';
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
  const email = `pnum-${label}-${crypto.randomUUID()}@internal.test`;
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
}

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
  if (r.status !== expected) {
    throw new Error(`${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`);
  }
  return r.body;
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function login(email: string, password: string): Promise<string> {
  const r = await api('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return (r.body as { session: { access_token: string } }).session.access_token;
}

// Randomized per run: `number` is globally unique, so fixed values would make
// the suite single-shot against a persistent local stack.
const SUFFIX = String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0');
const NUM_A = `+1913${SUFFIX}`;
const NUM_A2 = `+1914${SUFFIX}`;
const NUM_B = `+1915${SUFFIX}`;

interface Fixture {
  accountId: string;
  landlordToken: string;
  landlordId: string;
  agentToken: string;
  viewerToken: string;
  tenancyId: string;
  tenantId: string;
}

async function setup(tag: string): Promise<Fixture> {
  const email = `pnum-landlord-${tag}-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: 'Platform Number Acct' },
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
    name: 'Pnum prop',
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
  const tenant = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, {
    full_name: 'Tenant One',
  });

  for (const [userId, role] of [
    [agentAuth.id, 'agent'],
    [viewerAuth.id, 'viewer'],
  ] as const) {
    const { error } = await admin
      .from('account_members')
      .insert({ account_id: accountId, user_id: userId, role });
    if (error) throw new Error(`membership ${role}: ${error.message}`);
  }

  return {
    accountId,
    landlordToken: token,
    landlordId: b.user.id,
    agentToken: await login(agentAuth.email, agentAuth.password),
    viewerToken: await login(viewerAuth.email, viewerAuth.password),
    tenancyId: tenancy.id,
    tenantId: tenant.id,
  };
}

interface NumberShape {
  id: string;
  account_id: string;
  number: string;
  provider: string;
  capabilities: string[];
  status: string;
}

async function main(): Promise<void> {
  console.info('comms platform-number checks');
  const A = await setup('a');
  const B = await setup('b');

  const listPath = (acct: string, q = '') => `/v1/accounts/${acct}/comms/platform-numbers${q}`;

  await check('write is transport-only: owner is 403', async () => {
    const r = await api('POST', listPath(A.accountId), {
      token: A.landlordToken,
      body: { number: NUM_A, provider: 'test', capabilities: ['sms', 'mms'] },
    });
    assertStatus(r, 403, 'owner register');
    // And nothing was written.
    const { data } = await admin.from('platform_numbers').select('id').eq('number', NUM_A);
    assert((data ?? []).length === 0, 'owner 403 must not have written a row');
  });

  await check('write is transport-only: viewer is 403', async () => {
    const r = await api('POST', listPath(A.accountId), {
      token: A.viewerToken,
      body: { number: NUM_A, provider: 'test' },
    });
    assertStatus(r, 403, 'viewer register');
  });

  await check('agent registers a number (201, capabilities honored)', async () => {
    const r = await api('POST', listPath(A.accountId), {
      token: A.agentToken,
      body: { number: NUM_A, provider: 'telnyx', capabilities: ['sms', 'mms'] },
    });
    const row = assertStatus(r, 201, 'agent register') as NumberShape;
    assert(row.number === NUM_A, `number: ${row.number}`);
    assert(row.status === 'active', `status: ${row.status}`);
    assert(row.provider === 'telnyx', `provider: ${row.provider}`);
    assert(
      JSON.stringify([...row.capabilities].sort()) === JSON.stringify(['mms', 'sms']),
      `capabilities: ${JSON.stringify(row.capabilities)}`,
    );
    assert(row.account_id === A.accountId, 'account_id must be the URL account');
  });

  await check('replay is a no-op that still returns the row (one row total)', async () => {
    const r = await api('POST', listPath(A.accountId), {
      token: A.agentToken,
      body: { number: NUM_A, provider: 'telnyx', capabilities: ['sms', 'mms'] },
    });
    const row = assertStatus(r, 201, 'replay register') as NumberShape;
    assert(row.number === NUM_A, 'replay returns the row');
    const { data } = await admin.from('platform_numbers').select('id').eq('number', NUM_A);
    assert((data ?? []).length === 1, `expected exactly 1 row, got ${(data ?? []).length}`);
  });

  await check('omitted capabilities default to {sms}', async () => {
    const r = await api('POST', listPath(A.accountId), {
      token: A.agentToken,
      body: { number: NUM_A2, provider: 'telnyx' },
    });
    const row = assertStatus(r, 201, 'default capabilities') as NumberShape;
    assert(
      JSON.stringify(row.capabilities) === JSON.stringify(['sms']),
      `capabilities: ${JSON.stringify(row.capabilities)}`,
    );
  });

  await check('a released number re-activates on re-registration', async () => {
    const { error } = await admin
      .from('platform_numbers')
      .update({ status: 'released' })
      .eq('number', NUM_A2);
    assert(!error, `release: ${error?.message}`);
    const r = await api('POST', listPath(A.accountId), {
      token: A.agentToken,
      body: { number: NUM_A2, provider: 'telnyx' },
    });
    const row = assertStatus(r, 201, 're-register released') as NumberShape;
    assert(row.status === 'active', `status: ${row.status}`);
  });

  await check("another account's agent cannot claim the same number (409)", async () => {
    const r = await api('POST', listPath(B.accountId), {
      token: B.agentToken,
      body: { number: NUM_A, provider: 'telnyx' },
    });
    assertStatus(r, 409, 'cross-account claim');
    // Still owned by A.
    const { data } = await admin
      .from('platform_numbers')
      .select('account_id')
      .eq('number', NUM_A)
      .single();
    assert(
      (data as { account_id: string } | null)?.account_id === A.accountId,
      'ownership must not move',
    );
  });

  await check('malformed number is a 400, not a database error', async () => {
    const r = await api('POST', listPath(A.accountId), {
      token: A.agentToken,
      body: { number: '415-555-0100', provider: 'telnyx' },
    });
    assertStatus(r, 400, 'malformed number');
  });

  await check('read: owner sees their numbers', async () => {
    const r = await api('GET', listPath(A.accountId), { token: A.landlordToken });
    const body = assertStatus(r, 200, 'owner list') as { data: NumberShape[] };
    const numbers = body.data.map((n) => n.number).sort();
    assert(
      JSON.stringify(numbers) === JSON.stringify([NUM_A, NUM_A2].sort()),
      `numbers: ${JSON.stringify(numbers)}`,
    );
  });

  await check('read: agent sees them too (routing needs this)', async () => {
    const r = await api('GET', listPath(A.accountId), { token: A.agentToken });
    const body = assertStatus(r, 200, 'agent list') as { data: NumberShape[] };
    assert(body.data.length === 2, `expected 2, got ${body.data.length}`);
  });

  await check('read: viewer is denied', async () => {
    const r = await api('GET', listPath(A.accountId), { token: A.viewerToken });
    assertStatus(r, 403, 'viewer list');
  });

  await check('read: status=active filters out released', async () => {
    const { error } = await admin
      .from('platform_numbers')
      .update({ status: 'released' })
      .eq('number', NUM_A2);
    assert(!error, `release: ${error?.message}`);
    const r = await api('GET', listPath(A.accountId, '?status=active'), { token: A.agentToken });
    const body = assertStatus(r, 200, 'active list') as { data: NumberShape[] };
    assert(body.data.length === 1, `expected 1 active, got ${body.data.length}`);
    assert(body.data[0]!.number === NUM_A, `active number: ${body.data[0]!.number}`);
    // Restore for later checks.
    await admin.from('platform_numbers').update({ status: 'active' }).eq('number', NUM_A2);
  });

  await check("read: account B does not see account A's numbers", async () => {
    const r = await api('GET', listPath(B.accountId), { token: B.agentToken });
    const body = assertStatus(r, 200, 'B list') as { data: NumberShape[] };
    assert(body.data.length === 0, `B should see none, got ${body.data.length}`);
  });

  await check('a registered number satisfies the thread-create gate', async () => {
    // Account B has no number yet: thread create must 409.
    const before = await api('POST', `/v1/accounts/${B.accountId}/comms/threads`, {
      token: B.landlordToken,
      body: {
        kind: 'bridged_tenant',
        channel: 'sms',
        tenancy_id: B.tenancyId,
        participants: [
          { party_type: 'tenant', party_id: B.tenantId, address: `+1916${SUFFIX}` },
        ],
      },
    });
    assertStatus(before, 409, 'thread create without a number');

    const reg = await api('POST', listPath(B.accountId), {
      token: B.agentToken,
      body: { number: NUM_B, provider: 'telnyx', capabilities: ['sms', 'mms'] },
    });
    assertStatus(reg, 201, 'register B');

    const after = await api('POST', `/v1/accounts/${B.accountId}/comms/threads`, {
      token: B.landlordToken,
      body: {
        kind: 'bridged_tenant',
        channel: 'sms',
        tenancy_id: B.tenancyId,
        participants: [
          { party_type: 'tenant', party_id: B.tenantId, address: `+1916${SUFFIX}` },
        ],
      },
    });
    assertStatus(after, 201, 'thread create after registering a number');
  });

  // =========================================================================
  // The dialing number is frozen on the send intent, and the journal records
  // the SAME field the transport dialed — not one re-derived at completion.
  // =========================================================================
  await check('a bare sms intent freezes the account\'s active number', async () => {
    const r = await api('POST', `/v1/accounts/${B.accountId}/comms/outbox`, {
      token: B.landlordToken,
      body: {
        channel: 'sms',
        to_address: `+1917${SUFFIX}`,
        body: 'bare send',
        approval_ref: `self:${B.landlordId}`,
      },
    });
    const row = assertStatus(r, 201, 'bare sms intent') as { platform_number: string | null };
    assert(row.platform_number === NUM_B, `platform_number: ${row.platform_number}`);
  });

  await check('an email intent freezes no number (its From is a reply token)', async () => {
    const r = await api('POST', `/v1/accounts/${B.accountId}/comms/outbox`, {
      token: B.landlordToken,
      body: {
        channel: 'email',
        to_address: `pnum-${rnd()}@example.test`,
        body: 'email send',
        approval_ref: `self:${B.landlordId}`,
      },
    });
    // Email may be refused for unrelated branding reasons on this fixture; the
    // assertion only applies when the intent was actually created.
    if (r.status === 201) {
      const row = r.body as { platform_number: string | null };
      assert(row.platform_number === null, `email platform_number: ${row.platform_number}`);
    }
  });

  await check('complete_send journals the frozen number as the sender', async () => {
    const created = await api('POST', `/v1/accounts/${B.accountId}/comms/outbox`, {
      token: B.landlordToken,
      body: {
        channel: 'sms',
        to_address: `+1918${SUFFIX}`,
        body: 'journal sender check',
        approval_ref: `self:${B.landlordId}`,
      },
    });
    const row = assertStatus(created, 201, 'intent') as { id: string; platform_number: string };
    assert(row.platform_number === NUM_B, `frozen: ${row.platform_number}`);

    const done = await api(
      'POST',
      `/v1/accounts/${B.accountId}/comms/outbox/${row.id}/complete`,
      {
        token: B.agentToken,
        body: { provider: 'test', provider_sid: `sid-${crypto.randomUUID()}` },
      },
    );
    const body = assertStatus(done, 200, 'complete') as { interaction_id: string };

    // The sender leg of the journal cast must name the number we froze.
    const { data, error } = await admin
      .from('interaction_participants')
      .select('address, party_type')
      .eq('interaction_id', body.interaction_id)
      .eq('role', 'sender')
      .single();
    assert(!error, `sender cast read: ${error?.message}`);
    const sender = data as { address: string | null; party_type: string };
    assert(sender.party_type === 'platform', `sender party_type: ${sender.party_type}`);
    assert(sender.address === NUM_B, `journalled sender: ${sender.address} (want ${NUM_B})`);
  });

  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} platform-number check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: platform-number checks all green');
}

await main();
