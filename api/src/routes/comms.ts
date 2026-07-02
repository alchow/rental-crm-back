import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, dbError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { normalizePhone } from './_lib/phone';
import { withResolvedAuthorship } from './_lib/authorship';
import { Interaction } from './interactions';

// ---------------------------------------------------------------------------
// Communications ledger contract (comms build, core repo; ADR-0007 revived).
//
// Core owns all communications STATE — the outbox/delivery ledger, threads,
// opt-outs, standing policies, and the journal rows a confirmed send appends.
// Core NEVER calls a messaging provider and NEVER terminates a provider
// webhook: the transport module (landlord-agent repo) makes the provider
// calls and drives this ledger over these endpoints, writing an outbox
// INTENT before dialing and confirming/failing after. ADR-0007's guarantee
// holds across the process boundary: the intent is durable here before any
// provider call; the journal entry is appended only with a provider message
// id, in the same transaction that marks the outbox row sent.
//
// Authorization provenance convention (shared across repos):
//   approval_ref='proposal:<id>' + approved_by=<user uuid>  -> a human
//     approved this exact message.
//   approval_ref='grant:<id>'    + approved_by null         -> sent under a
//     standing policy; no human read this specific message.
//   approval_ref='self:<user_id>' + approved_by=<user uuid> -> landlord-
//     authored (stamped server-side on the thread-messages path).
//
// Principal gating (enforced by the handlers, M2):
//   transport endpoints -> the agent principal (resolvePrincipal type='agent')
//   landlord endpoints  -> owner|manager members
//
// This file is contract-first: every route below is fully typed and FINAL;
// handlers 501 until the ledger migrations + real handlers land (M1/M2).
// ---------------------------------------------------------------------------

const CommChannel = z.enum(['sms', 'email', 'voice']);
// Monotonic: queued -> sending -> sent -> delivered; failed/undeliverable
// terminal; needs_reconcile parks ambiguity for the documented manual
// procedure. Late or duplicate provider callbacks are ignored.
const CommOutboxStatus = z.enum([
  'queued', 'sending', 'sent', 'delivered', 'failed', 'undeliverable', 'needs_reconcile',
]);
const CommThreadKind = z.enum(['bridged_tenant', 'vendor']);
const CommThreadStatus = z.enum(['active', 'closed']);
const CommPartyType = z.enum(['tenant', 'landlord_user', 'vendor', 'agent']);
const CommPolicyKind = z.enum(['rent_reminder', 'thread_autonomy', 'voice_autonomy']);
const CommPolicyStatus = z.enum(['active', 'revoked']);

// tz-aware "do not disturb" window for policy-driven sends; times are local
// to `timezone` (IANA name), window may span midnight (start > end).
const CommQuietHours = z
  .object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).openapi({ example: '21:00' }),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).openapi({ example: '08:00' }),
    timezone: z.string().min(1).max(64).openapi({ example: 'America/Los_Angeles' }),
  })
  .openapi('CommQuietHours');

// ---------------------------------------------------------------------------
// Outbox — the mutable send intent/progress record (operational tier).
// Committed BEFORE any provider call; the immutable journal entry is appended
// only on confirmed send, in the same transaction that marks the row 'sent'.
// ---------------------------------------------------------------------------

const CommOutbox = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    channel: CommChannel,
    /** Resolved destination (E.164 for sms/voice, email address for email),
     *  frozen at intent time so the record survives later identity edits.
     *  Null only while thread routing resolves it (never null once sending). */
    to_address: z.string().nullable(),
    thread_id: z.string().uuid().nullable(),
    /** Thread participant this leg addresses (comm_thread_participants.id). */
    participant_id: z.string().uuid().nullable(),
    body: z.string(),
    /** Opaque template reference (templates live agent-side). */
    template_id: z.string().nullable(),
    /** Earliest eligible dispatch time; the transport's dispatch scan must
     *  not pick this row up before it. Null = immediately eligible. */
    not_before: z.string().nullable(),
    /** For relay legs of a bridged thread: the journal entry (inbound
     *  original) this send relays. */
    relay_of_interaction_id: z.string().uuid().nullable(),
    status: CommOutboxStatus,
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    /** Provider that accepted the send (e.g. 'twilio'); set on completion. */
    provider: z.string().nullable(),
    /** Provider message id; unique, set on completion. */
    provider_sid: z.string().nullable(),
    /** Server-generated opaque ref the transport passes to the provider so
     *  callbacks can always re-associate with this row (unique). */
    client_ref: z.string(),
    approval_ref: z.string(),
    approved_by: z.string().uuid().nullable(),
    /** Capacity of the author of the send intent (stamped from the resolved
     *  principal, never client-supplied). */
    author_type: z.enum(['landlord', 'agent']),
    /** Journal entry appended by the confirmed send; null until 'sent'. */
    interaction_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    delivered_at: z.string().nullable(),
  })
  .openapi('CommOutbox');

const CreateOutboxBody = z
  .object({
    channel: CommChannel,
    /** Explicit destination. Required unless thread_id + participant_ref
     *  resolve one from the thread's channel bindings. */
    to_address: z.string().min(3).max(320).optional(),
    thread_id: z.string().uuid().optional(),
    /** Thread participant to address (comm_thread_participants.id). */
    participant_ref: z.string().uuid().optional(),
    /** Channel-specific caps (sms: 1600) are enforced at write. */
    body: z.string().min(1).max(20000),
    approval_ref: z.string().min(1).max(200),
    approved_by: z.string().uuid().optional(),
    not_before: z.string().datetime().optional(),
    relay_of_interaction_id: z.string().uuid().optional(),
    template_id: z.string().min(1).max(200).optional(),
  })
  .openapi('CreateCommOutboxBody');

const OutboxListResponse = z
  .object({ data: z.array(CommOutbox), next_cursor: z.string().nullable() })
  .openapi('CommOutboxListResponse');

const CompleteSendBody = z
  .object({
    provider: z.string().min(1).max(100),
    provider_sid: z.string().min(1).max(200),
  })
  .openapi('CompleteCommSendBody');

const CompleteSendResponse = z
  .object({
    /** The journal entry appended by the confirmed send. */
    interaction_id: z.string().uuid(),
    outbox: CommOutbox,
  })
  .openapi('CompleteCommSendResponse');

const FailSendBody = z
  .object({
    error_code: z.string().min(1).max(100),
    detail: z.string().max(2000).optional(),
    /** true = the provider outcome is UNKNOWN (crash window / lost response):
     *  park the row in needs_reconcile for the manual procedure instead of
     *  marking it failed. */
    reconcile: z.boolean().optional(),
  })
  .openapi('FailCommSendBody');

const DeliveryBody = z
  .object({
    /** Provider callback state, already mapped to ledger vocabulary. Only
     *  forward transitions apply (monotonic); late/duplicate callbacks are
     *  ignored and return the unchanged row. 'sending' is the transport's
     *  pre-dial claim on a queued row (the ADR-0007 crash-window marker). */
    status: z.enum(['sending', 'sent', 'delivered', 'failed', 'undeliverable']),
    provider_ts: z.string().datetime(),
    error_code: z.string().max(100).optional(),
  })
  .openapi('CommDeliveryBody');

// ---------------------------------------------------------------------------
// Inbound capture
// ---------------------------------------------------------------------------

const CommInboundMedia = z
  .object({
    url: z.string().min(1).max(2000),
    content_type: z.string().max(200).optional(),
  })
  .openapi('CommInboundMedia');

const CaptureInboundBody = z
  .object({
    provider: z.string().min(1).max(100),
    /** Idempotency key for capture: replaying the same provider_msg_id
     *  returns the original result without writing anything. */
    provider_msg_id: z.string().min(1).max(200),
    /** The platform number the message arrived on (binding routing key). */
    to_number: z.string().min(3).max(50),
    /** The counterparty address the message came from. */
    from_address: z.string().min(3).max(320),
    channel: CommChannel,
    body: z.string().max(20000).optional(),
    media: z.array(CommInboundMedia).max(20).optional(),
    received_at: z.string().datetime(),
  })
  .openapi('CaptureCommInboundBody');

const CommThreadParticipant = z
  .object({
    id: z.string().uuid(),
    thread_id: z.string().uuid(),
    party_type: CommPartyType,
    party_id: z.string().uuid().nullable(),
    joined_at: z.string(),
    left_at: z.string().nullable(),
  })
  .openapi('CommThreadParticipant');

const CaptureInboundResponse = z
  .object({
    /** matched: bound thread+participant resolved and the message journaled.
     *  orphan: no active binding for (to_number, from_address) — captured in
     *  the raw tier only; nothing journaled (no account to attribute to).
     *  opted_out: matched AND journaled, but the counterparty address is on
     *  the opt-out register — the transport must not relay further replies
     *  and should run its keyword handling. */
    disposition: z.enum(['matched', 'orphan', 'opted_out']),
    interaction_id: z.string().uuid().nullable(),
    thread_id: z.string().uuid().nullable(),
    participant: CommThreadParticipant.nullable(),
  })
  .openapi('CaptureCommInboundResponse');

// ---------------------------------------------------------------------------
// Opt-outs — global compliance register keyed by (channel, address), NOT by
// account (a member-readable table would be a cross-account address oracle).
// The landlord read is filtered to addresses already known to the account.
// ---------------------------------------------------------------------------

const CommOptOut = z
  .object({
    channel: CommChannel,
    address: z.string(),
    opted_out_at: z.string(),
    keyword: z.string().nullable(),
    source_ref: z.string().nullable(),
  })
  .openapi('CommOptOut');

const CreateOptOutBody = z
  .object({
    channel: CommChannel,
    address: z.string().min(3).max(320),
    /** Normalized keyword that triggered the opt-out (STOP, UNSUBSCRIBE, ...). */
    keyword: z.string().min(1).max(50),
    /** Provider-side reference for the triggering message. */
    source_ref: z.string().min(1).max(200),
  })
  .openapi('CreateCommOptOutBody');

const OptOutListResponse = z
  .object({ data: z.array(CommOptOut), next_cursor: z.string().nullable() })
  .openapi('CommOptOutListResponse');

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const CommThreadBinding = z
  .object({
    id: z.string().uuid(),
    thread_id: z.string().uuid(),
    participant_id: z.string().uuid(),
    /** The account's platform number carrying this leg. */
    platform_number: z.string(),
    /** The counterparty address bound on that number. (platform_number,
     *  participant_address) is unique among ACTIVE bindings — the inbound
     *  routing key. */
    participant_address: z.string(),
    active: z.boolean(),
  })
  .openapi('CommThreadBinding');

const CommThread = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    kind: CommThreadKind,
    status: CommThreadStatus,
    tenancy_id: z.string().uuid().nullable(),
    maintenance_request_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('CommThread');

const CommThreadWithParticipants = CommThread.extend({
  participants: z.array(CommThreadParticipant),
}).openapi('CommThreadWithParticipants');

/** Per-leg delivery state for a relayed message (legs are outbox rows whose
 *  relay_of_interaction_id points at the journal entry). */
const CommRelayLeg = z
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
const CommThreadMessage = Interaction.extend({
  /** Delivery state of the outbox row that produced this journal entry;
   *  null for rows with no outbox leg (e.g. inbound). */
  delivery_status: CommOutboxStatus.nullable(),
  delivered_at: z.string().nullable(),
  outbox_id: z.string().uuid().nullable(),
  relay_legs: z.array(CommRelayLeg),
}).openapi('CommThreadMessage');

const ThreadListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  status: CommThreadStatus.optional(),
  kind: CommThreadKind.optional(),
  tenancy_id: z.string().uuid().optional(),
});

const ThreadListResponse = z
  .object({ data: z.array(CommThreadWithParticipants), next_cursor: z.string().nullable() })
  .openapi('CommThreadListResponse');

const CommThreadDetail = CommThreadWithParticipants.extend({
  bindings: z.array(CommThreadBinding),
  /** Journal rows with thread_id = this thread (newest-first, keyset-paged
   *  via the cursor/limit query params). */
  messages: z.array(CommThreadMessage),
  messages_next_cursor: z.string().nullable(),
}).openapi('CommThreadDetail');

const CreateThreadBody = z
  .object({
    kind: CommThreadKind,
    channel: CommChannel.default('sms'),
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
        }),
      )
      .min(1)
      .max(20),
  })
  .openapi('CreateCommThreadBody');

const CreateThreadMessageBody = z
  .object({
    body: z.string().min(1).max(20000),
    not_before: z.string().datetime().optional(),
  })
  .openapi('CreateCommThreadMessageBody');

const ThreadMessageResponse = z
  .object({
    /** One send intent per counterparty participant (status 'queued');
     *  approval provenance is stamped server-side: approved_by = caller,
     *  approval_ref = 'self:<user_id>'. */
    data: z.array(CommOutbox),
  })
  .openapi('CommThreadMessageResponse');

// ---------------------------------------------------------------------------
// Policies — standing grants; creating one IS the approval act.
// ---------------------------------------------------------------------------

const CommPolicy = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    policy_kind: CommPolicyKind,
    channel: CommChannel,
    template_id: z.string().nullable(),
    params: z.record(z.unknown()),
    quiet_hours: CommQuietHours.nullable(),
    status: CommPolicyStatus,
    approved_by: z.string().uuid(),
    approved_at: z.string(),
    revoked_by: z.string().uuid().nullable(),
    revoked_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('CommPolicy');

const CreatePolicyBody = z
  .object({
    policy_kind: CommPolicyKind,
    channel: CommChannel,
    template_id: z.string().min(1).max(200).optional(),
    params: z.record(z.unknown()).default({}),
    quiet_hours: CommQuietHours.optional(),
  })
  .openapi('CreateCommPolicyBody');

const PolicyListResponse = z
  .object({ data: z.array(CommPolicy), next_cursor: z.string().nullable() })
  .openapi('CommPolicyListResponse');

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});
const AccountAndIdParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

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
    201: { description: 'send intent created', content: { 'application/json': { schema: CommOutbox } } },
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
    200: { description: 'sent + journaled', content: { 'application/json': { schema: CompleteSendResponse } } },
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
    200: { description: 'updated outbox row', content: { 'application/json': { schema: CommOutbox } } },
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
    200: { description: 'outbox row (possibly unchanged)', content: { 'application/json': { schema: CommOutbox } } },
    ...errorResponses,
  },
});

const captureInbound = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/comms/inbound',
  tags: ['comms'],
  summary:
    'Capture an inbound message (transport). Raw payload is stored first; the ' +
    'active binding (platform number, from address) resolves the thread and ' +
    'participant; matched messages are journaled. Idempotent on ' +
    'provider_msg_id: a replay returns the original result.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CaptureInboundBody } }, required: true },
  },
  responses: {
    200: { description: 'capture result', content: { 'application/json': { schema: CaptureInboundResponse } } },
    ...errorResponses,
  },
});

const createOptOut = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/comms/opt-outs',
  tags: ['comms'],
  summary:
    'Record a carrier/provider opt-out (transport). Idempotent upsert keyed by ' +
    '(channel, address).',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreateOptOutBody } }, required: true },
  },
  responses: {
    200: { description: 'opt-out row', content: { 'application/json': { schema: CommOptOut } } },
    ...errorResponses,
  },
});

const listOptOuts = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/comms/opt-outs',
  tags: ['comms'],
  summary:
    'List opt-outs relevant to this account (landlord, read-only). The register ' +
    'is global by address; the read is filtered to addresses the account ' +
    'already knows (its channel identities) so it can never be used as a ' +
    'cross-account address oracle.',
  request: {
    params: AccountParam,
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().positive().max(100).default(50),
      channel: CommChannel.optional(),
    }),
  },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: OptOutListResponse } } },
    ...errorResponses,
  },
});

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
    'Thread detail (landlord): participants, channel bindings, and the journal ' +
    'rows in the thread with their delivery state (cursor/limit page the ' +
    'messages).',
  request: {
    params: AccountAndIdParam,
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().positive().max(100).default(50),
    }),
  },
  responses: {
    200: { description: 'thread detail', content: { 'application/json': { schema: CommThreadDetail } } },
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
    201: { description: 'created', content: { 'application/json': { schema: CommThreadDetail } } },
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
    body: { content: { 'application/json': { schema: CreateThreadMessageBody } }, required: true },
  },
  responses: {
    201: { description: 'send intents created', content: { 'application/json': { schema: ThreadMessageResponse } } },
    ...errorResponses,
  },
});

const listPolicies = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/comms/policies',
  tags: ['comms'],
  summary: 'List standing communication policies (landlord).',
  request: {
    params: AccountParam,
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().positive().max(100).default(50),
      status: CommPolicyStatus.optional(),
      policy_kind: CommPolicyKind.optional(),
    }),
  },
  responses: {
    200: { description: 'page', content: { 'application/json': { schema: PolicyListResponse } } },
    ...errorResponses,
  },
});

const createPolicy = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/comms/policies',
  tags: ['comms'],
  summary:
    'Create a standing grant (landlord, owner|manager). Creation IS the ' +
    'approval act: approved_by is stamped from the caller. Sends made under it ' +
    "carry approval_ref='grant:<id>' with approved_by null — the journal stays " +
    'honest that no human read those specific messages.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CreatePolicyBody } }, required: true },
  },
  responses: {
    201: { description: 'created', content: { 'application/json': { schema: CommPolicy } } },
    ...errorResponses,
  },
});

const revokePolicy = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/comms/policies/{id}/revoke',
  tags: ['comms'],
  summary:
    'Revoke a standing grant (landlord, owner|manager). Already-queued sends ' +
    'authorized by it are cancelled where still unsent.',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'revoked policy', content: { 'application/json': { schema: CommPolicy } } },
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
    200: { description: 'stale sending rows', content: { 'application/json': { schema: z.object({ data: z.array(CommOutbox) }).openapi('CommReconcileResponse') } } },
    ...errorResponses,
  },
});

export const commsApp = newApiApp();

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

// Transport endpoints are driven by the agent principal (the provider-calling
// module in the agent repo); everything else on it is 403.
function requireTransport(c: Context): void {
  if (c.get('principal').type !== 'agent') {
    throw new ApiError(403, 'forbidden', 'this endpoint is reserved for the agent transport');
  }
}

// Landlord endpoints require owner|manager (viewers read the journal, not the
// comms controls; the agent principal holds role='agent' and is denied too).
function requireManager(c: Context): void {
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only an owner or manager may use this endpoint');
  }
}

// Map the typed SQLSTATEs raised by the comms triggers/RPCs to the envelope.
function commDbError(error: { code?: string; message: string }): ApiError {
  switch (error.code) {
    case 'P0002':
      return new ApiError(404, 'not_found', 'not found');
    case 'P0003':
      return new ApiError(409, 'conflict', error.message);
    case 'P0004':
      return new ApiError(422, 'opted_out', 'the destination address has opted out of this channel');
    case '23505':
      return new ApiError(409, 'conflict', 'duplicate reference (provider_sid or routing key already recorded)');
    case '23503':
      return new ApiError(404, 'not_found', 'a referenced row does not belong to this account');
    case '23514':
      return new ApiError(400, 'invalid_request', error.message);
    default:
      return dbError(error);
  }
}

// Destination validation is channel-specific: sms/voice must normalize to
// E.164; email gets a shape check. Returns the canonical address.
function normalizeAddress(channel: string, raw: string): string {
  if (channel === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) || raw.length > 320) {
      throw new ApiError(422, 'invalid_request', 'to_address is not a valid email address', {
        fieldErrors: { to_address: ['not a valid email address'] },
      });
    }
    return raw.toLowerCase();
  }
  const e164 = normalizePhone(raw);
  if (!e164) {
    throw new ApiError(422, 'invalid_phone', 'to_address cannot be normalised to E.164', {
      fieldErrors: { to_address: ['cannot be normalised to E.164'] },
    });
  }
  return e164;
}

// Tiny offset cursor for the opt-out list: the register has no uuid id to
// keyset on (PK is (channel, address)) and a landlord's slice of it is small.
function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}
function decodeOffsetCursor(s: string): number {
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof obj.o === 'number' && Number.isInteger(obj.o) && obj.o >= 0) return obj.o;
  } catch {
    /* fall through */
  }
  throw new ApiError(400, 'invalid_request', 'invalid cursor');
}

type OutboxRow = z.infer<typeof CommOutbox>;
type ParticipantRow = z.infer<typeof CommThreadParticipant>;

const PARTICIPANT_COLS = 'id, thread_id, party_type, party_id, joined_at, left_at';
const BINDING_COLS = 'id, thread_id, participant_id, platform_number, participant_address, active';

// ---------------------------------------------------------------------------
// POST /comms/outbox — create a send intent (transport + landlord)
// ---------------------------------------------------------------------------
// Ordering is the ADR-0007 contract: provenance validation (no DB) ->
// destination resolution (read-only) -> INTENT INSERT (the commit point; the
// opt-out register is enforced by a BEFORE INSERT trigger inside the same
// statement, race-free). No provider call happens anywhere in core.

commsApp.openapi(createOutbox, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const principal = c.get('principal');
  const role = c.get('account').role;

  if (principal.type !== 'agent' && role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only the agent transport or an owner/manager may create send intents');
  }

  // Provenance (mirrors the journal firewall vocabulary; the DB CHECK and
  // capacity trigger are the backstops).
  if (principal.type === 'agent') {
    if (body.approved_by === undefined && !body.approval_ref.startsWith('grant:')) {
      throw new ApiError(
        403,
        'agent_entry_type_forbidden',
        "agent send intents require approved_by (proposal-approved) or a 'grant:'-prefixed approval_ref (policy-authorized)",
      );
    }
    if (body.approved_by !== undefined) {
      const { data: ok } = await sb.rpc('is_approver_member', {
        p_account_id: accountId,
        p_user_id: body.approved_by,
      });
      if (!ok) {
        throw new ApiError(400, 'invalid_request', 'approved_by must be a non-agent member of this account');
      }
    } else {
      // A grant ref must name a live standing policy in THIS account.
      const grantId = body.approval_ref.slice('grant:'.length);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(grantId)) {
        throw new ApiError(400, 'invalid_request', "a 'grant:' approval_ref must carry the comm_policies id");
      }
      const { data: policy, error: polErr } = await sb
        .from('comm_policies')
        .select('id, status')
        .eq('account_id', accountId)
        .eq('id', grantId)
        .maybeSingle();
      if (polErr) throw commDbError(polErr);
      if (!policy || policy.status !== 'active') {
        throw new ApiError(403, 'forbidden', 'the referenced grant is not an active policy of this account');
      }
    }
  } else {
    // Landlord-authored: the caller IS the approval. The provenance is
    // stamped, not trusted from the body.
    const self = `self:${c.get('auth').userId}`;
    if (body.approval_ref !== self) {
      throw new ApiError(400, 'invalid_request', `landlord send intents carry approval_ref='${self}'`, {
        fieldErrors: { approval_ref: [`must be '${self}'`] },
      });
    }
    if (body.approved_by !== undefined && body.approved_by !== c.get('auth').userId) {
      throw new ApiError(400, 'invalid_request', 'landlord send intents are approved by the caller', {
        fieldErrors: { approved_by: ['must be your own user id (or omitted)'] },
      });
    }
  }

  // Destination resolution: explicit address, else the thread binding, else
  // the account's channel identity for the participant.
  if (body.to_address === undefined && (body.thread_id === undefined || body.participant_ref === undefined)) {
    throw new ApiError(400, 'invalid_request', 'provide to_address, or thread_id + participant_ref to resolve one');
  }
  if (body.participant_ref !== undefined && body.thread_id === undefined) {
    throw new ApiError(400, 'invalid_request', 'participant_ref requires thread_id');
  }

  let participant: { id: string; party_type: string; party_id: string | null } | null = null;
  if (body.thread_id !== undefined) {
    const { data: thread, error: thErr } = await sb
      .from('comm_threads')
      .select('id, status')
      .eq('account_id', accountId)
      .eq('id', body.thread_id)
      .maybeSingle();
    if (thErr) throw commDbError(thErr);
    if (!thread) throw new ApiError(404, 'not_found', 'thread not found');
    if (thread.status === 'closed') throw new ApiError(409, 'conflict', 'the thread is closed');

    if (body.participant_ref !== undefined) {
      const { data: part, error: pErr } = await sb
        .from('comm_thread_participants')
        .select('id, party_type, party_id, left_at')
        .eq('account_id', accountId)
        .eq('thread_id', body.thread_id)
        .eq('id', body.participant_ref)
        .maybeSingle();
      if (pErr) throw commDbError(pErr);
      if (!part) throw new ApiError(404, 'not_found', 'participant not found in this thread');
      if (part.left_at !== null) throw new ApiError(409, 'conflict', 'the participant has left the thread');
      participant = part;
    }
  }

  let toAddress: string;
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
      throw new ApiError(422, 'invalid_request', 'no destination address is bound or on file for this participant');
    }
    toAddress = resolved;
  }

  const { data, error } = await sb
    .from('comm_outbox')
    .insert({
      account_id: accountId,
      channel: body.channel,
      to_address: toAddress,
      thread_id: body.thread_id ?? null,
      participant_id: body.participant_ref ?? null,
      body: body.body,
      template_id: body.template_id ?? null,
      not_before: body.not_before ?? null,
      relay_of_interaction_id: body.relay_of_interaction_id ?? null,
      approval_ref: body.approval_ref,
      approved_by: principal.type === 'agent' ? (body.approved_by ?? null) : c.get('auth').userId,
      author_type: principal.type === 'agent' ? 'agent' : 'landlord',
    })
    .select('*')
    .single();
  if (error) throw commDbError(error);
  return c.json(data as OutboxRow, 201);
});

// ---------------------------------------------------------------------------
// GET /comms/outbox — dispatch scan (transport)
// ---------------------------------------------------------------------------

commsApp.openapi(listOutbox, async (c) => {
  requireTransport(c);
  const { accountId } = c.req.valid('param');
  const { cursor, limit, status, eligible_at } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('comm_outbox').select('*').eq('account_id', accountId);
  if (status !== undefined) q = q.eq('status', status);
  // eligible_at is zod-validated ISO, safe to interpolate; a second .or()
  // is AND-combined with the keyset filter by PostgREST.
  if (eligible_at !== undefined) q = q.or(`not_before.is.null,not_before.lte.${eligible_at}`);
  const { items, next_cursor } = await keysetPage<OutboxRow>(q, { cursor, limit });
  return c.json({ data: items, next_cursor }, 200);
});

// ---------------------------------------------------------------------------
// GET /comms/outbox/{id} — recovery read (transport + landlord)
// ---------------------------------------------------------------------------

commsApp.openapi(getOutbox, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const principal = c.get('principal');
  const role = c.get('account').role;
  if (principal.type !== 'agent' && role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only the agent transport or an owner/manager may read outbox rows');
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
  return c.json(data as OutboxRow, 200);
});

// ---------------------------------------------------------------------------
// POST /comms/outbox/{id}/complete — ADR-0007 atomicity point (transport)
// ---------------------------------------------------------------------------

commsApp.openapi(completeSend, async (c) => {
  requireTransport(c);
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data: interactionId, error } = await sb.rpc('complete_send', {
    p_outbox_id: id,
    p_provider: body.provider,
    p_provider_sid: body.provider_sid,
  });
  if (error) throw commDbError(error);
  const { data: row, error: rowErr } = await sb
    .from('comm_outbox')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .single();
  if (rowErr) throw commDbError(rowErr);
  return c.json(
    { interaction_id: interactionId as string, outbox: row as OutboxRow },
    200,
  );
});

// ---------------------------------------------------------------------------
// POST /comms/outbox/{id}/fail — definitive rejection / reconcile parking
// ---------------------------------------------------------------------------

commsApp.openapi(failSend, async (c) => {
  requireTransport(c);
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('fail_send', {
    p_outbox_id: id,
    p_error_code: body.error_code,
    p_detail: body.detail ?? null,
    p_reconcile: body.reconcile ?? false,
  });
  if (error) throw commDbError(error);
  return c.json(data as OutboxRow, 200);
});

// ---------------------------------------------------------------------------
// POST /comms/outbox/{id}/delivery — monotonic callback advancement
// ---------------------------------------------------------------------------

commsApp.openapi(updateDelivery, async (c) => {
  requireTransport(c);
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('update_delivery', {
    p_outbox_id: id,
    p_status: body.status,
    p_provider_ts: body.provider_ts,
    p_error_code: body.error_code ?? null,
  });
  if (error) throw commDbError(error);
  return c.json(data as OutboxRow, 200);
});

// ---------------------------------------------------------------------------
// POST /comms/inbound — capture (transport); idempotent on provider_msg_id
// ---------------------------------------------------------------------------

commsApp.openapi(captureInbound, async (c) => {
  requireTransport(c);
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('capture_inbound', {
    p_account_id: accountId,
    p_provider: body.provider,
    p_provider_msg_id: body.provider_msg_id,
    p_to_number: body.to_number,
    p_from_address: body.from_address,
    p_channel: body.channel,
    p_body: body.body ?? null,
    p_media: body.media ?? null,
    p_received_at: body.received_at,
  });
  if (error) throw commDbError(error);
  const result = (data as {
    disposition: 'matched' | 'orphan' | 'opted_out';
    interaction_id: string | null;
    thread_id: string | null;
    participant_id: string | null;
  }[])[0];
  if (!result) throw new ApiError(500, 'internal_error', 'capture returned no result');

  let participant: ParticipantRow | null = null;
  if (result.participant_id !== null) {
    const { data: part, error: pErr } = await sb
      .from('comm_thread_participants')
      .select(PARTICIPANT_COLS)
      .eq('account_id', accountId)
      .eq('id', result.participant_id)
      .maybeSingle();
    if (pErr) throw commDbError(pErr);
    participant = (part as ParticipantRow | null) ?? null;
  }
  return c.json(
    {
      disposition: result.disposition,
      interaction_id: result.interaction_id,
      thread_id: result.thread_id,
      participant,
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// POST /comms/opt-outs — record (transport); GET — landlord read
// ---------------------------------------------------------------------------

commsApp.openapi(createOptOut, async (c) => {
  requireTransport(c);
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('record_opt_out', {
    p_account_id: accountId,
    p_channel: body.channel,
    p_address: normalizeAddress(body.channel, body.address),
    p_keyword: body.keyword,
    p_source_ref: body.source_ref,
  });
  if (error) throw commDbError(error);
  return c.json(data as z.infer<typeof CommOptOut>, 200);
});

commsApp.openapi(listOptOuts, async (c) => {
  requireManager(c);
  const { accountId } = c.req.valid('param');
  const { cursor, limit, channel } = c.req.valid('query');
  const sb = getSb(c);
  const { data, error } = await sb.rpc('list_account_opt_outs', {
    p_account_id: accountId,
    p_channel: channel ?? null,
  });
  if (error) throw commDbError(error);
  const rows = (data ?? []) as z.infer<typeof CommOptOut>[];
  const offset = cursor !== undefined ? decodeOffsetCursor(cursor) : 0;
  const page = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? encodeOffsetCursor(offset + limit) : null;
  return c.json({ data: page, next_cursor: next }, 200);
});

// ---------------------------------------------------------------------------
// Threads (landlord)
// ---------------------------------------------------------------------------

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

commsApp.openapi(listThreads, async (c) => {
  requireManager(c);
  const { accountId } = c.req.valid('param');
  const { cursor, limit, status, kind, tenancy_id } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('comm_threads').select('*').eq('account_id', accountId);
  if (status !== undefined) q = q.eq('status', status);
  if (kind !== undefined) q = q.eq('kind', kind);
  if (tenancy_id !== undefined) q = q.eq('tenancy_id', tenancy_id);
  const { items, next_cursor } = await keysetPage<z.infer<typeof CommThread>>(q, {
    cursor,
    limit,
    descending: true,
  });
  const participants = await loadParticipants(c, accountId, items.map((t) => t.id));
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
    .select('id, relay_of_interaction_id, participant_id, to_address, status, interaction_id, delivered_at')
    .eq('account_id', accountId)
    .in('relay_of_interaction_id', interactionIds);
  if (error) throw commDbError(error);
  for (const o of (data ?? []) as {
    id: string; relay_of_interaction_id: string; participant_id: string | null;
    to_address: string | null; status: z.infer<typeof CommOutboxStatus>;
    interaction_id: string | null; delivered_at: string | null;
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

commsApp.openapi(getThread, async (c) => {
  requireManager(c);
  const { accountId, id } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const sb = getSb(c);

  const { data: thread, error: thErr } = await sb
    .from('comm_threads')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (thErr) throw commDbError(thErr);
  if (!thread) throw new ApiError(404, 'not_found', 'not found');

  const participants = (await loadParticipants(c, accountId, [id])).get(id) ?? [];

  const { data: bindings, error: bErr } = await sb
    .from('thread_channel_bindings')
    .select(BINDING_COLS)
    .eq('account_id', accountId)
    .eq('thread_id', id);
  if (bErr) throw commDbError(bErr);

  // Journal rows in the thread, newest-first, with derived delivery state
  // from the chain view (outbox join), then per-leg relay fan-out.
  const msgQuery = sb
    .from('interactions_with_chain')
    .select('*')
    .eq('account_id', accountId)
    .eq('thread_id', id)
    .is('deleted_at', null);
  const { items: msgRows, next_cursor: messagesNext } = await keysetPage<Record<string, unknown>>(
    msgQuery,
    { cursor, limit, column: 'occurred_at', descending: true },
  );
  const legs = await loadRelayLegs(c, accountId, msgRows.map((m) => String(m.id)));
  const messages = msgRows.map((m) => ({
    ...withResolvedAuthorship(m as { author_type?: string | null; actor: string }),
    relay_legs: legs.get(String(m.id)) ?? [],
  }));

  return c.json(
    {
      ...(thread as z.infer<typeof CommThread>),
      participants,
      bindings: (bindings ?? []) as z.infer<typeof CommThreadBinding>[],
      messages,
      messages_next_cursor: messagesNext,
    } as z.infer<typeof CommThreadDetail>,
    200,
  );
});

commsApp.openapi(createThread, async (c) => {
  requireManager(c);
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // Counterparties need a reachable address; require party_id so identity
  // lookup / journal attribution stay honest.
  for (const p of body.participants) {
    if ((p.party_type === 'tenant' || p.party_type === 'vendor') && p.party_id === undefined) {
      throw new ApiError(400, 'invalid_request', `${p.party_type} participants require party_id`);
    }
  }
  const counterparties = body.participants.filter(
    (p) => p.party_type === 'tenant' || p.party_type === 'vendor',
  );
  if (counterparties.length === 0) {
    throw new ApiError(400, 'invalid_request', 'a thread needs at least one tenant or vendor participant');
  }

  // Resolve every counterparty address BEFORE creating anything, so a
  // resolution failure leaves no partial thread.
  const resolvedAddresses = new Map<number, string>();
  for (const [i, p] of body.participants.entries()) {
    if (p.party_type !== 'tenant' && p.party_type !== 'vendor') continue;
    if (p.address !== undefined) {
      resolvedAddresses.set(i, normalizeAddress(body.channel, p.address));
      continue;
    }
    const { data: ident, error: iErr } = await sb
      .from('channel_identities')
      .select('address')
      .eq('account_id', accountId)
      .eq('channel', body.channel)
      .eq('party_type', p.party_type)
      .eq('party_id', p.party_id!)
      .limit(1)
      .maybeSingle();
    if (iErr) throw commDbError(iErr);
    if (!ident) {
      throw new ApiError(
        422,
        'invalid_request',
        `no ${body.channel} address on file for participant ${i}; supply address explicitly`,
      );
    }
    resolvedAddresses.set(i, ident.address);
  }

  // The account's platform number carries every counterparty leg.
  const { data: number, error: numErr } = await sb
    .from('platform_numbers')
    .select('number')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .contains('capabilities', [body.channel])
    .limit(1)
    .maybeSingle();
  if (numErr) throw commDbError(numErr);
  if (!number) {
    throw new ApiError(409, 'conflict', `the account has no active platform number with ${body.channel} capability`);
  }

  const { data: thread, error: thErr } = await sb
    .from('comm_threads')
    .insert({
      account_id: accountId,
      kind: body.kind,
      tenancy_id: body.tenancy_id ?? null,
      maintenance_request_id: body.maintenance_request_id ?? null,
    })
    .select('*')
    .single();
  if (thErr) throw commDbError(thErr);

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
      bindingRows.push({
        account_id: accountId,
        thread_id: thread.id as string,
        participant_id: participant.id,
        platform_number: number.number as string,
        participant_address: address,
      });
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
      .filter(({ p, i }) => p.address !== undefined && resolvedAddresses.has(i) && p.party_id !== undefined)
      .map(({ p, i }) => ({
        account_id: accountId,
        party_type: p.party_type,
        party_id: p.party_id!,
        channel: body.channel,
        address: resolvedAddresses.get(i)!,
      }));
    if (newIdentities.length > 0) {
      const { error: idErr } = await sb
        .from('channel_identities')
        .upsert(newIdentities, { onConflict: 'account_id,channel,address', ignoreDuplicates: true });
      if (idErr) throw commDbError(idErr);
    }

    return c.json(
      {
        ...(thread as z.infer<typeof CommThread>),
        participants,
        bindings: (bindings ?? []) as z.infer<typeof CommThreadBinding>[],
        messages: [],
        messages_next_cursor: null,
      } as z.infer<typeof CommThreadDetail>,
      201,
    );
  } catch (e) {
    // Best-effort cleanup of the skeleton; the original error is what the
    // client needs to see.
    await sb.from('thread_channel_bindings').delete().eq('account_id', accountId).eq('thread_id', thread.id as string);
    await sb.from('comm_thread_participants').delete().eq('account_id', accountId).eq('thread_id', thread.id as string);
    await sb.from('comm_threads').delete().eq('account_id', accountId).eq('id', thread.id as string);
    throw e;
  }
});

commsApp.openapi(createThreadMessage, async (c) => {
  requireManager(c);
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const userId = c.get('auth').userId;

  const { data: thread, error: thErr } = await sb
    .from('comm_threads')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (thErr) throw commDbError(thErr);
  if (!thread) throw new ApiError(404, 'not_found', 'not found');
  if (thread.status === 'closed') throw new ApiError(409, 'conflict', 'the thread is closed');

  // One send intent per actively-bound counterparty. The binding carries the
  // address the conversation runs on; sms is the only bound channel today.
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
      .filter((p) => (p.party_type === 'tenant' || p.party_type === 'vendor') && p.left_at === null)
      .map((p) => [p.id, p]),
  );
  const targets = ((bindings ?? []) as { participant_id: string; participant_address: string }[])
    .filter((b) => present.has(b.participant_id));
  if (targets.length === 0) {
    throw new ApiError(409, 'conflict', 'the thread has no actively-bound counterparty to message');
  }

  const { data: rows, error } = await sb
    .from('comm_outbox')
    .insert(
      targets.map((t) => ({
        account_id: accountId,
        channel: 'sms',
        to_address: t.participant_address,
        thread_id: id,
        participant_id: t.participant_id,
        body: body.body,
        not_before: body.not_before ?? null,
        approval_ref: `self:${userId}`,
        approved_by: userId,
        author_type: 'landlord',
      })),
    )
    .select('*');
  if (error) throw commDbError(error);
  return c.json({ data: (rows ?? []) as OutboxRow[] }, 201);
});

// ---------------------------------------------------------------------------
// Policies (landlord, owner|manager)
// ---------------------------------------------------------------------------

// Canonical per-kind params (agreed cross-repo): unknown keys are rejected so
// a typo'd policy can't silently change what the reminder cron sends.
const RENT_REMINDER_PARAMS = z
  .object({
    days_before: z.number().int().min(0).max(60),
    monthly_cap: z.number().int().min(1).max(100),
  })
  .strict();

function validatePolicyParams(kind: string, params: Record<string, unknown>): void {
  if (kind === 'rent_reminder') {
    const parsed = RENT_REMINDER_PARAMS.safeParse(params);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'invalid_request',
        "rent_reminder params must be exactly { days_before: number, monthly_cap: number }",
        { fieldErrors: { params: [parsed.error.issues.map((i) => i.message).join('; ')] } },
      );
    }
  }
  // thread_autonomy / voice_autonomy: no canonical params agreed yet;
  // pass-through until the coordinator publishes their shapes.
}

commsApp.openapi(listPolicies, async (c) => {
  requireManager(c);
  const { accountId } = c.req.valid('param');
  const { cursor, limit, status, policy_kind } = c.req.valid('query');
  const sb = getSb(c);
  let q = sb.from('comm_policies').select('*').eq('account_id', accountId);
  if (status !== undefined) q = q.eq('status', status);
  if (policy_kind !== undefined) q = q.eq('policy_kind', policy_kind);
  const { items, next_cursor } = await keysetPage<z.infer<typeof CommPolicy>>(q, {
    cursor,
    limit,
    descending: true,
  });
  return c.json({ data: items, next_cursor }, 200);
});

commsApp.openapi(createPolicy, async (c) => {
  requireManager(c);
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  validatePolicyParams(body.policy_kind, body.params);
  const sb = getSb(c);
  const { data, error } = await sb
    .from('comm_policies')
    .insert({
      account_id: accountId,
      policy_kind: body.policy_kind,
      channel: body.channel,
      template_id: body.template_id ?? null,
      params: body.params,
      quiet_hours: body.quiet_hours ?? null,
      // Creation IS the approval act.
      approved_by: c.get('auth').userId,
    })
    .select('*')
    .single();
  if (error) throw commDbError(error);
  return c.json(data as z.infer<typeof CommPolicy>, 201);
});

commsApp.openapi(revokePolicy, async (c) => {
  requireManager(c);
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const userId = c.get('auth').userId;

  const { data: existing, error: exErr } = await sb
    .from('comm_policies')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (exErr) throw commDbError(exErr);
  if (!existing) throw new ApiError(404, 'not_found', 'not found');
  // Replay-friendly: revoking a revoked policy returns it unchanged.
  if (existing.status === 'revoked') {
    return c.json(existing as z.infer<typeof CommPolicy>, 200);
  }

  const { data: revoked, error } = await sb
    .from('comm_policies')
    .update({ status: 'revoked', revoked_by: userId, revoked_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', id)
    .eq('status', 'active')
    .select('*')
    .single();
  if (error) throw commDbError(error);

  // Queued-but-unsent intents authorized by this grant die with it. 'sending'
  // rows are mid-flight (the transport re-checks policy status before dialing
  // new work, and delivery callbacks still land).
  const { error: parkErr } = await sb
    .from('comm_outbox')
    .update({ status: 'undeliverable', error_code: 'policy_revoked', error_message: 'standing grant revoked before dispatch' })
    .eq('account_id', accountId)
    .eq('status', 'queued')
    .eq('approval_ref', `grant:${id}`);
  if (parkErr) throw commDbError(parkErr);

  return c.json(revoked as z.infer<typeof CommPolicy>, 200);
});

// ---------------------------------------------------------------------------
// GET /comms/reconcile — stale 'sending' scan (transport)
// ---------------------------------------------------------------------------

commsApp.openapi(reconcileScan, async (c) => {
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
