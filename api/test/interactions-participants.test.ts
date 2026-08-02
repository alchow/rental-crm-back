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
// participants the legacy insert path is preserved, but the attestation
// default-fill trigger still stamps 'attested' for a communication/note
// (null now means strictly a pre-migration legacy row); participants [].
//
// Covers:
//   (a) manual create with 3 attendees (in-person group) round-trips
//       POST -> GET -> list; attestation='attested'; each cast row
//       source='capture'.
//   (b) witnessed exchange: sender + recipient cast; the row is landlord-
//       authored (author_type='landlord'), attribution unaffected by the cast.
//   (c) plain create (no participants) -> attestation 'attested', participants [].
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

interface ApiResp {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

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
  res.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
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
    if (r.status !== 201)
      throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(`/v1/accounts/${b.account.id}/properties`, {
    name: `${label} prop`,
  });
  const unitArea = await post<{ id: string }>(`/v1/accounts/${b.account.id}/areas`, {
    property_id: property.id,
    kind: 'unit',
    name: `${label} unit`,
  });
  const tenancy = await post<{ id: string }>(`/v1/accounts/${b.account.id}/tenancies`, {
    area_id: unitArea.id,
    start_date: '2026-01-01',
    status: 'active',
  });
  return {
    userId: b.user.id,
    accessToken: b.session.access_token,
    accountId: b.account.id,
    propertyId: property.id,
    unitAreaId: unitArea.id,
    tenancyId: tenancy.id,
  };
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
  if (r.status !== expected)
    throw new Error(`${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`);
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
  area_id: string | null;
  property_id: string | null;
}

// Find exactly one cast row matching a predicate; throws if not unique.
function one(cast: Participant[], pred: (p: Participant) => boolean, ctx: string): Participant {
  const hits = cast.filter(pred);
  if (hits.length !== 1) {
    throw new Error(
      `${ctx}: expected exactly 1 participant, got ${hits.length} (cast=${JSON.stringify(cast)})`,
    );
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

  await check(
    'attendees: 3-attendee in-person group round-trips; attestation=attested; source=capture',
    async () => {
      const alice = crypto.randomUUID();
      const bob = crypto.randomUUID();
      const pete = crypto.randomUUID();
      const r = await createInteraction(
        commBody({
          body: 'Site walkthrough with both tenants and the plumber.',
          participants: [
            { role: 'attendee', party_type: 'tenant', party_id: alice, label: 'Alice Tenant' },
            { role: 'attendee', party_type: 'tenant', party_id: bob, label: 'Bob Tenant' },
            { role: 'attendee', party_type: 'vendor', party_id: pete, label: 'Pete Plumber' },
          ],
        }),
      );
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
      if (a.party_type !== 'tenant' || a.label !== 'Alice Tenant')
        throw new Error(`alice=${JSON.stringify(a)}`);
      const pl = one(row.participants, (p) => p.party_id === pete, 'pete');
      if (pl.party_type !== 'vendor' || pl.label !== 'Pete Plumber')
        throw new Error(`pete=${JSON.stringify(pl)}`);

      // GET single embeds the cast.
      const g = await api('GET', `${base}/${row.id}`, { token: A.accessToken });
      const got = assertStatus(g, 200, 'get back') as InteractionRow;
      if (got.attestation !== 'attested') throw new Error(`GET attestation: ${got.attestation}`);
      if (got.participants.length !== 3)
        throw new Error(`GET participants: ${JSON.stringify(got.participants)}`);

      // List embeds the cast.
      const list = await api('GET', `${base}?limit=100`, { token: A.accessToken });
      const rows = (assertStatus(list, 200, 'list') as { data: InteractionRow[] }).data;
      const found = rows.find((x) => x.id === row.id);
      if (!found) throw new Error('created row missing from list');
      if (found.participants.length !== 3)
        throw new Error(`list participants: ${JSON.stringify(found.participants)}`);
    },
  );

  // =========================================================================
  // (b) witnessed exchange: sender + recipient; row is landlord-authored
  // =========================================================================

  await check('witnessed exchange: sender+recipient cast; row author_type=landlord', async () => {
    const tenant = crypto.randomUUID();
    const r = await createInteraction(
      commBody({
        party_type: 'tenant',
        party_id: tenant, // filed under the tenant (legacy headline slot)
        body: 'Cash rent handed over, witnessed by the building super.',
        participants: [
          { role: 'sender', party_type: 'tenant', party_id: tenant, label: 'Alice Tenant' },
          {
            role: 'recipient',
            party_type: 'landlord_user',
            party_id: A.userId,
            label: 'Me Landlord',
          },
        ],
      }),
    );
    const row = assertStatus(r, 201, 'create witnessed') as InteractionRow;
    if (row.attestation !== 'attested') throw new Error(`attestation: ${row.attestation}`);
    // The cast describes the event; authorship stays on the row and follows the
    // acting principal (owner -> landlord), never the cast.
    if (row.author_type !== 'landlord') throw new Error(`author_type: ${row.author_type}`);
    if (row.participants.length !== 2)
      throw new Error(`participants: ${JSON.stringify(row.participants)}`);
    const sender = one(row.participants, (p) => p.role === 'sender', 'sender');
    if (sender.party_type !== 'tenant' || sender.party_id !== tenant)
      throw new Error(`sender=${JSON.stringify(sender)}`);
    if (sender.source !== 'capture') throw new Error(`sender source: ${sender.source}`);
    const recipient = one(row.participants, (p) => p.role === 'recipient', 'recipient');
    if (recipient.party_type !== 'landlord_user' || recipient.party_id !== A.userId) {
      throw new Error(`recipient=${JSON.stringify(recipient)}`);
    }
  });

  // =========================================================================
  // (c) plain create without participants -> legacy path preserved
  // =========================================================================

  await check(
    "plain create (no participants): attestation 'attested', participants []",
    async () => {
      const r = await createInteraction(
        commBody({ party_type: 'tenant', body: 'Phoned about the gate code.' }),
      );
      const row = assertStatus(r, 201, 'plain create') as InteractionRow;
      // The plain path skips journal_with_participants, but the BEFORE INSERT
      // default-fill trigger still stamps a communication with no stated tier as
      // 'attested' (null is now strictly a pre-migration legacy row).
      if (row.attestation !== 'attested')
        throw new Error(`attestation must default-fill to 'attested', got ${row.attestation}`);
      if (!Array.isArray(row.participants) || row.participants.length !== 0) {
        throw new Error(`participants must be [], got ${JSON.stringify(row.participants)}`);
      }
      // GET agrees.
      const g = await api('GET', `${base}/${row.id}`, { token: A.accessToken });
      const got = assertStatus(g, 200, 'get plain') as InteractionRow;
      if (got.attestation !== 'attested') throw new Error(`GET attestation: ${got.attestation}`);
      if (got.participants.length !== 0)
        throw new Error(`GET participants: ${JSON.stringify(got.participants)}`);
    },
  );

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
    const r = await createInteraction(
      commBody({
        participants: [{ role: 'author', party_type: 'tenant', label: 'Alice Tenant' }],
      }),
    );
    assertStatus(r, 400, "role 'author'");
  });

  await check("participant party_type='platform' (reserved for wire paths) -> 400", async () => {
    const r = await createInteraction(
      commBody({
        participants: [{ role: 'recipient', party_type: 'platform', address: '+15551230000' }],
      }),
    );
    assertStatus(r, 400, "party_type 'platform'");
  });

  await check('21 participants (over the 1..20 bound) -> 400', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      role: 'attendee',
      party_type: 'other',
      label: `Attendee ${i}`,
    }));
    const r = await createInteraction(commBody({ participants: many }));
    assertStatus(r, 400, '21 participants');
  });

  await check('participants on a correction (corrects_id set) -> 400', async () => {
    const orig = assertStatus(
      await createInteraction(commBody({ party_type: 'tenant', body: 'Original entry.' })),
      201,
      'correction target',
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
      await createInteraction(
        commBody({
          body: 'Two-party call.',
          participants: [
            { role: 'sender', party_type: 'tenant', label: 'Alice Tenant' },
            {
              role: 'recipient',
              party_type: 'landlord_user',
              party_id: A.userId,
              label: 'Me Landlord',
            },
          ],
        }),
      ),
      201,
      'first with cast',
    ) as InteractionRow;
    const second = assertStatus(
      await createInteraction(
        commBody({
          body: 'Single-attendee note of a doorstep chat.',
          participants: [{ role: 'attendee', party_type: 'other', label: 'Neighbour' }],
        }),
      ),
      201,
      'second with cast',
    ) as InteractionRow;

    const list = await api('GET', `${base}?limit=100`, { token: A.accessToken });
    const rows = (assertStatus(list, 200, 'list') as { data: InteractionRow[] }).data;

    const rFirst = rows.find((x) => x.id === first.id);
    if (!rFirst || rFirst.participants.length !== 2) {
      throw new Error(`first row cast: ${JSON.stringify(rFirst?.participants)}`);
    }
    if (
      !rFirst.participants.some((p) => p.role === 'sender') ||
      !rFirst.participants.some((p) => p.role === 'recipient')
    ) {
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

  // =========================================================================
  // party_id / area_id list filters (Field Log ask #5) + Item C castless gap
  // =========================================================================

  const listBy = async (qs: string): Promise<InteractionRow[]> => {
    const r = await api('GET', `${base}${qs}`, { token: A.accessToken });
    return (assertStatus(r, 200, `list ${qs}`) as { data: InteractionRow[] }).data;
  };

  await check(
    'party_id: returns the entry naming the person (cast leg OR row-slot leg)',
    async () => {
      const target = crypto.randomUUID();
      const withTarget = assertStatus(
        await createInteraction(
          commBody({
            body: 'Names the target as a witnessed sender.',
            participants: [
              { role: 'sender', party_type: 'tenant', party_id: target, label: 'Target Tenant' },
              { role: 'recipient', party_type: 'landlord_user', party_id: A.userId, label: 'Me' },
            ],
          }),
        ),
        201,
        'with target',
      ) as InteractionRow;
      // A different interaction that does NOT name the target.
      await createInteraction(
        commBody({
          participants: [
            {
              role: 'sender',
              party_type: 'tenant',
              party_id: crypto.randomUUID(),
              label: 'Someone else',
            },
          ],
        }),
      );

      const rows = await listBy(`?party_id=${target}&limit=100`);
      const ids = new Set(rows.map((r) => r.id));
      if (!ids.has(withTarget.id)) throw new Error('target entry missing from party_id filter');
      // No false positives: every returned row must name the target on one of
      // the two legs the RPC matches — its cast, or its own party slot.
      for (const r of rows) {
        const inCast = r.participants.some((p) => p.party_id === target);
        const inSlot = r.party_id === target;
        if (!inCast && !inSlot) {
          throw new Error(
            `row ${r.id} matched party_id but names the target in neither its cast nor its slot: cast=${JSON.stringify(r.participants)} slot=${r.party_id}`,
          );
        }
      }
    },
  );

  // party_type narrows whichever leg matched. Both fixtures here carry the
  // person only in the cast (commBody's slot is party_type='unspecified' with
  // no party_id), so this pins the cast-leg narrowing specifically.
  await check('party_id + party_type: narrows to the matching leg (cast)', async () => {
    const shared = crypto.randomUUID(); // same uuid cast under two party_types
    const asTenant = assertStatus(
      await createInteraction(
        commBody({
          participants: [
            { role: 'sender', party_type: 'tenant', party_id: shared, label: 'As tenant' },
          ],
        }),
      ),
      201,
      'as tenant',
    ) as InteractionRow;
    const asVendor = assertStatus(
      await createInteraction(
        commBody({
          participants: [
            { role: 'recipient', party_type: 'vendor', party_id: shared, label: 'As vendor' },
          ],
        }),
      ),
      201,
      'as vendor',
    ) as InteractionRow;

    const vendorRows = await listBy(`?party_id=${shared}&party_type=vendor&limit=100`);
    const vIds = new Set(vendorRows.map((r) => r.id));
    if (!vIds.has(asVendor.id) || vIds.has(asTenant.id)) {
      throw new Error(
        `party_type=vendor should return only the vendor leg: ${JSON.stringify([...vIds])}`,
      );
    }
    const tenantRows = await listBy(`?party_id=${shared}&party_type=tenant&limit=100`);
    const tIds = new Set(tenantRows.map((r) => r.id));
    if (!tIds.has(asTenant.id) || tIds.has(asVendor.id)) {
      throw new Error(
        `party_type=tenant should return only the tenant leg: ${JSON.stringify([...tIds])}`,
      );
    }
  });

  await check(
    'party_id: cross-account — each account sees ONLY its own row for a shared uuid',
    async () => {
      const B = await setupUser('B');
      // NON-VACUOUS probe: A and B both cast the SAME uuid on their own rows,
      // so a semi-join that ignored account scoping would leak a real row.
      // (An empty-account assertion proves nothing about RLS.)
      const shared = crypto.randomUUID();
      const aRow = assertStatus(
        await createInteraction(
          commBody({
            body: 'A names the shared person.',
            participants: [
              { role: 'sender', party_type: 'tenant', party_id: shared, label: 'Shared-A' },
            ],
          }),
        ),
        201,
        'A row',
      ) as InteractionRow;
      const bRow = assertStatus(
        await api('POST', `/v1/accounts/${B.accountId}/interactions`, {
          token: B.accessToken,
          body: {
            party_type: 'tenant',
            channel: 'in_person',
            direction: 'inbound',
            occurred_at: '2026-03-01T09:00:00Z',
            body: 'B names the shared person.',
            participants: [
              { role: 'sender', party_type: 'tenant', party_id: shared, label: 'Shared-B' },
            ],
          },
        }),
        201,
        'B row',
      ) as InteractionRow;

      const aList = await listBy(`?party_id=${shared}&limit=100`);
      if (aList.length !== 1 || aList[0]!.id !== aRow.id) {
        throw new Error(
          `A should see exactly its own row, got ${JSON.stringify(aList.map((x) => x.id))}`,
        );
      }
      const bList = (
        assertStatus(
          await api(
            'GET',
            `/v1/accounts/${B.accountId}/interactions?party_id=${shared}&limit=100`,
            {
              token: B.accessToken,
            },
          ),
          200,
          'B lists',
        ) as { data: InteractionRow[] }
      ).data;
      if (bList.length !== 1 || bList[0]!.id !== bRow.id) {
        throw new Error(
          `B should see exactly its own row, got ${JSON.stringify(bList.map((x) => x.id))}`,
        );
      }
    },
  );

  await check(
    'party_id: keyset walk (limit=1) over equal occurred_at rows — exactly once, in order',
    async () => {
      // Three rows cast to one person, ALL sharing occurred_at, plus one later
      // row: the walk must rely on the (occurred_at, id) tie-break. A dup/skip
      // regression in list_interactions_for_party's keyset predicate fails here.
      // Also the no-duplicates proof for the cast-OR-slot predicate
      // (20260801000004): the OR is a filter inside one scan, not a join, so a
      // row satisfying both legs is still emitted exactly once.
      const person = crypto.randomUUID();
      const mk = (body: string, when: string) =>
        createInteraction(
          commBody({
            body,
            occurred_at: when,
            participants: [
              { role: 'sender', party_type: 'tenant', party_id: person, label: 'Walker' },
            ],
          }),
        );
      const created: string[] = [];
      for (let i = 0; i < 3; i++) {
        const row = assertStatus(
          await mk(`tie ${i}`, '2026-03-05T10:00:00Z'),
          201,
          `tie ${i}`,
        ) as InteractionRow;
        created.push(row.id);
      }
      const late = assertStatus(
        await mk('later', '2026-03-06T10:00:00Z'),
        201,
        'later',
      ) as InteractionRow;
      created.push(late.id);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const qs = `?party_id=${person}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const r = await api('GET', `${base}${qs}`, { token: A.accessToken });
        const body = assertStatus(r, 200, `page ${page}`) as {
          data: InteractionRow[];
          next_cursor: string | null;
        };
        for (const row of body.data) {
          if (seen.includes(row.id)) throw new Error(`row ${row.id} appeared twice across pages`);
          seen.push(row.id);
        }
        if (body.next_cursor === null) break;
        cursor = body.next_cursor;
      }
      if (seen.length !== created.length || !created.every((id) => seen.includes(id))) {
        throw new Error(`walk saw ${seen.length}/${created.length} rows: ${JSON.stringify(seen)}`);
      }
      // Ascending order: the later row must come out last.
      if (seen[seen.length - 1] !== late.id) {
        throw new Error('ascending order violated: later row not last');
      }
    },
  );

  await check('area_id: filters interactions scoped to one area', async () => {
    const property = assertStatus(
      await api('POST', `/v1/accounts/${A.accountId}/properties`, {
        token: A.accessToken,
        body: { name: 'Area prop' },
      }),
      201,
      'prop',
    ) as { id: string };
    const area = assertStatus(
      await api('POST', `/v1/accounts/${A.accountId}/areas`, {
        token: A.accessToken,
        body: { property_id: property.id, kind: 'unit', name: 'Area unit' },
      }),
      201,
      'area',
    ) as { id: string };
    const inArea = assertStatus(
      await createInteraction(
        commBody({ area_id: area.id, party_type: 'tenant', body: 'Scoped to the area.' }),
      ),
      201,
      'in area',
    ) as InteractionRow;
    const rows = await listBy(`?area_id=${area.id}&limit=100`);
    const ids = new Set(rows.map((r) => r.id));
    if (!ids.has(inArea.id)) throw new Error('area-scoped interaction missing from area_id filter');
    // Nothing outside the area should appear (all fixture rows used tenancy_id, not this area).
    for (const r of rows) {
      if (r.id !== inArea.id) throw new Error(`area_id filter returned an out-of-area row ${r.id}`);
    }
  });

  await check('property_id: a single-family property resolves to its one live unit', async () => {
    const person = crypto.randomUUID();
    const created = assertStatus(
      await createInteraction(
        commBody({
          property_id: A.propertyId,
          party_type: 'tenant',
          party_id: person,
          channel: 'phone',
          direction: 'inbound',
          body: 'Property selected; backend resolves the only unit.',
        }),
      ),
      201,
      'single-unit property create',
    ) as InteractionRow;
    if (created.area_id !== A.unitAreaId) {
      throw new Error(`expected canonical area ${A.unitAreaId}, got ${created.area_id}`);
    }
    if (created.property_id !== A.propertyId) {
      throw new Error(`expected derived property ${A.propertyId}, got ${created.property_id}`);
    }

    const get = assertStatus(
      await api('GET', `${base}/${created.id}`, { token: A.accessToken }),
      200,
      'get property-scoped interaction',
    ) as InteractionRow;
    if (get.area_id !== A.unitAreaId || get.property_id !== A.propertyId) {
      throw new Error(`GET lost derived scope: ${JSON.stringify(get)}`);
    }

    const byProperty = await listBy(`?property_id=${A.propertyId}&limit=100`);
    if (!byProperty.some((row) => row.id === created.id)) {
      throw new Error('property_id list filter omitted the interaction');
    }
    // This fixture names the person in BOTH legs (the slot, plus the one-person
    // cast Item C derives from it) — the OR predicate must still yield one row.
    const byPersonAndProperty = await listBy(
      `?party_id=${person}&property_id=${A.propertyId}&limit=100`,
    );
    if (byPersonAndProperty.length !== 1 || byPersonAndProperty[0]!.id !== created.id) {
      throw new Error('party_id + property_id SQL filter did not compose');
    }
  });

  await check('property_id: a correction can switch to a different singleton property', async () => {
    const targetProperty = assertStatus(
      await api('POST', `/v1/accounts/${A.accountId}/properties`, {
        token: A.accessToken,
        body: { name: 'Correction target property' },
      }),
      201,
      'correction target property',
    ) as { id: string };
    const targetArea = assertStatus(
      await api('POST', `/v1/accounts/${A.accountId}/areas`, {
        token: A.accessToken,
        body: { property_id: targetProperty.id, kind: 'unit', name: 'Only target unit' },
      }),
      201,
      'correction target area',
    ) as { id: string };
    const original = assertStatus(
      await createInteraction(
        commBody({ property_id: A.propertyId, body: 'Initially logged at property A.' }),
      ),
      201,
      'original property scope',
    ) as InteractionRow;
    const corrected = assertStatus(
      await createInteraction({
        corrects_id: original.id,
        correction_kind: 'amend',
        property_id: targetProperty.id,
        body: 'Correct property is B.',
      }),
      201,
      'property scope correction',
    ) as InteractionRow;
    if (corrected.area_id !== targetArea.id || corrected.property_id !== targetProperty.id) {
      throw new Error(`new singleton property was not resolved: ${JSON.stringify(corrected)}`);
    }
  });

  await check('area_id: an explicitly selected archived area is rejected', async () => {
    const property = assertStatus(
      await api('POST', `/v1/accounts/${A.accountId}/properties`, {
        token: A.accessToken,
        body: { name: 'Archived area property' },
      }),
      201,
      'archived area property',
    ) as { id: string };
    const area = assertStatus(
      await api('POST', `/v1/accounts/${A.accountId}/areas`, {
        token: A.accessToken,
        body: { property_id: property.id, kind: 'unit', name: 'Archived unit' },
      }),
      201,
      'archived area',
    ) as { id: string };
    assertStatus(
      await api('DELETE', `/v1/accounts/${A.accountId}/areas/${area.id}`, {
        token: A.accessToken,
      }),
      204,
      'archive area',
    );
    const response = await createInteraction(
      commBody({ area_id: area.id, tenancy_id: undefined, body: 'Should not attach here.' }),
    );
    assertStatus(response, 404, 'explicit archived area');
  });

  await check('property_id: ambiguous or empty properties require explicit area_id', async () => {
    const multiProperty = assertStatus(
      await api('POST', `/v1/accounts/${A.accountId}/properties`, {
        token: A.accessToken,
        body: { name: 'Two-unit property' },
      }),
      201,
      'multi property',
    ) as { id: string };
    const unit1 = assertStatus(
      await api('POST', `/v1/accounts/${A.accountId}/areas`, {
        token: A.accessToken,
        body: { property_id: multiProperty.id, kind: 'unit', name: 'Unit 1' },
      }),
      201,
      'multi unit 1',
    ) as { id: string };
    await api('POST', `/v1/accounts/${A.accountId}/areas`, {
      token: A.accessToken,
      body: { property_id: multiProperty.id, kind: 'unit', name: 'Unit 2' },
    });

    const ambiguous = await createInteraction(
      commBody({
        property_id: multiProperty.id,
        tenancy_id: undefined,
      }),
    );
    if (ambiguous.status !== 422)
      throw new Error(`ambiguous property expected 422, got ${ambiguous.status}`);
    const ambiguousError = ambiguous.body as {
      error: { code: string; details?: { fieldErrors?: Record<string, unknown> } };
    };
    if (ambiguousError.error.code !== 'property_requires_area') {
      throw new Error(`wrong ambiguity code: ${ambiguousError.error.code}`);
    }
    if (!ambiguousError.error.details?.fieldErrors?.area_id) {
      throw new Error('ambiguous property response lacks fieldErrors.area_id');
    }

    const explicit = assertStatus(
      await createInteraction(
        commBody({
          property_id: multiProperty.id,
          area_id: unit1.id,
          tenancy_id: undefined,
        }),
      ),
      201,
      'explicit area within multi property',
    ) as InteractionRow;
    if (explicit.area_id !== unit1.id || explicit.property_id !== multiProperty.id) {
      throw new Error(`explicit property/area scope wrong: ${JSON.stringify(explicit)}`);
    }

    const mismatch = await createInteraction(
      commBody({
        property_id: multiProperty.id,
        area_id: A.unitAreaId,
        tenancy_id: undefined,
      }),
    );
    if (mismatch.status !== 422)
      throw new Error(`mismatched property/area expected 422, got ${mismatch.status}`);

    const emptyProperty = assertStatus(
      await api('POST', `/v1/accounts/${A.accountId}/properties`, {
        token: A.accessToken,
        body: { name: 'No-unit property' },
      }),
      201,
      'empty property',
    ) as { id: string };
    const empty = await createInteraction(
      commBody({
        property_id: emptyProperty.id,
        tenancy_id: undefined,
      }),
    );
    if (empty.status !== 422) throw new Error(`empty property expected 422, got ${empty.status}`);
  });

  await check(
    'Item C: a castless create naming party_id is cast + findable via party_id',
    async () => {
      const person = crypto.randomUUID();
      // NO participants[]; the legacy slot names the counterparty. Direction
      // inbound must derive a 'sender' cast (the backfill mapping).
      const created = assertStatus(
        await createInteraction(
          commBody({
            party_type: 'tenant',
            party_id: person,
            direction: 'inbound',
            channel: 'phone',
            body: 'Inbound call, logged with only the party slot.',
          }),
        ),
        201,
        'castless create',
      ) as InteractionRow;
      // The row now carries ONE derived participant (it was routed through the RPC).
      if (created.participants.length !== 1) {
        throw new Error(
          `expected 1 derived participant, got ${JSON.stringify(created.participants)}`,
        );
      }
      const p = created.participants[0]!;
      if (p.role !== 'sender' || p.party_type !== 'tenant' || p.party_id !== person) {
        throw new Error(`derived participant wrong: ${JSON.stringify(p)}`);
      }
      if (p.source !== 'capture') throw new Error(`derived participant source: ${p.source}`);
      if (p.address !== null)
        throw new Error(`derived participant address should be null: ${p.address}`);
      // The legacy headline slot is still populated (back-compat).
      if (created.party_id !== person) throw new Error(`party slot cleared: ${created.party_id}`);
      // Findable through the cast filter — the whole point.
      const rows = await listBy(`?party_id=${person}&limit=100`);
      if (!rows.some((r) => r.id === created.id)) {
        throw new Error('castless-then-derived entry not findable via party_id');
      }
    },
  );

  await check(
    'Item C: a concrete role with no id and no label stays castless (plain insert)',
    async () => {
      // "role known, person unknown" is a headline bucket, not a nameable
      // counterparty — it must NOT be forced through the cast path.
      const created = assertStatus(
        await createInteraction(
          commBody({ party_type: 'tenant', channel: 'phone', body: 'Some tenant, unknown which.' }),
        ),
        201,
        'headline-only',
      ) as InteractionRow;
      if (created.participants.length !== 0) {
        throw new Error(
          `headline-only should stay castless, got ${JSON.stringify(created.participants)}`,
        );
      }
    },
  );

  await check(
    'party_id + latest_only=true: the castless correction head matches via its inherited slot',
    async () => {
      const person = crypto.randomUUID();
      const original = assertStatus(
        await createInteraction(
          commBody({
            party_type: 'tenant',
            party_id: person,
            body: 'Original, cast and slot both name the person.',
            participants: [
              { role: 'sender', party_type: 'tenant', party_id: person, label: 'Person' },
            ],
          }),
        ),
        201,
        'original',
      ) as InteractionRow;
      // Amend it: the correction ROW carries no cast (the cast belongs to the
      // root) but DOES inherit the corrected row's party slot.
      const amend = assertStatus(
        await createInteraction({
          corrects_id: original.id,
          correction_kind: 'amend',
          body: 'Amended content.',
        }),
        201,
        'amend',
      ) as InteractionRow;
      if (amend.participants.length !== 0) {
        throw new Error(
          `correction row should be castless, got ${JSON.stringify(amend.participants)}`,
        );
      }
      if (amend.party_id !== person) throw new Error('amend did not inherit the party slot');

      // Without latest_only both entries of the chain are returned.
      const full = await listBy(`?party_id=${person}&limit=100`);
      const fullIds = new Set(full.map((r) => r.id));
      if (!fullIds.has(original.id))
        throw new Error('root entry must be found without latest_only');
      if (!fullIds.has(amend.id))
        throw new Error('correction row must be found without latest_only');

      // With latest_only=true the head is the castless amend: it now matches on
      // the row-slot leg (20260801000004), so the chain no longer drops out.
      // The root is still absent — excluded by latest_only (superseded), which
      // is the only reason it should ever be missing here.
      const heads = await listBy(`?party_id=${person}&latest_only=true&limit=100`);
      const headIds = new Set(heads.map((r) => r.id));
      if (!headIds.has(amend.id))
        throw new Error('castless correction head should match party_id via its inherited slot');
      if (headIds.has(original.id))
        throw new Error('superseded root should not appear under latest_only');
    },
  );

  await check(
    'party_id + latest_only=true RESIDUAL: a cast-only participant of a corrected entry does not match (documented caveat)',
    async () => {
      // The slot leg rescues a corrected chain only for the HEADLINE party.
      // Someone named ONLY in the superseded row's cast (a cc, a witness, a
      // group-message member) still drops out under latest_only, because the
      // correction inherits the root's slot, which names someone else. Pinned
      // so the contract caveat (route description, 20260801000004 header) and
      // reality cannot drift apart; the fix is a chain-walking read model, not
      // another predicate arm.
      const headline = crypto.randomUUID();
      const ccOnly = crypto.randomUUID();
      const original = assertStatus(
        await createInteraction(
          commBody({
            party_type: 'tenant',
            party_id: headline,
            body: 'Root: headline in slot+cast, second person in cast only.',
            participants: [
              { role: 'sender', party_type: 'tenant', party_id: headline, label: 'Headline' },
              { role: 'cc', party_type: 'tenant', party_id: ccOnly, label: 'CC only' },
            ],
          }),
        ),
        201,
        'root with two-person cast',
      ) as InteractionRow;
      const amend = assertStatus(
        await createInteraction({
          corrects_id: original.id,
          correction_kind: 'amend',
          body: 'Amended.',
        }),
        201,
        'amend',
      ) as InteractionRow;

      // Full set: the cc-only person still finds the root (their evidence).
      const full = await listBy(`?party_id=${ccOnly}&limit=100`);
      if (!full.some((r) => r.id === original.id))
        throw new Error('cc-only participant must find the root without latest_only');

      // latest_only: the head matches the headline party but NOT the cc-only
      // person — the residual exclusion this test pins.
      const ccHeads = await listBy(`?party_id=${ccOnly}&latest_only=true&limit=100`);
      if (ccHeads.some((r) => r.id === amend.id || r.id === original.id))
        throw new Error(
          'residual caveat no longer holds — cast-only participant matched under latest_only; update the route description, guide, and 20260801000004 header before changing this pin',
        );
      const headlineHeads = await listBy(`?party_id=${headline}&latest_only=true&limit=100`);
      if (!headlineHeads.some((r) => r.id === amend.id))
        throw new Error('headline party must still match the correction head');
    },
  );

  await check('party_id: a party-carrying NOTE matches, and stays castless', async () => {
    // Notes take the plain-insert branch by design (no wire cast to record), so
    // the only thing that can match them is the row-slot leg.
    const who = crypto.randomUUID();
    const note = assertStatus(
      await createInteraction({
        kind: 'note',
        occurred_at: '2026-04-02T09:00:00.000Z',
        body: 'Spoke to the tenant about the boiler.',
        party_type: 'tenant',
        party_id: who,
      }),
      201,
      'party-carrying note',
    ) as InteractionRow;
    if (note.participants.length !== 0) {
      throw new Error(`note should stay castless, got ${JSON.stringify(note.participants)}`);
    }
    const rows = await listBy(`?party_id=${who}&limit=100`);
    if (!rows.some((r) => r.id === note.id)) {
      throw new Error('party-carrying note missing from the party_id filter');
    }

    // (c) party_type narrows the slot leg: the note is a tenant row.
    const asVendor = await listBy(`?party_id=${who}&party_type=vendor&limit=100`);
    if (asVendor.some((r) => r.id === note.id)) {
      throw new Error('tenant-slot note must not match party_type=vendor');
    }
  });

  await check(
    'party_id: a classify that adds the who makes the correction head match',
    async () => {
      // The capture flow's real sequence: log the note first, name the person
      // after. The classify row inherits nothing to match on except the slot it
      // just filled, and it carries no cast of its own.
      const who = crypto.randomUUID();
      const note = assertStatus(
        await createInteraction({
          kind: 'note',
          occurred_at: '2026-04-03T09:00:00.000Z',
          body: 'Reported a cracked tile on the roof.',
        }),
        201,
        'party-less note',
      ) as InteractionRow;
      const classified = assertStatus(
        await createInteraction({
          corrects_id: note.id,
          correction_kind: 'classify',
          party_type: 'tenant',
          party_id: who,
        }),
        201,
        'classify adds the who',
      ) as InteractionRow;

      const heads = await listBy(`?party_id=${who}&latest_only=true&limit=100`);
      if (!heads.some((r) => r.id === classified.id)) {
        throw new Error('classify head that named the person must match party_id');
      }
      // The party-less root never named anyone, so it must NOT match.
      const full = await listBy(`?party_id=${who}&limit=100`);
      if (full.some((r) => r.id === note.id)) {
        throw new Error('the party-less root should not match party_id');
      }
    },
  );

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
