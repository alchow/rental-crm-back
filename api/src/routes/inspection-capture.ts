import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { ApiError, errorResponses } from './_lib/error';
import {
  bumpCaptureIpRate,
  lookupCaptureToken,
  loadCaptureForm,
  requestCaptureRenewal,
  tenantUpdateItem,
  tenantUpsertChecks,
  tenantSubmit,
  tenantAttachItemPhoto,
  tenantUpsertItems,
  tenantMarkFormOpened,
  tenantConfirmRoom,
  lookupCaptureAttachment,
} from '../admin/inspection-capture';
import {
  processAndStoreBytes,
  downloadAttachment,
  ALLOWED_MIME_TYPES,
  MAX_BYTES,
} from '../admin/storage';

// ============================================================================
// PUBLIC tenant capture magic-link endpoints.
// ============================================================================
//
// Mounted OUTSIDE the /v1/accounts auth+idempotency stack (no JWT; the verified
// token IS the auth, and account/inspection scope come from the token row, not
// the URL). Writes go through the SECURITY DEFINER tenant_* RPCs via the
// service-role client, which stamp the audit actor as tenant:<token>.

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  return null;
}

async function guard(c: Parameters<typeof clientIp>[0]): Promise<void> {
  const ip = clientIp(c);
  if (!ip) return;
  const { ok } = await bumpCaptureIpRate(ip);
  if (!ok) throw new ApiError(429, 'conflict', 'rate limit exceeded; try again later');
}

const rateLimitedResponse = {
  429: {
    description: 'rate limited',
    content: { 'application/json': { schema: errorResponses[400].content['application/json'].schema } },
  },
} as const;

const SecretParam = z.object({
  secret: z.string().min(8).max(200).openapi({ param: { name: 'secret', in: 'path' } }),
});
const SecretItemParam = SecretParam.extend({
  itemId: z.string().uuid().openapi({ param: { name: 'itemId', in: 'path' } }),
});

const CaptureForm = z
  .object({
    token: z.object({ id: z.string().uuid(), expires_at: z.string() }),
    inspection: z.record(z.unknown()),
    items: z.array(z.record(z.unknown())),
    checks: z.array(z.record(z.unknown())),
    // null entry = the ungrouped ("General") bucket has been confirmed.
    confirmed_rooms: z.array(z.string().nullable()),
  })
  .openapi('TenantCaptureForm');

const PatchItemBody = z
  .object({
    condition: z.string().max(200).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  })
  .openapi('CaptureItemPatchBody');

const UpsertChecksBody = z
  .object({
    checks: z
      .array(
        z.object({
          field_key: z.string().min(1).max(200),
          label: z.string().min(1).max(200).optional(),
          group_label: z.string().min(1).max(200).optional(),
          value: z.unknown().optional(),
          sort_order: z.number().int().optional(),
        }),
      )
      .min(1)
      .max(1000),
  })
  .openapi('CaptureChecksUpsertBody');

const RenewalBody = z.object({ secret: z.string().min(8).max(200) }).openapi('CaptureRenewalBody');

const RoomConfirmBody = z
  .object({
    // Omit or send null to confirm the ungrouped ("General") bucket -- items
    // whose server group_label is null. Do NOT send the literal "General".
    group_label: z.string().min(1).max(200).nullish(),
  })
  .openapi('CaptureRoomConfirmBody');
const RoomConfirmResponse = z.object({ confirmed: z.boolean() }).openapi('CaptureRoomConfirmResponse');

const ItemResponse = z.object({ item: z.record(z.unknown()) }).openapi('CaptureItemResponse');
const CheckListResponse = z.object({ data: z.array(z.record(z.unknown())) }).openapi('CaptureCheckList');
const SubmitResponse = z.object({ inspection: z.record(z.unknown()) }).openapi('CaptureSubmitResponse');
const AcceptedResponse = z.object({ status: z.string() }).openapi('CaptureAccepted');

export const inspectionCaptureApp = newApiApp();

// --- GET form ---------------------------------------------------------------
const getFormRoute = createRoute({
  method: 'get',
  path: '/inspection-capture/{secret}',
  tags: ['inspection-capture'],
  summary: 'Load the condition form to fill via a tenant magic link',
  request: { params: SecretParam },
  responses: {
    200: { description: 'form', content: { 'application/json': { schema: CaptureForm } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
inspectionCaptureApp.openapi(getFormRoute, async (c) => {
  await guard(c);
  const { secret } = c.req.valid('param');
  const token = await lookupCaptureToken(secret);
  // Stamp form_opened_at on the FIRST load (set-once, GET-only) -- this is what
  // distinguishes "opened" from "used" (the write paths also verify the token).
  await tenantMarkFormOpened(token);
  const payload = await loadCaptureForm(token);
  return c.json(payload as z.infer<typeof CaptureForm>, 200);
});

// --- PATCH an item ----------------------------------------------------------
const patchItemRoute = createRoute({
  method: 'patch',
  path: '/inspection-capture/{secret}/items/{itemId}',
  tags: ['inspection-capture'],
  summary: 'Tenant updates an item condition/notes',
  request: {
    params: SecretItemParam,
    body: { content: { 'application/json': { schema: PatchItemBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: ItemResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
inspectionCaptureApp.openapi(patchItemRoute, async (c) => {
  await guard(c);
  const { secret, itemId } = c.req.valid('param');
  const body = c.req.valid('json');
  const token = await lookupCaptureToken(secret);
  const row = await tenantUpdateItem(token, itemId, body.condition ?? null, body.notes ?? null);
  return c.json({ item: row }, 200);
});

// --- POST checks (batch upsert) ---------------------------------------------
const upsertChecksRoute = createRoute({
  method: 'post',
  path: '/inspection-capture/{secret}/checks',
  tags: ['inspection-capture'],
  summary: 'Tenant upserts typed checks',
  request: {
    params: SecretParam,
    body: { content: { 'application/json': { schema: UpsertChecksBody } }, required: true },
  },
  responses: {
    200: { description: 'upserted', content: { 'application/json': { schema: CheckListResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
inspectionCaptureApp.openapi(upsertChecksRoute, async (c) => {
  await guard(c);
  const { secret } = c.req.valid('param');
  const body = c.req.valid('json');
  const token = await lookupCaptureToken(secret);
  const data = await tenantUpsertChecks(token, body.checks);
  return c.json({ data }, 200);
});

// --- POST confirm a room ("everything looks good / finish room") ------------
const confirmRoomRoute = createRoute({
  method: 'post',
  path: '/inspection-capture/{secret}/rooms/confirm',
  tags: ['inspection-capture'],
  summary: 'Tenant marks a section confirmed-good (funnel progress)',
  request: {
    params: SecretParam,
    body: { content: { 'application/json': { schema: RoomConfirmBody } }, required: true },
  },
  responses: {
    200: { description: 'confirmed', content: { 'application/json': { schema: RoomConfirmResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
inspectionCaptureApp.openapi(confirmRoomRoute, async (c) => {
  await guard(c);
  const { secret } = c.req.valid('param');
  const body = c.req.valid('json');
  const token = await lookupCaptureToken(secret);
  await tenantConfirmRoom(token, body.group_label ?? null);
  return c.json({ confirmed: true }, 200);
});

// --- POST submit (tenant attestation) ---------------------------------------
const submitRoute = createRoute({
  method: 'post',
  path: '/inspection-capture/{secret}/submit',
  tags: ['inspection-capture'],
  summary: 'Tenant submits + attests the filled form (draft -> tenant_submitted)',
  request: { params: SecretParam },
  responses: {
    200: { description: 'submitted', content: { 'application/json': { schema: SubmitResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
inspectionCaptureApp.openapi(submitRoute, async (c) => {
  await guard(c);
  const { secret } = c.req.valid('param');
  const token = await lookupCaptureToken(secret);
  const row = await tenantSubmit(token);
  return c.json({ inspection: row }, 200);
});

// --- POST request a fresh link (uniform 202; sends to on-file email only) ----
const renewalRoute = createRoute({
  method: 'post',
  path: '/inspection-capture/request-renewal',
  tags: ['inspection-capture'],
  summary: 'Request a fresh capture link (delivered to the tenant on-file contact)',
  request: { body: { content: { 'application/json': { schema: RenewalBody } }, required: true } },
  responses: {
    202: { description: 'accepted', content: { 'application/json': { schema: AcceptedResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
inspectionCaptureApp.openapi(renewalRoute, async (c) => {
  await guard(c);
  const body = c.req.valid('json');
  // Uniform response regardless of whether the token/contact exists
  // (anti-enumeration). Delivery is to the on-file contact only, never echoed.
  await requestCaptureRenewal({ secret: body.secret });
  return c.json({ status: 'accepted' }, 202);
});

// ============================================================================
// New endpoints: photo upload, attachment download proxy, batch item edit
// ============================================================================

const PhotoUploadBody = z
  .object({ file: z.any().describe('binary photo file (multipart/form-data)') })
  .openapi('CapturePhotoUploadBody');

const PhotoUploadResponse = z
  .object({
    attachment_id: z.string().uuid(),
    derivative_id: z.string().uuid().nullable(),
  })
  .openapi('CapturePhotoUploadResponse');

const BatchItemsBody = z
  .object({
    items: z
      .array(
        z.object({
          item_key: z.string().min(1).max(200),
          condition: z.string().max(200).nullable().optional(),
          notes: z.string().max(5000).nullable().optional(),
        }),
      )
      .min(1)
      .max(1000),
  })
  .openapi('CaptureItemsBatchBody');

const ItemListResponse = z
  .object({ data: z.array(z.record(z.unknown())) })
  .openapi('CaptureItemList');

// --- POST photo for an item ---------------------------------------------------
const uploadPhotoRoute = createRoute({
  method: 'post',
  path: '/inspection-capture/{secret}/items/{itemId}/photos',
  tags: ['inspection-capture'],
  summary: 'Tenant uploads a photo for an inspection item',
  request: {
    params: SecretItemParam,
    body: { content: { 'multipart/form-data': { schema: PhotoUploadBody } }, required: true },
  },
  responses: {
    201: { description: 'uploaded', content: { 'application/json': { schema: PhotoUploadResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
inspectionCaptureApp.openapi(uploadPhotoRoute, async (c) => {
  await guard(c);
  const { secret, itemId } = c.req.valid('param');
  const token = await lookupCaptureToken(secret);

  type BodyVal = string | File | undefined;
  const form = (await c.req.parseBody()) as Record<string, BodyVal>;
  const maybeFile = form.file;
  if (!maybeFile || typeof maybeFile === 'string' || !('arrayBuffer' in maybeFile)) {
    throw new ApiError(400, 'invalid_request', 'file part missing');
  }
  const file = maybeFile as File;
  const mime = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new ApiError(400, 'invalid_request', `unsupported mime_type ${mime}`);
  }
  const size = file.size;
  if (size <= 0 || size > MAX_BYTES) {
    throw new ApiError(400, 'invalid_request', `file size out of range (${size})`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const put = await processAndStoreBytes(token.account_id, bytes, mime);
  const result = await tenantAttachItemPhoto(token, itemId, put);
  return c.json({ attachment_id: result.attachment_id, derivative_id: result.derivative_id }, 201);
});

// --- GET attachment download (binary proxy, NOT openapi) ----------------------
// Mirror of attachments.ts download: forced Content-Disposition, nosniff, CSP,
// no-store, x-content-sha256. Scope is restricted to items in the token's inspection.
inspectionCaptureApp.get('/inspection-capture/:secret/attachments/:attachmentId/download', async (c) => {
  await guard(c);
  const secret = c.req.param('secret') ?? '';
  const attachmentId = c.req.param('attachmentId') ?? '';
  // Validate the id shape up front: this is a plain (non-openapi) route, so a
  // malformed id would otherwise reach Postgres as a 22P02 and leak the raw
  // error in a 500. A non-uuid is simply not found.
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) {
    throw new ApiError(404, 'not_found', 'attachment not found');
  }
  const token = await lookupCaptureToken(secret);
  const hit = await lookupCaptureAttachment(token, attachmentId);
  if (!hit) throw new ApiError(404, 'not_found', 'attachment not found');
  const dl = await downloadAttachment(token.account_id, attachmentId);
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

// --- POST batch item edit -----------------------------------------------------
const batchItemsRoute = createRoute({
  method: 'post',
  path: '/inspection-capture/{secret}/items/batch',
  tags: ['inspection-capture'],
  summary: 'Tenant batch-edits multiple inspection items by item_key (UPDATE-only; unknown keys are ignored)',
  request: {
    params: SecretParam,
    body: { content: { 'application/json': { schema: BatchItemsBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: ItemListResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
inspectionCaptureApp.openapi(batchItemsRoute, async (c) => {
  await guard(c);
  const { secret } = c.req.valid('param');
  const body = c.req.valid('json');
  const token = await lookupCaptureToken(secret);
  const data = await tenantUpsertItems(token, body.items);
  return c.json({ data }, 200);
});
