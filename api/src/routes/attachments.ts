import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { paginated } from './_lib/list-response';
import {
  uploadAttachment,
  downloadAttachment,
  softDeleteAttachment,
  ALLOWED_ENTITY_TYPES,
  ALLOWED_MIME_TYPES,
  MAX_BYTES,
} from '../admin/storage';

// ============================================================================
// Attachments: upload, metadata, download (proxied), delete.
// ============================================================================
//
// Reads are PROXIED through the API rather than served via long-lived
// signed URLs. The proxy:
//   * sets Content-Disposition: attachment; filename="..." -- forces a
//     download instead of inline rendering (no stored-XSS via HTML/SVG);
//   * forces a safe Content-Type (the value the API decided at upload time,
//     not anything a client might tamper into the URL);
//   * runs the membership check on every request, so a leaked URL means
//     "leaked to one HTTPS request once," not "permanent file access."
//
// The trade-off (API streams every byte) is worth it for tamper evidence:
// short-lived signed URLs from storage skip the API's response-header
// control unless we negotiate response-content-disposition support across
// providers, which we don't yet need.

const Attachment = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    entity_type: z.string(),
    entity_id: z.string().uuid(),
    storage_path: z.string(),
    content_hash: z.string(),
    mime_type: z.string().nullable(),
    size_bytes: z.number().int().nullable(),
    uploaded_by: z.string().uuid().nullable(),
    // Phase 9: when this row is a server-derived rendering of another
    // attachment (HEIC -> JPEG), derived_from points at the original.
    // Provenance is explicit: the JPEG isn't tenant-supplied bytes.
    derived_from: z.string().uuid().nullable(),
    received_at: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Attachment');

const UploadResponse = z
  .object({
    attachment: Attachment,
    // Set iff the upload was HEIC and the server produced a renderable
    // JPEG derivative; null otherwise. Both rows are already persisted.
    derivative: Attachment.nullable(),
    // true when identical bytes were already attached to this entity and the
    // existing row was returned (HTTP 200) rather than a new one (HTTP 201).
    deduped: z.boolean(),
  })
  .openapi('AttachmentUploadResponse');

const ListResponse = paginated(Attachment).openapi('AttachmentListResponse');

const ENTITY_TABLES = [
  'maintenance_requests',
  'inspections',
  'inspection_items',
  'interactions',
  'document_versions',
  'leases',
  'notices',
] as const;
type EntityTable = (typeof ENTITY_TABLES)[number];
const ENTITY_TABLE_SET = new Set<string>(ENTITY_TABLES);

const AccountParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
});
const AccountAndIdParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const ListQuery = z.object({
  entity_type: z.string().optional(),
  entity_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

// Upload uses multipart/form-data, so we describe it in the OpenAPI spec as
// such. zod-openapi accepts a multipart schema; the runtime parses via
// c.req.parseBody().
const MultipartBody = z
  .object({
    entity_type: z.string().min(1),
    entity_id: z.string().uuid(),
    file: z.any().describe('binary file (multipart)'),
  })
  .openapi('AttachmentUploadBody');

const upload = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/attachments',
  tags: ['attachments'],
  summary: 'Upload an attachment (multipart). Hash + path computed server-side.',
  request: {
    params: AccountParam,
    body: { content: { 'multipart/form-data': { schema: MultipartBody } }, required: true },
  },
  responses: {
    200: {
      description: 'identical bytes already attached to this entity; existing row returned',
      content: { 'application/json': { schema: UploadResponse } },
    },
    201: { description: 'created', content: { 'application/json': { schema: UploadResponse } } },
    ...errorResponses,
  },
});

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/attachments',
  tags: ['attachments'],
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'list', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});

const getMeta = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/attachments/{id}',
  tags: ['attachments'],
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'attachment', content: { 'application/json': { schema: Attachment } } },
    ...errorResponses,
  },
});

// Download deliberately does NOT use createRoute -- the handler returns a
// raw Response with binary bytes and explicit Content-Disposition /
// Content-Type headers. The handler is registered as a plain Hono GET
// below; the OpenAPI doc just won't have a typed schema for the binary
// response, which is the standard treatment for file downloads.

const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/attachments/{id}',
  tags: ['attachments'],
  summary: 'Soft-delete an attachment',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const attachmentsApp = newApiApp();

// ---- upload ------------------------------------------------------------------
attachmentsApp.openapi(upload, async (c) => {
  const { accountId } = c.req.valid('param');

  // Parse multipart. Hono returns a record of fields/files. The file may be
  // a Web File or a Blob depending on the runtime; both expose arrayBuffer.
  type BodyVal = string | File | undefined;
  const form = (await c.req.parseBody()) as Record<string, BodyVal>;
  const entityType = typeof form.entity_type === 'string' ? form.entity_type : '';
  const entityId = typeof form.entity_id === 'string' ? form.entity_id : '';
  const file = form.file;

  if (!entityType || !ALLOWED_ENTITY_TYPES.has(entityType) || !ENTITY_TABLE_SET.has(entityType)) {
    throw new ApiError(400, 'invalid_request', 'entity_type missing or not allowed');
  }
  const entityTable = entityType as EntityTable;
  if (!entityId || !/^[0-9a-f-]{36}$/i.test(entityId)) {
    throw new ApiError(400, 'invalid_request', 'entity_id missing or not a uuid');
  }
  if (!file || typeof file === 'string' || !('arrayBuffer' in file)) {
    throw new ApiError(400, 'invalid_request', 'file part missing');
  }
  const mime = (file as File).type || 'application/octet-stream';
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new ApiError(400, 'invalid_request', `unsupported mime_type ${mime}`);
  }
  const size = (file as File).size;
  if (size <= 0 || size > MAX_BYTES) {
    throw new ApiError(400, 'invalid_request', `file size out of range (${size})`);
  }

  // Verify the entity belongs to this account before we waste bandwidth.
  // The user-client + RLS guarantees we only see rows in the caller's
  // account, so .eq('account_id', accountId).eq('id', entityId) returns a
  // hit only when the user actually owns the target row.
  const sb = getSb(c);
  const { data: hit, error: hitErr } = await sb
    .from(entityTable)
    .select('id')
    .eq('account_id', accountId)
    .eq('id', entityId)
    .is('deleted_at', null)
    .maybeSingle();
  if (hitErr) throw new ApiError(500, 'database_error', hitErr.message);
  if (!hit) throw new ApiError(404, 'not_found', 'target entity not found in this account');

  // Slurp bytes (capped by Hono's request body limit + our MAX_BYTES check
  // above). For Phase 8 this is fine; very large uploads would want
  // streaming, but those aren't in scope.
  const bytes = new Uint8Array(await (file as File).arrayBuffer());
  const result = await uploadAttachment({
    accountId,
    entityType,
    entityId,
    bytes,
    mimeType: mime,
    filename: (file as File).name,
    uploadedBy: c.get('auth').userId,
  });
  return c.json(
    {
      attachment: result.primary as unknown as z.infer<typeof Attachment>,
      derivative: result.derivative as unknown as z.infer<typeof Attachment> | null,
      deduped: result.deduped,
    },
    result.deduped ? 200 : 201,
  );
});

// ---- list / metadata --------------------------------------------------------
attachmentsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { entity_type, entity_id, cursor, limit } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('attachments').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (entity_type) q = q.eq('entity_type', entity_type);
  if (entity_id) q = q.eq('entity_id', entity_id);
  // Oldest-first (ascending), keyset-paginated: an entity's attachments
  // (inspection photos, etc.) can accumulate without bound.
  const { items, next_cursor } = await keysetPage<z.infer<typeof Attachment>>(q, { cursor, limit });
  return c.json({ data: items, next_cursor }, 200);
});

attachmentsApp.openapi(getMeta, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('attachments')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'attachment not found');
  return c.json(data as z.infer<typeof Attachment>, 200);
});

// ---- download (proxy with forced headers) -----------------------------------
// Note: we go AROUND the openapi-typed handler here so we can return a raw
// Response with binary bytes. The route definition above is enough to keep
// the OpenAPI doc honest.
attachmentsApp.get('/accounts/:accountId/attachments/:id/download', async (c) => {
  const accountId = c.req.param('accountId') ?? '';
  const id = c.req.param('id') ?? '';
  // The middleware stack has already enforced auth + account membership;
  // this handler trusts the account scope and delegates to the helper.
  const dl = await downloadAttachment(accountId, id);
  return new Response(dl.bytes, {
    status: 200,
    headers: {
      'content-type': dl.mimeType,
      'content-disposition': `attachment; filename="${dl.filename}"`,
      'content-length': String(dl.bytes.byteLength),
      // Block downstream caches from sharing this URL's response across
      // sessions. Membership is checked per-request.
      'cache-control': 'private, no-store',
      // Make sure browsers obey our Content-Type strictly (no MIME sniffing
      // an SVG-disguised-as-png into stored-XSS).
      'x-content-type-options': 'nosniff',
      // Defence-in-depth: even if a future change leaks a path that serves
      // HTML inline, this CSP refuses to run scripts.
      'content-security-policy': "default-src 'none'; sandbox",
      // Surface the server-computed hash so downstream tooling can verify.
      'x-content-sha256': dl.contentHash,
    },
  });
});

// ---- delete -----------------------------------------------------------------
attachmentsApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  await softDeleteAttachment(accountId, id);
  return c.body(null, 204);
});
