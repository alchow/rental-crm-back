import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { softDeleteStamp } from './_lib/soft-delete';

// =====================================================================
// schemas
// =====================================================================

// NOT registered as a named component on purpose. Referencing a registered
// `.openapi('Address')` schema through `.optional()` / `.nullable()` makes
// zod-openapi emit `allOf: [{$ref: Address}, {type: object}]`, which
// openapi-typescript then renders as `Address & Record<string, never>` -- an
// unsatisfiable type (every key becomes `never`). Inlining keeps the same
// validation while emitting a plain object schema the SDK can actually use.
const Address = z.object({
  line1:   z.string().max(200).optional(),
  line2:   z.string().max(200).optional(),
  city:    z.string().max(100).optional(),
  state:   z.string().max(100).optional(),
  zip:     z.string().max(20).optional(),
  country: z.string().max(100).optional(),
});

const Property = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    name: z.string(),
    address: Address.nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Property');

// Exported so the onboarding-import executor validates against the EXACT same
// schema an HTTP POST would, rather than a hand-rolled parallel copy.
export const CreatePropertyBody = z
  .object({
    name: z.string().min(1).max(200),
    address: Address.optional(),
  })
  .openapi('CreatePropertyBody');

const PatchPropertyBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    address: Address.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  })
  .openapi('PatchPropertyBody');

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
  .object({
    data: z.array(Property),
    next_cursor: z.string().nullable(),
  })
  .openapi('PropertyListResponse');

// =====================================================================
// routes
// =====================================================================

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/properties',
  tags: ['properties'],
  summary: 'List properties in an account',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});

const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/properties/{id}',
  tags: ['properties'],
  summary: 'Get one property',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'property', content: { 'application/json': { schema: Property } } },
    ...errorResponses,
  },
});

const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/properties',
  tags: ['properties'],
  summary: 'Create a property',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreatePropertyBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Property } } },
    ...errorResponses,
  },
});

const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/properties/{id}',
  tags: ['properties'],
  summary: 'Update a property (partial)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchPropertyBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Property } } },
    ...errorResponses,
  },
});

const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/properties/{id}',
  tags: ['properties'],
  summary: 'Soft-delete a property',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

// =====================================================================
// handlers
// =====================================================================

export const propertiesApp = newApiApp();

propertiesApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getSb(c);

  const query = sb
    .from('properties')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  const { items, next_cursor: nextCursor } = await keysetPage(query, { cursor, limit });

  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

propertiesApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);

  const { data, error } = await sb
    .from('properties')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Property>, 200);
});

propertiesApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  const { data, error } = await sb
    .from('properties')
    .insert({
      account_id: accountId,
      name: body.name,
      address: body.address ?? {},
    })
    .select('*')
    .single();

  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json(data as z.infer<typeof Property>, 201);
});

propertiesApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) update.name = body.name;
  if (body.address !== undefined) update.address = body.address;

  const { data, error } = await sb
    .from('properties')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();

  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Property>, 200);
});

propertiesApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);

  const { data, error } = await sb
    .from('properties')
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});
