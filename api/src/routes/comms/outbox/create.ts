import { createRoute } from '@hono/zod-openapi';
import { getSb } from '../../../supabase/request-client';
import { asJson, nullableRpcArg } from '../../../supabase/db-types';
import { ApiError, conflictResponse, dbError, errorResponses } from '../../_lib/error';
import { loadEnv } from '../../../env';
import { personaAddress } from '../../_lib/subdomain';
import { AccountParam, CommOutbox, CreateOutboxBody } from '../schemas';
import {
  commDbError,
  normalizeAddress,
  pickPreferredIdentity,
  type CommsApp,
  type IdentityClaimPick,
  type OutboxRow,
} from '../shared';

export function registerOutboxCreateRoute(app: CommsApp): void {
  const createOutbox = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/outbox',
    tags: ['comms'],
    summary:
      'Create a send intent (status queued). Transport or landlord. The intent is ' +
      'durable BEFORE any provider call (ADR-0007); the journal entry is appended ' +
      'only by the completion path, never here.',
    description:
      'An email RELAY leg (relay_of_interaction_id set) whose target participant is a ' +
      'landlord_user is a notification, not the conversation surface: it dials the ' +
      "account's authoritative owner/manager email for that participant, falling back to " +
      'the thread binding when no authoritative email exists. When the relayed ' +
      "interaction's cast already contains the resolved address (canonical email compare " +
      '— the landlord physically received the original, e.g. as a visible Cc), the intent ' +
      'is refused with 409 error.code=relay_already_delivered and no row is created. ' +
      'Other 409 codes: conflict (closed thread / departed participant / an address ' +
      'claimed by two hinted parties). Any CONVERSATIONAL email send — bare OR a ' +
      'thread leg — on an account whose branding is not configured is refused 422 ' +
      "error.code=invalid_request, message 'email branding is not configured' (the " +
      'gate engages only when the platform parent domain is set).',
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
      ...conflictResponse,
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

    // cc_addresses is the BARE-intent arm of the landlord CC feature (see the
    // body-schema doc): email-only like subject, and never accepted alongside
    // thread_id — a thread leg derives its Cc from the thread's is_cc
    // participants, so an explicit set there is a caller bug, not a merge.
    if (body.cc_addresses !== undefined) {
      if (body.channel !== 'email') {
        throw new ApiError(400, 'invalid_request', 'cc_addresses is only valid on email sends', {
          fieldErrors: { cc_addresses: ['only valid when channel=email'] },
        });
      }
      if (body.thread_id !== undefined) {
        throw new ApiError(
          400,
          'invalid_request',
          'cc_addresses is only valid on bare sends; a thread leg derives its Cc from is_cc participants',
          { fieldErrors: { cc_addresses: ['not accepted with thread_id'] } },
        );
      }
    }

    // Explicit party intent (persona routing v2 PR 3): to_party / cc_parties
    // let a bare-send caller state the party it already knows instead of
    // making core re-derive it from the address. Same shape gate as
    // cc_addresses — bare email only — plus the presence coupling the DB
    // trigger backstops. The account/tenancy/address VERIFICATION runs below
    // (after cc_addresses is normalized), before the insert.
    if (body.to_party !== undefined || body.cc_parties !== undefined) {
      if (body.channel !== 'email') {
        throw new ApiError(
          400,
          'invalid_request',
          'party intent (to_party/cc_parties) is only valid on email sends',
          { fieldErrors: { to_party: ['only valid when channel=email'] } },
        );
      }
      if (body.thread_id !== undefined) {
        throw new ApiError(
          400,
          'invalid_request',
          'party intent (to_party/cc_parties) is only valid on bare sends; a thread leg derives parties from its participants',
          { fieldErrors: { to_party: ['not accepted with thread_id'] } },
        );
      }
    }
    if (body.to_party !== undefined && body.to_address === undefined) {
      throw new ApiError(400, 'invalid_request', 'to_party requires to_address', {
        fieldErrors: { to_party: ['requires to_address'] },
      });
    }
    if (body.cc_parties !== undefined && body.cc_addresses === undefined) {
      throw new ApiError(400, 'invalid_request', 'cc_parties requires cc_addresses', {
        fieldErrors: { cc_parties: ['requires cc_addresses'] },
      });
    }

    // HARD GATE (product decision 2026-07-17; extended to thread legs by W1,
    // 2026-07-18): NO CONVERSATIONAL email without branding. A conversational
    // email send — bare (thread-less) OR a thread leg — is rendered From the
    // account persona / minted under the account's branded subdomain; when
    // branding is incomplete the transport falls back to the platform noreply@,
    // whose replies are dropped, black-holing the reply on the one surface
    // built to carry it. Refuse to mint the intent instead, with a stable
    // message the frontend keys on (same exact-string pattern as the premium
    // subdomain reason). Engages only when the platform parent domain is
    // configured — without it the branding feature does not exist and blocking
    // would brick email, not nudge setup.
    //
    // Deliberate admin-client bypass (this route is JWT-bearing only; core's
    // system tier writes comm_outbox through the admin client, never through
    // here, so those sends never see this gate — by design):
    //   - persona-ack: SAFE — it only ever mints for an account that already
    //     resolves a persona (i.e. a branded account), so it cannot emit an
    //     unbranded conversational send in the first place.
    //   - inspection capture_renewal (api/src/admin/inspection-capture.ts:312)
    //     is DELIBERATELY allowed through unbranded: it is a no-reply
    //     transactional LINK email, not a conversation, so the noreply
    //     fallback is the intended reply path, not a black hole.
    // The honest invariant this route enforces is therefore "no CONVERSATIONAL
    // email without branding" — transactional system link mail is out of scope.
    if (body.channel === 'email') {
      const parent = loadEnv().EMAIL_PLATFORM_PARENT_DOMAIN;
      if (parent !== null) {
        const { data: acct, error: acctErr } = await sb
          .from('accounts')
          .select('email_subdomain, persona_local_part')
          .eq('id', accountId)
          .maybeSingle();
        if (acctErr) throw dbError(acctErr);
        if (!acct) throw new ApiError(404, 'not_found', 'not found');
        if (personaAddress(acct.persona_local_part, acct.email_subdomain, parent) === null) {
          throw new ApiError(422, 'invalid_request', 'email branding is not configured');
        }
      }
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
    let ccAddresses: string[] | null = null;

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

      // Relay demoted to notification (persona routing v2 PR 7): an email
      // relay leg addressed to a landlord_user participant is a NOTIFICATION
      // of mail the visible-Cc surface already carries, so its recipient comes
      // from the account's AUTHORITATIVE owner/manager email — not the thread
      // binding, which is minted from channel_identities at thread creation
      // and once froze the TENANT's address as the landlord leg (a bad claim
      // relayed the tenant's own message back to them). The binding/address
      // book resolved below remains the fallback when no authoritative email
      // exists. Email relay legs only; sms relays and all non-relay sends are
      // byte-identical.
      const isLandlordEmailRelay =
        body.channel === 'email' &&
        body.relay_of_interaction_id !== undefined &&
        participant !== null &&
        participant.party_type === 'landlord_user' &&
        participant.party_id !== null;

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
          // Several live claims may exist for the party now; pick
          // deterministically (human_link, then verified, then newest).
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
        // A landlord email relay may still resolve via the authoritative
        // owner/manager email below, so its missing-binding 422 is deferred to
        // the RPC verdict.
        if (resolved === null && !isLandlordEmailRelay) {
          throw new ApiError(
            422,
            'invalid_request',
            'no destination address is bound or on file for this participant',
          );
        }
        // Validate the resolved address against the requested channel too — a
        // binding stored for one channel must not be silently reused as the
        // destination for another (e.g. an sms binding for an email send).
        toAddress = resolved === null ? null : normalizeAddress(body.channel, resolved);
      }
      participantId = body.participant_ref ?? null;

      if (isLandlordEmailRelay) {
        // One server-side judge for both questions (the DB owns the email
        // canonicalization, so TS never re-implements it): the authoritative
        // recipient, and whether the source interaction's cast shows the
        // landlord already physically received the mail.
        const { data: relayTarget, error: rtErr } = await sb.rpc(
          'resolve_relay_landlord_recipient',
          {
            p_account_id: accountId,
            p_user_id: participant!.party_id!,
            p_source_interaction_id: body.relay_of_interaction_id!,
            p_fallback_address: nullableRpcArg(toAddress),
          },
        );
        if (rtErr) throw commDbError(rtErr);
        const target = (
          (relayTarget ?? []) as { to_address: string | null; already_delivered: boolean }[]
        )[0];
        if (!target || target.to_address === null) {
          // No authoritative email AND no binding/address-book fallback: the
          // same contract as any unresolvable 1:1 destination.
          throw new ApiError(
            422,
            'invalid_request',
            'no destination address is bound or on file for this participant',
          );
        }
        // SUPPRESSION: the landlord already received this mail directly (their
        // address — canonically compared, so gmail dot/+tag aliases count — is
        // in the relayed interaction's cast, e.g. as a visible Cc). A relay
        // row would double-deliver; refuse BEFORE creating anything with a
        // stable code the transport treats as "already satisfied".
        if (target.already_delivered) {
          throw new ApiError(
            409,
            'relay_already_delivered',
            'the landlord already received this mail directly (e.g. as a visible Cc); no relay leg was created',
          );
        }
        toAddress = normalizeAddress(body.channel, target.to_address);
      }

      // Landlord CC arm (thread arm): copy any is_cc participant of this thread
      // as a VISIBLE Cc on the outbound mail, resolved to their REAL email —
      // the participant_address on their ACTIVE email binding (minted at
      // thread create from the landlord's channel identity), the same address
      // the separate relay leg would dial. Frozen here at intent time exactly
      // like to_address, so a binding edited while the row sits queued can't
      // rewrite who the send is recorded as copying. Excludes the leg's own
      // recipient (participant_ref) and any address equal to to_address. Email
      // threads only; the DB CHECK (comm_outbox_cc_email_only) backstops the
      // channel gate. This is additive to relay legs, not a replacement — a
      // flagged landlord still gets their existing forwarded copy of
      // tenant-initiated inbound; the Cc adds them to agent/owner->tenant
      // outbound.
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
        // Relay-echo exclusion: relaying a flagged participant's OWN inbound
        // must not Cc them a copy of their own words (their sent mail already
        // holds the original). The relayed journal row carries the sender's
        // party identity — drop flagged participants that match it.
        if (flagged.length > 0 && body.relay_of_interaction_id !== undefined) {
          const { data: relayed, error: relErr } = await sb
            .from('interactions')
            .select('party_id')
            .eq('account_id', accountId)
            .eq('id', body.relay_of_interaction_id)
            .maybeSingle();
          if (relErr) throw commDbError(relErr);
          // party_id alone: the journal maps participant party_type to its own
          // vocabulary ('landlord_user' journals as 'landlord'), so a type+id
          // pair can never match across the two tables. Both ids are
          // account-scoped uuids — id equality IS identity here.
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
          // Stored bindings, not caller input: a malformed learned address is
          // DROPPED rather than thrown — the tenant's send must not 422 on the
          // landlord's bad identity. Lowercase = the same canonical form
          // normalizeAddress produces.
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

      // cc_relayed delivery shape (PRODUCT DECISION 2026-07-18; contract doc
      // "The cc_relayed delivery shape"): a relay leg that DELIVERS a
      // landlord's persona reply — the source journal row is the capture cc
      // arm's landlord-authored outbound (actor 'system:comm-persona-cc') —
      // to a tenant/vendor carries the landlord's AUTHORITATIVE email as a
      // visible Cc, derived here server-side (the transport stays thin and a
      // thread leg still accepts no caller Cc). Every delivery then REBUILDS
      // the group thread: the counterparty's next reply-all includes the
      // landlord directly (self-healing topology, converging on the
      // visible-CC model), and the landlord's copy doubles as a delivery
      // receipt. Resolution reuses resolve_relay_landlord_recipient
      // (authoritative owner/manager email; sender-cast address fallback).
      // Its already_delivered verdict is deliberately IGNORED: the landlord
      // is the AUTHOR of this mail — their address in the source cast is the
      // sender leg, not evidence of a delivered copy, and the Cc is a
      // deliberate receipt. No loop: the counterparty's reply-all carries
      // the landlord on To/Cc, so its persona capture splits to cc_journaled
      // (relay nothing). Best-effort by design: an unresolvable Cc never
      // blocks the delivery (the black hole is the failure mode this arm
      // exists to prevent); the opt-out trigger scrubs a registered Cc at
      // INSERT and the snapshot trigger freezes whatever survives.
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
            const { data: rec, error: recErr } = await sb.rpc(
              'resolve_relay_landlord_recipient',
              {
                p_account_id: accountId,
                p_user_id: senderCast.party_id as string,
                p_source_interaction_id: body.relay_of_interaction_id,
                p_fallback_address: nullableRpcArg((senderCast.address as string | null) ?? null),
              },
            );
            if (recErr) throw commDbError(recErr);
            landlordCc =
              ((rec ?? []) as { to_address: string | null }[])[0]?.to_address ?? null;
          } else {
            landlordCc = (senderCast?.address as string | null) ?? null;
          }
          if (landlordCc !== null) {
            const addr = landlordCc.toLowerCase();
            if (
              addr !== toAddress &&
              addr.length <= 320 &&
              /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)
            ) {
              ccAddresses = [...new Set([...(ccAddresses ?? []), addr])].slice(0, 10);
            }
          }
        }
      }

      // Landlord CC arm (BARE arm): an explicit caller-supplied Cc on a
      // thread-less email send (the inspection-link welcome/reminder mail).
      // Unlike the thread arm's stored bindings above, this list is
      // hand-authored request input — an invalid entry is a caller error and
      // 422s field-scoped, matching to_address's contract. Lowercased,
      // deduped, primary excluded; the opt-out trigger scrubs register hits
      // at INSERT.
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

    // Persona routing v2 PR 3: verify the explicit party intent BEFORE the
    // insert, mapping each hint to a stable, field-scoped error. The DB
    // snapshot trigger re-verifies with the same predicate as an independent
    // backstop — this pre-check exists for the specific status codes.
    let ccPartiesPayload: { address: string; party_type: string; party_id: string }[] | null = null;
    if (body.to_party !== undefined || body.cc_parties !== undefined) {
      // (a) Every cc_parties address must name one normalized cc_addresses
      // entry — a Cc party hint annotates a Cc the caller actually asked for.
      const ccSet = new Set(ccAddresses ?? []);
      if (body.cc_parties !== undefined) {
        ccPartiesPayload = body.cc_parties.map((p) => ({
          address: p.address.toLowerCase(),
          party_type: p.party_type,
          party_id: p.party_id,
        }));
        for (const [i, p] of ccPartiesPayload.entries()) {
          if (!ccSet.has(p.address)) {
            throw new ApiError(
              400,
              'invalid_request',
              `cc_parties[${i}].address must match a cc_addresses entry`,
              { fieldErrors: { cc_parties: [`entry ${i} address is not in cc_addresses`] } },
            );
          }
        }
      }

      // (b) One address claimed by two different hinted parties -> 409. (Cc
      // already excludes to_address, so this catches duplicate cc_parties.)
      const claimed = new Map<string, string>();
      const allHints: { address: string; key: string }[] = [];
      if (body.to_party !== undefined && toAddress !== null) {
        allHints.push({
          address: toAddress,
          key: `${body.to_party.party_type}:${body.to_party.party_id}`,
        });
      }
      for (const p of ccPartiesPayload ?? []) {
        allHints.push({ address: p.address, key: `${p.party_type}:${p.party_id}` });
      }
      for (const h of allHints) {
        const prev = claimed.get(h.address);
        if (prev !== undefined && prev !== h.key) {
          throw new ApiError(
            409,
            'conflict',
            `address ${h.address} is claimed by two different parties`,
          );
        }
        claimed.set(h.address, h.key);
      }

      // (c) Account membership, tenancy membership, and address resolution —
      // judged in the DB by the same predicate the snapshot trigger applies.
      const { data: verdicts, error: vErr } = await sb.rpc('check_outbox_party_intent', {
        p_account_id: accountId,
        p_tenancy_id: nullableRpcArg(body.tenancy_id ?? null),
        p_to_party_type: nullableRpcArg(body.to_party?.party_type ?? null),
        p_to_party_id: nullableRpcArg(body.to_party?.party_id ?? null),
        p_to_address: nullableRpcArg(body.to_party !== undefined ? toAddress : null),
        p_cc_parties: ccPartiesPayload !== null ? asJson(ccPartiesPayload) : null,
      });
      if (vErr) throw commDbError(vErr);
      for (const row of (verdicts ?? []) as {
        slot: string;
        hint_address: string;
        verdict: string;
      }[]) {
        if (row.verdict === 'ok') continue;
        const field = row.slot === 'to' ? 'to_party' : 'cc_parties';
        const msg =
          row.verdict === 'wrong_account'
            ? 'the referenced party does not belong to this account'
            : row.verdict === 'not_in_tenancy'
              ? 'the referenced tenant is not a member of the supplied tenancy'
              : 'the address does not resolve to the referenced party';
        throw new ApiError(422, 'invalid_request', msg, {
          fieldErrors: { [field]: [`${row.hint_address}: ${row.verdict}`] },
        });
      }
    }

    const { data, error } = await sb
      .from('comm_outbox')
      .insert({
        account_id: accountId,
        channel: body.channel,
        to_address: toAddress,
        group_addresses: groupAddresses,
        cc_addresses: ccAddresses,
        to_party_type: body.to_party?.party_type ?? null,
        to_party_id: body.to_party?.party_id ?? null,
        cc_parties: ccPartiesPayload !== null ? asJson(ccPartiesPayload) : null,
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
}
