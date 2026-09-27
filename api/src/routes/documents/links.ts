import { createRoute, z } from '@hono/zod-openapi';
import { randomBytes, createHash } from 'node:crypto';
import type { newApiApp } from '../_lib/app';
import { getSb } from '../../supabase/request-client';
import { ApiError, errorResponses } from '../_lib/error';

const TOKEN_BYTES = 32;
const DEFAULT_LINK_TTL_MINUTES = 120;
const MAX_LINK_TTL_MINUTES = 7 * 24 * 60;

function generateSecret(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

const TenancyParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'tenancyId', in: 'path' } }),
});

const LinkBody = z
  .object({
    tenant_id: z.string().uuid().optional(),
    expires_in_minutes: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_LINK_TTL_MINUTES)
      .default(DEFAULT_LINK_TTL_MINUTES),
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

export function registerDocumentLinkRoutes(app: ReturnType<typeof newApiApp>): void {
  app.openapi(mintLinkRoute, async (c) => {
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
    if (error || !data)
      throw new ApiError(500, 'database_error', error?.message ?? 'token insert failed');
    return c.json({ ...(data as object), secret } as z.infer<typeof MintedDocumentLink>, 201);
  });
}
