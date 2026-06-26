import { createRoute, z } from '@hono/zod-openapi';
import { randomBytes, createHash } from 'node:crypto';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { processAndStoreBytes } from '../admin/storage';
import {
  documentTemplates,
  getDocumentTemplate,
  readStaticDocumentAsset,
} from '../admin/document-templates';
import {
  bumpDocAccessIpRate,
  insertDocumentAccessEvent,
  loadDocumentForDownload,
  lookupDocumentAccessToken,
  tenantDocumentAccessPayload,
} from '../admin/document-access';

const TOKEN_BYTES = 32;
const DEFAULT_LINK_TTL_MINUTES = 120;
const MAX_LINK_TTL_MINUTES = 7 * 24 * 60;

function generateSecret(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function boolFromForm(v: string | File | undefined, fallback: boolean): boolean {
  if (typeof v !== 'string') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('cf-connecting-ip') ??
    'unknown'
  );
}

// Per-IP rate limit guard for the public, unauthenticated document-access
// endpoints. Throws 429 when over (fail-closed if the limiter infra is down).
async function guardDocAccessRate(c: Parameters<typeof clientIp>[0]): Promise<void> {
  const { ok } = await bumpDocAccessIpRate(clientIp(c));
  if (!ok) throw new ApiError(429, 'conflict', 'rate limit exceeded; try again later');
}

// 429 added to the OpenAPI response map for the public routes (reuses the
// shared error envelope, mirroring the intake endpoint).
const rateLimitedResponse = {
  429: {
    description: 'rate limited',
    content: { 'application/json': { schema: errorResponses[400].content['application/json'].schema } },
  },
} as const;

const DocumentType = z.enum(['lease', 'move_in', 'move_out', 'lead_paint', 'disclosure', 'other']);
const VersionSource = z.enum(['landlord_upload', 'bundled_static']);
const AccessEventType = z.enum(['viewed', 'downloaded', 'acknowledged']);

const DocumentVersion = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    document_id: z.string().uuid(),
    version_no: z.number().int(),
    source: VersionSource,
    attachment_id: z.string().uuid().nullable(),
    static_template_id: z.string().nullable(),
    static_asset_path: z.string().nullable(),
    content_hash: z.string(),
    mime_type: z.string(),
    size_bytes: z.number().int(),
    created_by: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('DocumentVersion');

const DocumentRow = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    document_type: DocumentType,
    title: z.string(),
    requires_ack: z.boolean(),
    published_at: z.string().nullable(),
    created_by: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
    latest_version: DocumentVersion.nullable(),
  })
  .openapi('Document');

const DocumentTemplate = z
  .object({
    id: z.string(),
    document_type: DocumentType,
    title: z.string(),
    requires_ack: z.boolean(),
    source_url: z.string().url(),
    content_hash: z.string(),
    size_bytes: z.number().int(),
    mime_type: z.string(),
  })
  .openapi('DocumentTemplate');

const AccessDocument = z
  .object({
    id: z.string().uuid(),
    document_type: DocumentType,
    title: z.string(),
    requires_ack: z.boolean(),
    published_at: z.string(),
    acknowledged_at: z.string().nullable(),
    latest_version: DocumentVersion,
  })
  .openapi('TenantAccessDocument');

const DocumentListResponse = z
  .object({ data: z.array(DocumentRow) })
  .openapi('DocumentListResponse');

const DocumentTemplateListResponse = z
  .object({ data: z.array(DocumentTemplate) })
  .openapi('DocumentTemplateListResponse');

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});
const AccountAndIdParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});
const TenancyParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z.string().uuid().openapi({ param: { name: 'tenancyId', in: 'path' } }),
});
const AccessParam = z.object({
  token: z.string().min(8).max(200).openapi({ param: { name: 'token', in: 'path' } }),
});
const AccessDocumentParam = AccessParam.extend({
  documentId: z.string().uuid().openapi({ param: { name: 'documentId', in: 'path' } }),
});

const ListQuery = z.object({
  tenancy_id: z.string().uuid().optional(),
  document_type: DocumentType.optional(),
});

const UploadBody = z
  .object({
    tenancy_id: z.string().uuid(),
    document_type: DocumentType,
    title: z.string(),
    requires_ack: z.string().optional(),
    file: z.any().describe('PDF document file (multipart)'),
  })
  .openapi('DocumentUploadBody');

const UploadFields = z.object({
  tenancy_id: z.string().uuid(),
  document_type: DocumentType,
  title: z.string().min(1).max(200),
  requires_ack: z.boolean().optional(),
});

const FromTemplateBody = z
  .object({
    tenancy_id: z.string().uuid(),
    template_id: z.string().min(1).max(100),
    title: z.string().min(1).max(200).optional(),
    requires_ack: z.boolean().optional(),
  })
  .openapi('CreateDocumentFromTemplateBody');

const LinkBody = z
  .object({
    tenant_id: z.string().uuid().optional(),
    expires_in_minutes: z.coerce.number().int().positive().max(MAX_LINK_TTL_MINUTES).default(DEFAULT_LINK_TTL_MINUTES),
  })
  .openapi('CreateDocumentAccessLinkBody');

const MintedDocumentLink = z
  .object({
    id: z.string().uuid(),
    secret: z.string(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    tenant_id: z.string().uuid().nullable(),
    expires_at: z.string(),
    created_at: z.string(),
  })
  .openapi('MintedDocumentAccessLink');

const TenantAccessResponse = z
  .object({
    token: z.object({
      id: z.string().uuid(),
      expires_at: z.string(),
    }),
    tenancy: z.object({
      id: z.string().uuid(),
      area_id: z.string().uuid(),
      unit_name: z.string(),
      property_name: z.string(),
    }),
    documents: z.array(AccessDocument),
  })
  .openapi('TenantDocumentAccessResponse');

const AckResponse = z
  .object({
    document_id: z.string().uuid(),
    acknowledged_at: z.string(),
    event_type: AccessEventType,
  })
  .openapi('DocumentAcknowledgeResponse');

async function latestVersions(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  documentIds: string[],
): Promise<Map<string, z.infer<typeof DocumentVersion>>> {
  const out = new Map<string, z.infer<typeof DocumentVersion>>();
  if (documentIds.length === 0) return out;
  const { data, error } = await sb
    .from('document_versions')
    .select('*')
    .eq('account_id', accountId)
    .in('document_id', documentIds)
    .is('deleted_at', null)
    .order('version_no', { ascending: false });
  if (error) throw new ApiError(500, 'database_error', error.message);
  for (const row of (data ?? []) as z.infer<typeof DocumentVersion>[]) {
    if (!out.has(row.document_id)) out.set(row.document_id, row);
  }
  return out;
}

async function withLatestVersions(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  docs: Array<Omit<z.infer<typeof DocumentRow>, 'latest_version'>>,
): Promise<z.infer<typeof DocumentRow>[]> {
  const versions = await latestVersions(sb, accountId, docs.map((d) => d.id));
  return docs.map((d) => ({ ...d, latest_version: versions.get(d.id) ?? null }));
}

function binaryResponse(bytes: Uint8Array, opts: {
  mimeType: string;
  filename: string;
  contentHash: string;
}): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': opts.mimeType,
      'content-disposition': `attachment; filename="${opts.filename}"`,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-sha256': opts.contentHash,
    },
  });
}

// Atomic create: the documents + document_versions (+ attachment for uploads)
// rows land in one transaction via the create_tenancy_document RPC. Called
// through the RLS client so membership + tenancy scoping are enforced and the
// audit actor is the landlord (auth.uid()). A missing/soft-deleted tenancy
// surfaces as P0002 -> 404.
async function createTenancyDocument(
  sb: ReturnType<typeof getSb>,
  params: {
    p_account_id: string;
    p_tenancy_id: string;
    p_document_type: z.infer<typeof DocumentType>;
    p_title: string;
    p_requires_ack: boolean;
    p_source: z.infer<typeof VersionSource>;
    p_content_hash: string;
    p_mime_type: string;
    p_size_bytes: number;
    p_attachment_path?: string | null;
    p_static_template_id?: string | null;
    p_static_asset_path?: string | null;
  },
): Promise<z.infer<typeof DocumentRow>> {
  const { data, error } = await sb.rpc('create_tenancy_document', params);
  if (error) {
    if (error.code === 'P0002' || /tenancy_not_found/.test(error.message)) {
      throw new ApiError(404, 'not_found', 'tenancy not found');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  const result = data as { document: object; version: object } | null;
  if (!result) throw new ApiError(500, 'database_error', 'document creation returned no row');
  return { ...(result.document as object), latest_version: result.version } as z.infer<typeof DocumentRow>;
}

// ----- authenticated landlord routes ---------------------------------------

const listTemplatesRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/document-templates',
  tags: ['documents'],
  summary: 'List bundled document templates/disclosures',
  request: { params: AccountParam },
  responses: {
    200: { description: 'templates', content: { 'application/json': { schema: DocumentTemplateListResponse } } },
    ...errorResponses,
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/documents',
  tags: ['documents'],
  summary: 'List documents',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'documents', content: { 'application/json': { schema: DocumentListResponse } } },
    ...errorResponses,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/documents/{id}',
  tags: ['documents'],
  summary: 'Get one document',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'document', content: { 'application/json': { schema: DocumentRow } } },
    ...errorResponses,
  },
});

const uploadRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/documents',
  tags: ['documents'],
  summary: 'Upload a PDF document for a tenancy',
  request: {
    params: AccountParam,
    body: { content: { 'multipart/form-data': { schema: UploadBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: DocumentRow } } },
    ...errorResponses,
  },
});

const fromTemplateRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/documents/from-template',
  tags: ['documents'],
  summary: 'Attach a bundled disclosure template to a tenancy',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: FromTemplateBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: DocumentRow } } },
    ...errorResponses,
  },
});

const removeRoute = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/documents/{id}',
  tags: ['documents'],
  summary: 'Soft-delete a document',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

const downloadRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/documents/{id}/download',
  tags: ['documents'],
  summary: 'Download one document PDF',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'document bytes' },
    ...errorResponses,
  },
});

const mintLinkRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/document-links',
  tags: ['documents'],
  summary: 'Mint a short-lived tenant document access link',
  request: {
    params: TenancyParam,
    body: { content: { 'application/json': { schema: LinkBody } }, required: false },
  },
  responses: {
    201: { description: 'minted', content: { 'application/json': { schema: MintedDocumentLink } } },
    ...errorResponses,
  },
});

export const documentsApp = newApiApp();

documentsApp.openapi(listTemplatesRoute, async (c) => {
  const data = await Promise.all(
    documentTemplates().map(async (t) => {
      const asset = await readStaticDocumentAsset(t.asset_path);
      return {
        id: t.id,
        document_type: t.document_type,
        title: t.title,
        requires_ack: t.requires_ack,
        source_url: t.source_url,
        content_hash: asset.content_hash,
        size_bytes: asset.size_bytes,
        mime_type: t.mime_type,
      };
    }),
  );
  return c.json({ data } as z.infer<typeof DocumentTemplateListResponse>, 200);
});

documentsApp.openapi(listRoute, async (c) => {
  const { accountId } = c.req.valid('param');
  const { tenancy_id, document_type } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb
    .from('documents')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  if (document_type) q = q.eq('document_type', document_type);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) throw new ApiError(500, 'database_error', error.message);
  const docs = await withLatestVersions(
    sb,
    accountId,
    (data ?? []) as Array<Omit<z.infer<typeof DocumentRow>, 'latest_version'>>,
  );
  return c.json({ data: docs }, 200);
});

documentsApp.openapi(getRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('documents')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'document not found');
  const [doc] = await withLatestVersions(
    sb,
    accountId,
    [data as Omit<z.infer<typeof DocumentRow>, 'latest_version'>],
  );
  return c.json(doc!, 200);
});

documentsApp.openapi(uploadRoute, async (c) => {
  const { accountId } = c.req.valid('param');
  type BodyVal = string | File | undefined;
  const form = (await c.req.parseBody()) as Record<string, BodyVal>;
  const tenancyId = typeof form.tenancy_id === 'string' ? form.tenancy_id : '';
  const documentType = typeof form.document_type === 'string' ? form.document_type : '';
  const title = typeof form.title === 'string' ? form.title : '';
  const file = form.file;
  const parsed = UploadFields.safeParse({
    tenancy_id: tenancyId,
    document_type: documentType,
    title,
    requires_ack: boolFromForm(form.requires_ack, false),
  });
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', 'request validation failed', parsed.error.flatten());
  }
  if (!file || typeof file === 'string' || !('arrayBuffer' in file)) {
    throw new ApiError(400, 'invalid_request', 'file part missing');
  }
  if ((file as File).type !== 'application/pdf') {
    throw new ApiError(400, 'invalid_request', 'documents must be uploaded as application/pdf');
  }

  const sb = getSb(c);
  // Cheap tenancy pre-check before we spend bytes on storage: avoids an orphan
  // blob on the common "bad tenancy" 404. The RPC re-checks under RLS as the
  // authoritative, transactional guard.
  const { data: tenancy, error: tErr } = await sb
    .from('tenancies')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', parsed.data.tenancy_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) throw new ApiError(500, 'database_error', tErr.message);
  if (!tenancy) throw new ApiError(404, 'not_found', 'tenancy not found');

  // Store the bytes first (service-role; content-addressed). The attachment +
  // document + version ROWS are then written atomically by the RPC. If the RPC
  // fails, the stored object is an orphan a storage-GC cron prunes -- never a
  // half-written document.
  const bytes = new Uint8Array(await (file as File).arrayBuffer());
  const stored = await processAndStoreBytes(accountId, bytes, 'application/pdf');
  const document = await createTenancyDocument(sb, {
    p_account_id: accountId,
    p_tenancy_id: parsed.data.tenancy_id,
    p_document_type: parsed.data.document_type,
    p_title: parsed.data.title,
    p_requires_ack: parsed.data.requires_ack ?? false,
    p_source: 'landlord_upload',
    p_content_hash: stored.primary.hash,
    p_mime_type: stored.primary.mimeType,
    p_size_bytes: stored.primary.sizeBytes,
    p_attachment_path: stored.primary.storagePath,
  });
  return c.json(document, 201);
});

documentsApp.openapi(fromTemplateRoute, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const template = getDocumentTemplate(body.template_id);
  if (!template) throw new ApiError(404, 'not_found', 'document template not found');
  const sb = getSb(c);
  const asset = await readStaticDocumentAsset(template.asset_path);
  const document = await createTenancyDocument(sb, {
    p_account_id: accountId,
    p_tenancy_id: body.tenancy_id,
    p_document_type: template.document_type,
    p_title: body.title ?? template.title,
    p_requires_ack: body.requires_ack ?? template.requires_ack,
    p_source: 'bundled_static',
    p_content_hash: asset.content_hash,
    p_mime_type: template.mime_type,
    p_size_bytes: asset.size_bytes,
    p_static_template_id: template.id,
    p_static_asset_path: template.asset_path,
  });
  return c.json(document, 201);
});

documentsApp.openapi(downloadRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const dl = await loadDocumentForDownload(accountId, id);
  return binaryResponse(dl.bytes, {
    mimeType: dl.mimeType,
    filename: dl.filename,
    contentHash: dl.contentHash,
  });
});

documentsApp.openapi(removeRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('documents')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'document not found');
  return c.body(null, 204);
});

documentsApp.openapi(mintLinkRoute, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const body = c.req.valid('json') ?? { expires_in_minutes: DEFAULT_LINK_TTL_MINUTES };
  const sb = getSb(c);
  const auth = c.get('auth');
  if (body.tenant_id) {
    const { data: member, error: memberErr } = await sb
      .from('tenancy_tenants')
      .select('id')
      .eq('account_id', accountId)
      .eq('tenancy_id', tenancyId)
      .eq('tenant_id', body.tenant_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (memberErr) throw new ApiError(500, 'database_error', memberErr.message);
    if (!member) throw new ApiError(404, 'not_found', 'tenant not found in this tenancy');
  }
  const secret = generateSecret();
  const expiresAt = new Date(Date.now() + body.expires_in_minutes * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('document_access_tokens')
    .insert({
      account_id: accountId,
      tenancy_id: tenancyId,
      tenant_id: body.tenant_id ?? null,
      secret_hash: '\\x' + hashSecret(secret).toString('hex'),
      expires_at: expiresAt,
      created_by: auth.userId,
    })
    .select('id, account_id, tenancy_id, tenant_id, expires_at, created_at')
    .single();
  if (error || !data) throw new ApiError(500, 'database_error', error?.message ?? 'token insert failed');
  return c.json({ ...(data as object), secret } as z.infer<typeof MintedDocumentLink>, 201);
});

// ----- public tenant document access ---------------------------------------

const tenantAccessRoute = createRoute({
  method: 'get',
  path: '/document-access/{token}',
  tags: ['document-access'],
  summary: 'List published tenancy documents via a short-lived magic link',
  request: { params: AccessParam },
  responses: {
    200: { description: 'documents', content: { 'application/json': { schema: TenantAccessResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});

const ackRoute = createRoute({
  method: 'post',
  path: '/document-access/{token}/documents/{documentId}/acknowledge',
  tags: ['document-access'],
  summary: 'Acknowledge a published document via a magic link',
  request: { params: AccessDocumentParam },
  responses: {
    200: { description: 'acknowledged', content: { 'application/json': { schema: AckResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});

const accessDownloadRoute = createRoute({
  method: 'get',
  path: '/document-access/{token}/documents/{documentId}/download',
  tags: ['document-access'],
  summary: 'Download a published document via a magic link',
  request: { params: AccessDocumentParam },
  responses: {
    200: { description: 'document bytes' },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});

export const documentAccessApp = newApiApp();

documentAccessApp.openapi(tenantAccessRoute, async (c) => {
  await guardDocAccessRate(c);
  const { token: rawToken } = c.req.valid('param');
  const payload = await tenantDocumentAccessPayload({
    secret: rawToken,
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
  });
  return c.json(payload as z.infer<typeof TenantAccessResponse>, 200);
});

documentAccessApp.openapi(accessDownloadRoute, async (c) => {
  await guardDocAccessRate(c);
  const { token: rawToken, documentId } = c.req.valid('param');
  const token = await lookupDocumentAccessToken(rawToken);
  const { document, bytes, mimeType, filename, contentHash } = await loadDocumentForDownload(
    token.account_id,
    documentId,
  );
  if (document.tenancy_id !== token.tenancy_id || !document.published_at || new Date(document.published_at).getTime() > Date.now()) {
    throw new ApiError(404, 'not_found', 'document not found');
  }
  await insertDocumentAccessEvent({
    token,
    documentId,
    documentVersionId: document.latest_version?.id ?? null,
    eventType: 'downloaded',
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
  });
  return binaryResponse(bytes, { mimeType, filename, contentHash });
});

documentAccessApp.openapi(ackRoute, async (c) => {
  await guardDocAccessRate(c);
  const { token: rawToken, documentId } = c.req.valid('param');
  const token = await lookupDocumentAccessToken(rawToken);
  const { document } = await loadDocumentForDownload(token.account_id, documentId);
  if (document.tenancy_id !== token.tenancy_id || !document.published_at || new Date(document.published_at).getTime() > Date.now()) {
    throw new ApiError(404, 'not_found', 'document not found');
  }
  const event = await insertDocumentAccessEvent({
    token,
    documentId,
    documentVersionId: document.latest_version?.id ?? null,
    eventType: 'acknowledged',
    ip: clientIp(c),
    userAgent: c.req.header('user-agent') ?? null,
  });
  return c.json({
    document_id: documentId,
    acknowledged_at: event.occurred_at,
    event_type: 'acknowledged',
  } as z.infer<typeof AckResponse>, 200);
});
