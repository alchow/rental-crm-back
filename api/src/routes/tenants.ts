import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getUserClient } from '../supabase/user-client';
import { ApiError, errorResponses } from './_lib/error';
import { decodeCursor, encodeCursor } from './_lib/cursor';

const Tenant = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    full_name: z.string(),
    emails: z.array(z.string()),
    phones: z.array(z.string()),
    notes: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Tenant');

// Exported for reuse by the onboarding-import executor (same-schema validation):
// this is where email-format and phone-length checks live that the DB does not.
export const CreateTenantBody = z
  .object({
    full_name: z.string().min(1).max(200),
    emails: z.array(z.string().email()).optional(),
    phones: z.array(z.string().min(1).max(40)).optional(),
    notes: z.string().optional(),
  })
  .openapi('CreateTenantBody');

const PatchTenantBody = z
  .object({
    full_name: z.string().min(1).max(200).optional(),
    emails: z.array(z.string().email()).optional(),
    phones: z.array(z.string().min(1).max(40)).optional(),
    notes: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  })
  .openapi('PatchTenantBody');

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
  .object({ data: z.array(Tenant), next_cursor: z.string().nullable() })
  .openapi('TenantListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenants',
  tags: ['tenants'],
  summary: 'List tenants',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenants/{id}',
  tags: ['tenants'],
  summary: 'Get one tenant',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'tenant', content: { 'application/json': { schema: Tenant } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenants',
  tags: ['tenants'],
  summary: 'Create a tenant',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateTenantBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Tenant } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/tenants/{id}',
  tags: ['tenants'],
  summary: 'Update a tenant (partial)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchTenantBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Tenant } } },
    ...errorResponses,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/tenants/{id}',
  tags: ['tenants'],
  summary: 'Soft-delete a tenant',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const tenantsApp = new OpenAPIHono();

tenantsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getUserClient(c.get('auth').accessToken);
  let query = sb
    .from('tenants')
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

tenantsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('tenants')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Tenant>, 200);
});

tenantsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('tenants')
    .insert({
      account_id: accountId,
      full_name: body.full_name,
      emails: body.emails ?? [],
      phones: body.phones ?? [],
      notes: body.notes ?? null,
    })
    .select('*')
    .single();
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json(data as z.infer<typeof Tenant>, 201);
});

tenantsApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.full_name !== undefined) update.full_name = body.full_name;
  if (body.emails !== undefined) update.emails = body.emails;
  if (body.phones !== undefined) update.phones = body.phones;
  if (body.notes !== undefined) update.notes = body.notes;
  const { data, error } = await sb
    .from('tenants')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Tenant>, 200);
});

tenantsApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('tenants')
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
