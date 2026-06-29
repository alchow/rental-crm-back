import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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
const { buildApp } = await import('../src/app');

const app = buildApp();

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; multipart?: FormData; idempotencyKey?: string } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = opts.idempotencyKey ?? `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.multipart) {
    init = { ...init, body: opts.multipart };
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('application/json') || ctype === '') {
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
  }
  return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), headers: responseHeaders };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface UserFixture {
  accessToken: string;
  accountId: string;
  propertyId: string;
  unitAreaId: string;
  tenancyId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `docs-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Docs ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };
  const accessToken = b.session.access_token;
  const accountId = b.account.id;
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: accessToken, body });
    if (r.status !== 201) throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(`/v1/accounts/${accountId}/properties`, {
    name: `${label} prop`,
  });
  const unitArea = await post<{ id: string }>(`/v1/accounts/${accountId}/areas`, {
    property_id: property.id,
    kind: 'unit',
    name: `${label} unit`,
  });
  const tenancy = await post<{ id: string }>(`/v1/accounts/${accountId}/tenancies`, {
    area_id: unitArea.id,
    start_date: '2026-01-01',
    status: 'active',
  });
  return { accessToken, accountId, propertyId: property.id, unitAreaId: unitArea.id, tenancyId: tenancy.id };
}

const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

function pdfFile(): File {
  return new File([PDF_BYTES], 'lease.pdf', { type: 'application/pdf' });
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

async function main(): Promise<void> {
  console.info('Tenant document vault checks');
  const A = await setupUser('a');
  const B = await setupUser('b');
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // Clear the per-IP doc-access rate buckets so repeated test runs in the same
  // 10-minute window don't trip the limiter.
  await admin.from('ip_rate_buckets').delete().eq('scope', 'doc_access');

  let uploadedDocId = '';
  let bundledDocId = '';
  let linkSecret = '';
  let linkId = '';

  await check('landlord uploads lease PDF and sees hash metadata', async () => {
    const fd = new FormData();
    fd.set('tenancy_id', A.tenancyId);
    fd.set('document_type', 'lease');
    fd.set('title', 'Signed Lease');
    fd.set('requires_ack', 'true');
    fd.set('file', pdfFile());
    const r = await api('POST', `/v1/accounts/${A.accountId}/documents`, {
      token: A.accessToken,
      multipart: fd,
    });
    const body = assertStatus(r, 201, 'upload document') as {
      id: string;
      latest_version: { content_hash: string; attachment_id: string };
    };
    uploadedDocId = body.id;
    if (body.latest_version.content_hash !== createHash('sha256').update(PDF_BYTES).digest('hex')) {
      throw new Error('uploaded document hash mismatch');
    }
    if (!body.latest_version.attachment_id) throw new Error('uploaded document missing attachment id');
  });

  await check('document upload: identical PDF for same tenancy + type dedupes (200, same id)', async () => {
    const fd = new FormData();
    fd.set('tenancy_id', A.tenancyId);
    fd.set('document_type', 'lease');
    fd.set('title', 'Signed Lease (re-upload)');
    fd.set('file', pdfFile());
    const r = await api('POST', `/v1/accounts/${A.accountId}/documents`, {
      token: A.accessToken,
      multipart: fd,
    });
    const body = assertStatus(r, 200, 're-upload document') as { id: string };
    if (body.id !== uploadedDocId) {
      throw new Error(`expected the existing doc ${uploadedDocId}, got ${body.id}`);
    }
  });

  await check('document upload: same bytes as a DIFFERENT type creates a new doc (type-scoped)', async () => {
    const fd = new FormData();
    fd.set('tenancy_id', A.tenancyId);
    fd.set('document_type', 'other');
    fd.set('title', 'Same bytes, different type');
    fd.set('file', pdfFile());
    const r = await api('POST', `/v1/accounts/${A.accountId}/documents`, {
      token: A.accessToken,
      multipart: fd,
    });
    const body = assertStatus(r, 201, 'different-type upload') as { id: string };
    if (body.id === uploadedDocId) throw new Error('must not merge identical bytes across document_type');
  });

  await check('landlord creates bundled lead-paint document from template', async () => {
    const templates = await api('GET', `/v1/accounts/${A.accountId}/document-templates`, { token: A.accessToken });
    const tb = assertStatus(templates, 200, 'templates') as { data: { id: string; content_hash: string }[] };
    const lead = tb.data.find((t) => t.id === 'epa_lead_pamphlet_2020');
    if (!lead) throw new Error('EPA lead template not returned');
    const r = await api('POST', `/v1/accounts/${A.accountId}/documents/from-template`, {
      token: A.accessToken,
      body: { tenancy_id: A.tenancyId, template_id: lead.id },
    });
    const body = assertStatus(r, 201, 'from template') as {
      id: string;
      document_type: string;
      latest_version: { source: string; content_hash: string };
    };
    bundledDocId = body.id;
    if (body.document_type !== 'lead_paint') throw new Error(`wrong type: ${body.document_type}`);
    if (body.latest_version.source !== 'bundled_static') throw new Error('template doc should be static');
    if (body.latest_version.content_hash !== lead.content_hash) throw new Error('template hash mismatch');
  });

  await check('document list paginates (limit + next_cursor, no overlap)', async () => {
    const p1 = await api(
      'GET',
      `/v1/accounts/${A.accountId}/documents?tenancy_id=${A.tenancyId}&limit=2`,
      { token: A.accessToken },
    );
    const b1 = assertStatus(p1, 200, 'docs page 1') as { data: { id: string }[]; next_cursor: string | null };
    if (b1.data.length !== 2) throw new Error(`expected 2 docs on page 1, got ${b1.data.length}`);
    if (!b1.next_cursor) throw new Error('expected a next_cursor when more docs remain');
    const p2 = await api(
      'GET',
      `/v1/accounts/${A.accountId}/documents?tenancy_id=${A.tenancyId}&limit=2&cursor=${encodeURIComponent(b1.next_cursor)}`,
      { token: A.accessToken },
    );
    const b2 = assertStatus(p2, 200, 'docs page 2') as { data: { id: string }[]; next_cursor: string | null };
    const all = [...b1.data, ...b2.data];
    const ids = new Set(all.map((d) => d.id));
    if (ids.size !== all.length) throw new Error('pages overlap');
    if (ids.size < 3) throw new Error(`expected >=3 docs across pages, got ${ids.size}`);
  });

  // 1f: an abandoned in-flight idempotency key is reclaimed once it ages past
  // the request budget so a same-key retry re-executes, instead of wedging on
  // 409 for the multi-day prune TTL. (Placed here because this file already has
  // a service-role `admin` client to seed the in-flight rows.)
  await check('idempotency 1f: stale in-flight key is reclaimed; a fresh one still 409s', async () => {
    const fp = 'a'.repeat(64); // any sha256-shaped fingerprint
    // (a) FRESH in-flight placeholder -> a same-key request is rejected (409).
    const freshKey = `inflight-fresh-${crypto.randomUUID()}`;
    const ins1 = await admin.from('idempotency_keys').insert({
      account_id: A.accountId,
      key: freshKey,
      request_fingerprint: fp,
      completed_at: null,
    });
    if (ins1.error) throw new Error(`seed fresh in-flight failed: ${ins1.error.message}`);
    const r409 = await api('POST', `/v1/accounts/${A.accountId}/properties`, {
      token: A.accessToken,
      idempotencyKey: freshKey,
      body: { name: 'Inflight Fresh' },
    });
    assertStatus(r409, 409, 'fresh in-flight is not reclaimed');

    // (b) STALE in-flight placeholder (older than the ~90s budget) -> reclaimed,
    // so the request re-executes and creates the resource (201).
    const staleKey = `inflight-stale-${crypto.randomUUID()}`;
    const ins2 = await admin.from('idempotency_keys').insert({
      account_id: A.accountId,
      key: staleKey,
      request_fingerprint: fp,
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      completed_at: null,
    });
    if (ins2.error) throw new Error(`seed stale in-flight failed: ${ins2.error.message}`);
    const r201 = await api('POST', `/v1/accounts/${A.accountId}/properties`, {
      token: A.accessToken,
      idempotencyKey: staleKey,
      body: { name: 'Inflight Stale Reclaimed' },
    });
    assertStatus(r201, 201, 'stale in-flight is reclaimed and re-executes');
  });

  await check('tenant magic link lists only published docs for scoped tenancy', async () => {
    const minted = await api('POST', `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/document-links`, {
      token: A.accessToken,
      body: { expires_in_minutes: 120 },
    });
    const mb = assertStatus(minted, 201, 'mint document link') as { id: string; secret: string };
    linkSecret = mb.secret;
    linkId = mb.id;
    const publicList = await api('GET', `/v1/document-access/${linkSecret}`);
    const body = assertStatus(publicList, 200, 'public list') as { documents: { id: string }[] };
    const ids = body.documents.map((d) => d.id);
    if (!ids.includes(uploadedDocId) || !ids.includes(bundledDocId)) {
      throw new Error(`public list missing docs: ${ids.join(',')}`);
    }
  });

  await check('repeated magic-link loads do not multiply viewed events', async () => {
    // One load already happened in the previous check; load twice more. The
    // once-per-(token,document) dedupe must keep the viewed count at one row
    // per published document rather than growing with each refresh.
    for (let i = 0; i < 2; i++) {
      const r = await api('GET', `/v1/document-access/${linkSecret}`);
      assertStatus(r, 200, `repeat list ${i}`);
    }
    const { data } = await admin
      .from('document_access_events')
      .select('id')
      .eq('token_id', linkId)
      .eq('event_type', 'viewed');
    if (!data || data.length !== 2) {
      throw new Error(`expected 2 viewed events after repeated loads, got ${data?.length ?? 0}`);
    }
  });

  await check('tenant download creates downloaded access event', async () => {
    const dl = await api('GET', `/v1/document-access/${linkSecret}/documents/${uploadedDocId}/download`);
    const bytes = assertStatus(dl, 200, 'public download') as Uint8Array;
    if (new TextDecoder().decode(bytes) !== new TextDecoder().decode(PDF_BYTES)) {
      throw new Error('download bytes mismatch');
    }
    const { data } = await admin
      .from('document_access_events')
      .select('id')
      .eq('token_id', linkId)
      .eq('document_id', uploadedDocId)
      .eq('event_type', 'downloaded');
    if (!data || data.length !== 1) throw new Error(`expected one downloaded event, got ${data?.length ?? 0}`);
  });

  await check('tenant acknowledgment is idempotent per token and document', async () => {
    const a1 = await api('POST', `/v1/document-access/${linkSecret}/documents/${uploadedDocId}/acknowledge`);
    assertStatus(a1, 200, 'ack 1');
    const a2 = await api('POST', `/v1/document-access/${linkSecret}/documents/${uploadedDocId}/acknowledge`);
    assertStatus(a2, 200, 'ack 2');
    const { data } = await admin
      .from('document_access_events')
      .select('id')
      .eq('token_id', linkId)
      .eq('document_id', uploadedDocId)
      .eq('event_type', 'acknowledged');
    if (!data || data.length !== 1) throw new Error(`expected one ack event, got ${data?.length ?? 0}`);
  });

  await check('expired and malformed tokens return non-oracle 404', async () => {
    await admin
      .from('document_access_tokens')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('id', linkId);
    const expired = await api('GET', `/v1/document-access/${linkSecret}`);
    assertStatus(expired, 404, 'expired token');
    const malformed = await api('GET', '/v1/document-access/not-a-real-token');
    assertStatus(malformed, 404, 'malformed token');
  });

  await check('cross-account landlord and tenant access are denied', async () => {
    const byB = await api('GET', `/v1/accounts/${B.accountId}/documents/${uploadedDocId}`, { token: B.accessToken });
    assertStatus(byB, 404, 'cross-account landlord get');
    const minted = await api('POST', `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/document-links`, {
      token: A.accessToken,
      body: { expires_in_minutes: 120 },
    });
    const secret = (assertStatus(minted, 201, 'mint second link') as { secret: string }).secret;
    const bDoc = await api('POST', `/v1/accounts/${B.accountId}/documents/from-template`, {
      token: B.accessToken,
      body: { tenancy_id: B.tenancyId, template_id: 'epa_lead_pamphlet_2020' },
    });
    const bDocId = (assertStatus(bDoc, 201, 'B template') as { id: string }).id;
    const crossPublic = await api('GET', `/v1/document-access/${secret}/documents/${bDocId}/download`);
    assertStatus(crossPublic, 404, 'cross-account public download');
  });

  await check('document tables are audited', async () => {
    const { data: docsEvt } = await admin
      .from('events')
      .select('id')
      .eq('account_id', A.accountId)
      .eq('entity_type', 'documents')
      .eq('entity_id', uploadedDocId)
      .eq('event_type', 'inserted')
      .maybeSingle();
    if (!docsEvt) throw new Error('missing document audit event');
    const { data: accessEvt } = await admin
      .from('events')
      .select('id')
      .eq('account_id', A.accountId)
      .eq('entity_type', 'document_access_events')
      .eq('event_type', 'inserted')
      .limit(1);
    if (!accessEvt || accessEvt.length === 0) throw new Error('missing access-event audit rows');
  });

  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`- ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: tenant document vault checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
