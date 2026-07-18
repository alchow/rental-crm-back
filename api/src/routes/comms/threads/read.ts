import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getSb } from '../../../supabase/request-client';
import { ApiError, errorResponses } from '../../_lib/error';
import { keysetPage } from '../../_lib/cursor';
import { withResolvedAuthorship } from '../../_lib/authorship';
import { loadInteractionParticipants } from '../../interactions';
import {
  AccountAndIdParam,
  AccountParam,
  CommThreadDetail,
  ThreadListQuery,
  ThreadListResponse,
} from '../schemas';
import type { CommOutboxStatus, CommRelayLeg, CommThread ,
  CommThreadBinding} from '../schemas';
import {
  BINDING_COLS,
  commDbError,
  requireAgentOrManager,
  requireManager,
  THREAD_COLS,
  type CommsApp,
} from '../shared';
import { loadParticipants } from './helpers';

export function registerThreadReadRoutes(app: CommsApp): void {
  const listThreads = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/threads',
    tags: ['comms'],
    summary: 'List comms threads with participants (landlord).',
    request: { params: AccountParam, query: ThreadListQuery },
    responses: {
      200: { description: 'page', content: { 'application/json': { schema: ThreadListResponse } } },
      ...errorResponses,
    },
  });

  const getThread = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/threads/{id}',
    tags: ['comms'],
    summary:
      'Thread detail (transport + landlord): participants, channel bindings, and ' +
      'the journal rows in the thread with their delivery state (cursor/limit ' +
      'page the messages).',
    request: {
      params: AccountAndIdParam,
      query: z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).default(50),
      }),
    },
    responses: {
      200: {
        description: 'thread detail',
        content: { 'application/json': { schema: CommThreadDetail } },
      },
      ...errorResponses,
    },
  });

  app.openapi(listThreads, async (c) => {
    requireManager(c);
    const { accountId } = c.req.valid('param');
    const { cursor, limit, status, kind, channel, tenancy_id } = c.req.valid('query');
    const sb = getSb(c);
    let q = sb.from('comm_threads').select(THREAD_COLS).eq('account_id', accountId);
    if (status !== undefined) q = q.eq('status', status);
    if (kind !== undefined) q = q.eq('kind', kind);
    if (channel !== undefined) q = q.eq('channel', channel);
    if (tenancy_id !== undefined) q = q.eq('tenancy_id', tenancy_id);
    const { items, next_cursor } = await keysetPage<z.infer<typeof CommThread>>(q, {
      cursor,
      limit,
      descending: true,
    });
    const participants = await loadParticipants(
      c,
      accountId,
      items.map((t) => t.id),
    );
    const data = items.map((t) => ({ ...t, participants: participants.get(t.id) ?? [] }));
    return c.json({ data, next_cursor } as z.infer<typeof ThreadListResponse>, 200);
  });

  // Attach per-leg relay delivery states to a page of journal rows.
  async function loadRelayLegs(
    c: Context,
    accountId: string,
    interactionIds: string[],
  ): Promise<Map<string, z.infer<typeof CommRelayLeg>[]>> {
    const map = new Map<string, z.infer<typeof CommRelayLeg>[]>();
    if (interactionIds.length === 0) return map;
    const { data, error } = await getSb(c)
      .from('comm_outbox')
      .select(
        'id, relay_of_interaction_id, participant_id, to_address, status, interaction_id, delivered_at',
      )
      .eq('account_id', accountId)
      .in('relay_of_interaction_id', interactionIds);
    if (error) throw commDbError(error);
    for (const o of (data ?? []) as {
      id: string;
      relay_of_interaction_id: string;
      participant_id: string | null;
      to_address: string | null;
      status: z.infer<typeof CommOutboxStatus>;
      interaction_id: string | null;
      delivered_at: string | null;
    }[]) {
      const leg = {
        outbox_id: o.id,
        participant_id: o.participant_id,
        to_address: o.to_address,
        status: o.status,
        interaction_id: o.interaction_id,
        delivered_at: o.delivered_at,
      };
      const list = map.get(o.relay_of_interaction_id) ?? [];
      list.push(leg);
      map.set(o.relay_of_interaction_id, list);
    }
    return map;
  }

  app.openapi(getThread, async (c) => {
    // Transport + landlord: the transport reads bindings/participants (and the
    // sender display name below) to address relay legs and thread sends.
    requireAgentOrManager(c);
    const { accountId, id } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const sb = getSb(c);

    const { data: thread, error: thErr } = await sb
      .from('comm_threads')
      .select(THREAD_COLS)
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (thErr) throw commDbError(thErr);
    if (!thread) throw new ApiError(404, 'not_found', 'not found');

    // Journal rows in the thread, newest-first, with derived delivery state
    // from the chain view (outbox join), then per-leg relay fan-out.
    const msgQuery = sb
      .from('interactions_with_chain')
      .select('*')
      .eq('account_id', accountId)
      .eq('thread_id', id)
      .is('deleted_at', null);

    // These reads are independent once the thread row exists. Keep them together
    // so the data flow is obvious: thread detail = metadata + message page.
    const [participantMap, accountRes, bindingsRes, msgPage] = await Promise.all([
      loadParticipants(c, accountId, [id]),
      sb.from('accounts').select('sender_display_name').eq('id', accountId).maybeSingle(),
      sb
        .from('thread_channel_bindings')
        .select(BINDING_COLS)
        .eq('account_id', accountId)
        .eq('thread_id', id),
      keysetPage<Record<string, unknown>>(msgQuery, {
        cursor,
        limit,
        column: 'occurred_at',
        descending: true,
      }),
    ]);
    if (accountRes.error) throw commDbError(accountRes.error);
    if (bindingsRes.error) throw commDbError(bindingsRes.error);

    const participants = participantMap.get(id) ?? [];
    const { items: msgRows, next_cursor: messagesNext } = msgPage;
    const messageIds = msgRows.map((m) => String(m.id));
    const [legs, casts] = await Promise.all([
      loadRelayLegs(c, accountId, messageIds),
      loadInteractionParticipants(sb, accountId, messageIds),
    ]);
    const messages = msgRows.map((m) => ({
      ...withResolvedAuthorship(m as { author_type?: string | null; actor: string }),
      relay_legs: legs.get(String(m.id)) ?? [],
      participants: casts.get(String(m.id)) ?? [],
    }));

    return c.json(
      {
        ...(thread as z.infer<typeof CommThread>),
        participants,
        bindings: (bindingsRes.data ?? []) as z.infer<typeof CommThreadBinding>[],
        messages,
        messages_next_cursor: messagesNext,
        sender_display_name: (accountRes.data?.sender_display_name ?? null) as string | null,
      } as z.infer<typeof CommThreadDetail>,
      200,
    );
  });
}
