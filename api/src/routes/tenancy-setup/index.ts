import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { getSb } from '../../supabase/request-client';
import { asJson } from '../../supabase/db-types';
import { ApiError, errorResponses, conflictResponse } from '../_lib/error';
import { dateRpc } from '../tenancies/rpc';
import { requireManager } from '../_lib/guards';
import { stageDocumentUpload, MAX_BYTES, renderStoredImageToJpeg } from '../../admin/storage';
import { renderDocumentImagePdf } from '../../admin/document-image';
import { createHash } from 'node:crypto';
import {
  SetupParam,
  SetupAccount,
  Session,
  SaveSession,
  SetupInput,
  SetupReview,
  SetupResult,
  SetupDocument,
  RentDefaults,
} from './schemas';

export const tenancySetupApp = newApiApp();
const responses = { ...errorResponses, ...conflictResponse };
const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancy-setup-sessions',
  tags: ['tenancy_setup'],
  request: {
    params: SetupAccount,
    query: z.object({
      area_id: z.string().uuid().optional(),
      tenancy_id: z.string().uuid().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Resumable setup drafts',
      content: { 'application/json': { schema: z.array(Session) } },
    },
    ...responses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancy-setup-sessions/{id}',
  tags: ['tenancy_setup'],
  request: { params: SetupParam },
  responses: {
    200: {
      description: 'Setup draft or its recorded completion',
      content: { 'application/json': { schema: Session } },
    },
    ...responses,
  },
});
const save = createRoute({
  method: 'put',
  path: '/accounts/{accountId}/tenancy-setup-sessions/{id}',
  tags: ['tenancy_setup'],
  request: {
    params: SetupParam,
    body: { required: true, content: { 'application/json': { schema: SaveSession } } },
  },
  responses: {
    200: { description: 'Saved draft', content: { 'application/json': { schema: Session } } },
    ...responses,
  },
});
const preview = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancy-setup-sessions/{id}/preview',
  tags: ['tenancy_setup'],
  request: {
    params: SetupParam,
    body: { required: true, content: { 'application/json': { schema: SetupInput } } },
  },
  responses: {
    200: {
      description: 'Read-only proposed records and findings',
      content: { 'application/json': { schema: SetupReview } },
    },
    ...responses,
  },
});
const commit = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancy-setup-sessions/{id}/commit',
  tags: ['tenancy_setup'],
  request: {
    params: SetupParam,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z
            .object({
              setup: SetupInput,
              expected_context: z.string().min(1),
              accept_warnings: z.literal(true),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Setup committed atomically',
      content: { 'application/json': { schema: SetupResult } },
    },
    ...responses,
  },
});
const upload = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancy-setup-sessions/{id}/document',
  tags: ['tenancy_setup'],
  request: {
    params: SetupParam,
    body: {
      required: true,
      content: { 'multipart/form-data': { schema: z.object({ file: z.any() }) } },
    },
  },
  responses: {
    201: {
      description: 'Private staged lease upload',
      content: { 'application/json': { schema: SetupDocument } },
    },
    ...responses,
  },
});
const defaults = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/rent-defaults',
  tags: ['tenancy_setup'],
  request: { params: SetupAccount },
  responses: {
    200: {
      description: 'Suggestions only, not agreed terms',
      content: { 'application/json': { schema: RentDefaults } },
    },
    ...responses,
  },
});

tenancySetupApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const q = c.req.valid('query');
  let query = getSb(c)
    .from('tenancy_setup_sessions')
    .select('*')
    .eq('account_id', accountId)
    .is('completed_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('updated_at', { ascending: false })
    .limit(100);
  if (q.area_id) query = query.eq('area_id', q.area_id);
  if (q.tenancy_id) query = query.eq('tenancy_id', q.tenancy_id);
  const { data, error } = await query;
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json((data ?? []) as z.infer<typeof Session>[], 200);
});
tenancySetupApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { data, error } = await getSb(c)
    .from('tenancy_setup_sessions')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'Setup session not found');
  return c.json(data as z.infer<typeof Session>, 200);
});
tenancySetupApp.openapi(save, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  return c.json(
    await dateRpc<z.infer<typeof Session>>(c, 'save_tenancy_setup_session', {
      p_account_id: accountId,
      p_id: id,
      p_area_id: body.area_id,
      p_tenancy_id: body.tenancy_id,
      p_revision: body.expected_revision,
      p_payload: asJson(body.payload),
    }),
    200,
  );
});
tenancySetupApp.openapi(preview, async (c) => {
  const { accountId, id } = c.req.valid('param');
  return c.json(
    await dateRpc<z.infer<typeof SetupReview>>(c, 'preview_tenancy_setup_session', {
      p_account_id: accountId,
      p_id: id,
      p_setup: asJson(c.req.valid('json')),
    }),
    200,
  );
});
tenancySetupApp.openapi(commit, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const claim = c.get('idempotencyClaim');
  if (!claim) throw new ApiError(500, 'database_error', 'Idempotency claim unavailable');
  const result = await dateRpc<z.infer<typeof SetupResult>>(c, 'commit_tenancy_setup_session', {
    p_account_id: accountId,
    p_id: id,
    p_setup: asJson(body.setup),
    p_expected_context: body.expected_context,
    p_accept_warnings: true,
    p_idempotency_key: claim.key,
    p_request_fingerprint: claim.fingerprint,
  });
  c.set('idempotencyCompletedAtomically', true);
  return c.json(result, 201);
});
tenancySetupApp.openapi(defaults, async (c) => {
  const { accountId } = c.req.valid('param');
  const { data, error } = await getSb(c)
    .from('account_rent_defaults')
    .select('grace_days,late_fee_policy')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json(
    (data ?? { grace_days: null, late_fee_policy: { kind: 'unknown' } }) as z.infer<
      typeof RentDefaults
    >,
    200,
  );
});
tenancySetupApp.openapi(upload, async (c) => {
  requireManager(c);
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const auth = c.get('auth');
  const { data: session, error } = await sb
    .from('tenancy_setup_sessions')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('completed_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error || !session) throw new ApiError(404, 'not_found', 'Setup draft not found');
  const form = await c.req.parseBody();
  const file = form.file;
  if (!file || typeof file === 'string' || !('arrayBuffer' in file))
    throw new ApiError(400, 'invalid_request', 'Choose a lease PDF or photo');
  const mime =
    file.type ||
    (
      {
        pdf: 'application/pdf',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        heic: 'image/heic',
        heif: 'image/heif',
      } as Record<string, string>
    )[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ||
    '';
  if (
    ![
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
    ].includes(mime)
  )
    throw new ApiError(400, 'invalid_request', 'Choose a lease PDF or photo');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES)
    throw new ApiError(400, 'invalid_request', 'Lease must be between 1 byte and 20 MiB');
  const original = await stageDocumentUpload(accountId, auth.userId, bytes, mime);
  let pdf = original;
  if (mime !== 'application/pdf') {
    const image = /^image\/hei[cf]$/.test(mime)
      ? await renderStoredImageToJpeg(original.storagePath, bytes)
      : bytes;
    pdf = await stageDocumentUpload(
      accountId,
      auth.userId,
      await renderDocumentImagePdf(image, createHash('sha256').update(bytes).digest('hex')),
      'application/pdf',
      original.receiptId,
    );
  }
  const receiptIds = [...new Set([original.receiptId, pdf.receiptId])];
  const { data: bound, error: bindError } = await sb
    .from('document_upload_receipts')
    .update({ setup_session_id: id })
    .eq('account_id', accountId)
    .in('id', receiptIds)
    .select('id');
  if (bindError) throw new ApiError(500, 'database_error', bindError.message);
  if (bound?.length !== receiptIds.length)
    throw new ApiError(
      409,
      'conflict',
      'Upload could not be bound to this setup; retry the upload',
    );
  return c.json(
    {
      receipt_id: pdf.receiptId,
      ...(mime !== 'application/pdf' ? { original_receipt_id: original.receiptId } : {}),
      name: file.name,
    },
    201,
  );
});
