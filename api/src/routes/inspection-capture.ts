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
} from '../admin/inspection-capture';

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
