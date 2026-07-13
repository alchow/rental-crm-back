import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { asDbInsert, asJson, nullableRpcArg } from '../supabase/db-types';
import { ApiError, dbError, ErrorEnvelope, errorResponses } from './_lib/error';
import { decodeCursor, encodeCursor, keysetPage } from './_lib/cursor';
import { withResolvedAuthorship } from './_lib/authorship';
import { assertAgentJournalWrite } from './_lib/agent-firewall';
import {
  CreateInteractionBody,
  Direction,
  Interaction,
  PartyType,
  type InteractionParticipantRow,
} from '../schemas/importable';

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
//                                     'amend' (body = corrected content),
//                                     'retract' (body = reason), or 'classify'
//                                     (metadata only: body + occurred_at
//                                     inherited, fill-only context fields)
//
// The original row is never written to. Supersession (superseded_by_id,
// is_head) is DERIVED from the forward corrects_id link by the
// interactions_with_chain view; chains are linear by DB invariant (partial
// unique index on corrects_id) and same-account by composite FK. The
// collapsed ?latest_only=true view is a client convenience -- the full set
// is the default and the evidence export always renders complete chains.

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
  maintenance_request_id: z.string().uuid().optional(),
  /** 'true' returns only chain heads (the collapsed view). Default: the
   *  full set, so clients and the evidence export can reconstruct chains. */
  latest_only: z.enum(['true', 'false']).optional(),
  /** Filter by counterparty attribution. party_type='unspecified' is the
   *  unresolved-sender queue: comm rows whose sender did not verify
   *  (sender_mismatch captures) waiting for a human classify. When party_id is
   *  ALSO present, party_type narrows the matched CAST leg (a tenant vs. a
   *  vendor participant), not the row slot. */
  party_type: PartyType.optional(),
  direction: Direction.optional(),
  /** Everything involving one person, resolved through the CAST
   *  (interaction_participants), not the legacy single-slot party_id — so a
   *  witnessed exchange or group message where the person is one of several
   *  participants still matches. Keyset pagination stays correct: the person is
   *  pruned by a SQL semi-join, never a materialized id set. */
  party_id: z.string().uuid().optional(),
  /** Filter to interactions scoped to one area (direct column on the row). */
  area_id: z.string().uuid().optional(),
  /** Derived through area_id; no duplicate property_id is stored on the journal row. */
  property_id: z.string().uuid().optional(),
});
const ListResponse = z
  .object({ data: z.array(Interaction), next_cursor: z.string().nullable() })
  .openapi('InteractionListResponse');

/** Batched cast loader: ONE query for a page of journal rows, bucketed by
 *  interaction id — the same embed pattern comms thread participants use
 *  (comms.ts loadParticipants). The cast belongs to the ROOT entry of a
 *  correction chain (the event record); correction rows read back with an
 *  empty cast of their own. */
export async function loadInteractionParticipants(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  interactionIds: string[],
): Promise<Map<string, InteractionParticipantRow[]>> {
  const map = new Map<string, InteractionParticipantRow[]>();
  if (interactionIds.length === 0) return map;
  const { data, error } = await sb
    .from('interaction_participants')
    .select('interaction_id, role, party_type, party_id, address, label, source')
    .eq('account_id', accountId)
    .in('interaction_id', interactionIds)
    .order('created_at', { ascending: true });
  if (error) throw new ApiError(500, 'database_error', error.message);
  for (const row of (data ?? []) as (InteractionParticipantRow & { interaction_id: string })[]) {
    const { interaction_id, ...entry } = row;
    const list = map.get(interaction_id) ?? [];
    list.push(entry);
    map.set(interaction_id, list);
  }
  return map;
}

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/interactions',
  tags: ['interactions'],
  summary: 'List interactions (filterable; keyset-paginated on occurred_at)',
  description:
    'Chronological journal feed. Filters: tenancy_id, maintenance_request_id, ' +
    'area_id, property_id, direction, party_type, latest_only, and party_id. `party_id` ' +
    'resolves the person through the CAST (interaction_participants), so a ' +
    'group message or witnessed exchange in which they were one of several ' +
    'participants still matches; combine it with party_type to narrow to that ' +
    "person's tenant vs. vendor leg. HEADS CAVEAT: the cast belongs to the " +
    'ROOT entry of a correction chain — a correction/retraction row carries no ' +
    'cast of its own. So `party_id` combined with `latest_only=true` can EXCLUDE ' +
    'a corrected communication whose current head is a castless correction row; ' +
    'omit latest_only (the default full set) to see every entry that names the ' +
    'person.',
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
    422: {
      description:
        'property_id has zero/multiple live units, or the supplied area_id is outside it',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    ...errorResponses,
  },
});

export const interactionsApp = newApiApp();

interactionsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const {
    cursor,
    limit,
    tenancy_id,
    maintenance_request_id,
    latest_only,
    party_type,
    direction,
    party_id,
    area_id,
    property_id,
  } = c.req.valid('query');
  const sb = getSb(c);

  // Both read paths converge on the same cast-load + map tail. When party_id
  // is present the person is resolved through the CAST (interaction_participants)
  // by a SQL function that reimplements this page's (occurred_at, id) keyset —
  // the PostgREST view embed is ambiguous on interactions_with_chain (see
  // 20260716000001). The rows it returns ARE interactions_with_chain rows, so
  // there is no embedded key to strip. When party_id is absent the view query
  // keeps its exact prior behaviour (row-slot party_type filter included).
  let items: Array<Record<string, unknown> & { id: string }>;
  let nextCursor: string | null;

  if (party_id) {
    // Decode the shared opaque cursor here (keysetPage owns it on the other
    // path); garbage -> 400, the same contract as everywhere else.
    let beforeOccurredAt: string | null = null;
    let beforeId: string | null = null;
    if (cursor !== undefined) {
      const cur = decodeCursor(cursor);
      if (!cur) throw new ApiError(400, 'invalid_request', 'invalid cursor');
      beforeOccurredAt = cur.created_at; // the keyset column value (occurred_at)
      beforeId = cur.id;
    }
    const { data, error } = await sb.rpc('list_interactions_for_party', {
      p_account_id: accountId,
      p_party_type: nullableRpcArg(party_type ?? null),
      p_party_id: party_id,
      p_tenancy_id: nullableRpcArg(tenancy_id ?? null),
      p_maintenance_request_id: nullableRpcArg(maintenance_request_id ?? null),
      p_area_id: nullableRpcArg(area_id ?? null),
      p_property_id: nullableRpcArg(property_id ?? null),
      p_direction: nullableRpcArg(direction ?? null),
      p_latest_only: latest_only === 'true',
      p_before_occurred_at: nullableRpcArg(beforeOccurredAt),
      p_before_id: nullableRpcArg(beforeId),
      p_limit: limit + 1,
    });
    if (error) throw new ApiError(500, 'database_error', error.message);
    const rows = (data ?? []) as Array<
      Record<string, unknown> & { id: string; occurred_at: string }
    >;
    const hasMore = rows.length > limit;
    items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    nextCursor =
      hasMore && last
        ? encodeCursor({ created_at: String(last.occurred_at), id: String(last.id) })
        : null;
  } else {
    let q = sb
      .from('interactions_with_chain')
      .select('*')
      .eq('account_id', accountId)
      .is('deleted_at', null);
    if (tenancy_id) q = q.eq('tenancy_id', tenancy_id);
    if (maintenance_request_id) q = q.eq('maintenance_request_id', maintenance_request_id);
    // area_id is a direct column on the row. Deliberately UNINDEXED:
    // interactions is the highest-write table and this is a low-frequency
    // filter, so it rides the per-account scan rather than paying write cost on
    // every insert. Ready-made partial index if that ever changes:
    //   create index interactions_area_idx
    //     on public.interactions (account_id, area_id, occurred_at, id)
    //     where deleted_at is null;
    if (area_id) q = q.eq('area_id', area_id);
    if (property_id) q = q.eq('property_id', property_id);
    if (latest_only === 'true') q = q.eq('is_head', true);
    if (party_type) q = q.eq('party_type', party_type);
    if (direction) q = q.eq('direction', direction);
    const page = await keysetPage<Record<string, unknown> & { id: string }>(q, {
      cursor,
      limit,
      column: 'occurred_at',
    });
    items = page.items;
    nextCursor = page.next_cursor;
  }

  const casts = await loadInteractionParticipants(
    sb,
    accountId,
    items.map((r) => r.id),
  );
  const data = (items as { id: string; author_type?: string | null; actor: string }[]).map((r) => ({
    ...withResolvedAuthorship(r),
    participants: casts.get(r.id) ?? [],
  }));
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
  const cast = (await loadInteractionParticipants(sb, accountId, [id])).get(id) ?? [];
  return c.json(
    {
      ...withResolvedAuthorship(data as { author_type?: string | null; actor: string }),
      participants: cast,
    } as z.infer<typeof Interaction>,
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
      row.channel !== 'agent_event' ||
      row.direction !== 'none' ||
      row.party_type !== 'none' ||
      row.party_id !== null ||
      row.party_label !== null
    ) {
      throw new ApiError(
        400,
        'invalid_request',
        'an agent_event correction cannot change the event shape (channel/direction/party fields)',
      );
    }
    return;
  }
  if (row.channel === 'agent_event') {
    throw new ApiError(
      400,
      'invalid_request',
      "channel 'agent_event' is reserved for kind='agent_event'",
    );
  }
  if (row.kind === 'note') {
    if (
      row.channel !== 'note' ||
      row.direction !== 'none' ||
      row.party_type !== 'none' ||
      row.party_id !== null ||
      row.party_label !== null
    ) {
      throw new ApiError(
        400,
        'invalid_request',
        'a note correction cannot change the note shape (channel/direction/party fields)',
      );
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
    throw new ApiError(
      400,
      'invalid_request',
      "direction 'none' is only valid for channel 'import'",
    );
  }
  if (row.party_type === 'unspecified' && row.party_id !== null) {
    throw new ApiError(
      400,
      'invalid_request',
      "party_type 'unspecified' cannot carry a party_id (resolve the role, or clear party_id)",
    );
  }
}

// classify is fill-only: it may populate a context field that was EMPTY on the
// corrected row, but must never overwrite a value already recorded there
// (overwriting a stated fact is a substantive change -> amend). 'unspecified'
// (party_type) / 'unspecified'|'none' (direction) / null all count as empty.
// This is the app-side clean 400; the DB trigger interactions_classify_fill_only
// is the evidence-grade backstop for direct writes.
function assertClassifyFillOnly(
  original: Record<string, unknown>,
  row: Record<string, unknown>,
): void {
  const fieldError = (f: string, msg: string) =>
    new ApiError(400, 'invalid_request', msg, { fieldErrors: { [f]: [msg] } });

  const nullable = [
    'party_id',
    'party_label',
    'tenancy_id',
    'maintenance_request_id',
    'area_id',
    'work_order_id',
    'vendor_id',
    'references_interaction_id',
  ] as const;
  for (const f of nullable) {
    if (original[f] != null && row[f] !== original[f]) {
      throw fieldError(
        f,
        `classify cannot overwrite ${f} (already set; use correction_kind='amend' to change a recorded value)`,
      );
    }
  }
  // party_type: 'unspecified'/'none' are empty (fillable); a concrete role is locked.
  if (
    original.party_type !== 'unspecified' &&
    original.party_type !== 'none' &&
    row.party_type !== original.party_type
  ) {
    throw fieldError(
      'party_type',
      "classify cannot overwrite party_type (use correction_kind='amend')",
    );
  }
  // direction: 'unspecified'/'none' are empty (fillable); a stated direction is locked.
  if (
    original.direction !== 'unspecified' &&
    original.direction !== 'none' &&
    row.direction !== original.direction
  ) {
    throw fieldError(
      'direction',
      "classify cannot overwrite direction (use correction_kind='amend')",
    );
  }
  // channel is never empty on a communication -> effectively immutable here.
  if (row.channel !== original.channel) {
    throw fieldError('channel', "classify cannot change channel (use correction_kind='amend')");
  }
  // atomic resolve: naming a party_id requires resolving the role too.
  if (row.party_id != null && row.party_type === 'unspecified') {
    throw fieldError(
      'party_type',
      'classify must resolve party_type (tenant/vendor/inspector/other) when setting party_id',
    );
  }
}

// The atomic-cast participant shape journal_with_participants consumes.
interface CastParticipant {
  role: string;
  party_type: string;
  party_id: string | null;
  address: string | null;
  label: string | null;
}

// Item C — close the castless-cast gap. A landlord communication that names a
// single counterparty in the legacy party slot but supplies no explicit cast
// gets ONE derived participant, so "everything involving <person>" stays ONE
// indexed cast query (the party_id filter) even for hand-logged contacts —
// restoring the backfill's stated end state. Returns null (→ the plain insert,
// no cast) when:
//   - the principal is the agent: agent communications are cast by the verified
//     comms transport (capture_inbound / complete_send always write a cast),
//     and journal_with_participants both refuses agents AND cannot carry an
//     agent's provenance (external_ref / approval_ref / approved_by), so the
//     manual agent-journal path stays on the plain insert;
//   - no counterparty is named: party_type 'unspecified' is the
//     unresolved-sender queue (a later classify resolves it) with no name to
//     cast; 'none' is a note; a concrete role with neither party_id nor
//     party_label is just a headline bucket ("role known, person unknown");
//   - a field the RPC cannot faithfully carry is present:
//     references_interaction_id is dropped by journal_with_participants, and
//     channel='import' would be stamped attestation='attested' instead of
//     'imported' — both stay on the plain insert so behaviour is byte-identical.
// Role follows direction, the same mapping the backfill (20260703000005) uses:
// inbound → sender, outbound → recipient, anything else → attendee.
function deriveSingleParticipant(
  body: {
    channel?: string;
    direction?: string;
    party_type?: string;
    party_id?: string;
    party_label?: string;
    references_interaction_id?: string;
  },
  principalType: string,
): CastParticipant[] | null {
  if (principalType === 'agent') return null;
  if (body.channel === 'import') return null;
  if (body.references_interaction_id !== undefined) return null;
  const pt = body.party_type;
  if (pt !== 'tenant' && pt !== 'vendor' && pt !== 'inspector' && pt !== 'other') return null;
  if (body.party_id === undefined && body.party_label === undefined) return null;
  const role =
    body.direction === 'inbound'
      ? 'sender'
      : body.direction === 'outbound'
        ? 'recipient'
        : 'attendee';
  return [
    {
      role,
      party_type: pt,
      party_id: body.party_id ?? null,
      address: null,
      label: body.party_label ?? null,
    },
  ];
}

interface ResolvedInteractionScope {
  areaId: string | null;
  propertyId: string | null;
}

/**
 * Resolve a client-facing property selection to the one canonical place key we
 * store: interactions.area_id.
 *
 * property with one live unit -> that unit
 * property with zero/multiple live units -> typed 422; caller chooses area_id
 * property + area -> validate that they belong together
 */
async function resolveInteractionScope(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  propertyId: string | undefined,
  explicitAreaId: string | undefined,
  fallback: ResolvedInteractionScope = { areaId: null, propertyId: null },
): Promise<ResolvedInteractionScope> {
  // An explicit area remains the canonical input. We still resolve its
  // property once so POST responses carry the same derived shape as GET/list.
  if (propertyId === undefined && explicitAreaId !== undefined) {
    const { data: area, error } = await sb
      .from('areas')
      .select('id, property_id')
      .eq('account_id', accountId)
      .eq('id', explicitAreaId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new ApiError(500, 'database_error', error.message);
    if (!area) throw new ApiError(404, 'not_found', 'area_id does not belong to this account');
    return { areaId: area.id, propertyId: area.property_id };
  }

  if (propertyId === undefined) return fallback;

  const { data: property, error: propertyError } = await sb
    .from('properties')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', propertyId)
    .is('deleted_at', null)
    .maybeSingle();
  if (propertyError) throw new ApiError(500, 'database_error', propertyError.message);
  if (!property)
    throw new ApiError(404, 'not_found', 'property_id does not belong to this account');

  // A correction that deliberately changes property must not inherit the old
  // property's area. Resolve the new property from scratch unless its area is
  // also supplied explicitly.
  const candidateAreaId =
    explicitAreaId ?? (fallback.propertyId === propertyId ? fallback.areaId : null);
  if (candidateAreaId !== null && candidateAreaId !== undefined) {
    let query = sb
      .from('areas')
      .select('id, property_id')
      .eq('account_id', accountId)
      .eq('id', candidateAreaId);
    // A newly selected area must be live. A correction may retain the original
    // historical area after that area was soft-deleted.
    if (explicitAreaId !== undefined) query = query.is('deleted_at', null);
    const { data: area, error } = await query.maybeSingle();
    if (error) throw new ApiError(500, 'database_error', error.message);
    if (!area) throw new ApiError(404, 'not_found', 'area_id does not belong to this account');
    if (area.property_id !== propertyId) {
      throw new ApiError(422, 'property_requires_area', 'area_id does not belong to property_id', {
        fieldErrors: {
          property_id: ['does not contain area_id'],
          area_id: ['does not belong to property_id'],
        },
      });
    }
    return { areaId: area.id, propertyId };
  }

  const { data: units, error: unitsError } = await sb
    .from('areas')
    .select('id')
    .eq('account_id', accountId)
    .eq('property_id', propertyId)
    .eq('kind', 'unit')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(2);
  if (unitsError) throw new ApiError(500, 'database_error', unitsError.message);
  if ((units ?? []).length !== 1) {
    throw new ApiError(
      422,
      'property_requires_area',
      'property_id cannot be resolved to exactly one live unit; supply area_id',
      {
        fieldErrors: {
          property_id: ['property has zero or multiple live units'],
          area_id: ['choose a unit or common area explicitly'],
        },
      },
    );
  }
  return { areaId: units![0]!.id, propertyId };
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

  // The manual cast path is landlord-only BY DESIGN: an agent's
  // communications are journaled (with their cast) by the verified comms
  // transport paths, and an agent's notes carry no cast — so an agent
  // supplying participants here could only be fabricating an unverifiable
  // record of who was contacted.
  if (principal.type === 'agent' && body.participants !== undefined) {
    throw new ApiError(
      400,
      'invalid_request',
      'participants are recorded by the comms transport for agent communications; the manual participants path is landlord-only',
      { fieldErrors: { participants: ['not permitted for the agent principal'] } },
    );
  }

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
    const { data: ok, error: approverErr } = await sb.rpc('is_approver_member', {
      p_account_id: accountId,
      p_user_id: body.approved_by,
    });
    if (approverErr) throw dbError(approverErr);
    if (!ok) {
      throw new ApiError(
        400,
        'invalid_request',
        'approved_by must be a non-agent member of this account',
      );
    }
  }

  // NOTE: a `grant:`-prefixed approval_ref on this direct journaling path is
  // NOT validated against comm_policies here -- deliberately. This path RECORDS
  // a send that already happened (the agent transport's confirmed-send journal,
  // per landlord-agent/docs/agent-sends-core-records.md); refusing the record
  // because the cited grant is (now) revoked would suppress the evidence of a
  // real send, violating ADR-0007's "a message is never sent without a record".
  // Grant existence/scope is enforced at INTENT-CREATION time on POST
  // /comms/outbox instead. (Open item raised to the coordinator: whether to
  // additionally reject a truly-nonexistent grant id here without the ADR-0007
  // suppression risk -- pending confirmation of the grant-ref format Plan B
  // emits.)

  let row: Record<string, unknown>;
  let responsePropertyId: string | null = null;

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
      throw new ApiError(
        409,
        'invalid_correction_target',
        'the entry is retracted and its chain is closed; log a new entry instead',
      );
    }
    if (original.superseded_by_id !== null) {
      throw new ApiError(
        409,
        'invalid_correction_target',
        'the entry is already superseded; correct the latest version of the chain',
      );
    }
    if (body.kind !== undefined && body.kind !== original.kind) {
      throw new ApiError(
        400,
        'invalid_request',
        'kind is inherited from the corrected entry and cannot change',
      );
    }

    const isAmend = body.correction_kind === 'amend';
    const isClassify = body.correction_kind === 'classify';
    // amend and classify may both set context fields; retract inherits all.
    // amend may also rewrite body/occurred_at; classify may not (superRefine
    // rejects them) and is fill-only (assertClassifyFillOnly + the DB trigger):
    // it fills an empty field but never overwrites a recorded one.
    const mayCorrectContext = isAmend || isClassify;
    const correctedScope = mayCorrectContext
      ? await resolveInteractionScope(sb, accountId, body.property_id, body.area_id, {
          areaId: original.area_id,
          propertyId: original.property_id,
        })
      : { areaId: original.area_id, propertyId: original.property_id };
    responsePropertyId = correctedScope.propertyId;
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
      party_type: mayCorrectContext
        ? (body.party_type ?? original.party_type)
        : original.party_type,
      party_id: mayCorrectContext ? (body.party_id ?? original.party_id) : original.party_id,
      party_label: mayCorrectContext
        ? (body.party_label ?? original.party_label)
        : original.party_label,
      channel: mayCorrectContext ? (body.channel ?? original.channel) : original.channel,
      direction: mayCorrectContext ? (body.direction ?? original.direction) : original.direction,
      // classify inherits body (substantive -> amend-only); amend/retract carry it.
      body: isClassify ? original.body : body.body,
      // Same event -> same timeline position, unless an amend explicitly
      // re-dates it. classify always inherits. logged_at stays server-set.
      occurred_at: isAmend ? (body.occurred_at ?? original.occurred_at) : original.occurred_at,
      corrects_id: body.corrects_id,
      correction_kind: body.correction_kind,
      tenancy_id: mayCorrectContext
        ? (body.tenancy_id ?? original.tenancy_id)
        : original.tenancy_id,
      maintenance_request_id: mayCorrectContext
        ? (body.maintenance_request_id ?? original.maintenance_request_id)
        : original.maintenance_request_id,
      area_id: correctedScope.areaId,
      work_order_id: mayCorrectContext
        ? (body.work_order_id ?? original.work_order_id)
        : original.work_order_id,
      vendor_id: mayCorrectContext ? (body.vendor_id ?? original.vendor_id) : original.vendor_id,
      references_interaction_id: mayCorrectContext
        ? (body.references_interaction_id ?? original.references_interaction_id)
        : original.references_interaction_id,
    };
    assertCoherentShape(row as Parameters<typeof assertCoherentShape>[0]);
    if (isClassify) assertClassifyFillOnly(original as Record<string, unknown>, row);
  } else {
    const scope = await resolveInteractionScope(sb, accountId, body.property_id, body.area_id);
    responsePropertyId = scope.propertyId;

    if ((body.kind ?? 'communication') === 'agent_event') {
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
        area_id: scope.areaId,
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
        area_id: scope.areaId,
        work_order_id: body.work_order_id ?? null,
        vendor_id: body.vendor_id ?? null,
        references_interaction_id: body.references_interaction_id ?? null,
      };
    } else {
      // Cast-carrying create: the row and its cast are written atomically by
      // the journal_with_participants RPC (no window where a valid-but-castless
      // entry exists), which also stamps attestation='attested' and derives
      // actor/author_type from the caller — same values this handler computes.
      // Landlord-only at this point (agent guard above). TWO inputs converge
      // here: an EXPLICIT cast (body.participants), or a single DERIVED
      // participant (Item C) when the body names a counterparty in the legacy
      // slot but supplies no cast. Both keep the plain insert below for the
      // no-counterparty case and the agent principal.
      const explicitCast: CastParticipant[] | undefined = body.participants?.map((p) => ({
        role: p.role,
        party_type: p.party_type,
        party_id: p.party_id ?? null,
        address: p.address ?? null,
        label: p.label ?? null,
      }));
      const castToWrite = explicitCast ?? deriveSingleParticipant(body, principal.type);
      if (castToWrite) {
        const { data: created, error: rpcErr } = await sb.rpc('journal_with_participants', {
          p_account_id: accountId,
          p_entry: {
            channel: body.channel,
            direction: body.direction ?? 'unspecified',
            party_type: body.party_type,
            party_id: body.party_id ?? null,
            party_label: body.party_label ?? null,
            body: body.body ?? null,
            occurred_at: body.occurred_at,
            tenancy_id: body.tenancy_id ?? null,
            maintenance_request_id: body.maintenance_request_id ?? null,
            area_id: scope.areaId,
            work_order_id: body.work_order_id ?? null,
            vendor_id: body.vendor_id ?? null,
          },
          p_participants: asJson(castToWrite),
        });
        if (rpcErr) {
          if (rpcErr.code === '23503') {
            throw new ApiError(
              404,
              'not_found',
              'a referenced row does not belong to this account',
            );
          }
          if (rpcErr.code === '22023') {
            throw new ApiError(400, 'invalid_request', rpcErr.message);
          }
          throw dbError(rpcErr);
        }
        const createdRow = created as unknown as {
          id: string;
          author_type?: string | null;
          actor: string;
        };
        const cast =
          (await loadInteractionParticipants(sb, accountId, [createdRow.id])).get(createdRow.id) ??
          [];
        return c.json(
          withResolvedAuthorship({
            ...createdRow,
            property_id: responsePropertyId,
            superseded_by_id: null,
            is_head: true,
            participants: cast,
          }) as z.infer<typeof Interaction>,
          201,
        );
      }
      row = {
        account_id: accountId,
        actor,
        author_type: authorType,
        // Agent communications carry their authorization provenance (the
        // firewall has already required approval_ref + approved_by-or-grant);
        // landlord communications never carry approval fields.
        approved_by: principal.type === 'agent' ? (body.approved_by ?? null) : null,
        approval_ref: principal.type === 'agent' ? (body.approval_ref ?? null) : null,
        entry_type: null,
        external_ref: principal.type === 'agent' ? (body.external_ref ?? null) : null,
        kind: 'communication',
        party_type: body.party_type,
        party_id: body.party_id ?? null,
        party_label: body.party_label ?? null,
        channel: body.channel,
        // Optional now: an omitted direction is stored as the 'unspecified'
        // sentinel rather than forcing the landlord to fabricate inbound/outbound.
        direction: body.direction ?? 'unspecified',
        body: body.body ?? null,
        occurred_at: body.occurred_at,
        corrects_id: null,
        correction_kind: null,
        tenancy_id: body.tenancy_id ?? null,
        maintenance_request_id: body.maintenance_request_id ?? null,
        area_id: scope.areaId,
        work_order_id: body.work_order_id ?? null,
        vendor_id: body.vendor_id ?? null,
        references_interaction_id: body.references_interaction_id ?? null,
      };
    }
  }

  // logged_at not passed -- DB default = now(); Phase 3 immutability
  // trigger blocks any later UPDATE that changes it.
  const { data, error } = await sb
    .from('interactions')
    .insert(asDbInsert<'interactions'>(row))
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') {
      // interactions_corrects_id_uniq: we lost a race to correct the same
      // head. Chains stay linear by DB invariant, not just the check above.
      throw new ApiError(
        409,
        'invalid_correction_target',
        'the entry was corrected concurrently; correct the latest version of the chain',
      );
    }
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'a referenced row does not belong to this account');
    }
    // 42501 (RLS denial) -> 403 (ADR-0009 Phase 4). Defensive: for mutating
    // requests the idempotency middleware claims a key FIRST and a revoked
    // agent is denied there, so this branch fires only if a write ever reaches
    // the handler without that claim. Else 500.
    throw dbError(error);
  }
  // Derived fields, true by construction for a row that did not exist a
  // moment ago: nothing can reference it yet, and (on this castless path)
  // no participants exist for it.
  return c.json(
    withResolvedAuthorship({
      ...data,
      property_id: responsePropertyId,
      superseded_by_id: null,
      is_head: true,
      participants: [],
    }) as z.infer<typeof Interaction>,
    201,
  );
});
