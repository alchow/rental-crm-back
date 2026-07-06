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
    // Provenance for an instrument-anchored rent change (migration
    // 20260706000001). A schedule created by a rent change points back at the
    // renewal lease (source_lease_id) or served notice (source_notice_id) that
    // authorised it; change_reason is a free-text note. All null on a schedule
    // created directly via POST /rent-schedules.
    source_lease_id: z.string().uuid().nullable(),
    source_notice_id: z.string().uuid().nullable(),
    change_reason: z.string().nullable(),
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
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    // Optional provenance (see the RentSchedule schema). Pass one when the
    // schedule is being written to record a lease/notice-anchored change
    // directly; the rent-changes endpoint is the higher-level path that also
    // ends the prior schedule and supersedes the anchored lease atomically.
    source_lease_id: z.string().uuid().optional(),
    source_notice_id: z.string().uuid().optional(),
    change_reason: z.string().min(1).max(2000).optional(),
  })
  .openapi('CreateRentScheduleBody');

const EndRentScheduleBody = z
  .object({
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .openapi('EndRentScheduleBody');

// Instrument-anchored rent change (migration 20260706000001). A rent change is
// never a free-floating amount edit: it must be anchored to the instrument that
// authorises it -- a renewal lease (fixed-term) or a served notice
// (month-to-month). change_tenancy_rent() does the whole swap atomically: ends
// the open same-kind schedule at effective_date-1, inserts the successor with
// this provenance, and (when lease-anchored) supersedes the other active leases
// and activates a 'draft' anchor lease.
const RentChangeBody = z
  .object({
    amount_cents: z.number().int().nonnegative(),
    currency: CurrencyCode,
    effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    due_day: z.number().int().min(1).max(28).optional(),
    source_lease_id: z.string().uuid().optional(),
    source_notice_id: z.string().uuid().optional(),
    change_reason: z.string().min(1).max(2000).optional(),
    kind: z.string().min(1).max(50).optional(),
  })
  .refine((b) => b.source_lease_id !== undefined || b.source_notice_id !== undefined, {
    message:
      'a rent change must be anchored to source_lease_id (fixed-term) or source_notice_id (month-to-month)',
  })
  .openapi('RentChangeBody');

const RentChangeResult = z
  .object({
    rent_schedule: RentSchedule,
    ended_schedule_ids: z.array(z.string().uuid()),
    superseded_lease_ids: z.array(z.string().uuid()),
    // Charges the generator had already advance-created off the OLD era for
    // periods on/after effective_date are voided by change_tenancy_rent (the
    // successor era re-bills them at the new amount); their ids are returned so
    // the caller can reconcile any downstream invoice it had emitted.
    voided_charge_ids: z.array(z.string().uuid()),
  })
  .openapi('RentChangeResult');

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
const AccountAndTenancyParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'tenancyId', in: 'path' } }),
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
const rentChange = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/rent-changes',
  tags: ['rent_schedules'],
  summary: 'Apply an instrument-anchored rent change (renewal lease or served notice)',
  description:
    'Ends the open same-kind schedule at effective_date−1 and opens the successor ' +
    'anchored to the renewal lease and/or served notice. Any charges the generator ' +
    'had already advance-created off the old era for periods on/after effective_date ' +
    'are voided automatically (returned in voided_charge_ids); the successor era ' +
    're-bills those periods at the new amount.',
  request: {
    params: AccountAndTenancyParam,
    body: { content: { 'application/json': { schema: RentChangeBody } }, required: true },
  },
  responses: {
    201: { description: 'applied', content: { 'application/json': { schema: RentChangeResult } } },
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
  // The source_*/change_reason columns arrive with migration 20260706000001.
  // Schema-first is the deploy policy, but code MUST also survive leading the
  // schema: include these three keys ONLY when the caller supplied them, so a
  // plain create (the overwhelming majority, from clients that never send them)
  // never references a not-yet-created column -- PostgREST 500s on an unknown
  // column even for a null value. Same conditional-spread the rent-change
  // handler uses for its RPC params.
  const insert: Record<string, unknown> = {
    account_id: accountId,
    tenancy_id: body.tenancy_id,
    kind: body.kind,
    amount_cents: body.amount_cents,
    currency: body.currency,
    due_day: body.due_day,
    start_date: body.start_date,
    end_date: body.end_date ?? null,
  };
  if (body.source_lease_id !== undefined) insert.source_lease_id = body.source_lease_id;
  if (body.source_notice_id !== undefined) insert.source_notice_id = body.source_notice_id;
  if (body.change_reason !== undefined) insert.change_reason = body.change_reason;
  const { data, error } = await sb.from('rent_schedules').insert(insert).select('*').single();
  if (error) {
    if (error.code === '23503') {
      // Any of tenancy_id / source_lease_id / source_notice_id can trip the FK
      // (all are account-scoped composite FKs). The constraint name pins which.
      throw new ApiError(404, 'not_found', 'referenced entity does not belong to this account');
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

rentSchedulesApp.openapi(rentChange, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // Only forward the optionals the caller actually supplied so the SQL
  // DEFAULTs apply (kind -> 'rent', due_day/source ids/change_reason -> null).
  // supabase-js JSON-serialises the params, so an omitted key is simply absent.
  const params: Record<string, unknown> = {
    p_account_id: accountId,
    p_tenancy_id: tenancyId,
    p_amount_cents: body.amount_cents,
    p_currency: body.currency,
    p_effective_date: body.effective_date,
  };
  if (body.due_day !== undefined) params.p_due_day = body.due_day;
  if (body.source_lease_id !== undefined) params.p_source_lease_id = body.source_lease_id;
  if (body.source_notice_id !== undefined) params.p_source_notice_id = body.source_notice_id;
  if (body.change_reason !== undefined) params.p_change_reason = body.change_reason;
  if (body.kind !== undefined) params.p_kind = body.kind;

  const { data, error } = await sb.rpc('change_tenancy_rent', params);
  if (error) {
    // change_tenancy_rent RAISEs with a stable prefix on the message
    // (not_found:/conflict:/invalid:); everything else is a genuine DB error.
    // The prefix is stripped so the client sees a clean message.
    const msg = error.message ?? '';
    if (msg.startsWith('not_found:')) {
      throw new ApiError(404, 'not_found', msg.slice('not_found:'.length).trim());
    }
    if (msg.startsWith('conflict:')) {
      throw new ApiError(409, 'conflict', msg.slice('conflict:'.length).trim());
    }
    if (msg.startsWith('invalid:')) {
      throw new ApiError(400, 'invalid_request', msg.slice('invalid:'.length).trim());
    }
    throw new ApiError(500, 'database_error', msg);
  }

  // The function RETURNS TABLE, so supabase-js hands back a one-row array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        o_schedule_id: string;
        o_ended_schedule_ids: string[];
        o_superseded_lease_ids: string[];
        o_voided_charge_ids: string[];
      }
    | null
    | undefined;
  if (!row) throw new ApiError(500, 'database_error', 'rent change returned no row');

  // Fetch the full successor schedule for the response. Runs as the same user,
  // so RLS still scopes it to the account.
  const { data: schedule, error: fetchErr } = await sb
    .from('rent_schedules')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', row.o_schedule_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (fetchErr) throw new ApiError(500, 'database_error', fetchErr.message);
  if (!schedule)
    throw new ApiError(500, 'database_error', 'successor schedule not found after change');

  return c.json(
    {
      rent_schedule: schedule as z.infer<typeof RentSchedule>,
      ended_schedule_ids: row.o_ended_schedule_ids ?? [],
      superseded_lease_ids: row.o_superseded_lease_ids ?? [],
      voided_charge_ids: row.o_voided_charge_ids ?? [],
    } as z.infer<typeof RentChangeResult>,
    201,
  );
});
