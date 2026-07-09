import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getSb } from '../../supabase/request-client';
import { ApiError, errorResponses } from '../_lib/error';
import { keysetPage } from '../_lib/cursor';
import {
  AccountAndIdParam,
  AccountParam,
  CommChannel,
  CommOutbox,
  CommOutboxStatus,
  CompleteSendBody,
  CompleteSendResponse,
  CreateOutboxBody,
  DeliveryBody,
  FailSendBody,
  OutboxListResponse,
} from './schemas';
import {
  assertOutboxInAccount,
  commDbError,
  normalizeAddress,
  requireTransport,
  type CommsApp,
  type OutboxRow,
} from './shared';

export function registerOutboxRoutes(app: CommsApp): void {
  const createOutbox = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/outbox',
    tags: ['comms'],
    summary:
      'Create a send intent (status queued). Transport or landlord. The intent is ' +
      'durable BEFORE any provider call (ADR-0007); the journal entry is appended ' +
      'only by the completion path, never here.',
    request: {
      params: AccountParam,
      body: { content: { 'application/json': { schema: CreateOutboxBody } }, required: true },
    },
    responses: {
      201: {
        description: 'send intent created',
        content: { 'application/json': { schema: CommOutbox } },
      },
      ...errorResponses,
    },
  });

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

  app.openapi(createOutbox, async (c) => {
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    const principal = c.get('principal');
    const role = c.get('account').role;

    if (principal.type !== 'agent' && role !== 'owner' && role !== 'manager') {
      throw new ApiError(
        403,
        'forbidden',
        'only the agent transport or an owner/manager may create send intents',
      );
    }

    // system:<flow> provenance is reserved for core-originated sends (core's
    // server tier writing its own ledger through the admin client). Applies to
    // BOTH the agent and landlord principals here — no JWT-bearing caller may
    // mint one. The DB capacity trigger (auth.uid() IS NOT NULL) is the backstop.
    if (body.approval_ref.startsWith('system:')) {
      throw new ApiError(
        403,
        'forbidden',
        'system provenance is reserved for core-originated sends',
      );
    }

    // subject is an email-only intent field (DB CHECK backstops it). Reject it on
    // any other channel up front with a field-scoped 400.
    if (body.subject !== undefined && body.channel !== 'email') {
      throw new ApiError(400, 'invalid_request', 'subject is only valid on email sends', {
        fieldErrors: { subject: ['only valid when channel=email'] },
      });
    }

    // Provenance (mirrors the journal firewall vocabulary; the DB CHECK and
    // capacity trigger are the backstops). Three agent-authorized shapes:
    //   approved_by            -> a human approved this exact message
    //   grant:<policy_id>      -> a live standing policy of this account
    //   thread:<thread_id>     -> a RELAY leg; the thread (an owner/manager
    //                             creation) IS the authorization
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (principal.type === 'agent') {
      const isGrant = body.approval_ref.startsWith('grant:');
      const isThread = body.approval_ref.startsWith('thread:');
      if (body.approved_by === undefined && !isGrant && !isThread) {
        throw new ApiError(
          403,
          'agent_entry_type_forbidden',
          "agent send intents require approved_by (proposal-approved), a 'grant:' approval_ref (policy-authorized), or a 'thread:' approval_ref (relay)",
        );
      }
      if (body.approved_by !== undefined) {
        const { data: ok, error: approverErr } = await sb.rpc('is_approver_member', {
          p_account_id: accountId,
          p_user_id: body.approved_by,
        });
        if (approverErr) throw commDbError(approverErr);
        if (!ok) {
          throw new ApiError(
            400,
            'invalid_request',
            'approved_by must be a non-agent member of this account',
          );
        }
      } else if (isGrant) {
        // A grant ref must name a live standing policy in THIS account, and the
        // policy's channel must match the send's channel — a standing grant for
        // sms does not authorize a voice/email send.
        const grantId = body.approval_ref.slice('grant:'.length);
        if (!UUID_RE.test(grantId)) {
          throw new ApiError(
            400,
            'invalid_request',
            "a 'grant:' approval_ref must carry the comm_policies id",
          );
        }
        const { data: policy, error: polErr } = await sb
          .from('comm_policies')
          .select('id, status, channel')
          .eq('account_id', accountId)
          .eq('id', grantId)
          .maybeSingle();
        if (polErr) throw commDbError(polErr);
        if (!policy || policy.status !== 'active') {
          throw new ApiError(
            403,
            'forbidden',
            'the referenced grant is not an active policy of this account',
          );
        }
        if (policy.channel !== body.channel) {
          throw new ApiError(
            403,
            'forbidden',
            `the referenced grant authorizes ${policy.channel}, not ${body.channel}`,
          );
        }
      } else {
        // thread:<id> — valid ONLY for a relay leg: relay_of_interaction_id must
        // be set, the thread live + account-owned, and the relayed interaction
        // must belong to that thread. The thread is the recorded authorizing act.
        if (body.relay_of_interaction_id === undefined) {
          throw new ApiError(
            403,
            'forbidden',
            "a 'thread:' approval_ref is only valid on a relay (relay_of_interaction_id required)",
          );
        }
        const threadRef = body.approval_ref.slice('thread:'.length);
        if (!UUID_RE.test(threadRef)) {
          throw new ApiError(
            400,
            'invalid_request',
            "a 'thread:' approval_ref must carry the thread id",
          );
        }
        const { data: thread, error: thErr } = await sb
          .from('comm_threads')
          .select('id, status')
          .eq('account_id', accountId)
          .eq('id', threadRef)
          .maybeSingle();
        if (thErr) throw commDbError(thErr);
        if (!thread || thread.status !== 'active') {
          throw new ApiError(
            403,
            'forbidden',
            'the referenced thread is not an active thread of this account',
          );
        }
        // The relayed interaction must be a journal row IN that thread.
        const { data: orig, error: origErr } = await sb
          .from('interactions')
          .select('id, thread_id')
          .eq('account_id', accountId)
          .eq('id', body.relay_of_interaction_id)
          .maybeSingle();
        if (origErr) throw commDbError(origErr);
        if (!orig || orig.thread_id !== threadRef) {
          throw new ApiError(
            403,
            'forbidden',
            'the relayed interaction does not belong to the referenced thread',
          );
        }
      }
    } else {
      // Landlord-authored: the caller IS the approval. The provenance is
      // stamped, not trusted from the body.
      const self = `self:${c.get('auth').userId}`;
      if (body.approval_ref !== self) {
        throw new ApiError(
          400,
          'invalid_request',
          `landlord send intents carry approval_ref='${self}'`,
          {
            fieldErrors: { approval_ref: [`must be '${self}'`] },
          },
        );
      }
      if (body.approved_by !== undefined && body.approved_by !== c.get('auth').userId) {
        throw new ApiError(
          400,
          'invalid_request',
          'landlord send intents are approved by the caller',
          {
            fieldErrors: { approved_by: ['must be your own user id (or omitted)'] },
          },
        );
      }
    }

    // Destination resolution. Fetch the thread first (when one is named) so a
    // group thread — whose recipients are its whole active binding set, not a
    // single address — is dispatched before the 1:1 presence checks below.
    let thread: { id: string; status: string; mode: string } | null = null;
    if (body.thread_id !== undefined) {
      const { data: t, error: thErr } = await sb
        .from('comm_threads')
        .select('id, status, mode')
        .eq('account_id', accountId)
        .eq('id', body.thread_id)
        .maybeSingle();
      if (thErr) throw commDbError(thErr);
      if (!t) throw new ApiError(404, 'not_found', 'thread not found');
      thread = t as { id: string; status: string; mode: string };
      if (thread.status === 'closed') throw new ApiError(409, 'conflict', 'the thread is closed');
    }
    const isGroup = thread !== null && thread.mode === 'group';

    let toAddress: string | null = null;
    let groupAddresses: string[] | null = null;
    let participantId: string | null = null;

    if (isGroup) {
      // A group send addresses the whole thread; its recipient set is frozen
      // from the thread's ACTIVE bindings, never supplied on the body.
      if (body.to_address !== undefined) {
        throw new ApiError(
          400,
          'invalid_request',
          'a group thread derives recipients from its bindings; to_address is not accepted',
        );
      }
      if (body.participant_ref !== undefined) {
        throw new ApiError(
          400,
          'invalid_request',
          'a group send addresses the whole thread; participant_ref is not accepted',
        );
      }
      if (body.relay_of_interaction_id !== undefined) {
        throw new ApiError(400, 'invalid_request', 'relays do not exist in group mode');
      }
      const { data: bindings, error: bErr } = await sb
        .from('thread_channel_bindings')
        .select('participant_address')
        .eq('account_id', accountId)
        .eq('thread_id', body.thread_id!)
        .eq('active', true);
      if (bErr) throw commDbError(bErr);
      const rows = (bindings ?? []) as { participant_address: string }[];
      groupAddresses = [...new Set(rows.map((b) => b.participant_address))].sort();
      if (groupAddresses.length < 2) {
        throw new ApiError(
          409,
          'conflict',
          'the group thread needs at least 2 actively-bound members',
        );
      }
    } else {
      // 1:1 (or thread-less): explicit address, else the thread binding, else
      // the account's channel identity for the participant.
      if (
        body.to_address === undefined &&
        (body.thread_id === undefined || body.participant_ref === undefined)
      ) {
        throw new ApiError(
          400,
          'invalid_request',
          'provide to_address, or thread_id + participant_ref to resolve one',
        );
      }
      if (body.participant_ref !== undefined && body.thread_id === undefined) {
        throw new ApiError(400, 'invalid_request', 'participant_ref requires thread_id');
      }

      let participant: { id: string; party_type: string; party_id: string | null } | null = null;
      if (body.thread_id !== undefined && body.participant_ref !== undefined) {
        const { data: part, error: pErr } = await sb
          .from('comm_thread_participants')
          .select('id, party_type, party_id, left_at')
          .eq('account_id', accountId)
          .eq('thread_id', body.thread_id)
          .eq('id', body.participant_ref)
          .maybeSingle();
        if (pErr) throw commDbError(pErr);
        if (!part) throw new ApiError(404, 'not_found', 'participant not found in this thread');
        if (part.left_at !== null)
          throw new ApiError(409, 'conflict', 'the participant has left the thread');
        participant = part;
      }

      if (body.to_address !== undefined) {
        toAddress = normalizeAddress(body.channel, body.to_address);
      } else {
        // Binding first (the address the conversation is actually running on),
        // then the address book.
        const { data: binding, error: bErr } = await sb
          .from('thread_channel_bindings')
          .select('participant_address')
          .eq('account_id', accountId)
          .eq('thread_id', body.thread_id!)
          .eq('participant_id', body.participant_ref!)
          .eq('active', true)
          .maybeSingle();
        if (bErr) throw commDbError(bErr);
        let resolved = binding?.participant_address ?? null;
        if (resolved === null && participant && participant.party_id !== null) {
          const { data: ident, error: iErr } = await sb
            .from('channel_identities')
            .select('address')
            .eq('account_id', accountId)
            .eq('channel', body.channel)
            .eq('party_type', participant.party_type)
            .eq('party_id', participant.party_id)
            .limit(1)
            .maybeSingle();
          if (iErr) throw commDbError(iErr);
          resolved = ident?.address ?? null;
        }
        if (resolved === null) {
          throw new ApiError(
            422,
            'invalid_request',
            'no destination address is bound or on file for this participant',
          );
        }
        // Validate the resolved address against the requested channel too — a
        // binding stored for one channel must not be silently reused as the
        // destination for another (e.g. an sms binding for an email send).
        toAddress = normalizeAddress(body.channel, resolved);
      }
      participantId = body.participant_ref ?? null;
    }

    const { data, error } = await sb
      .from('comm_outbox')
      .insert({
        account_id: accountId,
        channel: body.channel,
        to_address: toAddress,
        group_addresses: groupAddresses,
        thread_id: body.thread_id ?? null,
        participant_id: participantId,
        body: body.body,
        subject: body.subject ?? null,
        template_id: body.template_id ?? null,
        not_before: body.not_before ?? null,
        relay_of_interaction_id: body.relay_of_interaction_id ?? null,
        tenancy_id: body.tenancy_id ?? null,
        maintenance_request_id: body.maintenance_request_id ?? null,
        approval_ref: body.approval_ref,
        approved_by: principal.type === 'agent' ? (body.approved_by ?? null) : c.get('auth').userId,
        author_type: principal.type === 'agent' ? 'agent' : 'landlord',
      })
      .select('*')
      .single();
    // commDbError maps the DB's typed SQLSTATEs; the P0004 opt-out trigger
    // surfaces here as 422 opted_out — for a group row that is the "any member
    // opted out" refusal (a group MMS reaches every member, so one opt-out
    // refuses the whole send).
    if (error) throw commDbError(error);
    return c.json(data as OutboxRow, 201);
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
