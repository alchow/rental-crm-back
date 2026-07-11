import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import type { DbTableUpdate } from '../supabase/db-types';
import { ApiError, errorResponses, conflictResponse } from './_lib/error';
import { keysetPage } from './_lib/cursor';
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
    // Correction path for a mis-entered move-in date (usability finding C3).
    // Guarded in the handler: refused with 409 tenancy_has_money once any
    // non-voided charge or payment exists, and a future start_date must be
    // accompanied by status='upcoming' (a future-dated active/holdover/ended
    // tenancy is incoherent, and the daily sweep only advances forward).
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .openapi({
        description:
          'Correction path for a wrong move-in date. Allowed only while the tenancy has no ' +
          "non-voided charges or payments (409 tenancy_has_money otherwise). A future date " +
          "requires status='upcoming' in the same PATCH.",
      }),
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
  status: TenancyStatus.optional(),
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
  summary: 'Update a tenancy (status / end_date / guarded start_date; area_id is immutable)',
  description:
    'start_date is a correction path for a mis-entered move-in date and is refused with ' +
    '409 tenancy_has_money once any non-voided charge or payment exists. Two documented ' +
    'side effects of a correction: evidence-export PDFs show the corrected span from then ' +
    'on, and re-running an import sheet created before the correction can duplicate the ' +
    'tenancy (import dedupe keys on start_date).',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchTenancyBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Tenancy } } },
    ...errorResponses,
    ...conflictResponse,
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
  if (status) q = q.eq('status', status);
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

  // start_date guards. The edit is a workflow guard, not DB-integrity:
  // charges/payments carry their own dates and never reference
  // tenancies.start_date, so nothing corrupts — but a correction under money
  // would silently leave already-billed periods on the old timeline, and a
  // future-dated 'active' tenancy would never be re-advanced (the daily
  // sweep only moves upcoming -> active).
  if (body.start_date !== undefined) {
    const { data: current, error: curErr } = await sb
      .from('tenancies')
      .select('start_date, end_date, status')
      .eq('account_id', accountId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (curErr) throw new ApiError(500, 'database_error', curErr.message);
    if (!current) throw new ApiError(404, 'not_found', 'not found');

    // Idempotent no-op corrections skip the guards.
    if (body.start_date !== current.start_date) {
      const [charges, payments] = await Promise.all([
        sb
          .from('charges')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('tenancy_id', id)
          .is('deleted_at', null)
          .is('voided_at', null),
        sb
          .from('payments')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('tenancy_id', id)
          .is('deleted_at', null)
          .is('voided_at', null),
      ]);
      if (charges.error) throw new ApiError(500, 'database_error', charges.error.message);
      if (payments.error) throw new ApiError(500, 'database_error', payments.error.message);
      if ((charges.count ?? 0) > 0 || (payments.count ?? 0) > 0) {
        throw new ApiError(
          409,
          'tenancy_has_money',
          'start_date cannot change once non-voided charges or payments exist; void them first ' +
            '(POST /charges/{id}/void, POST /payments/{id}/void) or leave start_date unchanged',
          { fieldErrors: { start_date: ['tenancy has non-voided charges or payments'] } },
        );
      }

      // Status coherence. Dates are compared as YYYY-MM-DD strings in UTC —
      // the same day-boundary contract the status-advance sweep uses.
      const today = new Date().toISOString().slice(0, 10);
      const effStatus = body.status ?? current.status;
      if (body.start_date > today && effStatus !== 'upcoming') {
        throw new ApiError(
          400,
          'invalid_request',
          "a future start_date requires status='upcoming' in the same PATCH " +
            '(the daily sweep re-activates the tenancy on the new date)',
          {
            fieldErrors: {
              start_date: ['future date on a non-upcoming tenancy'],
              status: ["must be 'upcoming' when start_date is in the future"],
            },
          },
        );
      }

      const effEnd = body.end_date !== undefined ? body.end_date : current.end_date;
      if (effEnd !== null && effEnd < body.start_date) {
        throw new ApiError(400, 'invalid_request', 'end_date must be on or after start_date', {
          fieldErrors: { start_date: ['after the effective end_date'] },
        });
      }
    }
  }

  const update: DbTableUpdate<'tenancies'> = { updated_at: new Date().toISOString() };
  if (body.end_date !== undefined) update.end_date = body.end_date;
  if (body.status !== undefined) update.status = body.status;
  if (body.start_date !== undefined) update.start_date = body.start_date;
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
