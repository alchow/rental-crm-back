import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from '../_lib/app';
import { conflictResponse, errorResponses } from '../_lib/error';
import { AccountAndTenancyParam, ContextFingerprint, DateChanges, DateFacts, DateReasonCode, SelectedDateContext } from './schemas';
import { TenancyDateCommandResponse, TenancyDateRecord } from './date-history';
import { atomicDateArgs, dateRpc } from './rpc';

const SelectedLease = z.object({
  id: z.string().uuid(), term_start: z.string(), term_end: z.string().nullable(),
  status: z.string(), voided_at: z.string().nullable(), updated_at: z.string(),
});
const SelectedSchedule = z.object({
  id: z.string().uuid(), start_date: z.string(), end_date: z.string().nullable(),
  due_day: z.number().int(), updated_at: z.string(),
});
const EndingSummary = z.object({
  id: z.string().uuid(), kind: z.enum(['ended', 'cancelled_before_move_in']), effective_date: z.string(),
});
const InformationCode = z.enum([
  'date_values_differ', 'legacy_date_unverified', 'charges_in_changed_interval',
  'billing_precedes_possession', 'legacy_ending_incomplete',
]);
const BlockerCode = z.enum([
  'invalid_date_order', 'date_status_conflict', 'date_fixed_by_cancellation',
  'source_scope_invalid', 'actual_move_in_in_future', 'no_date_change',
]);

const ContextQuery = z.object(SelectedDateContext);
export const TenancyDateContext = z.object({
  version: z.literal(1), facts: DateFacts, lease: SelectedLease.nullable(),
  schedule: SelectedSchedule.nullable(), ending: EndingSummary.nullable(),
  context_fingerprint: ContextFingerprint, information: z.array(InformationCode),
  applicable_explanation: TenancyDateRecord.nullable(), can_correct_start: z.boolean(),
}).openapi('TenancyDateContext');

const PreviewBody = z.object({ changes: DateChanges, ...SelectedDateContext })
  .openapi('PreviewTenancyDateCorrectionBody');
export const TenancyDateCorrectionPreview = z.object({
  current: DateFacts, proposed: DateFacts, context_fingerprint: ContextFingerprint,
  blockers: z.array(BlockerCode), information: z.array(InformationCode),
  financial_review: z.object({
    live_charges: z.number().int().nonnegative(), live_payments: z.number().int().nonnegative(),
    charges_in_changed_interval: z.number().int().nonnegative(),
    due_date_fallback_count: z.number().int().nonnegative(), sampled_at: z.string(),
  }),
}).openapi('TenancyDateCorrectionPreview');

const CorrectBody = z.object({
  changes: DateChanges,
  expected_date_revision: z.number().int().nonnegative(),
  expected_context_fingerprint: ContextFingerprint,
  expected_resulting_status: z.enum(['upcoming', 'active', 'ended', 'holdover']),
  ...SelectedDateContext,
  reason_code: DateReasonCode,
  reason_note: z.string().trim().min(1).max(2000),
  source_document_id: z.string().uuid().optional(),
}).openapi('CorrectTenancyDatesBody');

const contextRoute = createRoute({
  method: 'get', path: '/accounts/{accountId}/tenancies/{tenancyId}/date-context',
  tags: ['tenancies'], summary: 'Read possession, selected lease, and selected rent dates',
  request: { params: AccountAndTenancyParam, query: ContextQuery },
  responses: { 200: { description: 'date context', content: { 'application/json': { schema: TenancyDateContext } } }, ...errorResponses },
});
const previewRoute = createRoute({
  method: 'post', path: '/accounts/{accountId}/tenancies/{tenancyId}/date-corrections/preview',
  tags: ['tenancies'], summary: 'Preview a reasoned possession-date correction',
  description: 'Reports informational financial counts. Previewing and correcting never changes charges, payments, allocations, leases, or rent schedules.',
  request: { params: AccountAndTenancyParam, body: { required: true, content: { 'application/json': { schema: PreviewBody } } } },
  responses: { 200: { description: 'preview', content: { 'application/json': { schema: TenancyDateCorrectionPreview } } }, ...errorResponses },
});
const correctRoute = createRoute({
  method: 'post', path: '/accounts/{accountId}/tenancies/{tenancyId}/date-corrections',
  tags: ['tenancies'], summary: 'Correct possession facts and append immutable history',
  description: 'Atomically validates the preview context, changes only tenancy possession facts/status, and records the supplied reason. Existing money is retained.',
  request: { params: AccountAndTenancyParam, body: { required: true, content: { 'application/json': { schema: CorrectBody } } } },
  responses: { 200: { description: 'corrected', content: { 'application/json': { schema: TenancyDateCommandResponse } } }, ...errorResponses, ...conflictResponse },
});

export const tenancyDatesApp = newApiApp();
tenancyDatesApp.openapi(contextRoute, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const query = c.req.valid('query');
  const data = await dateRpc<z.infer<typeof TenancyDateContext>>(c, 'get_tenancy_date_context', {
    p_account_id: accountId, p_tenancy_id: tenancyId,
    p_lease_id: query.lease_id ?? null, p_rent_schedule_id: query.rent_schedule_id ?? null,
  });
  return c.json(data, 200);
});
tenancyDatesApp.openapi(previewRoute, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const body = c.req.valid('json');
  const data = await dateRpc<z.infer<typeof TenancyDateCorrectionPreview>>(c, 'preview_tenancy_date_correction', {
    p_account_id: accountId, p_tenancy_id: tenancyId, p_payload: body,
  });
  return c.json(data, 200);
});
tenancyDatesApp.openapi(correctRoute, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const body = c.req.valid('json');
  const data = await dateRpc<z.infer<typeof TenancyDateCommandResponse>>(c, 'correct_tenancy_dates', {
    p_account_id: accountId, p_tenancy_id: tenancyId, ...atomicDateArgs(c, body),
  });
  c.set('idempotencyCompletedAtomically', true);
  return c.json(data, 200);
});
