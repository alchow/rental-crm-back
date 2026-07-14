import { execSync } from 'node:child_process';

// ----------------------------------------------------------------------------
// PR D: per-unit inspection layout delta store (HTTP, against a local Supabase
// stack). Mirrors condition-reports.test.ts bootstrap. Exercises the singleton
// sub-resource on an area: PUT (idempotent whole-document upsert), GET (404 ==
// "no memory"), DELETE (reset to standard form + tombstone), tombstone revival
// on re-PUT, the cross-account-template FK 404, and the two request guards
// (missing Idempotency-Key, zod array bound).
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
  opts: { token?: string; body?: unknown; noIdemKey?: boolean } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  // Account-scoped mutations require an Idempotency-Key; inject one unless the
  // test is deliberately probing the missing-key guard.
  if (mutating && path.startsWith('/v1/accounts/') && !opts.noIdemKey) {
    headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
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

interface UserFixture { accessToken: string; accountId: string; unitAreaId: string; templateId: string }

async function setupUser(label: string): Promise<UserFixture> {
  const email = `ail-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', { body: { email, password, account_name: `AIL ${label}` } });
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
  const template = await post<{ id: string }>(`/v1/accounts/${accountId}/inspection-templates`, {
    name: `${label} template`,
  });
  return { accessToken, accountId, unitAreaId: unitArea.id, templateId: template.id };
}

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

// jsonb canonicalizes object KEY ORDER on write; compare documents by content
// (sorted keys, array order preserved), not by serialization byte order.
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]),
    );
  }
  return v;
}
function sameDoc(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

interface Layout {
  id: string;
  account_id: string;
  area_id: string;
  template_id: string;
  base_template_version: string | null;
  layout: {
    removed_section_keys?: string[];
    removed_item_keys?: string[];
    removed_check_keys?: string[];
    added_items?: { key: string; label: string }[];
    added_checks?: { key: string; label: string; input_kind?: string }[];
  };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

async function main(): Promise<void> {
  console.info('PR D area-inspection-layouts checks');
  const A = await setupUser('a');
  const B = await setupUser('b');

  const layoutUrl = (u: UserFixture) =>
    `/v1/accounts/${u.accountId}/areas/${u.unitAreaId}/inspection-layouts/${u.templateId}`;

  await check('GET on a never-written (area,template) pair -> 404', async () => {
    const r = await api('GET', layoutUrl(A), { token: A.accessToken });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('PUT creates (200) -> GET returns the same document', async () => {
    const doc = { removed_item_keys: ['garage/floor'], added_items: [{ key: 'balcony2/rail', label: 'Second balcony rail' }] };
    const put = await api('PUT', layoutUrl(A), {
      token: A.accessToken, body: { base_template_version: '1', layout: doc },
    });
    // PUT mirrors unit-details' PUT: 200 on upsert (create or replace).
    const pb = assertStatus(put, 200, 'PUT create') as Layout;
    if (pb.area_id !== A.unitAreaId || pb.template_id !== A.templateId) throw new Error('PUT echoed wrong keys');
    if (pb.base_template_version !== '1') throw new Error(`base_template_version=${pb.base_template_version}`);
    const get = await api('GET', layoutUrl(A), { token: A.accessToken });
    const gb = assertStatus(get, 200, 'GET after create') as Layout;
    if (!sameDoc(gb.layout, doc)) throw new Error(`layout mismatch: ${JSON.stringify(gb.layout)}`);
    if (gb.deleted_at !== null) throw new Error('live row should have deleted_at null');
  });

  await check('PUT again with a different layout -> GET shows whole-document replacement', async () => {
    const doc2 = { removed_section_keys: ['garage'], removed_check_keys: ['keys/mailbox'] };
    const put = await api('PUT', layoutUrl(A), {
      token: A.accessToken, body: { base_template_version: '2', layout: doc2 },
    });
    assertStatus(put, 200, 'PUT replace');
    const get = await api('GET', layoutUrl(A), { token: A.accessToken });
    const gb = assertStatus(get, 200, 'GET after replace') as Layout;
    // Whole-document semantics: the previous removed_item_keys/added_items are gone.
    if (gb.layout.removed_item_keys !== undefined) throw new Error('stale removed_item_keys survived replacement');
    if (gb.layout.added_items !== undefined) throw new Error('stale added_items survived replacement');
    if (!sameDoc(gb.layout, doc2)) throw new Error(`layout not replaced: ${JSON.stringify(gb.layout)}`);
    if (gb.base_template_version !== '2') throw new Error(`base_template_version=${gb.base_template_version}`);
  });

  await check('DELETE -> 204; GET -> 404; second DELETE -> 404', async () => {
    const del = await api('DELETE', layoutUrl(A), { token: A.accessToken });
    if (del.status !== 204) throw new Error(`DELETE expected 204, got ${del.status} ${JSON.stringify(del.body)}`);
    const get = await api('GET', layoutUrl(A), { token: A.accessToken });
    if (get.status !== 404) throw new Error(`GET after delete expected 404, got ${get.status}`);
    const del2 = await api('DELETE', layoutUrl(A), { token: A.accessToken });
    if (del2.status !== 404) throw new Error(`second DELETE expected 404, got ${del2.status}`);
  });

  await check('re-PUT after DELETE revives the tombstone (GET 200)', async () => {
    const doc = { removed_item_keys: ['garage/floor'] };
    const put = await api('PUT', layoutUrl(A), {
      token: A.accessToken, body: { base_template_version: '3', layout: doc },
    });
    // A revival, not a duplicate insert: the total unique constraint means the
    // same physical row is resurrected with deleted_at cleared.
    const pb = assertStatus(put, 200, 'PUT revive') as Layout;
    if (pb.deleted_at !== null) throw new Error('revived row should have deleted_at null');
    const get = await api('GET', layoutUrl(A), { token: A.accessToken });
    const gb = assertStatus(get, 200, 'GET after revive') as Layout;
    if (!sameDoc(gb.layout, doc)) throw new Error(`revived layout mismatch: ${JSON.stringify(gb.layout)}`);
    if (gb.base_template_version !== '3') throw new Error(`base_template_version=${gb.base_template_version}`);
  });

  await check('PUT with a cross-account template_id -> 404 (composite FK)', async () => {
    // A's account + A's area, but B's template id. The (account_id, template_id)
    // FK has no matching row, so PostgREST returns 23503 -> mapped to 404.
    const url = `/v1/accounts/${A.accountId}/areas/${A.unitAreaId}/inspection-layouts/${B.templateId}`;
    const r = await api('PUT', url, { token: A.accessToken, body: { layout: {} } });
    if (r.status !== 404) throw new Error(`cross-account template expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('PUT without an Idempotency-Key header -> 400', async () => {
    const r = await api('PUT', layoutUrl(A), {
      token: A.accessToken, body: { layout: {} }, noIdemKey: true,
    });
    if (r.status !== 400) throw new Error(`missing idempotency-key expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('PUT with 501 removed_item_keys -> 400 (zod max bound)', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `k/${i}`);
    const r = await api('PUT', layoutUrl(A), {
      token: A.accessToken, body: { layout: { removed_item_keys: tooMany } },
    });
    if (r.status !== 400) throw new Error(`501-entry array expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} FAILURE(S):`);
    for (const f of failures) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('OK: area-inspection-layouts flow all green');
}

main().catch((err) => { console.error(err); process.exit(1); });
