import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { softDeleteStamp } from './_lib/soft-delete';

// Areas are the model's central abstraction: a unit is just an `area` whose
// kind = 'unit'. Common areas (hallway, basement_mechanical, …) live in the
// same table; clients filter by `kind`. Operational entities (assets,
// maintenance requests, inspections, scheduled tasks) attach to an area, not
// to a property or a free-text location.
//
// The composite FK on (account_id, property_id) makes a cross-account
// property_id rejected by the DB, not just by RLS. The route relies on that.

export const AreaKind = z.enum([
  'unit',
  'entrance',
  'hallway',
  'stairwell',
  'basement_mechanical',
  'laundry',
  'parking',
  'roof',
  'exterior_grounds',
  'common_other',
]);

const Area = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    property_id: z.string().uuid(),
    kind: AreaKind,
    name: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Area');

// Exported for reuse by the onboarding-import executor (same-schema validation).
export const CreateAreaBody = z
  .object({
    property_id: z.string().uuid(),
    kind: AreaKind,
    name: z.string().min(1).max(200),
  })
  .openapi('CreateAreaBody');

// kind is intentionally NOT patchable. Changing an area's kind would orphan
// unit_details (which is keyed on a unit-kind area) and break any operational
// rows that assumed the prior kind. To change kind, soft-delete + create new.
const PatchAreaBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  })
  .openapi('PatchAreaBody');

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
  property_id: z.string().uuid().optional(),
  kind: AreaKind.optional(),
});

const ListResponse = z
  .object({ data: z.array(Area), next_cursor: z.string().nullable() })
  .openapi('AreaListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/areas',
  tags: ['areas'],
  summary: 'List areas in an account (filterable by property_id and kind)',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/areas/{id}',
  tags: ['areas'],
  summary: 'Get one area',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'area', content: { 'application/json': { schema: Area } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/areas',
  tags: ['areas'],
  summary: 'Create an area (unit or common area)',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateAreaBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Area } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/areas/{id}',
  tags: ['areas'],
  summary: 'Update an area (name only; kind is immutable)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchAreaBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Area } } },
    ...errorResponses,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/areas/{id}',
  tags: ['areas'],
  summary: 'Soft-delete an area',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const areasApp = newApiApp();

areasApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, property_id, kind } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb
    .from('areas')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  if (property_id) q = q.eq('property_id', property_id);
  if (kind) q = q.eq('kind', kind);
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

areasApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('areas')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Area>, 200);
});

areasApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('areas')
    .insert({
      account_id: accountId,
      property_id: body.property_id,
      kind: body.kind,
      name: body.name,
    })
    .select('*')
    .single();
  if (error) {
    // Cross-account property_id is caught by the composite FK; surface as 404
    // (we don't confirm the foreign property exists to non-owners).
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'property_id does not belong to this account');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof Area>, 201);
});

areasApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) update.name = body.name;
  const { data, error } = await sb
    .from('areas')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Area>, 200);
});

areasApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('areas')
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
