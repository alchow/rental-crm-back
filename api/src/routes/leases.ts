import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';

// Leases attach to a tenancy. A tenancy can have zero, one, or many leases
// (handshake / month-to-month / holdover are first-class -- they're tenancies
// with no lease rows). The lease.rent_amount_cents is the CONTRACTED figure;
// what actually gets billed comes from rent_schedules in Phase 6. We keep
// them separate so a rent change mid-lease (concession, addendum) writes a
// new schedule without falsifying the lease record.

const LeaseStatus = z.enum(['draft', 'active', 'expired', 'superseded']);
const CurrencyCode = z.string().length(3); // ISO 4217-shaped; trust the DB check

const Lease = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    term_start: z.string(),
    term_end: z.string().nullable(),
    rent_amount_cents: z.number().int().nonnegative(),
    rent_currency: CurrencyCode,
    deposit_amount_cents: z.number().int().nonnegative(),
    deposit_currency: CurrencyCode.nullable(),
    document: z.record(z.unknown()),
    status: LeaseStatus,
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Lease');

// Exported for reuse by the onboarding-import executor (same-schema validation).
export const CreateLeaseBody = z
  .object({
    tenancy_id: z.string().uuid(),
    term_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    term_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    rent_amount_cents: z.number().int().nonnegative(),
    rent_currency: CurrencyCode,
    deposit_amount_cents: z.number().int().nonnegative().optional(),
    deposit_currency: CurrencyCode.optional(),
    document: z.record(z.unknown()).optional(),
    status: LeaseStatus,
  })
  .refine(
    (b) => (b.deposit_amount_cents ?? 0) === 0 || b.deposit_currency !== undefined,
    { message: 'deposit_currency is required when deposit_amount_cents > 0' },
  )
  .openapi('CreateLeaseBody');

const PatchLeaseBody = z
  .object({
    term_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    rent_amount_cents: z.number().int().nonnegative().optional(),
    rent_currency: CurrencyCode.optional(),
    deposit_amount_cents: z.number().int().nonnegative().optional(),
    deposit_currency: CurrencyCode.nullable().optional(),
    document: z.record(z.unknown()).optional(),
    status: LeaseStatus.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchLeaseBody');

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
  status: LeaseStatus.optional(),
});

const ListResponse = z
  .object({ data: z.array(Lease), next_cursor: z.string().nullable() })
  .openapi('LeaseListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/leases',
  tags: ['leases'],
  summary: 'List leases (filterable by tenancy_id and status)',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/leases/{id}',
  tags: ['leases'],
  summary: 'Get one lease',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'lease', content: { 'application/json': { schema: Lease } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/leases',
  tags: ['leases'],
  summary: 'Create a lease attached to a tenancy',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateLeaseBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Lease } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/leases/{id}',
  tags: ['leases'],
  summary: 'Update a lease (partial)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchLeaseBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Lease } } },
    ...errorResponses,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/leases/{id}',
  tags: ['leases'],
  summary: 'Soft-delete a lease',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const leasesApp = newApiApp();

leasesApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id, status } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb
    .from('leases')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  if (status) q = q.eq('status', status);
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

leasesApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('leases')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Lease>, 200);
});

leasesApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('leases')
    .insert({
      account_id: accountId,
      tenancy_id: body.tenancy_id,
      term_start: body.term_start,
      term_end: body.term_end ?? null,
      rent_amount_cents: body.rent_amount_cents,
      rent_currency: body.rent_currency,
      deposit_amount_cents: body.deposit_amount_cents ?? 0,
      deposit_currency: body.deposit_currency ?? null,
      document: body.document ?? {},
      status: body.status,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'tenancy_id does not belong to this account');
    }
    if (error.code === '23514') {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof Lease>, 201);
});

leasesApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.term_end !== undefined) update.term_end = body.term_end;
  if (body.rent_amount_cents !== undefined) update.rent_amount_cents = body.rent_amount_cents;
  if (body.rent_currency !== undefined) update.rent_currency = body.rent_currency;
  if (body.deposit_amount_cents !== undefined) update.deposit_amount_cents = body.deposit_amount_cents;
  if (body.deposit_currency !== undefined) update.deposit_currency = body.deposit_currency;
  if (body.document !== undefined) update.document = body.document;
  if (body.status !== undefined) update.status = body.status;
  const { data, error } = await sb
    .from('leases')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    if (error.code === '23514') {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Lease>, 200);
});

leasesApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('leases')
    .update({ deleted_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});
