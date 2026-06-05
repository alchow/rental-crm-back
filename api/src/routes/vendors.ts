import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireAuth } from '../middleware/auth';
import { requireAccountMembership } from '../middleware/account-context';
import { getUserClient } from '../supabase/user-client';
import { ApiError, errorResponses } from './_lib/error';
import { decodeCursor, encodeCursor } from './_lib/cursor';

const Vendor = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    name: z.string(),
    contact: z.record(z.unknown()).nullable(),
    notes: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Vendor');

const CreateVendorBody = z
  .object({
    name: z.string().min(1).max(200),
    contact: z.record(z.unknown()).optional(),
    notes: z.string().optional(),
  })
  .openapi('CreateVendorBody');

const PatchVendorBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    contact: z.record(z.unknown()).optional(),
    notes: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  })
  .openapi('PatchVendorBody');

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
});

const ListResponse = z
  .object({ data: z.array(Vendor), next_cursor: z.string().nullable() })
  .openapi('VendorListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/vendors',
  tags: ['vendors'],
  summary: 'List vendors',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/vendors/{id}',
  tags: ['vendors'],
  summary: 'Get one vendor',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'vendor', content: { 'application/json': { schema: Vendor } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/vendors',
  tags: ['vendors'],
  summary: 'Create a vendor',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateVendorBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Vendor } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/vendors/{id}',
  tags: ['vendors'],
  summary: 'Update a vendor (partial)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchVendorBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Vendor } } },
    ...errorResponses,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/vendors/{id}',
  tags: ['vendors'],
  summary: 'Soft-delete a vendor',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const vendorsApp = new OpenAPIHono();
vendorsApp.use('/accounts/:accountId/*', requireAuth(), requireAccountMembership());

vendorsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getUserClient(c.get('auth').accessToken);
  let query = sb
    .from('vendors')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit + 1);
  if (cursor) {
    const cur = decodeCursor(cursor);
    if (cur) {
      query = query.or(
        `created_at.gt.${cur.created_at},and(created_at.eq.${cur.created_at},id.gt.${cur.id})`,
      );
    }
  }
  const { data, error } = await query;
  if (error) throw new ApiError(500, 'database_error', error.message);
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ created_at: String(last.created_at), id: String(last.id) })
      : null;
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

vendorsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('vendors')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Vendor>, 200);
});

vendorsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('vendors')
    .insert({
      account_id: accountId,
      name: body.name,
      contact: body.contact ?? {},
      notes: body.notes ?? null,
    })
    .select('*')
    .single();
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json(data as z.infer<typeof Vendor>, 201);
});

vendorsApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) update.name = body.name;
  if (body.contact !== undefined) update.contact = body.contact;
  if (body.notes !== undefined) update.notes = body.notes;
  const { data, error } = await sb
    .from('vendors')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Vendor>, 200);
});

vendorsApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('vendors')
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
