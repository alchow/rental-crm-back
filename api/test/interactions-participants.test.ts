// ----------------------------------------------------------------------------
// Interactions participants-cast DoD checks — the manual capture path's
// interaction_participants round-trip (work item EV-A, the API surface of the
// 20260703000003 rework).
//
// The journal's single counterparty slot cannot describe a group meeting or a
// witnessed exchange. POST /v1/accounts/{id}/interactions now accepts an
// optional `participants` array (kind='communication' only, 1..20 rows). When
// present, the row is created via the atomic journal_with_participants RPC:
// the response is stamped attestation='attested' and carries the created cast
// (source='capture'); GET (single + list) embed the same cast. Without
// participants the legacy path is preserved verbatim (attestation null,
// participants []).
//
// Covers:
//   (a) manual create with 3 attendees (in-person group) round-trips
//       POST -> GET -> list; attestation='attested'; each cast row
//       source='capture'.
//   (b) witnessed exchange: sender + recipient cast; the row is landlord-
//       authored (author_type='landlord'), attribution unaffected by the cast.
//   (c) plain create (no participants) -> attestation null, participants [].
//   (d) participants on kind='note' -> 400.
//   (e) a participant role outside the vocab ('author') -> 400.
//   (f) a participant party_type='platform' (reserved for the wire paths) -> 400.
//   (g) 21 participants (over the 1..20 bound) -> 400.
//   (h) participants on a correction (corrects_id set) -> 400.
//   (i) GET list embeds each row's cast (multiple rows, correct per-row).
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

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
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
  const email = `ip-${label}-${rnd()}@example.test`;
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
interface Participant {
  role: string;
  party_type: string;
  party_id: string | null;
  address: string | null;
  label: string | null;
  source: string;
}

interface InteractionRow {
  id: string;
  kind: string;
  channel: string;
  direction: string;
  party_type: string;
  party_id: string | null;
  party_label: string | null;
  body: string | null;
  occurred_at: string;
  author_type: string;
  attestation: string | null;
  participants: Participant[];
  corrects_id: string | null;
  correction_kind: string | null;
  is_head: boolean;
  actor: string;
  tenancy_id: string | null;
}

// Find exactly one cast row matching a predicate; throws if not unique.
function one(cast: Participant[], pred: (p: Participant) => boolean, ctx: string): Participant {
  const hits = cast.filter(pred);
  if (hits.length !== 1) {
    throw new Error(`${ctx}: expected exactly 1 participant, got ${hits.length} (cast=${JSON.stringify(cast)})`);
  }
  return hits[0]!;
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Interactions participants-cast DoD checks');
  const A = await setupUser('A');
  const base = `/v1/accounts/${A.accountId}/interactions`;

  const createInteraction = async (body: Record<string, unknown>, key?: string): Promise<ApiResp> =>
    api('POST', base, { token: A.accessToken, body, idempotencyKey: key });

  // A communication with no single counterparty (the cast carries the people):
  // party_type='unspecified' is the role-unknown sentinel and carries no
  // top-level party_id.
  const commBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    party_type: 'unspecified',
    channel: 'in_person',
    direction: 'mutual',
    occurred_at: '2026-04-01T10:00:00.000Z',
    body: 'Logged an in-person contact.',
    tenancy_id: A.tenancyId,
    ...overrides,
  });

  // =========================================================================
  // (a) manual create with 3 attendees round-trips POST -> GET -> list
  // =========================================================================

  await check('attendees: 3-attendee in-person group round-trips; attestation=attested; source=capture', async () => {
    const alice = crypto.randomUUID();
    const bob = crypto.randomUUID();
    const pete = crypto.randomUUID();
    const r = await createInteraction(commBody({
      body: 'Site walkthrough with both tenants and the plumber.',
      participants: [
        { role: 'attendee', party_type: 'tenant', party_id: alice, label: 'Alice Tenant' },
        { role: 'attendee', party_type: 'tenant', party_id: bob, label: 'Bob Tenant' },
        { role: 'attendee', party_type: 'vendor', party_id: pete, label: 'Pete Plumber' },
      ],
    }));
    const row = assertStatus(r, 201, 'create with attendees') as InteractionRow;
    if (row.kind !== 'communication') throw new Error(`kind: ${row.kind}`);
    if (row.attestation !== 'attested') throw new Error(`attestation: ${row.attestation}`);
    if (!Array.isArray(row.participants) || row.participants.length !== 3) {
      throw new Error(`participants echoed: ${JSON.stringify(row.participants)}`);
    }
    for (const p of row.participants) {
      if (p.role !== 'attendee') throw new Error(`role: ${p.role}`);
      if (p.source !== 'capture') throw new Error(`source: ${p.source}`);
    }
    const a = one(row.participants, (p) => p.party_id === alice, 'alice');
    if (a.party_type !== 'tenant' || a.label !== 'Alice Tenant') throw new Error(`alice=${JSON.stringify(a)}`);
    const pl = one(row.participants, (p) => p.party_id === pete, 'pete');
    if (pl.party_type !== 'vendor' || pl.label !== 'Pete Plumber') throw new Error(`pete=${JSON.stringify(pl)}`);

    // GET single embeds the cast.
    const g = await api('GET', `${base}/${row.id}`, { token: A.accessToken });
    const got = assertStatus(g, 200, 'get back') as InteractionRow;
    if (got.attestation !== 'attested') throw new Error(`GET attestation: ${got.attestation}`);
    if (got.participants.length !== 3) throw new Error(`GET participants: ${JSON.stringify(got.participants)}`);

    // List embeds the cast.
    const list = await api('GET', `${base}?limit=100`, { token: A.accessToken });
    const rows = (assertStatus(list, 200, 'list') as { data: InteractionRow[] }).data;
    const found = rows.find((x) => x.id === row.id);
    if (!found) throw new Error('created row missing from list');
    if (found.participants.length !== 3) throw new Error(`list participants: ${JSON.stringify(found.participants)}`);
  });

  // =========================================================================
  // (b) witnessed exchange: sender + recipient; row is landlord-authored
  // =========================================================================

  await check('witnessed exchange: sender+recipient cast; row author_type=landlord', async () => {
    const tenant = crypto.randomUUID();
    const r = await createInteraction(commBody({
      party_type: 'tenant',
      party_id: tenant, // filed under the tenant (legacy headline slot)
      body: 'Cash rent handed over, witnessed by the building super.',
      participants: [
        { role: 'sender', party_type: 'tenant', party_id: tenant, label: 'Alice Tenant' },
        { role: 'recipient', party_type: 'landlord_user', party_id: A.userId, label: 'Me Landlord' },
      ],
    }));
    const row = assertStatus(r, 201, 'create witnessed') as InteractionRow;
    if (row.attestation !== 'attested') throw new Error(`attestation: ${row.attestation}`);
    // The cast describes the event; authorship stays on the row and follows the
    // acting principal (owner -> landlord), never the cast.
    if (row.author_type !== 'landlord') throw new Error(`author_type: ${row.author_type}`);
    if (row.participants.length !== 2) throw new Error(`participants: ${JSON.stringify(row.participants)}`);
    const sender = one(row.participants, (p) => p.role === 'sender', 'sender');
    if (sender.party_type !== 'tenant' || sender.party_id !== tenant) throw new Error(`sender=${JSON.stringify(sender)}`);
    if (sender.source !== 'capture') throw new Error(`sender source: ${sender.source}`);
    const recipient = one(row.participants, (p) => p.role === 'recipient', 'recipient');
    if (recipient.party_type !== 'landlord_user' || recipient.party_id !== A.userId) {
      throw new Error(`recipient=${JSON.stringify(recipient)}`);
    }
  });

  // =========================================================================
  // (c) plain create without participants -> legacy path preserved
  // =========================================================================

  await check('plain create (no participants): attestation null, participants []', async () => {
    const r = await createInteraction(commBody({ party_type: 'tenant', body: 'Phoned about the gate code.' }));
    const row = assertStatus(r, 201, 'plain create') as InteractionRow;
    if (row.attestation !== null) throw new Error(`attestation must be null on the legacy path, got ${row.attestation}`);
    if (!Array.isArray(row.participants) || row.participants.length !== 0) {
      throw new Error(`participants must be [], got ${JSON.stringify(row.participants)}`);
    }
    // GET agrees.
    const g = await api('GET', `${base}/${row.id}`, { token: A.accessToken });
    const got = assertStatus(g, 200, 'get plain') as InteractionRow;
    if (got.attestation !== null) throw new Error(`GET attestation: ${got.attestation}`);
    if (got.participants.length !== 0) throw new Error(`GET participants: ${JSON.stringify(got.participants)}`);
  });

  // =========================================================================
  // (d)-(h) rejections
  // =========================================================================

  await check("participants on kind='note' -> 400", async () => {
    const r = await createInteraction({
      kind: 'note',
      occurred_at: '2026-04-02T09:00:00.000Z',
      body: 'Inspected roof; one cracked tile.',
      participants: [{ role: 'attendee', party_type: 'tenant', label: 'Alice Tenant' }],
    });
    assertStatus(r, 400, 'participants on note');
  });

  await check("participant role outside the vocab ('author') -> 400", async () => {
    const r = await createInteraction(commBody({
      participants: [{ role: 'author', party_type: 'tenant', label: 'Alice Tenant' }],
    }));
    assertStatus(r, 400, "role 'author'");
  });

  await check("participant party_type='platform' (reserved for wire paths) -> 400", async () => {
    const r = await createInteraction(commBody({
      participants: [{ role: 'recipient', party_type: 'platform', address: '+15551230000' }],
    }));
    assertStatus(r, 400, "party_type 'platform'");
  });

  await check('21 participants (over the 1..20 bound) -> 400', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      role: 'attendee', party_type: 'other', label: `Attendee ${i}`,
    }));
    const r = await createInteraction(commBody({ participants: many }));
    assertStatus(r, 400, '21 participants');
  });

  await check('participants on a correction (corrects_id set) -> 400', async () => {
    const orig = assertStatus(
      await createInteraction(commBody({ party_type: 'tenant', body: 'Original entry.' })),
      201, 'correction target',
    ) as InteractionRow;
    const r = await createInteraction({
      corrects_id: orig.id,
      correction_kind: 'amend',
      body: 'Corrected content.',
      participants: [{ role: 'sender', party_type: 'tenant', label: 'Alice Tenant' }],
    });
    assertStatus(r, 400, 'participants on correction');
  });

  // =========================================================================
  // (i) GET list embeds each row's cast (multiple rows, correct per-row)
  // =========================================================================

  await check('list: participants are embedded per-row across multiple rows', async () => {
    const first = assertStatus(
      await createInteraction(commBody({
        body: 'Two-party call.',
        participants: [
          { role: 'sender', party_type: 'tenant', label: 'Alice Tenant' },
          { role: 'recipient', party_type: 'landlord_user', party_id: A.userId, label: 'Me Landlord' },
        ],
      })),
      201, 'first with cast',
    ) as InteractionRow;
    const second = assertStatus(
      await createInteraction(commBody({
        body: 'Single-attendee note of a doorstep chat.',
        participants: [{ role: 'attendee', party_type: 'other', label: 'Neighbour' }],
      })),
      201, 'second with cast',
    ) as InteractionRow;

    const list = await api('GET', `${base}?limit=100`, { token: A.accessToken });
    const rows = (assertStatus(list, 200, 'list') as { data: InteractionRow[] }).data;

    const rFirst = rows.find((x) => x.id === first.id);
    if (!rFirst || rFirst.participants.length !== 2) {
      throw new Error(`first row cast: ${JSON.stringify(rFirst?.participants)}`);
    }
    if (!rFirst.participants.some((p) => p.role === 'sender') ||
        !rFirst.participants.some((p) => p.role === 'recipient')) {
      throw new Error(`first row roles: ${JSON.stringify(rFirst.participants)}`);
    }
    const rSecond = rows.find((x) => x.id === second.id);
    if (!rSecond || rSecond.participants.length !== 1) {
      throw new Error(`second row cast: ${JSON.stringify(rSecond?.participants)}`);
    }
    if (rSecond.participants[0]!.label !== 'Neighbour') {
      throw new Error(`second row cast content: ${JSON.stringify(rSecond.participants)}`);
    }
  });

  // --- summary ---------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\n${failures.length} interactions-participants failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nAll interactions-participants checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
