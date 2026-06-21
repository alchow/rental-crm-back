// ----------------------------------------------------------------------------
// Interactions evidentiary-journal DoD checks — append-only corrections,
// notes, retractions.
//
// Covers:
//   (A) Communication create/read: party_type still required; direction is
//       now OPTIONAL (omitted -> 'unspecified'), and 'mutual' is accepted.
//   (B) kind='note': creates with no direction/party_type/channel; reads
//       back note-shaped; counterparty fields rejected.
//   (C) Amend: the correcting row carries corrects_id+correction_kind;
//       the ORIGINAL row is unchanged byte-for-byte (stored fields AND its
//       audit events); superseded_by_id/is_head derive correctly;
//       ?latest_only=true returns the correction, not the original.
//   (D) Retract: head reads as retracted with its reason; the original
//       leaves the collapsed head set but stays in the full list.
//   (E) Linear-chain guards: correcting a superseded entry → 409;
//       amending/retracting a retracted head → 409; malformed correction
//       bodies → 400.
//   (F) Immutability holds: no PATCH/DELETE route exists on interactions.
//   (G) Cross-account corrects_id → 404, nothing created. Plus the two DB
//       invariants behind the app checks: the partial unique index keeps
//       chains linear even for a direct write (23505), and the composite
//       FK keeps corrections same-account even for a direct write (23503).
//   (H) Audit: the correction is attributed to the acting user in the
//       immutable events trail.
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
process.env.PORT = '8791';
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
const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
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
  const email = `ij-${label}-${rnd()}@example.test`;
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
  logged_at: string;
  corrects_id: string | null;
  correction_kind: string | null;
  superseded_by_id: string | null;
  is_head: boolean;
  actor: string;
  tenancy_id: string | null;
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Interactions evidentiary-journal DoD checks');
  const A = await setupUser('A');
  const B = await setupUser('B');
  const admin = getAdminClient();
  const base = `/v1/accounts/${A.accountId}/interactions`;

  const createInteraction = async (body: Record<string, unknown>, key?: string): Promise<ApiResp> =>
    api('POST', base, { token: A.accessToken, body, idempotencyKey: key });

  const commBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    party_type: 'tenant',
    channel: 'phone',
    direction: 'inbound',
    occurred_at: '2026-03-01T10:00:00.000Z',
    body: 'Tenant called about the gate code.',
    tenancy_id: A.tenancyId,
    ...overrides,
  });

  // =========================================================================
  // (A) Existing communication behavior unchanged
  // =========================================================================

  await check('communication: creates and reads exactly as before', async () => {
    const r = await createInteraction(commBody());
    const row = assertStatus(r, 201, 'create communication') as InteractionRow;
    if (row.kind !== 'communication') throw new Error(`kind: ${row.kind}`);
    if (row.corrects_id !== null || row.correction_kind !== null) {
      throw new Error('fresh row must not carry correction fields');
    }
    if (row.superseded_by_id !== null || row.is_head !== true) {
      throw new Error(`derived fields on create: superseded_by_id=${row.superseded_by_id} is_head=${row.is_head}`);
    }
    const g = await api('GET', `${base}/${row.id}`, { token: A.accessToken });
    const got = assertStatus(g, 200, 'read back') as InteractionRow;
    if (got.channel !== 'phone' || got.direction !== 'inbound' || got.party_type !== 'tenant') {
      throw new Error(`read back mismatch: ${JSON.stringify(got)}`);
    }
    if (got.is_head !== true) throw new Error('fresh row must be a head');
  });

  await check('communication: missing direction defaults to unspecified; missing party_type still rejected', async () => {
    const noDir = await createInteraction(commBody({ direction: undefined }));
    const row = assertStatus(noDir, 201, 'missing direction is now allowed') as InteractionRow;
    if (row.direction !== 'unspecified') {
      throw new Error(`omitted direction must store 'unspecified', got '${row.direction}'`);
    }
    const noParty = await createInteraction(commBody({ party_type: undefined }));
    assertStatus(noParty, 400, 'missing party_type');
  });

  await check('communication: explicit mutual direction is accepted (two-way contact)', async () => {
    const r = await createInteraction(commBody({
      direction: 'mutual', channel: 'in_person',
      body: 'Doorstep back-and-forth about front-lawn usage.',
    }));
    const row = assertStatus(r, 201, 'mutual direction') as InteractionRow;
    if (row.direction !== 'mutual') throw new Error(`expected 'mutual', got '${row.direction}'`);
    const g = await api('GET', `${base}/${row.id}`, { token: A.accessToken });
    const got = assertStatus(g, 200, 'read back mutual') as InteractionRow;
    if (got.direction !== 'mutual') throw new Error(`read back direction: ${got.direction}`);
  });

  // =========================================================================
  // (B) kind='note'
  // =========================================================================

  let noteId = '';
  await check('note: creates with no direction/party_type/channel', async () => {
    const r = await createInteraction({
      kind: 'note',
      occurred_at: '2026-03-02T09:00:00.000Z',
      body: 'Inspected roof; one cracked tile on the south slope.',
      tenancy_id: A.tenancyId,
    });
    const row = assertStatus(r, 201, 'create note') as InteractionRow;
    noteId = row.id;
    if (row.kind !== 'note') throw new Error(`kind: ${row.kind}`);
    if (row.channel !== 'note' || row.direction !== 'none' || row.party_type !== 'none') {
      throw new Error(`note shape: channel=${row.channel} direction=${row.direction} party_type=${row.party_type}`);
    }
  });

  await check('note: counterparty / real channel-direction rejected', async () => {
    const withParty = await createInteraction({
      kind: 'note', occurred_at: '2026-03-02T09:00:00.000Z', body: 'x',
      party_id: crypto.randomUUID(),
    });
    assertStatus(withParty, 400, 'note with party_id');
    const withDirection = await createInteraction({
      kind: 'note', occurred_at: '2026-03-02T09:00:00.000Z', body: 'x',
      direction: 'inbound',
    });
    assertStatus(withDirection, 400, 'note with direction');
    const reservedChannel = await createInteraction(commBody({ channel: 'note' }));
    assertStatus(reservedChannel, 400, "communication with channel 'note'");
  });

  // =========================================================================
  // (C) Amend
  // =========================================================================

  const orig = (await createInteraction(commBody({
    body: 'Tenant agreed to pay by the 5th.',
    occurred_at: '2026-03-03T15:00:00.000Z',
  }))).body as InteractionRow;

  // Snapshot the stored row + its audit events BEFORE the correction.
  const snapRow = async (id: string): Promise<unknown> => {
    const { data, error } = await admin.from('interactions').select('*').eq('id', id).single();
    if (error) throw new Error(`admin snapshot: ${error.message}`);
    return data;
  };
  const snapEvents = async (id: string): Promise<unknown> => {
    const { data, error } = await admin
      .from('events')
      .select('id, event_type, actor, event_hash')
      .eq('entity_type', 'interactions')
      .eq('entity_id', id)
      .order('occurred_at', { ascending: true });
    if (error) throw new Error(`admin events snapshot: ${error.message}`);
    return data;
  };
  const beforeRow = await snapRow(orig.id);
  const beforeEvents = await snapEvents(orig.id);

  let amend: InteractionRow | null = null;
  await check('amend: correction created; kind/channel/occurred_at inherited', async () => {
    const r = await createInteraction({
      corrects_id: orig.id,
      correction_kind: 'amend',
      body: 'Correction: tenant agreed to pay by the 10th, not the 5th.',
    });
    amend = assertStatus(r, 201, 'create amend') as InteractionRow;
    if (amend.corrects_id !== orig.id) throw new Error(`corrects_id: ${amend.corrects_id}`);
    if (amend.correction_kind !== 'amend') throw new Error(`correction_kind: ${amend.correction_kind}`);
    if (amend.kind !== 'communication') throw new Error(`kind not inherited: ${amend.kind}`);
    if (amend.channel !== 'phone' || amend.direction !== 'inbound' || amend.party_type !== 'tenant') {
      throw new Error('context fields not inherited');
    }
    if (amend.occurred_at !== orig.occurred_at) {
      throw new Error(`occurred_at must default to the original's: ${amend.occurred_at} vs ${orig.occurred_at}`);
    }
    if (amend.tenancy_id !== orig.tenancy_id) throw new Error('tenancy_id not inherited');
  });

  await check('amend: the original row is unchanged byte-for-byte (fields + audit events)', async () => {
    const afterRow = await snapRow(orig.id);
    const afterEvents = await snapEvents(orig.id);
    if (JSON.stringify(afterRow) !== JSON.stringify(beforeRow)) {
      throw new Error(`original row changed:\nbefore=${JSON.stringify(beforeRow)}\nafter=${JSON.stringify(afterRow)}`);
    }
    if (JSON.stringify(afterEvents) !== JSON.stringify(beforeEvents)) {
      throw new Error('audit events of the original changed');
    }
  });

  await check('amend: superseded_by_id/is_head derive; latest_only collapses to the correction', async () => {
    if (!amend) throw new Error('amend fixture missing');
    const g = await api('GET', `${base}/${orig.id}`, { token: A.accessToken });
    const got = assertStatus(g, 200, 'read original') as InteractionRow;
    if (got.superseded_by_id !== amend.id) {
      throw new Error(`superseded_by_id: ${got.superseded_by_id}, want ${amend.id}`);
    }
    if (got.is_head !== false) throw new Error('original must not be a head');

    const heads = await api('GET', `${base}?latest_only=true&limit=100`, { token: A.accessToken });
    const headRows = (assertStatus(heads, 200, 'latest_only') as { data: InteractionRow[] }).data;
    const headIds = new Set(headRows.map((x) => x.id));
    if (!headIds.has(amend.id)) throw new Error('latest_only must include the correction');
    if (headIds.has(orig.id)) throw new Error('latest_only must not include the superseded original');

    const full = await api('GET', `${base}?limit=100`, { token: A.accessToken });
    const fullRows = (assertStatus(full, 200, 'full list') as { data: InteractionRow[] }).data;
    const fullIds = new Set(fullRows.map((x) => x.id));
    if (!fullIds.has(orig.id) || !fullIds.has(amend.id)) {
      throw new Error('default list must carry the complete chain');
    }
  });

  await check('amend: may override context fields and occurred_at explicitly', async () => {
    const target = (await createInteraction(commBody({ channel: 'in_person', body: 'doorstep chat' }))).body as InteractionRow;
    const r = await createInteraction({
      corrects_id: target.id,
      correction_kind: 'amend',
      channel: 'phone',
      occurred_at: '2026-03-04T08:00:00.000Z',
      body: 'It was actually a phone call, on the morning of the 4th.',
    });
    const corr = assertStatus(r, 201, 'amend with overrides') as InteractionRow;
    if (corr.channel !== 'phone') throw new Error(`override channel: ${corr.channel}`);
    if (corr.occurred_at !== '2026-03-04T08:00:00+00:00' && !corr.occurred_at.startsWith('2026-03-04T08:00:00')) {
      throw new Error(`override occurred_at: ${corr.occurred_at}`);
    }
  });

  // =========================================================================
  // (D) Retract
  // =========================================================================

  const toRetract = (await createInteraction(commBody({
    body: 'Logged against the wrong tenancy entirely.',
    occurred_at: '2026-03-05T11:00:00.000Z',
  }))).body as InteractionRow;

  let retraction: InteractionRow | null = null;
  await check('retract: head reads as retracted with its reason; lists behave', async () => {
    const r = await createInteraction({
      corrects_id: toRetract.id,
      correction_kind: 'retract',
      body: 'Entered against the wrong tenancy; see the corrected entry under unit 2B.',
    });
    retraction = assertStatus(r, 201, 'create retraction') as InteractionRow;
    if (retraction.correction_kind !== 'retract') throw new Error(`correction_kind: ${retraction.correction_kind}`);
    if (!String(retraction.body).includes('wrong tenancy')) throw new Error('reason must be in body');
    if (retraction.occurred_at !== toRetract.occurred_at) throw new Error('retraction must keep the original timeline position');

    const heads = await api('GET', `${base}?latest_only=true&limit=100`, { token: A.accessToken });
    const headRows = (assertStatus(heads, 200, 'latest_only') as { data: InteractionRow[] }).data;
    const headIds = new Set(headRows.map((x) => x.id));
    if (headIds.has(toRetract.id)) throw new Error('retracted original must leave the collapsed head set');
    if (!headIds.has(retraction.id)) throw new Error('the retraction head carries the retracted state for the client');

    const full = await api('GET', `${base}?limit=100`, { token: A.accessToken });
    const fullRows = (assertStatus(full, 200, 'full list') as { data: InteractionRow[] }).data;
    if (!fullRows.some((x) => x.id === toRetract.id)) throw new Error('retracted entry must stay in the full list');
  });

  await check('retract: carries only the reason; extra fields rejected', async () => {
    const target = (await createInteraction(commBody())).body as InteractionRow;
    const r = await createInteraction({
      corrects_id: target.id,
      correction_kind: 'retract',
      body: 'reason',
      occurred_at: '2026-03-06T00:00:00.000Z',
    });
    assertStatus(r, 400, 'retract with occurred_at');
  });

  // =========================================================================
  // (E) Linear-chain guards
  // =========================================================================

  await check('guard: correcting an already-superseded entry → 409 invalid_correction_target', async () => {
    const r = await createInteraction({
      corrects_id: orig.id, correction_kind: 'amend', body: 'second correction of the original',
    });
    assertStatus(r, 409, 'correct superseded');
    if (errCode(r) !== 'invalid_correction_target') throw new Error(`code: ${errCode(r)}`);
  });

  await check('guard: amending/retracting a retracted head → 409', async () => {
    if (!retraction) throw new Error('retraction fixture missing');
    const am = await createInteraction({
      corrects_id: retraction.id, correction_kind: 'amend', body: 'amend a retraction',
    });
    assertStatus(am, 409, 'amend retracted head');
    if (errCode(am) !== 'invalid_correction_target') throw new Error(`code: ${errCode(am)}`);
    const re = await createInteraction({
      corrects_id: retraction.id, correction_kind: 'retract', body: 'retract a retraction',
    });
    assertStatus(re, 409, 'retract retracted head');
  });

  await check('guard: malformed corrections → 400', async () => {
    const noKind = await createInteraction({ corrects_id: orig.id, body: 'x' });
    assertStatus(noKind, 400, 'corrects_id without correction_kind');
    const noTarget = await createInteraction({ correction_kind: 'amend', body: 'x' });
    assertStatus(noTarget, 400, 'correction_kind without corrects_id');
    const noBody = await createInteraction({ corrects_id: noteId, correction_kind: 'amend' });
    assertStatus(noBody, 400, 'correction without body');
    const target = (await createInteraction(commBody())).body as InteractionRow;
    const kindMismatch = await createInteraction({
      corrects_id: target.id, correction_kind: 'amend', kind: 'note', body: 'x',
    });
    assertStatus(kindMismatch, 400, 'explicit kind mismatch');
  });

  // =========================================================================
  // (F) Immutability: no PATCH / DELETE routes
  // =========================================================================

  await check('immutability: PATCH and DELETE on an interaction do not exist', async () => {
    const p = await api('PATCH', `${base}/${orig.id}`, { token: A.accessToken, body: { body: 'rewrite history' } });
    if (p.status < 400) throw new Error(`PATCH must not exist; got ${p.status}`);
    const d = await api('DELETE', `${base}/${orig.id}`, { token: A.accessToken });
    if (d.status < 400) throw new Error(`DELETE must not exist; got ${d.status}`);
    const after = await snapRow(orig.id);
    if (JSON.stringify(after) !== JSON.stringify(beforeRow)) throw new Error('row changed');
  });

  // =========================================================================
  // (G) Cross-account + DB invariants
  // =========================================================================

  const bInteraction = (await api('POST', `/v1/accounts/${B.accountId}/interactions`, {
    token: B.accessToken,
    body: {
      party_type: 'tenant', channel: 'sms', direction: 'outbound',
      occurred_at: '2026-03-07T10:00:00.000Z', body: 'B account row',
    },
  })).body as InteractionRow;

  await check('cross-account: corrects_id into another account → 404, nothing created', async () => {
    const r = await createInteraction({
      corrects_id: bInteraction.id, correction_kind: 'amend', body: 'cross-account correction',
    });
    assertStatus(r, 404, 'cross-account correction');
    const { data } = await admin.from('interactions').select('id').eq('corrects_id', bInteraction.id);
    if ((data ?? []).length !== 0) throw new Error('a correction row was created');
  });

  await check('DB invariant: chains stay linear even for a direct write (unique corrects_id)', async () => {
    if (!amend) throw new Error('amend fixture missing');
    // orig already has `amend` correcting it; a second direct corrector must
    // hit interactions_corrects_id_uniq regardless of any app-level check.
    const { error } = await admin.from('interactions').insert({
      account_id: A.accountId, actor: 'system',
      party_type: 'tenant', channel: 'phone', direction: 'inbound',
      occurred_at: orig.occurred_at, body: 'branch attempt',
      corrects_id: orig.id, correction_kind: 'amend',
    });
    if (!error) throw new Error('direct branching insert was accepted');
    if (error.code !== '23505') throw new Error(`expected 23505 unique violation, got ${error.code}: ${error.message}`);
  });

  await check('DB invariant: cross-account corrects_id rejected by composite FK', async () => {
    const { error } = await admin.from('interactions').insert({
      account_id: A.accountId, actor: 'system',
      party_type: 'tenant', channel: 'phone', direction: 'inbound',
      occurred_at: '2026-03-07T10:00:00.000Z', body: 'cross-account attempt',
      corrects_id: bInteraction.id, correction_kind: 'amend',
    });
    if (!error) throw new Error('direct cross-account correction was accepted');
    if (error.code !== '23503') throw new Error(`expected 23503 FK violation, got ${error.code}: ${error.message}`);
  });

  // =========================================================================
  // (H) Audit attribution
  // =========================================================================

  await check('audit: the correction insert is attributed to the acting user', async () => {
    if (!amend) throw new Error('amend fixture missing');
    const { data, error } = await admin
      .from('events')
      .select('event_type, actor')
      .eq('entity_type', 'interactions')
      .eq('entity_id', amend.id);
    if (error) throw new Error(error.message);
    const inserted = (data ?? []).filter((e) => e.event_type === 'inserted');
    const ev = inserted[0];
    if (inserted.length !== 1 || !ev) throw new Error(`expected 1 inserted event, got ${inserted.length}`);
    if (ev.actor !== `user:${A.userId}`) {
      throw new Error(`actor: ${ev.actor}, want user:${A.userId}`);
    }
  });

  // =========================================================================
  // (I) classify correction + 'unspecified' party_type capture sentinel
  //
  // classify = metadata-completion correction: same chain mechanics as amend
  // (corrects_id; server owns is_head/linearity; 409 on a stale/retracted head)
  // but body- and occurred_at-IMMUTABLE and FILL-ONLY (fills an empty context
  // field, never overwrites a recorded one). party_type='unspecified' is the
  // role-unknown capture sentinel: communication-only, carries no party_id at
  // capture, resolved later by a classify (party_type + party_id atomically).
  // =========================================================================

  // AC1: classify filling an empty field (party_id null -> attached) -> 201;
  // new head; body unchanged; occurred_at unchanged; correction_kind='classify'.
  await check('classify: fills an empty context field (attaches party_id) → new head, body+occurred_at inherited', async () => {
    const original = (await createInteraction(commBody({
      party_type: 'tenant', // role known, person unknown -> party_id null
      body: 'Tenant called about a leaking tap.',
      occurred_at: '2026-03-10T12:00:00.000Z',
    }))).body as InteractionRow;
    if (original.party_id !== null) throw new Error(`precondition: party_id must start null, got ${original.party_id}`);

    const newPartyId = crypto.randomUUID();
    const r = await createInteraction({
      corrects_id: original.id,
      correction_kind: 'classify',
      party_id: newPartyId,
    });
    const cls = assertStatus(r, 201, 'classify fill party_id') as InteractionRow;
    if (cls.correction_kind !== 'classify') throw new Error(`correction_kind: ${cls.correction_kind}`);
    if (cls.corrects_id !== original.id) throw new Error(`corrects_id: ${cls.corrects_id}`);
    if (cls.party_id !== newPartyId) throw new Error(`party_id not filled: ${cls.party_id}`);
    if (cls.kind !== 'communication') throw new Error(`kind not inherited: ${cls.kind}`);
    if (cls.party_type !== 'tenant') throw new Error(`party_type not inherited: ${cls.party_type}`);
    if (cls.channel !== original.channel) throw new Error(`channel not inherited: ${cls.channel}`);
    if (cls.body !== original.body) throw new Error(`body must be inherited unchanged: ${cls.body}`);
    if (cls.occurred_at !== original.occurred_at) throw new Error(`occurred_at must be inherited unchanged: ${cls.occurred_at} vs ${original.occurred_at}`);
    if (cls.superseded_by_id !== null || cls.is_head !== true) {
      throw new Error(`classify must be the new head: superseded_by_id=${cls.superseded_by_id} is_head=${cls.is_head}`);
    }

    // The original now reads as superseded by the classify row.
    const g = await api('GET', `${base}/${original.id}`, { token: A.accessToken });
    const got = assertStatus(g, 200, 'read original after classify') as InteractionRow;
    if (got.superseded_by_id !== cls.id) throw new Error(`original superseded_by_id: ${got.superseded_by_id}, want ${cls.id}`);
    if (got.is_head !== false) throw new Error('original must no longer be a head');
  });

  // AC2: classify with body present -> 400; classify with occurred_at present -> 400.
  await check('classify: body present → 400; occurred_at present → 400 (both inherited)', async () => {
    const target1 = (await createInteraction(commBody({ party_type: 'tenant' }))).body as InteractionRow;
    const withBody = await createInteraction({
      corrects_id: target1.id, correction_kind: 'classify', body: 'trying to change the body',
    });
    assertStatus(withBody, 400, 'classify with body');
    if (errCode(withBody) !== 'invalid_request') throw new Error(`body code: ${errCode(withBody)}`);
    // The offending field name surfaces in the zod validation details.
    if (!JSON.stringify(withBody.body).includes('body')) throw new Error(`expected 'body' in error detail: ${JSON.stringify(withBody.body)}`);

    const target2 = (await createInteraction(commBody({ party_type: 'tenant' }))).body as InteractionRow;
    const withOccurredAt = await createInteraction({
      corrects_id: target2.id, correction_kind: 'classify', occurred_at: '2026-03-11T00:00:00.000Z',
    });
    assertStatus(withOccurredAt, 400, 'classify with occurred_at');
    if (errCode(withOccurredAt) !== 'invalid_request') throw new Error(`occurred_at code: ${errCode(withOccurredAt)}`);
    if (!JSON.stringify(withOccurredAt.body).includes('occurred_at')) throw new Error(`expected 'occurred_at' in error detail: ${JSON.stringify(withOccurredAt.body)}`);
  });

  // AC3: classify overwriting an already-set field -> 400 invalid_request.
  await check('classify: overwriting an already-set field → 400 (fill-only, not overwrite)', async () => {
    const partyX = crypto.randomUUID();
    // Capture WITH a party_id already set (party_type concrete so the id is legal).
    const original = (await createInteraction(commBody({
      party_type: 'tenant', party_id: partyX, body: 'Has a counterparty already.',
    }))).body as InteractionRow;
    if (original.party_id !== partyX) throw new Error(`precondition: party_id should be set, got ${original.party_id}`);

    const partyY = crypto.randomUUID();
    const r = await createInteraction({
      corrects_id: original.id, correction_kind: 'classify', party_id: partyY,
    });
    assertStatus(r, 400, 'classify overwrite party_id');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
    if (!JSON.stringify(r.body).includes('party_id')) throw new Error(`expected 'party_id' in error detail: ${JSON.stringify(r.body)}`);
  });

  // AC4: classify targeting a stale/already-superseded head -> 409; on a
  // retracted head -> 409 (same chain guards as amend).
  await check('classify: targeting a superseded head → 409 invalid_correction_target', async () => {
    const root = (await createInteraction(commBody({ party_type: 'tenant' }))).body as InteractionRow;
    // Supersede it with a first classify (fills party_id).
    const first = await createInteraction({
      corrects_id: root.id, correction_kind: 'classify', party_id: crypto.randomUUID(),
    });
    assertStatus(first, 201, 'first classify');
    // Now classify the STALE root again -> 409.
    const stale = await createInteraction({
      corrects_id: root.id, correction_kind: 'classify', party_label: 'late',
    });
    assertStatus(stale, 409, 'classify stale head');
    if (errCode(stale) !== 'invalid_correction_target') throw new Error(`code: ${errCode(stale)}`);
  });

  await check('classify: on a retracted head → 409 (chain is closed)', async () => {
    const target = (await createInteraction(commBody({ party_type: 'tenant' }))).body as InteractionRow;
    const ret = await createInteraction({
      corrects_id: target.id, correction_kind: 'retract', body: 'logged in error',
    });
    const retraction = assertStatus(ret, 201, 'retract for classify guard') as InteractionRow;
    const r = await createInteraction({
      corrects_id: retraction.id, correction_kind: 'classify', party_id: crypto.randomUUID(),
    });
    assertStatus(r, 409, 'classify retracted head');
    if (errCode(r) !== 'invalid_correction_target') throw new Error(`code: ${errCode(r)}`);
  });

  // AC5: capture a communication with party_type='unspecified' and no party_id
  // -> 201; then classify resolving party_type='tenant' + party_id -> 201.
  await check("capture party_type='unspecified' (no party_id) → 201, then classify resolves role + party_id → 201", async () => {
    const capture = await createInteraction(commBody({
      party_type: 'unspecified',
      party_id: undefined,
      body: 'Someone phoned about the bins; role unclear at the time.',
      occurred_at: '2026-03-12T09:30:00.000Z',
    }));
    const captured = assertStatus(capture, 201, "capture party_type='unspecified'") as InteractionRow;
    if (captured.party_type !== 'unspecified') throw new Error(`party_type: ${captured.party_type}`);
    if (captured.party_id !== null) throw new Error(`unspecified capture must carry no party_id: ${captured.party_id}`);

    const resolvedPartyId = crypto.randomUUID();
    const r = await createInteraction({
      corrects_id: captured.id,
      correction_kind: 'classify',
      party_type: 'tenant',
      party_id: resolvedPartyId,
    });
    const resolved = assertStatus(r, 201, 'classify resolves unspecified') as InteractionRow;
    if (resolved.party_type !== 'tenant') throw new Error(`resolved party_type: ${resolved.party_type}`);
    if (resolved.party_id !== resolvedPartyId) throw new Error(`resolved party_id: ${resolved.party_id}`);
    if (resolved.body !== captured.body) throw new Error('body must be inherited through the resolve');
    if (resolved.occurred_at !== captured.occurred_at) throw new Error('occurred_at must be inherited through the resolve');
    if (resolved.is_head !== true) throw new Error('the resolving classify must be the head');
  });

  // AC6: capture party_type='unspecified' WITH party_id -> 400.
  await check("capture party_type='unspecified' WITH party_id → 400", async () => {
    const r = await createInteraction(commBody({
      party_type: 'unspecified', party_id: crypto.randomUUID(),
      body: 'role unknown but somehow an id?',
    }));
    assertStatus(r, 400, "unspecified capture with party_id");
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
    if (!JSON.stringify(r.body).includes('party_id')) throw new Error(`expected 'party_id' in error detail: ${JSON.stringify(r.body)}`);
  });

  // AC7: classify setting party_id while leaving party_type='unspecified'
  // (role unresolved) -> 400 (atomic resolve).
  await check("classify: setting party_id with party_type still 'unspecified' → 400 (atomic resolve)", async () => {
    const captured = (await createInteraction(commBody({
      party_type: 'unspecified', party_id: undefined,
      body: 'Counterparty role still unknown.',
    }))).body as InteractionRow;
    if (captured.party_type !== 'unspecified') throw new Error(`precondition party_type: ${captured.party_type}`);

    // Set party_id but do NOT resolve the role -> 400.
    const r = await createInteraction({
      corrects_id: captured.id,
      correction_kind: 'classify',
      party_id: crypto.randomUUID(),
      // party_type omitted -> inherits 'unspecified' -> illegal id+unspecified pair.
    });
    assertStatus(r, 400, 'classify party_id without resolving role');
    if (errCode(r) !== 'invalid_request') throw new Error(`code: ${errCode(r)}`);
    if (!JSON.stringify(r.body).includes('party_type')) throw new Error(`expected 'party_type' in error detail: ${JSON.stringify(r.body)}`);
  });

  // AC8: GET ?latest_only=true returns the classify row as the head (chain
  // collapses to it; the corrected original drops out of the head set).
  await check('classify: ?latest_only=true collapses the chain to the classify head', async () => {
    const original = (await createInteraction(commBody({
      party_type: 'tenant', body: 'Chain-collapse classify subject.',
      occurred_at: '2026-03-13T14:00:00.000Z',
    }))).body as InteractionRow;
    const cls = assertStatus(
      await createInteraction({ corrects_id: original.id, correction_kind: 'classify', party_id: crypto.randomUUID() }),
      201, 'classify for collapse',
    ) as InteractionRow;

    const heads = await api('GET', `${base}?latest_only=true&limit=100`, { token: A.accessToken });
    const headRows = (assertStatus(heads, 200, 'latest_only') as { data: InteractionRow[] }).data;
    const headIds = new Set(headRows.map((x) => x.id));
    if (!headIds.has(cls.id)) throw new Error('latest_only must include the classify head');
    if (headIds.has(original.id)) throw new Error('latest_only must not include the superseded original');

    const full = await api('GET', `${base}?limit=100`, { token: A.accessToken });
    const fullRows = (assertStatus(full, 200, 'full list') as { data: InteractionRow[] }).data;
    const fullIds = new Set(fullRows.map((x) => x.id));
    if (!fullIds.has(original.id) || !fullIds.has(cls.id)) throw new Error('full list must carry the complete chain');
  });

  // --- summary ---------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\n${failures.length} interactions-journal failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nAll interactions-journal checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
