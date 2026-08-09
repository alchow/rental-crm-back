import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';

// Lossless polling feed (ADR-0001). account_seq is assigned and committed under
// a per-account lock, so `after_seq=<last seen>` neither skips nor repeats a
// committed event. Snapshot = payload.after, or payload.before for hard deletes;
// chain-internal payload/hash fields stay private. The existing
// (account_id, account_seq) index avoids taxing every audited write with an
// entity-filter index; revisit if feed p95 exceeds 200 ms or 20k events/account.

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});

const FeedQuery = z.object({
  after_seq: z.coerce.number().int().min(0).default(0),
  entity_type: z.string().regex(/^[a-z_]{1,63}$/).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

const EventFeedItem = z
  .object({
    account_seq:  z.number().int(),
    entity_type:  z.string(),
    entity_id:    z.string().uuid(),
    event_type:   z.enum(['inserted', 'updated', 'deleted', 'restored', 'hard_deleted']),
    occurred_at:  z.string(),
    actor:        z.string(),
    snapshot:     z.unknown().nullable(),
  })
  .openapi('EventFeedItem');

const FeedResponse = z
  .object({
    data:     z.array(EventFeedItem),
    next_seq: z.number().int(),
  })
  .openapi('EventFeedResponse');

const list = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/events',
  tags: ['events'],
  summary: 'Lossless per-account event feed ordered by account_seq',
  description:
    'Returns audit events for the account in account_seq order. ' +
    'account_seq is gap-free and strictly increasing, assigned under the ' +
    'per-account advisory lock and committed in the same transaction (ADR-0001). ' +
    'A poller that requests after_seq=<last seen> can provably never miss or ' +
    'double-see a committed event. Pass next_seq back verbatim on the next poll. ' +
    'snapshot is payload[after] when present, payload[before] on hard_deleted, else null.',
  request: { params: AccountParam, query: FeedQuery },
  responses: {
    200: { description: 'event page', content: { 'application/json': { schema: FeedResponse } } },
    ...errorResponses,
  },
});

export const eventsApp = newApiApp();

eventsApp.openapi(list, async (c) => {
  const { accountId } = c.req.valid('param');
  const { after_seq, entity_type, limit } = c.req.valid('query');
  const sb = getSb(c);

  let q = sb
    .from('events')
    .select('account_seq, entity_type, entity_id, event_type, occurred_at, actor, payload')
    .eq('account_id', accountId)
    .gt('account_seq', after_seq)
    .order('account_seq', { ascending: true })
    .limit(limit);

  // entity_type is a post-filter expressed at the query level for efficiency
  // (the (account_id, account_seq) index is the primary scan; a composite
  // with entity_type would tax every audited write — see module header).
  if (entity_type !== undefined) {
    q = q.eq('entity_type', entity_type);
  }

  const { data, error } = await q;
  if (error) throw new ApiError(500, 'database_error', error.message);

  const rows = (data ?? []) as {
    account_seq: number;
    entity_type: string;
    entity_id: string;
    event_type: string;
    occurred_at: string;
    actor: string;
    payload: Record<string, unknown> | null;
  }[];

  const items = rows.map((r) => {
    // Map payload to the snapshot the poller consumes. Hash columns and the
    // raw envelope are internal to the chain and are never forwarded.
    let snapshot: unknown = null;
    if (r.payload) {
      if ('after' in r.payload) {
        snapshot = r.payload['after'];
      } else if ('before' in r.payload) {
        // hard_deleted: the before-image is the recoverable state.
        snapshot = r.payload['before'];
      }
    }
    return {
      account_seq: r.account_seq,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      event_type: r.event_type as z.infer<typeof EventFeedItem>['event_type'],
      occurred_at: r.occurred_at,
      actor: r.actor,
      snapshot,
    };
  });

  // next_seq: last item's account_seq, or the request's after_seq when the
  // page is empty. The caller can always pass next_seq back verbatim.
  const next_seq =
    items.length > 0 ? items[items.length - 1]!.account_seq : after_seq;

  return c.json({ data: items, next_seq } satisfies z.infer<typeof FeedResponse>, 200);
});
