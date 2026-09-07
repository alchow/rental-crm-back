import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import {
  asJson,
  nullableRpcArg,
  type DbFunctionArgs,
  type DbTableUpdate,
} from '../supabase/db-types';
import { ApiError, errorResponses, conflictResponse, mapPrefixedRpcError } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { CreateLeaseBody, CurrencyCode, LeaseStatus } from '../schemas/importable';

// The leases_guard trigger (ADR-0014) is the single enforcement point; each entry
// pins one of its RAISE messages to the code clients branch on.
const LEASE_CONFLICTS = [
  [/different rent/i, 'schedule_conflict'],
  [/anchors a rent schedule/i, 'instrument_anchored'],
  [/is superseded/i, 'lease_superseded'],
  [/is voided/i, 'lease_voided'],
  [/is executed/i, 'lease_executed'],
] as const;

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const VoidReason = z
  .string()
  .max(500)
  .refine((s) => s.trim().length > 0, { message: 'void_reason must not be blank' });

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
    voided_at: z.string().nullable(),
    void_reason: z.string().nullable(),
    corrects_lease_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Lease');

const PatchLeaseBody = z
  .object({
    term_start: DateString.optional(),
    term_end: DateString.nullable().optional(),
    rent_amount_cents: z.number().int().nonnegative().optional(),
    rent_currency: CurrencyCode.optional(),
    deposit_amount_cents: z.number().int().nonnegative().optional(),
    deposit_currency: CurrencyCode.nullable().optional(),
    document: z.record(z.unknown()).optional(),
    status: LeaseStatus.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' })
  .openapi('PatchLeaseBody');

const VoidLeaseBody = z.object({ void_reason: VoidReason }).openapi('VoidLeaseBody');

const ReplaceLeaseBody = z
  .object({
    void_reason: VoidReason,
    lease: z
      .object({
        term_start: DateString,
        term_end: DateString.nullable().optional(),
        rent_amount_cents: z.number().int().nonnegative(),
        rent_currency: CurrencyCode,
        deposit_amount_cents: z.number().int().nonnegative().optional().default(0),
        deposit_currency: CurrencyCode.nullable().optional(),
        document: z.record(z.unknown()).optional(),
      })
      .refine((b) => b.deposit_amount_cents === 0 || b.deposit_currency != null, {
        message: 'deposit_currency is required when deposit_amount_cents > 0',
      }),
  })
  .openapi('ReplaceLeaseBody');

const ReplaceLeaseResult = z
  .object({
    voided: Lease,
    replacement: Lease,
    repointed_schedule_ids: z.array(z.string().uuid()),
  })
  .openapi('ReplaceLeaseResult');

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
  description:
    'Voided leases are returned (voided_at/void_reason set). There is no delete: ' +
    'a lease leaves service by POST .../void with a reason.',
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
  description:
    'corrects_lease_id, when given, must name a voided lease of the same tenancy ' +
    '(400 otherwise). For an atomic correction use POST .../leases/{id}/replace.',
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
    'Mutability by status — draft: every field; active/expired (executed): term_end, ' +
    'deposit_*, document, status; superseded: nothing; voided: nothing. Status only ' +
    'moves forward (draft→active|expired|superseded, active→expired|superseded). ' +
    'Re-sending an unchanged value is a no-op. Refusals: 409 lease_executed (a ' +
    'differing term_start/rent_amount_cents/rent_currency or a backward status on an ' +
    'executed lease — record a rent change via rent-changes, or a correction via ' +
    'replace), 409 lease_superseded, 409 lease_voided; 400 on unknown fields or ' +
    'CHECK violations (e.g. term_end before term_start).',
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
const voidRoute = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/leases/{id}/void',
  tags: ['leases'],
  summary: 'Void a lease',
  description:
    'Sets voided_at and void_reason; the row stays readable and accepts no further ' +
    'change. Voiding does not stop billing: rent schedules keep emitting charges. ' +
    '409 instrument_anchored while a live rent schedule names the lease as ' +
    'source_lease_id — use replace, or delete that schedule first. 404 when the ' +
    'lease is missing or already voided.',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: VoidLeaseBody } }, required: true },
  },
  responses: {
    200: { description: 'voided', content: { 'application/json': { schema: Lease } } },
    ...errorResponses,
    ...conflictResponse,
  },
});
const replace = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/leases/{id}/replace',
  tags: ['leases'],
  summary: 'Void a lease and create its corrected replacement atomically',
  description:
    'Voids the lease with void_reason, creates the replacement from `lease` (same ' +
    'tenancy and status, corrects_lease_id = this lease), and re-points live rent ' +
    'schedules anchored on it. 409 schedule_conflict when an anchored schedule bills a ' +
    'different rent than the replacement (void its charges, delete the schedule, ' +
    'replace, then record a rent change); 409 lease_voided when already voided; 400 on ' +
    'invalid lease fields.',
  request: {
    params: AccountAndIdParam,
    body: { content: { 'application/json': { schema: ReplaceLeaseBody } }, required: true },
  },
  responses: {
    200: {
      description: 'replaced',
      content: { 'application/json': { schema: ReplaceLeaseResult } },
    },
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
      document: asJson(body.document ?? {}),
      status: body.status,
      corrects_lease_id: body.corrects_lease_id ?? null,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'tenancy_id does not belong to this account');
    }
    throw mapPrefixedRpcError(error, LEASE_CONFLICTS);
  }
  return c.json(data as z.infer<typeof Lease>, 201);
});

leasesApp.openapi(patch, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { document, ...fields } = c.req.valid('json');
  const sb = getSb(c);
  const update: DbTableUpdate<'leases'> = { ...fields, updated_at: new Date().toISOString() };
  if (document !== undefined) update.document = asJson(document);
  const { data, error } = await sb
    .from('leases')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw mapPrefixedRpcError(error, LEASE_CONFLICTS);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Lease>, 200);
});

leasesApp.openapi(voidRoute, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { void_reason } = c.req.valid('json');
  const sb = getSb(c);
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from('leases')
    .update({ voided_at: now, void_reason, updated_at: now })
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .is('voided_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw mapPrefixedRpcError(error, LEASE_CONFLICTS);
  if (!data) throw new ApiError(404, 'not_found', 'lease not found or already voided');
  return c.json(data as z.infer<typeof Lease>, 200);
});

leasesApp.openapi(replace, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const { void_reason, lease } = c.req.valid('json');
  const sb = getSb(c);
  const params: DbFunctionArgs<'replace_lease'> = {
    p_account_id: accountId,
    p_lease_id: id,
    p_void_reason: void_reason,
    p_term_start: lease.term_start,
    p_term_end: nullableRpcArg(lease.term_end ?? null),
    p_rent_amount_cents: lease.rent_amount_cents,
    p_rent_currency: lease.rent_currency,
    p_deposit_amount_cents: lease.deposit_amount_cents,
    p_deposit_currency: nullableRpcArg(lease.deposit_currency ?? null),
    p_document: asJson(lease.document ?? {}),
  };
  const { data, error } = await sb.rpc('replace_lease', params);
  if (error) throw mapPrefixedRpcError(error, LEASE_CONFLICTS);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { o_voided_id: string; o_replacement_id: string; o_repointed_schedule_ids: string[] }
    | null
    | undefined;
  if (!row) throw new ApiError(500, 'database_error', 'replace_lease returned no row');

  const { data: rows, error: fetchErr } = await sb
    .from('leases')
    .select('*')
    .eq('account_id', accountId)
    .in('id', [row.o_voided_id, row.o_replacement_id]);
  if (fetchErr) throw new ApiError(500, 'database_error', fetchErr.message);
  const voided = rows?.find((r) => r.id === row.o_voided_id);
  const replacement = rows?.find((r) => r.id === row.o_replacement_id);
  if (!voided || !replacement) {
    throw new ApiError(500, 'database_error', 'lease not found after replace');
  }
  return c.json(
    {
      voided: voided as z.infer<typeof Lease>,
      replacement: replacement as z.infer<typeof Lease>,
      repointed_schedule_ids: row.o_repointed_schedule_ids ?? [],
    } as z.infer<typeof ReplaceLeaseResult>,
    200,
  );
});
