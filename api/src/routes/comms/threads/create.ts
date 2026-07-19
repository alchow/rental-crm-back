import { randomBytes } from 'node:crypto';
import type { z } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { getSb } from '../../../supabase/request-client';
import { loadEnv } from '../../../env';
import { ApiError, errorResponses } from '../../_lib/error';
import { brandedReplyDomain } from '../../_lib/subdomain';
import { AccountParam, CommThreadDetail, CreateThreadBody } from '../schemas';
import type { CommThread , CommThreadBinding} from '../schemas';
import {
  BINDING_COLS,
  commDbError,
  IDENTITY_CLAIM_KEY,
  normalizeAddress,
  PARTICIPANT_COLS,
  pickPreferredIdentity,
  requireManager,
  type CommsApp,
  type IdentityClaimPick,
  type ParticipantRow,
} from '../shared';

export function registerThreadCreateRoute(app: CommsApp): void {
  const createThread = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/threads',
    tags: ['comms'],
    summary:
      'Create a thread with participants and channel bindings (landlord). Each ' +
      'counterparty participant is bound to one of the account’s platform ' +
      'numbers; a counterparty may hold only one active thread per platform ' +
      'number.',
    description:
      'An EMAIL thread is a conversational surface: it requires the account to ' +
      'have configured email branding. When the platform parent domain is set ' +
      'but the account carries no branded subdomain, creation is refused 422 ' +
      "error.code=invalid_request, message 'email branding is not configured' " +
      '(same stable message as the outbox send gate). A 503 is returned only in ' +
      'the platform-env-missing case (no receiving domain configured anywhere). ' +
      'Non-email (sms/group) threads are unaffected.',
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
    // receiving domain, resolved by a strict W1 ladder (no CONVERSATIONAL email
    // without branding):
    //   1. Branded account (subdomain + platform parent both set) → mint under
    //      `<subdomain>.<EMAIL_PLATFORM_PARENT_DOMAIN>`.
    //   2. Platform parent configured but this account is unbranded → 422 hard
    //      gate with the SAME stable message the bare/thread-leg outbox gate
    //      keys on. An email thread here would mint on a shared domain and
    //      dispatch From the platform noreply@ — a conversation nobody can
    //      answer. Refuse, so the frontend routes the owner into branding setup.
    //   3. Platform parent NOT configured at all (platform-env-missing) →
    //      branding does not exist as a feature; fall back to the shared
    //      EMAIL_REPLY_DOMAIN rather than brick email.
    //   4. Nothing configured anywhere → 503, nowhere for replies to land
    //      (retryable once ops configures a domain).
    // Non-email threads never enter this block.
    let domain: string | null = null;
    if (isEmail) {
      const env = loadEnv();
      const branded = brandedReplyDomain(
        (account?.email_subdomain ?? null) as string | null,
        env.EMAIL_PLATFORM_PARENT_DOMAIN,
      );
      if (branded !== null) {
        domain = branded.toLowerCase();
      } else if (env.EMAIL_PLATFORM_PARENT_DOMAIN !== null) {
        throw new ApiError(422, 'invalid_request', 'email branding is not configured');
      } else if (env.EMAIL_REPLY_DOMAIN !== null) {
        domain = env.EMAIL_REPLY_DOMAIN.toLowerCase();
      } else {
        throw new ApiError(
          503,
          'service_unavailable',
          'email threads are not configured (no branded subdomain and EMAIL_REPLY_DOMAIN unset)',
        );
      }
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
        // A party may hold several live claims now; pick deterministically
        // (human_link, then verified, then newest) — never row order.
        const { data: idents, error: iErr } = await sb
          .from('channel_identities')
          .select('address, source, verified_at, created_at')
          .eq('account_id', accountId)
          .eq('channel', body.channel)
          .eq('party_type', p.party_type)
          .eq('party_id', p.party_id)
          .is('superseded_at', null);
        if (iErr) throw commDbError(iErr);
        const ident = pickPreferredIdentity((idents ?? []) as IdentityClaimPick[]);
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

      // Remember explicit addresses for future attribution/resolution as
      // account-wide 'thread_rebind' claims (verified tier): the caller
      // EXPLICITLY supplied this address for this party at create time, and
      // bare sends/casts keep resolving off it account-wide (unchanged
      // behavior). Additive on the claim key — a different party's claim on
      // the same address now coexists instead of being silently dropped, and
      // the resolver ranks the claims instead of trusting write order.
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
          source: 'thread_rebind',
          created_by: c.get('auth').userId,
        }));
      if (newIdentities.length > 0) {
        const { error: idErr } = await sb.from('channel_identities').upsert(newIdentities, {
          onConflict: IDENTITY_CLAIM_KEY,
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
}
