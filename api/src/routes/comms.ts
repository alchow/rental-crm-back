import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { requireAuth } from '../middleware/auth';
import { loadEnv } from '../env';
import { ApiError, dbError, errorResponses } from './_lib/error';
import { keysetPage } from './_lib/cursor';
import { normalizePhone } from './_lib/phone';
import { brandedReplyDomain } from './_lib/subdomain';
import { withResolvedAuthorship } from './_lib/authorship';
import { Interaction, loadInteractionParticipants } from './interactions';
import {
  evidenceSha256,
  evidenceStoragePath,
  storeEvidenceBytes,
  MAX_EVIDENCE_BYTES,
} from '../admin/evidence';
import { queuePersonaAck } from '../admin/persona-ack';

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
// bridged = per-counterparty 1:1 legs relayed by core; group = one provider-
// native MMS group (our platform number + up to 7 member addresses, the
// landlord's phone included).
const CommThreadMode = z.enum(['bridged', 'group']);
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
    /** Frozen recipient set of a group send (to_address is null exactly when
     *  this is set); dialed as ONE provider group message whose provider_sid is
     *  the group_message_id; null on 1:1 rows. */
    group_addresses: z.array(z.string()).nullable(),
    /** WHO the dialed address(es) resolved to at INTENT time — trigger-stamped
     *  from thread bindings / channel identities, immutable, and copied
     *  verbatim into the journal cast on completion, so an identity edited
     *  while the row sits queued can never rewrite who the send is recorded
     *  as reaching. Null on rows queued before the column landed. */
    recipient_snapshot: z
      .array(
        z.object({
          address: z.string().nullable(),
          party_type: z.string(),
          party_id: z.string().uuid().nullable(),
          label: z.string().nullable(),
        }),
      )
      .nullable()
      .optional(),
    thread_id: z.string().uuid().nullable(),
    /** Thread participant this leg addresses (comm_thread_participants.id). */
    participant_id: z.string().uuid().nullable(),
    body: z.string(),
    /** Email subject line, frozen at intent time (email-only; null on
     *  sms/voice). On completion the journal records it as the first line
     *  ('Subject: <subject>' + blank line + body). */
    subject: z.string().nullable(),
    /** Opaque template reference (templates live agent-side). */
    template_id: z.string().nullable(),
    /** Earliest eligible dispatch time; the transport's dispatch scan must
     *  not pick this row up before it. Null = immediately eligible. */
    not_before: z.string().nullable(),
    /** For relay legs of a bridged thread: the journal entry (inbound
     *  original) this send relays. */
    relay_of_interaction_id: z.string().uuid().nullable(),
    /** Optional context refs copied onto the journal row on completion so the
     *  send surfaces in the tenancy / maintenance-request activity feed. */
    tenancy_id: z.string().uuid().nullable(),
    maintenance_request_id: z.string().uuid().nullable(),
    status: CommOutboxStatus,
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    /** Provider that accepted the send (e.g. 'twilio'); set on completion. */
    provider: z.string().nullable(),
    /** Provider message id; unique, set on completion. */
    provider_sid: z.string().nullable(),
    /** The SENT mail's RFC 5322 Message-ID, reported by the transport at
     *  completion (email only; normalized server-side). Null until completed
     *  or when the transport did not report one. */
    rfc822_message_id: z.string().nullable().optional(),
    /** Derived, read-only (email relay legs): the Message-ID of the inbound
     *  original this leg relays (relay_of_interaction_id's journal row) — set
     *  it as In-Reply-To/References when rendering the relayed mail so the
     *  conversation threads natively in the recipient's client. Null when the
     *  original carried no Message-ID; absent on non-relay rows. */
    relay_source_rfc822_message_id: z.string().nullable().optional(),
    /** Server-generated opaque ref the transport passes to the provider so
     *  callbacks can always re-associate with this row (unique). */
    client_ref: z.string(),
    approval_ref: z.string(),
    approved_by: z.string().uuid().nullable(),
    /** Capacity of the author of the send intent (stamped from the resolved
     *  principal, never client-supplied). 'system' = a core-originated
     *  transactional send (approval_ref 'system:<flow>'), mintable only by
     *  core's service tier — it appears in reads/dispatch scans but can never
     *  be requested through this API. */
    author_type: z.enum(['landlord', 'agent', 'system']),
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
    /** Email subject line. Email-only: supplying it on any other channel is a
     *  400. Journaled on completion as `Subject: <subject>\n\n<body>` — one
     *  documented shape shared with the transport's template rendering. */
    subject: z.string().min(1).max(998).optional(),
    approval_ref: z.string().min(1).max(200),
    approved_by: z.string().uuid().optional(),
    not_before: z.string().datetime().optional(),
    relay_of_interaction_id: z.string().uuid().optional(),
    template_id: z.string().min(1).max(200).optional(),
    /** Optional context: links the send (and, on completion, its journal row)
     *  to a tenancy / maintenance request so it appears in that entity's feed.
     *  Composite-FK validated to the account. */
    tenancy_id: z.string().uuid().optional(),
    maintenance_request_id: z.string().uuid().optional(),
  })
  .openapi('CreateCommOutboxBody');

const OutboxListResponse = z
  .object({ data: z.array(CommOutbox), next_cursor: z.string().nullable() })
  .openapi('CommOutboxListResponse');

const CompleteSendBody = z
  .object({
    provider: z.string().min(1).max(100),
    provider_sid: z.string().min(1).max(200),
    /** Email-only: the Message-ID the provider stamped on the SENT mail
     *  (angle brackets optional; normalized server-side). Recorded on the
     *  outbox row + journal entry so later replies/relays can cite it. */
    rfc822_message_id: z.string().min(3).max(998).optional(),
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

/** Provider-evaluated email authentication verdicts (RFC 7601 vocabulary),
 *  passed through by the transport from the receiving provider's headers.
 *  Core stores them with the raw capture; later phases gate attribution and
 *  auto-replies on them. */
const CommAuthResults = z
  .object({
    spf: z.enum(['pass', 'fail', 'neutral', 'none', 'softfail', 'temperror', 'permerror']),
    dkim: z.enum(['pass', 'fail', 'neutral', 'none', 'policy', 'temperror', 'permerror']),
    dmarc: z.enum(['pass', 'fail', 'none', 'temperror', 'permerror']),
  })
  .openapi('CommAuthResults');

const CaptureInboundBody = z
  .object({
    provider: z.string().min(1).max(100),
    /** Idempotency key for capture: replaying the same provider_msg_id
     *  returns the original result without writing anything. */
    provider_msg_id: z.string().min(1).max(200),
    /** The platform number the message arrived on (binding routing key). For
     *  email captures this instead carries the tokenized reply address
     *  (lowercased) the message was sent to — the email routing key. (Capped at
     *  320 like from_address: a `t-<token>@<domain>` address exceeds a phone's
     *  length.) */
    to_number: z.string().min(3).max(320),
    /** The counterparty address the message came from. */
    from_address: z.string().min(3).max(320),
    /** The other recipients of an inbound group message (E.164 as received from
     *  the provider, exactly like from_address). When present and non-empty,
     *  routing is by participant-SET match ({from} ∪ cc minus our number == a
     *  group thread's bound member set) instead of the 1:1 binding lookup; no
     *  set match → orphan. */
    cc: z.array(z.string().min(3).max(50)).max(10).optional(),
    channel: CommChannel,
    body: z.string().max(20000).optional(),
    media: z.array(CommInboundMedia).max(20).optional(),
    received_at: z.string().datetime(),
    /** Email-only. The mail's Subject header, stored with the raw capture
     *  (NOT folded into the journal body — the journal shape is unchanged). */
    subject: z.string().min(1).max(998).optional(),
    /** Email-only. The mail's own RFC 5322 Message-ID (angle brackets
     *  optional; normalized trim+strip+lowercase server-side). Powers the
     *  same-thread duplicate detection: one email delivered to two platform
     *  mailboxes arrives as two receipts with two provider_msg_ids, and this
     *  is the identity that recognizes them as one message. */
    rfc822_message_id: z.string().min(3).max(998).optional(),
    /** Email-only. The In-Reply-To header, stored with the raw capture. */
    in_reply_to: z.string().min(3).max(998).optional(),
    /** Email-only. The References header's Message-IDs, oldest first. */
    references: z.array(z.string().min(3).max(998)).max(50).optional(),
    /** Email-only. Provider auth verdicts; stored with the raw capture. */
    auth_results: CommAuthResults.optional(),
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

// ---------------------------------------------------------------------------
// Persona inbound capture — the cold-inbound front door (no reply token).
// Routing resolves the SENDER, not the recipient: the transport resolves the
// persona address to an account first (resolve-persona-address), then posts
// the mail here.
// ---------------------------------------------------------------------------

const CapturePersonaInboundBody = z
  .object({
    provider: z.string().min(1).max(100),
    /** Idempotency key (same space as token captures: one inbound_raw). */
    provider_msg_id: z.string().min(1).max(200),
    /** The persona address the mail arrived on (already resolved to this
     *  account by resolve-persona-address). */
    persona_address: z.string().min(5).max(320),
    /** The sender — the routing input. */
    from_address: z.string().min(3).max(320),
    /** The sender's From display name, if any (cast label fallback + the
     *  phase-6 triage suggestion input). */
    from_display_name: z.string().min(1).max(200).optional(),
    /** The mail's other To recipients (persona excluded or not — core
     *  filters). */
    to_addresses: z.array(z.string().min(3).max(320)).max(50).default([]),
    cc_addresses: z.array(z.string().min(3).max(320)).max(50).default([]),
    subject: z.string().min(1).max(998).optional(),
    /** Capped at the relay/outbox limit: a larger body could never be relayed
     *  onward or acked. The transport truncates / strips HTML first. */
    body: z.string().max(20000).optional(),
    media: z.array(CommInboundMedia).max(20).optional(),
    rfc822_message_id: z.string().min(3).max(998).optional(),
    in_reply_to: z.string().min(3).max(998).optional(),
    references: z.array(z.string().min(3).max(998)).max(50).optional(),
    /** REQUIRED here (unlike token capture): sender identity is the routing
     *  key, so attribution is gated on DMARC — a capture without verdicts is
     *  treated as unauthenticated and lands in triage. */
    auth_results: CommAuthResults,
    received_at: z.string().datetime(),
  })
  .openapi('CapturePersonaInboundBody');

const CapturePersonaInboundResponse = z
  .object({
    /** matched: the sender resolved to a known tenant/vendor (DMARC pass) and
     *  the message journaled into their active email thread — created
     *  atomically (tokens minted) when none existed. Relay it onward like any
     *  thread inbound.
     *  triaged: unknown sender, or a claimed-known sender that failed DMARC —
     *  raw-tier captured; nothing journaled; relay nothing. (Phase 6 adds the
     *  visible triage queue.)
     *  duplicate: this email's Message-ID already journaled into the resolved
     *  thread (the token door landed first) — ids point at the ORIGINAL row;
     *  success-no-op, relay nothing.
     *  opted_out: matched AND journaled, but the sender is on the opt-out
     *  register — relay nothing.
     *  cc_journaled: reserved for the phase-4 landlord CC arm — journal-only;
     *  relay nothing.
     *  Forward-compat rule: relay nothing on any unrecognized disposition. */
    disposition: z.enum(['matched', 'triaged', 'duplicate', 'opted_out', 'cc_journaled']),
    interaction_id: z.string().uuid().nullable(),
    thread_id: z.string().uuid().nullable(),
    participant: CommThreadParticipant.nullable(),
    /** The triage row id once phase 6 lands; null until then. */
    unmatched_id: z.string().uuid().nullable(),
  })
  .openapi('CapturePersonaInboundResponse');

const CaptureInboundResponse = z
  .object({
    /** matched: bound thread+participant resolved and the message journaled.
     *  orphan: no active binding for (to_number, from_address) — captured in
     *  the raw tier only; nothing journaled (no account to attribute to).
     *  opted_out: matched AND journaled, but the counterparty address is on
     *  the opt-out register — the transport must not relay further replies
     *  and should run its keyword handling.
     *  sender_mismatch: the email reply token resolved but the from-address is
     *  NOT the bound participant's — the message IS journaled into the thread
     *  (party 'unspecified', actual sender as the label) but the transport must
     *  NOT auto-relay it as verified.
     *  duplicate: the token resolved AND this email's own Message-ID already
     *  journaled into the same thread (a second delivery door of one send) —
     *  nothing new was written; interaction_id/thread_id/participant point at
     *  the ORIGINAL row. Treat as success-no-op; relay nothing.
     *  Forward-compat rule: relay nothing on any unrecognized disposition. */
    disposition: z.enum(['matched', 'orphan', 'opted_out', 'sender_mismatch', 'duplicate']),
    interaction_id: z.string().uuid().nullable(),
    thread_id: z.string().uuid().nullable(),
    participant: CommThreadParticipant.nullable(),
  })
  .openapi('CaptureCommInboundResponse');

// ---------------------------------------------------------------------------
// Evidence archive (EV-B) — the carrier-signed webhook original, archived
// verbatim so inbound journal rows are verifiable independently of our own
// software. The transport POSTs the raw body + signature headers BEFORE
// parsing (archive-then-process; see docs/comms-evidence.md). The provenance
// row is audit-attached, so its body hash lands in the per-account event
// hash chain — blob and ledger vouch for each other.
// ---------------------------------------------------------------------------

const CommEvidenceBody = z
  .object({
    provider: z.string().min(1).max(100),
    /** Idempotency key, same value later passed to the inbound capture. A
     *  replay with the SAME body returns the original row; a replay with a
     *  DIFFERENT body is refused (409) — first archived claim wins. */
    provider_msg_id: z.string().min(1).max(200),
    /** The webhook body VERBATIM (base64 of the exact bytes received). The
     *  hash is computed server-side from these bytes; max 5 MiB decoded. */
    raw_body_b64: z
      .string()
      .min(1)
      .max(7_100_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    /** Provider signature header value (e.g. telnyx-signature-ed25519).
     *  Optional: an unsigned provider still gets body-hash anchoring. */
    signature: z.string().min(1).max(2000).optional(),
    /** Provider signature timestamp header value (e.g. telnyx-timestamp). */
    signature_timestamp: z.string().min(1).max(100).optional(),
    received_at: z.string().datetime(),
  })
  .openapi('CommEvidenceBody');

const CommInboundProvenance = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    provider: z.string(),
    provider_msg_id: z.string(),
    /** sha256 (lowercase hex) of the archived verbatim body bytes. Anchored
     *  in the audit hash chain by this row's insert event. */
    body_sha256: z.string(),
    signature: z.string().nullable(),
    signature_timestamp: z.string().nullable(),
    /** Object name in the private 'comm-evidence' bucket (API-mediated;
     *  content-addressed: `<account>/<sha256>.bin`). */
    storage_path: z.string(),
    received_at: z.string(),
    /** Set when the retention janitor removed the BLOB (the row itself is
     *  never deleted — the subpoena handle survives). Null while archived. */
    purged_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('CommInboundProvenance');

// ---------------------------------------------------------------------------
// Legal hold — while active, every comms destruction path skips the account
// (the inbound_raw prune and the evidence-blob retention janitor). Read is
// member-wide; set/release is owner|manager only — the agent principal must
// never be able to release a hold and re-enable purging.
// ---------------------------------------------------------------------------

const AccountLegalHold = z
  .object({
    account_id: z.string().uuid(),
    active: z.boolean(),
    reason: z.string().nullable(),
    /** Member who last set the hold; null if never set. */
    set_by: z.string().uuid().nullable(),
    /** When the hold was last set; null if never set. */
    set_at: z.string().nullable(),
    /** When the hold was last released; null while active or never set. */
    released_at: z.string().nullable(),
  })
  .openapi('AccountLegalHold');

const SetLegalHoldBody = z
  .object({
    active: z.boolean(),
    /** Why the hold exists (demand letter, filed case, …). Recorded on set;
     *  ignored on release. */
    reason: z.string().min(1).max(2000).optional(),
  })
  .openapi('SetAccountLegalHoldBody');

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

const CommThread = z
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
  channel: CommChannel.optional(),
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
  /** The account's From display name the transport renders on relayed mail;
   *  account-level, injected at the handler (not on list/THREAD_COLS). Null
   *  when the account has not set one. */
  sender_display_name: z.string().nullable(),
}).openapi('CommThreadDetail');

const CreateThreadBody = z
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
    // union-with-null (not .nullable()): the generator drops nullability
    // from a wrapped registered schema; the union form emits anyOf correctly.
    quiet_hours: z.union([CommQuietHours, z.null()]),
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

const capturePersonaInbound = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/comms/inbound-persona',
  tags: ['comms'],
  summary:
    'Capture an inbound email addressed to the account persona (transport). ' +
    'No reply token: the SENDER is the routing key — a known tenant/vendor ' +
    '(DMARC pass) journals into their active email thread, created atomically ' +
    'when none exists; everything else lands in triage. Idempotent on ' +
    'provider_msg_id (shared raw tier with token capture).',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CapturePersonaInboundBody } }, required: true },
  },
  responses: {
    200: { description: 'capture result', content: { 'application/json': { schema: CapturePersonaInboundResponse } } },
    ...errorResponses,
  },
});

const captureEvidence = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/comms/evidence',
  tags: ['comms'],
  summary:
    'Archive the verbatim signed webhook for an inbound message (transport). ' +
    'The body hash is computed server-side, recorded on an audit-anchored ' +
    'provenance row, and the exact bytes are stored in the private evidence ' +
    'bucket. Idempotent on provider_msg_id; a replay with a different body ' +
    'is refused (409) — the first archived claim wins. Independent of the ' +
    'inbound capture call: archive-then-process.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: CommEvidenceBody } }, required: true },
  },
  responses: {
    200: { description: 'provenance anchor', content: { 'application/json': { schema: CommInboundProvenance } } },
    ...errorResponses,
  },
});

const getLegalHold = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/comms/legal-hold',
  tags: ['comms'],
  summary:
    'Read the account legal-hold state (any member). active=false with null ' +
    'timestamps means no hold was ever set.',
  request: { params: AccountParam },
  responses: {
    200: { description: 'hold state', content: { 'application/json': { schema: AccountLegalHold } } },
    ...errorResponses,
  },
});

const setLegalHold = createRoute({
  method: 'put',
  path: '/accounts/{accountId}/comms/legal-hold',
  tags: ['comms'],
  summary:
    'Set or release the account legal hold (owner|manager). While active, ' +
    'every comms destruction path (raw-capture prune, evidence-blob ' +
    'retention) skips this account. Audited.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: SetLegalHoldBody } }, required: true },
  },
  responses: {
    200: { description: 'hold state after the write', content: { 'application/json': { schema: AccountLegalHold } } },
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

const RebindBody = z
  .object({
    /** The counterparty's NEW address for this leg. Email bindings only. */
    address: z.string().min(3).max(320),
  })
  .openapi('RebindCommBindingBody');

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
      accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
      threadId: z.string().uuid().openapi({ param: { name: 'threadId', in: 'path' } }),
      bindingId: z.string().uuid().openapi({ param: { name: 'bindingId', in: 'path' } }),
    }),
    body: { content: { 'application/json': { schema: RebindBody } }, required: true },
  },
  responses: {
    200: { description: 'updated binding', content: { 'application/json': { schema: CommThreadBinding } } },
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

// ---------------------------------------------------------------------------
// Transport token-resolve read (E2-A2). Lives OUTSIDE the account-scoped path
// on purpose: reply tokens are runtime-minted, so an inbound email's token is
// the ONLY thing the transport knows — the account is exactly what it is
// asking for. requireAuth() is attached per-route (the /accounts/* middleware
// stack never fires here); the handler gates on the agent principal itself.
// ---------------------------------------------------------------------------

const ResolveReplyAddressResponse = z
  .object({
    account_id: z.string().uuid(),
    thread_id: z.string().uuid(),
    participant_id: z.string().uuid(),
  })
  .openapi('CommResolveReplyAddressResponse');

const resolveReplyAddress = createRoute({
  method: 'get',
  path: '/comms/resolve-reply-address',
  tags: ['comms'],
  middleware: [requireAuth()] as const,
  summary:
    'Resolve a tokenized email reply address to its (account, thread, ' +
    'participant) — transport only, account-agnostic by design (the token is ' +
    'all an inbound email carries). 404 for anything but an ACTIVE email ' +
    'binding in an account the caller transports (uniform: unknown, revoked, ' +
    'and foreign tokens are indistinguishable).',
  request: {
    query: z.object({
      /** The full tokenized reply address (t-<token>@<domain>); matched
       *  trim+lowercased, like capture. */
      address: z.string().min(5).max(320),
    }),
  },
  responses: {
    200: { description: 'active binding', content: { 'application/json': { schema: ResolveReplyAddressResponse } } },
    ...errorResponses,
  },
});

const ResolvePersonaAddressResponse = z
  .object({
    account_id: z.string().uuid(),
  })
  .openapi('CommResolvePersonaAddressResponse');

const resolvePersonaAddress = createRoute({
  method: 'get',
  path: '/comms/resolve-persona-address',
  tags: ['comms'],
  middleware: [requireAuth()] as const,
  summary:
    'Resolve a persona address (<local>@<subdomain>.<parent>) to its account — ' +
    'transport only, account-agnostic like resolve-reply-address (a cold ' +
    'inbound email carries nothing but the address). 404 for anything but a ' +
    'configured persona in an account the caller transports (uniform: unknown ' +
    'local parts, unknown subdomains, and foreign accounts are ' +
    'indistinguishable).',
  request: {
    query: z.object({
      /** The full persona address; matched trim+lowercased. */
      address: z.string().min(5).max(320),
    }),
  },
  responses: {
    200: { description: 'persona account', content: { 'application/json': { schema: ResolvePersonaAddressResponse } } },
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

// Pin an outbox mutation to the URL account BEFORE calling its RPC. The
// complete/fail/delivery RPCs self-defend on the row's OWN account (and
// fail_send/update_delivery rely on RLS), so a caller who is a member of both
// the URL account and the row's account could otherwise drive a row in the
// wrong account through the URL. account_id is immutable (guard trigger), so
// this check is race-free. 404 (not 403) so a foreign id is indistinguishable
// from a missing one.
async function assertOutboxInAccount(c: Context, accountId: string, id: string): Promise<void> {
  const { data, error } = await getSb(c)
    .from('comm_outbox')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw commDbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
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
// Explicit so the internal group_routing_key column (canonical member-set
// identity, enforced DB-side) never rides along into thread responses.
const THREAD_COLS =
  'id, account_id, kind, mode, channel, subject, status, tenancy_id, maintenance_request_id, created_at, updated_at';
const BINDING_COLS =
  'id, thread_id, participant_id, channel, platform_number, participant_address, reply_address, active';

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

  // system:<flow> provenance is reserved for core-originated sends (core's
  // server tier writing its own ledger through the admin client). Applies to
  // BOTH the agent and landlord principals here — no JWT-bearing caller may
  // mint one. The DB capacity trigger (auth.uid() IS NOT NULL) is the backstop.
  if (body.approval_ref.startsWith('system:')) {
    throw new ApiError(403, 'forbidden', 'system provenance is reserved for core-originated sends');
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
        throw new ApiError(400, 'invalid_request', 'approved_by must be a non-agent member of this account');
      }
    } else if (isGrant) {
      // A grant ref must name a live standing policy in THIS account, and the
      // policy's channel must match the send's channel — a standing grant for
      // sms does not authorize a voice/email send.
      const grantId = body.approval_ref.slice('grant:'.length);
      if (!UUID_RE.test(grantId)) {
        throw new ApiError(400, 'invalid_request', "a 'grant:' approval_ref must carry the comm_policies id");
      }
      const { data: policy, error: polErr } = await sb
        .from('comm_policies')
        .select('id, status, channel')
        .eq('account_id', accountId)
        .eq('id', grantId)
        .maybeSingle();
      if (polErr) throw commDbError(polErr);
      if (!policy || policy.status !== 'active') {
        throw new ApiError(403, 'forbidden', 'the referenced grant is not an active policy of this account');
      }
      if (policy.channel !== body.channel) {
        throw new ApiError(403, 'forbidden', `the referenced grant authorizes ${policy.channel}, not ${body.channel}`);
      }
    } else {
      // thread:<id> — valid ONLY for a relay leg: relay_of_interaction_id must
      // be set, the thread live + account-owned, and the relayed interaction
      // must belong to that thread. The thread is the recorded authorizing act.
      if (body.relay_of_interaction_id === undefined) {
        throw new ApiError(403, 'forbidden', "a 'thread:' approval_ref is only valid on a relay (relay_of_interaction_id required)");
      }
      const threadRef = body.approval_ref.slice('thread:'.length);
      if (!UUID_RE.test(threadRef)) {
        throw new ApiError(400, 'invalid_request', "a 'thread:' approval_ref must carry the thread id");
      }
      const { data: thread, error: thErr } = await sb
        .from('comm_threads')
        .select('id, status')
        .eq('account_id', accountId)
        .eq('id', threadRef)
        .maybeSingle();
      if (thErr) throw commDbError(thErr);
      if (!thread || thread.status !== 'active') {
        throw new ApiError(403, 'forbidden', 'the referenced thread is not an active thread of this account');
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
        throw new ApiError(403, 'forbidden', 'the relayed interaction does not belong to the referenced thread');
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
      throw new ApiError(400, 'invalid_request', 'a group thread derives recipients from its bindings; to_address is not accepted');
    }
    if (body.participant_ref !== undefined) {
      throw new ApiError(400, 'invalid_request', 'a group send addresses the whole thread; participant_ref is not accepted');
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
      throw new ApiError(409, 'conflict', 'the group thread needs at least 2 actively-bound members');
    }
  } else {
    // 1:1 (or thread-less): explicit address, else the thread binding, else
    // the account's channel identity for the participant.
    if (body.to_address === undefined && (body.thread_id === undefined || body.participant_ref === undefined)) {
      throw new ApiError(400, 'invalid_request', 'provide to_address, or thread_id + participant_ref to resolve one');
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
      if (part.left_at !== null) throw new ApiError(409, 'conflict', 'the participant has left the thread');
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
        throw new ApiError(422, 'invalid_request', 'no destination address is bound or on file for this participant');
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

commsApp.openapi(listOutbox, async (c) => {
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
  const [row] = await withRelaySourceMessageIds(c, accountId, [data as OutboxRow]);
  return c.json(row, 200);
});

// ---------------------------------------------------------------------------
// POST /comms/outbox/{id}/complete — ADR-0007 atomicity point (transport)
// ---------------------------------------------------------------------------

commsApp.openapi(completeSend, async (c) => {
  requireTransport(c);
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  await assertOutboxInAccount(c, accountId, id);
  const { data: interactionId, error } = await sb.rpc('complete_send', {
    p_outbox_id: id,
    p_provider: body.provider,
    p_provider_sid: body.provider_sid,
    p_rfc822_message_id: body.rfc822_message_id ?? null,
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
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  await assertOutboxInAccount(c, accountId, id);
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
  const { accountId, id } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  await assertOutboxInAccount(c, accountId, id);
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
  // Bound email addresses and reply tokens are stored lowercased; the token is
  // the routing key and the from-address is the sender-verification input, so
  // both normalize identically (trim + lowercase). The sms path is unchanged.
  const toNumber = body.channel === 'email' ? body.to_number.trim().toLowerCase() : body.to_number;
  const fromAddress = body.channel === 'email' ? body.from_address.trim().toLowerCase() : body.from_address;
  // Email header fields are email-only: reject them on sms/voice up front so
  // an sms capture can never smuggle a Message-ID into the dedupe space.
  if (body.channel !== 'email') {
    const emailOnly = ['subject', 'rfc822_message_id', 'in_reply_to', 'references', 'auth_results'] as const;
    for (const f of emailOnly) {
      if (body[f] !== undefined) {
        throw new ApiError(400, 'invalid_request', `${f} is only valid on email captures`, {
          fieldErrors: { [f]: ['only valid when channel=email'] },
        });
      }
    }
  }
  const { data, error } = await sb.rpc('capture_inbound', {
    p_account_id: accountId,
    p_provider: body.provider,
    p_provider_msg_id: body.provider_msg_id,
    p_to_number: toNumber,
    p_from_address: fromAddress,
    p_channel: body.channel,
    p_body: body.body ?? null,
    p_media: body.media ?? null,
    p_received_at: body.received_at,
    p_cc: body.cc ?? null,
    p_subject: body.subject ?? null,
    p_rfc822_message_id: body.rfc822_message_id ?? null,
    p_in_reply_to: body.in_reply_to ?? null,
    p_references: body.references ?? null,
    p_auth_results: body.auth_results ?? null,
  });
  if (error) throw commDbError(error);
  const result = (data as {
    disposition: 'matched' | 'orphan' | 'opted_out' | 'sender_mismatch' | 'duplicate';
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
// POST /comms/inbound-persona — persona capture (transport)
// ---------------------------------------------------------------------------

commsApp.openapi(capturePersonaInbound, async (c) => {
  requireTransport(c);
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // The persona mints thread tokens on the cold-create path, so the account
  // must still carry a branded receiving domain (it did at resolve time; a
  // branding change since then surfaces here as a retryable conflict).
  const { data: account, error: acctErr } = await sb
    .from('accounts')
    .select('email_subdomain')
    .eq('id', accountId)
    .maybeSingle();
  if (acctErr) throw commDbError(acctErr);
  const replyDomain = brandedReplyDomain(
    (account?.email_subdomain ?? null) as string | null,
    loadEnv().EMAIL_PLATFORM_PARENT_DOMAIN,
  );
  if (replyDomain === null) {
    throw new ApiError(409, 'conflict', 'the account has no branded receiving domain (persona is not configured)');
  }

  const lower = (a: string): string => a.trim().toLowerCase();
  const fromAddress = lower(body.from_address);
  const { data, error } = await sb.rpc('capture_persona_inbound', {
    p_account_id: accountId,
    p_provider: body.provider,
    p_provider_msg_id: body.provider_msg_id,
    p_persona_address: lower(body.persona_address),
    p_from_address: fromAddress,
    p_from_display_name: body.from_display_name ?? null,
    p_to_addresses: body.to_addresses.map(lower),
    p_cc_addresses: body.cc_addresses.map(lower),
    p_subject: body.subject ?? null,
    p_body: body.body ?? null,
    p_media: body.media ?? null,
    p_rfc822_message_id: body.rfc822_message_id ?? null,
    p_in_reply_to: body.in_reply_to ?? null,
    p_references: body.references ?? null,
    p_spf: body.auth_results.spf,
    p_dkim: body.auth_results.dkim,
    p_dmarc: body.auth_results.dmarc,
    p_received_at: body.received_at,
    p_reply_domain: replyDomain,
  });
  if (error) throw commDbError(error);
  const result = (data as {
    disposition: 'matched' | 'triaged' | 'duplicate' | 'opted_out' | 'cc_journaled';
    interaction_id: string | null;
    thread_id: string | null;
    participant_id: string | null;
    unmatched_id: string | null;
  }[])[0];
  if (!result) throw new ApiError(500, 'internal_error', 'capture returned no result');

  // Friendly front door: the ack is for STRANGERS only. A first-touch unknown
  // sender gets ONE ack — only on provider-verified mail (DMARC), rate-capped
  // inside. A recognized landlord (e.g. CCing about a counterparty core doesn't
  // know) or a self-addressed persona loop must NEVER receive the tenant-
  // oriented receipt. Fire-and-forget so ack latency/failures never couple to
  // capture.
  if (
    result.disposition === 'triaged' &&
    body.auth_results.dmarc === 'pass' &&
    fromAddress !== lower(body.persona_address)
  ) {
    const { data: landlordIdentity, error: identityErr } = await sb
      .from('channel_identities')
      .select('id')
      .eq('account_id', accountId)
      .eq('channel', 'email')
      .eq('party_type', 'landlord_user')
      .eq('address', fromAddress)
      .maybeSingle();
    // Fail closed: an identity-read failure must never cause a mis-targeted
    // email, and a recognized landlord identity is never a stranger.
    if (!identityErr && !landlordIdentity) {
      queuePersonaAck(accountId, fromAddress);
    }
  }

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
      unmatched_id: result.unmatched_id,
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// POST /comms/evidence — archive the verbatim signed webhook (transport)
// ---------------------------------------------------------------------------

const HOLD_COLS = 'account_id, active, reason, set_by, set_at, released_at';

commsApp.openapi(captureEvidence, async (c) => {
  requireTransport(c);
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');

  // The schema's regex admits only base64 alphabet; reject ragged length here
  // (Buffer.from silently drops trailing garbage, which would make the hash a
  // function of something other than what the caller sent).
  if (body.raw_body_b64.length % 4 !== 0) {
    throw new ApiError(400, 'invalid_request', 'raw_body_b64 is not valid base64', {
      fieldErrors: { raw_body_b64: ['not valid base64 (length not a multiple of 4)'] },
    });
  }
  const bytes = Buffer.from(body.raw_body_b64, 'base64');
  if (bytes.byteLength === 0) {
    throw new ApiError(400, 'invalid_request', 'raw_body_b64 decodes to zero bytes', {
      fieldErrors: { raw_body_b64: ['empty body'] },
    });
  }
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new ApiError(
      400,
      'invalid_request',
      `evidence body exceeds max size (${bytes.byteLength} > ${MAX_EVIDENCE_BYTES} bytes)`,
    );
  }

  // Row first, then bytes: record_inbound_provenance is idempotent and
  // first-hash-wins, so the upload below only ever writes bytes whose hash
  // the audited row has already pinned (a crashed upload heals on retry; a
  // conflicting body 409s here and never touches storage).
  const sha256 = evidenceSha256(bytes);
  const { data, error } = await getSb(c).rpc('record_inbound_provenance', {
    p_account_id: accountId,
    p_provider: body.provider,
    p_provider_msg_id: body.provider_msg_id,
    p_body_sha256: sha256,
    p_signature: body.signature ?? null,
    p_signature_timestamp: body.signature_timestamp ?? null,
    p_storage_path: evidenceStoragePath(accountId, sha256),
    p_received_at: body.received_at,
  });
  if (error) throw commDbError(error);
  const row = data as z.infer<typeof CommInboundProvenance>;

  await storeEvidenceBytes(accountId, bytes);
  return c.json(row, 200);
});

// ---------------------------------------------------------------------------
// GET/PUT /comms/legal-hold — destruction gate (read: member; write: manager)
// ---------------------------------------------------------------------------

const NO_HOLD = (accountId: string): z.infer<typeof AccountLegalHold> => ({
  account_id: accountId,
  active: false,
  reason: null,
  set_by: null,
  set_at: null,
  released_at: null,
});

commsApp.openapi(getLegalHold, async (c) => {
  const { accountId } = c.req.valid('param');
  const { data, error } = await getSb(c)
    .from('account_legal_holds')
    .select(HOLD_COLS)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw commDbError(error);
  return c.json((data as z.infer<typeof AccountLegalHold> | null) ?? NO_HOLD(accountId), 200);
});

commsApp.openapi(setLegalHold, async (c) => {
  requireManager(c);
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const nowIso = new Date().toISOString();

  if (body.active) {
    const { data, error } = await sb
      .from('account_legal_holds')
      .upsert(
        {
          account_id: accountId,
          active: true,
          reason: body.reason ?? null,
          set_by: c.get('auth').userId,
          set_at: nowIso,
          released_at: null,
          updated_at: nowIso,
        },
        { onConflict: 'account_id' },
      )
      .select(HOLD_COLS)
      .single();
    if (error) throw commDbError(error);
    return c.json(data as z.infer<typeof AccountLegalHold>, 200);
  }

  // Release. Idempotent: releasing an account that never held returns the
  // default state without minting a row that records a release of nothing.
  const { data, error } = await sb
    .from('account_legal_holds')
    .update({ active: false, released_at: nowIso, updated_at: nowIso })
    .eq('account_id', accountId)
    .select(HOLD_COLS)
    .maybeSingle();
  if (error) throw commDbError(error);
  return c.json((data as z.infer<typeof AccountLegalHold> | null) ?? NO_HOLD(accountId), 200);
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
    .select(THREAD_COLS)
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (thErr) throw commDbError(thErr);
  if (!thread) throw new ApiError(404, 'not_found', 'not found');

  const participants = (await loadParticipants(c, accountId, [id])).get(id) ?? [];

  // Account-level From display name, injected on the detail read (the transport
  // renders it). One extra indexed read; not on list/THREAD_COLS.
  const { data: account, error: acctErr } = await sb
    .from('accounts')
    .select('sender_display_name')
    .eq('id', accountId)
    .maybeSingle();
  if (acctErr) throw commDbError(acctErr);

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
  const casts = await loadInteractionParticipants(sb, accountId, msgRows.map((m) => String(m.id)));
  const messages = msgRows.map((m) => ({
    ...withResolvedAuthorship(m as { author_type?: string | null; actor: string }),
    relay_legs: legs.get(String(m.id)) ?? [],
    participants: casts.get(String(m.id)) ?? [],
  }));

  return c.json(
    {
      ...(thread as z.infer<typeof CommThread>),
      participants,
      bindings: (bindings ?? []) as z.infer<typeof CommThreadBinding>[],
      messages,
      messages_next_cursor: messagesNext,
      sender_display_name: (account?.sender_display_name ?? null) as string | null,
    } as z.infer<typeof CommThreadDetail>,
    200,
  );
});

commsApp.openapi(createThread, async (c) => {
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
        throw new ApiError(400, 'invalid_request', 'agent participants are not part of a group MMS thread');
      }
    }
  }

  // An email thread relays natively between human inboxes (tenant/vendor +
  // landlord); the agent transport is not a party to it.
  if (isEmail) {
    for (const p of body.participants) {
      if (p.party_type === 'agent') {
        throw new ApiError(400, 'invalid_request', 'agent participants are not part of an email thread');
      }
    }
  }

  const counterparties = body.participants.filter(
    (p) => p.party_type === 'tenant' || p.party_type === 'vendor',
  );
  if (counterparties.length === 0) {
    throw new ApiError(400, 'invalid_request', 'a thread needs at least one tenant or vendor participant');
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
      throw new ApiError(400, 'invalid_request', 'email thread participant addresses must be distinct');
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
      throw new ApiError(400, 'invalid_request', 'a group thread needs at least 2 member addresses');
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
      throw new ApiError(409, 'conflict', `the account has no active platform number with ${body.channel} capability`);
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
      ? number!.number + '>' + [...new Set(addresses)].filter((a) => a !== number!.number).sort().join('|')
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
      throw new ApiError(409, 'conflict', 'an identical active group thread already exists on this platform number');
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
        sender_display_name: senderDisplayName,
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
      throw new ApiError(409, 'conflict', 'the group thread needs at least 2 actively-bound members');
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
        channel: thread.channel,
        to_address: t.participant_address,
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
      })),
    )
    .select('*');
  if (error) throw commDbError(error);
  return c.json({ data: (rows ?? []) as OutboxRow[] }, 201);
});

// ---------------------------------------------------------------------------
// POST /comms/threads/{threadId}/bindings/{bindingId}/rebind (landlord)
// ---------------------------------------------------------------------------

commsApp.openapi(rebindBinding, async (c) => {
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
    throw new ApiError(400, 'invalid_request', 'only email bindings can be rebound (sms routes by platform number)');
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
    const { error: idErr } = await sb
      .from('channel_identities')
      .upsert(
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
    .maybeSingle();
  if (error) throw commDbError(error);
  // Lost a concurrent-revoke race (the status='active' filter matched zero
  // rows): stay replay-friendly — re-read and return the already-revoked row
  // rather than surfacing a spurious 500 from a single-row expectation.
  if (!revoked) {
    const { data: current, error: reErr } = await sb
      .from('comm_policies')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (reErr) throw commDbError(reErr);
    if (!current) throw new ApiError(404, 'not_found', 'not found');
    return c.json(current as z.infer<typeof CommPolicy>, 200);
  }

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

// ---------------------------------------------------------------------------
// GET /comms/resolve-reply-address — transport token directory lookup (E2-A2)
// ---------------------------------------------------------------------------
// Two-layer fencing, both uniform-404:
//   1. RLS: the binding read runs as the caller, so only bindings in accounts
//      the caller is a MEMBER of are visible at all — a token belonging to an
//      account this transport does not serve resolves to nothing.
//   2. Role: the caller must hold role='agent' in the resolved binding's
//      account (the self-only account_members SELECT policy makes this the
//      caller's own membership row). A landlord probing their own account's
//      tokens gets the same 404 as an unknown token — no oracle anywhere.

commsApp.openapi(resolveReplyAddress, async (c) => {
  const { address } = c.req.valid('query');
  const sb = getSb(c);

  const { data: binding, error } = await sb
    .from('thread_channel_bindings')
    .select('account_id, thread_id, participant_id')
    .eq('reply_address', address.trim().toLowerCase())
    .eq('channel', 'email')
    .eq('active', true)
    .maybeSingle();
  if (error) throw commDbError(error);
  if (!binding) throw new ApiError(404, 'not_found', 'not found');

  const { data: membership, error: mErr } = await sb
    .from('account_members')
    .select('role')
    .eq('account_id', binding.account_id)
    .is('deleted_at', null)
    .maybeSingle();
  if (mErr) throw commDbError(mErr);
  if (!membership || membership.role !== 'agent') {
    throw new ApiError(404, 'not_found', 'not found');
  }

  return c.json(
    {
      account_id: binding.account_id as string,
      thread_id: binding.thread_id as string,
      participant_id: binding.participant_id as string,
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// GET /comms/resolve-persona-address — persona directory lookup
// ---------------------------------------------------------------------------
// Same two-layer uniform-404 fencing as resolve-reply-address above:
//   1. RLS: the accounts read runs as the caller (member SELECT policy), so a
//      persona belonging to an account this transport does not serve resolves
//      to nothing.
//   2. Role: the caller must hold role='agent' in the resolved account.
// The persona is branded-subdomain-only: the address must decompose as
// <local>@<label>.<EMAIL_PLATFORM_PARENT_DOMAIN>. With the parent env unset
// nothing can resolve — uniform 404, not 503, so probes learn nothing about
// platform configuration.

commsApp.openapi(resolvePersonaAddress, async (c) => {
  const { address } = c.req.valid('query');
  const sb = getSb(c);
  const parent = loadEnv().EMAIL_PLATFORM_PARENT_DOMAIN?.toLowerCase() ?? null;

  const canonical = address.trim().toLowerCase();
  const at = canonical.lastIndexOf('@');
  const local = at > 0 ? canonical.slice(0, at) : '';
  const domain = at > 0 ? canonical.slice(at + 1) : '';
  // The domain must be exactly one label under the platform parent.
  const label =
    parent !== null && domain.endsWith('.' + parent)
      ? domain.slice(0, domain.length - parent.length - 1)
      : '';
  if (local === '' || label === '' || label.includes('.')) {
    throw new ApiError(404, 'not_found', 'not found');
  }

  const { data: account, error } = await sb
    .from('accounts')
    .select('id')
    .eq('email_subdomain', label)
    .eq('persona_local_part', local)
    .maybeSingle();
  if (error) throw commDbError(error);
  if (!account) throw new ApiError(404, 'not_found', 'not found');

  const { data: membership, error: mErr } = await sb
    .from('account_members')
    .select('role')
    .eq('account_id', account.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (mErr) throw commDbError(mErr);
  if (!membership || membership.role !== 'agent') {
    throw new ApiError(404, 'not_found', 'not found');
  }

  return c.json({ account_id: account.id as string }, 200);
});
