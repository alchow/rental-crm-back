import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getUserClient } from '../supabase/user-client';
import { ApiError, errorResponses } from './_lib/error';
import { decodeCursor, encodeCursor } from './_lib/cursor';

// The channel-aware contact log. The high-stakes records are OFFLINE
// contacts logged after the fact -- a doorstep conversation, a phone call,
// a verbal "I'll let it slide three days." This is the single log; intake
// submissions land here too (via the public POST /v1/intake/:token in
// src/admin/intake.ts, which sets actor=tenant:<token_id>).
//
// Server-set immutable: logged_at (DB trigger from Phase 3 rejects any
// UPDATE that touches it). The CREATE body accepts only occurred_at; the
// route never trusts a client-supplied logged_at and never sets one.

const PartyType = z.enum(['tenant', 'vendor', 'inspector', 'other']);
const Channel   = z.enum(['in_person', 'phone', 'voicemail', 'sms', 'email', 'letter', 'in_app']);
const Direction = z.enum(['inbound', 'outbound']);

const Interaction = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    actor: z.string(),
    party_type: PartyType,
    party_id: z.string().uuid().nullable(),
    party_label: z.string().nullable(),
    channel: Channel,
    direction: Direction,
    body: z.string().nullable(),
    occurred_at: z.string(),
    logged_at: z.string(),
    tenancy_id: z.string().uuid().nullable(),
    maintenance_request_id: z.string().uuid().nullable(),
    area_id: z.string().uuid().nullable(),
    work_order_id: z.string().uuid().nullable(),
    vendor_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .openapi('Interaction');

const CreateBody = z
  .object({
    party_type: PartyType,
    party_id: z.string().uuid().optional(),
    party_label: z.string().max(200).optional(),
    channel: Channel,
    direction: Direction,
    body: z.string().max(20000).optional(),
    /** When the contact actually happened. logged_at is set by the server. */
    occurred_at: z.string().datetime(),
    tenancy_id: z.string().uuid().optional(),
    maintenance_request_id: z.string().uuid().optional(),
    area_id: z.string().uuid().optional(),
    work_order_id: z.string().uuid().optional(),
    vendor_id: z.string().uuid().optional(),
  })
  .openapi('CreateInteractionBody');

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
  maintenance_request_id: z.string().uuid().optional(),
});
const ListResponse = z
  .object({ data: z.array(Interaction), next_cursor: z.string().nullable() })
  .openapi('InteractionListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/interactions',
  tags: ['interactions'],
  request: { params: AccountParam, query: ListQuery },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: ListResponse } } },
    ...errorResponses,
  },
});
const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/interactions/{id}',
  tags: ['interactions'],
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'interaction', content: { 'application/json': { schema: Interaction } } },
    ...errorResponses,
  },
});
const create = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/interactions',
  tags: ['interactions'],
  summary: 'Log a contact (offline call, doorstep conversation, etc.). logged_at is server-set.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Interaction } } },
    ...errorResponses,
  },
});

export const interactionsApp = new OpenAPIHono();

interactionsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id, maintenance_request_id } = c.req.valid('query');
  const sb = getUserClient(c.get('auth').accessToken);
  let q = sb.from('interactions').select('*').eq('account_id', accountId).is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  if (maintenance_request_id) q = q.eq('maintenance_request_id', maintenance_request_id);
  q = q
    .order('occurred_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit + 1);
  if (cursor) {
    const cur = decodeCursor(cursor);
    if (cur) {
      q = q.or(
        `occurred_at.gt.${cur.created_at},and(occurred_at.eq.${cur.created_at},id.gt.${cur.id})`,
      );
    }
  }
  const { data, error } = await q;
  if (error) throw new ApiError(500, 'database_error', error.message);
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ created_at: String(last.occurred_at), id: String(last.id) })
      : null;
  return c.json({ data: items, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

interactionsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);
  const { data, error } = await sb
    .from('interactions')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Interaction>, 200);
});

interactionsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const auth = c.get('auth');

  // actor is derived from the authenticated user; the Phase 4 actor-integrity
  // trigger logic for the audit chain will set the same thing on the audit
  // event. We persist it here so the row carries its own actor field too.
  const actor = `user:${auth.userId}`;
  const { data, error } = await sb
    .from('interactions')
    .insert({
      account_id: accountId,
      actor,
      party_type: body.party_type,
      party_id: body.party_id ?? null,
      party_label: body.party_label ?? null,
      channel: body.channel,
      direction: body.direction,
      body: body.body ?? null,
      occurred_at: body.occurred_at,
      // logged_at not passed -- DB default = now(); Phase 3 immutability
      // trigger blocks any later UPDATE that changes it.
      tenancy_id: body.tenancy_id ?? null,
      maintenance_request_id: body.maintenance_request_id ?? null,
      area_id: body.area_id ?? null,
      work_order_id: body.work_order_id ?? null,
      vendor_id: body.vendor_id ?? null,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'a referenced row does not belong to this account');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  return c.json(data as z.infer<typeof Interaction>, 201);
});
