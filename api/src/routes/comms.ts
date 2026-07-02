import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { ApiError, errorResponses } from './_lib/error';
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
     *  ignored and return the unchanged row. */
    status: z.enum(['sent', 'delivered', 'failed', 'undeliverable']),
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

// Contract-first stubs: the schemas above are FINAL; handlers land in M2.
// Throwing (rather than returning a typed error) keeps zod-openapi's
// response inference on the success path, same as every other route.
const notImplemented = (): never => {
  throw new ApiError(
    501,
    'not_implemented',
    'this comms endpoint is a contract-first stub; the handler ships with the ledger milestones',
  );
};

commsApp.openapi(createOutbox, notImplemented);
commsApp.openapi(listOutbox, notImplemented);
commsApp.openapi(getOutbox, notImplemented);
commsApp.openapi(completeSend, notImplemented);
commsApp.openapi(failSend, notImplemented);
commsApp.openapi(updateDelivery, notImplemented);
commsApp.openapi(captureInbound, notImplemented);
commsApp.openapi(createOptOut, notImplemented);
commsApp.openapi(listOptOuts, notImplemented);
commsApp.openapi(listThreads, notImplemented);
commsApp.openapi(getThread, notImplemented);
commsApp.openapi(createThread, notImplemented);
commsApp.openapi(createThreadMessage, notImplemented);
commsApp.openapi(listPolicies, notImplemented);
commsApp.openapi(createPolicy, notImplemented);
commsApp.openapi(revokePolicy, notImplemented);
commsApp.openapi(reconcileScan, notImplemented);
