// ----------------------------------------------------------------------------
// Phase 7 intake DoD tests.
//
// The intake surface is the first public, unauthenticated, RLS-bypassing
// route in the build. The test exercises every threat-model assertion the
// review called out:
//
//   * Scope is derived STRICTLY from the verified token (account_id,
//     property_id, tenancy_id). Body fields can't override.
//   * Area must belong to the TOKEN's property -- not just the account.
//   * Forged / revoked / tenancy-ended tokens are rejected with 404.
//   * Per-token rate limit returns 429 after the cap.
//   * audit.actor on the resulting events is 'tenant:<token_id>'.
//   * Dedup: a second submission with same area + title links to the
//     existing open request rather than creating a duplicate.
//   * The revoke-on-tenancy-end trigger auto-revokes when status = 'ended'.
//   * Interactions.logged_at is server-set and cannot be overridden by the
//     submitter.
//
// Runs against the full local Supabase stack (supabase start), because
// real GoTrue + PostgREST is where test-vs-prod drift would hide and
// because the audit trigger sets actor from the live request GUC.
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
process.env.PORT = '8787';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { _resetIntakeIpBucketsForTests } = await import('../src/admin/intake');
const { buildApp } = await import('../src/app');

const app = buildApp();
await _resetIntakeIpBucketsForTests();

// --- helpers ----------------------------------------------------------------

interface ApiCall {
  status: number;
  body: unknown;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiCall> {
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
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { status: res.status, body };
}

function rnd(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface UserFixture {
  userId: string;
  accessToken: string;
  accountId: string;
  propertyId: string;
  unitAreaId: string;
  commonAreaId: string;
  tenancyId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `intake-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) {
    throw new Error(`signup ${label} failed: ${su.status} ${JSON.stringify(su.body)}`);
  }
  const b = su.body as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  const userId = b.user.id;
  const accessToken = b.session.access_token;
  const accountId = b.account.id;
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: accessToken, body });
    if (r.status !== 201) {
      throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body as T;
  };
  const property = await post<{ id: string }>(
    `/v1/accounts/${accountId}/properties`,
    { name: `${label} prop ${rnd()}` },
  );
  const unitArea = await post<{ id: string }>(
    `/v1/accounts/${accountId}/areas`,
    { property_id: property.id, kind: 'unit', name: `${label} unit ${rnd()}` },
  );
  const commonArea = await post<{ id: string }>(
    `/v1/accounts/${accountId}/areas`,
    { property_id: property.id, kind: 'hallway', name: `${label} hallway ${rnd()}` },
  );
  const tenancy = await post<{ id: string }>(
    `/v1/accounts/${accountId}/tenancies`,
    { area_id: unitArea.id, start_date: '2026-01-01', status: 'active' },
  );
  return {
    userId,
    accessToken,
    accountId,
    propertyId: property.id,
    unitAreaId: unitArea.id,
    commonAreaId: commonArea.id,
    tenancyId: tenancy.id,
  };
}

interface MintedToken {
  id: string;
  secret: string;
  account_id: string;
  property_id: string;
  tenancy_id: string;
}

async function mintToken(u: UserFixture): Promise<MintedToken> {
  const r = await api('POST', `/v1/accounts/${u.accountId}/tenancies/${u.tenancyId}/intake-tokens`, {
    token: u.accessToken,
  });
  if (r.status !== 201) {
    throw new Error(`mint failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body as MintedToken;
}

async function submitIntake(
  tokenSecret: string,
  body: Record<string, unknown>,
): Promise<ApiCall> {
  return api('POST', `/v1/intake/${tokenSecret}`, { body });
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

function assertStatus(r: ApiCall, expected: number, ctx: string): unknown {
  if (r.status !== expected) {
    throw new Error(
      `${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`,
    );
  }
  return r.body;
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Phase 7 intake DoD checks');
  console.info(`  supabase API at ${status.API_URL}`);
  // Reset the per-IP rate limiter so a previous run's hits don't bleed
  // into this one (the in-memory map is process-local; if main() is run
  // multiple times in the same process the buckets persist).
  await _resetIntakeIpBucketsForTests();

  const A = await setupUser('A');
  const B = await setupUser('B');
  console.info(`  user A: account ${A.accountId} / tenancy ${A.tenancyId}`);
  console.info(`  user B: account ${B.accountId}`);

  // -----------------------------------------------------------------------
  // Forged tokens never resolve.
  // -----------------------------------------------------------------------
  await check('forged token -> 404', async () => {
    const r = await submitIntake('forged-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      area_id: A.unitAreaId,
      title: 'leak',
      severity: 'routine',
    });
    assertStatus(r, 404, 'forged');
  });

  // -----------------------------------------------------------------------
  // Mint a real token; verify the response shape and that the secret is
  // returned plaintext exactly once.
  // -----------------------------------------------------------------------
  let tokenA: MintedToken;
  await check('mint: landlord can mint a token; secret returned once', async () => {
    tokenA = await mintToken(A);
    if (!tokenA.secret || tokenA.secret.length < 32) {
      throw new Error(`weak secret returned: ${tokenA.secret}`);
    }
    // Listing must NOT include the secret.
    const list = await api(
      'GET',
      `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/intake-tokens`,
      { token: A.accessToken },
    );
    const body = assertStatus(list, 200, 'list') as {
      data: Array<Record<string, unknown>>;
    };
    if (body.data.length < 1) throw new Error('list did not return minted token');
    if ('secret' in body.data[0]!) throw new Error('list leaked the secret');
  });

  // -----------------------------------------------------------------------
  // Happy path: submission lands; response carries the request + interaction ids.
  // -----------------------------------------------------------------------
  let firstRequestId = '';
  await check('happy path: submit lands and creates a request + interaction', async () => {
    const r = await submitIntake(tokenA!.secret, {
      area_id: A.unitAreaId,
      title: 'sink leak',
      description: 'kitchen sink drips constantly',
      severity: 'routine',
      occurred_at: '2026-02-15T09:00:00Z',
    });
    const body = assertStatus(r, 201, 'happy path') as {
      maintenance_request_id: string;
      interaction_id: string;
      deduped_onto_existing: boolean;
    };
    if (!body.maintenance_request_id || !body.interaction_id) {
      throw new Error(`missing ids: ${JSON.stringify(body)}`);
    }
    if (body.deduped_onto_existing !== false) {
      throw new Error(`first submission claims dedupe? ${JSON.stringify(body)}`);
    }
    firstRequestId = body.maintenance_request_id;
  });

  // -----------------------------------------------------------------------
  // The audit chain entry for the maintenance_request must carry
  // actor='tenant:<token_id>' (Phase 3.1 actor-integrity work). We verify by
  // reading events via the user-client (RLS allows account members to SELECT
  // events).
  // -----------------------------------------------------------------------
  await check("audit: maintenance_request event has actor 'tenant:<id>'", async () => {
    const r = await api(
      'GET',
      `/v1/accounts/${A.accountId}/_audit_actor_probe_dummy`,
      { token: A.accessToken },
    );
    // The above is a non-existent path and returns 404 -- we just needed an
    // auth-bearing GET to confirm token still works. Audit-event lookups
    // happen directly via supabase-js. To avoid a circular dep on the
    // sdk, we query via the admin client through a brief inline supabase-js
    // call.
    void r;
    // Use the admin client to read the events table by entity_id.
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await admin
      .from('events')
      .select('actor, event_type')
      .eq('entity_type', 'maintenance_requests')
      .eq('entity_id', firstRequestId)
      .eq('event_type', 'inserted')
      .maybeSingle();
    if (error) throw new Error(`events query failed: ${error.message}`);
    if (!data) throw new Error('no inserted event for the new maintenance_request');
    const expected = `tenant:${tokenA!.id}`;
    if (data.actor !== expected) {
      throw new Error(`actor mismatch: expected ${expected}, got ${data.actor}`);
    }
  });

  // -----------------------------------------------------------------------
  // Area scope: body cannot land a request in another property/account.
  // -----------------------------------------------------------------------
  await check("body trying to use B's area is rejected (404 'area not found in this property')", async () => {
    const r = await submitIntake(tokenA!.secret, {
      area_id: B.unitAreaId,
      title: 'attack',
      severity: 'routine',
    });
    assertStatus(r, 404, 'cross-property area');
  });

  // -----------------------------------------------------------------------
  // Dedup: a second submission with the SAME area + title links onto the
  // existing OPEN request. CRUCIALLY: the tenant's new description is
  // RECORDED as a second interaction on that request -- not dropped. The
  // dedupe is on the maintenance_request, never on the words.
  // -----------------------------------------------------------------------
  const dedupedDescription = `tenant follow-up: getting worse today ${rnd()}`;
  await check('dedup: same area+title links to existing request AND records new description as a 2nd interaction', async () => {
    const r = await submitIntake(tokenA!.secret, {
      area_id: A.unitAreaId,
      title: 'sink leak',
      description: dedupedDescription,
      severity: 'routine',
    });
    const body = assertStatus(r, 201, 'dedup attempt') as {
      maintenance_request_id: string;
      interaction_id: string;
      deduped_onto_existing: boolean;
    };
    if (!body.deduped_onto_existing) {
      throw new Error(`expected deduped_onto_existing=true; got false`);
    }
    if (body.maintenance_request_id !== firstRequestId) {
      throw new Error(
        `dedup landed on a NEW request id: ${body.maintenance_request_id} (expected ${firstRequestId})`,
      );
    }

    // Read interactions for that request via the admin client. We expect
    // AT LEAST two: the original submission's interaction and this one
    // (the deduped follow-up). The follow-up's body must be the new
    // description -- proof we didn't drop it.
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await admin
      .from('interactions')
      .select('id, body')
      .eq('maintenance_request_id', firstRequestId)
      .order('logged_at', { ascending: true });
    if (error) throw new Error(`interactions query failed: ${error.message}`);
    if (!data || data.length < 2) {
      throw new Error(
        `expected >= 2 interactions on the deduped request, got ${data?.length ?? 0}`,
      );
    }
    const bodies = data.map((r) => r.body);
    if (!bodies.includes(dedupedDescription)) {
      throw new Error(
        `dedup dropped the tenant's new description; bodies seen: ${JSON.stringify(bodies)}`,
      );
    }
  });

  // Dedup is intentionally CONSERVATIVE: an OPEN + same area + same title.
  // A different title for the same area creates a NEW request (better
  // two-requests-for-one-issue than over-dedup hiding a real second
  // problem). Verify.
  await check('dedup: different title on same area creates a NEW request (no over-dedup)', async () => {
    const r = await submitIntake(tokenA!.secret, {
      area_id: A.unitAreaId,
      title: 'completely separate issue, broken stove',
      severity: 'urgent',
    });
    const body = assertStatus(r, 201, 'distinct title') as {
      maintenance_request_id: string;
      deduped_onto_existing: boolean;
    };
    if (body.deduped_onto_existing) {
      throw new Error(`over-deduped: a different-title submission should create a new request`);
    }
    if (body.maintenance_request_id === firstRequestId) {
      throw new Error(`returned the original request id for a different-title submission`);
    }
  });

  // -----------------------------------------------------------------------
  // Rate limit. The token bucket is 20 requests / 10 min; we fire 25 and
  // expect the last few to 429. (We've already used a few above; the test
  // counts from here.)
  // -----------------------------------------------------------------------
  await check('per-token rate limit: 429 after the cap', async () => {
    let saw429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await submitIntake(tokenA!.secret, {
        area_id: A.unitAreaId,
        title: `flood-test-${i}-${rnd()}`,
        severity: 'routine',
      });
      if (r.status === 429) {
        saw429 = true;
        break;
      }
      if (r.status !== 201) {
        throw new Error(`unexpected status ${r.status} during flood`);
      }
    }
    if (!saw429) throw new Error('never saw a 429; rate limit not enforced');
  });

  // -----------------------------------------------------------------------
  // Revocation: a revoked token returns 404 (no distinction from not-found).
  // -----------------------------------------------------------------------
  await check('revoke: explicit revoke -> token no longer accepted', async () => {
    // Need a FRESH token because the previous one is rate-limited (and we
    // also want this section to be independent of the rate limiter state).
    // First revoke the current one to free the unique-active index, then
    // mint a new one for the revoke test.
    const rev = await api(
      'POST',
      `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/intake-tokens/${tokenA!.id}/revoke`,
      { token: A.accessToken },
    );
    assertStatus(rev, 200, 'revoke existing');

    const fresh = await mintToken(A);
    await _resetIntakeIpBucketsForTests();

    // Sanity: the fresh token works.
    const ok = await submitIntake(fresh.secret, {
      area_id: A.unitAreaId,
      title: `revoke-test-pre ${rnd()}`,
      severity: 'routine',
    });
    assertStatus(ok, 201, 'fresh token works pre-revoke');

    // Now revoke it and re-attempt.
    const rev2 = await api(
      'POST',
      `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/intake-tokens/${fresh.id}/revoke`,
      { token: A.accessToken },
    );
    assertStatus(rev2, 200, 'revoke fresh');

    const denied = await submitIntake(fresh.secret, {
      area_id: A.unitAreaId,
      title: 'should not land',
      severity: 'routine',
    });
    assertStatus(denied, 404, 'submit after explicit revoke');
  });

  // -----------------------------------------------------------------------
  // Auto-revoke on tenancy end: trigger fires, the live token's revoked_at
  // is set.
  // -----------------------------------------------------------------------
  await check('auto-revoke on tenancy-end: trigger flips revoked_at', async () => {
    // Mint a fresh token for a fresh tenancy (the previous one's tokens
    // are all revoked now).
    const u = await setupUser('AutoRev');
    const t = await mintToken(u);
    await _resetIntakeIpBucketsForTests();

    // Confirm pre-end the token works.
    const pre = await submitIntake(t.secret, {
      area_id: u.unitAreaId,
      title: `pre-end ${rnd()}`,
      severity: 'routine',
    });
    assertStatus(pre, 201, 'pre-end submit');

    // Now flip the tenancy to ended via the landlord PATCH.
    const patch = await api(
      'PATCH',
      `/v1/accounts/${u.accountId}/tenancies/${u.tenancyId}`,
      { token: u.accessToken, body: { status: 'ended' } },
    );
    assertStatus(patch, 200, 'set tenancy ended');

    // Token should be auto-revoked now.
    const after = await submitIntake(t.secret, {
      area_id: u.unitAreaId,
      title: `post-end ${rnd()}`,
      severity: 'routine',
    });
    assertStatus(after, 404, 'submit after tenancy-ended auto-revoke');
  });

  // -----------------------------------------------------------------------
  // logged_at is server-set & immutable. The CREATE body for interactions
  // doesn't accept logged_at; the route never passes it; the Phase 3 trigger
  // would reject any UPDATE that changes it. Verify the route schema.
  // -----------------------------------------------------------------------
  await check('interactions: logged_at is server-set; client-set value is ignored', async () => {
    const u = await setupUser('LogTest');
    const r = await api('POST', `/v1/accounts/${u.accountId}/interactions`, {
      token: u.accessToken,
      body: {
        // logged_at intentionally injected -- the zod schema simply doesn't
        // declare it, so it's dropped before the insert. We still test the
        // recorded logged_at is "approximately now" (server-set).
        logged_at: '2020-01-01T00:00:00Z',
        party_type: 'tenant',
        channel: 'in_person',
        direction: 'inbound',
        occurred_at: '2026-03-01T09:00:00Z',
        body: 'doorstep conversation',
      },
    });
    const body = assertStatus(r, 201, 'create interaction') as { logged_at: string };
    const t = Date.parse(body.logged_at);
    if (!t || Math.abs(Date.now() - t) > 60_000) {
      throw new Error(`logged_at not server-now (got ${body.logged_at})`);
    }
  });

  // -----------------------------------------------------------------------
  // C2 usability fixes (2026-07): area_id defaults to the tenancy's unit,
  // 400s are actionable, and the token carries an honest success counter.
  // Fresh fixture + fresh token so the counter assertions are exact.
  // -----------------------------------------------------------------------
  await _resetIntakeIpBucketsForTests();
  const C = await setupUser('C2');
  const tokenC = await mintToken(C);

  await check('C2: submit without area_id -> 201, lands on the tenancy unit', async () => {
    // This is byte-for-byte the payload the FE tenant page sends.
    const r = await submitIntake(tokenC.secret, {
      title: 'Leaky kitchen faucet',
      severity: 'routine',
      description: 'drips constantly',
    });
    const body = assertStatus(r, 201, 'no-area submit') as { maintenance_request_id: string };
    const mr = await api(
      'GET',
      `/v1/accounts/${C.accountId}/maintenance-requests/${body.maintenance_request_id}`,
      { token: C.accessToken },
    );
    const mrBody = assertStatus(mr, 200, 'read request') as { area_id: string };
    if (mrBody.area_id !== C.unitAreaId) {
      throw new Error(`defaulted to ${mrBody.area_id}, expected the tenancy unit ${C.unitAreaId}`);
    }
  });

  await check('C2: malformed JSON body -> its own 400, not "Required" cascade', async () => {
    const res = await app.fetch(
      new Request(`http://test/v1/intake/${tokenC.secret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{oops',
      }),
    );
    const body = (await res.json()) as { error: { code: string; message: string } };
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    if (!/malformed JSON/i.test(body.error.message)) {
      throw new Error(`message should say malformed JSON, got: ${body.error.message}`);
    }
  });

  await check('C2: missing title -> 400 that names the field', async () => {
    const r = await submitIntake(tokenC.secret, { severity: 'routine' });
    assertStatus(r, 400, 'missing title');
    const err = (r.body as { error: { message: string; details?: { fieldErrors?: Record<string, unknown> } } }).error;
    if (!/title/.test(err.message)) {
      throw new Error(`message should name the missing field, got: ${err.message}`);
    }
    if (!err.details?.fieldErrors?.title) {
      throw new Error(`details.fieldErrors.title missing: ${JSON.stringify(err.details)}`);
    }
  });

  await check('C2: submission_count counts successes only; use_count counts attempts', async () => {
    // One more success: 2 successes total against 4 attempts (1 success,
    // 1 malformed, 1 missing-title, 1 success).
    const r = await submitIntake(tokenC.secret, {
      title: 'Second, separate issue: broken stove',
      severity: 'urgent',
    });
    assertStatus(r, 201, 'second success');
    const list = await api(
      'GET',
      `/v1/accounts/${C.accountId}/tenancies/${C.tenancyId}/intake-tokens`,
      { token: C.accessToken },
    );
    const rows = (assertStatus(list, 200, 'token list') as {
      data: { id: string; use_count: number; submission_count: number }[];
    }).data;
    const row = rows.find((t) => t.id === tokenC.id);
    if (!row) throw new Error('minted token missing from list');
    if (row.submission_count !== 2) {
      throw new Error(`submission_count: expected 2 successes, got ${row.submission_count}`);
    }
    if (row.use_count !== 4) {
      throw new Error(`use_count: expected 4 attempts in window, got ${row.use_count}`);
    }
  });

  await check('C2: explicit area_id: null also defaults to the tenancy unit', async () => {
    // Third-party serializers often emit absent optionals as null; the
    // schema is nullish so both shapes mean "use the default".
    const r = await submitIntake(tokenC.secret, {
      title: 'Third issue: hallway light out by my door',
      severity: 'routine',
      area_id: null,
    });
    const body = assertStatus(r, 201, 'null-area submit') as { maintenance_request_id: string };
    const mr = await api(
      'GET',
      `/v1/accounts/${C.accountId}/maintenance-requests/${body.maintenance_request_id}`,
      { token: C.accessToken },
    );
    const mrBody = assertStatus(mr, 200, 'read request') as { area_id: string };
    if (mrBody.area_id !== C.unitAreaId) {
      throw new Error(`null area_id defaulted to ${mrBody.area_id}, expected ${C.unitAreaId}`);
    }
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} intake DoD failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: intake DoD checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
