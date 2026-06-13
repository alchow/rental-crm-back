import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { withResolvedAuthorship } from './_lib/authorship';
import { assertAgentJournalWrite } from './_lib/agent-firewall';

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
const Channel   = z.enum(['in_person', 'phone', 'voicemail', 'sms', 'email', 'letter', 'in_app', 'import', 'note', 'agent_event']);
const Direction = z.enum(['inbound', 'outbound', 'none']);
const Kind = z.enum(['communication', 'note', 'agent_event']);
const CorrectionKind = z.enum(['amend', 'retract']);

// Read-side output enum (identical to input after Workstream D lands both):
// kind='agent_event' and channel='agent_event' are accepted in the body but
// gated by the firewall -- a landlord who sends kind='agent_event' gets 403.
const KindOut = z.enum(['communication', 'note', 'agent_event']);
const ChannelOut = z.enum([
  'in_person', 'phone', 'voicemail', 'sms', 'email', 'letter', 'in_app',
  'import', 'note', 'agent_event',
]);
const EntryType = z.enum([
  'proposal_created', 'proposal_approved', 'proposal_rejected', 'step_executed',
  'proposal_failed', 'proposal_blocked', 'resume_target_dead', 'proposal_superseded',
]);
const AuthorType = z.enum(['landlord', 'tenant', 'vendor', 'agent', 'system']);

// Exported: the messages route returns the journal entry created by a
// confirmed send and must reference THIS schema so the SDK contract is typed.
export const Interaction = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    actor: z.string(),
    party_type: PartyType,
    party_id: z.string().uuid().nullable(),
    party_label: z.string().nullable(),
    channel: ChannelOut,
    direction: Direction,
    body: z.string().nullable(),
    occurred_at: z.string(),
    logged_at: z.string(),
    kind: KindOut,
    /** Authorship capacity. Stamped from the resolved principal on new
     *  writes; resolved from `actor` for pre-capacity rows. Never null on
     *  the wire (ADR-0008). */
    author_type: AuthorType,
    /** Landlord user who explicitly approved an agent-authored entry. */
    approved_by: z.string().uuid().nullable(),
    /** Opaque agent-side approval/proposal reference. */
    approval_ref: z.string().nullable(),
    /** Agent exhaust vocabulary; set exactly on kind='agent_event' rows. */
    entry_type: EntryType.nullable(),
    /** Provider-side message id (e.g. Twilio MessageSid) on send-pipeline rows. */
    external_ref: z.string().nullable(),
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
    /** The prior interaction / journal entry this entry references — e.g. a
     *  step_executed agent_event anchored to the proposal it acts on. Null
     *  when unset. */
    references_interaction_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
    /** Derived from the linked message_outbox row via the view join.
     *  Null on entries that were not produced by the send pipeline
     *  (e.g. direct journal notes, logged phone calls). */
    delivery_status: z
      .enum(['sending', 'sent', 'delivered', 'failed', 'undeliverable', 'needs_reconcile'])
      .nullable(),
    delivered_at: z.string().nullable(),
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
    /** Defaults to 'communication'. A correction always inherits the original's kind.
     *  'agent_event' is agent-principal only (firewall enforced). */
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
    /** Agent-principal only: structured entry vocabulary. Forbidden on
     *  kind='communication'|'note'; forbidden together with corrects_id. */
    entry_type: EntryType.optional(),
    /** Landlord user who explicitly approved this agent-authored entry. */
    approved_by: z.string().uuid().optional(),
    /** Opaque agent-side approval/proposal reference. */
    approval_ref: z.string().min(1).max(200).optional(),
    /** Optional same-account reference to a prior interaction / journal entry
     *  this entry follows from. Primarily used by step_executed agent_events to
     *  anchor to the entry they act on (and satisfies the firewall's
     *  step_executed entity-ref requirement), but handled like any other
     *  context ref. */
    references_interaction_id: z.string().uuid().optional().openapi({
      description: "Same-account reference to a prior interaction / journal entry this entry follows from (e.g. a step_executed agent_event's anchor).",
    }),
  })
  .superRefine((b, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if ((b.corrects_id === undefined) !== (b.correction_kind === undefined)) {
      issue('correction_kind', 'corrects_id and correction_kind must be provided together');
      return;
    }

    // entry_type is forbidden on a correction (corrections inherit kind;
    // entry_type is stamped from the original).
    if (b.corrects_id !== undefined && b.entry_type !== undefined) {
      issue('entry_type', 'entry_type is inherited from the corrected entry and cannot be supplied on a correction');
    }

    if (b.corrects_id !== undefined) {
      if (b.body === undefined) {
        issue('body', 'a correction requires body (amend: corrected content; retract: reason)');
      }
      if (b.correction_kind === 'retract') {
        const forbidden = [
          'kind', 'party_type', 'party_id', 'party_label', 'channel', 'direction',
          'occurred_at', 'tenancy_id', 'maintenance_request_id', 'area_id',
          'work_order_id', 'vendor_id', 'references_interaction_id',
        ] as const;
        for (const f of forbidden) {
          if (b[f] !== undefined) {
            issue(f, 'a retraction carries only the reason (body); everything else is inherited from the original');
          }
        }
      }
      return;
    }

    const kind = b.kind ?? 'communication';

    if (kind === 'agent_event') {
      // occurred_at required for agent_events (they are timestamped machine exhaust).
      if (b.occurred_at === undefined) issue('occurred_at', 'occurred_at is required');
      // entry_type required: every agent_event must carry structured vocabulary.
      if (b.entry_type === undefined) issue('entry_type', 'entry_type is required for kind=\'agent_event\'');
      // channel must be the sentinel or omitted.
      if (b.channel !== undefined && b.channel !== 'agent_event') {
        issue('channel', "channel must be 'agent_event' or omitted for kind='agent_event'");
      }
      // direction must be 'none' or omitted.
      if (b.direction !== undefined && b.direction !== 'none') {
        issue('direction', "direction must be 'none' or omitted for kind='agent_event'");
      }
      // party_type must be 'none' or omitted.
      if (b.party_type !== undefined && b.party_type !== 'none') {
        issue('party_type', "party_type must be 'none' or omitted for kind='agent_event'");
      }
      // party_id and party_label are forbidden (no counterparty on a machine event).
      if (b.party_id !== undefined) issue('party_id', "party_id is forbidden for kind='agent_event'");
      if (b.party_label !== undefined) issue('party_label', "party_label is forbidden for kind='agent_event'");
      return;
    }

    // entry_type is forbidden on communication/note (it pairs exclusively with agent_event).
    if (b.entry_type !== undefined) {
      issue('entry_type', "entry_type is only valid for kind='agent_event'");
    }

    if (b.occurred_at === undefined) issue('occurred_at', 'occurred_at is required');

    if (kind === 'communication') {
      if (b.channel === undefined) issue('channel', 'channel is required for a communication');
      if (b.direction === undefined) issue('direction', 'direction is required for a communication');
      if (b.party_type === undefined) issue('party_type', 'party_type is required for a communication');
      if (b.direction === 'none' && b.channel !== 'import') {
        issue('direction', "direction 'none' is only valid for channel 'import'");
      }
      if (b.channel === 'note') issue('channel', "channel 'note' is reserved for kind='note'");
      if (b.channel === 'agent_event') issue('channel', "channel 'agent_event' is reserved for kind='agent_event'");
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

export const interactionsApp = newApiApp();

interactionsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { cursor, limit, tenancy_id, maintenance_request_id, latest_only } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb
    .from('interactions_with_chain')
    .select('*')
    .eq('account_id', accountId)
    .is('deleted_at', null);
  if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
  if (maintenance_request_id) q = q.eq('maintenance_request_id', maintenance_request_id);
  if (latest_only === 'true') q = q.eq('is_head', true);
  const { items, next_cursor: nextCursor } = await keysetPage(q, {
    cursor,
    limit,
    column: 'occurred_at',
  });
  const data = (items as { author_type?: string | null; actor: string }[]).map(
    withResolvedAuthorship,
  );
  return c.json({ data, next_cursor: nextCursor } as z.infer<typeof ListResponse>, 200);
});

interactionsApp.openapi(get, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('interactions_with_chain')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  return c.json(
    withResolvedAuthorship(data as { author_type?: string | null; actor: string }) as z.infer<
      typeof Interaction
    >,
    200,
  );
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
  if (row.kind === 'agent_event') {
    if (
      row.channel !== 'agent_event' || row.direction !== 'none' || row.party_type !== 'none' ||
      row.party_id !== null || row.party_label !== null
    ) {
      throw new ApiError(400, 'invalid_request', 'an agent_event correction cannot change the event shape (channel/direction/party fields)');
    }
    return;
  }
  if (row.channel === 'agent_event') {
    throw new ApiError(400, 'invalid_request', "channel 'agent_event' is reserved for kind='agent_event'");
  }
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
  const sb = getSb(c);
  const auth = c.get('auth');
  const principal = c.get('principal');

  // Firewall: enforce the write vocabulary permitted to each principal type.
  // Landlord checks are fast path (no DB). Agent checks may also be fast.
  // Both run before any DB write so violations never touch the journal.
  assertAgentJournalWrite(principal, body);

  // actor is derived from the authenticated user; the audit chain records the
  // same value via auth.uid(). Agent-authored rows use actor='user:<agent-uuid>'
  // (truthful -- it IS that principal); author_type is the capacity signal
  // (ADR-0006/0008). No 'agent:' prefix here.
  const actor = `user:${auth.userId}`;

  // author_type is stamped from the resolved principal, never client-supplied.
  const authorType = principal.type === 'agent' ? 'agent' : 'landlord';

  // When approved_by is supplied (agent paths only, post-firewall), verify
  // the target is a real, non-agent member of this account. The RPC uses
  // security definer so it can see other members despite self-only RLS.
  if (body.approved_by !== undefined) {
    const { data: ok } = await sb.rpc('is_approver_member', {
      p_account_id: accountId,
      p_user_id: body.approved_by,
    });
    if (!ok) {
      throw new ApiError(400, 'invalid_request', 'approved_by must be a non-agent member of this account');
    }
  }

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
      // The CORRECTOR's capacity, not the original author's: a landlord
      // retracting an agent entry is a landlord-authored row. approval and
      // external_ref stay with the original row they attest to; entry_type
      // is inherited (DB pairing: an agent_event correction is an
      // agent_event and must carry its type).
      author_type: authorType,
      approved_by: null,
      approval_ref: null,
      entry_type: original.entry_type ?? null,
      external_ref: null,
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
      references_interaction_id: isAmend
        ? (body.references_interaction_id ?? original.references_interaction_id)
        : original.references_interaction_id,
    };
    assertCoherentShape(row as Parameters<typeof assertCoherentShape>[0]);
  } else if ((body.kind ?? 'communication') === 'agent_event') {
    // Agent exhaust entry: structured machine event with sentinel shape.
    row = {
      account_id: accountId,
      actor,
      author_type: authorType,
      approved_by: body.approved_by ?? null,
      approval_ref: body.approval_ref ?? null,
      entry_type: body.entry_type ?? null,
      external_ref: null,
      kind: 'agent_event',
      party_type: 'none',
      party_id: null,
      party_label: null,
      channel: 'agent_event',
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
      references_interaction_id: body.references_interaction_id ?? null,
    };
  } else if ((body.kind ?? 'communication') === 'note') {
    row = {
      account_id: accountId,
      actor,
      author_type: authorType,
      // Agent notes carry approval fields; landlord notes always null.
      approved_by: principal.type === 'agent' ? (body.approved_by ?? null) : null,
      approval_ref: principal.type === 'agent' ? (body.approval_ref ?? null) : null,
      entry_type: null,
      external_ref: null,
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
      references_interaction_id: body.references_interaction_id ?? null,
    };
  } else {
    row = {
      account_id: accountId,
      actor,
      author_type: authorType,
      approved_by: null,
      approval_ref: null,
      entry_type: null,
      external_ref: null,
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
      references_interaction_id: body.references_interaction_id ?? null,
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
  // moment ago: nothing can reference it yet, and there is no outbox row for
  // a directly-logged entry.
  return c.json(
    withResolvedAuthorship({
      ...data,
      superseded_by_id: null,
      is_head: true,
      delivery_status: null,
      delivered_at: null,
    }) as z.infer<typeof Interaction>,
    201,
  );
});
