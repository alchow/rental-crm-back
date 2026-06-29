import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { paginated } from './_lib/list-response';
import { buildEvidenceExport } from '../admin/export-pdf';
import { enqueue } from '../admin/job-runner';
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

// Async status machine (Phase 2.1): the row is created queued, a background
// job renders the bundle, and the artifact fields (attachment_id,
// chain_verified, chain_message, the real generated_at) are null/provisional
// until status='done'. Clients poll GET until status is done or failed.
const ExportStatus = z.enum(['queued', 'running', 'done', 'failed']).openapi('EvidenceExportStatus');

const ExportRow = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    status: ExportStatus,
    /** Set when status='failed'; human-readable cause. Retry by POSTing a new export. */
    error: z.string().nullable(),
    tenancy_id: z.string().uuid().nullable(),
    area_id: z.string().uuid().nullable(),
    from_date: z.string().nullable(),
    to_date: z.string().nullable(),
    /** Provisional (row-creation time) until status='done'; then the render timestamp. */
    generated_at: z.string(),
    chain_verified: z.boolean().nullable(),
    chain_message: z.string().nullable(),
    attachment_id: z.string().uuid().nullable(),
    exporter: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('EvidenceExport');

const ListResponse = paginated(ExportRow).openapi('EvidenceExportList');

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

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
  summary:
    'Queue generation of a tamper-evident evidence bundle PDF (async; poll the returned export until status is done)',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: ExportBody } }, required: true },
  },
  responses: {
    202: { description: 'queued', content: { 'application/json': { schema: ExportRow } } },
    ...errorResponses,
  },
});

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/evidence-exports',
  tags: ['evidence-exports'],
  request: { params: AccountParam, query: ListQuery },
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

export const evidenceExportsApp = newApiApp();

evidenceExportsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');

  // The middleware stack already verified membership in :accountId. Pre-
  // validate that the requested tenancy / area actually belong to this
  // account before we waste cycles on PDF rendering. We DO NOT filter
  // deleted_at -- the export specifically must work for ended/soft-deleted
  // tenancies (that's when disputes happen).
  const sb = getSb(c);
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

  // Insert the QUEUED row through the member's own client: RLS applies and
  // the audit event natively records actor='user:<uuid>' (no GUC needed for
  // the request itself; the completion RPC pins the actor for the artifact
  // writes). The row IS the job -- the in-process runner renders the bundle
  // and flips it to done/failed; clients poll GET.
  const { data: row, error: insErr } = await sb
    .from('evidence_exports')
    .insert({
      account_id: accountId,
      tenancy_id: body.tenancy_id ?? null,
      area_id: body.area_id ?? null,
      from_date: body.from_date ?? null,
      to_date: body.to_date ?? null,
      exporter: c.get('auth').userId ?? null,
      status: 'queued',
    })
    .select('*')
    .single();
  if (insErr || !row) {
    throw new ApiError(500, 'database_error', insErr?.message ?? 'could not queue export');
  }

  const exportId = (row as { id: string }).id;
  enqueue(`evidence-export:${exportId}`, () => buildEvidenceExport(exportId));

  return c.json(row as z.infer<typeof ExportRow>, 202);
});

evidenceExportsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getSb(c);
  const q = sb
    .from('evidence_exports')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  // Newest-first, keyset-paginated on generated_at.
  const { items, next_cursor } = await keysetPage<z.infer<typeof ExportRow>>(q, {
    cursor,
    limit,
    column: 'generated_at',
    descending: true,
  });
  return c.json({ data: items, next_cursor }, 200);
});

evidenceExportsApp.openapi(getOne, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
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
  const sb = getSb(c);
  // Look up the attachment_id under RLS so a non-member is filtered out
  // even though the middleware should have already short-circuited.
  const { data, error } = await sb
    .from('evidence_exports')
    .select('attachment_id, status')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'evidence_export not found');
  if (data.status !== 'done' || !data.attachment_id) {
    throw new ApiError(
      409,
      'conflict',
      `export is not ready (status=${data.status}); poll the export until status is done`,
    );
  }
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
