import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { ApiError, errorResponses } from '../_lib/error';
import {
  bumpDocAccessIpRate,
  insertDocumentAccessEvent,
  loadDocumentForDownload,
  lookupDocumentAccessToken,
  tenantDocumentAccessPayload,
} from '../../admin/document-access';
import { DocumentType, DocumentVersion, binaryResponse } from './shared';

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
  // Missing IPs must not share a limiter bucket; empty headers fall through.
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  return null;
}

// Skip the soft IP cap when no address is available; token verification still applies.
async function guardDocAccessRate(c: Parameters<typeof clientIp>[0]): Promise<void> {
  const ip = clientIp(c);
  if (!ip) return;
  const { ok } = await bumpDocAccessIpRate(ip);
  if (!ok) throw new ApiError(429, 'conflict', 'rate limit exceeded; try again later');
}

const rateLimitedResponse = {
  429: {
    description: 'rate limited',
    content: {
      'application/json': { schema: errorResponses[400].content['application/json'].schema },
    },
  },
} as const;

const AccessEventType = z.enum(['viewed', 'downloaded', 'acknowledged']);

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

const AccessParam = z.object({
  token: z
    .string()
    .min(8)
    .max(200)
    .openapi({ param: { name: 'token', in: 'path' } }),
});
const AccessDocumentParam = AccessParam.extend({
  documentId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'documentId', in: 'path' } }),
});

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

const tenantAccessRoute = createRoute({
  method: 'get',
  path: '/document-access/{token}',
  tags: ['document-access'],
  summary: 'List published tenancy documents via a short-lived magic link',
  request: { params: AccessParam },
  responses: {
    200: {
      description: 'documents',
      content: { 'application/json': { schema: TenantAccessResponse } },
    },
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
    ip: clientIp(c) ?? 'unknown',
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
  if (
    document.tenancy_id !== token.tenancy_id ||
    !document.published_at ||
    new Date(document.published_at).getTime() > Date.now()
  ) {
    throw new ApiError(404, 'not_found', 'document not found');
  }
  await insertDocumentAccessEvent({
    token,
    documentId,
    documentVersionId: document.latest_version?.id ?? null,
    eventType: 'downloaded',
    ip: clientIp(c) ?? 'unknown',
    userAgent: c.req.header('user-agent') ?? null,
  });
  return binaryResponse(bytes, { mimeType, filename, contentHash });
});

documentAccessApp.openapi(ackRoute, async (c) => {
  await guardDocAccessRate(c);
  const { token: rawToken, documentId } = c.req.valid('param');
  const token = await lookupDocumentAccessToken(rawToken);
  const { document } = await loadDocumentForDownload(token.account_id, documentId);
  if (
    document.tenancy_id !== token.tenancy_id ||
    !document.published_at ||
    new Date(document.published_at).getTime() > Date.now()
  ) {
    throw new ApiError(404, 'not_found', 'document not found');
  }
  const event = await insertDocumentAccessEvent({
    token,
    documentId,
    documentVersionId: document.latest_version?.id ?? null,
    eventType: 'acknowledged',
    ip: clientIp(c) ?? 'unknown',
    userAgent: c.req.header('user-agent') ?? null,
  });
  return c.json(
    {
      document_id: documentId,
      acknowledged_at: event.occurred_at,
      event_type: 'acknowledged',
    } as z.infer<typeof AckResponse>,
    200,
  );
});
