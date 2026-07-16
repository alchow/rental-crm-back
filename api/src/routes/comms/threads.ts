import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getSb } from '../../supabase/request-client';
import { loadEnv } from '../../env';
import { ApiError, errorResponses } from '../_lib/error';
import { keysetPage } from '../_lib/cursor';
import { brandedReplyDomain } from '../_lib/subdomain';
import { withResolvedAuthorship } from '../_lib/authorship';
import { loadInteractionParticipants } from '../interactions';
import {
  AccountAndIdParam,
  AccountParam,
  CommThreadBinding,
  CommThreadDetail,
  CreateThreadBody,
  CreateThreadMessageBody,
  RebindBody,
  ThreadListQuery,
  ThreadListResponse,
  ThreadMessageResponse,
} from './schemas';
import type { CommOutboxStatus, CommRelayLeg, CommThread } from './schemas';
import {
  BINDING_COLS,
  commDbError,
  normalizeAddress,
  PARTICIPANT_COLS,
  requireAgentOrManager,
  requireManager,
  THREAD_COLS,
  type CommsApp,
  type OutboxRow,
  type ParticipantRow,
} from './shared';

export function registerThreadRoutes(app: CommsApp): void {
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

  const createThread = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/threads',
    tags: ['comms'],
    summary:
      'Create a thread with participants and channel bindings (landlord). Each ' +
      'counterparty participant is bound to one of the account’s platform ' +
      'numbers; a counterparty may hold only one active thread per platform ' +
      'number.',
    request: {
      params: AccountParam,
      body: { content: { 'application/json': { schema: CreateThreadBody } }, required: true },
    },
    responses: {
      201: {
        description: 'created',
        content: { 'application/json': { schema: CommThreadDetail } },
      },
      ...errorResponses,
    },
  });

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

  async function loadParticipants(
    c: Context,
    accountId: string,
    threadIds: string[],
  ): Promise<Map<string, ParticipantRow[]>> {
    const map = new Map<string, ParticipantRow[]>();
    if (threadIds.length === 0) return map;
    const { data, error } = await getSb(c)
      .from('comm_thread_participants')
      .select(PARTICIPANT_COLS)
      .eq('account_id', accountId)
      .in('thread_id', threadIds)
      .order('joined_at', { ascending: true });
    if (error) throw commDbError(error);
    for (const p of (data ?? []) as ParticipantRow[]) {
      const list = map.get(p.thread_id) ?? [];
      list.push(p);
      map.set(p.thread_id, list);
    }
    return map;
  }

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

  app.openapi(createThread, async (c) => {
    requireManager(c);
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);

    // Channel gating. sms (bridged + group) and bridged email are the built
    // paths. Voice bridging and group email remain unbuilt: a group email would
    // fan a native group out of tokenized 1:1 reply addresses (no shared
    // routing key), so the DB CHECK (comm_threads_group_sms_only) also backstops
    // it. (Direct POST /comms/outbox remains multi-channel by design.)
    if (body.channel === 'voice') {
      throw new ApiError(501, 'not_implemented', 'bridged voice threads are not supported yet');
    }
    if (body.channel === 'email' && body.mode === 'group') {
      throw new ApiError(
        501,
        'not_implemented',
        'group email threads are not supported yet; group mode is sms-only',
      );
    }
    const isEmail = body.channel === 'email';

    // subject is an email-only thread seed (DB CHECK comm_threads_subject_email_only
    // backstops). Reject it on any other channel with a field-scoped 400.
    if (body.subject !== undefined && !isEmail) {
      throw new ApiError(400, 'invalid_request', 'subject is only valid on email threads', {
        fieldErrors: { subject: ['only valid on email threads'] },
      });
    }

    // Account branding row, read once: the email branch may mint reply tokens
    // under this account's branded subdomain, and the 201 assembly echoes the
    // sender_display_name back on every channel. RLS member SELECT permits it.
    const { data: account, error: acctErr } = await sb
      .from('accounts')
      .select('email_subdomain, sender_display_name')
      .eq('id', accountId)
      .maybeSingle();
    if (acctErr) throw commDbError(acctErr);
    const senderDisplayName = (account?.sender_display_name ?? null) as string | null;

    // Email threads mint a UNIQUE tokenized reply address per participant under a
    // receiving domain. Prefer the account's branded subdomain
    // (`<subdomain>.<EMAIL_PLATFORM_PARENT_DOMAIN>`) when both are configured;
    // otherwise fall back to the shared EMAIL_REPLY_DOMAIN. With NO resolvable
    // domain at all there is nowhere for replies to land, so refuse up front
    // (retryable once ops configures one).
    let domain: string | null = null;
    if (isEmail) {
      const env = loadEnv();
      const branded = brandedReplyDomain(
        (account?.email_subdomain ?? null) as string | null,
        env.EMAIL_PLATFORM_PARENT_DOMAIN,
      );
      const resolved = branded ?? env.EMAIL_REPLY_DOMAIN;
      if (resolved === null) {
        throw new ApiError(
          503,
          'service_unavailable',
          'email threads are not configured (no branded subdomain and EMAIL_REPLY_DOMAIN unset)',
        );
      }
      domain = resolved.toLowerCase();
    }

    const mode = body.mode;

    // Counterparties need a reachable address; require party_id so identity
    // lookup / journal attribution stay honest.
    for (const p of body.participants) {
      if ((p.party_type === 'tenant' || p.party_type === 'vendor') && p.party_id === undefined) {
        throw new ApiError(400, 'invalid_request', `${p.party_type} participants require party_id`);
      }
    }

    // A group thread is a provider-native MMS group of human members; the agent
    // transport is never a member of it.
    if (mode === 'group') {
      for (const p of body.participants) {
        if (p.party_type === 'agent') {
          throw new ApiError(
            400,
            'invalid_request',
            'agent participants are not part of a group MMS thread',
          );
        }
      }
    }

    // An email thread relays natively between human inboxes (tenant/vendor +
    // landlord); the agent transport is not a party to it.
    if (isEmail) {
      for (const p of body.participants) {
        if (p.party_type === 'agent') {
          throw new ApiError(
            400,
            'invalid_request',
            'agent participants are not part of an email thread',
          );
        }
      }
    }

    // is_cc (the landlord CC arm) is an email-only opt-in — a visible Cc has no
    // meaning on sms/voice, and createOutbox only ever freezes cc_addresses on
    // email legs. Reject it up front rather than storing a flag that can never
    // take effect.
    if (!isEmail && body.participants.some((p) => p.is_cc)) {
      throw new ApiError(400, 'invalid_request', 'is_cc is only valid on email threads', {
        fieldErrors: { participants: ['is_cc is only valid on email threads'] },
      });
    }
    // …and landlord-only (DB CHECK comm_thread_participants_cc_landlord is the
    // backstop): CC addresses ride outside the opt-out refusal — safe only
    // while the copied party is the landlord copying their own conversation.
    // A tenant/vendor flagged is_cc would route a counterparty through that
    // blind spot.
    if (body.participants.some((p) => p.is_cc && p.party_type !== 'landlord_user')) {
      throw new ApiError(
        400,
        'invalid_request',
        'is_cc is only valid on landlord_user participants',
        { fieldErrors: { participants: ['is_cc is only valid on landlord_user participants'] } },
      );
    }

    const counterparties = body.participants.filter(
      (p) => p.party_type === 'tenant' || p.party_type === 'vendor',
    );
    if (counterparties.length === 0) {
      throw new ApiError(
        400,
        'invalid_request',
        'a thread needs at least one tenant or vendor participant',
      );
    }

    // Resolve every addressable participant BEFORE creating anything, so a
    // resolution failure leaves no partial thread. Bridged sms binds the
    // counterparties only (tenant/vendor); a group thread AND an email thread
    // additionally bind the landlord_user members — the group landlord's phone is
    // a group member, and the email landlord replies natively from their own
    // inbox so they get a tokenized reply address too.
    const addressable = (t: string): boolean =>
      t === 'tenant' || t === 'vendor' || ((mode === 'group' || isEmail) && t === 'landlord_user');
    const resolvedAddresses = new Map<number, string>();
    for (const [i, p] of body.participants.entries()) {
      if (!addressable(p.party_type)) continue;
      if (p.address !== undefined) {
        resolvedAddresses.set(i, normalizeAddress(body.channel, p.address));
        continue;
      }
      if (p.party_id !== undefined) {
        const { data: ident, error: iErr } = await sb
          .from('channel_identities')
          .select('address')
          .eq('account_id', accountId)
          .eq('channel', body.channel)
          .eq('party_type', p.party_type)
          .eq('party_id', p.party_id)
          .limit(1)
          .maybeSingle();
        if (iErr) throw commDbError(iErr);
        if (ident) {
          resolvedAddresses.set(i, ident.address);
          continue;
        }
        // Email landlord fallback: the caller replies from their OWN inbox, so a
        // landlord_user participant that IS the caller resolves to the caller's
        // JWT email (lowercased) when no identity is on file. Skip if absent.
        if (isEmail && p.party_type === 'landlord_user' && p.party_id === c.get('auth').userId) {
          const authEmail = c.get('auth').claims.email;
          if (authEmail) {
            resolvedAddresses.set(i, authEmail.toLowerCase());
            continue;
          }
        }
        throw new ApiError(
          422,
          'invalid_request',
          `no ${body.channel} address on file for participant ${i}; supply address explicitly`,
        );
      }
      // No explicit address and no party_id.
      if (isEmail) {
        // An email landlord_user with neither can't be resolved (no identity key,
        // and no way to confirm it is the caller); ask for an explicit address.
        throw new ApiError(
          422,
          'invalid_request',
          `no ${body.channel} address on file for participant ${i}; supply address explicitly`,
        );
      }
      // Only a group landlord_user reaches here (tenant/vendor already required
      // party_id above); it needs an address or a party_id to resolve one.
      throw new ApiError(
        400,
        'invalid_request',
        'landlord_user participants in a group thread require an address or party_id',
      );
    }

    // Email-shape validation on the resolved set (group has its own block below):
    // an email thread must carry a resolvable landlord_user (they reply from
    // their own inbox), and every reply-address participant must be distinct.
    if (isEmail) {
      const hasLandlord = body.participants.some(
        (p, i) => p.party_type === 'landlord_user' && resolvedAddresses.has(i),
      );
      if (!hasLandlord) {
        throw new ApiError(
          400,
          'invalid_request',
          'an email thread must include a landlord_user participant with an email address (they reply from their own inbox)',
        );
      }
      const emailAddresses = [...resolvedAddresses.values()];
      if (new Set(emailAddresses).size !== emailAddresses.length) {
        throw new ApiError(
          400,
          'invalid_request',
          'email thread participant addresses must be distinct',
        );
      }
    }

    // Group-shape validation on the resolved member set (bridged skips all of
    // this): the landlord's phone must be a member, addresses must be pairwise
    // distinct, and the set is 2..7 (8 incl. our platform number).
    if (mode === 'group') {
      const hasLandlord = body.participants.some(
        (p, i) => p.party_type === 'landlord_user' && resolvedAddresses.has(i),
      );
      if (!hasLandlord) {
        throw new ApiError(
          400,
          'invalid_request',
          'a group thread must include a landlord_user participant with an address (their phone is a group member)',
        );
      }
      const memberAddresses = [...resolvedAddresses.values()];
      const distinct = new Set(memberAddresses);
      if (distinct.size !== memberAddresses.length) {
        throw new ApiError(400, 'invalid_request', 'group participant addresses must be distinct');
      }
      if (distinct.size < 2) {
        throw new ApiError(
          400,
          'invalid_request',
          'a group thread needs at least 2 member addresses',
        );
      }
      if (distinct.size > 7) {
        throw new ApiError(
          400,
          'invalid_request',
          'a group thread carries at most 7 member addresses (8 participants including the platform number)',
        );
      }
    }

    // The account's platform number carries every counterparty leg. Email threads
    // route by a minted reply token per participant, so they need no platform
    // number — skip the lookup entirely.
    let number: { number: string } | null = null;
    if (!isEmail) {
      const { data: num, error: numErr } = await sb
        .from('platform_numbers')
        .select('number')
        .eq('account_id', accountId)
        .eq('status', 'active')
        .contains('capabilities', [body.channel])
        .limit(1)
        .maybeSingle();
      if (numErr) throw commDbError(numErr);
      if (!num) {
        throw new ApiError(
          409,
          'conflict',
          `the account has no active platform number with ${body.channel} capability`,
        );
      }
      number = num as { number: string };
    }

    // Canonical group routing key. This MUST stay in lockstep with
    // public._comm_group_routing_key (capture_inbound recomputes it for inbound
    // set-matching; the group capture test locks the two together): our number,
    // '>', then the deduped members minus our own number, byte-order sorted (JS
    // default sort on these ASCII addresses matches collate "C"). Bridged threads
    // carry no key (the DB CHECK (mode='group') = (group_routing_key is not null)
    // rejects anything else).
    // group implies !isEmail (email group is 501'd above), so `number` is set on
    // the only branch that reads it.
    const addresses = [...resolvedAddresses.values()];
    const groupKey =
      mode === 'group'
        ? number!.number +
          '>' +
          [...new Set(addresses)]
            .filter((a) => a !== number!.number)
            .sort()
            .join('|')
        : null;

    const { data: thread, error: thErr } = await sb
      .from('comm_threads')
      .insert({
        account_id: accountId,
        kind: body.kind,
        mode,
        channel: body.channel,
        subject: body.subject ?? null,
        group_routing_key: groupKey,
        tenancy_id: body.tenancy_id ?? null,
        maintenance_request_id: body.maintenance_request_id ?? null,
      })
      .select('*')
      .single();
    if (thErr) {
      if (mode === 'group' && thErr.code === '23505') {
        throw new ApiError(
          409,
          'conflict',
          'an identical active group thread already exists on this platform number',
        );
      }
      throw commDbError(thErr);
    }

    // Participants + bindings. PostgREST statements are not one transaction;
    // on a later failure we best-effort delete the skeleton (hard delete is
    // audited as hard_deleted) and rethrow, so a retry starts clean.
    try {
      const { data: parts, error: pErr } = await sb
        .from('comm_thread_participants')
        .insert(
          body.participants.map((p) => ({
            account_id: accountId,
            thread_id: thread.id as string,
            party_type: p.party_type,
            party_id: p.party_id ?? null,
            is_cc: p.is_cc ?? false,
          })),
        )
        .select(PARTICIPANT_COLS);
      if (pErr) throw commDbError(pErr);
      const participants = (parts ?? []) as ParticipantRow[];

      const bindingRows = [];
      for (const [i, p] of body.participants.entries()) {
        const address = resolvedAddresses.get(i);
        if (address === undefined) continue;
        // insert order preserved participants order; match by index.
        const participant = participants[i];
        if (!participant) continue;
        if (isEmail) {
          // Email bindings route by a UNIQUE minted reply token (128-bit random),
          // not a shared platform number; the whole address is lowercase. The DB
          // stamp trigger sets `channel` from the thread — never send it.
          const token = ('t-' + randomBytes(16).toString('hex') + '@' + domain!).toLowerCase();
          bindingRows.push({
            account_id: accountId,
            thread_id: thread.id as string,
            participant_id: participant.id,
            participant_address: address,
            reply_address: token,
          });
        } else {
          bindingRows.push({
            account_id: accountId,
            thread_id: thread.id as string,
            participant_id: participant.id,
            platform_number: number!.number as string,
            participant_address: address,
          });
        }
        void p;
      }
      const { data: bindings, error: bindErr } = await sb
        .from('thread_channel_bindings')
        .insert(bindingRows)
        .select(BINDING_COLS);
      if (bindErr) {
        if (bindErr.code === '23505') {
          throw new ApiError(
            409,
            'conflict',
            'a counterparty already has an active thread on this platform number',
          );
        }
        throw commDbError(bindErr);
      }

      // Remember explicit addresses for future attribution/resolution.
      const newIdentities = body.participants
        .map((p, i) => ({ p, i }))
        .filter(
          ({ p, i }) =>
            p.address !== undefined && resolvedAddresses.has(i) && p.party_id !== undefined,
        )
        .map(({ p, i }) => ({
          account_id: accountId,
          party_type: p.party_type,
          party_id: p.party_id!,
          channel: body.channel,
          address: resolvedAddresses.get(i)!,
        }));
      if (newIdentities.length > 0) {
        const { error: idErr } = await sb.from('channel_identities').upsert(newIdentities, {
          onConflict: 'account_id,channel,address',
          ignoreDuplicates: true,
        });
        if (idErr) throw commDbError(idErr);
      }

      return c.json(
        {
          ...(thread as z.infer<typeof CommThread>),
          participants,
          bindings: (bindings ?? []) as z.infer<typeof CommThreadBinding>[],
          messages: [],
          messages_next_cursor: null,
          sender_display_name: senderDisplayName,
        } as z.infer<typeof CommThreadDetail>,
        201,
      );
    } catch (e) {
      // Best-effort cleanup of the skeleton; the original error is what the
      // client needs to see.
      await sb
        .from('thread_channel_bindings')
        .delete()
        .eq('account_id', accountId)
        .eq('thread_id', thread.id as string);
      await sb
        .from('comm_thread_participants')
        .delete()
        .eq('account_id', accountId)
        .eq('thread_id', thread.id as string);
      await sb
        .from('comm_threads')
        .delete()
        .eq('account_id', accountId)
        .eq('id', thread.id as string);
      throw e;
    }
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

    // Learn the new address so attribution/resolution (incl. persona capture)
    // recognizes it account-wide, not just on this leg.
    //
    // KNOWN LIMITATION (review, deliberate): ignoreDuplicates means an address
    // that ALREADY maps to a different party keeps its OLD mapping — the
    // address book stays first-writer-wins (same semantics as the capture
    // paths' learning upserts). The binding update above is still the primary
    // outcome (replies on THIS leg verify), but future cold/persona mail from
    // a shared address may attribute to the previously-mapped party. Changing
    // the book to last-human-wins is a cross-cutting decision tracked in
    // docs/persona-email-contract.md § Known limitations.
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
        },
        { onConflict: 'account_id,channel,address', ignoreDuplicates: true },
      );
      if (idErr) throw commDbError(idErr);
    }

    return c.json(updated as z.infer<typeof CommThreadBinding>, 200);
  });
}
