import type { z } from '@hono/zod-openapi';
import type { CreateOutboxBody } from '../schemas';
import type { getSb } from '../../../supabase/request-client';
import { nullableRpcArg } from '../../../supabase/db-types';
import { ApiError } from '../../_lib/error';
import {
  commDbError,
  normalizeAddress,
  pickPreferredIdentity,
  type IdentityClaimPick,
} from '../shared';

interface OutboxDestination {
  toAddress: string | null;
  groupAddresses: string[] | null;
  participantId: string | null;
  ccAddresses: string[] | null;
}

export async function resolveOutboxDestination(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  body: z.infer<typeof CreateOutboxBody>,
): Promise<OutboxDestination> {
  // Resolve group mode before applying one-to-one destination requirements.
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
  let ccAddresses: string[] | null = null;

  if (isGroup) {
    // Freeze group recipients from active bindings; callers cannot supply the set.
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
      // SECURITY: A private text may echo only into a two-member group containing
      // its sender and one landlord; never broadcast it to a larger group.
      const { data: members, error: mErr } = await sb
        .from('comm_thread_participants')
        .select('id, party_type, party_id')
        .eq('account_id', accountId)
        .eq('thread_id', body.thread_id!)
        .is('left_at', null);
      if (mErr) throw commDbError(mErr);
      const live = (members ?? []) as {
        id: string;
        party_type: string;
        party_id: string | null;
      }[];
      const counterparties = live.filter(
        (m) => m.party_type === 'tenant' || m.party_type === 'vendor',
      );
      const landlords = live.filter((m) => m.party_type === 'landlord_user');
      const sole = counterparties[0];
      if (live.length !== 2 || counterparties.length !== 1 || landlords.length !== 1 || !sole) {
        throw new ApiError(
          409,
          'conflict',
          'a group relay is only permitted into a two-member thread (the sender and the landlord)',
        );
      }
      const { data: orig, error: oErr } = await sb
        .from('interactions')
        .select('id, party_type, party_id')
        .eq('account_id', accountId)
        .eq('id', body.relay_of_interaction_id)
        .maybeSingle();
      if (oErr) throw commDbError(oErr);
      if (!orig || orig.party_type !== sole.party_type || orig.party_id !== sole.party_id) {
        throw new ApiError(
          409,
          'conflict',
          "a group relay must reference an interaction attributed to the thread's sole counterparty",
        );
      }
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

    // Landlord email relays prefer the authoritative owner/manager email;
    // bindings and address-book claims supply the fallback.
    const isLandlordEmailRelay =
      body.channel === 'email' &&
      body.relay_of_interaction_id !== undefined &&
      participant !== null &&
      participant.party_type === 'landlord_user' &&
      participant.party_id !== null;

    if (body.to_address !== undefined) {
      toAddress = normalizeAddress(body.channel, body.to_address);
    } else {
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
        // Prefer human-linked, then verified, then newest identity claims.
        const { data: idents, error: iErr } = await sb
          .from('channel_identities')
          .select('address, source, verified_at, created_at')
          .eq('account_id', accountId)
          .eq('channel', body.channel)
          .eq('party_type', participant.party_type)
          .eq('party_id', participant.party_id)
          .is('superseded_at', null);
        if (iErr) throw commDbError(iErr);
        resolved = pickPreferredIdentity((idents ?? []) as IdentityClaimPick[])?.address ?? null;
      }
      // Defer missing-address rejection until the authoritative landlord lookup.
      if (resolved === null && !isLandlordEmailRelay) {
        throw new ApiError(
          422,
          'invalid_request',
          'no destination address is bound or on file for this participant',
        );
      }
      // Reject bindings incompatible with the requested channel.
      toAddress = resolved === null ? null : normalizeAddress(body.channel, resolved);
    }
    participantId = body.participant_ref ?? null;

    if (isLandlordEmailRelay) {
      // The database resolves the landlord address and detects already-delivered mail.
      const { data: relayTarget, error: rtErr } = await sb.rpc('resolve_relay_landlord_recipient', {
        p_account_id: accountId,
        p_user_id: participant!.party_id!,
        p_source_interaction_id: body.relay_of_interaction_id!,
        p_fallback_address: nullableRpcArg(toAddress),
      });
      if (rtErr) throw commDbError(rtErr);
      const target = (
        (relayTarget ?? []) as { to_address: string | null; already_delivered: boolean }[]
      )[0];
      if (!target || target.to_address === null) {
        throw new ApiError(
          422,
          'invalid_request',
          'no destination address is bound or on file for this participant',
        );
      }
      // A landlord already in the source cast must not receive a duplicate relay.
      if (target.already_delivered) {
        throw new ApiError(
          409,
          'relay_already_delivered',
          'the landlord already received this mail directly (e.g. as a visible Cc); no relay leg was created',
        );
      }
      toAddress = normalizeAddress(body.channel, target.to_address);
    }

    // Freeze visible Cc from active email bindings, excluding this recipient.
    // Cc complements relay delivery; queued intents retain this address snapshot.
    if (body.channel === 'email' && body.thread_id !== undefined) {
      const { data: ccParts, error: ccPartErr } = await sb
        .from('comm_thread_participants')
        .select('id, party_type, party_id')
        .eq('account_id', accountId)
        .eq('thread_id', body.thread_id)
        .eq('is_cc', true)
        .is('left_at', null);
      if (ccPartErr) throw commDbError(ccPartErr);
      let flagged = (
        (ccParts ?? []) as { id: string; party_type: string; party_id: string | null }[]
      ).filter((p) => p.id !== body.participant_ref);
      // Do not Cc a flagged participant on a relay of their own message.
      if (flagged.length > 0 && body.relay_of_interaction_id !== undefined) {
        const { data: relayed, error: relErr } = await sb
          .from('interactions')
          .select('party_id')
          .eq('account_id', accountId)
          .eq('id', body.relay_of_interaction_id)
          .maybeSingle();
        if (relErr) throw commDbError(relErr);
        // Match by account-scoped UUID: journal and participant role vocabularies differ.
        if (relayed && relayed.party_id !== null) {
          flagged = flagged.filter((p) => p.party_id !== relayed.party_id);
        }
      }
      if (flagged.length > 0) {
        const { data: ccBindings, error: ccBindErr } = await sb
          .from('thread_channel_bindings')
          .select('participant_address')
          .eq('account_id', accountId)
          .eq('thread_id', body.thread_id)
          .in(
            'participant_id',
            flagged.map((p) => p.id),
          )
          .eq('channel', 'email')
          .eq('active', true);
        if (ccBindErr) throw commDbError(ccBindErr);
        // Drop malformed stored Cc addresses so they cannot block the primary send.
        const addrs = [
          ...new Set(
            (ccBindings ?? [])
              .map((b) => (b.participant_address as string).toLowerCase())
              .filter((a) => a.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))
              .filter((a) => a !== toAddress),
          ),
        ].slice(0, 10); // matches the comm_outbox_cc_size CHECK bound
        if (addrs.length > 0) ccAddresses = addrs;
      }
    }

    // Add the landlord author's authoritative email for reply-all on tenant/vendor relays.
    // The author is a sender, so ignore already_delivered; DB triggers scrub opt-outs.
    if (
      body.channel === 'email' &&
      body.thread_id !== undefined &&
      body.relay_of_interaction_id !== undefined &&
      participant !== null &&
      (participant.party_type === 'tenant' || participant.party_type === 'vendor')
    ) {
      const { data: sourceRow, error: srcErr } = await sb
        .from('interactions')
        .select('actor, author_type, direction')
        .eq('account_id', accountId)
        .eq('id', body.relay_of_interaction_id)
        .maybeSingle();
      if (srcErr) throw commDbError(srcErr);
      if (
        sourceRow !== null &&
        sourceRow.actor === 'system:comm-persona-cc' &&
        sourceRow.direction === 'outbound' &&
        sourceRow.author_type === 'landlord'
      ) {
        const { data: senderCast, error: castErr } = await sb
          .from('interaction_participants')
          .select('party_id, address')
          .eq('account_id', accountId)
          .eq('interaction_id', body.relay_of_interaction_id)
          .eq('role', 'sender')
          .eq('party_type', 'landlord_user')
          .limit(1)
          .maybeSingle();
        if (castErr) throw commDbError(castErr);
        let landlordCc: string | null = null;
        if (senderCast?.party_id != null) {
          const { data: rec, error: recErr } = await sb.rpc('resolve_relay_landlord_recipient', {
            p_account_id: accountId,
            p_user_id: senderCast.party_id as string,
            p_source_interaction_id: body.relay_of_interaction_id,
            p_fallback_address: nullableRpcArg((senderCast.address as string | null) ?? null),
          });
          if (recErr) throw commDbError(recErr);
          landlordCc = ((rec ?? []) as { to_address: string | null }[])[0]?.to_address ?? null;
        } else {
          landlordCc = (senderCast?.address as string | null) ?? null;
        }
        if (landlordCc !== null) {
          const addr = landlordCc.toLowerCase();
          if (addr !== toAddress && addr.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
            ccAddresses = [...new Set([...(ccAddresses ?? []), addr])].slice(0, 10);
          }
        }
      }
    }

    // Add the verified inbound sender's frozen address for reply-all on landlord relays.
    // SECURITY: Unverified senders must never become reply targets.
    if (isLandlordEmailRelay) {
      const { data: relaySource, error: relSrcErr } = await sb
        .from('interactions')
        .select('author_type, direction, attestation')
        .eq('account_id', accountId)
        .eq('id', body.relay_of_interaction_id!)
        .maybeSingle();
      if (relSrcErr) throw commDbError(relSrcErr);
      if (
        relaySource !== null &&
        relaySource.direction === 'inbound' &&
        (relaySource.author_type === 'tenant' || relaySource.author_type === 'vendor') &&
        relaySource.attestation !== 'unverified'
      ) {
        const { data: authorCast, error: authorErr } = await sb
          .from('interaction_participants')
          .select('address')
          .eq('account_id', accountId)
          .eq('interaction_id', body.relay_of_interaction_id!)
          .eq('role', 'sender')
          .limit(1)
          .maybeSingle();
        if (authorErr) throw commDbError(authorErr);
        const authorAddr = (authorCast?.address as string | null)?.toLowerCase() ?? null;
        if (
          authorAddr !== null &&
          authorAddr !== toAddress &&
          authorAddr.length <= 320 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorAddr)
        ) {
          ccAddresses = [...new Set([...(ccAddresses ?? []), authorAddr])].slice(0, 10);
        }
      }
    }

    // Malformed caller-supplied Cc is a field error; the DB scrubs opt-outs at insert.
    if (body.cc_addresses !== undefined) {
      const seen = new Set<string>();
      for (const [i, raw] of body.cc_addresses.entries()) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) || raw.length > 320) {
          throw new ApiError(
            422,
            'invalid_request',
            `cc_addresses[${i}] is not a valid email address`,
            { fieldErrors: { cc_addresses: [`entry ${i} is not a valid email address`] } },
          );
        }
        const addr = raw.toLowerCase();
        if (addr !== toAddress) seen.add(addr);
      }
      if (seen.size > 0) ccAddresses = [...seen];
    }
  }
  return { toAddress, groupAddresses, participantId, ccAddresses };
}

export async function resolveOutboxPlatformNumber(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  body: z.infer<typeof CreateOutboxBody>,
): Promise<string | null> {
  // INVARIANT: Freeze the SMS sender at intent time for transport and completion.
  // Leave missing numbers null so transport records a terminal provisioning failure.
  let platformNumber: string | null = null;
  if (body.channel === 'sms') {
    if (body.thread_id !== undefined) {
      const { data: bound, error: pnErr } = await sb
        .from('thread_channel_bindings')
        .select('platform_number')
        .eq('account_id', accountId)
        .eq('thread_id', body.thread_id)
        .not('platform_number', 'is', null)
        .limit(1)
        .maybeSingle();
      if (pnErr) throw commDbError(pnErr);
      platformNumber = bound?.platform_number ?? null;
    }
    if (platformNumber === null) {
      const { data: num, error: nErr } = await sb
        .from('platform_numbers')
        .select('number')
        .eq('account_id', accountId)
        .eq('status', 'active')
        .contains('capabilities', ['sms'])
        .limit(1)
        .maybeSingle();
      if (nErr) throw commDbError(nErr);
      platformNumber = (num as { number: string } | null)?.number ?? null;
    }
  }
  return platformNumber;
}
