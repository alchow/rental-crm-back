import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';

// A rent schedule is the recurring rule that EMITS periodic charges. It
// lives on a tenancy (not on a lease) so lease-less tenancies still bill.
// There is no PATCH / DELETE: "the rent changed mid-tenancy" is recorded
// by ending the current schedule (set end_date) and creating a new one.
// That keeps the history honest -- nobody can edit "what the rent was"
// retroactively.

const CurrencyCode = z.string().length(3);
const ScheduleKind = z.string().min(1).max(50); // rent / parking / pet / utility / ...

const RentSchedule = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    kind: ScheduleKind,
    amount_cents: z.number().int().nonnegative(),
    currency: CurrencyCode,
    due_day: z.number().int().min(1).max(28),
    start_date: z.string(),
    end_date: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('RentSchedule');

// Exported for reuse by the onboarding-import executor (same-schema validation).
export const CreateRentScheduleBody = z
  .object({
    tenancy_id: z.string().uuid(),
    kind: ScheduleKind,
    amount_cents: z.number().int().nonnegative(),
    currency: CurrencyCode,
    due_day: z.number().int().min(1).max(28),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .openapi('CreateRentScheduleBody');

const EndRentScheduleBody = z
  .object({
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .openapi('EndRentScheduleBody');

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
  .object({ data: z.array(RentSchedule), next_cursor: z.string().nullable() })
  .openapi('RentScheduleListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/rent-schedules',
  tags: ['rent_schedules'],
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/rent-schedules/{id}',
  tags: ['rent_schedules'],
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'schedule', content: { 'application/json': { schema: RentSchedule } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/rent-schedules',
  tags: ['rent_schedules'],
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateRentScheduleBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: RentSchedule } } },
    ...errorResponses,
  },
});
const end = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/rent-schedules/{id}/end',
  tags: ['rent_schedules'],
  summary: 'Set the end_date on a schedule (history-preserving end)',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: EndRentScheduleBody } }, required: true },
  },
  responses: {
    200: { description: 'ended', content: { 'application/json': { schema: RentSchedule } } },
    ...errorResponses,
  },
});

export const rentSchedulesApp = newApiApp();

rentSchedulesApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('rent_schedules').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

rentSchedulesApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('rent_schedules')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof RentSchedule>, 200);
});

rentSchedulesApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('rent_schedules')
    .insert({
      account_id: accountId,
      tenancy_id: body.tenancy_id,
      kind: body.kind,
      amount_cents: body.amount_cents,
      currency: body.currency,
      due_day: body.due_day,
      start_date: body.start_date,
      end_date: body.end_date ?? null,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'tenancy_id does not belong to this account');
    }
    if (error.code === '23514') throw new ApiError(400, 'invalid_request', error.message);
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof RentSchedule>, 201);
});

rentSchedulesApp.openapi(end, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('rent_schedules')
    .update({ end_date: body.end_date, updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    if (error.code === '23514') throw new ApiError(400, 'invalid_request', error.message);
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof RentSchedule>, 200);
});
