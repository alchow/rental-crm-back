import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { softDeleteStamp } from './_lib/soft-delete';

// Assets (water heaters, boilers, smoke detectors, etc.) attach to an area,
// never directly to a property. That means the basement boiler is an asset
// in a `basement_mechanical` area, and a unit's water heater is in that
// unit-area. This is the same area-as-the-only-physical-anchor pattern the
// brief is built around.

const Asset = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    area_id: z.string().uuid(),
    name: z.string(),
    kind: z.string(),
    attributes: z.record(z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Asset');

const CreateAssetBody = z
  .object({
    area_id: z.string().uuid(),
    name: z.string().min(1).max(200),
    kind: z.string().min(1).max(100),
    attributes: z.record(z.unknown()).optional(),
  })
  .openapi('CreateAssetBody');

const PatchAssetBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    kind: z.string().min(1).max(100).optional(),
    attributes: z.record(z.unknown()).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchAssetBody');

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
  area_id: z.string().uuid().optional(),
});

const ListResponse = z
  .object({ data: z.array(Asset), next_cursor: z.string().nullable() })
  .openapi('AssetListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/assets',
  tags: ['assets'],
  summary: 'List assets (filterable by area_id)',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/assets/{id}',
  tags: ['assets'],
  summary: 'Get one asset',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'asset', content: { 'application/json': { schema: Asset } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/assets',
  tags: ['assets'],
  summary: 'Create an asset attached to an area',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateAssetBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Asset } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/assets/{id}',
  tags: ['assets'],
  summary: 'Update an asset (partial)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchAssetBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Asset } } },
    ...errorResponses,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/assets/{id}',
  tags: ['assets'],
  summary: 'Soft-delete an asset',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const assetsApp = newApiApp();

assetsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, area_id } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb
    .from('assets')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  if (area_id) q = q.eq('area_id', area_id);
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

assetsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('assets')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Asset>, 200);
});

assetsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('assets')
    .insert({
      account_id: accountId,
      area_id: body.area_id,
      name: body.name,
      kind: body.kind,
      attributes: body.attributes ?? {},
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'area_id does not belong to this account');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof Asset>, 201);
});

assetsApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) update.name = body.name;
  if (body.kind !== undefined) update.kind = body.kind;
  if (body.attributes !== undefined) update.attributes = body.attributes;
  const { data, error } = await sb
    .from('assets')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Asset>, 200);
});

assetsApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('assets')
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
