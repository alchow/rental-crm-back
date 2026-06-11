import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';

// Charges are AMOUNTS OWED. There is no PATCH / DELETE: a mis-entered or
// cancelled charge is VOIDED via POST .../void (sets voided_at + reason).
// A reversing fee, if there is one, is a SEPARATE new charge row. The
// original row stays visible in every list and the ledger -- "the bill we
// sent the tenant" history is never rewritten.
//
// Status is DERIVED. We never store a "paid / partially_paid / open" field
// on the row; the ledger view computes it from sum(allocations) and
// voided_at. Storing status here would invite drift between the column and
// the truth (allocations + voids).

const ChargeType = z.enum([
  'rent', 'late_fee', 'deposit', 'utility',
  'parking', 'repair_chargeback', 'nsf_fee', 'other',
]);
const CurrencyCode = z.string().length(3);

const Charge = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    type: ChargeType,
    amount_cents: z.number().int().nonnegative(),
    currency: CurrencyCode,
    due_date: z.string(),
    period_start: z.string().nullable(),
    period_end: z.string().nullable(),
    description: z.string().nullable(),
    source_schedule_id: z.string().uuid().nullable(),
    voided_at: z.string().nullable(),
    void_reason: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Charge');

const CreateChargeBody = z
  .object({
    tenancy_id: z.string().uuid(),
    type: ChargeType,
    amount_cents: z.number().int().positive(),
    currency: CurrencyCode,
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    description: z.string().optional(),
    source_schedule_id: z.string().uuid().optional(),
  })
  .openapi('CreateChargeBody');

const VoidChargeBody = z
  .object({ void_reason: z.string().min(1).max(500) })
  .openapi('VoidChargeBody');

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});
const AccountAndIdParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});
const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  tenancy_id: z.string().uuid().optional(),
  type: ChargeType.optional(),
});
const ListResponse = z
  .object({ data: z.array(Charge), next_cursor: z.string().nullable() })
  .openapi('ChargeListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/charges',
  tags: ['charges'],
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/charges/{id}',
  tags: ['charges'],
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'charge', content: { 'application/json': { schema: Charge } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/charges',
  tags: ['charges'],
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateChargeBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Charge } } },
    ...errorResponses,
  },
});
const voidRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/charges/{id}/void',
  tags: ['charges'],
  summary: 'Void a charge (history-preserving; original row stays visible)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: VoidChargeBody } }, required: true },
  },
  responses: {
    200: { description: 'voided', content: { 'application/json': { schema: Charge } } },
    ...errorResponses,
  },
});

export const chargesApp = newApiApp();

chargesApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id, type } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('charges').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  if (type) q = q.eq('type', type);
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

chargesApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('charges')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Charge>, 200);
});

chargesApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('charges')
    .insert({
      account_id: accountId,
      tenancy_id: body.tenancy_id,
      type: body.type,
      amount_cents: body.amount_cents,
      currency: body.currency,
      due_date: body.due_date,
      period_start: body.period_start ?? null,
      period_end: body.period_end ?? null,
      description: body.description ?? null,
      source_schedule_id: body.source_schedule_id ?? null,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'tenancy_id or source_schedule_id does not belong to this account');
    }
    if (error.code === '23514') throw new ApiError(400, 'invalid_request', error.message);
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof Charge>, 201);
});

chargesApp.openapi(voidRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { void_reason } = c.req.valid('json');
  const sb = getSb(c);
  // Voiding sets voided_at + void_reason. The audit trigger records the
  // before/after; the ledger computation already filters voided rows.
  // is('voided_at', null) makes the void itself idempotent: a re-void is a
  // no-op match-zero -> 404 "not found".
  const { data, error } = await sb
    .from('charges')
    .update({ voided_at: new Date().toISOString(), void_reason, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .is('voided_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'charge not found or already voided');
  return c.json(data as z.infer<typeof Charge>, 200);
});
