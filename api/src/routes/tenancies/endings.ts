import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
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
      expected_move_out_on: CalendarDate.optional(),
      final_rent_schedule_id: z.string().uuid().optional(),
      final_rent_amount_cents: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    }),
    z.object({
      kind: z.literal('cancelled_before_move_in'),
      ...EndingBodyFields,
      reason_code: CancelledReasonCode.default('other'),
    }),
  ])
  .refine(
    (body) =>
      body.kind !== 'ended' ||
      (body.final_rent_schedule_id === undefined) === (body.final_rent_amount_cents === undefined),
    'The final rent amount needs its rent schedule.',
  )
  .openapi('EndTenancyBody');
const TenancyEnding = z
  .object({
    id: z.string().uuid().nullable().openapi({
      description: 'Null when the ending is a scheduled move-out whose last day has passed.',
    }),
    source: z.enum(['recorded', 'scheduled_move_out']).optional(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    kind: z.enum(['ended', 'cancelled_before_move_in']),
    effective_date: z.string(),
    initiated_by: EndingInitiatedBy,
    reason_code: z.string(),
    reason_note: z.string().nullable(),
    source_notice_id: z.string().uuid().nullable(),
    source_interaction_id: z.string().uuid().nullable(),
    created_by: z.string().uuid().nullable(),
    created_at: z.string(),
    original_effective_date: z.string().optional(),
    correction_record_id: z.string().uuid().nullable().optional(),
  })
  .openapi('TenancyEnding');
const EndTenancyResponse = z
  .object({ tenancy: Tenancy, ending: TenancyEnding.nullable() })
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
    'Schedules a future move-out on enabled accounts. Ending today or earlier records the actual ending immediately.',
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
  summary: 'Review an ending or planned move-out without writing it',
  request: {
    params: AccountAndIdParam,
    body: { required: true, content: { 'application/json': { schema: EndTenancyBody } } },
  },
  responses: {
    200: { description: 'review', content: { 'application/json': { schema: DateWarningPreview } } },
    ...errorResponses,
  },
});

const cancelMoveOut = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{id}/move-out/cancel',
  tags: ['tenancies'],
  summary: 'Cancel a scheduled move-out while the tenancy is occupied',
  request: {
    params: AccountAndIdParam,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ expected_move_out_on: CalendarDate }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Current tenancy', content: { 'application/json': { schema: Tenancy } } },
    ...errorResponses,
    ...conflictResponse,
  },
});

// DATA FLOW: a scheduled move-out records no ending row. Once its last day has
// passed in the account's time zone, the ending is derived from the saved plan.
async function scheduledEnding(
  c: Context,
  accountId: string,
  tenancyId: string,
): Promise<z.infer<typeof TenancyEnding>> {
  const { data, error } = await getSb(c)
    .from('tenancy_current')
    .select('status, move_out_on, move_out_plan')
    .eq('account_id', accountId)
    .eq('id', tenancyId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data || data.status !== 'ended' || !data.move_out_on) {
    throw new ApiError(404, 'not_found', 'ending not found');
  }
  const plan = (data.move_out_plan ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof plan[key] === 'string' ? (plan[key] as string) : null);
  const initiatedBy = EndingInitiatedBy.safeParse(plan.initiated_by);
  return {
    id: null,
    source: 'scheduled_move_out',
    account_id: accountId,
    tenancy_id: tenancyId,
    kind: 'ended',
    effective_date: data.move_out_on,
    initiated_by: initiatedBy.success ? initiatedBy.data : 'unknown',
    reason_code: text('reason_code') ?? 'other',
    reason_note: text('reason_note'),
    source_notice_id: text('source_notice_id'),
    source_interaction_id: text('source_interaction_id'),
    created_by: text('scheduled_by'),
    created_at: text('scheduled_at') ?? data.move_out_on,
  };
}

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
  if (!original) return c.json(await scheduledEnding(c, accountId, id), 200);
  const data = await dateRpc<z.infer<typeof TenancyEnding>>(c, 'get_tenancy_ending_context', {
    p_account_id: accountId,
    p_tenancy_id: id,
  });
  return c.json({ ...data, source: 'recorded' } as z.infer<typeof TenancyEnding>, 200);
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

tenancyEndingsApp.openapi(cancelMoveOut, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const claim = c.get('idempotencyClaim');
  if (!claim) throw new ApiError(500, 'database_error', 'Missing request claim');
  const tenancy = await dateRpc<z.infer<typeof Tenancy>>(c, 'cancel_scheduled_move_out', {
    p_account_id: accountId,
    p_tenancy_id: id,
    p_expected_move_out_on: c.req.valid('json').expected_move_out_on,
    p_idempotency_key: claim.key,
    p_request_fingerprint: claim.fingerprint,
  });
  c.set('idempotencyCompletedAtomically', true);
  return c.json(tenancy, 200);
});
