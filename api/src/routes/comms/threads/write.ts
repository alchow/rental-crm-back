import { createRoute, z } from '@hono/zod-openapi';
import { getSb } from '../../../supabase/request-client';
import { ApiError, errorResponses } from '../../_lib/error';
import {
  AccountAndIdParam,
  CommThreadBinding,
  CreateThreadMessageBody,
  RebindBody,
  ThreadMessageResponse,
} from '../schemas';
import {
  BINDING_COLS,
  commDbError,
  IDENTITY_CLAIM_KEY,
  normalizeAddress,
  requireManager,
  type CommsApp,
  type OutboxRow,
} from '../shared';
import { loadParticipants } from './helpers';

export function registerThreadWriteRoutes(app: CommsApp): void {
  const createThreadMessage = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/threads/{id}/messages',
    tags: ['comms'],
    summary:
      'Landlord-authored outbound into a thread: creates one send intent per ' +
      'counterparty participant (approved_by = caller, approval_ref = ' +
      "'self:<user_id>'). The journal entries are appended by the completion " +
      'path once the transport confirms each leg.',
    request: {
      params: AccountAndIdParam,
      body: {
        content: { 'application/json': { schema: CreateThreadMessageBody } },
        required: true,
      },
    },
    responses: {
      201: {
        description: 'send intents created',
        content: { 'application/json': { schema: ThreadMessageResponse } },
      },
      ...errorResponses,
    },
  });

  const rebindBinding = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/threads/{threadId}/bindings/{bindingId}/rebind',
    tags: ['comms'],
    summary:
      'Point an email binding at a new counterparty address (landlord, ' +
      'owner|manager). The mismatch-hygiene half of a classify: after a human ' +
      'confirms a sender_mismatch was really the participant writing from a new ' +
      'address, rebinding stops every FUTURE reply from mismatching. The reply ' +
      'token is untouched; the new address is learned into the address book.',
    request: {
      params: z.object({
        accountId: z
          .string()
          .uuid()
          .openapi({ param: { name: 'accountId', in: 'path' } }),
        threadId: z
          .string()
          .uuid()
          .openapi({ param: { name: 'threadId', in: 'path' } }),
        bindingId: z
          .string()
          .uuid()
          .openapi({ param: { name: 'bindingId', in: 'path' } }),
      }),
      body: { content: { 'application/json': { schema: RebindBody } }, required: true },
    },
    responses: {
      200: {
        description: 'updated binding',
        content: { 'application/json': { schema: CommThreadBinding } },
      },
      ...errorResponses,
    },
  });

  app.openapi(createThreadMessage, async (c) => {
    requireManager(c);
    const { accountId, id } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    const userId = c.get('auth').userId;

    const { data: thread, error: thErr } = await sb
      .from('comm_threads')
      .select('id, status, mode, channel, tenancy_id, maintenance_request_id')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (thErr) throw commDbError(thErr);
    if (!thread) throw new ApiError(404, 'not_found', 'not found');
    if (thread.status === 'closed') throw new ApiError(409, 'conflict', 'the thread is closed');

    if (thread.mode === 'group') {
      // A group send is ONE outbox row = one provider group message. The
      // recipient set is the thread's whole ACTIVE binding set (the landlord's
      // own phone included — the provider group session is keyed by the full
      // member set), frozen at intent time; any-member opt-out refuses at insert
      // (P0004 -> 422 opted_out).
      const { data: bindings, error: gErr } = await sb
        .from('thread_channel_bindings')
        .select('participant_address')
        .eq('account_id', accountId)
        .eq('thread_id', id)
        .eq('active', true);
      if (gErr) throw commDbError(gErr);
      const rows = (bindings ?? []) as { participant_address: string }[];
      const groupAddresses = [...new Set(rows.map((b) => b.participant_address))].sort();
      if (groupAddresses.length < 2) {
        throw new ApiError(
          409,
          'conflict',
          'the group thread needs at least 2 actively-bound members',
        );
      }
      const { data: row, error } = await sb
        .from('comm_outbox')
        .insert({
          account_id: accountId,
          // Group threads are always sms (DB CHECK), so this is effectively sms.
          channel: thread.channel,
          to_address: null,
          group_addresses: groupAddresses,
          thread_id: id,
          participant_id: null,
          body: body.body,
          not_before: body.not_before ?? null,
          tenancy_id: thread.tenancy_id,
          maintenance_request_id: thread.maintenance_request_id,
          approval_ref: `self:${userId}`,
          approved_by: userId,
          author_type: 'landlord',
        })
        .select('*')
        .single();
      if (error) throw commDbError(error);
      return c.json({ data: [row as OutboxRow] }, 201);
    }

    // One send intent per actively-bound counterparty. The binding carries the
    // address the conversation runs on; the leg dials on the thread's channel
    // (sms relays 1:1 per platform number, email relays natively per reply token).
    const { data: bindings, error: bErr } = await sb
      .from('thread_channel_bindings')
      .select('participant_id, participant_address')
      .eq('account_id', accountId)
      .eq('thread_id', id)
      .eq('active', true);
    if (bErr) throw commDbError(bErr);
    const participants = (await loadParticipants(c, accountId, [id])).get(id) ?? [];
    const present = new Map(
      participants
        .filter(
          (p) => (p.party_type === 'tenant' || p.party_type === 'vendor') && p.left_at === null,
        )
        .map((p) => [p.id, p]),
    );
    const targets = (
      (bindings ?? []) as { participant_id: string; participant_address: string }[]
    ).filter((b) => present.has(b.participant_id));
    if (targets.length === 0) {
      throw new ApiError(
        409,
        'conflict',
        'the thread has no actively-bound counterparty to message',
      );
    }

    // Landlord CC arm — fan-out parity with createOutbox: a flagged (is_cc)
    // participant's bound email rides every landlord-composed email leg as a
    // visible Cc, excluding the leg's own recipient. The author is deliberately
    // NOT excluded: an app-composed message exists only in-app, so the Cc copy
    // is the flagged landlord's email record of their own send (unlike relay
    // echoes, where the sender already holds the original). Both lists are
    // already loaded above; addresses were normalized at binding creation.
    const ccParticipantIds = new Set(
      participants.filter((p) => p.is_cc && p.left_at === null).map((p) => p.id),
    );
    const ccPool =
      thread.channel === 'email' && ccParticipantIds.size > 0
        ? [
            ...new Set(
              ((bindings ?? []) as { participant_id: string; participant_address: string }[])
                .filter((b) => ccParticipantIds.has(b.participant_id))
                .map((b) => b.participant_address),
            ),
          ]
        : [];

    const { data: rows, error } = await sb
      .from('comm_outbox')
      .insert(
        targets.map((t) => {
          const cc = ccPool.filter((a) => a !== t.participant_address).slice(0, 10);
          return {
            account_id: accountId,
            channel: thread.channel,
            to_address: t.participant_address,
            cc_addresses: cc.length > 0 ? cc : null,
            thread_id: id,
            participant_id: t.participant_id,
            body: body.body,
            // No outbox subject on a thread leg: the transport renders the actual
            // email subject from the thread's subject seed ("Re: …").
            not_before: body.not_before ?? null,
            // Inherit the thread's context so the message lands in the tenancy /
            // maintenance-request feed on completion.
            tenancy_id: thread.tenancy_id,
            maintenance_request_id: thread.maintenance_request_id,
            approval_ref: `self:${userId}`,
            approved_by: userId,
            author_type: 'landlord',
          };
        }),
      )
      .select('*');
    if (error) throw commDbError(error);
    return c.json({ data: (rows ?? []) as OutboxRow[] }, 201);
  });

  app.openapi(rebindBinding, async (c) => {
    requireManager(c);
    const { accountId, threadId, bindingId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);

    const { data, error: bErr } = await sb
      .from('thread_channel_bindings')
      .select(BINDING_COLS)
      .eq('account_id', accountId)
      .eq('thread_id', threadId)
      .eq('id', bindingId)
      .maybeSingle();
    if (bErr) throw commDbError(bErr);
    if (!data) throw new ApiError(404, 'not_found', 'not found');
    const binding = data as unknown as z.infer<typeof CommThreadBinding>;
    if (binding.channel !== 'email') {
      throw new ApiError(
        400,
        'invalid_request',
        'only email bindings can be rebound (sms routes by platform number)',
      );
    }
    if (!binding.active) {
      throw new ApiError(409, 'conflict', 'the binding is inactive');
    }

    const address = normalizeAddress('email', body.address);
    if (address === binding.participant_address) {
      // Idempotent: rebinding to the current address returns it unchanged.
      return c.json(binding, 200);
    }

    const { data: updated, error: uErr } = await sb
      .from('thread_channel_bindings')
      .update({ participant_address: address })
      .eq('account_id', accountId)
      .eq('id', bindingId)
      .select(BINDING_COLS)
      .single();
    if (uErr) throw commDbError(uErr);

    // Learn the new address as a THREAD-scoped 'thread_rebind' claim: the
    // human bound this address to THIS conversation leg, so replies routed by
    // the parent/thread context recognize it — without granting the claim
    // account-wide reach. This replaces the old first-writer-wins address
    // book: a different party's claim on the same address now coexists as its
    // own row (the resolver ranks human/verified claims above learned ones,
    // and only link_unmatched_inbound — a human — ever supersedes a claim).
    const { data: participant, error: pErr } = await sb
      .from('comm_thread_participants')
      .select('party_type, party_id')
      .eq('account_id', accountId)
      .eq('id', binding.participant_id)
      .maybeSingle();
    if (pErr) throw commDbError(pErr);
    if (
      participant?.party_id &&
      ['tenant', 'vendor', 'landlord_user'].includes(participant.party_type as string)
    ) {
      const { error: idErr } = await sb.from('channel_identities').upsert(
        {
          account_id: accountId,
          party_type: participant.party_type,
          party_id: participant.party_id,
          channel: 'email',
          address,
          source: 'thread_rebind',
          scope_type: 'thread',
          scope_id: binding.thread_id,
          created_by: c.get('auth').userId,
        },
        { onConflict: IDENTITY_CLAIM_KEY, ignoreDuplicates: true },
      );
      if (idErr) throw commDbError(idErr);
    }

    return c.json(updated as z.infer<typeof CommThreadBinding>, 200);
  });
}
