import { createRoute } from '@hono/zod-openapi';
import type { z } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { errorResponses, conflictResponse, ApiError } from '../_lib/error';
import { getSb } from '../../supabase/request-client';
import { asJson } from '../../supabase/db-types';
import { AccountAndTenancyParam } from '../tenancies/schemas';
import { BillingSetupIntent, BillingSetupCommit, BillingSetupPreview, BillingSetupResult } from './schemas';
export const billingSetupApp = newApiApp();
const preview = createRoute({
  method: 'post', path: '/accounts/{accountId}/tenancies/{tenancyId}/billing-setup/preview', tags: ['billing_setup'],
  summary: 'Review authoritative periods and proposed money facts without writing them',
  request: { params: AccountAndTenancyParam, body: { content: { 'application/json': { schema: BillingSetupIntent } }, required: true } },
  responses: { 200: { description: 'review', content: { 'application/json': { schema: BillingSetupPreview } } }, ...errorResponses, ...conflictResponse },
});
const commit = createRoute({
  method: 'post', path: '/accounts/{accountId}/tenancies/{tenancyId}/billing-setup/commit', tags: ['billing_setup'],
  summary: 'Atomically commit reviewed schedules, obligations, receipts, allocations and progress',
  request: { params: AccountAndTenancyParam, body: { content: { 'application/json': { schema: BillingSetupCommit } }, required: true } },
  responses: { 201: { description: 'saved', content: { 'application/json': { schema: BillingSetupResult } } }, ...errorResponses, ...conflictResponse },
});
function rpcError(error: { code?: string; message?: string }): never {
  const message = error.message ?? 'billing operation failed';
  if (error.code === '42501') throw new ApiError(403, 'forbidden', message);
  if (error.code === 'P0002') throw new ApiError(404, 'not_found', message);
  if (message.startsWith('conflict:') || error.code === '23505') throw new ApiError(409, 'billing_context_changed', message);
  if (['22023', '22P02', '23514', '23503', '22007', '22008'].includes(error.code ?? '') || message.startsWith('invalid:')) throw new ApiError(400, 'invalid_request', message);
  throw new ApiError(500, 'database_error', message);
}
billingSetupApp.openapi(preview, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const { data, error } = await getSb(c).rpc('preview_billing_setup', {
    p_account_id: accountId, p_tenancy_id: tenancyId, p_intent: asJson({ ...c.req.valid('json'), operation: 'initial' }),
  });
  if (error) rpcError(error);
  return c.json(data as z.infer<typeof BillingSetupPreview>, 200);
});
billingSetupApp.openapi(commit, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const claim = c.get('idempotencyClaim');
  if (!claim) throw new ApiError(500, 'database_error', 'idempotency claim unavailable');
  const { data, error } = await getSb(c).rpc('commit_billing_setup', {
    p_account_id: accountId, p_tenancy_id: tenancyId, p_intent: asJson({ ...c.req.valid('json'), operation: 'initial' }),
    p_idempotency_key: claim.key, p_request_fingerprint: claim.fingerprint,
  });
  if (error) rpcError(error);
  c.set('idempotencyCompletedAtomically', true);
  return c.json(data as z.infer<typeof BillingSetupResult>, 201);
});
const transitionPreview = createRoute({
  method: 'post', path: '/accounts/{accountId}/tenancies/{tenancyId}/billing-transition/preview', tags: ['billing_setup'],
  summary: 'Review a complete successor billing instruction and the advance charges it supersedes',
  request: { params: AccountAndTenancyParam, body: { content: { 'application/json': { schema: BillingSetupIntent } }, required: true } },
  responses: { 200: { description: 'review', content: { 'application/json': { schema: BillingSetupPreview } } }, ...errorResponses, ...conflictResponse },
});
const transitionCommit = createRoute({
  method: 'post', path: '/accounts/{accountId}/tenancies/{tenancyId}/billing-transition/commit', tags: ['billing_setup'],
  summary: 'Atomically end predecessor billing eras and record the fully confirmed successor',
  request: { params: AccountAndTenancyParam, body: { content: { 'application/json': { schema: BillingSetupCommit } }, required: true } },
  responses: { 201: { description: 'saved', content: { 'application/json': { schema: BillingSetupResult } } }, ...errorResponses, ...conflictResponse },
});
billingSetupApp.openapi(transitionPreview, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const { data, error } = await getSb(c).rpc('preview_billing_setup', {
    p_account_id: accountId, p_tenancy_id: tenancyId, p_intent: asJson({ ...c.req.valid('json'), operation: 'transition' }),
  });
  if (error) rpcError(error);
  return c.json(data as z.infer<typeof BillingSetupPreview>, 200);
});
billingSetupApp.openapi(transitionCommit, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const claim = c.get('idempotencyClaim');
  if (!claim) throw new ApiError(500, 'database_error', 'idempotency claim unavailable');
  const { data, error } = await getSb(c).rpc('commit_billing_setup', {
    p_account_id: accountId, p_tenancy_id: tenancyId, p_intent: asJson({ ...c.req.valid('json'), operation: 'transition' }),
    p_idempotency_key: claim.key, p_request_fingerprint: claim.fingerprint,
  });
  if (error) rpcError(error);
  c.set('idempotencyCompletedAtomically', true);
  return c.json(data as z.infer<typeof BillingSetupResult>, 201);
});
