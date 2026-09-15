import { createRoute } from '@hono/zod-openapi';
import type { z } from '@hono/zod-openapi';
import { asDbFunctionArgs, asJson } from '../../supabase/db-types';
import { getSb } from '../../supabase/request-client';
import { newApiApp } from '../_lib/app';
import { keysetPage } from '../_lib/cursor';
import {
  ApiError,
  ErrorEnvelope,
  conflictResponse,
  errorResponses,
  mapPrefixedRpcError,
} from '../_lib/error';
import {
  AccountTenancyParams,
  AdjustmentParams,
  CommitRentAdjustmentBody,
  RentAdjustmentInput,
  RentAdjustmentList,
  RentAdjustmentListQuery,
  RentAdjustmentPreview,
  RentAdjustmentReceipt,
  RentAdjustmentRecovery,
  RequestKeyParams,
} from './schemas';

const adjustmentErrors = {
  ...errorResponses,
  ...conflictResponse,
  422: {
    description: 'adjustment_not_supported: the requested correction cannot be planned safely',
    content: { 'application/json': { schema: ErrorEnvelope } },
  },
} as const;

const previewRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/rent-adjustments/preview',
  tags: ['rent-adjustments'],
  summary: 'Preview a lease correction or rent change',
  description:
    'Read-only. Returns canonical financial effects and an opaque token for atomic commit.',
  request: {
    params: AccountTenancyParams,
    body: { required: true, content: { 'application/json': { schema: RentAdjustmentInput } } },
  },
  responses: {
    200: {
      description: 'preview',
      content: { 'application/json': { schema: RentAdjustmentPreview } },
    },
    ...adjustmentErrors,
  },
});

const commitRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/rent-adjustments',
  tags: ['rent-adjustments'],
  summary: 'Commit a reviewed lease correction or rent change',
  description:
    'Replans under lock and commits the adjustment, receipt, and idempotency outcome atomically.',
  request: {
    params: AccountTenancyParams,
    body: { required: true, content: { 'application/json': { schema: CommitRentAdjustmentBody } } },
  },
  responses: {
    200: {
      description: 'durable receipt',
      content: { 'application/json': { schema: RentAdjustmentReceipt } },
    },
    ...adjustmentErrors,
  },
});

const recoverRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/rent-adjustments/by-request-key/{requestKey}',
  tags: ['rent-adjustments'],
  summary: 'Resolve an uncertain adjustment by request key',
  request: { params: RequestKeyParams },
  responses: {
    200: {
      description: 'receipt, or null if no durable adjustment exists',
      content: { 'application/json': { schema: RentAdjustmentRecovery } },
    },
    ...errorResponses,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/rent-adjustments/{adjustmentId}',
  tags: ['rent-adjustments'],
  summary: 'Read a rent-adjustment receipt',
  request: { params: AdjustmentParams },
  responses: {
    200: {
      description: 'receipt',
      content: { 'application/json': { schema: RentAdjustmentReceipt } },
    },
    ...errorResponses,
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/rent-adjustments',
  tags: ['rent-adjustments'],
  summary: 'List rent-adjustment receipts newest first',
  request: { params: AccountTenancyParams, query: RentAdjustmentListQuery },
  responses: {
    200: {
      description: 'receipt page',
      content: { 'application/json': { schema: RentAdjustmentList } },
    },
    ...errorResponses,
  },
});

export function mapAdjustmentError(error: { code?: string; message?: string }): ApiError {
  const message = error.message ?? '';
  if (error.code === 'P0002')
    return new ApiError(404, 'not_found', 'rent adjustment target not found');
  if (message.includes('adjustment_not_supported')) {
    return new ApiError(
      422,
      'adjustment_not_supported',
      message.replace(/^.*adjustment_not_supported:\s*/, ''),
    );
  }
  if (message.includes('preview_stale')) {
    return new ApiError(409, 'preview_stale', message.replace(/^.*preview_stale:\s*/, ''));
  }
  if (message.includes('adjustment_scope_required')) {
    return new ApiError(
      409,
      'adjustment_scope_required',
      message.replace(/^.*adjustment_scope_required:\s*/, ''),
    );
  }
  const exact = {
    source_amount_mismatch: [409, 'adjustment_scope_required'],
    no_change: [400, 'invalid_request'],
    lease_voided: [409, 'lease_voided'],
    notice_not_served: [409, 'notice_not_served'],
    tenancy_ended: [409, 'tenancy_ended'],
    instrument_not_current: [409, 'instrument_not_current'],
    schedule_conflict: [409, 'schedule_conflict'],
  } as const;
  const mapped = exact[message as keyof typeof exact];
  if (mapped) return new ApiError(mapped[0], mapped[1], message.replaceAll('_', ' '));
  return mapPrefixedRpcError(error, [
    [/preview_stale/i, 'preview_stale'],
    [/adjustment_scope_required/i, 'adjustment_scope_required'],
  ]);
}

function parseReceipt(value: unknown): z.infer<typeof RentAdjustmentReceipt> {
  const result = RentAdjustmentReceipt.safeParse(value);
  if (!result.success) {
    throw new ApiError(500, 'database_error', 'rent adjustment returned an invalid receipt');
  }
  return result.data;
}

export const rentAdjustmentsApp = newApiApp();

rentAdjustmentsApp.openapi(listRoute, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const page = await keysetPage<{ id: string; created_at: string; response_body: unknown }>(
    getSb(c)
      .from('rent_adjustments')
      .select('id,created_at,response_body')
      .eq('account_id', accountId)
      .eq('tenancy_id', tenancyId),
    { cursor, limit, descending: true },
  );
  return c.json(
    {
      items: page.items.map(({ response_body }) => parseReceipt(response_body)),
      next_cursor: page.next_cursor,
    },
    200,
  );
});

rentAdjustmentsApp.openapi(previewRoute, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const { data, error } = await getSb(c).rpc(
    'preview_rent_adjustment',
    asDbFunctionArgs<'preview_rent_adjustment'>({
      p_account_id: accountId,
      p_tenancy_id: tenancyId,
      p_payload: asJson(c.req.valid('json')),
    }),
  );
  if (error) throw mapAdjustmentError(error);
  const result = RentAdjustmentPreview.safeParse(data);
  if (!result.success)
    throw new ApiError(500, 'database_error', 'rent adjustment preview returned an invalid result');
  return c.json(result.data, 200);
});

rentAdjustmentsApp.openapi(commitRoute, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const body = c.req.valid('json');
  const claim = c.get('idempotencyClaim');
  if (!claim) throw new ApiError(500, 'database_error', 'idempotency claim is unavailable');
  const { data, error } = await getSb(c).rpc(
    'commit_rent_adjustment',
    asDbFunctionArgs<'commit_rent_adjustment'>({
      p_account_id: accountId,
      p_tenancy_id: tenancyId,
      p_payload: asJson(body.input),
      p_preview_token: body.preview_token,
      p_request_key: claim.key,
      p_request_fingerprint: claim.fingerprint,
    }),
  );
  if (error) throw mapAdjustmentError(error);
  const receipt = parseReceipt(data);
  c.set('idempotencyCompletedAtomically', true);
  return c.json(receipt, 200);
});

rentAdjustmentsApp.openapi(recoverRoute, async (c) => {
  const { accountId, tenancyId, requestKey } = c.req.valid('param');
  const { data, error } = await getSb(c)
    .from('rent_adjustments')
    .select('response_body')
    .eq('account_id', accountId)
    .eq('tenancy_id', tenancyId)
    .eq('request_key', requestKey)
    .maybeSingle();
  if (error) throw mapAdjustmentError(error);
  return c.json({ receipt: data ? parseReceipt(data.response_body) : null }, 200);
});

rentAdjustmentsApp.openapi(getRoute, async (c) => {
  const { accountId, tenancyId, adjustmentId } = c.req.valid('param');
  const { data, error } = await getSb(c)
    .from('rent_adjustments')
    .select('response_body')
    .eq('account_id', accountId)
    .eq('tenancy_id', tenancyId)
    .eq('id', adjustmentId)
    .maybeSingle();
  if (error) throw mapAdjustmentError(error);
  if (!data) throw new ApiError(404, 'not_found', 'rent adjustment not found');
  return c.json(parseReceipt(data.response_body), 200);
});
