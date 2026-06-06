import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getUserClient } from '../supabase/user-client';
import { ApiError, errorResponses } from './_lib/error';
import { decodeCursor, encodeCursor } from './_lib/cursor';

// Payments are MONEY RECEIVED. As with charges, there is no PATCH / DELETE:
// a bounced check or mis-entered cash is VOIDED via POST .../void. A
// reversal that involves a fee (NSF) is a SEPARATE new charge row plus an
// optional negative-account-balance carryover; the original payment stays
// visible.
//
// Allocations: a payment can be created with allocations[] inline (atomic;
// the DB trigger _assert_allocation_integrity guards against cross-tenancy
// / cross-account / over-allocation). Additional allocations land via
// POST .../payments/{id}/allocations. Allocations are immutable once
// created -- correcting a misallocation is itself a reversal (we'd add a
// new charge or apply against the right one). Phase 6 ships create-only.
//
// Voiding a payment leaves its allocations in place; the ledger view
// filters them out via the payment.voided_at check.

const PaymentMethod = z.enum([
  'cash', 'check', 'ach', 'card', 'zelle_venmo', 'money_order', 'other',
]);
const CurrencyCode = z.string().length(3);

const Payment = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    amount_cents: z.number().int().nonnegative(),
    currency: CurrencyCode,
    received_at: z.string(),
    method: PaymentMethod,
    reference: z.string().nullable(),
    payer_tenant_id: z.string().uuid().nullable(),
    processor_ref: z.string().nullable(),
    notes: z.string().nullable(),
    idempotency_key: z.string().nullable(),
    voided_at: z.string().nullable(),
    void_reason: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Payment');

const PaymentAllocation = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    payment_id: z.string().uuid(),
    charge_id: z.string().uuid(),
    amount_cents: z.number().int().positive(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('PaymentAllocation');

const AllocationInput = z
  .object({
    charge_id: z.string().uuid(),
    amount_cents: z.number().int().positive(),
  })
  .openapi('PaymentAllocationInput');

const CreatePaymentBody = z
  .object({
    tenancy_id: z.string().uuid(),
    amount_cents: z.number().int().positive(),
    currency: CurrencyCode,
    received_at: z.string(),
    method: PaymentMethod,
    reference: z.string().optional(),
    payer_tenant_id: z.string().uuid().optional(),
    notes: z.string().optional(),
    // Optional inline allocations. The DB trigger enforces all the
    // integrity rules (sums, currency, same tenancy/account, no voided).
    allocations: z.array(AllocationInput).optional(),
  })
  .openapi('CreatePaymentBody');

const VoidPaymentBody = z
  .object({ void_reason: z.string().min(1).max(500) })
  .openapi('VoidPaymentBody');

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
});
const ListResponse = z
  .object({ data: z.array(Payment), next_cursor: z.string().nullable() })
  .openapi('PaymentListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/payments',
  tags: ['payments'],
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/payments/{id}',
  tags: ['payments'],
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'payment', content: { 'application/json': { schema: Payment } } },
    ...errorResponses,
  },
});

const PaymentWithAllocations = z
  .object({
    payment: Payment,
    allocations: z.array(PaymentAllocation),
  })
  .openapi('PaymentWithAllocations');

const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/payments',
  tags: ['payments'],
  summary: 'Record a received payment, optionally with allocations',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreatePaymentBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: PaymentWithAllocations } } },
    ...errorResponses,
  },
});

const voidRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/payments/{id}/void',
  tags: ['payments'],
  summary: 'Void a payment (history-preserving; original row stays visible)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: VoidPaymentBody } }, required: true },
  },
  responses: {
    200: { description: 'voided', content: { 'application/json': { schema: Payment } } },
    ...errorResponses,
  },
});

const addAllocation = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/payments/{id}/allocations',
  tags: ['payments'],
  summary: 'Add an allocation against an existing payment',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: AllocationInput } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: PaymentAllocation } } },
    ...errorResponses,
  },
});

export const paymentsApp = new OpenAPIHono();

paymentsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id } = c.req.valid('query');
  const sb = getUserClient(c.get('auth').accessToken);
  let q = sb.from('payments').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  q = q
    .order('received_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit + 1);
  if (cursor) {
    const cur = decodeCursor(cursor);
    if (cur) {
      q = q.or(
        `received_at.gt.${cur.created_at},and(received_at.eq.${cur.created_at},id.gt.${cur.id})`,
      );
    }
  }
  const { data, error } = await q;
  if (error) throw new ApiError(500, 'database_error', error.message);
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ created_at: String(last.received_at), id: String(last.id) })
      : null;
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

paymentsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('payments')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Payment>, 200);
});

paymentsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);

  // Atomicity: a payment with allocations[] is ONE Postgres transaction.
  // Without this, an allocation that trips the integrity trigger would
  // leave a phantom payment row (money in limbo). The RPC takes both pieces
  // and lets postgres roll back the lot on any failure.
  const { data: rpcData, error: rpcErr } = await sb.rpc(
    'create_payment_with_allocations',
    {
      p_account_id:      accountId,
      p_tenancy_id:      body.tenancy_id,
      p_amount_cents:    body.amount_cents,
      p_currency:        body.currency,
      p_received_at:     body.received_at,
      p_method:          body.method,
      p_reference:       body.reference ?? null,
      p_payer_tenant_id: body.payer_tenant_id ?? null,
      p_notes:           body.notes ?? null,
      p_allocations:     body.allocations ?? [],
    },
  );
  if (rpcErr) {
    // Map the trigger / FK / membership errors the function can raise to
    // the right HTTP status. Anything else is a real 500.
    if (rpcErr.code === '42501' || rpcErr.code === '28000') {
      throw new ApiError(404, 'not_found', 'not found');
    }
    if (/cross-tenancy|cross-account|account mismatch|currency mismatch|voided/i.test(rpcErr.message)) {
      throw new ApiError(400, 'invalid_request', rpcErr.message);
    }
    if (/exceed (payment|charge) amount/i.test(rpcErr.message)) {
      throw new ApiError(400, 'invalid_request', rpcErr.message);
    }
    if (rpcErr.code === '23503') {
      throw new ApiError(404, 'not_found', 'a referenced row (tenancy / charge / tenant) does not belong to this account');
    }
    if (rpcErr.code === '23514') {
      throw new ApiError(400, 'invalid_request', rpcErr.message);
    }
    throw new ApiError(500, 'database_error', rpcErr.message);
  }

  // RPC returns a setof; supabase-js gives us an array.
  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
    | { payment: unknown; allocations: unknown }
    | null;
  if (!row || !row.payment) {
    throw new ApiError(500, 'database_error', 'RPC returned no payment row');
  }
  return c.json(
    {
      payment:     row.payment     as z.infer<typeof Payment>,
      allocations: row.allocations as z.infer<typeof PaymentAllocation>[],
    },
    201,
  );
});

paymentsApp.openapi(voidRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { void_reason } = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('payments')
    .update({ voided_at: new Date().toISOString(), void_reason, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .is('voided_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'payment not found or already voided');
  return c.json(data as z.infer<typeof Payment>, 200);
});

paymentsApp.openapi(addAllocation, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('payment_allocations')
    .insert({
      account_id: accountId,
      payment_id: id,
      charge_id: body.charge_id,
      amount_cents: body.amount_cents,
    })
    .select('*')
    .single();
  if (error) {
    if (/cross-tenancy|cross-account|account mismatch|currency mismatch|voided/i.test(error.message)) {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    if (/exceed (payment|charge) amount/i.test(error.message)) {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'payment or charge not found in this account');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof PaymentAllocation>, 201);
});
