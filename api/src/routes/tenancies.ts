import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import type { DbFunctionArgs, DbTableUpdate } from '../supabase/db-types';
import { ApiError, errorResponses, conflictResponse } from './_lib/error';
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
          'non-voided charges or payments (409 tenancy_has_money otherwise). A future date ' +
          "requires status='upcoming' in the same PATCH.",
      }),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  })
  .openapi('PatchTenancyBody');

const EndingInitiatedBy = z.enum(['tenant', 'landlord', 'mutual', 'unknown']);
const EndedReasonCode = z.enum([
  'notice',
  'abandonment',
  'fixed_term_completed',
  'mutual_surrender',
  'other',
]);
const CancelledReasonCode = z.enum(['applicant_withdrew', 'landlord_withdrew', 'other']);

const EndingBodyFields = {
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  initiated_by: EndingInitiatedBy.default('unknown'),
  reason_note: z.string().min(1).max(2000).optional(),
  source_notice_id: z.string().uuid().optional(),
  source_interaction_id: z.string().uuid().optional(),
};

const EndTenancyBody = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('ended'),
      ...EndingBodyFields,
      reason_code: EndedReasonCode.default('other'),
    }),
    z.object({
      kind: z.literal('cancelled_before_move_in'),
      ...EndingBodyFields,
      reason_code: CancelledReasonCode.default('other'),
    }),
  ])
  .openapi('EndTenancyBody');

const TenancyEnding = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    kind: z.enum(['ended', 'cancelled_before_move_in']),
    effective_date: z.string(),
    initiated_by: EndingInitiatedBy,
    reason_code: z.string(),
    reason_note: z.string().nullable(),
    source_notice_id: z.string().uuid().nullable(),
    source_interaction_id: z.string().uuid().nullable(),
    created_by: z.string().uuid(),
    created_at: z.string(),
  })
  .openapi('TenancyEnding');

const EndTenancyResponse = z
  .object({ tenancy: Tenancy, ending: TenancyEnding })
  .openapi('EndTenancyResponse');

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
    description:
      "Status or comma-separated statuses. Allowed values: upcoming, active, ended, holdover. Example: 'active,holdover'.",
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
  summary: 'Update a tenancy (status / end_date / guarded start_date; area_id is immutable)',
  description:
    'start_date is a correction path for a mis-entered move-in date and is refused with ' +
    '409 tenancy_has_money once any non-voided charge or payment exists. A future ' +
    "start_date requires status='upcoming' in the same PATCH (this guards the correction " +
    'path only; it is not a table-wide invariant). Two documented side effects of a ' +
    'correction: evidence-export PDFs show the corrected span from then on, and re-running ' +
    'an import sheet created before the correction can duplicate the tenancy (import ' +
    'dedupe keys on start_date).',
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
const getEnding = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{id}/ending',
  tags: ['tenancies'],
  summary: 'Get the immutable ending fact for a tenancy',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'ending', content: { 'application/json': { schema: TenancyEnding } } },
    ...errorResponses,
  },
});
const endTenancy = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{id}/end',
  tags: ['tenancies'],
  summary: 'End or cancel a tenancy atomically',
  description:
    'Creates an immutable ending fact, marks the tenancy ended, and safely stops future ' +
    'rent generation in one transaction. cancelled_before_move_in is valid only for an ' +
    'upcoming tenancy and preserves its actual cancellation effective_date separately from ' +
    'tenancies.end_date. Schedules with live charges are retained for explicit void/correction. ' +
    'Repeated calls return 409 tenancy_already_ended. The generic tenancy PATCH remains a ' +
    'compatibility path during frontend migration but does not create an ending fact.',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: EndTenancyBody } }, required: true },
  },
  responses: {
    200: {
      description: 'ended',
      content: { 'application/json': { schema: EndTenancyResponse } },
    },
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

tenanciesApp.openapi(getEnding, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('tenancy_endings')
    .select('*')
    .eq('account_id', accountId)
    .eq('tenancy_id', id)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'ending not found');
  return c.json(data as z.infer<typeof TenancyEnding>, 200);
});

tenanciesApp.openapi(endTenancy, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  const params: DbFunctionArgs<'end_tenancy'> = {
    p_account_id: accountId,
    p_tenancy_id: id,
    p_kind: body.kind,
    p_effective_date: body.effective_date,
    p_initiated_by: body.initiated_by,
    p_reason_code: body.reason_code,
  };
  if (body.reason_note !== undefined) params.p_reason_note = body.reason_note;
  if (body.source_notice_id !== undefined) params.p_source_notice_id = body.source_notice_id;
  if (body.source_interaction_id !== undefined) {
    params.p_source_interaction_id = body.source_interaction_id;
  }

  const { data, error } = await sb.rpc('end_tenancy', params);
  if (error) {
    const message = error.message ?? '';
    if (message.startsWith('not_found:')) {
      throw new ApiError(404, 'not_found', message.slice('not_found:'.length).trim());
    }
    if (message.startsWith('conflict:')) {
      const detail = message.slice('conflict:'.length).trim();
      const code = /already (ended|has an ending)/i.test(detail)
        ? 'tenancy_already_ended'
        : 'conflict';
      throw new ApiError(409, code, detail);
    }
    if (message.startsWith('invalid:')) {
      throw new ApiError(400, 'invalid_request', message.slice('invalid:'.length).trim());
    }
    throw new ApiError(500, 'database_error', message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError(500, 'database_error', 'end_tenancy returned no result');
  }
  return c.json(data as z.infer<typeof EndTenancyResponse>, 200);
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
