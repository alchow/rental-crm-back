import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { asJson, nullableRpcArg } from '../supabase/db-types';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';

// Payment voids and application reversals preserve original facts and append audit events.

const PaymentMethod = z.enum([
  'cash',
  'check',
  'ach',
  'card',
  'zelle_venmo',
  'money_order',
  'other',
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
    note: z.string().nullable(),
    voided_at: z.string().nullable(),
    void_reason: z.string().nullable(),
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

const ApplyCreditBody = AllocationInput.extend({
  note: z.string().trim().max(1000).optional(),
}).openapi('ApplyCreditBody');

function matchesApplication(
  allocation: z.infer<typeof PaymentAllocation>,
  paymentId: string,
  body: z.infer<typeof ApplyCreditBody>,
): boolean {
  return (
    allocation.payment_id === paymentId &&
    allocation.charge_id === body.charge_id &&
    allocation.amount_cents === body.amount_cents &&
    allocation.note === (body.note || null)
  );
}

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
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
});
const AccountAndIdParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
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
    201: {
      description: 'created',
      content: { 'application/json': { schema: PaymentWithAllocations } },
    },
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
    body: { content: { 'application/json': { schema: ApplyCreditBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: PaymentAllocation } } },
    ...errorResponses,
  },
});

const voidAllocation = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/payments/{id}/allocations/{allocationId}/void',
  tags: ['payments'],
  summary: 'Reverse one application without changing the received payment',
  request: {
    params: AccountAndIdParam.extend({ allocationId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: VoidPaymentBody } }, required: true },
  },
  responses: {
    200: {
      description: 'reversed',
      content: { 'application/json': { schema: PaymentAllocation } },
    },
    ...errorResponses,
  },
});

export const paymentsApp = newApiApp();

paymentsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('payments').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  const { items, next_cursor: nextCursor } = await keysetPage(q, {
    cursor,
    limit,
    column: 'received_at',
  });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

paymentsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
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
  const sb = getSb(c);

  // Atomicity: a payment with allocations[] is ONE Postgres transaction.
  // Without this, an allocation that trips the integrity trigger would
  // leave a phantom payment row (money in limbo). The RPC takes both pieces
  // and lets postgres roll back the lot on any failure.
  const { data: rpcData, error: rpcErr } = await sb.rpc('create_payment_with_allocations', {
    p_account_id: accountId,
    p_tenancy_id: body.tenancy_id,
    p_amount_cents: body.amount_cents,
    p_currency: body.currency,
    p_received_at: body.received_at,
    p_method: body.method,
    p_reference: nullableRpcArg(body.reference ?? null),
    p_payer_tenant_id: nullableRpcArg(body.payer_tenant_id ?? null),
    p_notes: nullableRpcArg(body.notes ?? null),
    p_allocations: asJson(body.allocations ?? []),
  });
  if (rpcErr) {
    // Map the trigger / FK / membership errors the function can raise to
    // the right HTTP status. Anything else is a real 500.
    if (rpcErr.code === '42501' || rpcErr.code === '28000') {
      throw new ApiError(404, 'not_found', 'not found');
    }
    if (
      /cross-tenancy|cross-account|account mismatch|currency mismatch|voided/i.test(rpcErr.message)
    ) {
      throw new ApiError(400, 'invalid_request', rpcErr.message);
    }
    if (/exceed (payment|charge) amount/i.test(rpcErr.message)) {
      throw new ApiError(400, 'invalid_request', rpcErr.message);
    }
    if (rpcErr.code === '23503') {
      throw new ApiError(
        404,
        'not_found',
        'a referenced row (tenancy / charge / tenant) does not belong to this account',
      );
    }
    if (rpcErr.code === '23514') {
      throw new ApiError(400, 'invalid_request', rpcErr.message);
    }
    throw new ApiError(500, 'database_error', rpcErr.message);
  }

  // RPC returns a setof; supabase-js gives us an array.
  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as {
    payment: unknown;
    allocations: unknown;
  } | null;
  if (!row || !row.payment) {
    throw new ApiError(500, 'database_error', 'RPC returned no payment row');
  }
  return c.json(
    {
      payment: row.payment as z.infer<typeof Payment>,
      allocations: row.allocations as z.infer<typeof PaymentAllocation>[],
    },
    201,
  );
});

paymentsApp.openapi(voidRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { void_reason } = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('payments')
    .update({
      voided_at: new Date().toISOString(),
      void_reason,
      updated_at: new Date().toISOString(),
    })
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
  const sb = getSb(c);
  const requestKey = c.req.header('idempotency-key')!;
  const { data: replay, error: replayError } = await sb
    .from('payment_allocations')
    .select('*')
    .eq('account_id', accountId)
    .eq('request_key', requestKey)
    .maybeSingle();
  if (replayError) throw new ApiError(500, 'database_error', replayError.message);
  if (replay) {
    if (!matchesApplication(replay, id, body))
      throw new ApiError(409, 'idempotency_conflict', 'This request key was already used.');
    return c.json(replay as z.infer<typeof PaymentAllocation>, 201);
  }
  const { data, error } = await sb
    .from('payment_allocations')
    .insert({
      account_id: accountId,
      payment_id: id,
      charge_id: body.charge_id,
      amount_cents: body.amount_cents,
      note: body.note || null,
      request_key: requestKey,
    })
    .select('*')
    .single();
  if (error) {
    // The unique key closes the gap between committing the row and caching the HTTP response.
    if (error.code === '23505') {
      const { data: existing } = await sb
        .from('payment_allocations')
        .select('*')
        .eq('account_id', accountId)
        .eq('request_key', requestKey)
        .maybeSingle();
      if (existing && matchesApplication(existing, id, body)) {
        return c.json(existing as z.infer<typeof PaymentAllocation>, 201);
      }
      throw new ApiError(409, 'idempotency_conflict', 'This request key was already used.');
    }
    if (
      /cross-tenancy|cross-account|account mismatch|currency mismatch|voided/i.test(error.message)
    ) {
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

paymentsApp.openapi(voidAllocation, async (c) => {
  const { accountId, id, allocationId } = c.req.valid('param');
  const reason = c.req.valid('json').void_reason.trim();
  if (!reason) throw new ApiError(400, 'invalid_request', 'A reversal reason is required.');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('payment_allocations')
    .update({ voided_at: new Date().toISOString(), void_reason: reason })
    .eq('account_id', accountId)
    .eq('payment_id', id)
    .eq('id', allocationId)
    .is('deleted_at', null)
    .is('voided_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (data) return c.json(data as z.infer<typeof PaymentAllocation>, 200);
  const { data: existing, error: readError } = await sb
    .from('payment_allocations')
    .select('*')
    .eq('account_id', accountId)
    .eq('payment_id', id)
    .eq('id', allocationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (readError) throw new ApiError(500, 'database_error', readError.message);
  if (!existing) throw new ApiError(404, 'not_found', 'Application not found.');
  if (existing.void_reason !== reason)
    throw new ApiError(409, 'invalid_request', 'Application already reversed.');
  return c.json(existing as z.infer<typeof PaymentAllocation>, 200);
});
