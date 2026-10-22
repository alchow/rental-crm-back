import { createRoute, z } from '@hono/zod-openapi';
import { getSb } from '../../supabase/request-client';
import { ApiError, errorResponses } from '../_lib/error';
import { keysetPage } from '../_lib/cursor';
import { withResolvedAuthorship } from '../_lib/authorship';
import { loadInteractionParticipants } from '../interactions';
import { CommThread, CommThreadMessage } from './schemas';
import { requireManager, commDbError, THREAD_COLS, type CommsApp } from './shared';
import { loadRelayLegs } from './threads/delivery';

const Params = z.object({ accountId: z.string().uuid(), tenantId: z.string().uuid() });
const HistoryMessage = CommThreadMessage.extend({
  thread: CommThread.nullable(),
}).openapi('TenantHistoryMessage');
const HistoryPage = z
  .object({
    data: z.array(HistoryMessage),
    next_cursor: z.string().nullable(),
    snapshot: z.string().datetime({ offset: true }),
  })
  .openapi('TenantHistoryPage');

export function registerTenantHistoryRoute(app: CommsApp): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/accounts/{accountId}/comms/tenants/{tenantId}/messages',
      tags: ['comms'],
      summary:
        'Captured person history across threads, newest first. Corrections remain explicit records.',
      request: {
        params: Params,
        query: z.object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().positive().max(100).default(50),
          snapshot: z.string().datetime({ offset: true }).optional(),
        }),
      },
      responses: {
        200: { description: 'page', content: { 'application/json': { schema: HistoryPage } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      requireManager(c);
      const { accountId, tenantId } = c.req.valid('param');
      const { cursor, limit, snapshot: requested } = c.req.valid('query');
      if (cursor && !requested)
        throw new ApiError(400, 'invalid_request', 'snapshot required with cursor');
      const snapshot = requested ?? new Date().toISOString();
      if (Date.parse(snapshot) > Date.now() + 1000)
        throw new ApiError(400, 'invalid_request', 'snapshot cannot be in the future');
      const sb = getSb(c);
      const tenant = await sb
        .from('tenants')
        .select('id')
        .eq('account_id', accountId)
        .eq('id', tenantId)
        .maybeSingle();
      if (tenant.error) throw commDbError(tenant.error);
      if (!tenant.data) throw new ApiError(404, 'not_found', 'tenant not found');
      const { items, next_cursor } = await keysetPage<Record<string, unknown>>(
        sb.rpc('tenant_communication_records', {
          p_account_id: accountId,
          p_tenant_id: tenantId,
          p_snapshot: snapshot,
          p_captured_only: true,
        }),
        { cursor, limit, column: 'occurred_at', descending: true },
      );
      const ids = items.map((r) => String(r.id));
      const threadIds = [
        ...new Set(items.flatMap((r) => (r.thread_id ? [String(r.thread_id)] : []))),
      ];
      const [casts, legs, threads] = await Promise.all([
        loadInteractionParticipants(sb, accountId, ids),
        loadRelayLegs(c, accountId, ids),
        threadIds.length
          ? sb
              .from('comm_threads')
              .select(THREAD_COLS)
              .eq('account_id', accountId)
              .in('id', threadIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (threads.error) throw commDbError(threads.error);
      const byId = new Map((threads.data ?? []).map((t) => [t.id, t]));
      return c.json(
        {
          snapshot,
          next_cursor,
          data: items.map((m) => ({
            ...withResolvedAuthorship(m as { actor: string; author_type?: string | null }),
            ...(m.deleted_at ? { body: null, party_label: null } : {}),
            participants: m.deleted_at ? [] : (casts.get(String(m.id)) ?? []),
            relay_legs: legs.get(String(m.id)) ?? [],
            thread: m.thread_id ? (byId.get(String(m.thread_id)) ?? null) : null,
          })),
        } as z.infer<typeof HistoryPage>,
        200,
      );
    },
  );
}
