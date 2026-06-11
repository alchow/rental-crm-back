import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import {
  mintIntakeToken,
  revokeIntakeToken,
} from '../admin/intake';

// Authenticated routes for managing intake tokens. The mint endpoint
// returns the plaintext SECRET exactly once (in the response body); the
// list endpoint never reveals the secret. The actual public consumption
// endpoint (POST /v1/intake/:token) lives in src/admin/intake.ts.

const IntakeTokenRow = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    property_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    created_at: z.string(),
    revoked_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
    use_count: z.number().int(),
  })
  .openapi('IntakeTokenRow');

const MintedIntakeToken = z
  .object({
    id: z.string().uuid(),
    /** Plaintext secret; shown ONCE. The hash is what's persisted. */
    secret: z.string(),
    account_id: z.string().uuid(),
    property_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    created_at: z.string(),
  })
  .openapi('MintedIntakeToken');

const ListResponse = z
  .object({ data: z.array(IntakeTokenRow) })
  .openapi('IntakeTokenListResponse');

const TenancyParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z.string().uuid().openapi({ param: { name: 'tenancyId', in: 'path' } }),
});
const TokenParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z.string().uuid().openapi({ param: { name: 'tenancyId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/intake-tokens',
  tags: ['intake-tokens'],
  summary: "List a tenancy's intake tokens (current and revoked; never the secret)",
  request: { params: TenancyParam },
  responses: {
    200: { description: 'list', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const mint = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/intake-tokens',
  tags: ['intake-tokens'],
  summary: "Mint a fresh intake token for the tenancy. Returns the secret EXACTLY ONCE.",
  request: { params: TenancyParam },
  responses: {
    201: { description: 'minted', content: { 'application/json': { schema: MintedIntakeToken } } },
    ...errorResponses,
  },
});
const revoke = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/intake-tokens/{id}/revoke',
  tags: ['intake-tokens'],
  summary: 'Revoke an active intake token',
  request: { params: TokenParam },
  responses: {
    200: {
      description: 'revoked',
      content: { 'application/json': { schema: z.object({ id: z.string().uuid(), revoked_at: z.string() }) } },
    },
    ...errorResponses,
  },
});

export const intakeTokensApp = newApiApp();

intakeTokensApp.openapi(list, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('intake_tokens')
    .select('id, account_id, property_id, tenancy_id, created_at, revoked_at, last_used_at, use_count')
    .eq('account_id', accountId)
    .eq('tenancy_id', tenancyId)
    .order('created_at', { ascending: false });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json({ data: (data ?? []) as z.infer<typeof IntakeTokenRow>[] }, 200);
});

intakeTokensApp.openapi(mint, async (c) => {
  // Membership + immediate-parent (the tenancyId belongs to the account)
  // are verified by the v1-level middleware stack BEFORE this handler runs.
  // The admin helper just mints; no extra auth checks needed.
  const { accountId, tenancyId } = c.req.valid('param');
  const minted = await mintIntakeToken(accountId, tenancyId);
  return c.json(minted, 201);
});

intakeTokensApp.openapi(revoke, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const result = await revokeIntakeToken(accountId, id);
  return c.json(result, 200);
});
