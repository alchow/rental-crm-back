import { createRoute, z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { newApiApp } from '../_lib/app';
import { getSb } from '../../supabase/request-client';
import { ApiError, errorResponses } from '../_lib/error';
import { keysetPage } from '../_lib/cursor';
import { paginated } from '../_lib/list-response';
import { softDeleteStamp } from '../_lib/soft-delete';
import { MAX_BYTES, renderStoredImageToJpeg, stageDocumentUpload } from '../../admin/storage';
import { renderDocumentImagePdf } from '../../admin/document-image';
import {
  documentTemplates,
  getDocumentTemplate,
  readStaticDocumentAsset,
} from '../../admin/document-templates';
import { loadDocumentForDownload } from '../../admin/document-access';
import {
  AccountParam,
  AccountAndIdParam,
  DocumentType,
  DocumentRow,
  binaryResponse,
} from './shared';
import {
  createTenancyDocument,
  createTenancyDocumentFromImage,
  createTenancyDocumentFromUpload,
  withLatestVersions,
} from './queries';
import { registerDocumentLinkRoutes } from './links';

function boolFromForm(v: string | File | undefined, fallback: boolean): boolean {
  if (typeof v !== 'string') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

const IMAGE_DOCUMENT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

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

const DocumentListResponse = paginated(DocumentRow).openapi('DocumentListResponse');

const DocumentTemplateListResponse = z
  .object({ data: z.array(DocumentTemplate) })
  .openapi('DocumentTemplateListResponse');

const ListQuery = z.object({
  tenancy_id: z.string().uuid().optional(),
  document_type: DocumentType.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const UploadBody = z
  .object({
    tenancy_id: z.string().uuid(),
    document_type: DocumentType,
    title: z.string(),
    requires_ack: z.string().optional(),
    file: z.any().describe('PDF or image document file (JPEG, PNG, WebP, HEIC/HEIF; multipart)'),
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

const listTemplatesRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/document-templates',
  tags: ['documents'],
  summary: 'List bundled document templates/disclosures',
  request: { params: AccountParam },
  responses: {
    200: {
      description: 'templates',
      content: { 'application/json': { schema: DocumentTemplateListResponse } },
    },
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
    200: {
      description: 'documents',
      content: { 'application/json': { schema: DocumentListResponse } },
    },
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
  summary: 'Upload a PDF or phone image document for a tenancy',
  description:
    'PDF uploads are stored directly. Image uploads preserve the exact original bytes and ' +
    'create a linked PDF rendition; document downloads and acknowledgements use the PDF while ' +
    'latest_version.original_* identifies the uploaded evidence.',
  request: {
    params: AccountParam,
    body: { content: { 'multipart/form-data': { schema: UploadBody } }, required: true },
  },
  responses: {
    200: {
      description: 'identical document already filed for this tenancy + type; existing returned',
      content: { 'application/json': { schema: DocumentRow } },
    },
    201: { description: 'created', content: { 'application/json': { schema: DocumentRow } } },
    422: {
      description: 'image bytes could not be converted to PDF',
      content: {
        'application/json': { schema: errorResponses[400].content['application/json'].schema },
      },
    },
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
    200: {
      description: 'identical document already filed for this tenancy + type; existing returned',
      content: { 'application/json': { schema: DocumentRow } },
    },
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
  const { tenancy_id, document_type, cursor, limit } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('documents').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  if (document_type) q = q.eq('document_type', document_type);
  const { items, next_cursor } = await keysetPage<
    Omit<z.infer<typeof DocumentRow>, 'latest_version'>
  >(q, { cursor, limit, descending: true });
  const docs = await withLatestVersions(sb, accountId, items);
  return c.json({ data: docs, next_cursor }, 200);
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
  const [doc] = await withLatestVersions(sb, accountId, [
    data as Omit<z.infer<typeof DocumentRow>, 'latest_version'>,
  ]);
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
  const mimeType = (file as File).type;
  if (mimeType !== 'application/pdf' && !IMAGE_DOCUMENT_MIME_TYPES.has(mimeType)) {
    throw new ApiError(
      400,
      'invalid_request',
      'documents must be PDF, JPEG, PNG, WebP, HEIC, or HEIF',
    );
  }

  const sb = getSb(c);
  const auth = c.get('auth');
  // Reject missing tenancies before staging bytes; the RPC rechecks scope atomically.
  const { data: tenancy, error: tErr } = await sb
    .from('tenancies')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', parsed.data.tenancy_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (tErr) throw new ApiError(500, 'database_error', tErr.message);
  if (!tenancy) throw new ApiError(404, 'not_found', 'tenancy not found');

  // DATA FLOW: Private staged bytes -> receipt -> atomic document RPC.
  // Failed RPCs leave orphans for age-gated cleanup; unique paths isolate upload races.
  const bytes = new Uint8Array(await (file as File).arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    throw new ApiError(400, 'invalid_request', 'document file is empty or exceeds 20 MiB');
  }

  if (mimeType !== 'application/pdf') {
    const originalHash = createHash('sha256').update(bytes).digest('hex');
    const isHeic = mimeType === 'image/heic' || mimeType === 'image/heif';
    // Stage exact HEIC bytes so Storage decodes large phone images outside API memory.
    const stagedHeic = isHeic
      ? await stageDocumentUpload(accountId, auth.userId, bytes, mimeType)
      : null;
    const renderableBytes = stagedHeic
      ? await renderStoredImageToJpeg(stagedHeic.storagePath, bytes)
      : bytes;
    const pdfBytes = await renderDocumentImagePdf(renderableBytes, originalHash);
    const original =
      stagedHeic ?? (await stageDocumentUpload(accountId, auth.userId, bytes, mimeType));
    const pdf = await stageDocumentUpload(
      accountId,
      auth.userId,
      pdfBytes,
      'application/pdf',
      original.receiptId,
    );
    const created = await createTenancyDocumentFromImage(sb, {
      p_account_id: accountId,
      p_tenancy_id: parsed.data.tenancy_id,
      p_document_type: parsed.data.document_type,
      p_title: parsed.data.title,
      p_requires_ack: parsed.data.requires_ack ?? false,
      p_original_receipt_id: original.receiptId,
      p_pdf_receipt_id: pdf.receiptId,
    });
    // Age-gated cleanup preserves retryable uploads and avoids request-time deletes.
    return c.json(created.document, created.deduped ? 200 : 201);
  }

  const stored = await stageDocumentUpload(accountId, auth.userId, bytes, mimeType);
  const created = await createTenancyDocumentFromUpload(sb, {
    p_account_id: accountId,
    p_tenancy_id: parsed.data.tenancy_id,
    p_document_type: parsed.data.document_type,
    p_title: parsed.data.title,
    p_requires_ack: parsed.data.requires_ack ?? false,
    p_upload_receipt_id: stored.receiptId,
  });
  return c.json(created.document, created.deduped ? 200 : 201);
});

documentsApp.openapi(fromTemplateRoute, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const template = getDocumentTemplate(body.template_id);
  if (!template) throw new ApiError(404, 'not_found', 'document template not found');
  const sb = getSb(c);
  const asset = await readStaticDocumentAsset(template.asset_path);
  const { document, deduped } = await createTenancyDocument(sb, {
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
  return c.json(document, deduped ? 200 : 201);
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
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'document not found');
  return c.body(null, 204);
});

registerDocumentLinkRoutes(documentsApp);
