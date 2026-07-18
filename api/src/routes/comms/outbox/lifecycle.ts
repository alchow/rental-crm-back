import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getSb } from '../../../supabase/request-client';
import { ApiError, errorResponses } from '../../_lib/error';
import { keysetPage } from '../../_lib/cursor';
import {
  AccountAndIdParam,
  AccountParam,
  CommChannel,
  CommOutbox,
  CommOutboxStatus,
  CompleteSendBody,
  CompleteSendResponse,
  DeliveryBody,
  FailSendBody,
  OutboxListResponse,
} from '../schemas';
import {
  assertOutboxInAccount,
  commDbError,
  requireTransport,
  type CommsApp,
  type OutboxRow,
} from '../shared';

export function registerOutboxLifecycleRoutes(app: CommsApp): void {
  const listOutbox = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/outbox',
    tags: ['comms'],
    summary:
      'Dispatch scan (transport): list outbox rows, filterable by status and ' +
      'dispatch eligibility (not_before <= eligible_at or unset).',
    request: {
      params: AccountParam,
      query: z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).default(50),
        status: CommOutboxStatus.optional(),
        // The transport runs a separate dispatch loop per channel; this scopes
        // the scan to one channel's rows. Additive/optional.
        channel: CommChannel.optional(),
        eligible_at: z.string().datetime().optional(),
      }),
    },
    responses: {
      200: { description: 'page', content: { 'application/json': { schema: OutboxListResponse } } },
      ...errorResponses,
    },
  });

  const getOutbox = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/outbox/{id}',
    tags: ['comms'],
    summary:
      'Retrieve one outbox row — the resolution read for a send whose provider ' +
      'outcome was lost (ADR-0007 crash window).',
    request: { params: AccountAndIdParam },
    responses: {
      200: { description: 'outbox row', content: { 'application/json': { schema: CommOutbox } } },
      ...errorResponses,
    },
  });

  const completeSend = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/outbox/{id}/complete',
    tags: ['comms'],
    summary:
      'Confirm a send (transport): marks the row sent AND appends the journal ' +
      'entry with external_ref = provider_sid, atomically in one transaction. ' +
      'Idempotent on replay.',
    request: {
      params: AccountAndIdParam,
      body: { content: { 'application/json': { schema: CompleteSendBody } }, required: true },
    },
    responses: {
      200: {
        description: 'sent + journaled',
        content: { 'application/json': { schema: CompleteSendResponse } },
      },
      ...errorResponses,
    },
  });

  const failSend = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/outbox/{id}/fail',
    tags: ['comms'],
    summary:
      'Record a definitive provider rejection (transport) — no journal entry, ' +
      'nothing was sent. reconcile=true parks the row in needs_reconcile instead ' +
      '(unknown outcome).',
    request: {
      params: AccountAndIdParam,
      body: { content: { 'application/json': { schema: FailSendBody } }, required: true },
    },
    responses: {
      200: {
        description: 'updated outbox row',
        content: { 'application/json': { schema: CommOutbox } },
      },
      ...errorResponses,
    },
  });

  const updateDelivery = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/outbox/{id}/delivery',
    tags: ['comms'],
    summary:
      'Advance delivery state from a provider status callback (transport). ' +
      'Monotonic: late or duplicate callbacks are ignored and return the ' +
      'unchanged row.',
    request: {
      params: AccountAndIdParam,
      body: { content: { 'application/json': { schema: DeliveryBody } }, required: true },
    },
    responses: {
      200: {
        description: 'outbox row (possibly unchanged)',
        content: { 'application/json': { schema: CommOutbox } },
      },
      ...errorResponses,
    },
  });

  const reconcileScan = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/reconcile',
    tags: ['comms'],
    summary:
      "Reconcile scan (transport): rows stuck in 'sending' longer than " +
      'ttl_seconds. The scan never auto-retries or auto-fails — the transport ' +
      'checks the provider and resolves each row via complete or fail.',
    request: {
      params: AccountParam,
      query: z.object({
        ttl_seconds: z.coerce.number().int().positive().max(86400).default(3600),
      }),
    },
    responses: {
      200: {
        description: 'stale sending rows',
        content: {
          'application/json': {
            schema: z.object({ data: z.array(CommOutbox) }).openapi('CommReconcileResponse'),
          },
        },
      },
      ...errorResponses,
    },
  });

  // ---------------------------------------------------------------------------
  // GET /comms/outbox — dispatch scan (transport)
  // ---------------------------------------------------------------------------

  // Attach relay_source_rfc822_message_id to email relay legs: the Message-ID
  // of the inbound original each leg relays, so the transport can set
  // In-Reply-To/References and the relayed mail threads natively in the
  // recipient's client. One batched read per page; non-relay rows are untouched.
  async function withRelaySourceMessageIds(
    c: Context,
    accountId: string,
    rows: OutboxRow[],
  ): Promise<OutboxRow[]> {
    const sourceIds = [
      ...new Set(
        rows
          .filter((r) => r.channel === 'email' && r.relay_of_interaction_id !== null)
          .map((r) => r.relay_of_interaction_id as string),
      ),
    ];
    if (sourceIds.length === 0) return rows;
    const { data, error } = await getSb(c)
      .from('interactions')
      .select('id, rfc822_message_id')
      .eq('account_id', accountId)
      .in('id', sourceIds);
    if (error) throw commDbError(error);
    const byId = new Map(
      ((data ?? []) as { id: string; rfc822_message_id: string | null }[]).map((i) => [
        i.id,
        i.rfc822_message_id,
      ]),
    );
    return rows.map((r) =>
      r.channel === 'email' && r.relay_of_interaction_id !== null
        ? { ...r, relay_source_rfc822_message_id: byId.get(r.relay_of_interaction_id) ?? null }
        : r,
    );
  }

  app.openapi(listOutbox, async (c) => {
    requireTransport(c);
    const { accountId } = c.req.valid('param');
    const { cursor, limit, status, channel, eligible_at } = c.req.valid('query');
    const sb = getSb(c);
    let q = sb.from('comm_outbox').select('*').eq('account_id', accountId);
    if (status !== undefined) q = q.eq('status', status);
    if (channel !== undefined) q = q.eq('channel', channel);
    // eligible_at is zod-validated ISO, safe to interpolate; a second .or()
    // is AND-combined with the keyset filter by PostgREST.
    if (eligible_at !== undefined) q = q.or(`not_before.is.null,not_before.lte.${eligible_at}`);
    const { items, next_cursor } = await keysetPage<OutboxRow>(q, { cursor, limit });
    const data = await withRelaySourceMessageIds(c, accountId, items);
    return c.json({ data, next_cursor }, 200);
  });

  // ---------------------------------------------------------------------------
  // GET /comms/outbox/{id} — recovery read (transport + landlord)
  // ---------------------------------------------------------------------------

  app.openapi(getOutbox, async (c) => {
    const { accountId, id } = c.req.valid('param');
    const principal = c.get('principal');
    const role = c.get('account').role;
    if (principal.type !== 'agent' && role !== 'owner' && role !== 'manager') {
      throw new ApiError(
        403,
        'forbidden',
        'only the agent transport or an owner/manager may read outbox rows',
      );
    }
    const sb = getSb(c);
    const { data, error } = await sb
      .from('comm_outbox')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw commDbError(error);
    if (!data) throw new ApiError(404, 'not_found', 'not found');
    const [row] = await withRelaySourceMessageIds(c, accountId, [data as OutboxRow]);
    return c.json(row, 200);
  });

  // ---------------------------------------------------------------------------
  // POST /comms/outbox/{id}/complete — ADR-0007 atomicity point (transport)
  // ---------------------------------------------------------------------------

  app.openapi(completeSend, async (c) => {
    requireTransport(c);
    const { accountId, id } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    await assertOutboxInAccount(c, accountId, id);
    const { data: interactionId, error } = await sb.rpc('complete_send', {
      p_outbox_id: id,
      p_provider: body.provider,
      p_provider_sid: body.provider_sid,
      p_rfc822_message_id: body.rfc822_message_id,
    });
    if (error) throw commDbError(error);
    const { data: row, error: rowErr } = await sb
      .from('comm_outbox')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', id)
      .single();
    if (rowErr) throw commDbError(rowErr);
    return c.json({ interaction_id: interactionId as string, outbox: row as OutboxRow }, 200);
  });

  // ---------------------------------------------------------------------------
  // POST /comms/outbox/{id}/fail — definitive rejection / reconcile parking
  // ---------------------------------------------------------------------------

  app.openapi(failSend, async (c) => {
    requireTransport(c);
    const { accountId, id } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    await assertOutboxInAccount(c, accountId, id);
    const { data, error } = await sb.rpc('fail_send', {
      p_outbox_id: id,
      p_error_code: body.error_code,
      p_detail: body.detail,
      p_reconcile: body.reconcile ?? false,
    });
    if (error) throw commDbError(error);
    return c.json(data as OutboxRow, 200);
  });

  // ---------------------------------------------------------------------------
  // POST /comms/outbox/{id}/delivery — monotonic callback advancement
  // ---------------------------------------------------------------------------

  app.openapi(updateDelivery, async (c) => {
    requireTransport(c);
    const { accountId, id } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    await assertOutboxInAccount(c, accountId, id);
    const { data, error } = await sb.rpc('update_delivery', {
      p_outbox_id: id,
      p_status: body.status,
      p_provider_ts: body.provider_ts,
      p_error_code: body.error_code,
    });
    if (error) throw commDbError(error);
    return c.json(data as OutboxRow, 200);
  });

  app.openapi(reconcileScan, async (c) => {
    requireTransport(c);
    const { accountId } = c.req.valid('param');
    const { ttl_seconds } = c.req.valid('query');
    const sb = getSb(c);
    const { data, error } = await sb.rpc('reconcile_scan', {
      p_account_id: accountId,
      p_ttl_seconds: ttl_seconds,
    });
    if (error) throw commDbError(error);
    return c.json({ data: (data ?? []) as OutboxRow[] }, 200);
  });
}
