import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses, conflictResponse } from './_lib/error';
import { keysetPage } from './_lib/cursor';

// A notice is a served instrument (entry notice, rent-increase notice,
// termination notice, ...). It attaches to a tenancy and, like a lease, is a
// RECORD of something that happened -- served_at / served_method / body /
// document capture what was delivered and how. Notices are one of the two
// anchors a month-to-month rent change hangs off (the other is a renewal
// lease); see the rent-changes endpoint in rent-schedules.ts.

// A notice that anchors a live rent_schedule (migration 20260706000001) has
// crossed from tamper-evident to WRITE-BLOCKED: once it authorises a billing
// era it is evidence of the increase, so it becomes immutable and undeletable
// -- the completed-inspection precedent (see inspections.ts), where anchoring
// an instrument locks the record. This matches the trigger MESSAGE (the DB
// triggers raise the shared check_violation errcode, like the coherence checks
// that map to 400, so message-matching is how the two are told apart) for the
// race where a schedule anchors the notice between our pre-check and the write.
function isRentInstrumentReject(msg: string): boolean {
  // The trigger raises 'notice <id> is anchored to a rent schedule and cannot
  // be modified'; keep the pattern tolerant of both phrasings.
  return /anchor(s|ed to) a (live )?rent[_ ]schedule/i.test(msg);
}

const Notice = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    notice_type: z.string(),
    served_at: z.string().nullable(),
    served_method: z.string().nullable(),
    body: z.string().nullable(),
    document: z.record(z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Notice');

// served_at convention: when the client only knows the CALENDAR DATE of
// service (the common landlord-entry case), send midnight UTC
// (YYYY-MM-DDT00:00:00Z) and always RENDER it back as a UTC calendar date --
// formatting it in a local timezone shifts the displayed service date by a
// day for any viewer west of Greenwich. When the actual service moment is
// known (e-service, certified delivery scan), send the real timestamp.
const ServedAt = z.string().datetime().openapi({
  description:
    'When the notice was served. Date-only knowledge: send midnight UTC ' +
    '(YYYY-MM-DDT00:00:00Z) and render as a UTC calendar date. Send the real ' +
    'timestamp when the service moment is known.',
});

const CreateNoticeBody = z
  .object({
    tenancy_id: z.string().uuid(),
    notice_type: z.string().min(1).max(100),
    served_at: ServedAt.optional(),
    served_method: z.string().min(1).max(100).optional(),
    body: z.string().max(10000).optional(),
    document: z.record(z.unknown()).optional(),
  })
  .openapi('CreateNoticeBody');

const PatchNoticeBody = z
  .object({
    served_at: ServedAt.nullable().optional(),
    served_method: z.string().min(1).max(100).nullable().optional(),
    body: z.string().max(10000).nullable().optional(),
    document: z.record(z.unknown()).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchNoticeBody');

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
  tenancy_id: z.string().uuid().optional(),
});

const ListResponse = z
  .object({ data: z.array(Notice), next_cursor: z.string().nullable() })
  .openapi('NoticeListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/notices',
  tags: ['notices'],
  summary: 'List notices (filterable by tenancy_id)',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/notices/{id}',
  tags: ['notices'],
  summary: 'Get one notice',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'notice', content: { 'application/json': { schema: Notice } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/notices',
  tags: ['notices'],
  summary: 'Create a notice attached to a tenancy',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateNoticeBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Notice } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/notices/{id}',
  tags: ['notices'],
  summary: 'Update a notice (partial)',
  description:
    'A free-floating notice is fully editable (drafting is normal). A notice that ' +
    'anchors a live rent schedule is evidence of the increase and is write-blocked ' +
    'ENTIRELY: any PATCH is rejected 409 instrument_anchored — serve a new notice ' +
    'and change rent again, or delete the never-billed schedule to release it.',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchNoticeBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Notice } } },
    ...errorResponses,
    ...conflictResponse,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/notices/{id}',
  tags: ['notices'],
  summary: 'Soft-delete a notice',
  description:
    'Rejected 409 instrument_anchored while the notice anchors a live rent schedule ' +
    '(it is the instrument of record for that billing era).',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
    ...conflictResponse,
  },
});

export const noticesApp = newApiApp();

noticesApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('notices').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

noticesApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('notices')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Notice>, 200);
});

noticesApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('notices')
    .insert({
      account_id: accountId,
      tenancy_id: body.tenancy_id,
      notice_type: body.notice_type,
      served_at: body.served_at ?? null,
      served_method: body.served_method ?? null,
      body: body.body ?? null,
      document: body.document ?? {},
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'tenancy_id does not belong to this account');
    }
    if (error.code === '23514') {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof Notice>, 201);
});

noticesApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // A notice that anchors a live rent schedule is immutable: PATCH is blocked
  // ENTIRELY (not just for served_at) because the notice is now the evidence
  // that authorised a billing increase. The source_notice_id column arrives with
  // migration 20260706000001; on a not-yet-migrated DB this filter errors on the
  // unknown column -- treat that as "no anchor" (nothing can be anchored before
  // the feature ships) and fall through. The DB trigger is the authoritative
  // backstop; the error branch below maps a racing trigger fire to the same 409.
  const anchored = await sb
    .from('rent_schedules')
    .select('id')
    .eq('account_id', accountId)
    .eq('source_notice_id', id)
    .is('deleted_at', null)
    .limit(1);
  if (!anchored.error && (anchored.data?.length ?? 0) > 0) {
    throw new ApiError(
      409,
      'instrument_anchored',
      'notice anchors a rent schedule; it is the instrument of record — create a new notice instead',
    );
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.served_at !== undefined) update.served_at = body.served_at;
  if (body.served_method !== undefined) update.served_method = body.served_method;
  if (body.body !== undefined) update.body = body.body;
  if (body.document !== undefined) update.document = body.document;
  const { data, error } = await sb
    .from('notices')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    if (isRentInstrumentReject(error.message)) {
      throw new ApiError(
        409,
        'instrument_anchored',
        'notice anchors a rent schedule; it is the instrument of record — create a new notice instead',
      );
    }
    if (error.code === '23514') {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Notice>, 200);
});

noticesApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);

  // A notice that anchors a live rent schedule cannot be deleted -- it is the
  // instrument of record for the billing era. Deploy-window handling mirrors the
  // PATCH pre-check above; the DB trigger is the authoritative backstop.
  const anchored = await sb
    .from('rent_schedules')
    .select('id')
    .eq('account_id', accountId)
    .eq('source_notice_id', id)
    .is('deleted_at', null)
    .limit(1);
  if (!anchored.error && (anchored.data?.length ?? 0) > 0) {
    throw new ApiError(
      409,
      'instrument_anchored',
      'notice anchors a rent schedule; it is the instrument of record and cannot be deleted',
    );
  }

  const { data, error } = await sb
    .from('notices')
    .update({ deleted_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    if (isRentInstrumentReject(error.message)) {
      throw new ApiError(
        409,
        'instrument_anchored',
        'notice anchors a rent schedule; it is the instrument of record and cannot be deleted',
      );
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});
