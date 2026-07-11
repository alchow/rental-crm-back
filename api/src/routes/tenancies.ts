import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import type { DbTableUpdate } from '../supabase/db-types';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { parseCsvEnum } from './_lib/csv-enum';
import { softDeleteStamp } from './_lib/soft-delete';
import { CreateTenancyBody, TenancyStatus } from '../schemas/importable';

// A tenancy is one occupancy period of one unit-kind area. The DB trigger
// `tenancies_area_kind_check` enforces area.kind = 'unit' (a tenancy on a
// hallway makes no sense and would corrupt the rent ledger built on top).
// We don't allow patching area_id once a tenancy is created -- changing
// which area a tenancy occupies is a different operation (end the old,
// start a new) and conflates the records.

const Tenancy = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    area_id: z.string().uuid(),
    start_date: z.string(),
    end_date: z.string().nullable(),
    status: TenancyStatus,
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Tenancy');

const PatchTenancyBody = z
  .object({
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    status: TenancyStatus.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  })
  .openapi('PatchTenancyBody');

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
  area_id: z.string().uuid().optional(),
  // Single status or a comma-separated set — a single value keeps its exact
  // pre-existing behaviour; a multi-value filter widens to an IN. Validated in
  // the handler (parseCsvEnum) so an unknown member is a 400 with fieldErrors,
  // not a silent empty page.
  status: z.string().optional().openapi({
    description: "Status or comma-separated statuses, e.g. 'active,holdover'.",
    example: 'active,holdover',
  }),
});

const ListResponse = z
  .object({ data: z.array(Tenancy), next_cursor: z.string().nullable() })
  .openapi('TenancyListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies',
  tags: ['tenancies'],
  summary: 'List tenancies (filterable by area_id and status)',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{id}',
  tags: ['tenancies'],
  summary: 'Get one tenancy',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'tenancy', content: { 'application/json': { schema: Tenancy } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies',
  tags: ['tenancies'],
  summary: 'Create a tenancy (on a unit-kind area)',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateTenancyBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Tenancy } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/tenancies/{id}',
  tags: ['tenancies'],
  summary: 'Update a tenancy (status / end_date only; area_id is immutable)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchTenancyBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Tenancy } } },
    ...errorResponses,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/tenancies/{id}',
  tags: ['tenancies'],
  summary: 'Soft-delete a tenancy',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
  },
});

export const tenanciesApp = newApiApp();

tenanciesApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, area_id, status } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('tenancies').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (area_id) q = q.eq('area_id', area_id);
  const statuses = parseCsvEnum(status, TenancyStatus.options, 'status');
  if (statuses) {
    const [only] = statuses;
    q = statuses.length === 1 && only ? q.eq('status', only) : q.in('status', statuses);
  }
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

tenanciesApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('tenancies')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Tenancy>, 200);
});

tenanciesApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('tenancies')
    .insert({
      account_id: accountId,
      area_id: body.area_id,
      start_date: body.start_date,
      end_date: body.end_date ?? null,
      status: body.status,
    })
    .select('*')
    .single();
  if (error) {
    // The trigger raises `area <uuid> not found` for an area_id that's
    // invisible under RLS (e.g., belongs to another account) -- the row IS
    // in the DB but the trigger's SELECT runs under the caller's identity
    // and gets nothing back. From the caller's perspective the area "doesn't
    // exist", so 404 is the right status.
    if (/area .* not found/i.test(error.message)) {
      throw new ApiError(404, 'not_found', 'area_id does not belong to this account');
    }
    if (/expected unit/i.test(error.message)) {
      throw new ApiError(400, 'invalid_request', 'tenancy area must be kind=unit');
    }
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'area_id does not belong to this account');
    }
    if (error.code === '23514') {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof Tenancy>, 201);
});

tenanciesApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const update: DbTableUpdate<'tenancies'> = { updated_at: new Date().toISOString() };
  if (body.end_date !== undefined) update.end_date = body.end_date;
  if (body.status !== undefined) update.status = body.status;
  const { data, error } = await sb
    .from('tenancies')
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
  return c.json(data as z.infer<typeof Tenancy>, 200);
});

tenanciesApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('tenancies')
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
