import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getUserClient } from '../supabase/user-client';
import { ApiError, errorResponses } from './_lib/error';
import { buildEvidenceExport } from '../admin/export-pdf';
import { downloadAttachment } from '../admin/storage';

// ============================================================================
// Evidence exports
// ============================================================================
//
// POST /v1/accounts/{accountId}/evidence-exports
//   Body: { tenancy_id?, area_id?, from_date?, to_date? }
//   Returns: { id, attachment_id, content_hash, size_bytes, generated_at,
//              chain_verified, chain_message }
//
// GET  /v1/accounts/{accountId}/evidence-exports
// GET  /v1/accounts/{accountId}/evidence-exports/{id}
// GET  /v1/accounts/{accountId}/evidence-exports/{id}/download
//
// Builder lives in api/src/admin/export-pdf.ts because it uses the admin
// (service-role) client to read across tables -- the export touches
// soft-deleted tenancies and the events table, both of which we want a
// uniform reader for. The route handler is responsible for verifying the
// caller is a member of the account; the middleware stack mounted in
// app.ts already does that for /v1/accounts/:accountId/*.

const ExportBody = z
  .object({
    tenancy_id: z.string().uuid().optional(),
    area_id: z.string().uuid().optional(),
    from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine(
    (v) => v.tenancy_id !== undefined || v.area_id !== undefined,
    { message: 'must include tenancy_id and/or area_id (blank-scope exports rejected)' },
  )
  .openapi('EvidenceExportRequest');

const ExportResponse = z
  .object({
    id: z.string().uuid(),
    attachment_id: z.string().uuid(),
    content_hash: z.string(),
    size_bytes: z.number().int(),
    generated_at: z.string(),
    chain_verified: z.boolean(),
    chain_message: z.string(),
  })
  .openapi('EvidenceExportResponse');

const ExportRow = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid().nullable(),
    area_id: z.string().uuid().nullable(),
    from_date: z.string().nullable(),
    to_date: z.string().nullable(),
    generated_at: z.string(),
    chain_verified: z.boolean(),
    chain_message: z.string(),
    attachment_id: z.string().uuid(),
    exporter: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('EvidenceExport');

const ListResponse = z.object({ data: z.array(ExportRow) }).openapi('EvidenceExportList');

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});
const AccountAndIdParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/evidence-exports',
  tags: ['evidence-exports'],
  summary: 'Generate a tamper-evident evidence bundle PDF',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: ExportBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: ExportResponse } } },
    ...errorResponses,
  },
});

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/evidence-exports',
  tags: ['evidence-exports'],
  request: { params: AccountParam },
  responses: {
    200: { description: 'list', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});

const getOne = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/evidence-exports/{id}',
  tags: ['evidence-exports'],
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'export', content: { 'application/json': { schema: ExportRow } } },
    ...errorResponses,
  },
});

export const evidenceExportsApp = new OpenAPIHono();

evidenceExportsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');

  // The middleware stack already verified membership in :accountId. Pre-
  // validate that the requested tenancy / area actually belong to this
  // account before we waste cycles on PDF rendering. We DO NOT filter
  // deleted_at -- the export specifically must work for ended/soft-deleted
  // tenancies (that's when disputes happen).
  const sb = getUserClient(c.get('auth').accessToken);
  if (body.tenancy_id) {
    const t = await sb
      .from('tenancies')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', body.tenancy_id)
      .maybeSingle();
    if (t.error) throw new ApiError(500, 'database_error', t.error.message);
    if (!t.data) throw new ApiError(404, 'not_found', 'tenancy not found in this account');
  }
  if (body.area_id) {
    const a = await sb
      .from('areas')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', body.area_id)
      .maybeSingle();
    if (a.error) throw new ApiError(500, 'database_error', a.error.message);
    if (!a.data) throw new ApiError(404, 'not_found', 'area not found in this account');
  }

  const result = await buildEvidenceExport({
    accountId,
    tenancyId: body.tenancy_id ?? null,
    areaId: body.area_id ?? null,
    fromDate: body.from_date ?? null,
    toDate: body.to_date ?? null,
    exporter: c.get('auth').userId ?? null,
  });

  return c.json(
    {
      id: result.evidence_export_id,
      attachment_id: result.attachment_id,
      content_hash: result.content_hash,
      size_bytes: result.size_bytes,
      generated_at: result.generated_at,
      chain_verified: result.chain_verified,
      chain_message: result.chain_message,
    },
    201,
  );
});

evidenceExportsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('evidence_exports')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('generated_at', { ascending: false });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json({ data: (data ?? []) as z.infer<typeof ExportRow>[] }, 200);
});

evidenceExportsApp.openapi(getOne, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('evidence_exports')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'evidence_export not found');
  return c.json(data as z.infer<typeof ExportRow>, 200);
});

// Download proxy. Same hardened headers as the generic attachments
// download (Content-Disposition: attachment, nosniff, CSP, no-store, the
// X-Content-Sha256 echo). Membership already enforced by middleware.
evidenceExportsApp.get('/accounts/:accountId/evidence-exports/:id/download', async (c) => {
  const accountId = c.req.param('accountId') ?? '';
  const id = c.req.param('id') ?? '';
  const sb = getUserClient(c.get('auth').accessToken);
  // Look up the attachment_id under RLS so a non-member is filtered out
  // even though the middleware should have already short-circuited.
  const { data, error } = await sb
    .from('evidence_exports')
    .select('attachment_id')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'evidence_export not found');
  const dl = await downloadAttachment(accountId, data.attachment_id as string);
  return new Response(dl.bytes, {
    status: 200,
    headers: {
      'content-type': dl.mimeType,
      'content-disposition': `attachment; filename="${dl.filename}"`,
      'content-length': String(dl.bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-sha256': dl.contentHash,
    },
  });
});
