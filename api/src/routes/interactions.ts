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
//
// Evidentiary journal: the table is append-only -- there is no PATCH and no
// DELETE, deliberately. A "correction", a "retraction" and a "note" are all
// just NEW immutable rows:
//
//   kind='note'                       dated observation, no counterparty
//                                     ("inspected roof, cracked tile")
//   corrects_id + correction_kind     this row supersedes corrects_id;
//                                     'amend' (body = corrected content) or
//                                     'retract' (body = reason)
//
// The original row is never written to. Supersession (superseded_by_id,
// is_head) is DERIVED from the forward corrects_id link by the
// interactions_with_chain view; chains are linear by DB invariant (partial
// unique index on corrects_id) and same-account by composite FK. The
// collapsed ?latest_only=true view is a client convenience -- the full set
// is the default and the evidence export always renders complete chains.

// 'import' + 'none' exist for the onboarding import: an imported journal
// note is not a communication, so it carries no real channel/direction.
// 'note' follows the same precedent for user-logged observations: a note
// stores channel='note', direction='none', party_type='none' (sentinels,
// valid ONLY in that combination; DB checks mirror the refines on
// CreateInteractionBody below) rather than nullable columns.
const PartyType = z.enum(['tenant', 'vendor', 'inspector', 'other', 'none']);
const Channel   = z.enum(['in_person', 'phone', 'voicemail', 'sms', 'email', 'letter', 'in_app', 'import', 'note']);
const Direction = z.enum(['inbound', 'outbound', 'none']);
const Kind = z.enum(['communication', 'note']);
const CorrectionKind = z.enum(['amend', 'retract']);

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
    kind: Kind,
    /** Set on a correcting entry: the id of the entry this row supersedes. */
    corrects_id: z.string().uuid().nullable(),
    correction_kind: CorrectionKind.nullable(),
    /** Derived: id of the entry that corrects this one (forward link), or null. */
    superseded_by_id: z.string().uuid().nullable(),
    /** Derived: true when no entry corrects this one. */
    is_head: z.boolean(),
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

// Exported: the import executor validates through THIS schema (house rule:
// the import path can never persist anything an HTTP POST would reject).
//
// Three creation shapes, one schema (the superRefine below enforces the
// matrix):
//   communication  channel + direction + party_type + occurred_at required
//                  (today's behavior, unchanged)
//   note           occurred_at required; channel/direction/party_type may
//                  be omitted (server fills the sentinels) or sent as the
//                  sentinels; no counterparty fields
//   correction     corrects_id + correction_kind + body required; context
//                  fields are inherited from the original server-side.
//                  'amend' may override them; 'retract' carries ONLY the
//                  reason in body.
export const CreateInteractionBody = z
  .object({
    /** Defaults to 'communication'. A correction always inherits the original's kind. */
    kind: Kind.optional(),
    party_type: PartyType.optional(),
    party_id: z.string().uuid().optional(),
    party_label: z.string().max(200).optional(),
    channel: Channel.optional(),
    direction: Direction.optional(),
    body: z.string().max(20000).optional(),
    /** When the contact actually happened. logged_at is set by the server.
     *  Optional on a correction (defaults to the original's occurred_at --
     *  same event, same timeline position). */
    occurred_at: z.string().datetime().optional(),
    /** Makes this entry a correction: the id of the entry it supersedes.
     *  The original row is never mutated. */
    corrects_id: z.string().uuid().optional(),
    correction_kind: CorrectionKind.optional(),
    tenancy_id: z.string().uuid().optional(),
    maintenance_request_id: z.string().uuid().optional(),
    area_id: z.string().uuid().optional(),
    work_order_id: z.string().uuid().optional(),
    vendor_id: z.string().uuid().optional(),
  })
  .superRefine((b, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if ((b.corrects_id === undefined) !== (b.correction_kind === undefined)) {
      issue('correction_kind', 'corrects_id and correction_kind must be provided together');
      return;
    }

    if (b.corrects_id !== undefined) {
      if (b.body === undefined) {
        issue('body', 'a correction requires body (amend: corrected content; retract: reason)');
      }
      if (b.correction_kind === 'retract') {
        const forbidden = [
          'kind', 'party_type', 'party_id', 'party_label', 'channel', 'direction',
          'occurred_at', 'tenancy_id', 'maintenance_request_id', 'area_id',
          'work_order_id', 'vendor_id',
        ] as const;
        for (const f of forbidden) {
          if (b[f] !== undefined) {
            issue(f, 'a retraction carries only the reason (body); everything else is inherited from the original');
          }
        }
      }
      return;
    }

    if (b.occurred_at === undefined) issue('occurred_at', 'occurred_at is required');

    if ((b.kind ?? 'communication') === 'communication') {
      if (b.channel === undefined) issue('channel', 'channel is required for a communication');
      if (b.direction === undefined) issue('direction', 'direction is required for a communication');
      if (b.party_type === undefined) issue('party_type', 'party_type is required for a communication');
      if (b.direction === 'none' && b.channel !== 'import') {
        issue('direction', "direction 'none' is only valid for channel 'import'");
      }
      if (b.channel === 'note') issue('channel', "channel 'note' is reserved for kind='note'");
      if (b.party_type === 'none') issue('party_type', "party_type 'none' is reserved for kind='note'");
    } else {
      // note: a dated observation with no counterparty. The sentinel values
      // may be sent explicitly but nothing else.
      if (b.channel !== undefined && b.channel !== 'note') {
        issue('channel', "a note has no channel (omit it, or send 'note')");
      }
      if (b.direction !== undefined && b.direction !== 'none') {
        issue('direction', "a note has no direction (omit it, or send 'none')");
      }
      if (b.party_type !== undefined && b.party_type !== 'none') {
        issue('party_type', "a note has no counterparty (omit party_type, or send 'none')");
      }
      if (b.party_id !== undefined) issue('party_id', 'a note has no counterparty');
      if (b.party_label !== undefined) issue('party_label', 'a note has no counterparty');
    }
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
  /** 'true' returns only chain heads (the collapsed view). Default: the
   *  full set, so clients and the evidence export can reconstruct chains. */
  latest_only: z.enum(['true', 'false']).optional(),
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
  summary:
    'Log a contact, a note, or a correction/retraction of an earlier entry. ' +
    'logged_at is server-set. Corrections are new immutable rows (the log is ' +
    'append-only); correcting a non-head or retracted entry returns 409.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateInteractionBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: Interaction } } },
    ...errorResponses,
  },
});

export const interactionsApp = new OpenAPIHono();

interactionsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id, maintenance_request_id, latest_only } = c.req.valid('query');
  const sb = getUserClient(c.get('auth').accessToken);
  let q = sb
    .from('interactions_with_chain')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  if (maintenance_request_id) q = q.eq('maintenance_request_id', maintenance_request_id);
  if (latest_only === 'true') q = q.eq('is_head', true);
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
    .from('interactions_with_chain')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(data as z.infer<typeof Interaction>, 200);
});

// An amend may re-state context fields (it WAS a phone call, not in-person);
// the merged row must still be a coherent shape. The DB checks would also
// catch these, but as opaque 500s -- validate here so the client gets a 400
// it can act on.
function assertCoherentShape(row: {
  kind: string;
  channel: string;
  direction: string;
  party_type: string;
  party_id: unknown;
  party_label: unknown;
}): void {
  if (row.kind === 'note') {
    if (
      row.channel !== 'note' || row.direction !== 'none' || row.party_type !== 'none' ||
      row.party_id !== null || row.party_label !== null
    ) {
      throw new ApiError(400, 'invalid_request', 'a note correction cannot change the note shape (channel/direction/party fields)');
    }
    return;
  }
  if (row.channel === 'note') {
    throw new ApiError(400, 'invalid_request', "channel 'note' is reserved for kind='note'");
  }
  if (row.party_type === 'none') {
    throw new ApiError(400, 'invalid_request', "party_type 'none' is reserved for kind='note'");
  }
  if (row.direction === 'none' && row.channel !== 'import') {
    throw new ApiError(400, 'invalid_request', "direction 'none' is only valid for channel 'import'");
  }
}

interactionsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getUserClient(c.get('auth').accessToken);
  const auth = c.get('auth');

  // actor is derived from the authenticated user; the Phase 4 actor-integrity
  // trigger logic for the audit chain will set the same thing on the audit
  // event. We persist it here so the row carries its own actor field too.
  const actor = `user:${auth.userId}`;

  let row: Record<string, unknown>;

  if (body.corrects_id !== undefined) {
    // A correction NEVER writes to the original -- it only reads it, to
    // validate the target and inherit context fields. Read through the
    // chain view: superseded_by_id tells us head-ness in the same query.
    // RLS hides other accounts' rows, so cross-account targets 404 here
    // without leaking existence (the composite FK is the DB backstop).
    const { data: original, error: origErr } = await sb
      .from('interactions_with_chain')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', body.corrects_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (origErr) throw new ApiError(500, 'database_error', origErr.message);
    if (!original) throw new ApiError(404, 'not_found', 'not found');

    if (original.correction_kind === 'retract') {
      // A retracted head closes its chain: to re-state something after a
      // retraction, log a fresh entry.
      throw new ApiError(409, 'invalid_correction_target', 'the entry is retracted and its chain is closed; log a new entry instead');
    }
    if (original.superseded_by_id !== null) {
      throw new ApiError(409, 'invalid_correction_target', 'the entry is already superseded; correct the latest version of the chain');
    }
    if (body.kind !== undefined && body.kind !== original.kind) {
      throw new ApiError(400, 'invalid_request', "kind is inherited from the corrected entry and cannot change");
    }

    const isAmend = body.correction_kind === 'amend';
    row = {
      account_id: accountId,
      actor,
      kind: original.kind,
      party_type: isAmend ? (body.party_type ?? original.party_type) : original.party_type,
      party_id: isAmend ? (body.party_id ?? original.party_id) : original.party_id,
      party_label: isAmend ? (body.party_label ?? original.party_label) : original.party_label,
      channel: isAmend ? (body.channel ?? original.channel) : original.channel,
      direction: isAmend ? (body.direction ?? original.direction) : original.direction,
      body: body.body,
      // Same event -> same timeline position, unless an amend explicitly
      // re-dates it. logged_at stays server-set as always.
      occurred_at: isAmend ? (body.occurred_at ?? original.occurred_at) : original.occurred_at,
      corrects_id: body.corrects_id,
      correction_kind: body.correction_kind,
      tenancy_id: isAmend ? (body.tenancy_id ?? original.tenancy_id) : original.tenancy_id,
      maintenance_request_id: isAmend
        ? (body.maintenance_request_id ?? original.maintenance_request_id)
        : original.maintenance_request_id,
      area_id: isAmend ? (body.area_id ?? original.area_id) : original.area_id,
      work_order_id: isAmend ? (body.work_order_id ?? original.work_order_id) : original.work_order_id,
      vendor_id: isAmend ? (body.vendor_id ?? original.vendor_id) : original.vendor_id,
    };
    assertCoherentShape(row as Parameters<typeof assertCoherentShape>[0]);
  } else if ((body.kind ?? 'communication') === 'note') {
    row = {
      account_id: accountId,
      actor,
      kind: 'note',
      party_type: 'none',
      party_id: null,
      party_label: null,
      channel: 'note',
      direction: 'none',
      body: body.body ?? null,
      occurred_at: body.occurred_at,
      corrects_id: null,
      correction_kind: null,
      tenancy_id: body.tenancy_id ?? null,
      maintenance_request_id: body.maintenance_request_id ?? null,
      area_id: body.area_id ?? null,
      work_order_id: body.work_order_id ?? null,
      vendor_id: body.vendor_id ?? null,
    };
  } else {
    row = {
      account_id: accountId,
      actor,
      kind: 'communication',
      party_type: body.party_type,
      party_id: body.party_id ?? null,
      party_label: body.party_label ?? null,
      channel: body.channel,
      direction: body.direction,
      body: body.body ?? null,
      occurred_at: body.occurred_at,
      corrects_id: null,
      correction_kind: null,
      tenancy_id: body.tenancy_id ?? null,
      maintenance_request_id: body.maintenance_request_id ?? null,
      area_id: body.area_id ?? null,
      work_order_id: body.work_order_id ?? null,
      vendor_id: body.vendor_id ?? null,
    };
  }

  // logged_at not passed -- DB default = now(); Phase 3 immutability
  // trigger blocks any later UPDATE that changes it.
  const { data, error } = await sb.from('interactions').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505') {
      // interactions_corrects_id_uniq: we lost a race to correct the same
      // head. Chains stay linear by DB invariant, not just the check above.
      throw new ApiError(409, 'invalid_correction_target', 'the entry was corrected concurrently; correct the latest version of the chain');
    }
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'a referenced row does not belong to this account');
    }
    throw new ApiError(500, 'database_error', error.message);
  }
  // Derived fields, true by construction for a row that did not exist a
  // moment ago: nothing can reference it yet.
  return c.json(
    { ...data, superseded_by_id: null, is_head: true } as z.infer<typeof Interaction>,
    201,
  );
});
