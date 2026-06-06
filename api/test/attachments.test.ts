// ----------------------------------------------------------------------------
// Phase 8 attachments + inspections DoD tests.
//
// Covers:
//   * Landlord upload: server-side hash matches the bytes; storage path is
//     account-scoped; cross-account read is denied.
//   * Download proxy: forces Content-Disposition: attachment and a safe
//     Content-Type, regardless of what the upload claimed.
//   * Intake attachment: storage path uses the TOKEN'S account_id, never
//     submitter input; a forged maintenance_request_id from another
//     tenancy is rejected.
//   * Inspection completion: PDF is rendered deterministically (same input
//     -> same content hash) and stored as an attachment whose own content
//     hash is server-computed.
//   * Completed inspections are immutable -- PATCH on inspection rejected,
//     item INSERT rejected.
// ----------------------------------------------------------------------------

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
const { _resetIntakeIpBucketsForTests } = await import('../src/admin/intake');
const { buildApp } = await import('../src/app');

const app = buildApp();
_resetIntakeIpBucketsForTests();

// --- helpers ----------------------------------------------------------------

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
    // The browser/Node will set the boundary content-type; don't set it.
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  // For binary responses we don't parse as JSON.
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('application/json') || ctype === '') {
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, body: buf, headers: responseHeaders };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface UserFixture {
  userId: string;
  accessToken: string;
  accountId: string;
  propertyId: string;
  unitAreaId: string;
  tenancyId: string;
  maintenanceRequestId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `att-${label}-${rnd()}@example.test`;
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
  const userId = b.user.id;
  const accessToken = b.session.access_token;
  const accountId = b.account.id;
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: accessToken, body });
    if (r.status !== 201) throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(
    `/v1/accounts/${accountId}/properties`,
    { name: `${label} prop` },
  );
  const unitArea = await post<{ id: string }>(
    `/v1/accounts/${accountId}/areas`,
    { property_id: property.id, kind: 'unit', name: `${label} unit` },
  );
  const tenancy = await post<{ id: string }>(
    `/v1/accounts/${accountId}/tenancies`,
    { area_id: unitArea.id, start_date: '2026-01-01', status: 'active' },
  );
  const req = await post<{ id: string }>(
    `/v1/accounts/${accountId}/maintenance-requests`,
    { area_id: unitArea.id, title: 'leak', severity: 'routine' },
  );
  return {
    userId, accessToken, accountId,
    propertyId: property.id,
    unitAreaId: unitArea.id,
    tenancyId: tenancy.id,
    maintenanceRequestId: req.id,
  };
}

// Smallest valid PNG: 1x1 transparent pixel. Bytes are deterministic so we
// can hash + cross-check.
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63600100000005000156a04fe50000000049454e44ae426082',
  'hex',
);

function pngFile(): File {
  return new File([new Uint8Array(PNG_1X1)], 'test.png', { type: 'image/png' });
}

async function uploadAttachment(
  user: UserFixture,
  entity: { type: string; id: string },
  bytes: Uint8Array,
  mime: string,
): Promise<{ id: string; content_hash: string }> {
  const fd = new FormData();
  fd.set('entity_type', entity.type);
  fd.set('entity_id', entity.id);
  fd.set('file', new File([bytes], 'test.png', { type: mime }));
  const r = await api('POST', `/v1/accounts/${user.accountId}/attachments`, {
    token: user.accessToken, multipart: fd,
  });
  if (r.status !== 201) throw new Error(`upload failed: ${r.status} ${JSON.stringify(r.body)}`);
  const body = r.body as { id: string; content_hash: string };
  return body;
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

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Phase 8 attachments + inspections DoD checks');

  const A = await setupUser('A');
  const B = await setupUser('B');

  // -----------------------------------------------------------------------
  // (1) Server-side hash: the response's content_hash equals sha256 of the
  // bytes WE sent, not anything the client claimed.
  // -----------------------------------------------------------------------
  let attachmentA = '';
  await check('upload: server-computed content_hash matches sha256(bytes)', async () => {
    const expected = createHash('sha256').update(PNG_1X1).digest('hex');
    const up = await uploadAttachment(A, { type: 'maintenance_requests', id: A.maintenanceRequestId }, new Uint8Array(PNG_1X1), 'image/png');
    if (up.content_hash !== expected) {
      throw new Error(`hash mismatch: got ${up.content_hash}, expected ${expected}`);
    }
    attachmentA = up.id;
  });

  // -----------------------------------------------------------------------
  // (2) Cross-account read denied. A's attachment ID cannot be fetched by B.
  // -----------------------------------------------------------------------
  await check("download: A's attachment is 404 when B asks for it", async () => {
    const r = await api(
      'GET',
      `/v1/accounts/${B.accountId}/attachments/${attachmentA}/download`,
      { token: B.accessToken },
    );
    if (r.status !== 404) {
      throw new Error(`expected 404, got ${r.status} body=${JSON.stringify(r.body)}`);
    }
  });

  // Even via the metadata endpoint -- B cannot GET A's attachment row.
  await check("metadata: B cannot GET A's attachment row", async () => {
    const r = await api(
      'GET',
      `/v1/accounts/${B.accountId}/attachments/${attachmentA}`,
      { token: B.accessToken },
    );
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  // -----------------------------------------------------------------------
  // (3) Download proxy enforces Content-Disposition: attachment + safe
  // Content-Type + nosniff + CSP. No inline rendering possible.
  // -----------------------------------------------------------------------
  await check('download: forces Content-Disposition: attachment + nosniff + CSP', async () => {
    const r = await api(
      'GET',
      `/v1/accounts/${A.accountId}/attachments/${attachmentA}/download`,
      { token: A.accessToken },
    );
    assertStatus(r, 200, 'download');
    const cd = r.headers['content-disposition'] ?? '';
    if (!cd.toLowerCase().startsWith('attachment')) {
      throw new Error(`Content-Disposition not attachment: ${cd}`);
    }
    if (r.headers['x-content-type-options'] !== 'nosniff') {
      throw new Error(`missing X-Content-Type-Options: nosniff`);
    }
    if (!(r.headers['content-security-policy'] ?? '').includes("default-src 'none'")) {
      throw new Error(`CSP missing default-src 'none': ${r.headers['content-security-policy']}`);
    }
    const got = createHash('sha256').update(r.body as Uint8Array).digest('hex');
    const expected = createHash('sha256').update(PNG_1X1).digest('hex');
    if (got !== expected) throw new Error(`download bytes hash mismatch`);
  });

  // -----------------------------------------------------------------------
  // (4) Cross-account upload attempt: A POSTs an upload with B's
  // maintenance_request_id under A's URL. RLS-scoped lookup misses, so the
  // route 404s before any bytes are written.
  // -----------------------------------------------------------------------
  await check("upload: A POST with B's maintenance_request_id under A's URL -> 404", async () => {
    const fd = new FormData();
    fd.set('entity_type', 'maintenance_requests');
    fd.set('entity_id', B.maintenanceRequestId);
    fd.set('file', pngFile());
    const r = await api('POST', `/v1/accounts/${A.accountId}/attachments`, {
      token: A.accessToken, multipart: fd,
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status} body=${JSON.stringify(r.body)}`);
  });

  // -----------------------------------------------------------------------
  // (5) Intake attachment: lands in TOKEN'S account path. Forged
  // maintenance_request_id from B's account is rejected.
  // -----------------------------------------------------------------------
  let mintedToken = '';
  let intakeRequestId = '';
  await check('intake: mint token + submit; capture maintenance_request_id', async () => {
    const m = await api(
      'POST',
      `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/intake-tokens`,
      { token: A.accessToken },
    );
    const minted = assertStatus(m, 201, 'mint') as { id: string; secret: string };
    mintedToken = minted.secret;

    const sub = await api('POST', `/v1/intake/${mintedToken}`, {
      body: {
        area_id: A.unitAreaId,
        title: 'attachment-test',
        severity: 'routine',
      },
    });
    const subBody = assertStatus(sub, 201, 'submit intake') as { maintenance_request_id: string };
    intakeRequestId = subBody.maintenance_request_id;
  });

  await check("intake attachment: lands at TOKEN'S account path", async () => {
    const fd = new FormData();
    fd.set('maintenance_request_id', intakeRequestId);
    fd.set('file', pngFile());
    const r = await api('POST', `/v1/intake/${mintedToken}/attachments`, {
      multipart: fd,
    });
    const body = assertStatus(r, 201, 'intake attachment') as {
      attachment_id: string;
      content_hash: string;
      size_bytes: number;
    };
    if (body.content_hash !== createHash('sha256').update(PNG_1X1).digest('hex')) {
      throw new Error(`server-side hash mismatch on intake attachment`);
    }
    // The attachment row's account_id MUST be A's account, never derived
    // from anywhere else. We read it back via the admin client.
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data } = await admin.from('attachments').select('account_id, storage_path').eq('id', body.attachment_id).single();
    if (!data) throw new Error(`attachment row not found`);
    if (data.account_id !== A.accountId) {
      throw new Error(`attachment landed in wrong account: ${data.account_id}`);
    }
    if (!String(data.storage_path).startsWith(`${A.accountId}/`)) {
      throw new Error(`storage_path doesn't start with token's account: ${data.storage_path}`);
    }
  });

  await check("intake attachment: forged maintenance_request_id (B's) is rejected", async () => {
    const fd = new FormData();
    fd.set('maintenance_request_id', B.maintenanceRequestId);
    fd.set('file', pngFile());
    const r = await api('POST', `/v1/intake/${mintedToken}/attachments`, {
      multipart: fd,
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  // -----------------------------------------------------------------------
  // (6) Inspection completion: PDF is byte-deterministic, stored as an
  // attachment with its own content hash.
  // -----------------------------------------------------------------------
  let inspectionId = '';
  await check('inspection: create + add items + a photo, then complete', async () => {
    const insp = await api(
      'POST',
      `/v1/accounts/${A.accountId}/inspections`,
      { token: A.accessToken, body: { area_id: A.unitAreaId, performed_at: '2026-04-01T10:00:00Z', notes: 'test' } },
    );
    const inspBody = assertStatus(insp, 201, 'create inspection') as { id: string };
    inspectionId = inspBody.id;
    // One item.
    const item = await api(
      'POST',
      `/v1/accounts/${A.accountId}/inspections/${inspectionId}/items`,
      { token: A.accessToken, body: { label: 'Kitchen faucet', condition: 'ok' } },
    );
    assertStatus(item, 201, 'create item');
    // One photo attachment on the inspection.
    const fd = new FormData();
    fd.set('entity_type', 'inspections');
    fd.set('entity_id', inspectionId);
    fd.set('file', pngFile());
    const photo = await api('POST', `/v1/accounts/${A.accountId}/attachments`, {
      token: A.accessToken, multipart: fd,
    });
    assertStatus(photo, 201, 'inspection photo upload');
    // Complete.
    const done = await api(
      'POST',
      `/v1/accounts/${A.accountId}/inspections/${inspectionId}/complete`,
      { token: A.accessToken },
    );
    const doneBody = assertStatus(done, 200, 'complete inspection') as {
      inspection: { completed_at: string };
      report: { attachment_id: string; content_hash: string; size_bytes: number };
    };
    if (!doneBody.inspection.completed_at) throw new Error('completed_at not set');
    if (!/^[a-f0-9]{64}$/.test(doneBody.report.content_hash)) {
      throw new Error(`report content_hash not a sha256 hex: ${doneBody.report.content_hash}`);
    }
    if (doneBody.report.size_bytes <= 0) throw new Error('report size_bytes non-positive');
  });

  // The PDF should be downloadable like any other attachment.
  let reportContentHash = '';
  await check('inspection report: download exposes the PDF with content-hash header', async () => {
    // Find the inspection_report attachment.
    const list = await api(
      'GET',
      `/v1/accounts/${A.accountId}/attachments?entity_type=inspection_report&entity_id=${inspectionId}`,
      { token: A.accessToken },
    );
    const lb = assertStatus(list, 200, 'list inspection_report') as { data: Array<{ id: string; content_hash: string }> };
    if (lb.data.length !== 1) throw new Error(`expected 1 report, got ${lb.data.length}`);
    reportContentHash = lb.data[0]!.content_hash;
    const dl = await api(
      'GET',
      `/v1/accounts/${A.accountId}/attachments/${lb.data[0]!.id}/download`,
      { token: A.accessToken },
    );
    assertStatus(dl, 200, 'download report');
    if (dl.headers['content-type'] !== 'application/pdf') {
      throw new Error(`expected content-type application/pdf, got ${dl.headers['content-type']}`);
    }
    const got = createHash('sha256').update(dl.body as Uint8Array).digest('hex');
    if (got !== reportContentHash) {
      throw new Error(`downloaded PDF hash != stored content_hash`);
    }
    if (dl.headers['x-content-sha256'] !== reportContentHash) {
      throw new Error(`X-Content-Sha256 header didn't match the stored hash`);
    }
  });

  // -----------------------------------------------------------------------
  // (7) PDF determinism: render the same inspection twice -> same hash.
  // We do this by directly importing the helper -- a second /complete call
  // would 404 because the inspection is already completed.
  // -----------------------------------------------------------------------
  await check('inspection PDF: same inputs -> byte-identical PDF (deterministic)', async () => {
    const { generateAndStoreInspectionReport } = await import('../src/admin/pdf');
    const r1 = await generateAndStoreInspectionReport({
      accountId: A.accountId, inspectionId,
    });
    const r2 = await generateAndStoreInspectionReport({
      accountId: A.accountId, inspectionId,
    });
    if (r1.content_hash !== r2.content_hash) {
      throw new Error(
        `non-deterministic PDF: hashes differ ${r1.content_hash} vs ${r2.content_hash}`,
      );
    }
    if (r1.content_hash !== reportContentHash) {
      throw new Error(
        `re-rendered PDF differs from the original complete() PDF: ${r1.content_hash} vs ${reportContentHash}`,
      );
    }
  });

  // -----------------------------------------------------------------------
  // (8) Completed inspection: PATCH rejected. Item INSERT rejected.
  // -----------------------------------------------------------------------
  await check('completed inspection: PATCH rejected with 409', async () => {
    const r = await api(
      'PATCH',
      `/v1/accounts/${A.accountId}/inspections/${inspectionId}`,
      { token: A.accessToken, body: { notes: 'late edit' } },
    );
    if (r.status !== 409) {
      throw new Error(`expected 409 conflict, got ${r.status} body=${JSON.stringify(r.body)}`);
    }
  });

  await check('completed inspection: item INSERT rejected with 409', async () => {
    const r = await api(
      'POST',
      `/v1/accounts/${A.accountId}/inspections/${inspectionId}/items`,
      { token: A.accessToken, body: { label: 'late item' } },
    );
    if (r.status !== 409) {
      throw new Error(`expected 409 conflict, got ${r.status} body=${JSON.stringify(r.body)}`);
    }
  });

  // -----------------------------------------------------------------------
  // (9) Disallowed content-type rejected at upload (HTML, application/x-...).
  // -----------------------------------------------------------------------
  await check('upload: disallowed content-type (text/html) rejected', async () => {
    const fd = new FormData();
    fd.set('entity_type', 'maintenance_requests');
    fd.set('entity_id', A.maintenanceRequestId);
    fd.set('file', new File([new Uint8Array([60, 33, 100, 111, 99])], 'evil.html', { type: 'text/html' }));
    const r = await api('POST', `/v1/accounts/${A.accountId}/attachments`, {
      token: A.accessToken, multipart: fd,
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  // --- summary ---
  if (failures.length > 0) {
    console.error(`\n${failures.length} Phase 8 failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: attachments + inspections DoD checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
