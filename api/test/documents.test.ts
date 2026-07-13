import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

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

interface ApiResp {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

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
  res.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('application/json') || ctype === '') {
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
  }
  return {
    status: res.status,
    body: new Uint8Array(await res.arrayBuffer()),
    headers: responseHeaders,
  };
}

function rnd(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface UserFixture {
  accessToken: string;
  userId: string;
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
  if (su.status !== 200)
    throw new Error(`signup ${label} failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as {
    account: { id: string };
    session: { access_token: string };
    user: { id: string };
  };
  const accessToken = b.session.access_token;
  const accountId = b.account.id;
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: accessToken, body });
    if (r.status !== 201)
      throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
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
  return {
    accessToken,
    userId: b.user.id,
    accountId,
    propertyId: property.id,
    unitAreaId: unitArea.id,
    tenancyId: tenancy.id,
  };
}

const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

function pdfFile(): File {
  return new File([PDF_BYTES], 'lease.pdf', { type: 'application/pdf' });
}

const pngBuffer = await sharp({
  create: {
    width: 80,
    height: 120,
    channels: 3,
    background: { r: 245, g: 240, b: 220 },
  },
})
  .png()
  .toBuffer();
const PNG_BYTES = new Uint8Array(pngBuffer.buffer, pngBuffer.byteOffset, pngBuffer.byteLength);

function pngFile(): File {
  return new File([PNG_BYTES], 'move-in-form.png', { type: 'image/png' });
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
  let uploadedAttachmentId = '';
  let uploadedVersionId = '';
  let imageDocId = '';
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
      latest_version: {
        id: string;
        content_hash: string;
        attachment_id: string;
        original_attachment_id: string;
        original_content_hash: string;
        original_mime_type: string;
      };
    };
    uploadedDocId = body.id;
    uploadedAttachmentId = body.latest_version.attachment_id;
    uploadedVersionId = body.latest_version.id;
    if (body.latest_version.content_hash !== createHash('sha256').update(PDF_BYTES).digest('hex')) {
      throw new Error('uploaded document hash mismatch');
    }
    if (!body.latest_version.attachment_id)
      throw new Error('uploaded document missing attachment id');
    if (body.latest_version.original_attachment_id !== body.latest_version.attachment_id) {
      throw new Error('a direct PDF upload should identify its own attachment as the original');
    }
    if (
      body.latest_version.original_content_hash !== body.latest_version.content_hash ||
      body.latest_version.original_mime_type !== 'application/pdf'
    ) {
      throw new Error(`direct PDF original metadata wrong: ${JSON.stringify(body.latest_version)}`);
    }
  });

  await check(
    'upload receipts and attachment provenance cannot be forged or rewritten',
    async () => {
      const user = createClient(status.API_URL, status.ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${A.accessToken}` } },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const forgedReceipt = await user.from('document_upload_receipts').insert({
        account_id: A.accountId,
        content_hash: 'f'.repeat(64),
        storage_path: `${A.accountId}/${'f'.repeat(64)}.png`,
        mime_type: 'image/png',
        size_bytes: 1,
        uploaded_by: A.userId,
      });
      if (!forgedReceipt.error || forgedReceipt.error.code !== '42501') {
        throw new Error(
          `authenticated receipt insert was not denied: ${forgedReceipt.error?.code}`,
        );
      }

      const forgedDocument = await user.rpc('create_tenancy_document_from_image', {
        p_account_id: A.accountId,
        p_tenancy_id: A.tenancyId,
        p_document_type: 'other',
        p_title: 'Forged evidence',
        p_requires_ack: false,
        p_original_receipt_id: crypto.randomUUID(),
        p_pdf_receipt_id: crypto.randomUUID(),
      });
      if (!forgedDocument.error || forgedDocument.error.code !== 'P0002') {
        throw new Error(`invented receipts were not rejected: ${forgedDocument.error?.code}`);
      }

      const incompleteReceiptId = crypto.randomUUID();
      const incompleteHash = '7'.repeat(64);
      const incompleteReceipt = await admin.from('document_upload_receipts').insert({
        id: incompleteReceiptId,
        account_id: A.accountId,
        content_hash: incompleteHash,
        storage_path: `${A.accountId}/document-uploads/${incompleteReceiptId}/${incompleteHash}.pdf`,
        mime_type: 'application/pdf',
        size_bytes: 1,
        uploaded_by: A.userId,
      });
      if (incompleteReceipt.error) {
        throw new Error(`seed incomplete receipt: ${incompleteReceipt.error.message}`);
      }
      const premature = await user.rpc('create_tenancy_document_from_upload', {
        p_account_id: A.accountId,
        p_tenancy_id: A.tenancyId,
        p_document_type: 'other',
        p_title: 'Missing bytes',
        p_requires_ack: false,
        p_upload_receipt_id: incompleteReceiptId,
      });
      if (!premature.error || premature.error.code !== 'P0002') {
        throw new Error(`incomplete receipt was consumable: ${premature.error?.code}`);
      }

      const directRewrite = await user
        .from('attachments')
        .update({ content_hash: 'e'.repeat(64) })
        .eq('id', uploadedAttachmentId);
      if (!directRewrite.error || directRewrite.error.code !== '42501') {
        throw new Error(
          `authenticated attachment rewrite was not denied: ${directRewrite.error?.code}`,
        );
      }
      const directPathPivot = await user.from('attachments').insert({
        account_id: A.accountId,
        entity_type: 'document_versions',
        entity_id: crypto.randomUUID(),
        storage_path: `${B.accountId}/${'d'.repeat(64)}.pdf`,
        content_hash: 'd'.repeat(64),
        mime_type: 'application/pdf',
        size_bytes: 1,
        uploaded_by: A.userId,
      });
      if (!directPathPivot.error || directPathPivot.error.code !== '42501') {
        throw new Error(`authenticated path pivot was not denied: ${directPathPivot.error?.code}`);
      }
      const directVersionRewrite = await user
        .from('document_versions')
        .update({ content_hash: 'c'.repeat(64) })
        .eq('id', uploadedVersionId);
      if (!directVersionRewrite.error || directVersionRewrite.error.code !== '42501') {
        throw new Error(
          `document version rewrite was not denied: ${directVersionRewrite.error?.code}`,
        );
      }
      const directForgedVersion = await user.from('document_versions').insert({
        account_id: A.accountId,
        document_id: uploadedDocId,
        version_no: 99,
        source: 'bundled_static',
        static_template_id: 'forged',
        static_asset_path: '../../../../etc/passwd',
        content_hash: 'c'.repeat(64),
        mime_type: 'application/pdf',
        size_bytes: 1,
        created_by: A.userId,
      });
      if (!directForgedVersion.error || directForgedVersion.error.code !== '42501') {
        throw new Error(
          `authenticated document version insert was not denied: ${directForgedVersion.error?.code}`,
        );
      }
      const privilegedRewrite = await admin
        .from('attachments')
        .update({ storage_path: `${B.accountId}/${'e'.repeat(64)}.pdf` })
        .eq('id', uploadedAttachmentId);
      if (!privilegedRewrite.error || privilegedRewrite.error.code !== '23514') {
        throw new Error(
          `provenance trigger did not reject path pivot: ${privilegedRewrite.error?.code}`,
        );
      }
      const privilegedVersionRewrite = await admin
        .from('document_versions')
        .update({ attachment_id: crypto.randomUUID() })
        .eq('id', uploadedVersionId);
      if (!privilegedVersionRewrite.error || privilegedVersionRewrite.error.code !== '23514') {
        throw new Error(
          `version provenance trigger did not reject attachment pivot: ${privilegedVersionRewrite.error?.code}`,
        );
      }
    },
  );

  await check('age-gated janitor removes only unreferenced staged document bytes', async () => {
    const orphanBytes = new TextEncoder().encode(`orphan-${rnd()}`);
    const orphanHash = createHash('sha256').update(orphanBytes).digest('hex');
    const orphanReceiptId = crypto.randomUUID();
    const orphanPath = `${A.accountId}/document-uploads/${orphanReceiptId}/${orphanHash}.pdf`;
    const upload = await admin.storage
      .from('attachments')
      .upload(orphanPath, orphanBytes, { contentType: 'application/pdf', upsert: true });
    if (upload.error) throw new Error(`seed orphan storage: ${upload.error.message}`);
    const receipt = await admin
      .from('document_upload_receipts')
      .insert({
        id: orphanReceiptId,
        account_id: A.accountId,
        content_hash: orphanHash,
        storage_path: orphanPath,
        mime_type: 'application/pdf',
        size_bytes: orphanBytes.byteLength,
        uploaded_by: A.userId,
        created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();
    if (receipt.error || !receipt.data)
      throw new Error(`seed orphan receipt: ${receipt.error?.message}`);
    const { pruneDocumentUploadOrphans } = await import('../src/admin/storage');
    const pruned = await pruneDocumentUploadOrphans();
    if (pruned < 1) throw new Error(`expected at least one orphan prune, got ${pruned}`);
    const receiptAfter = await admin
      .from('document_upload_receipts')
      .select('id')
      .eq('id', receipt.data.id)
      .maybeSingle();
    if (receiptAfter.error || receiptAfter.data) throw new Error('orphan receipt was not cleared');
    const download = await admin.storage.from('attachments').download(orphanPath);
    if (!download.error) throw new Error('orphan storage object still downloads');
  });

  await check('janitor removes an aged derived receipt before its parent', async () => {
    const createdAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    const originalId = crypto.randomUUID();
    const pdfId = crypto.randomUUID();
    const originalBytes = new TextEncoder().encode(`orphan-image-${rnd()}`);
    const pdfBytes = new TextEncoder().encode(`%PDF-1.4\norphan-derived-${rnd()}\n%%EOF`);
    const originalHash = createHash('sha256').update(originalBytes).digest('hex');
    const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
    const originalPath = `${A.accountId}/document-uploads/${originalId}/${originalHash}.png`;
    const pdfPath = `${A.accountId}/document-uploads/${pdfId}/${pdfHash}.pdf`;
    for (const [path, bytes, contentType] of [
      [originalPath, originalBytes, 'image/png'],
      [pdfPath, pdfBytes, 'application/pdf'],
    ] as const) {
      const upload = await admin.storage
        .from('attachments')
        .upload(path, bytes, { contentType, upsert: true });
      if (upload.error) throw new Error(`seed paired orphan object: ${upload.error.message}`);
    }
    const original = await admin.from('document_upload_receipts').insert({
      id: originalId,
      account_id: A.accountId,
      content_hash: originalHash,
      storage_path: originalPath,
      mime_type: 'image/png',
      size_bytes: originalBytes.byteLength,
      uploaded_by: A.userId,
      stored_at: createdAt,
      created_at: createdAt,
    });
    if (original.error) throw new Error(`seed parent receipt: ${original.error.message}`);
    const derived = await admin.from('document_upload_receipts').insert({
      id: pdfId,
      account_id: A.accountId,
      content_hash: pdfHash,
      storage_path: pdfPath,
      mime_type: 'application/pdf',
      size_bytes: pdfBytes.byteLength,
      uploaded_by: A.userId,
      derived_from_receipt_id: originalId,
      stored_at: createdAt,
      created_at: createdAt,
    });
    if (derived.error) throw new Error(`seed child receipt: ${derived.error.message}`);

    const { pruneDocumentUploadOrphans } = await import('../src/admin/storage');
    const pruned = await pruneDocumentUploadOrphans();
    if (pruned < 2) throw new Error(`expected paired orphan prune, got ${pruned}`);
    const receiptsAfter = await admin
      .from('document_upload_receipts')
      .select('id')
      .in('id', [originalId, pdfId]);
    if (receiptsAfter.error || (receiptsAfter.data?.length ?? 0) !== 0) {
      throw new Error(`paired receipts survived cleanup: ${receiptsAfter.error?.message}`);
    }
  });

  await check('janitor drains more than one 100-row receipt page per run', async () => {
    const createdAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    const stale = Array.from({ length: 101 }, (_, index) => {
      const id = crypto.randomUUID();
      const hash = createHash('sha256').update(`bulk-orphan-${index}-${rnd()}`).digest('hex');
      return {
        id,
        account_id: A.accountId,
        content_hash: hash,
        storage_path: `${A.accountId}/document-uploads/${id}/${hash}.pdf`,
        mime_type: 'application/pdf',
        size_bytes: 1,
        uploaded_by: A.userId,
        created_at: createdAt,
      };
    });
    const seeded = await admin.from('document_upload_receipts').insert(stale);
    if (seeded.error) throw new Error(`seed paged orphan receipts: ${seeded.error.message}`);
    const { pruneDocumentUploadOrphans } = await import('../src/admin/storage');
    const pruned = await pruneDocumentUploadOrphans();
    if (pruned < stale.length) {
      throw new Error(`janitor stopped after one page: expected ${stale.length}, got ${pruned}`);
    }
    const after = await admin
      .from('document_upload_receipts')
      .select('id', { count: 'exact', head: true })
      .in(
        'id',
        stale.map((row) => row.id),
      );
    if (after.error || after.count !== 0) {
      throw new Error(`paged orphan receipts survived: ${after.error?.message ?? after.count}`);
    }
  });

  await check('deployed PDF RPC stays compatible but cannot attest nonexistent bytes', async () => {
    const legacyBytes = new TextEncoder().encode(`%PDF-1.4\nlegacy-${rnd()}\n%%EOF`);
    const legacyHash = createHash('sha256').update(legacyBytes).digest('hex');
    const legacyPath = `${B.accountId}/${legacyHash}.pdf`;
    const upload = await admin.storage
      .from('attachments')
      .upload(legacyPath, legacyBytes, { contentType: 'application/pdf', upsert: true });
    if (upload.error) throw new Error(`legacy object upload failed: ${upload.error.message}`);
    const user = createClient(status.API_URL, status.ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${B.accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const compatible = await user.rpc('create_tenancy_document', {
      p_account_id: B.accountId,
      p_tenancy_id: B.tenancyId,
      p_document_type: 'other',
      p_title: 'Legacy compatible PDF',
      p_requires_ack: false,
      p_source: 'landlord_upload',
      p_content_hash: legacyHash,
      p_mime_type: 'application/pdf',
      p_size_bytes: legacyBytes.byteLength,
      p_attachment_path: legacyPath,
      p_static_template_id: null,
      p_static_asset_path: null,
    });
    if (compatible.error || !compatible.data) {
      throw new Error(`deployed PDF RPC compatibility failed: ${compatible.error?.message}`);
    }
    const absentHash = '9'.repeat(64);
    const invented = await user.rpc('create_tenancy_document', {
      p_account_id: B.accountId,
      p_tenancy_id: B.tenancyId,
      p_document_type: 'disclosure',
      p_title: 'Invented legacy PDF',
      p_requires_ack: false,
      p_source: 'landlord_upload',
      p_content_hash: absentHash,
      p_mime_type: 'application/pdf',
      p_size_bytes: 1,
      p_attachment_path: `${B.accountId}/${absentHash}.pdf`,
      p_static_template_id: null,
      p_static_asset_path: null,
    });
    if (!invented.error || invented.error.code !== 'P0002') {
      throw new Error(`invented legacy object was not rejected: ${invented.error?.code}`);
    }
    const forgedStatic = await user.rpc('create_tenancy_document', {
      p_account_id: B.accountId,
      p_tenancy_id: B.tenancyId,
      p_document_type: 'lead_paint',
      p_title: 'Forged static asset',
      p_requires_ack: true,
      p_source: 'bundled_static',
      p_content_hash: '8'.repeat(64),
      p_mime_type: 'application/pdf',
      p_size_bytes: 1,
      p_attachment_path: null,
      p_static_template_id: 'epa_lead_pamphlet_2020',
      p_static_asset_path: '../../../../etc/passwd',
    });
    if (!forgedStatic.error || forgedStatic.error.code !== '22023') {
      throw new Error(`forged static tuple was not rejected: ${forgedStatic.error?.code}`);
    }
  });

  await check(
    'document upload: identical PDF for same tenancy + type dedupes (200, same id)',
    async () => {
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
    },
  );

  await check(
    'document upload: same bytes as a DIFFERENT type creates a new doc (type-scoped)',
    async () => {
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
      if (body.id === uploadedDocId)
        throw new Error('must not merge identical bytes across document_type');
    },
  );

  await check('phone image preserves the original and files a linked PDF rendition', async () => {
    const fd = new FormData();
    fd.set('tenancy_id', A.tenancyId);
    fd.set('document_type', 'move_in');
    fd.set('title', 'Move-in form photo');
    fd.set('file', pngFile());
    const response = await api('POST', `/v1/accounts/${A.accountId}/documents`, {
      token: A.accessToken,
      multipart: fd,
    });
    const body = assertStatus(response, 201, 'image document upload') as {
      id: string;
      latest_version: {
        id: string;
        attachment_id: string;
        content_hash: string;
        mime_type: string;
        original_attachment_id: string;
        original_content_hash: string;
        original_mime_type: string;
      };
    };
    imageDocId = body.id;
    const version = body.latest_version;
    if (version.mime_type !== 'application/pdf')
      throw new Error(`version is not PDF: ${version.mime_type}`);
    if (version.original_mime_type !== 'image/png') {
      throw new Error(`original mime lost: ${version.original_mime_type}`);
    }
    const expectedOriginalHash = createHash('sha256').update(PNG_BYTES).digest('hex');
    if (version.original_content_hash !== expectedOriginalHash) {
      throw new Error('original image hash mismatch');
    }
    if (version.original_attachment_id === version.attachment_id) {
      throw new Error('image original and PDF rendition must be distinct attachments');
    }

    const attachments = await admin
      .from('attachments')
      .select('id, entity_id, storage_path, content_hash, mime_type, derived_from')
      .eq('account_id', A.accountId)
      .eq('entity_type', 'document_versions')
      .eq('entity_id', version.id)
      .is('deleted_at', null);
    if (attachments.error || attachments.data?.length !== 2) {
      throw new Error(`expected original + PDF attachment rows: ${attachments.error?.message}`);
    }
    const original = attachments.data.find((row) => row.id === version.original_attachment_id);
    const pdf = attachments.data.find((row) => row.id === version.attachment_id);
    if (!original || original.derived_from !== null || original.mime_type !== 'image/png') {
      throw new Error(`original attachment wrong: ${JSON.stringify(original)}`);
    }
    if (!pdf || pdf.derived_from !== original.id || pdf.mime_type !== 'application/pdf') {
      throw new Error(`PDF provenance link wrong: ${JSON.stringify(pdf)}`);
    }
    if (pdf.content_hash !== version.content_hash)
      throw new Error('version hash is not the PDF hash');

    const receiptRows = await admin
      .from('document_upload_receipts')
      .select('id, storage_path, derived_from_receipt_id')
      .in('storage_path', [original.storage_path, pdf.storage_path]);
    if (receiptRows.error || receiptRows.data?.length !== 2) {
      throw new Error(`missing upload receipt pair: ${receiptRows.error?.message}`);
    }
    const originalReceipt = receiptRows.data.find(
      (row) => row.storage_path === original.storage_path,
    );
    const pdfReceipt = receiptRows.data.find((row) => row.storage_path === pdf.storage_path);
    if (
      !originalReceipt ||
      !pdfReceipt ||
      pdfReceipt.derived_from_receipt_id !== originalReceipt.id
    ) {
      throw new Error('PDF receipt is not server-bound to its source image receipt');
    }
    const directAttachment = await admin
      .from('attachments')
      .select('storage_path')
      .eq('id', uploadedAttachmentId)
      .single();
    if (directAttachment.error || !directAttachment.data) {
      throw new Error(`direct PDF attachment missing: ${directAttachment.error?.message}`);
    }
    const standaloneReceipt = await admin
      .from('document_upload_receipts')
      .select('id')
      .eq('storage_path', directAttachment.data.storage_path)
      .single();
    if (standaloneReceipt.error || !standaloneReceipt.data) {
      throw new Error(`standalone PDF receipt missing: ${standaloneReceipt.error?.message}`);
    }
    const user = createClient(status.API_URL, status.ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${A.accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const mixedReceipts = await user.rpc('create_tenancy_document_from_image', {
      p_account_id: A.accountId,
      p_tenancy_id: A.tenancyId,
      p_document_type: 'other',
      p_title: 'False derivation pair',
      p_requires_ack: false,
      p_original_receipt_id: originalReceipt.id,
      p_pdf_receipt_id: standaloneReceipt.data.id,
    });
    if (!mixedReceipts.error || mixedReceipts.error.code !== '22023') {
      throw new Error(`unrelated receipt pair was not rejected: ${mixedReceipts.error?.code}`);
    }

    const download = await api('GET', `/v1/accounts/${A.accountId}/documents/${body.id}/download`, {
      token: A.accessToken,
    });
    const downloaded = assertStatus(download, 200, 'image-derived PDF download') as Uint8Array;
    if (!new TextDecoder().decode(downloaded.slice(0, 5)).startsWith('%PDF-')) {
      throw new Error('image document download is not a PDF');
    }
    const pdfText = Buffer.from(downloaded).toString('latin1');
    if (!/\/ID\s*\[\s*<([0-9a-f]{32})>\s*<\1>\s*\]/i.test(pdfText)) {
      throw new Error('image PDF has a malformed or nondeterministic trailer ID');
    }

    const retry = new FormData();
    retry.set('tenancy_id', A.tenancyId);
    retry.set('document_type', 'move_in');
    retry.set('title', 'Move-in form retry');
    retry.set('file', pngFile());
    const duplicate = await api('POST', `/v1/accounts/${A.accountId}/documents`, {
      token: A.accessToken,
      multipart: retry,
    });
    const duplicateBody = assertStatus(duplicate, 200, 'image document retry') as { id: string };
    if (duplicateBody.id !== imageDocId) throw new Error('identical image did not dedupe');
    const afterRetry = await admin
      .from('attachments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', A.accountId)
      .eq('entity_type', 'document_versions')
      .eq('entity_id', version.id)
      .is('deleted_at', null);
    if (afterRetry.error || afterRetry.count !== 2) {
      throw new Error(`retry multiplied evidence rows: ${afterRetry.count}`);
    }
  });

  await check('invalid image bytes return 422 before any document row is filed', async () => {
    const fd = new FormData();
    fd.set('tenancy_id', A.tenancyId);
    fd.set('document_type', 'move_out');
    fd.set('title', 'Broken image');
    fd.set(
      'file',
      new File([new TextEncoder().encode('not an image')], 'broken.png', { type: 'image/png' }),
    );
    const response = await api('POST', `/v1/accounts/${A.accountId}/documents`, {
      token: A.accessToken,
      multipart: fd,
    });
    assertStatus(response, 422, 'invalid image');
  });

  await check('landlord creates bundled lead-paint document from template', async () => {
    const templates = await api('GET', `/v1/accounts/${A.accountId}/document-templates`, {
      token: A.accessToken,
    });
    const tb = assertStatus(templates, 200, 'templates') as {
      data: { id: string; content_hash: string }[];
    };
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
    if (body.latest_version.source !== 'bundled_static')
      throw new Error('template doc should be static');
    if (body.latest_version.content_hash !== lead.content_hash)
      throw new Error('template hash mismatch');
  });

  await check('document list paginates (limit + next_cursor, no overlap)', async () => {
    const p1 = await api(
      'GET',
      `/v1/accounts/${A.accountId}/documents?tenancy_id=${A.tenancyId}&limit=2`,
      { token: A.accessToken },
    );
    const b1 = assertStatus(p1, 200, 'docs page 1') as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    if (b1.data.length !== 2) throw new Error(`expected 2 docs on page 1, got ${b1.data.length}`);
    if (!b1.next_cursor) throw new Error('expected a next_cursor when more docs remain');
    const p2 = await api(
      'GET',
      `/v1/accounts/${A.accountId}/documents?tenancy_id=${A.tenancyId}&limit=2&cursor=${encodeURIComponent(b1.next_cursor)}`,
      { token: A.accessToken },
    );
    const b2 = assertStatus(p2, 200, 'docs page 2') as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    const all = [...b1.data, ...b2.data];
    const ids = new Set(all.map((d) => d.id));
    if (ids.size !== all.length) throw new Error('pages overlap');
    if (ids.size < 3) throw new Error(`expected >=3 docs across pages, got ${ids.size}`);
  });

  // 1f: an abandoned in-flight idempotency key is reclaimed once it ages past
  // the request budget so a same-key retry re-executes, instead of wedging on
  // 409 for the multi-day prune TTL. (Placed here because this file already has
  // a service-role `admin` client to seed the in-flight rows.)
  await check(
    'idempotency 1f: stale in-flight key is reclaimed; a fresh one still 409s',
    async () => {
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
    },
  );

  await check('tenant magic link lists only published docs for scoped tenancy', async () => {
    const minted = await api(
      'POST',
      `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/document-links`,
      {
        token: A.accessToken,
        body: { expires_in_minutes: 120 },
      },
    );
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
    // per published document rather than growing with each refresh. This
    // This tenancy has four published docs (including the image-derived PDF),
    // so the deduped total is 4 -- not 4x loads.
    for (let i = 0; i < 2; i++) {
      const r = await api('GET', `/v1/document-access/${linkSecret}`);
      assertStatus(r, 200, `repeat list ${i}`);
    }
    const { data } = await admin
      .from('document_access_events')
      .select('id')
      .eq('token_id', linkId)
      .eq('event_type', 'viewed');
    if (!data || data.length !== 4) {
      throw new Error(`expected 4 viewed events after repeated loads, got ${data?.length ?? 0}`);
    }
  });

  await check('tenant download creates downloaded access event', async () => {
    const dl = await api(
      'GET',
      `/v1/document-access/${linkSecret}/documents/${uploadedDocId}/download`,
    );
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
    if (!data || data.length !== 1)
      throw new Error(`expected one downloaded event, got ${data?.length ?? 0}`);
  });

  await check('tenant acknowledgment is idempotent per token and document', async () => {
    const a1 = await api(
      'POST',
      `/v1/document-access/${linkSecret}/documents/${uploadedDocId}/acknowledge`,
    );
    assertStatus(a1, 200, 'ack 1');
    const a2 = await api(
      'POST',
      `/v1/document-access/${linkSecret}/documents/${uploadedDocId}/acknowledge`,
    );
    assertStatus(a2, 200, 'ack 2');
    const { data } = await admin
      .from('document_access_events')
      .select('id')
      .eq('token_id', linkId)
      .eq('document_id', uploadedDocId)
      .eq('event_type', 'acknowledged');
    if (!data || data.length !== 1)
      throw new Error(`expected one ack event, got ${data?.length ?? 0}`);
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
    const byB = await api('GET', `/v1/accounts/${B.accountId}/documents/${uploadedDocId}`, {
      token: B.accessToken,
    });
    assertStatus(byB, 404, 'cross-account landlord get');
    const minted = await api(
      'POST',
      `/v1/accounts/${A.accountId}/tenancies/${A.tenancyId}/document-links`,
      {
        token: A.accessToken,
        body: { expires_in_minutes: 120 },
      },
    );
    const secret = (assertStatus(minted, 201, 'mint second link') as { secret: string }).secret;
    const bDoc = await api('POST', `/v1/accounts/${B.accountId}/documents/from-template`, {
      token: B.accessToken,
      body: {
        tenancy_id: B.tenancyId,
        template_id: 'epa_lead_pamphlet_2020',
        title: 'Lead pamphlet — custom label',
        requires_ack: false,
      },
    });
    const bTemplate = assertStatus(bDoc, 201, 'B template with presentation overrides') as {
      id: string;
      title: string;
      requires_ack: boolean;
    };
    if (bTemplate.title !== 'Lead pamphlet — custom label' || bTemplate.requires_ack !== false) {
      throw new Error('bundled template presentation overrides were not preserved');
    }
    const bDocId = bTemplate.id;
    const crossPublic = await api(
      'GET',
      `/v1/document-access/${secret}/documents/${bDocId}/download`,
    );
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
