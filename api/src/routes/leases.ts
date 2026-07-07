import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses, conflictResponse } from './_lib/error';
import { keysetPage } from './_lib/cursor';

// Leases attach to a tenancy. A tenancy can have zero, one, or many leases
// (handshake / month-to-month / holdover are first-class -- they're tenancies
// with no lease rows). The lease.rent_amount_cents is the CONTRACTED figure;
// what actually gets billed comes from rent_schedules in Phase 6. We keep
// them separate so a rent change mid-lease (concession, addendum) writes a
// new schedule without falsifying the lease record.

const LeaseStatus = z.enum(['draft', 'active', 'expired', 'superseded']);
const CurrencyCode = z.string().length(3); // ISO 4217-shaped; trust the DB check

// The rent-change migration (20260706000001) adds BEFORE triggers that reject
// resurrecting a superseded lease and soft-deleting a lease that anchors a live
// rent schedule -- the instrument-of-record precedent, mirroring the
// completed-inspection reject trigger the inspections route maps to 409. Those
// triggers raise the shared check_violation errcode (same as the coherence
// checks that map to 400), so -- exactly like inspections.ts -- we tell them
// apart by matching the raised MESSAGE. The API pre-checks handle the normal
// case; this fallback covers the race where the status/anchor changed between
// our read and the write.
function isRentInstrumentReject(msg: string): boolean {
  // The triggers raise 'lease <id> is anchored to a rent schedule and cannot
  // be deleted' / 'a superseded lease is a historical record; ...'; keep the
  // anchor pattern tolerant of both phrasings.
  return (
    /anchor(s|ed to) a (live )?rent[_ ]schedule/i.test(msg) ||
    /superseded lease/i.test(msg) ||
    /superseded and cannot/i.test(msg)
  );
}

const Lease = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    term_start: z.string(),
    term_end: z.string().nullable(),
    rent_amount_cents: z.number().int().nonnegative(),
    rent_currency: CurrencyCode,
    deposit_amount_cents: z.number().int().nonnegative(),
    deposit_currency: CurrencyCode.nullable(),
    document: z.record(z.unknown()),
    status: LeaseStatus,
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Lease');

// Exported for reuse by the onboarding-import executor (same-schema validation).
export const CreateLeaseBody = z
  .object({
    tenancy_id: z.string().uuid(),
    term_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    term_end: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    rent_amount_cents: z.number().int().nonnegative(),
    rent_currency: CurrencyCode,
    deposit_amount_cents: z.number().int().nonnegative().optional(),
    deposit_currency: CurrencyCode.optional(),
    document: z.record(z.unknown()).optional(),
    status: LeaseStatus,
  })
  .refine((b) => (b.deposit_amount_cents ?? 0) === 0 || b.deposit_currency !== undefined, {
    message: 'deposit_currency is required when deposit_amount_cents > 0',
  })
  .openapi('CreateLeaseBody');

// Rent terms (rent_amount_cents / rent_currency) are IMMUTABLE on a lease: the
// contracted figure is evidence of what was agreed, and a rent change is a new
// instrument (a renewal lease or a served notice), not an edit. Those two fields
// are intentionally absent here; the handler additionally rejects them loudly
// (zod would otherwise strip unknown keys and silently no-op an old client's
// rent edit). deposit_* stay patchable.
const PatchLeaseBody = z
  .object({
    term_end: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    deposit_amount_cents: z.number().int().nonnegative().optional(),
    deposit_currency: CurrencyCode.nullable().optional(),
    document: z.record(z.unknown()).optional(),
    status: LeaseStatus.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchLeaseBody');

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
  status: LeaseStatus.optional(),
});

const ListResponse = z
  .object({ data: z.array(Lease), next_cursor: z.string().nullable() })
  .openapi('LeaseListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/leases',
  tags: ['leases'],
  summary: 'List leases (filterable by tenancy_id and status)',
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/leases/{id}',
  tags: ['leases'],
  summary: 'Get one lease',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'lease', content: { 'application/json': { schema: Lease } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/leases',
  tags: ['leases'],
  summary: 'Create a lease attached to a tenancy',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateLeaseBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Lease } } },
    ...errorResponses,
  },
});
const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/leases/{id}',
  tags: ['leases'],
  summary: 'Update a lease (partial)',
  description:
    'term_end, deposit_*, document and allowed status transitions stay editable on ' +
    'every lease, including one that anchors a live rent schedule (anchoring blocks ' +
    'only soft-delete). Rent terms are immutable everywhere: a differing ' +
    'rent_amount_cents/rent_currency is rejected 400 (unchanged echoed values are ' +
    'tolerated) — use the rent-changes endpoint. Any transition out of ' +
    'status=superseded is rejected 409 lease_superseded.',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: PatchLeaseBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: Lease } } },
    ...errorResponses,
    ...conflictResponse,
  },
});
const remove = createRoute({
  method: 'delete',
  path: '/accounts/{accountId}/leases/{id}',
  tags: ['leases'],
  summary: 'Soft-delete a lease',
  description:
    'Rejected 409 instrument_anchored while the lease anchors a live rent schedule ' +
    '(it is the instrument of record for that billing era). Deleting the schedule ' +
    'first (DELETE /rent-schedules/{id}, never-billed only) releases the block.',
  request: { params: AccountAndIdParam },
  responses: {
    204: { description: 'deleted' },
    ...errorResponses,
    ...conflictResponse,
  },
});

export const leasesApp = newApiApp();

leasesApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id, status } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('leases').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  if (status) q = q.eq('status', status);
  const { items, next_cursor: nextCursor } = await keysetPage(q, { cursor, limit });
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

leasesApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('leases')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Lease>, 200);
});

leasesApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('leases')
    .insert({
      account_id: accountId,
      tenancy_id: body.tenancy_id,
      term_start: body.term_start,
      term_end: body.term_end ?? null,
      rent_amount_cents: body.rent_amount_cents,
      rent_currency: body.rent_currency,
      deposit_amount_cents: body.deposit_amount_cents ?? 0,
      deposit_currency: body.deposit_currency ?? null,
      document: body.document ?? {},
      status: body.status,
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
  return c.json(data as z.infer<typeof Lease>, 201);
});

leasesApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // zod already stripped rent_amount_cents / rent_currency out of `body`
  // (they're not in PatchLeaseBody). Re-read the raw body (Hono caches the
  // parsed JSON, so this doesn't re-consume the stream) so we can distinguish a
  // real rent EDIT from a harmless echo-back.
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sentAmount = Object.prototype.hasOwnProperty.call(raw, 'rent_amount_cents');
  const sentCurrency = Object.prototype.hasOwnProperty.call(raw, 'rent_currency');

  // Fetch the current row ONCE and reuse it for both guards below: the rent
  // echo-back tolerance (needs the stored rent to compare against) and the
  // superseded-resurrection guard (needs the stored status). Only fetch when a
  // guard actually needs it.
  let current: { rent_amount_cents: number; rent_currency: string; status: string } | null = null;
  if (sentAmount || sentCurrency || body.status !== undefined) {
    const cur = await sb
      .from('leases')
      .select('rent_amount_cents, rent_currency, status')
      .eq('account_id', accountId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (cur.error) throw new ApiError(500, 'database_error', cur.error.message);
    if (!cur.data) throw new ApiError(404, 'not_found', 'not found');
    current = cur.data as { rent_amount_cents: number; rent_currency: string; status: string };
  }

  // Rent terms (rent_amount_cents/rent_currency) are IMMUTABLE on a lease -- a
  // rent change is a new instrument, not an edit. But a read-modify-write client
  // that GETs the lease and PATCHes the whole object back re-sends the UNCHANGED
  // rent values; echoed state is not an edit, so we tolerate it. Compare each
  // sent key against the stored value (raw JSON number vs PostgREST's
  // number-typed bigint -> strict ===; currency is a plain string): all sent
  // values equal to stored -> ignore them and proceed; ANY difference -> 400
  // pointing the caller at the rent-change flow.
  if ((sentAmount || sentCurrency) && current) {
    const amountEchoed = !sentAmount || raw.rent_amount_cents === current.rent_amount_cents;
    const currencyEchoed = !sentCurrency || raw.rent_currency === current.rent_currency;
    if (!amountEchoed || !currencyEchoed) {
      throw new ApiError(
        400,
        'invalid_request',
        'rent terms are immutable on a lease; use POST /accounts/{accountId}/tenancies/{tenancyId}/rent-changes (fixed-term renewals supersede the lease)',
      );
    }
  }

  // A superseded lease is a historical record: a rent change replaced it with a
  // successor contract. Any transition OUT of superseded (resurrecting it to
  // active/draft/expired) is refused with a clean 409 -- create a new lease
  // instead. The DB trigger backstops active-resurrection specifically; this
  // API check gives the clean message and covers every transition off
  // superseded.
  if (
    current &&
    current.status === 'superseded' &&
    body.status !== undefined &&
    body.status !== 'superseded'
  ) {
    throw new ApiError(
      409,
      'lease_superseded',
      'a superseded lease is a historical record; create a new lease instead',
    );
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.term_end !== undefined) update.term_end = body.term_end;
  if (body.deposit_amount_cents !== undefined)
    update.deposit_amount_cents = body.deposit_amount_cents;
  if (body.deposit_currency !== undefined) update.deposit_currency = body.deposit_currency;
  if (body.document !== undefined) update.document = body.document;
  if (body.status !== undefined) update.status = body.status;
  const { data, error } = await sb
    .from('leases')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) {
    // Race backstop for the superseded-resurrection trigger (see
    // isRentInstrumentReject); checked before the coherence 23514 -> 400 path.
    // Only the F9 trigger can fire on PATCH (F7 needs a deleted_at transition,
    // which this handler never writes), so the code is always lease_superseded.
    if (isRentInstrumentReject(error.message)) {
      throw new ApiError(
        409,
        'lease_superseded',
        'a superseded lease is a historical record; create a new lease instead',
      );
    }
    if (error.code === '23514') {
      throw new ApiError(400, 'invalid_request', error.message);
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Lease>, 200);
});

leasesApp.openapi(remove, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);

  // A lease that anchors a live rent schedule is the instrument of record for
  // that billing era -- deleting it would orphan the successor schedule's
  // provenance. Refuse the soft-delete with a clean 409. The source_lease_id
  // column arrives with migration 20260706000001; on a not-yet-migrated DB
  // (code may lead schema in the deploy window) this filter errors on an unknown
  // column -- treat that as "no anchor" (no schedule can be anchored before the
  // feature is live) and fall through, exactly as the create handler tolerates
  // the same window. The DB trigger is the authoritative backstop.
  const anchored = await sb
    .from('rent_schedules')
    .select('id')
    .eq('account_id', accountId)
    .eq('source_lease_id', id)
    .is('deleted_at', null)
    .limit(1);
  if (!anchored.error && (anchored.data?.length ?? 0) > 0) {
    throw new ApiError(
      409,
      'instrument_anchored',
      'lease anchors a rent schedule; it is the instrument of record and cannot be deleted',
    );
  }

  const { data, error } = await sb
    .from('leases')
    .update({ deleted_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  if (error) {
    // Race backstop for the anchored-lease delete trigger.
    if (isRentInstrumentReject(error.message)) {
      throw new ApiError(
        409,
        'instrument_anchored',
        'lease anchors a rent schedule; it is the instrument of record and cannot be deleted',
      );
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.body(null, 204);
});
