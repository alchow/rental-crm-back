// ----------------------------------------------------------------------------
// Incidents integration test (HTTP + raw PostgREST + raw SQL, against the local
// Supabase stack). Scenarios are named after the product use cases the incident
// research enumerated, so coverage reads against the research rather than
// against the route list:
//
//   UC2  inspection cited as incident evidence
//   UC3  repeat noise complaints -> capture, cite, recur, resolve
//   UC5  capture now, classify later (deferred classification)
//   UC6  maintenance request cited as evidence (the request row is untouched)
//   UC9  testimony written in pen (description / occurred_at frozen at capture)
//   UC11 a live citation freezes the cited journal entry
//   UC13 unlink is honest (soft, visible as history, never a hard delete)
//   UC18 dismiss (soft delete) is not the same fact as resolve
//
// Plus the mechanical contract around them: slot discipline, cross-account
// citation refusal, human-only writes (agent + viewer 403), incident
// attachments, and keyset pagination of the citation list.
//
// The DB-level probes matter as much as the HTTP ones: the route schema is a
// polite refusal, migration 20260801000002 is the enforcement layer. So every
// freeze is asserted twice -- once through the API, once through a real member
// JWT talking straight to PostgREST (and, for the no-hard-delete backstop,
// through a privileged SQL connection that bypasses RLS entirely).
// ----------------------------------------------------------------------------

import { Client as PgClient } from 'pg';
import {
  assert,
  assertStatus,
  configureIntegrationEnv,
  createApiClient,
  createCheckHarness,
  randomToken,
} from './helpers/integration';

const status = configureIntegrationEnv('8808');

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');
const { createClient } = await import('@supabase/supabase-js');

const app = buildApp();
const admin = getAdminClient();
const api = createApiClient(app);
const rnd = randomToken;
const { failures, check } = createCheckHarness();

// --- helpers ----------------------------------------------------------------

/** A member's REAL JWT against PostgREST: reads under RLS, and the raw-write
 *  threat model the DB triggers actually defend against. */
function memberClient(token: string) {
  return createClient(status.API_URL, status.ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } })?.error?.code ?? '<none>';
}

/** Deterministic deep-compare for the "citing evidence does not touch the cited
 *  row" assertion: key order from PostgREST is stable, but sorting removes any
 *  doubt about what the diff means. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const row = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((k) => [k, row[k]]),
      );
    }
    return v;
  });
}

const SLOT_KEYS = ['interaction', 'maintenance_request', 'notice', 'inspection'] as const;

interface HydratedItem {
  id: string;
  created_at: string;
  unlinked_at: string | null;
  interaction?: Record<string, unknown>;
  maintenance_request?: Record<string, unknown>;
  notice?: Record<string, unknown>;
  inspection?: Record<string, unknown>;
}

/** Exactly one populated evidence object per hydrated row -- the one-of
 *  contract the four typed FK slots exist to guarantee. */
function slotOf(row: HydratedItem): string {
  const present = SLOT_KEYS.filter((k) => row[k] !== undefined);
  if (present.length !== 1) {
    throw new Error(`expected exactly one hydrated slot, got [${present.join(', ')}]`);
  }
  return present[0]!;
}

// --- fixtures ---------------------------------------------------------------

interface Account {
  accountId: string;
  userId: string;
  token: string;
  propertyId: string;
  tenantId: string;
  /** Populated only for the account that also carries agent + viewer members. */
  agentToken: string;
  viewerToken: string;
}

async function createAuthUser(
  label: string,
): Promise<{ id: string; email: string; password: string }> {
  const email = `inc-${label}-${crypto.randomUUID()}@internal.test`;
  const password = `pw-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data?.user) throw new Error(`createUser ${label}: ${error?.message}`);
  return { id: data.user.id, email, password };
}

async function login(email: string, password: string): Promise<string> {
  const r = await api('POST', '/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { session: { access_token: string } }).session.access_token;
}

async function post<T>(token: string, path: string, body: unknown): Promise<T> {
  const r = await api('POST', path, { token, body });
  if (r.status !== 201)
    throw new Error(`setup POST ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

async function setupAccount(label: string, withRoles: boolean): Promise<Account> {
  const email = `inc-landlord-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Incidents ${label}` },
  });
  if (su.status !== 200)
    throw new Error(`signup ${label}: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  const accountId = b.account.id;
  const token = b.session.access_token;

  const property = await post<{ id: string }>(token, `/v1/accounts/${accountId}/properties`, {
    name: `${label} property`,
  });
  const tenant = await post<{ id: string }>(token, `/v1/accounts/${accountId}/tenants`, {
    full_name: `${label} tenant`,
  });

  let agentToken = '';
  let viewerToken = '';
  if (withRoles) {
    // The agent principal is nothing more than a role='agent' membership
    // (resolvePrincipal classifies off the scoped membership), so an agent
    // fixture is a real auth user + that membership row -- same recipe the
    // comms suites use.
    const agentAuth = await createAuthUser(`agent-${label}`);
    const viewerAuth = await createAuthUser(`viewer-${label}`);
    for (const [userId, role] of [
      [agentAuth.id, 'agent'],
      [viewerAuth.id, 'viewer'],
    ] as const) {
      const { error } = await admin
        .from('account_members')
        .insert({ account_id: accountId, user_id: userId, role });
      if (error) throw new Error(`membership ${role}: ${error.message}`);
    }
    agentToken = await login(agentAuth.email, agentAuth.password);
    viewerToken = await login(viewerAuth.email, viewerAuth.password);
  }

  return {
    accountId,
    userId: b.user.id,
    token,
    propertyId: property.id,
    tenantId: tenant.id,
    agentToken,
    viewerToken,
  };
}

/** One area per tenancy so scenarios never share a recurrence window. */
async function newTenancy(
  acct: Account,
  label: string,
): Promise<{ areaId: string; tenancyId: string }> {
  const area = await post<{ id: string }>(acct.token, `/v1/accounts/${acct.accountId}/areas`, {
    property_id: acct.propertyId,
    kind: 'unit',
    name: `${label}-${rnd()}`,
  });
  const tenancy = await post<{ id: string }>(
    acct.token,
    `/v1/accounts/${acct.accountId}/tenancies`,
    {
      area_id: area.id,
      start_date: '2026-01-01',
      status: 'active',
    },
  );
  return { areaId: area.id, tenancyId: tenancy.id };
}

/** An inbound-style journal entry: the tenant-complaint row an incident cites. */
async function journal(
  acct: Account,
  tenancyId: string,
  body: string,
  occurredAt: string,
): Promise<string> {
  const row = await post<{ id: string }>(
    acct.token,
    `/v1/accounts/${acct.accountId}/interactions`,
    {
      kind: 'communication',
      channel: 'sms',
      direction: 'inbound',
      party_type: 'tenant',
      party_id: acct.tenantId,
      tenancy_id: tenancyId,
      body,
      occurred_at: occurredAt,
    },
  );
  return row.id;
}

async function createIncident(
  acct: Account,
  body: Record<string, unknown>,
): Promise<{ status: number; incidentId: string; raw: unknown }> {
  const r = await api('POST', `/v1/accounts/${acct.accountId}/incidents`, {
    token: acct.token,
    body,
  });
  const parsed = r.body as { incident?: { id: string } };
  return { status: r.status, incidentId: parsed?.incident?.id ?? '', raw: r.body };
}

async function cite(
  acct: Account,
  incidentId: string,
  slots: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const r = await api('POST', `/v1/accounts/${acct.accountId}/incidents/${incidentId}/items`, {
    token: acct.token,
    body: slots,
  });
  return { status: r.status, body: r.body };
}

async function listItems(
  acct: Account,
  incidentId: string,
  query = '',
): Promise<{ data: HydratedItem[]; next_cursor: string | null }> {
  const r = await api(
    'GET',
    `/v1/accounts/${acct.accountId}/incidents/${incidentId}/items${query}`,
    { token: acct.token },
  );
  return assertStatus(r, 200, 'GET items') as { data: HydratedItem[]; next_cursor: string | null };
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// --- run --------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Incidents case-record checks');

  const A = await setupAccount('a', true);
  const B = await setupAccount('b', false);
  const landlordSb = memberClient(A.token);

  // Cross-account evidence: a journal row that exists, but not in A's account.
  const bTenancy = await newTenancy(B, 'b-unit');
  const foreignInteractionId = await journal(
    B,
    bTenancy.tenancyId,
    'Other account traffic',
    '2026-07-20T10:00:00.000Z',
  );

  // ==========================================================================
  // UC3 -- repeat noise complaints: capture, cite, recur, resolve.
  // ==========================================================================
  const noise = await newTenancy(A, 'noise');
  const NOISE_DESCRIPTION =
    'Unit 4B: "very loud bass" after 23:00 — third Saturday running.\n' +
    'Neighbour called me at home; I could hear it over the phone.';
  const NOISE_OCCURRED = '2026-07-04T22:15:00.000Z';
  let noiseIncidentId = '';
  let noiseComplaint1 = '';
  let noiseComplaint2 = '';
  let noiseNoticeId = '';

  await check(
    'UC3 capture: testimony is stored verbatim with a backdated occurred_at',
    async () => {
      noiseComplaint1 = await journal(
        A,
        noise.tenancyId,
        'Bass through the ceiling again, 11:40pm',
        '2026-07-04T22:40:00.000Z',
      );
      noiseComplaint2 = await journal(
        A,
        noise.tenancyId,
        'Same again tonight. Please do something.',
        '2026-07-11T23:05:00.000Z',
      );

      const created = await createIncident(A, {
        tenancy_id: noise.tenancyId,
        description: NOISE_DESCRIPTION,
        category: 'noise',
        occurred_at: NOISE_OCCURRED,
      });
      assert(
        created.status === 201,
        `capture expected 201, got ${created.status} ${JSON.stringify(created.raw)}`,
      );
      const body = created.raw as {
        incident: {
          id: string;
          description: string;
          occurred_at: string;
          category: string | null;
          resolved_at: string | null;
        };
        origin_item: unknown;
        warnings?: string[];
      };
      noiseIncidentId = body.incident.id;
      // Verbatim: not trimmed, not normalized, not re-wrapped.
      assert(
        body.incident.description === NOISE_DESCRIPTION,
        `description was not stored verbatim: ${JSON.stringify(body.incident.description)}`,
      );
      assert(
        Date.parse(body.incident.occurred_at) === Date.parse(NOISE_OCCURRED),
        `backdated occurred_at drifted: ${body.incident.occurred_at}`,
      );
      assert(body.incident.category === 'noise', 'category not stored');
      assert(body.incident.resolved_at === null, 'a fresh capture must be unresolved');
      assert(body.origin_item === null, 'no source was sent, so origin_item must be null');
      assert(body.warnings === undefined, `unexpected warnings: ${JSON.stringify(body.warnings)}`);
    },
  );

  await check(
    'UC3 cite: two journal entries + a served notice hydrate as one-of payloads',
    async () => {
      const first = await cite(A, noiseIncidentId, { interaction_id: noiseComplaint1 });
      assert(
        first.status === 201,
        `cite #1 expected 201, got ${first.status} ${JSON.stringify(first.body)}`,
      );
      const second = await cite(A, noiseIncidentId, { interaction_id: noiseComplaint2 });
      assert(
        second.status === 201,
        `cite #2 expected 201, got ${second.status} ${JSON.stringify(second.body)}`,
      );

      const notice = await post<{ id: string }>(A.token, `/v1/accounts/${A.accountId}/notices`, {
        tenancy_id: noise.tenancyId,
        notice_type: 'noise_warning',
        served_at: '2026-07-12T00:00:00.000Z',
        served_method: 'hand_delivered',
        body: 'Written warning re: repeated night-time noise.',
      });
      noiseNoticeId = notice.id;
      const third = await cite(A, noiseIncidentId, { notice_id: noiseNoticeId });
      assert(
        third.status === 201,
        `cite notice expected 201, got ${third.status} ${JSON.stringify(third.body)}`,
      );

      const page = await listItems(A, noiseIncidentId);
      assert(page.data.length === 3, `expected 3 live citations, got ${page.data.length}`);
      const slots = page.data.map(slotOf);
      assert(
        slots.filter((s) => s === 'interaction').length === 2 && slots.includes('notice'),
        `unexpected slot mix: ${slots.join(', ')}`,
      );
      for (const row of page.data) {
        assert(row.unlinked_at === null, 'a live citation must have unlinked_at null');
      }
      const citedInteraction = page.data.find((r) => r.interaction !== undefined)!.interaction!;
      // Chronology fields: when it happened AND when it was written down.
      for (const field of [
        'occurred_at',
        'logged_at',
        'body',
        'channel',
        'direction',
        'party_type',
      ]) {
        assert(citedInteraction[field] !== undefined, `cited interaction is missing ${field}`);
      }
      const citedNotice = page.data.find((r) => r.notice !== undefined)!.notice!;
      for (const field of ['notice_type', 'served_at', 'served_method', 'created_at']) {
        assert(citedNotice[field] !== undefined, `cited notice is missing ${field}`);
      }
      assert(
        citedNotice.notice_type === 'noise_warning',
        'notice projection carries the wrong row',
      );
    },
  );

  await check(
    'UC3 recurrence: a second same-category incident on the tenancy is counted',
    async () => {
      const before = await api(
        'GET',
        `/v1/accounts/${A.accountId}/incidents/${noiseIncidentId}/recurrence`,
        { token: A.token },
      );
      const first = assertStatus(before, 200, 'recurrence (single)') as { count: number };
      assert(first.count === 1, `expected count 1 before the repeat, got ${first.count}`);

      const repeat = await createIncident(A, {
        tenancy_id: noise.tenancyId,
        description: 'Fourth Saturday. Police were called by another neighbour.',
        category: 'noise',
        occurred_at: '2026-07-18T23:30:00.000Z',
      });
      assert(repeat.status === 201, `repeat capture expected 201, got ${repeat.status}`);

      const after = await api(
        'GET',
        `/v1/accounts/${A.accountId}/incidents/${noiseIncidentId}/recurrence?window_months=12`,
        { token: A.token },
      );
      const body = assertStatus(after, 200, 'recurrence (repeat)') as {
        category: string;
        window_months: number;
        count: number;
        incidents: { id: string; occurred_at: string; description: string }[];
      };
      assert(body.category === 'noise', `wrong recurrence category: ${body.category}`);
      assert(body.window_months === 12, `wrong window: ${body.window_months}`);
      assert(body.count === 2, `expected 2 noise incidents in the window, got ${body.count}`);
      const ids = body.incidents.map((r) => r.id);
      assert(
        ids.includes(noiseIncidentId) && ids.includes(repeat.incidentId),
        `recurrence list is missing one of the two incidents: ${ids.join(', ')}`,
      );
      // Newest first by occurred_at.
      assert(ids[0] === repeat.incidentId, 'recurrence list is not newest-first');
    },
  );

  await check('UC3 resolve: resolved_at + resolution_note are the mutable outcome', async () => {
    const r = await api('PATCH', `/v1/accounts/${A.accountId}/incidents/${noiseIncidentId}`, {
      token: A.token,
      body: {
        resolved_at: '2026-07-25T09:00:00.000Z',
        resolution_note: 'Tenant agreed to move the speakers; no further complaints in 14 days.',
      },
    });
    const body = assertStatus(r, 200, 'PATCH resolve') as {
      resolved_at: string;
      resolution_note: string;
      description: string;
    };
    assert(
      Date.parse(body.resolved_at) === Date.parse('2026-07-25T09:00:00.000Z'),
      `resolved_at not applied: ${body.resolved_at}`,
    );
    assert(body.resolution_note.startsWith('Tenant agreed'), 'resolution_note not applied');
    assert(body.description === NOISE_DESCRIPTION, 'resolving must not disturb the testimony');
  });

  // ==========================================================================
  // UC5 -- deferred classification: capture first, classify later.
  // ==========================================================================
  await check('UC5 deferred classification: unclassified 409, then recurrence works', async () => {
    const t = await newTenancy(A, 'deferred');
    const created = await createIncident(A, {
      tenancy_id: t.tenancyId,
      description: 'Tenant said something happened with the upstairs neighbour. Get details.',
    });
    assert(created.status === 201, `unclassified capture expected 201, got ${created.status}`);
    const captured = (created.raw as { incident: { category: string | null } }).incident;
    assert(captured.category === null, `expected null category, got ${String(captured.category)}`);

    const blocked = await api(
      'GET',
      `/v1/accounts/${A.accountId}/incidents/${created.incidentId}/recurrence`,
      { token: A.token },
    );
    assert(blocked.status === 409, `unclassified recurrence expected 409, got ${blocked.status}`);
    assert(
      errorCode(blocked.body) === 'unclassified',
      `expected code 'unclassified', got '${errorCode(blocked.body)}'`,
    );

    const classified = await api(
      'PATCH',
      `/v1/accounts/${A.accountId}/incidents/${created.incidentId}`,
      { token: A.token, body: { category: 'harassment' } },
    );
    const patched = assertStatus(classified, 200, 'PATCH classify') as { category: string };
    assert(patched.category === 'harassment', `classify did not apply: ${patched.category}`);

    const ok = await api(
      'GET',
      `/v1/accounts/${A.accountId}/incidents/${created.incidentId}/recurrence`,
      { token: A.token },
    );
    const body = assertStatus(ok, 200, 'recurrence after classify') as {
      category: string;
      count: number;
    };
    assert(
      body.category === 'harassment' && body.count === 1,
      `wrong post-classify recurrence: ${JSON.stringify(body)}`,
    );
  });

  // ==========================================================================
  // UC9 -- testimony written in pen. The route schema is the polite refusal;
  // the frozen-fields trigger is the enforcement.
  // ==========================================================================
  await check(
    'UC9 frozen testimony: API strips it, the DB rejects it, classification stays open',
    async () => {
      const t = await newTenancy(A, 'frozen');
      const created = await createIncident(A, {
        tenancy_id: t.tenancyId,
        description: 'Original wording of the damage report.',
        category: 'property_damage',
        occurred_at: '2026-06-01T12:00:00.000Z',
      });
      assert(created.status === 201, `frozen fixture capture expected 201, got ${created.status}`);
      const id = created.incidentId;

      // (a) PATCH carrying ONLY description: the field is absent from the schema,
      // so it is stripped and the "at least one field" refine fails -> 400.
      const onlyDescription = await api('PATCH', `/v1/accounts/${A.accountId}/incidents/${id}`, {
        token: A.token,
        body: { description: 'rewritten history' },
      });
      assert(
        onlyDescription.status === 400,
        `description-only PATCH expected 400, got ${onlyDescription.status}`,
      );

      // (b) PATCH smuggling description alongside a legal field: the legal field
      // applies, the testimony does not move.
      const smuggled = await api('PATCH', `/v1/accounts/${A.accountId}/incidents/${id}`, {
        token: A.token,
        body: {
          category: 'other',
          description: 'rewritten history',
          occurred_at: '2020-01-01T00:00:00.000Z',
        },
      });
      const smuggledBody = assertStatus(smuggled, 200, 'PATCH with smuggled fields') as {
        category: string;
        description: string;
        occurred_at: string;
      };
      assert(smuggledBody.category === 'other', 'the legal field should still apply');
      assert(
        smuggledBody.description === 'Original wording of the damage report.',
        `description was rewritten through PATCH: ${smuggledBody.description}`,
      );
      assert(
        Date.parse(smuggledBody.occurred_at) === Date.parse('2026-06-01T12:00:00.000Z'),
        `occurred_at was rewritten through PATCH: ${smuggledBody.occurred_at}`,
      );

      // (c) Straight to PostgREST with the landlord's own JWT -- no route schema
      // in the way. The frozen-fields trigger raises check_violation (23514).
      const rawDescription = await landlordSb
        .from('incidents')
        .update({ description: 'tampered at the database' })
        .eq('id', id)
        .select('id');
      assert(
        rawDescription.error?.code === '23514',
        `raw description UPDATE should hit the frozen-fields trigger, got ${JSON.stringify(rawDescription.error)}`,
      );
      const rawOccurred = await landlordSb
        .from('incidents')
        .update({ occurred_at: '2020-01-01T00:00:00.000Z' })
        .eq('id', id)
        .select('id');
      assert(
        rawOccurred.error?.code === '23514',
        `raw occurred_at UPDATE should hit the frozen-fields trigger, got ${JSON.stringify(rawOccurred.error)}`,
      );

      // (d) category is mutable BY DESIGN (deferred classification), so the same
      // raw path succeeds -- the trigger is a field allowlist, not a table lock.
      const rawCategory = await landlordSb
        .from('incidents')
        .update({ category: 'unauthorized_alteration' })
        .eq('id', id)
        .select('category')
        .single();
      assert(
        !rawCategory.error,
        `raw category UPDATE should succeed: ${JSON.stringify(rawCategory.error)}`,
      );
      assert(
        (rawCategory.data as { category: string } | null)?.category === 'unauthorized_alteration',
        'raw category UPDATE did not apply',
      );
    },
  );

  // ==========================================================================
  // UC11 -- a live citation freezes the cited journal entry; the freeze is
  // citation-scoped, so unlinking releases it.
  // ==========================================================================
  await check(
    'UC11 linked-evidence freeze: probative fields lock while cited, release on unlink',
    async () => {
      const t = await newTenancy(A, 'freeze');
      const interactionId = await journal(
        A,
        t.tenancyId,
        'Original tenant wording that the incident rests on.',
        '2026-05-02T18:00:00.000Z',
      );
      const created = await createIncident(A, {
        tenancy_id: t.tenancyId,
        description: 'Incident that cites the message above.',
        category: 'harassment',
      });
      assert(created.status === 201, `freeze fixture capture expected 201, got ${created.status}`);
      const cited = await cite(A, created.incidentId, { interaction_id: interactionId });
      assert(
        cited.status === 201,
        `cite expected 201, got ${cited.status} ${JSON.stringify(cited.body)}`,
      );
      const itemId = (cited.body as { id: string }).id;

      // body is testimony the incident rests on -> frozen.
      const frozenBody = await landlordSb
        .from('interactions')
        .update({ body: 'tampered evidence' })
        .eq('id', interactionId)
        .select('id');
      assert(
        frozenBody.error?.code === '23514' &&
          /cited by incident [0-9a-f-]{36}/.test(frozenBody.error.message),
        `cited body UPDATE should be rejected naming the citing incident, got ${JSON.stringify(frozenBody.error)}`,
      );

      // confirmed_at/confirmed_by are workflow, not testimony -> still writable.
      // (The table CHECK pairs the two, so they move together.)
      const confirmedAt = new Date().toISOString();
      const allowed = await landlordSb
        .from('interactions')
        .update({ confirmed_at: confirmedAt, confirmed_by: A.userId })
        .eq('id', interactionId)
        .select('confirmed_at, confirmed_by')
        .single();
      assert(
        !allowed.error,
        `confirmed_at UPDATE should be allowed: ${JSON.stringify(allowed.error)}`,
      );
      const confirmedRow = allowed.data as {
        confirmed_at: string | null;
        confirmed_by: string | null;
      } | null;
      assert(
        confirmedRow?.confirmed_at !== null && confirmedRow?.confirmed_by === A.userId,
        `confirm stamp did not apply: ${JSON.stringify(confirmedRow)}`,
      );

      // Deleting cited evidence would hollow out the incident -> refused.
      const deleteCited = await landlordSb
        .from('interactions')
        .delete()
        .eq('id', interactionId)
        .select('id');
      assert(
        deleteCited.error?.code === '23514',
        `deleting cited evidence should be rejected, got ${JSON.stringify(deleteCited.error)}`,
      );

      // Unlink -> the freeze is citation-scoped, so the entry is writable again.
      const unlink = await api(
        'DELETE',
        `/v1/accounts/${A.accountId}/incidents/${created.incidentId}/items/${itemId}`,
        { token: A.token },
      );
      assert(
        unlink.status === 204,
        `unlink expected 204, got ${unlink.status} ${JSON.stringify(unlink.body)}`,
      );

      const afterUnlink = await landlordSb
        .from('interactions')
        .update({ body: 'edited after the citation was withdrawn' })
        .eq('id', interactionId)
        .select('body')
        .single();
      assert(
        !afterUnlink.error,
        `body UPDATE after unlink should succeed: ${JSON.stringify(afterUnlink.error)}`,
      );
      assert(
        (afterUnlink.data as { body: string } | null)?.body ===
          'edited after the citation was withdrawn',
        'post-unlink body edit did not apply',
      );
    },
  );

  // ==========================================================================
  // UC13 -- unlink is honest: soft, visible as history, never a hard delete.
  // ==========================================================================
  await check(
    'UC13 honest unlink: hidden by default, visible as history, second unlink 409, hard delete refused',
    async () => {
      const t = await newTenancy(A, 'unlink');
      const interactionId = await journal(
        A,
        t.tenancyId,
        'Cited by mistake; will be unlinked.',
        '2026-05-09T09:00:00.000Z',
      );
      const created = await createIncident(A, {
        tenancy_id: t.tenancyId,
        description: 'Incident whose citation gets withdrawn.',
        category: 'sanitation',
      });
      const cited = await cite(A, created.incidentId, { interaction_id: interactionId });
      assert(cited.status === 201, `cite expected 201, got ${cited.status}`);
      const itemId = (cited.body as { id: string }).id;

      const first = await api(
        'DELETE',
        `/v1/accounts/${A.accountId}/incidents/${created.incidentId}/items/${itemId}`,
        { token: A.token },
      );
      assert(first.status === 204, `first unlink expected 204, got ${first.status}`);

      const live = await listItems(A, created.incidentId);
      assert(
        live.data.length === 0,
        `unlinked citation must be hidden by default, got ${live.data.length} rows`,
      );

      const history = await listItems(A, created.incidentId, '?include_unlinked=true');
      assert(
        history.data.length === 1,
        `citation history must survive, got ${history.data.length} rows`,
      );
      assert(history.data[0]!.id === itemId, 'history returned the wrong row');
      assert(
        history.data[0]!.unlinked_at !== null,
        'unlinked_at must be stamped on a withdrawn citation',
      );
      assert(slotOf(history.data[0]!) === 'interaction', 'history row lost its hydrated payload');

      const second = await api(
        'DELETE',
        `/v1/accounts/${A.accountId}/incidents/${created.incidentId}/items/${itemId}`,
        { token: A.token },
      );
      assert(second.status === 409, `second unlink expected 409, got ${second.status}`);
      assert(
        errorCode(second.body) === 'already_unlinked',
        `expected code 'already_unlinked', got '${errorCode(second.body)}'`,
      );

      // A member has no DELETE grant at all on incident_items -- the citation row
      // is not erasable through the client credential.
      const rawDelete = await landlordSb
        .from('incident_items')
        .delete()
        .eq('id', itemId)
        .select('id');
      assert(
        rawDelete.error !== null,
        'a member JWT must not be able to hard-delete a citation row',
      );
      assert(
        rawDelete.error?.code === '42501',
        `expected a permission denial (42501) for the member hard delete, got ${JSON.stringify(rawDelete.error)}`,
      );

      // ...and the trigger backstop still refuses even from a privileged SQL
      // connection that bypasses RLS and holds DELETE, which is the only way a
      // future admin path could reach the row.
      const pg = new PgClient({ connectionString: status.DB_URL });
      await pg.connect();
      try {
        await pg.query('delete from public.incident_items where id = $1', [itemId]);
        throw new Error('privileged hard delete of a citation row was NOT rejected');
      } catch (error) {
        const code = (error as { code?: string }).code;
        const message = (error as { message?: string }).message ?? '';
        assert(
          code === '23514' && /cannot be deleted/.test(message),
          `expected the no-delete trigger, got code=${String(code)} message=${message}`,
        );
      } finally {
        await pg.end();
      }
    },
  );

  // ==========================================================================
  // UC2 + UC6 -- an inspection and a maintenance request are evidence slots.
  // Citing them must be a pure read of the cited record.
  // ==========================================================================
  await check(
    'UC2/UC6 inspection + maintenance slots: citing leaves the cited row byte-identical',
    async () => {
      const t = await newTenancy(A, 'slots');
      const inspection = await post<{ id: string }>(
        A.token,
        `/v1/accounts/${A.accountId}/inspections`,
        {
          area_id: t.areaId,
          tenancy_id: t.tenancyId,
          kind: 'periodic',
          performed_at: '2026-06-15T10:00:00.000Z',
          notes: 'Routine walk-through that recorded the damage.',
        },
      );
      const request = await post<{ id: string }>(
        A.token,
        `/v1/accounts/${A.accountId}/maintenance-requests`,
        {
          area_id: t.areaId,
          title: 'Kitchen cabinet door torn off',
          description: 'Hinges pulled out of the frame.',
          severity: 'urgent',
        },
      );

      const before = await admin
        .from('maintenance_requests')
        .select('*')
        .eq('id', request.id)
        .single();
      assert(!before.error && before.data, `read maintenance row: ${before.error?.message}`);

      const created = await createIncident(A, {
        tenancy_id: t.tenancyId,
        description: 'Cabinet damage found at the June walk-through.',
        category: 'property_damage',
      });
      const citedInspection = await cite(A, created.incidentId, { inspection_id: inspection.id });
      assert(
        citedInspection.status === 201,
        `cite inspection expected 201, got ${citedInspection.status} ${JSON.stringify(citedInspection.body)}`,
      );
      const citedRequest = await cite(A, created.incidentId, {
        maintenance_request_id: request.id,
      });
      assert(
        citedRequest.status === 201,
        `cite maintenance expected 201, got ${citedRequest.status} ${JSON.stringify(citedRequest.body)}`,
      );

      const after = await admin
        .from('maintenance_requests')
        .select('*')
        .eq('id', request.id)
        .single();
      assert(!after.error && after.data, `re-read maintenance row: ${after.error?.message}`);
      assert(
        stable(before.data) === stable(after.data),
        `citing mutated the maintenance request:\n  before=${stable(before.data)}\n  after =${stable(after.data)}`,
      );

      const page = await listItems(A, created.incidentId);
      assert(page.data.length === 2, `expected 2 citations, got ${page.data.length}`);
      const bySlot = new Map(page.data.map((row) => [slotOf(row), row]));
      assert(
        bySlot.has('inspection') && bySlot.has('maintenance_request'),
        'wrong slot mix for the two citations',
      );
      const inspectionPayload = bySlot.get('inspection')!.inspection!;
      for (const field of ['kind', 'status', 'performed_at', 'completed_at', 'created_at']) {
        assert(inspectionPayload[field] !== undefined, `cited inspection is missing ${field}`);
      }
      const requestPayload = bySlot.get('maintenance_request')!.maintenance_request!;
      assert(
        requestPayload.title === 'Kitchen cabinet door torn off',
        'maintenance projection carries the wrong row',
      );
      assert(requestPayload.severity === 'urgent', 'maintenance projection lost severity');
    },
  );

  // ==========================================================================
  // UC18 -- dismissal and resolution are different facts.
  // ==========================================================================
  await check(
    'UC18 dismiss vs resolve: dismissal leaves the working set, resolution stays on the record',
    async () => {
      const t = await newTenancy(A, 'dismiss');
      const dismissed = await createIncident(A, {
        tenancy_id: t.tenancyId,
        description: 'Reported by the wrong unit; not this tenancy.',
        category: 'smoking',
      });
      const resolved = await createIncident(A, {
        tenancy_id: t.tenancyId,
        description: 'Cigarette smoke in the stairwell; tenant agreed to stop.',
        category: 'smoking',
      });

      const remove = await api(
        'DELETE',
        `/v1/accounts/${A.accountId}/incidents/${dismissed.incidentId}`,
        {
          token: A.token,
        },
      );
      assert(
        remove.status === 204,
        `dismiss expected 204, got ${remove.status} ${JSON.stringify(remove.body)}`,
      );
      const gone = await api(
        'GET',
        `/v1/accounts/${A.accountId}/incidents/${dismissed.incidentId}`,
        {
          token: A.token,
        },
      );
      assert(gone.status === 404, `dismissed incident GET expected 404, got ${gone.status}`);

      const patched = await api(
        'PATCH',
        `/v1/accounts/${A.accountId}/incidents/${resolved.incidentId}`,
        {
          token: A.token,
          body: {
            resolved_at: '2026-07-30T12:00:00.000Z',
            resolution_note: 'Verbal agreement; no repeat.',
          },
        },
      );
      assertStatus(patched, 200, 'PATCH resolve');

      const openList = await api(
        'GET',
        `/v1/accounts/${A.accountId}/incidents?tenancy_id=${t.tenancyId}&open=true`,
        { token: A.token },
      );
      const openBody = assertStatus(openList, 200, 'list open=true') as { data: { id: string }[] };
      const openIds = openBody.data.map((r) => r.id);
      assert(!openIds.includes(dismissed.incidentId), 'a dismissed incident must not be listed');
      assert(!openIds.includes(resolved.incidentId), 'a resolved incident is not open');

      const closedList = await api(
        'GET',
        `/v1/accounts/${A.accountId}/incidents?tenancy_id=${t.tenancyId}&open=false`,
        { token: A.token },
      );
      const closedBody = assertStatus(closedList, 200, 'list open=false') as {
        data: { id: string }[];
      };
      const closedIds = closedBody.data.map((r) => r.id);
      assert(
        closedIds.includes(resolved.incidentId),
        'a resolved incident must remain on the record',
      );
      assert(
        !closedIds.includes(dismissed.incidentId),
        'a dismissed incident must not resurface under open=false',
      );
    },
  );

  // ==========================================================================
  // Slot discipline + cross-account citations.
  // ==========================================================================
  await check(
    'slot discipline: zero/two slots 400, duplicate live citation 409, cross-account refused',
    async () => {
      const t = await newTenancy(A, 'slots-guard');
      const interactionId = await journal(
        A,
        t.tenancyId,
        'A message to cite twice.',
        '2026-05-20T08:00:00.000Z',
      );
      const created = await createIncident(A, {
        tenancy_id: t.tenancyId,
        description: 'Slot-discipline fixture.',
        category: 'other',
      });

      const zero = await cite(A, created.incidentId, {});
      assert(
        zero.status === 400,
        `zero slots expected 400, got ${zero.status} ${JSON.stringify(zero.body)}`,
      );

      const two = await cite(A, created.incidentId, {
        interaction_id: interactionId,
        notice_id: noiseNoticeId,
      });
      assert(
        two.status === 400,
        `two slots expected 400, got ${two.status} ${JSON.stringify(two.body)}`,
      );

      const once = await cite(A, created.incidentId, { interaction_id: interactionId });
      assert(once.status === 201, `first citation expected 201, got ${once.status}`);
      const twice = await cite(A, created.incidentId, { interaction_id: interactionId });
      assert(
        twice.status === 409,
        `duplicate live citation expected 409, got ${twice.status} ${JSON.stringify(twice.body)}`,
      );
      assert(
        errorCode(twice.body) === 'already_cited',
        `expected code 'already_cited', got '${errorCode(twice.body)}'`,
      );

      // A capture is never lost to a bad link: the incident is created (201) and
      // the failed cross-account link is reported as a warning.
      const withForeignSource = await createIncident(A, {
        tenancy_id: t.tenancyId,
        description: 'Captured while citing evidence that belongs to another account.',
        category: 'other',
        source: { interaction_id: foreignInteractionId },
      });
      assert(
        withForeignSource.status === 201,
        `cross-account source expected 201, got ${withForeignSource.status}`,
      );
      const warned = withForeignSource.raw as { origin_item: unknown; warnings?: string[] };
      assert(warned.origin_item === null, 'a failed source link must not report an origin_item');
      assert(
        Array.isArray(warned.warnings) && warned.warnings.length === 1,
        `expected one warning, got ${JSON.stringify(warned.warnings)}`,
      );
      assert(
        warned.warnings![0]!.startsWith('source_link_failed:'),
        `unexpected warning text: ${warned.warnings![0]}`,
      );

      // The explicit citation endpoint is a hard 404 for the same id: there is no
      // capture to preserve, so the caller gets a real error.
      const foreignCite = await cite(A, created.incidentId, {
        interaction_id: foreignInteractionId,
      });
      assert(
        foreignCite.status === 404,
        `cross-account citation expected 404, got ${foreignCite.status} ${JSON.stringify(foreignCite.body)}`,
      );
    },
  );

  // ==========================================================================
  // Human-only writes: the agent principal and viewers read, never author.
  // ==========================================================================
  await check(
    'guards: the agent principal reads but cannot author; a viewer is read-only',
    async () => {
      const agentList = await api('GET', `/v1/accounts/${A.accountId}/incidents`, {
        token: A.agentToken,
      });
      assertStatus(agentList, 200, 'agent GET /incidents');

      const agentCreate = await api('POST', `/v1/accounts/${A.accountId}/incidents`, {
        token: A.agentToken,
        body: {
          tenancy_id: noise.tenancyId,
          description: 'Agent-authored testimony',
          category: 'noise',
        },
      });
      assert(agentCreate.status === 403, `agent POST expected 403, got ${agentCreate.status}`);
      assert(
        errorCode(agentCreate.body) === 'forbidden',
        `expected 'forbidden', got '${errorCode(agentCreate.body)}'`,
      );

      const agentCite = await api(
        'POST',
        `/v1/accounts/${A.accountId}/incidents/${noiseIncidentId}/items`,
        { token: A.agentToken, body: { notice_id: noiseNoticeId } },
      );
      assert(agentCite.status === 403, `agent POST items expected 403, got ${agentCite.status}`);

      const viewerList = await api('GET', `/v1/accounts/${A.accountId}/incidents`, {
        token: A.viewerToken,
      });
      assertStatus(viewerList, 200, 'viewer GET /incidents');
      const viewerItems = await api(
        'GET',
        `/v1/accounts/${A.accountId}/incidents/${noiseIncidentId}/items`,
        { token: A.viewerToken },
      );
      assertStatus(viewerItems, 200, 'viewer GET items');

      const viewerCreate = await api('POST', `/v1/accounts/${A.accountId}/incidents`, {
        token: A.viewerToken,
        body: {
          tenancy_id: noise.tenancyId,
          description: 'Viewer-authored testimony',
          category: 'noise',
        },
      });
      assert(viewerCreate.status === 403, `viewer POST expected 403, got ${viewerCreate.status}`);
      const viewerPatch = await api(
        'PATCH',
        `/v1/accounts/${A.accountId}/incidents/${noiseIncidentId}`,
        {
          token: A.viewerToken,
          body: { category: 'other' },
        },
      );
      assert(viewerPatch.status === 403, `viewer PATCH expected 403, got ${viewerPatch.status}`);
      const viewerDelete = await api(
        'DELETE',
        `/v1/accounts/${A.accountId}/incidents/${noiseIncidentId}`,
        {
          token: A.viewerToken,
        },
      );
      assert(viewerDelete.status === 403, `viewer DELETE expected 403, got ${viewerDelete.status}`);

      // The refused writes changed nothing.
      const still = await api('GET', `/v1/accounts/${A.accountId}/incidents/${noiseIncidentId}`, {
        token: A.token,
      });
      const body = assertStatus(still, 200, 'incident after refused writes') as {
        category: string;
        deleted_at: string | null;
      };
      assert(
        body.category === 'noise' && body.deleted_at === null,
        `refused writes leaked: ${JSON.stringify(body)}`,
      );
    },
  );

  // ==========================================================================
  // Attachments: damage photos hang off the incident like any other entity.
  // ==========================================================================
  await check('attachments: an incident photo uploads and lists back', async () => {
    const form = new FormData();
    form.set('entity_type', 'incidents');
    form.set('entity_id', noiseIncidentId);
    form.set('file', new File([PNG_1X1], 'damage.png', { type: 'image/png' }));
    const upload = await api('POST', `/v1/accounts/${A.accountId}/attachments`, {
      token: A.token,
      multipart: form,
    });
    const uploaded = assertStatus(upload, 201, 'upload incident attachment') as {
      attachment: { id: string; entity_type: string; entity_id: string };
    };
    assert(uploaded.attachment.entity_type === 'incidents', 'wrong entity_type stored');
    assert(uploaded.attachment.entity_id === noiseIncidentId, 'wrong entity_id stored');

    const list = await api(
      'GET',
      `/v1/accounts/${A.accountId}/attachments?entity_type=incidents&entity_id=${noiseIncidentId}`,
      { token: A.token },
    );
    const listed = assertStatus(list, 200, 'list incident attachments') as {
      data: { id: string }[];
    };
    assert(
      listed.data.some((r) => r.id === uploaded.attachment.id),
      'the uploaded incident attachment did not list back',
    );
  });

  // ==========================================================================
  // Keyset pagination over the citation list.
  // ==========================================================================
  await check('keyset pagination: three pages of citations with no dupes or gaps', async () => {
    const t = await newTenancy(A, 'paging');
    const created = await createIncident(A, {
      tenancy_id: t.tenancyId,
      description: 'Incident with a long evidence trail.',
      category: 'nonpayment',
    });
    const expected: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const interactionId = await journal(
        A,
        t.tenancyId,
        `Chaser #${i + 1} about the arrears.`,
        `2026-04-0${i + 1}T09:00:00.000Z`,
      );
      const cited = await cite(A, created.incidentId, { interaction_id: interactionId });
      assert(cited.status === 201, `cite #${i + 1} expected 201, got ${cited.status}`);
      expected.push((cited.body as { id: string }).id);
    }

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const page = await listItems(A, created.incidentId, query);
      pages += 1;
      assert(page.data.length <= 2, `page ${pages} exceeded the limit: ${page.data.length}`);
      walked.push(...page.data.map((r) => r.id));
      cursor = page.next_cursor;
      assert(pages <= 10, 'pagination did not terminate');
    } while (cursor !== null);

    assert(pages === 3, `expected 3 pages at limit=2 over 5 citations, got ${pages}`);
    assert(walked.length === 5, `expected 5 rows across the walk, got ${walked.length}`);
    assert(new Set(walked).size === 5, `pagination returned duplicates: ${walked.join(', ')}`);
    for (const id of expected) {
      assert(walked.includes(id), `pagination dropped citation ${id}`);
    }
  });
}

await main();

if (failures.length > 0) {
  console.error(`\n${failures.length} incidents failure(s):`);
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.detail}`);
  process.exit(1);
}

console.info('\nOK: incidents case-record checks all green');
