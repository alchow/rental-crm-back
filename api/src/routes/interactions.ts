import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { asDbInsert, asJson, nullableRpcArg } from '../supabase/db-types';
import { ApiError, dbError, ErrorEnvelope, errorResponses } from './_lib/error';
import { decodeCursor, encodeCursor, keysetPage } from './_lib/cursor';
import { withResolvedAuthorship } from './_lib/authorship';
import { assertAgentJournalWrite } from './_lib/agent-firewall';
import { assertClassifyFillOnly, assertCoherentShape } from './interactions/corrections';
import { resolveInteractionScope } from './interactions/scope';
import {
  deriveSingleParticipant,
  loadInteractionParticipants,
  type CastParticipant,
} from './interactions/participants';
import { CreateInteractionBody, Direction, Interaction, PartyType } from '../schemas/importable';

// Append-only contact journal for offline, intake, and communications evidence.
// INVARIANT: logged_at is server-set and immutable. Amend, retract, classify,
// and note operations append rows linked by corrects_id; originals never change.
// DB constraints keep chains linear and account-safe, while
// interactions_with_chain derives heads/supersession. Evidence exports always
// include full chains even when API reads request latest_only.

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
   *  ALSO present, party_type narrows whichever leg matched — the cast leg by
   *  participant party_type, the row-slot leg by the row's own party_type. */
  party_type: PartyType.optional(),
  direction: Direction.optional(),
  /** Everything involving one person: a row matches when the CAST
   *  (interaction_participants) names them OR the row's own party fields do —
   *  so a witnessed exchange or group message where the person is one of
   *  several participants still matches, and so do castless shapes like a
   *  party-carrying note or a correction head that inherited the slot. Keyset
   *  pagination stays correct: the person is pruned inside the SQL scan, never
   *  by a materialized id set. */
  party_id: z.string().uuid().optional(),
  /** Filter to interactions scoped to one area (direct column on the row). */
  area_id: z.string().uuid().optional(),
  /** Derived through area_id; no duplicate property_id is stored on the journal row. */
  property_id: z.string().uuid().optional(),
});
const ListResponse = z
  .object({ data: z.array(Interaction), next_cursor: z.string().nullable() })
  .openapi('InteractionListResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/interactions',
  tags: ['interactions'],
  summary: 'List interactions (filterable; keyset-paginated on occurred_at)',
  description:
    'Chronological journal feed. Filters: tenancy_id, maintenance_request_id, ' +
    'area_id, property_id, direction, party_type, latest_only, and party_id. `party_id` ' +
    'matches an entry whose CAST (interaction_participants) names the person OR ' +
    'whose own party fields do, so a group message or witnessed exchange in ' +
    'which they were one of several participants matches, and so do castless ' +
    'entries such as a party-carrying note or a correction head that inherited ' +
    'the party from the entry it corrects. Combine it with party_type to narrow ' +
    "the matched leg to that person's tenant vs. vendor role. CAVEAT: with " +
    "latest_only=true, a person named ONLY in a superseded entry's cast (a cc " +
    'on a corrected message) does not match — the correction head inherits just ' +
    'the headline party. Omit latest_only for the complete involving-them set.',
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

  // The party RPC filters participant rows and the headline party before pagination;
  // the view handles requests without party_id. Both return chain-view rows.
  let items: Array<Record<string, unknown> & { id: string }>;
  let nextCursor: string | null;

  if (party_id) {
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
    // Keep this low-frequency filter on the account scan to avoid another write index.
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

interactionsApp.openapi(create, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const auth = c.get('auth');
  const principal = c.get('principal');

  // Apply principal-specific write rules before any journal mutation.
  assertAgentJournalWrite(principal, body);

  // SECURITY: Only landlords may supply manual participants; agent casts come from transport.
  if (principal.type === 'agent' && body.participants !== undefined) {
    throw new ApiError(
      400,
      'invalid_request',
      'participants are recorded by the comms transport for agent communications; the manual participants path is landlord-only',
      { fieldErrors: { participants: ['not permitted for the agent principal'] } },
    );
  }

  // PROVENANCE: actor identifies the caller; author_type records their capacity (ADR-0008).
  const actor = `user:${auth.userId}`;

  const authorType = principal.type === 'agent' ? 'agent' : 'landlord';

  // Validate approval against a non-agent account member through the scoped definer RPC.
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

  // Do not revalidate grant revocation when recording a completed send (ADR-0007).
  // Outbox creation validates intent; rejecting the later record would hide evidence.

  let row: Record<string, unknown>;
  let responsePropertyId: string | null = null;

  if (body.corrects_id !== undefined) {
    // Read the current chain head under caller RLS; corrections append rather than update.
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
      // Retraction closes a chain; a later statement starts a new entry.
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
    // Amend can replace facts; classify only fills empty context; retract inherits context.
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
      // The corrector owns this row; approval and external_ref remain on the original.
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
      body: isClassify ? original.body : body.body,
      // Keep the event's timeline position unless an amend explicitly changes it.
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

    const common = {
      account_id: accountId,
      actor,
      author_type: authorType,
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

    if ((body.kind ?? 'communication') === 'agent_event') {
      row = {
        ...common,
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
      };
    } else if ((body.kind ?? 'communication') === 'note') {
      row = {
        ...common,
        // Agent notes carry approval fields; landlord notes always null.
        approved_by: principal.type === 'agent' ? (body.approved_by ?? null) : null,
        approval_ref: principal.type === 'agent' ? (body.approval_ref ?? null) : null,
        entry_type: null,
        external_ref: null,
        kind: 'note',
        // Notes may identify a party but retain note channel/direction.
        party_type: body.party_type ?? 'none',
        party_id: body.party_id ?? null,
        party_label: body.party_label ?? null,
        channel: 'note',
        direction: 'none',
      };
    } else {
      // INVARIANT: Explicit or derived landlord participants and their journal entry
      // commit together. Agents and entries without participants use the plain insert.
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
        ...common,
        // Only agent communications retain approval and provider provenance.
        approved_by: principal.type === 'agent' ? (body.approved_by ?? null) : null,
        approval_ref: principal.type === 'agent' ? (body.approval_ref ?? null) : null,
        entry_type: null,
        external_ref: principal.type === 'agent' ? (body.external_ref ?? null) : null,
        kind: 'communication',
        party_type: body.party_type,
        party_id: body.party_id ?? null,
        party_label: body.party_label ?? null,
        channel: body.channel,
        // An unknown direction must not imply an invented inbound/outbound fact.
        direction: body.direction ?? 'unspecified',
      };
    }
  }

  // Leave logged_at to the DB default; its immutability trigger blocks edits.
  const { data, error } = await sb
    .from('interactions')
    .insert(asDbInsert<'interactions'>(row))
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') {
      // The unique correction target prevents concurrent forks in the evidence chain.
      throw new ApiError(
        409,
        'invalid_correction_target',
        'the entry was corrected concurrently; correct the latest version of the chain',
      );
    }
    if (error.code === '23503') {
      throw new ApiError(404, 'not_found', 'a referenced row does not belong to this account');
    }
    // RLS can reject a revoked member even after cached membership passed.
    throw dbError(error);
  }
  // New entries start as chain heads; this insert path creates no participants.
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
