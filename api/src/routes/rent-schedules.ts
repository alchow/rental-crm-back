import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses, conflictResponse, type ErrorCode } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { softDeleteStamp } from './_lib/soft-delete';

// A rent schedule is the recurring rule that EMITS periodic charges. It
// lives on a tenancy (not on a lease) so lease-less tenancies still bill.
// There is no PATCH: "the rent changed mid-tenancy" is recorded by ending
// the current schedule (set end_date) and creating a new one. That keeps
// the history honest -- nobody can edit "what the rent was" retroactively.
//
// DELETE exists for exactly one purpose (ADR-0012 corrections policy): a
// NEVER-BILLED mistaken schedule -- the typo'd rent change, the future era
// that blocks a re-change with "resolve it first" -- is corrected by
// soft-delete + recreate. A schedule with live (non-voided) charges is a
// billed era and is NEVER deletable: it gets ENDED, and its wrong charges
// voided (POST /charges/{id}/void). The DB backstops this (migration
// 20260706000002) because the FOR ALL member policy makes rent_schedules
// directly writable through PostgREST too.

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
    // null RE-OPENS the schedule (clears end_date) -- cancelling a planned
    // end, or undoing a rent change that VOIDED NOTHING (voided_charge_ids
    // was empty). It is the WRONG tool when the change voided advance
    // charges: the charge-dedupe key counts voided rows, so a re-opened
    // schedule can never re-bill a period it was voided for -- the month is
    // silently lost. Undo such a change with a fresh CONTINUATION schedule
    // instead (delete the successor, then POST a new schedule at the old
    // terms starting on the mistaken effective date); a new id gets a fresh
    // dedupe key, so the generator re-bills automatically -- but ONLY while
    // the voided period's due day is still ahead (the generator bills one
    // window and never backfills); a later undo re-creates the elapsed
    // period manually via POST /charges. Either way, remove the successor
    // BEFORE restoring coverage, or two open same-kind eras will both bill.
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .openapi({
        description:
          'End date (inclusive). null clears an existing end_date, re-opening the ' +
          'schedule. Only re-open when the ended state was not produced by a rent ' +
          'change that voided charges (voided_charge_ids non-empty) — a voided ' +
          '(schedule, period) pair never re-bills under the same schedule id, so a ' +
          're-opened schedule silently skips those periods. Undo such a change with ' +
          'a fresh continuation schedule (POST /rent-schedules) instead.',
      }),
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
    // due_day is inherited from the schedule being ended; when the tenancy has
    // no open same-kind schedule there is nothing to inherit and the RPC
    // rejects with 400 -- so first-time setup through this endpoint must pass
    // it. Declared in the description because JSON Schema cannot express
    // "conditionally required".
    due_day: z
      .number()
      .int()
      .min(1)
      .max(28)
      .optional()
      .openapi({
        description:
          'Day of month the successor bills on. Optional when an open same-kind ' +
          'schedule exists (inherited from it); REQUIRED (400 otherwise) when there ' +
          'is none — e.g. first-time setup through this endpoint.',
      }),
    // Both anchors optional in the schema, but AT LEAST ONE is required -- a
    // zod refine (below) enforces it at validation, which JSON Schema's
    // required-list cannot express. Declared here so generated clients see it.
    source_lease_id: z.string().uuid().optional().openapi({
      description:
        'Lease anchor (fixed-term changes: renewal/amendment). At least one of ' +
        'source_lease_id / source_notice_id is required (400 otherwise). A draft ' +
        'anchor lease is activated by the change; expired/superseded leases are ' +
        'rejected (409 instrument_not_current).',
    }),
    source_notice_id: z.string().uuid().optional().openapi({
      description:
        'Served-notice anchor (month-to-month changes). At least one of ' +
        'source_lease_id / source_notice_id is required (400 otherwise). The notice ' +
        'must have served_at set (409 notice_not_served otherwise).',
    }),
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
  summary: 'Set or clear the end_date on a schedule (history-preserving end / re-open)',
  description:
    'Sets end_date (inclusive) on the schedule; billing stops after it. Passing ' +
    'end_date: null clears the bound and RE-OPENS the schedule — for cancelling a ' +
    'planned end, or undoing a rent change that voided nothing (voided_charge_ids ' +
    'was empty). Do NOT re-open to undo a change that voided advance charges: a ' +
    'voided (schedule, period) pair is never re-billed under the same schedule id, ' +
    'so the re-opened schedule silently skips those periods. Undo that case with a ' +
    'fresh continuation schedule instead — delete the mistaken successor, then ' +
    'POST /rent-schedules with the old terms starting on the mistaken effective ' +
    'date. The new id re-bills a voided period on the next generator run ONLY ' +
    'while that period’s due day is still ahead (the generator never backfills): ' +
    'for an undo performed later, re-create the elapsed period(s) manually via ' +
    'POST /charges with source_schedule_id = the continuation.',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: EndRentScheduleBody } }, required: true },
  },
  responses: {
    200: { description: 'ended', content: { 'application/json': { schema: RentSchedule } } },
    ...errorResponses,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/rent-schedules/{id}',
  tags: ['rent_schedules'],
  summary: 'Soft-delete a never-billed schedule (ADR-0012 corrections path)',
  description:
    'Removes a mistaken schedule era — the resolution for the rent-change 409 ' +
    '(schedule_conflict) on an already-planned future schedule, and for the ' +
    '"never billed → soft-delete and recreate" correction. Refused with 409 ' +
    'schedule_has_charges while any non-voided charge references the schedule: ' +
    'void those first (POST /charges/{id}/void). A billed era is ended, never ' +
    'deleted. Deleting a schedule releases the write-block on the lease/notice ' +
    'that anchored it.',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
    ...conflictResponse,
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
    'are voided automatically (returned in voided_charge_ids). Re-billing is NOT ' +
    'synchronous, and only reaches periods whose due day is still ahead: for ' +
    'auto_charge_enabled accounts the next daily generator run (08:00 UTC) ' +
    're-emits those voided periods at the new amount. A BACKDATED change — applied ' +
    'after a voided period’s due day — leaves that period with no live charge and ' +
    'the generator never revisits it (no backfill, by design): re-create it ' +
    'manually via POST /charges at the new amount with source_schedule_id = the ' +
    'successor (rent_schedule.id in this response). Manually-billing accounts ' +
    're-create charges themselves in all cases. 409 codes: tenancy_ended, ' +
    'notice_not_served, instrument_not_current (expired/superseded anchor lease), ' +
    'schedule_conflict (a same-kind schedule starts on/after effective_date — ' +
    'delete it via DELETE /rent-schedules/{id} if mistaken, or change on a later ' +
    'date).',
  request: {
    params: AccountAndTenancyParam,
    body: { content: { 'application/json': { schema: RentChangeBody } }, required: true },
  },
  responses: {
    201: { description: 'applied', content: { 'application/json': { schema: RentChangeResult } } },
    ...errorResponses,
    ...conflictResponse,
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

rentSchedulesApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);

  // A schedule with live (non-voided) charges is a billed era: end it, never
  // delete it. Pre-check for the clean 409; the DB trigger (migration
  // 20260706000002) is the authoritative backstop for the check-then-write
  // race and for direct PostgREST writes.
  const live = await sb
    .from('charges')
    .select('id')
    .eq('account_id', accountId)
    .eq('source_schedule_id', id)
    .is('voided_at', null)
    .is('deleted_at', null)
    .limit(1);
  if (live.error) throw new ApiError(500, 'database_error', live.error.message);
  if ((live.data?.length ?? 0) > 0) {
    throw new ApiError(
      409,
      'schedule_has_charges',
      'schedule has non-voided charges; void them (POST /charges/{id}/void) or end the schedule instead',
    );
  }

  const { data, error } = await sb
    .from('rent_schedules')
    .update(softDeleteStamp())
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    // Race backstop: the trigger raises check_violation with this message when
    // a charge landed between our pre-check and the write.
    if (/has live charges and cannot be deleted/i.test(error.message)) {
      throw new ApiError(
        409,
        'schedule_has_charges',
        'schedule has non-voided charges; void them (POST /charges/{id}/void) or end the schedule instead',
      );
    }
    if (error.code === '23514') throw new ApiError(400, 'invalid_request', error.message);
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
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
      const detail = msg.slice('conflict:'.length).trim();
      // Fine-grained 409 codes (branch-on-code-never-message, per the FE
      // contract). Keyed off the RPC's stable messages -- test:rent-changes
      // pins each pairing, so a reworded RAISE fails loudly there instead of
      // silently degrading to the generic code.
      const code: ErrorCode = /tenancy already ended/i.test(detail)
        ? 'tenancy_ended'
        : /source lease is (expired|superseded)/i.test(detail)
          ? 'instrument_not_current'
          : /has not been served/i.test(detail)
            ? 'notice_not_served'
            : /conflicts with effective_date/i.test(detail)
              ? 'schedule_conflict'
              : 'conflict';
      throw new ApiError(409, code, detail);
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
