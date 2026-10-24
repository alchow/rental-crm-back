import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { getSb } from '../../supabase/request-client';
import { ApiError, conflictResponse, errorResponses } from '../_lib/error';
import { CalendarDate } from '../../schemas/calendar-date';
import { AccountAndIdParam, Tenancy } from './schemas';
import { atomicDateArgs, dateRpc } from './rpc';
import { DateWarningPreview, WarningAcknowledgements } from './date-warnings';

const EndingInitiatedBy = z.enum(['tenant', 'landlord', 'mutual', 'unknown']);
const EndedReasonCode = z.enum([
  'notice',
  'abandonment',
  'fixed_term_completed',
  'mutual_surrender',
  'other',
]);
const CancelledReasonCode = z.enum(['applicant_withdrew', 'landlord_withdrew', 'other']);
const EndingBodyFields = {
  warning_acknowledgements: WarningAcknowledgements,
  expected_context_fingerprint: z.string().min(1).max(256).optional(),
  effective_date: CalendarDate,
  initiated_by: EndingInitiatedBy.default('unknown'),
  reason_note: z.string().min(1).max(2000).optional(),
  source_notice_id: z.string().uuid().optional(),
  source_interaction_id: z.string().uuid().optional(),
};
const EndTenancyBody = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('ended'),
      ...EndingBodyFields,
      reason_code: EndedReasonCode.default('other'),
    }),
    z.object({
      kind: z.literal('cancelled_before_move_in'),
      ...EndingBodyFields,
      reason_code: CancelledReasonCode.default('other'),
    }),
  ])
  .openapi('EndTenancyBody');
const TenancyEnding = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    kind: z.enum(['ended', 'cancelled_before_move_in']),
    effective_date: z.string(),
    initiated_by: EndingInitiatedBy,
    reason_code: z.string(),
    reason_note: z.string().nullable(),
    source_notice_id: z.string().uuid().nullable(),
    source_interaction_id: z.string().uuid().nullable(),
    created_by: z.string().uuid(),
    created_at: z.string(),
    original_effective_date: z.string().optional(),
    correction_record_id: z.string().uuid().nullable().optional(),
  })
  .openapi('TenancyEnding');
const EndTenancyResponse = z
  .object({ tenancy: Tenancy, ending: TenancyEnding })
  .openapi('EndTenancyResponse');

const getEnding = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{id}/ending',
  tags: ['tenancies'],
  summary: 'Get the immutable ending fact for a tenancy',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'ending', content: { 'application/json': { schema: TenancyEnding } } },
    ...errorResponses,
  },
});
const endTenancy = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{id}/end',
  tags: ['tenancies'],
  summary: 'End or cancel a tenancy atomically',
  description:
    'Creates an immutable ending fact, marks the tenancy ended, and safely stops future rent generation in one transaction.',
  request: {
    params: AccountAndIdParam,
    body: { required: true, content: { 'application/json': { schema: EndTenancyBody } } },
  },
  responses: {
    200: { description: 'ended', content: { 'application/json': { schema: EndTenancyResponse } } },
    ...errorResponses,
    ...conflictResponse,
  },
});
const previewEnding = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{id}/end/preview',
  tags: ['tenancies'],
  summary: 'Review an actual ending and its immediate lifecycle effect without writing it',
  request: {
    params: AccountAndIdParam,
    body: { required: true, content: { 'application/json': { schema: EndTenancyBody } } },
  },
  responses: {
    200: { description: 'review', content: { 'application/json': { schema: DateWarningPreview } } },
    ...errorResponses,
  },
});

export const tenancyEndingsApp = newApiApp();
tenancyEndingsApp.openapi(getEnding, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { data: original, error } = await getSb(c)
    .from('tenancy_endings')
    .select('id')
    .eq('account_id', accountId)
    .eq('tenancy_id', id)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!original) throw new ApiError(404, 'not_found', 'ending not found');
  const data = await dateRpc<z.infer<typeof TenancyEnding>>(c, 'get_tenancy_ending_context', {
    p_account_id: accountId,
    p_tenancy_id: id,
  });
  return c.json(data as z.infer<typeof TenancyEnding>, 200);
});
tenancyEndingsApp.openapi(previewEnding, async (c) => {
  const { accountId, id } = c.req.valid('param');
  return c.json(
    await dateRpc<z.infer<typeof DateWarningPreview>>(c, 'preview_tenancy_ending', {
      p_account_id: accountId,
      p_tenancy_id: id,
      p_payload: c.req.valid('json'),
    }),
    200,
  );
});
tenancyEndingsApp.openapi(endTenancy, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const data = await dateRpc<z.infer<typeof EndTenancyResponse>>(c, 'record_tenancy_ending', {
    p_account_id: accountId,
    p_tenancy_id: id,
    ...atomicDateArgs(c, body),
  });
  c.set('idempotencyCompletedAtomically', true);
  return c.json(data, 200);
});
