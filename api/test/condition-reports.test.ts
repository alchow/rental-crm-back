import { execSync } from 'node:child_process';

// ----------------------------------------------------------------------------
// Phase 27 condition-reports integration test (HTTP, against a local Supabase
// stack). Mirrors documents.test.ts bootstrap. Exercises the full landlord +
// tenant flow end-to-end: catalog -> create -> seed -> fill -> photo -> tenant
// capture + submit -> review -> complete (+ document + snapshots, idempotent)
// -> immutability -> start-checkout -> diff, plus cross-account isolation.
// ----------------------------------------------------------------------------

interface SupabaseStatus { API_URL: string; DB_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string }

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
  return { API_URL: get('API_URL'), DB_URL: get('DB_URL'), ANON_KEY: get('ANON_KEY'), SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY') };
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
const { buildApp } = await import('../src/app');

const app = buildApp();

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; multipart?: FormData } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.multipart) init = { ...init, body: opts.multipart };
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => { h[k] = v; });
  return { status: res.status, body, headers: h };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface UserFixture { accessToken: string; accountId: string; unitAreaId: string; tenancyId: string; tenantId: string }

async function setupUser(label: string): Promise<UserFixture> {
  const email = `cr-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', { body: { email, password, account_name: `CR ${label}` } });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };
  const accessToken = b.session.access_token;
  const accountId = b.account.id;
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: accessToken, body });
    if (r.status !== 201) throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(`/v1/accounts/${accountId}/properties`, { name: `${label} prop` });
  const unitArea = await post<{ id: string }>(`/v1/accounts/${accountId}/areas`, {
    property_id: property.id, kind: 'unit', name: `${label} unit`,
  });
  const tenancy = await post<{ id: string }>(`/v1/accounts/${accountId}/tenancies`, {
    area_id: unitArea.id, start_date: '2026-01-01', status: 'active',
  });
  const tenant = await post<{ id: string }>(`/v1/accounts/${accountId}/tenants`, {
    full_name: `${label} tenant`, emails: [`tenant-${rnd()}@example.test`],
  });
  return { accessToken, accountId, unitAreaId: unitArea.id, tenancyId: tenancy.id, tenantId: tenant.id };
}

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
function pngFile(): File { return new File([PNG_1x1], 'photo.png', { type: 'image/png' }); }

interface Failure { name: string; detail: string }
const failures: Failure[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.info(`  PASS  ${name}`); }
  catch (e) { const detail = e instanceof Error ? e.message : String(e); failures.push({ name, detail }); console.error(`  FAIL  ${name}: ${detail}`); }
}
function assertStatus(r: ApiResp, expected: number, ctx: string): unknown {
  if (r.status !== expected) throw new Error(`${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`);
  return r.body;
}

async function main(): Promise<void> {
  console.info('Phase 27 condition-reports checks');
  const A = await setupUser('a');
  const B = await setupUser('b');
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  await admin.from('ip_rate_buckets').delete().eq('scope', 'capture_access');

  let templateId = '';
  let checkinId = '';
  let livingItemId = '';
  let checkoutId = '';
  let captureSecret = '';

  await check('catalog lists the bundled residential template', async () => {
    const r = await api('GET', `/v1/accounts/${A.accountId}/inspection-template-catalog`, { token: A.accessToken });
    const b = assertStatus(r, 200, 'catalog') as { data: { id: string }[] };
    if (!b.data.some((t) => t.id === 'residential-generic-v1')) throw new Error('residential-generic-v1 not in catalog');
  });

  await check('clone starter template into account', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspection-templates/from-catalog`, {
      token: A.accessToken, body: { catalog_id: 'residential-generic-v1' },
    });
    const b = assertStatus(r, 201, 'from-catalog') as { id: string; schema: { sections?: unknown[] }; jurisdiction: string | null };
    templateId = b.id;
    if (!b.schema.sections || b.schema.sections.length === 0) throw new Error('cloned template has no sections');
    if (b.jurisdiction !== 'US') throw new Error('jurisdiction not carried over');
  });

  // --------------------------------------------------------------------------
  // Key-stability contract (FE ask #23): schema keys are identity, labels are
  // display. Three backend commitments, each pinned:
  //   (1) the catalog never RENAMES a key (snapshot below -- additions and
  //       removals show up as a deliberate diff of this literal),
  //   (2) seed derivation is exactly <section.key>/<field.key>,
  //   (3) template schema round-trips PATCH verbatim (no server rewriting).
  // --------------------------------------------------------------------------
  await check('catalog key-set snapshot: keys are add/remove-only, never renamed', async () => {
    const { getInspectionTemplateCatalog } = await import('../src/admin/inspection-template-catalog');
    const t = getInspectionTemplateCatalog('residential-generic-v1');
    if (!t) throw new Error('residential-generic-v1 missing from catalog');
    const itemKeys: string[] = [];
    const checkKeys: string[] = [];
    for (const s of t.schema.sections) {
      for (const f of s.items ?? []) itemKeys.push(`${s.key}/${f.key}`);
      for (const f of s.checks ?? []) checkKeys.push(`${s.key}/${f.key}`);
    }
    // v2 snapshot. If this fails you either renamed a key (NOT allowed: cloned
    // templates + per-unit layout deltas match on keys) or added/removed a
    // question (allowed: update the literal AND bump the catalog version).
    const expectedChecks = [
      'exterior/breakers_located', 'exterior/water_shutoff_located',
      'keys/door_keys', 'keys/fobs_cards', 'keys/garage_remotes', 'keys/gate_keys', 'keys/mailbox_keys',
      'systems/exterior_locks_tested', 'systems/smoke_alarms_count',
      'systems/smoke_alarms_tested', 'systems/smoke_alarms_working',
    ];
    const gotChecks = [...checkKeys].sort();
    if (JSON.stringify(gotChecks) !== JSON.stringify(expectedChecks)) {
      throw new Error(`check key drift:\n got ${JSON.stringify(gotChecks)}\n exp ${JSON.stringify(expectedChecks)}`);
    }
    if (t.version !== '2') throw new Error(`catalog version=${t.version}, snapshot is for '2'`);
    if (itemKeys.length !== 136) throw new Error(`item key count drift: ${itemKeys.length} != 136`);
    if (new Set(itemKeys).size !== itemKeys.length) throw new Error('duplicate item keys in catalog');
    if (itemKeys.includes('garage/door_remotes' as never) || checkKeys.includes('garage/door_remotes')) {
      throw new Error('garage/door_remotes returned (deduped in v2; keys/garage_remotes is canonical)');
    }
    // Every check is typed -- the input_kind contract the FE renders from.
    for (const s of t.schema.sections) {
      for (const f of s.checks ?? []) {
        if (f.input_kind !== 'boolean' && f.input_kind !== 'count') {
          throw new Error(`catalog check ${s.key}/${f.key} has input_kind=${f.input_kind}`);
        }
      }
    }
  });

  await check('template schema round-trips PATCH verbatim (keys never rewritten)', async () => {
    const weird = {
      form_code: 'custom-x',
      sections: [{
        key: 'sec_one', label: 'Section One',
        items: [{ key: 'a_key', label: 'Label A', extra_client_field: 'preserved' }],
        checks: [{ key: 'c_key', label: 'Check C', input_kind: 'count' }],
      }],
      client_metadata: { anything: [1, 2, 3] },
    };
    const created = await api('POST', `/v1/accounts/${A.accountId}/inspection-templates`, {
      token: A.accessToken, body: { name: 'verbatim test', schema: weird },
    });
    const tid = (assertStatus(created, 201, 'create') as { id: string }).id;
    // Label-only edit: keys must be untouched (labels are display, keys are identity).
    const relabeled = structuredClone(weird);
    relabeled.sections[0]!.items[0]!.label = 'Label A renamed';
    const patched = await api('PATCH', `/v1/accounts/${A.accountId}/inspection-templates/${tid}`, {
      token: A.accessToken, body: { schema: relabeled },
    });
    assertStatus(patched, 200, 'patch');
    const got = await api('GET', `/v1/accounts/${A.accountId}/inspection-templates/${tid}`, { token: A.accessToken });
    const schema = (assertStatus(got, 200, 'get') as { schema: unknown }).schema;
    // jsonb canonicalizes object KEY ORDER (that's Postgres, not us). The
    // contract is content: every key, label, value, and array order intact.
    const canon = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(canon);
      if (v && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]),
        );
      }
      return v;
    };
    if (JSON.stringify(canon(schema)) !== JSON.stringify(canon(relabeled))) {
      throw new Error(`schema not verbatim:\n got ${JSON.stringify(schema)}\n exp ${JSON.stringify(relabeled)}`);
    }
  });

  await check('create tenancy-bound move-in inspection', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections`, {
      token: A.accessToken,
      body: { area_id: A.unitAreaId, tenancy_id: A.tenancyId, template_id: templateId, kind: 'move_in', capture_mode: 'collaborative' },
    });
    const b = assertStatus(r, 201, 'create move_in') as { id: string; kind: string; status: string };
    checkinId = b.id;
    if (b.kind !== 'move_in') throw new Error(`kind=${b.kind}`);
    if (b.status !== 'draft') throw new Error(`status=${b.status}`);
  });

  await check('coherence: move_in whose area != the tenancy unit is rejected', async () => {
    const prop2 = await api('POST', `/v1/accounts/${A.accountId}/properties`, { token: A.accessToken, body: { name: 'p2' } });
    const p2id = (assertStatus(prop2, 201, 'p2') as { id: string }).id;
    const area2 = await api('POST', `/v1/accounts/${A.accountId}/areas`, {
      token: A.accessToken, body: { property_id: p2id, kind: 'unit', name: 'other unit' },
    });
    const a2id = (assertStatus(area2, 201, 'area2') as { id: string }).id;
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections`, {
      token: A.accessToken,
      body: { area_id: a2id, tenancy_id: A.tenancyId, kind: 'move_in', template_id: templateId },
    });
    if (r.status !== 400) throw new Error(`coherence: expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('seed items + checks from template', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/seed-from-template`, {
      token: A.accessToken, body: {},
    });
    const b = assertStatus(r, 200, 'seed') as { items: { id: string; item_key: string }[]; checks: { field_key: string }[] };
    if (b.items.length < 10) throw new Error(`expected many items, got ${b.items.length}`);
    const living = b.items.find((i) => i.item_key === 'living_room/flooring');
    if (!living) throw new Error('living_room/flooring not seeded');
    livingItemId = living.id;
    if (!b.checks.some((c) => c.field_key === 'keys/door_keys')) throw new Error('keys/door_keys check not seeded');
  });

  await check('seeded checks carry input_kind; deduped garage remote is absent', async () => {
    const r = await api('GET', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, { token: A.accessToken });
    const b = assertStatus(r, 200, 'checks list') as { data: { field_key: string; input_kind: string | null }[] };
    const byKey = new Map(b.data.map((c) => [c.field_key, c.input_kind]));
    if (byKey.get('keys/door_keys') !== 'count') throw new Error(`keys/door_keys input_kind=${byKey.get('keys/door_keys')}`);
    if (byKey.get('systems/smoke_alarms_tested') !== 'boolean') {
      throw new Error(`systems/smoke_alarms_tested input_kind=${byKey.get('systems/smoke_alarms_tested')}`);
    }
    if (byKey.get('keys/garage_remotes') !== 'count') throw new Error('keys/garage_remotes not seeded as count');
    if (byKey.has('garage/door_remotes')) throw new Error('garage/door_remotes seeded (should be deduped out of catalog v2)');
  });

  await check('seed is idempotent (re-seed adds no duplicates)', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/seed-from-template`, {
      token: A.accessToken, body: {},
    });
    const b = assertStatus(r, 200, 're-seed') as { items: { item_key: string }[] };
    const keys = b.items.map((i) => i.item_key);
    if (new Set(keys).size !== keys.length) throw new Error('duplicate item_keys after re-seed');
  });

  await check('landlord batch-fills items + checks', async () => {
    const ri = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/items/batch`, {
      token: A.accessToken,
      body: { items: [{ item_key: 'living_room/flooring', condition: 'good' }, { item_key: 'kitchen/oven', condition: 'good' }] },
    });
    assertStatus(ri, 200, 'items batch');
    const rc = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, {
      token: A.accessToken, body: { checks: [{ field_key: 'keys/door_keys', value: 2 }] },
    });
    const cb = assertStatus(rc, 200, 'checks upsert') as { data: { field_key: string; value: unknown }[] };
    if (!cb.data.some((c) => c.field_key === 'keys/door_keys' && c.value === 2)) throw new Error('check value not stored');
  });

  // --------------------------------------------------------------------------
  // Checks lifecycle: presence-merge upsert semantics + soft-delete endpoint.
  // --------------------------------------------------------------------------
  interface CheckRow {
    id: string; field_key: string; value: unknown; group_label: string | null;
    sort_order: number | null; input_kind: string | null;
    answered_by: string | null; answered_at: string | null;
  }
  const getChecks = async (inspId: string): Promise<CheckRow[]> => {
    const r = await api('GET', `/v1/accounts/${A.accountId}/inspections/${inspId}/checks`, { token: A.accessToken });
    return (assertStatus(r, 200, 'checks list') as { data: CheckRow[] }).data;
  };

  await check('checks: metadata-only re-save preserves value AND answered stamp', async () => {
    const before = (await getChecks(checkinId)).find((c) => c.field_key === 'keys/door_keys');
    if (!before || before.value !== 2) throw new Error('precondition: keys/door_keys value=2');
    if (!before.answered_at || !before.answered_by) throw new Error('precondition: answered stamp set');
    // Build-step style re-save: no `value` key at all.
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, {
      token: A.accessToken,
      body: { checks: [{ field_key: 'keys/door_keys', group_label: 'Keys & access', sort_order: 42 }] },
    });
    assertStatus(r, 200, 'metadata-only re-save');
    const after = (await getChecks(checkinId)).find((c) => c.field_key === 'keys/door_keys')!;
    if (after.value !== 2) throw new Error(`value erased by metadata-only save: ${JSON.stringify(after.value)}`);
    if (after.answered_at !== before.answered_at) throw new Error('answered_at moved on metadata-only save');
    if (after.answered_by !== before.answered_by) throw new Error('answered_by moved on metadata-only save');
    if (after.sort_order !== 42) throw new Error(`sort_order not updated: ${after.sort_order}`);
  });

  await check('checks: value-only re-save preserves group_label and sort_order', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, {
      token: A.accessToken, body: { checks: [{ field_key: 'keys/door_keys', value: 3 }] },
    });
    assertStatus(r, 200, 'value-only re-save');
    const after = (await getChecks(checkinId)).find((c) => c.field_key === 'keys/door_keys')!;
    if (after.value !== 3) throw new Error(`value not updated: ${JSON.stringify(after.value)}`);
    if (after.group_label !== 'Keys & access') throw new Error(`group_label clobbered: ${after.group_label}`);
    if (after.sort_order !== 42) throw new Error(`sort_order clobbered: ${after.sort_order}`);
  });

  await check('checks: unanswered rows never get an answered stamp; explicit null un-answers', async () => {
    // A brand-new check saved with NO value: must not be marked answered.
    const create = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, {
      token: A.accessToken,
      body: { checks: [{ field_key: 'custom/spa_heater', label: 'Spa heater keys', group_label: 'Keys & access' }] },
    });
    assertStatus(create, 200, 'create unanswered');
    let row = (await getChecks(checkinId)).find((c) => c.field_key === 'custom/spa_heater')!;
    if (row.answered_at !== null || row.answered_by !== null) throw new Error('unanswered create was stamped answered');
    // Answer it -> stamped.
    await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, {
      token: A.accessToken, body: { checks: [{ field_key: 'custom/spa_heater', value: 1 }] },
    });
    row = (await getChecks(checkinId)).find((c) => c.field_key === 'custom/spa_heater')!;
    if (!row.answered_at || !row.answered_by) throw new Error('answer did not stamp');
    // Explicit null -> un-answered again (value + stamp cleared).
    await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, {
      token: A.accessToken, body: { checks: [{ field_key: 'custom/spa_heater', value: null }] },
    });
    row = (await getChecks(checkinId)).find((c) => c.field_key === 'custom/spa_heater')!;
    if (row.value !== null) throw new Error(`explicit null did not clear value: ${JSON.stringify(row.value)}`);
    if (row.answered_at !== null || row.answered_by !== null) throw new Error('explicit null did not clear answered stamp');
  });

  await check('checks: input_kind accepted on upsert, presence-merged, enum-validated', async () => {
    const create = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, {
      token: A.accessToken,
      body: { checks: [{ field_key: 'custom/spare_fobs', label: 'Spare fobs', input_kind: 'count', value: 2 }] },
    });
    assertStatus(create, 200, 'create typed check');
    let row = (await getChecks(checkinId)).find((c) => c.field_key === 'custom/spare_fobs')!;
    if (row.input_kind !== 'count') throw new Error(`input_kind=${row.input_kind}`);
    // Re-save without input_kind: preserved, not erased.
    await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, {
      token: A.accessToken, body: { checks: [{ field_key: 'custom/spare_fobs', value: 1 }] },
    });
    row = (await getChecks(checkinId)).find((c) => c.field_key === 'custom/spare_fobs')!;
    if (row.input_kind !== 'count') throw new Error('input_kind erased by re-save without the key');
    // Unknown kind rejected by the contract.
    const bad = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks`, {
      token: A.accessToken,
      body: { checks: [{ field_key: 'custom/spare_fobs', input_kind: 'condition_text' }] },
    });
    if (bad.status !== 400) throw new Error(`unknown input_kind: expected 400, got ${bad.status}`);
  });

  let deletedCheckId = '';
  await check('checks: DELETE soft-deletes; same-key retry replays 204; repeat is 404', async () => {
    const row = (await getChecks(checkinId)).find((c) => c.field_key === 'custom/spa_heater')!;
    deletedCheckId = row.id;
    // Fixed key: the retry below must REPLAY, not re-execute (the api() helper
    // mints a fresh key per call, which is why replay was never covered).
    const idemKey = `t-replay-${crypto.randomUUID()}`;
    const delReq = () =>
      app.fetch(
        new Request(`http://test/v1/accounts/${A.accountId}/inspections/${checkinId}/checks/${row.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${A.accessToken}`, 'idempotency-key': idemKey },
        }),
      );
    const del = await delReq();
    if (del.status !== 204) throw new Error(`delete: expected 204, got ${del.status} ${await del.text()}`);
    if ((await getChecks(checkinId)).some((c) => c.id === row.id)) throw new Error('deleted check still listed');
    // Same-key retry (lost-response simulation): replayed 204, not a 500/404.
    const replay = await delReq();
    if (replay.status !== 204) throw new Error(`replay: expected 204, got ${replay.status} ${await replay.text()}`);
    if (replay.headers.get('idempotency-replay') !== 'true') throw new Error('replay missing Idempotency-Replay header');
    // A FRESH key on the now-deleted row is a genuine re-execution: 404.
    const again = await api('DELETE', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks/${row.id}`, {
      token: A.accessToken,
    });
    if (again.status !== 404) throw new Error(`repeat delete: expected 404, got ${again.status}`);
  });

  await check('checks: cross-account DELETE is 404', async () => {
    const row = (await getChecks(checkinId)).find((c) => c.field_key === 'keys/door_keys')!;
    const del = await api('DELETE', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks/${row.id}`, {
      token: B.accessToken,
    });
    if (del.status !== 404 && del.status !== 403) throw new Error(`expected 404/403, got ${del.status}`);
  });

  await check('upload a photo to a move-in item (pre-completion)', async () => {
    const fd = new FormData();
    fd.set('entity_type', 'inspection_items');
    fd.set('entity_id', livingItemId);
    fd.set('file', pngFile());
    const r = await api('POST', `/v1/accounts/${A.accountId}/attachments`, { token: A.accessToken, multipart: fd });
    if (r.status !== 201) throw new Error(`photo upload: ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('mint tenant capture link', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/capture-links`, {
      token: A.accessToken, body: { tenant_id: A.tenantId },
    });
    const b = assertStatus(r, 201, 'capture link') as { secret: string };
    if (!b.secret) throw new Error('no secret returned');
    captureSecret = b.secret;
  });

  await check('capture form exposes input_kind so the tenant UI can render steppers', async () => {
    const form = await api('GET', `/v1/inspection-capture/${captureSecret}`);
    const fb = assertStatus(form, 200, 'capture form') as { checks: { field_key: string; input_kind: string | null }[] };
    const keysCheck = fb.checks.find((c) => c.field_key === 'keys/door_keys');
    if (!keysCheck) throw new Error('keys/door_keys not in capture form');
    if (keysCheck.input_kind !== 'count') throw new Error(`capture form input_kind=${keysCheck.input_kind}`);
  });

  await check('tenant loads form + edits an item + checks via magic link, then submits', async () => {
    const form = await api('GET', `/v1/inspection-capture/${captureSecret}`);
    const fb = assertStatus(form, 200, 'capture form') as { items: { id: string; item_key: string }[]; checks: unknown[] };
    if (fb.items.length === 0) throw new Error('form has no items');
    const item = fb.items.find((i) => i.item_key === 'living_room/flooring') ?? fb.items[0]!;
    const pi = await api('PATCH', `/v1/inspection-capture/${captureSecret}/items/${item.id}`, {
      body: { condition: 'tenant notes a small scuff' },
    });
    assertStatus(pi, 200, 'tenant item patch');
    const pc = await api('POST', `/v1/inspection-capture/${captureSecret}/checks`, {
      body: { checks: [{ field_key: 'systems/smoke_alarms_working', value: true }] },
    });
    assertStatus(pc, 200, 'tenant checks');
    const sub = await api('POST', `/v1/inspection-capture/${captureSecret}/submit`);
    const sb = assertStatus(sub, 200, 'tenant submit') as { inspection: { status: string } };
    if (sb.inspection.status !== 'tenant_submitted') throw new Error(`status=${sb.inspection.status}`);
  });

  await check('tenant cannot edit after submitting', async () => {
    const form = await api('GET', `/v1/inspection-capture/${captureSecret}`);
    const fb = form.body as { items: { id: string }[] };
    const pi = await api('PATCH', `/v1/inspection-capture/${captureSecret}/items/${fb.items[0]!.id}`, {
      body: { condition: 'should be blocked' },
    });
    if (pi.status !== 409) throw new Error(`expected 409, got ${pi.status}`);
  });

  // --------------------------------------------------------------------------
  // Engagement funnel: link -> opened -> started -> submitted + room progress.
  // Self-contained on its own capture_mode='tenant' inspection so no landlord
  // pre-fill perturbs the assertions.
  // --------------------------------------------------------------------------
  interface Engagement {
    link_delivered_at: string | null;
    form_opened_at: string | null;
    form_started_at: string | null;
    submitted_at: string | null;
    rooms_done: number;
    rooms_total: number;
  }
  const getEngagement = async (inspId: string): Promise<Engagement> => {
    const r = await api('GET', `/v1/accounts/${A.accountId}/inspections/${inspId}`, { token: A.accessToken });
    const b = assertStatus(r, 200, 'inspection detail') as { engagement?: Engagement };
    if (!b.engagement) throw new Error('engagement object missing on detail response');
    return b.engagement;
  };
  let engInspId = '';
  let engSecret = '';
  let engRoom1 = '';
  let engRoom2 = '';

  await check('engagement: fresh inspection -> all-null timestamps, zero rooms_done', async () => {
    const insp = await api('POST', `/v1/accounts/${A.accountId}/inspections`, {
      token: A.accessToken,
      body: { area_id: A.unitAreaId, tenancy_id: A.tenancyId, template_id: templateId, kind: 'move_in', capture_mode: 'tenant' },
    });
    engInspId = (assertStatus(insp, 201, 'eng create') as { id: string }).id;
    const seed = await api('POST', `/v1/accounts/${A.accountId}/inspections/${engInspId}/seed-from-template`, {
      token: A.accessToken, body: {},
    });
    assertStatus(seed, 200, 'eng seed');
    const e = await getEngagement(engInspId);
    if (e.link_delivered_at || e.form_opened_at || e.form_started_at || e.submitted_at) {
      throw new Error(`fresh funnel not all-null: ${JSON.stringify(e)}`);
    }
    if (e.rooms_done !== 0) throw new Error(`fresh rooms_done=${e.rooms_done}`);
    if (e.rooms_total < 2) throw new Error(`expected >=2 rooms, got rooms_total=${e.rooms_total}`);
  });

  await check('engagement: mint link -> link_delivered_at set, rest null', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections/${engInspId}/capture-links`, {
      token: A.accessToken, body: { tenant_id: A.tenantId },
    });
    engSecret = (assertStatus(r, 201, 'eng capture link') as { secret: string }).secret;
    const e = await getEngagement(engInspId);
    if (!e.link_delivered_at) throw new Error('link_delivered_at not set after mint');
    if (e.form_opened_at || e.form_started_at || e.submitted_at) throw new Error(`only link_delivered_at should be set: ${JSON.stringify(e)}`);
  });

  await check('engagement: tenant GETs form -> form_opened_at set, form_started_at null', async () => {
    const form = await api('GET', `/v1/inspection-capture/${engSecret}`);
    const fb = assertStatus(form, 200, 'eng form') as {
      items: { id: string; group_label: string | null }[];
      confirmed_rooms: string[];
    };
    if (!Array.isArray(fb.confirmed_rooms) || fb.confirmed_rooms.length !== 0) throw new Error('confirmed_rooms should start empty');
    const rooms = [...new Set(fb.items.map((i) => i.group_label).filter((g): g is string => !!g))];
    if (rooms.length < 2) throw new Error(`need >=2 distinct group_labels, got ${rooms.length}`);
    engRoom1 = rooms[0]!;
    engRoom2 = rooms[1]!;
    const e = await getEngagement(engInspId);
    if (!e.form_opened_at) throw new Error('form_opened_at not set after GET form');
    if (e.form_started_at) throw new Error('form_started_at should still be null (no writes yet)');
    if (e.rooms_done !== 0) throw new Error(`rooms_done should still be 0, got ${e.rooms_done}`);
  });

  await check('engagement: first tenant write -> form_started_at set once; room counts done', async () => {
    const form = await api('GET', `/v1/inspection-capture/${engSecret}`);
    const fb = form.body as { items: { id: string; group_label: string | null }[] };
    const itemInRoom1 = fb.items.find((i) => i.group_label === engRoom1)!;
    const pi = await api('PATCH', `/v1/inspection-capture/${engSecret}/items/${itemInRoom1.id}`, {
      body: { condition: 'good' },
    });
    assertStatus(pi, 200, 'eng tenant patch');
    const e1 = await getEngagement(engInspId);
    if (!e1.form_started_at) throw new Error('form_started_at not set after first write');
    if (e1.rooms_done < 1) throw new Error(`rooms_done should be >=1 after editing a room, got ${e1.rooms_done}`);
    // Second write must NOT move form_started_at (set-once).
    const pi2 = await api('PATCH', `/v1/inspection-capture/${engSecret}/items/${itemInRoom1.id}`, {
      body: { condition: 'fair' },
    });
    assertStatus(pi2, 200, 'eng tenant patch 2');
    const e2 = await getEngagement(engInspId);
    if (e2.form_started_at !== e1.form_started_at) throw new Error('form_started_at moved on second write (not set-once)');
  });

  await check('engagement: confirm a room -> rooms_done increments; re-confirm idempotent', async () => {
    const before = await getEngagement(engInspId);
    const rc = await api('POST', `/v1/inspection-capture/${engSecret}/rooms/confirm`, {
      body: { group_label: engRoom2 },
    });
    const rb = assertStatus(rc, 200, 'eng room confirm') as { confirmed: boolean };
    if (rb.confirmed !== true) throw new Error('confirm did not return confirmed:true');
    const after = await getEngagement(engInspId);
    if (after.rooms_done !== before.rooms_done + 1) throw new Error(`rooms_done ${before.rooms_done} -> ${after.rooms_done}, expected +1`);
    if (after.rooms_done > after.rooms_total) throw new Error('rooms_done exceeded rooms_total');
    // Re-confirm the same room: idempotent no-op (200), count unchanged.
    const rc2 = await api('POST', `/v1/inspection-capture/${engSecret}/rooms/confirm`, {
      body: { group_label: engRoom2 },
    });
    assertStatus(rc2, 200, 'eng room re-confirm');
    const again = await getEngagement(engInspId);
    if (again.rooms_done !== after.rooms_done) throw new Error('re-confirm changed rooms_done (not idempotent)');
    // confirmed_rooms surfaces on the tenant form.
    const form = await api('GET', `/v1/inspection-capture/${engSecret}`);
    const fb = form.body as { confirmed_rooms: string[] };
    if (!fb.confirmed_rooms.includes(engRoom2)) throw new Error('confirmed room not surfaced in confirmed_rooms');
  });

  await check('engagement: ungrouped items form a bucket, confirmable via omitted group_label', async () => {
    // Landlord adds a loose item with NO group_label -> the ungrouped bucket.
    const it = await api('POST', `/v1/accounts/${A.accountId}/inspections/${engInspId}/items`, {
      token: A.accessToken, body: { label: 'loose smoke detector' },
    });
    assertStatus(it, 201, 'ungrouped item create');
    const before = await getEngagement(engInspId); // ungrouped bucket now in rooms_total, not yet done
    // Confirm the ungrouped bucket by OMITTING group_label (null == ungrouped).
    const rc = await api('POST', `/v1/inspection-capture/${engSecret}/rooms/confirm`, { body: {} });
    assertStatus(rc, 200, 'confirm ungrouped (omitted)');
    const after = await getEngagement(engInspId);
    if (after.rooms_total !== before.rooms_total) throw new Error(`rooms_total shifted unexpectedly: ${before.rooms_total}->${after.rooms_total}`);
    if (after.rooms_done !== before.rooms_done + 1) throw new Error(`ungrouped confirm should +1 rooms_done: ${before.rooms_done}->${after.rooms_done}`);
    if (after.rooms_done > after.rooms_total) throw new Error('rooms_done exceeded rooms_total');
    // Re-confirm ungrouped via explicit null: idempotent no-op (dedupes despite null key).
    const rc2 = await api('POST', `/v1/inspection-capture/${engSecret}/rooms/confirm`, { body: { group_label: null } });
    assertStatus(rc2, 200, 're-confirm ungrouped (null)');
    const again = await getEngagement(engInspId);
    if (again.rooms_done !== after.rooms_done) throw new Error('re-confirm ungrouped changed rooms_done (null not deduped)');
    // Surfaces in confirmed_rooms as a null entry.
    const form = await api('GET', `/v1/inspection-capture/${engSecret}`);
    const fb = form.body as { confirmed_rooms: (string | null)[] };
    if (!fb.confirmed_rooms.includes(null)) throw new Error('ungrouped confirmation not surfaced as null in confirmed_rooms');
  });

  await check('engagement: submit -> submitted_at set; re-open/re-submit does not move timestamps', async () => {
    const sub = await api('POST', `/v1/inspection-capture/${engSecret}/submit`);
    assertStatus(sub, 200, 'eng submit');
    const e = await getEngagement(engInspId);
    if (!e.submitted_at) throw new Error('submitted_at not set after submit');
    // Idempotent re-submit + re-open: no timestamp moves.
    const sub2 = await api('POST', `/v1/inspection-capture/${engSecret}/submit`);
    assertStatus(sub2, 200, 'eng re-submit');
    const e2 = await getEngagement(engInspId);
    if (e2.submitted_at !== e.submitted_at) throw new Error('submitted_at moved on re-submit');
    if (e2.link_delivered_at !== e.link_delivered_at || e2.form_opened_at !== e.form_opened_at || e2.form_started_at !== e.form_started_at) {
      throw new Error('a set-once timestamp moved on re-open/re-submit');
    }
  });

  await check('engagement: rooms/confirm with an invalid secret -> 404', async () => {
    const r = await api('POST', `/v1/inspection-capture/not-a-real-secret-value/rooms/confirm`, {
      body: { group_label: 'anything' },
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  await check('landlord reviews then completes; emits move-in document + snapshots', async () => {
    const rev = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/review`, { token: A.accessToken });
    const rb = assertStatus(rev, 200, 'review') as { status: string };
    if (rb.status !== 'landlord_reviewed') throw new Error(`status=${rb.status}`);
    const comp = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/complete`, { token: A.accessToken });
    const cb = assertStatus(comp, 200, 'complete') as {
      inspection: { status: string; template_snapshot: unknown };
      report: { content_hash: string };
      document: { id: string; document_type: string } | null;
      document_version: { content_hash: string } | null;
    };
    if (cb.inspection.status !== 'completed') throw new Error(`status=${cb.inspection.status}`);
    if (!/^[a-f0-9]{64}$/.test(cb.report.content_hash)) throw new Error('bad report hash');
    if (!cb.document || cb.document.document_type !== 'move_in') throw new Error('move_in document not emitted');
    if (!cb.inspection.template_snapshot) throw new Error('template_snapshot not frozen');
    if (cb.document_version?.content_hash !== cb.report.content_hash) throw new Error('version hash != report hash');
  });

  await check('completion is idempotent (same report + document on re-complete)', async () => {
    const first = await api('GET', `/v1/accounts/${A.accountId}/documents?tenancy_id=${A.tenancyId}`, { token: A.accessToken });
    const docs1 = (first.body as { data: { id: string }[] }).data.length;
    const comp = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/complete`, { token: A.accessToken });
    assertStatus(comp, 200, 're-complete');
    const second = await api('GET', `/v1/accounts/${A.accountId}/documents?tenancy_id=${A.tenancyId}`, { token: A.accessToken });
    const docs2 = (second.body as { data: { id: string }[] }).data.length;
    if (docs1 !== docs2) throw new Error(`re-complete changed document count ${docs1} -> ${docs2}`);
  });

  await check('completed inspection rejects item edits and new photos', async () => {
    const items = await api('GET', `/v1/accounts/${A.accountId}/inspections/${checkinId}/items`, { token: A.accessToken });
    const itemId = (items.body as { data: { id: string }[] }).data[0]!.id;
    const patch = await api('PATCH', `/v1/accounts/${A.accountId}/inspections/${checkinId}/items/${itemId}`, {
      token: A.accessToken, body: { condition: 'nope' },
    });
    if (patch.status !== 409) throw new Error(`item patch expected 409, got ${patch.status}`);
    const fd = new FormData();
    fd.set('entity_type', 'inspection_items');
    fd.set('entity_id', itemId);
    fd.set('file', pngFile());
    const up = await api('POST', `/v1/accounts/${A.accountId}/attachments`, { token: A.accessToken, multipart: fd });
    if (up.status !== 409) throw new Error(`post-completion photo expected 409, got ${up.status}`);
  });

  await check('checks: DELETE on a completed inspection is 409', async () => {
    const row = (await getChecks(checkinId)).find((c) => c.field_key === 'keys/door_keys')!;
    const del = await api('DELETE', `/v1/accounts/${A.accountId}/inspections/${checkinId}/checks/${row.id}`, {
      token: A.accessToken,
    });
    if (del.status !== 409) throw new Error(`expected 409, got ${del.status} ${JSON.stringify(del.body)}`);
  });

  await check('start checkout pre-keyed from check-in (values reset)', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkinId}/start-checkout`, {
      token: A.accessToken, body: {},
    });
    const b = assertStatus(r, 201, 'start-checkout') as { id: string; kind: string; baseline_inspection_id: string };
    checkoutId = b.id;
    if (b.kind !== 'move_out') throw new Error(`kind=${b.kind}`);
    if (b.baseline_inspection_id !== checkinId) throw new Error('baseline not linked');
    const items = await api('GET', `/v1/accounts/${A.accountId}/inspections/${checkoutId}/items`, { token: A.accessToken });
    const ib = (items.body as { data: { item_key: string; condition: string | null }[] }).data;
    if (!ib.some((i) => i.item_key === 'living_room/flooring')) throw new Error('item skeleton not copied');
    if (ib.some((i) => i.condition !== null)) throw new Error('checkout conditions should reset to null');
  });

  await check('checkout skeleton copies check input_kind (move-out keeps its typing)', async () => {
    const rows = await getChecks(checkoutId);
    const keysCheck = rows.find((c) => c.field_key === 'keys/door_keys');
    if (!keysCheck) throw new Error('keys/door_keys not copied to checkout');
    if (keysCheck.input_kind !== 'count') {
      throw new Error(`checkout lost input_kind: ${keysCheck.input_kind} (move-out would regress to Yes/No)`);
    }
    if (keysCheck.value !== null) throw new Error('checkout check value should reset to null');
  });

  await check('checkout diff shows deltas, change_type, and photo counts', async () => {
    await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkoutId}/items/batch`, {
      token: A.accessToken,
      body: { items: [{ item_key: 'living_room/flooring', condition: 'stained', change_type: 'damage' }] },
    });
    const r = await api('GET', `/v1/accounts/${A.accountId}/inspections/${checkoutId}/checkout-diff`, { token: A.accessToken });
    const b = assertStatus(r, 200, 'checkout-diff') as {
      data: { row_type: string; key: string; checkout_value: string | null; change_type: string | null; baseline_photo_count: number }[];
    };
    const living = b.data.find((d) => d.row_type === 'item' && d.key === 'living_room/flooring');
    if (!living) throw new Error('living_room/flooring not in diff');
    if (living.checkout_value !== 'stained') throw new Error(`checkout_value=${living.checkout_value}`);
    if (living.change_type !== 'damage') throw new Error(`change_type=${living.change_type}`);
    if (living.baseline_photo_count < 1) throw new Error('baseline photo not counted');
    if (!b.data.some((d) => d.row_type === 'check' && d.key === 'keys/door_keys')) throw new Error('check not in diff');
  });

  await check('cross-account isolation: B cannot read A inspection or diff', async () => {
    const g = await api('GET', `/v1/accounts/${A.accountId}/inspections/${checkinId}`, { token: B.accessToken });
    if (g.status !== 404 && g.status !== 403) throw new Error(`cross-account read expected 404/403, got ${g.status}`);
    const d = await api('GET', `/v1/accounts/${A.accountId}/inspections/${checkoutId}/checkout-diff`, { token: B.accessToken });
    if (d.status !== 404 && d.status !== 403) throw new Error(`cross-account diff expected 404/403, got ${d.status}`);
  });

  await check('invalid capture secret -> 404; request-renewal -> 202 (uniform)', async () => {
    const bad = await api('GET', `/v1/inspection-capture/not-a-real-secret-value`);
    if (bad.status !== 404) throw new Error(`expected 404, got ${bad.status}`);
    const ren = await api('POST', `/v1/inspection-capture/request-renewal`, { body: { secret: captureSecret } });
    if (ren.status !== 202) throw new Error(`renewal expected 202, got ${ren.status}`);
  });

  await check('void a completed inspection', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/inspections/${checkoutId}/void`, {
      token: A.accessToken, body: { reason: 'duplicate; superseded' },
    });
    const b = assertStatus(r, 200, 'void') as { status: string; void_reason: string };
    if (b.status !== 'voided') throw new Error(`status=${b.status}`);
  });

  await check('evidence-export bundle includes condition-report data', async () => {
    const { loadExportData } = await import('../src/admin/export-pdf');
    const data = await loadExportData({
      accountId: A.accountId, tenancyId: A.tenancyId, areaId: null,
      fromDate: null, toDate: null, exporter: null,
    });
    const insp = data.inspections.find((i) => i.id === checkinId);
    if (!insp) throw new Error('completed check-in not in export scope');
    if (insp.kind !== 'move_in') throw new Error('export inspection missing kind');
    if (!data.inspectionChecks.some((c) => c.inspection_id === checkinId)) throw new Error('export missing inspection checks');
    if (!data.inspectionItems.some((it) => it.inspection_id === checkinId)) throw new Error('export missing inspection items');
    // Evidence completeness: the soft-deleted check stays in the bundle data
    // (rendered with a "(removed)" annotation), never silently dropped.
    const tomb = data.inspectionChecks.find((c) => c.id === deletedCheckId);
    if (!tomb) throw new Error('soft-deleted check missing from export data (evidence completeness)');
    if (!tomb.deleted_at) throw new Error('tombstone check lost its deleted_at in export data');
    if (!data.attachments.some((a) => a.entity_type === 'inspection_items' && a.derived_from === null)) throw new Error('export missing item photos');
    if (!data.attachments.some((a) => a.entity_type === 'inspection_report' && a.entity_id === checkinId)) throw new Error('export missing rendered report attachment');
  });

  // ============================================================================
  // Tenant capture: photo upload + attachment download proxy + batch item edit
  // ============================================================================

  let photoInspId = '';
  let photoItemId = '';
  let photoItemKeys: string[] = [];
  let photoSecret = '';
  let uploadedAttId = '';

  await check('tenant-photo setup: draft inspection, seed items, mint capture link', async () => {
    // Fresh property/area/tenancy so there are no unique-constraint conflicts
    // with the already-completed checkinId flow above.
    const prop = await api('POST', `/v1/accounts/${A.accountId}/properties`, {
      token: A.accessToken, body: { name: 'photo-test prop' },
    });
    const pId = (assertStatus(prop, 201, 'prop') as { id: string }).id;
    const area = await api('POST', `/v1/accounts/${A.accountId}/areas`, {
      token: A.accessToken, body: { property_id: pId, kind: 'unit', name: 'photo-test unit' },
    });
    const aId = (assertStatus(area, 201, 'area') as { id: string }).id;
    const ten = await api('POST', `/v1/accounts/${A.accountId}/tenancies`, {
      token: A.accessToken, body: { area_id: aId, start_date: '2026-02-01', status: 'active' },
    });
    const tId = (assertStatus(ten, 201, 'tenancy') as { id: string }).id;
    const t3 = await api('POST', `/v1/accounts/${A.accountId}/tenants`, {
      token: A.accessToken, body: { full_name: 'photo tenant', emails: [`photo-${rnd()}@example.test`] },
    });
    const t3Id = (assertStatus(t3, 201, 'tenant3') as { id: string }).id;
    const insp = await api('POST', `/v1/accounts/${A.accountId}/inspections`, {
      token: A.accessToken,
      body: { area_id: aId, tenancy_id: tId, template_id: templateId, kind: 'move_in', capture_mode: 'collaborative' },
    });
    const ib = assertStatus(insp, 201, 'photo insp') as { id: string };
    photoInspId = ib.id;
    const seed = await api('POST', `/v1/accounts/${A.accountId}/inspections/${photoInspId}/seed-from-template`, {
      token: A.accessToken, body: {},
    });
    const sb = assertStatus(seed, 200, 'photo seed') as { items: { id: string; item_key: string }[] };
    if (sb.items.length < 2) throw new Error(`expected >=2 seeded items, got ${sb.items.length}`);
    photoItemId = sb.items[0]!.id;
    photoItemKeys = sb.items.slice(0, 3).map((i) => i.item_key);
    const link = await api('POST', `/v1/accounts/${A.accountId}/inspections/${photoInspId}/capture-links`, {
      token: A.accessToken, body: { tenant_id: t3Id },
    });
    const lb = assertStatus(link, 201, 'photo link') as { secret: string };
    if (!lb.secret) throw new Error('no secret returned');
    photoSecret = lb.secret;
  });

  await check('tenant uploads a photo to a draft item via capture route -> 201 with attachment_id', async () => {
    const fd = new FormData();
    fd.set('file', pngFile());
    const r = await api('POST', `/v1/inspection-capture/${photoSecret}/items/${photoItemId}/photos`, { multipart: fd });
    const b = assertStatus(r, 201, 'photo upload') as { attachment_id: string; derivative_id: unknown };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.attachment_id)) {
      throw new Error(`invalid attachment_id uuid: ${b.attachment_id}`);
    }
    uploadedAttId = b.attachment_id;
  });

  await check('uploaded capture photo appears in capture form photos[] for that item', async () => {
    const r = await api('GET', `/v1/inspection-capture/${photoSecret}`);
    const fb = assertStatus(r, 200, 'form') as { items: { id: string; photos: { id: string }[] }[] };
    const item = fb.items.find((i) => i.id === photoItemId);
    if (!item) throw new Error('target item not found in form');
    if (!Array.isArray(item.photos)) throw new Error('photos field is not an array');
    if (!item.photos.some((p) => p.id === uploadedAttId)) {
      throw new Error(`uploaded photo ${uploadedAttId} not found in item.photos[]`);
    }
  });

  await check('capture download proxy: bytes match + forced content-disposition and nosniff', async () => {
    // Use app.fetch directly — api() consumes body as text which would corrupt binary bytes.
    const res = await app.fetch(
      new Request(`http://test/v1/inspection-capture/${photoSecret}/attachments/${uploadedAttId}/download`),
    );
    if (res.status !== 200) {
      const txt = await res.text();
      throw new Error(`expected 200, got ${res.status}: ${txt}`);
    }
    const cd = res.headers.get('content-disposition') ?? '';
    if (!cd.startsWith('attachment')) throw new Error(`content-disposition not forced to "attachment": "${cd}"`);
    const nosniff = res.headers.get('x-content-type-options') ?? '';
    if (nosniff !== 'nosniff') throw new Error(`x-content-type-options not "nosniff": "${nosniff}"`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength !== PNG_1x1.byteLength) {
      throw new Error(`size mismatch: downloaded ${buf.byteLength} bytes, expected ${PNG_1x1.byteLength}`);
    }
    if (!buf.equals(PNG_1x1)) throw new Error('downloaded bytes do not match the uploaded PNG bytes');
  });

  await check('capture photo upload is idempotent: identical bytes return the same attachment_id', async () => {
    const fd = new FormData();
    fd.set('file', pngFile());
    const r = await api('POST', `/v1/inspection-capture/${photoSecret}/items/${photoItemId}/photos`, { multipart: fd });
    const b = assertStatus(r, 201, 'idempotent upload') as { attachment_id: string };
    if (b.attachment_id !== uploadedAttId) {
      throw new Error(`idempotency broken: got ${b.attachment_id}, expected same id ${uploadedAttId}`);
    }
  });

  await check('tenant checks upsert: presence-merge + answered_at without answered_by', async () => {
    // Tenant answers a check via the capture route.
    const w1 = await api('POST', `/v1/inspection-capture/${photoSecret}/checks`, {
      body: { checks: [{ field_key: 'keys/door_keys', value: 4, group_label: 'Keys & access' }] },
    });
    assertStatus(w1, 200, 'tenant check write');
    const read1 = await admin.from('inspection_checks')
      .select('value, group_label, answered_by, answered_at')
      .eq('inspection_id', photoInspId).eq('field_key', 'keys/door_keys').is('deleted_at', null).single();
    if (read1.error) throw new Error(read1.error.message);
    if (read1.data.value !== 4) throw new Error(`tenant value not stored: ${JSON.stringify(read1.data.value)}`);
    if (!read1.data.answered_at) throw new Error('tenant answer did not stamp answered_at');
    if (read1.data.answered_by !== null) throw new Error('tenant answer must not attribute answered_by');
    // Metadata-only tenant re-save: value + stamp survive.
    const w2 = await api('POST', `/v1/inspection-capture/${photoSecret}/checks`, {
      body: { checks: [{ field_key: 'keys/door_keys', sort_order: 9 }] },
    });
    assertStatus(w2, 200, 'tenant metadata-only re-save');
    const read2 = await admin.from('inspection_checks')
      .select('value, group_label, sort_order, answered_at')
      .eq('inspection_id', photoInspId).eq('field_key', 'keys/door_keys').is('deleted_at', null).single();
    if (read2.error) throw new Error(read2.error.message);
    if (read2.data.value !== 4) throw new Error('tenant metadata-only save erased value');
    if (read2.data.group_label !== 'Keys & access') throw new Error('tenant metadata-only save erased group_label');
    if (read2.data.answered_at !== read1.data.answered_at) throw new Error('tenant metadata-only save moved answered_at');
  });

  await check('tenant batch edit marks items Good; unknown item_key is a silent no-op', async () => {
    const unknownKey = 'definitely/does_not_exist_xyz';
    const r = await api('POST', `/v1/inspection-capture/${photoSecret}/items/batch`, {
      body: { items: [...photoItemKeys.map((k) => ({ item_key: k, condition: 'Good' })), { item_key: unknownKey, condition: 'Good' }] },
    });
    const b = assertStatus(r, 200, 'batch') as { data: { item_key: string; condition: string }[] };
    if (b.data.some((d) => d.item_key === unknownKey)) throw new Error('unknown item_key must be silently ignored (not created)');
    for (const k of photoItemKeys) {
      const found = b.data.find((d) => d.item_key === k);
      if (!found) throw new Error(`item_key ${k} not returned in batch response`);
      if (found.condition !== 'Good') throw new Error(`item ${k}: expected condition=Good, got "${found.condition}"`);
    }
    // Verify persisted via GET form
    const form = await api('GET', `/v1/inspection-capture/${photoSecret}`);
    const fItems = (assertStatus(form, 200, 'form after batch') as { items: { item_key: string; condition: string }[] }).items;
    for (const k of photoItemKeys) {
      const fi = fItems.find((i) => i.item_key === k);
      if (!fi || fi.condition !== 'Good') throw new Error(`form item ${k}: expected Good, got "${fi?.condition}"`);
    }
  });

  await check('photo upload + batch both rejected after tenant submit (409)', async () => {
    // Submit the photo-test inspection so it moves out of draft.
    const sub = await api('POST', `/v1/inspection-capture/${photoSecret}/submit`);
    assertStatus(sub, 200, 'submit photo inspection');
    // Photo upload must now 409.
    const fd = new FormData();
    fd.set('file', pngFile());
    const up = await api('POST', `/v1/inspection-capture/${photoSecret}/items/${photoItemId}/photos`, { multipart: fd });
    if (up.status !== 409) throw new Error(`photo upload after submit: expected 409, got ${up.status} ${JSON.stringify(up.body)}`);
    // Batch must also 409.
    const batch = await api('POST', `/v1/inspection-capture/${photoSecret}/items/batch`, {
      body: { items: [{ item_key: photoItemKeys[0]!, condition: 'Bad' }] },
    });
    if (batch.status !== 409) throw new Error(`batch after submit: expected 409, got ${batch.status} ${JSON.stringify(batch.body)}`);
  });

  await check('capture photo upload rejected on a completed inspection (409)', async () => {
    // captureSecret + livingItemId belong to the already-completed checkinId from the main flow.
    const fd = new FormData();
    fd.set('file', pngFile());
    const up = await api(
      'POST',
      `/v1/inspection-capture/${captureSecret}/items/${livingItemId}/photos`,
      { multipart: fd },
    );
    if (up.status !== 409) {
      throw new Error(`expected 409 on completed inspection, got ${up.status} ${JSON.stringify(up.body)}`);
    }
  });

  await check('cross-token isolation: B token cannot download A attachment or modify A items', async () => {
    // Set up a fresh draft inspection in B with its own capture link.
    const bProp = await api('POST', `/v1/accounts/${B.accountId}/properties`, {
      token: B.accessToken, body: { name: 'b-iso prop' },
    });
    const bPId = (assertStatus(bProp, 201, 'b prop') as { id: string }).id;
    const bArea = await api('POST', `/v1/accounts/${B.accountId}/areas`, {
      token: B.accessToken, body: { property_id: bPId, kind: 'unit', name: 'b-iso unit' },
    });
    const bAId = (assertStatus(bArea, 201, 'b area') as { id: string }).id;
    const bTen = await api('POST', `/v1/accounts/${B.accountId}/tenancies`, {
      token: B.accessToken, body: { area_id: bAId, start_date: '2026-02-01', status: 'active' },
    });
    const bTId = (assertStatus(bTen, 201, 'b tenancy') as { id: string }).id;
    const bCatR = await api('GET', `/v1/accounts/${B.accountId}/inspection-template-catalog`, { token: B.accessToken });
    const bCatItems = (assertStatus(bCatR, 200, 'b catalog') as { data: { id: string }[] }).data;
    const bTmplR = await api('POST', `/v1/accounts/${B.accountId}/inspection-templates/from-catalog`, {
      token: B.accessToken, body: { catalog_id: bCatItems[0]!.id },
    });
    const bTmplId = (assertStatus(bTmplR, 201, 'b template') as { id: string }).id;
    const bInspR = await api('POST', `/v1/accounts/${B.accountId}/inspections`, {
      token: B.accessToken,
      body: { area_id: bAId, tenancy_id: bTId, template_id: bTmplId, kind: 'move_in', capture_mode: 'tenant' },
    });
    const bInspId = (assertStatus(bInspR, 201, 'b insp') as { id: string }).id;
    await api('POST', `/v1/accounts/${B.accountId}/inspections/${bInspId}/seed-from-template`, {
      token: B.accessToken, body: {},
    });
    const bTenantR = await api('POST', `/v1/accounts/${B.accountId}/tenants`, {
      token: B.accessToken, body: { full_name: 'b iso tenant', emails: [`b-iso-${rnd()}@example.test`] },
    });
    const bTenantId = (assertStatus(bTenantR, 201, 'b tenant') as { id: string }).id;
    const bLinkR = await api('POST', `/v1/accounts/${B.accountId}/inspections/${bInspId}/capture-links`, {
      token: B.accessToken, body: { tenant_id: bTenantId },
    });
    const bSecret = (assertStatus(bLinkR, 201, 'b link') as { secret: string }).secret;

    // B's secret cannot download A's attachment (item is not in B's inspection scope).
    const dlRes = await app.fetch(
      new Request(`http://test/v1/inspection-capture/${bSecret}/attachments/${uploadedAttId}/download`),
    );
    if (dlRes.status !== 404) throw new Error(`cross-token download: expected 404, got ${dlRes.status}`);

    // Snapshot A's item conditions before the isolation attempt.
    const aItemsBefore = await api('GET', `/v1/accounts/${A.accountId}/inspections/${photoInspId}/items`, { token: A.accessToken });
    const aIb = assertStatus(aItemsBefore, 200, 'a items before') as { data: { item_key: string; condition: string | null }[] };

    // B's capture secret batches using A's item_keys. The RPC scopes by B's
    // inspection_id, so A's rows are never touched; only B's own rows (if any
    // happen to share the same item_keys from the same template) are affected.
    const bBatch = await api('POST', `/v1/inspection-capture/${bSecret}/items/batch`, {
      body: { items: photoItemKeys.map((k) => ({ item_key: k, condition: 'tampered' })) },
    });
    if (bBatch.status !== 200 && bBatch.status !== 404 && bBatch.status !== 403) {
      throw new Error(`cross-token batch: unexpected status ${bBatch.status} ${JSON.stringify(bBatch.body)}`);
    }

    // Verify A's items are unchanged.
    const aItemsAfter = await api('GET', `/v1/accounts/${A.accountId}/inspections/${photoInspId}/items`, { token: A.accessToken });
    const aIa = assertStatus(aItemsAfter, 200, 'a items after') as { data: { item_key: string; condition: string | null }[] };
    for (const k of photoItemKeys) {
      const before = aIb.data.find((i) => i.item_key === k);
      const after = aIa.data.find((i) => i.item_key === k);
      if (before?.condition !== after?.condition) {
        throw new Error(`cross-token: A item "${k}" was modified: "${before?.condition}" -> "${after?.condition}"`);
      }
    }
  });

  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('OK: condition-reports flow all green');
}

main().catch((err) => { console.error(err); process.exit(1); });
