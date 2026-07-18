import { z } from '@hono/zod-openapi';
import { Interaction } from '../../../schemas/importable';
import {
  CommChannel,
  CommOutboxStatus,
  CommThreadKind,
  CommThreadStatus,
  CommThreadMode,
  CommPartyType,
  CommOutbox,
} from './outbox';
import { CommThreadParticipant } from './inbound';

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export const CommThreadBinding = z
  .object({
    id: z.string().uuid(),
    thread_id: z.string().uuid(),
    participant_id: z.string().uuid(),
    /** The binding's transport channel, stamped from the thread. */
    channel: z.enum(['sms', 'email']),
    /** The account's platform number carrying this leg (sms bindings); null
     *  on email bindings, which route by reply_address instead. */
    platform_number: z.string().nullable(),
    /** The counterparty address bound on that number. For sms,
     *  (platform_number, participant_address) is unique among ACTIVE bridged
     *  bindings — the inbound routing key. */
    participant_address: z.string(),
    /** Email bindings carry the participant's UNIQUE tokenized reply address
     *  (`t-<token>@<domain>`) — the transport sets it as the Reply-To/From on
     *  relayed mail so replies route by token; null on sms bindings (which
     *  route by platform number instead). */
    reply_address: z.string().nullable(),
    active: z.boolean(),
  })
  .openapi('CommThreadBinding');

export const CommThread = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    kind: CommThreadKind,
    mode: CommThreadMode,
    /** The thread's transport channel, frozen at create. Its legs (landlord
     *  in-app messages, relay legs) dial on it. */
    channel: CommChannel,
    /** Email-only subject seed — the transport continues it as "Re: …"; null
     *  on sms/voice threads. */
    subject: z.string().nullable(),
    status: CommThreadStatus,
    tenancy_id: z.string().uuid().nullable(),
    maintenance_request_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('CommThread');

export const CommThreadWithParticipants = CommThread.extend({
  participants: z.array(CommThreadParticipant),
}).openapi('CommThreadWithParticipants');

/** Per-leg delivery state for a relayed message (legs are outbox rows whose
 *  relay_of_interaction_id points at the journal entry). */
export const CommRelayLeg = z
  .object({
    outbox_id: z.string().uuid(),
    participant_id: z.string().uuid().nullable(),
    to_address: z.string().nullable(),
    status: CommOutboxStatus,
    interaction_id: z.string().uuid().nullable(),
    delivered_at: z.string().nullable(),
  })
  .openapi('CommRelayLeg');

/** A journal row in a thread, with its delivery state projected from the
 *  outbox (derived read — the journal itself never carries mutable state). */
export const CommThreadMessage = Interaction.extend({
  /** Delivery state of the outbox row that produced this journal entry;
   *  null for rows with no outbox leg (e.g. inbound). */
  delivery_status: CommOutboxStatus.nullable(),
  delivered_at: z.string().nullable(),
  outbox_id: z.string().uuid().nullable(),
  relay_legs: z.array(CommRelayLeg),
}).openapi('CommThreadMessage');

export const ThreadListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  status: CommThreadStatus.optional(),
  kind: CommThreadKind.optional(),
  channel: CommChannel.optional(),
  tenancy_id: z.string().uuid().optional(),
});

export const ThreadListResponse = z
  .object({ data: z.array(CommThreadWithParticipants), next_cursor: z.string().nullable() })
  .openapi('CommThreadListResponse');

export const CommThreadDetail = CommThreadWithParticipants.extend({
  bindings: z.array(CommThreadBinding),
  /** Journal rows with thread_id = this thread (newest-first, keyset-paged
   *  via the cursor/limit query params). */
  messages: z.array(CommThreadMessage),
  messages_next_cursor: z.string().nullable(),
  /** The account's From display name the transport renders on relayed mail;
   *  account-level, injected at the handler (not on list/THREAD_COLS). Null
   *  when the account has not set one. */
  sender_display_name: z.string().nullable(),
}).openapi('CommThreadDetail');

export const CreateThreadBody = z
  .object({
    kind: CommThreadKind,
    /** group threads are sms-only, carry 2..7 distinct member addresses (8
     *  participants incl. the platform number), and MUST include a
     *  landlord_user participant with an address — the landlord's phone is a
     *  group member and gets bound like everyone else. */
    mode: CommThreadMode.default('bridged'),
    channel: CommChannel.default('sms'),
    /** Email threads only: the subject seed the transport continues as "Re: …".
     *  Supplying it on any other channel is a 400. */
    subject: z.string().min(1).max(998).optional(),
    tenancy_id: z.string().uuid().optional(),
    maintenance_request_id: z.string().uuid().optional(),
    /** Counterparty + landlord-side participants. Each non-landlord
     *  participant gets a channel binding on one of the account's platform
     *  numbers; address defaults to the party's verified channel identity
     *  when omitted. */
    participants: z
      .array(
        z.object({
          party_type: CommPartyType,
          party_id: z.string().uuid().optional(),
          address: z.string().min(3).max(320).optional(),
          /** Opt this participant into the landlord CC arm: they are added as a
           *  visible Cc on the thread's outbound email legs. Email threads only
           *  (a Cc has no meaning on sms/voice); default false. */
          is_cc: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(20),
  })
  .openapi('CreateCommThreadBody');

export const CreateThreadMessageBody = z
  .object({
    body: z.string().min(1).max(20000),
    not_before: z.string().datetime().optional(),
  })
  .openapi('CreateCommThreadMessageBody');

export const ThreadMessageResponse = z
  .object({
    /** One send intent per counterparty participant (status 'queued');
     *  approval provenance is stamped server-side: approved_by = caller,
     *  approval_ref = 'self:<user_id>'. */
    data: z.array(CommOutbox),
  })
  .openapi('CommThreadMessageResponse');
