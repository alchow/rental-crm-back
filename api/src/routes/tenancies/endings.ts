import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { getSb } from '../../supabase/request-client';
import type { DbFunctionArgs } from '../../supabase/db-types';
import { ApiError, conflictResponse, errorResponses } from '../_lib/error';
import { CalendarDate } from '../../schemas/calendar-date';
import { AccountAndIdParam, Tenancy } from './schemas';

const EndingInitiatedBy = z.enum(['tenant', 'landlord', 'mutual', 'unknown']);
const EndedReasonCode = z.enum(['notice', 'abandonment', 'fixed_term_completed', 'mutual_surrender', 'other']);
const CancelledReasonCode = z.enum(['applicant_withdrew', 'landlord_withdrew', 'other']);
const EndingBodyFields = {
  effective_date: CalendarDate,
  initiated_by: EndingInitiatedBy.default('unknown'),
  reason_note: z.string().min(1).max(2000).optional(),
  source_notice_id: z.string().uuid().optional(),
  source_interaction_id: z.string().uuid().optional(),
};
const EndTenancyBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ended'), ...EndingBodyFields, reason_code: EndedReasonCode.default('other') }),
  z.object({ kind: z.literal('cancelled_before_move_in'), ...EndingBodyFields, reason_code: CancelledReasonCode.default('other') }),
]).openapi('EndTenancyBody');
const TenancyEnding = z.object({
  id: z.string().uuid(), account_id: z.string().uuid(), tenancy_id: z.string().uuid(),
  kind: z.enum(['ended', 'cancelled_before_move_in']), effective_date: z.string(),
  initiated_by: EndingInitiatedBy, reason_code: z.string(), reason_note: z.string().nullable(),
  source_notice_id: z.string().uuid().nullable(), source_interaction_id: z.string().uuid().nullable(),
  created_by: z.string().uuid(), created_at: z.string(),
}).openapi('TenancyEnding');
const EndTenancyResponse = z.object({ tenancy: Tenancy, ending: TenancyEnding }).openapi('EndTenancyResponse');

const getEnding = createRoute({
  method: 'get', path: '/accounts/{accountId}/tenancies/{id}/ending', tags: ['tenancies'],
  summary: 'Get the immutable ending fact for a tenancy', request: { params: AccountAndIdParam },
  responses: { 200: { description: 'ending', content: { 'application/json': { schema: TenancyEnding } } }, ...errorResponses },
});
const endTenancy = createRoute({
  method: 'post', path: '/accounts/{accountId}/tenancies/{id}/end', tags: ['tenancies'],
  summary: 'End or cancel a tenancy atomically',
  description: 'Creates an immutable ending fact, marks the tenancy ended, and safely stops future rent generation in one transaction.',
  request: { params: AccountAndIdParam, body: { required: true, content: { 'application/json': { schema: EndTenancyBody } } } },
  responses: { 200: { description: 'ended', content: { 'application/json': { schema: EndTenancyResponse } } }, ...errorResponses, ...conflictResponse },
});

export const tenancyEndingsApp = newApiApp();
tenancyEndingsApp.openapi(getEnding, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { data, error } = await getSb(c).from('tenancy_endings').select('*')
    .eq('account_id', accountId).eq('tenancy_id', id).maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'ending not found');
  return c.json(data as z.infer<typeof TenancyEnding>, 200);
});
tenancyEndingsApp.openapi(endTenancy, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const params: DbFunctionArgs<'end_tenancy'> = {
    p_account_id: accountId, p_tenancy_id: id, p_kind: body.kind,
    p_effective_date: body.effective_date, p_initiated_by: body.initiated_by,
    p_reason_code: body.reason_code,
  };
  if (body.reason_note !== undefined) params.p_reason_note = body.reason_note;
  if (body.source_notice_id !== undefined) params.p_source_notice_id = body.source_notice_id;
  if (body.source_interaction_id !== undefined) params.p_source_interaction_id = body.source_interaction_id;
  const { data, error } = await getSb(c).rpc('end_tenancy', params);
  if (error) {
    const message = error.message ?? '';
    if (message.startsWith('not_found:')) throw new ApiError(404, 'not_found', message.slice(10).trim());
    if (message.startsWith('conflict:')) {
      const detail = message.slice(9).trim();
      throw new ApiError(409, /already (ended|has an ending)/i.test(detail) ? 'tenancy_already_ended' : 'conflict', detail);
    }
    if (message.startsWith('invalid:')) throw new ApiError(400, 'invalid_request', message.slice(8).trim());
    throw new ApiError(500, 'database_error', message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(500, 'database_error', 'end_tenancy returned no result');
  return c.json(data as z.infer<typeof EndTenancyResponse>, 200);
});
