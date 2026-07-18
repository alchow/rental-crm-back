import { z } from '@hono/zod-openapi';
import { Interaction } from '../../schemas/importable';

export const CommChannel = z.enum(['sms', 'email', 'voice']);
// Monotonic: queued -> sending -> sent -> delivered; failed/undeliverable
// terminal; needs_reconcile parks ambiguity for the documented manual
// procedure. Late or duplicate provider callbacks are ignored.
export const CommOutboxStatus = z.enum([
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
  'undeliverable',
  'needs_reconcile',
]);
export const CommThreadKind = z.enum(['bridged_tenant', 'vendor']);
export const CommThreadStatus = z.enum(['active', 'closed']);
// bridged = per-counterparty 1:1 legs relayed by core; group = one provider-
// native MMS group (our platform number + up to 7 member addresses, the
// landlord's phone included).
export const CommThreadMode = z.enum(['bridged', 'group']);
export const CommPartyType = z.enum(['tenant', 'landlord_user', 'vendor', 'agent']);
export const CommPolicyKind = z.enum(['rent_reminder', 'thread_autonomy', 'voice_autonomy']);
export const CommPolicyStatus = z.enum(['active', 'revoked']);

// tz-aware "do not disturb" window for policy-driven sends; times are local
// to `timezone` (IANA name), window may span midnight (start > end).
export const CommQuietHours = z
  .object({
    start: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .openapi({ example: '21:00' }),
    end: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .openapi({ example: '08:00' }),
    timezone: z.string().min(1).max(64).openapi({ example: 'America/Los_Angeles' }),
  })
  .openapi('CommQuietHours');

// ---------------------------------------------------------------------------
// Outbox — the mutable send intent/progress record (operational tier).
// Committed BEFORE any provider call; the immutable journal entry is appended
// only on confirmed send, in the same transaction that marks the row 'sent'.
// ---------------------------------------------------------------------------

export const CommOutbox = z
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
    /** Frozen visible-Cc set (email only), resolved at intent time from the
     *  thread's is_cc participants' bound email addresses — the transport adds
     *  these as Cc on the outbound mail so a flagged participant (the landlord)
     *  is copied on the conversation. Null when no participant is flagged (the
     *  default) or on non-email rows. Immutable once queued, like to_address. */
    cc_addresses: z.array(z.string()).nullable(),
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
          /** 'cc' on copied-party entries (landlord CC arm); absent on primary
           *  recipients and on rows frozen before the CC arm existed. */
          role: z.enum(['cc']).optional(),
          /** WHICH tier resolved this entry (persona routing v2):
           *  caller_intent (the caller stated the party via to_party/cc_parties
           *  and core re-verified it — PR 3), then thread_participant |
           *  tenancy_member | account_member (authoritative context), then the
           *  claims resolver's winning tier (human_link | authoritative_record |
           *  verified_claim | provider_learned | legacy — PR 2), then unknown.
           *  'learned_identity' appears on rows frozen by the PR 1 stamp.
           *  Absent on rows frozen before the stamp existed and on group-MMS
           *  snapshots. */
          resolution_source: z
            .enum([
              'caller_intent',
              'thread_participant',
              'tenancy_member',
              'account_member',
              'human_link',
              'authoritative_record',
              'verified_claim',
              'provider_learned',
              'legacy',
              'learned_identity',
              'unknown',
            ])
            .optional(),
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

export const CreateOutboxBody = z
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
    /** Explicit visible-Cc set for BARE (thread-less) email intents — e.g. the
     *  inspection-link welcome/reminder mail CC'ing the landlord's own inbox.
     *  Email-only (400 otherwise) and rejected on thread-bound creates (a
     *  thread leg's Cc derives from its is_cc participants instead — one
     *  authority per arm). Entries are email-format validated, lowercased,
     *  deduped, and the primary recipient is excluded; opt-out register
     *  entries are scrubbed at INSERT (DB trigger). Frozen verbatim into
     *  comm_outbox.cc_addresses. */
    cc_addresses: z.array(z.string().min(3).max(320)).min(1).max(5).optional(),
    /** Explicit PRIMARY-recipient party for a BARE (thread-less) email intent
     *  — the caller states what it already knows (persona routing v2 PR 3) so
     *  core need not re-derive the party from the To address. Bare email only
     *  (400 otherwise) and requires to_address. Core re-verifies independently
     *  before freezing: the party must belong to the account, a tenant must be
     *  a member of tenancy_id when supplied, and to_address must resolve to
     *  this party at an authoritative claim tier — otherwise 422. Frozen into
     *  the recipient snapshot as resolution_source='caller_intent'. */
    to_party: z
      .object({
        party_type: z.enum(['tenant', 'vendor']),
        party_id: z.string().uuid(),
      })
      .optional(),
    /** Explicit party for each visible Cc of a BARE email intent (e.g. the
     *  inspection-link mail CC'ing the landlord). Bare email only, requires
     *  cc_addresses, and every entry's address MUST equal (case-insensitive)
     *  one cc_addresses entry (400 otherwise). Each cc party must be an
     *  owner/manager account member whose address verifies the same way (422).
     *  One address claimed by two different parties is a 409 conflict. Frozen
     *  as resolution_source='caller_intent'. */
    cc_parties: z
      .array(
        z.object({
          address: z.string().min(3).max(320),
          party_type: z.literal('landlord_user'),
          party_id: z.string().uuid(),
        }),
      )
      .min(1)
      .max(5)
      .optional(),
    approval_ref: z.string().min(1).max(200),
    approved_by: z.string().uuid().optional(),
    not_before: z.string().datetime().optional(),
    /** Marks this intent as a RELAY leg of an inbound journal row (agent
     *  provenance `thread:<id>`). An email relay leg whose target participant
     *  is a landlord_user is a NOTIFICATION: it dials the account's
     *  authoritative owner/manager email (thread-binding fallback) and is
     *  refused with 409 relay_already_delivered when the relayed mail's cast
     *  already carries that address (canonical compare — the landlord received
     *  the original physically, e.g. as a visible Cc). */
    relay_of_interaction_id: z.string().uuid().optional(),
    template_id: z.string().min(1).max(200).optional(),
    /** Optional context: links the send (and, on completion, its journal row)
     *  to a tenancy / maintenance request so it appears in that entity's feed.
     *  Composite-FK validated to the account. */
    tenancy_id: z.string().uuid().optional(),
    maintenance_request_id: z.string().uuid().optional(),
  })
  .openapi('CreateCommOutboxBody');

export const OutboxListResponse = z
  .object({ data: z.array(CommOutbox), next_cursor: z.string().nullable() })
  .openapi('CommOutboxListResponse');

export const CompleteSendBody = z
  .object({
    provider: z.string().min(1).max(100),
    provider_sid: z.string().min(1).max(200),
    /** Email-only: the Message-ID the provider stamped on the SENT mail
     *  (angle brackets optional; normalized server-side). Recorded on the
     *  outbox row + journal entry so later replies/relays can cite it. */
    rfc822_message_id: z.string().min(3).max(998).optional(),
  })
  .openapi('CompleteCommSendBody');

export const CompleteSendResponse = z
  .object({
    /** The journal entry appended by the confirmed send. */
    interaction_id: z.string().uuid(),
    outbox: CommOutbox,
  })
  .openapi('CompleteCommSendResponse');

export const FailSendBody = z
  .object({
    error_code: z.string().min(1).max(100),
    detail: z.string().max(2000).optional(),
    /** true = the provider outcome is UNKNOWN (crash window / lost response):
     *  park the row in needs_reconcile for the manual procedure instead of
     *  marking it failed. */
    reconcile: z.boolean().optional(),
  })
  .openapi('FailCommSendBody');

export const DeliveryBody = z
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

export const CommInboundMedia = z
  .object({
    url: z.string().min(1).max(2000),
    content_type: z.string().max(200).optional(),
  })
  .openapi('CommInboundMedia');

/** Provider-evaluated email authentication verdicts (RFC 7601 vocabulary),
 *  passed through by the transport from the receiving provider's headers.
 *  Core stores them with the raw capture; later phases gate attribution and
 *  auto-replies on them. */
export const CommAuthResults = z
  .object({
    spf: z.enum(['pass', 'fail', 'neutral', 'none', 'softfail', 'temperror', 'permerror']),
    dkim: z.enum(['pass', 'fail', 'neutral', 'none', 'policy', 'temperror', 'permerror']),
    dmarc: z.enum(['pass', 'fail', 'none', 'temperror', 'permerror']),
  })
  .openapi('CommAuthResults');

export const CaptureInboundBody = z
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

export const CommThreadParticipant = z
  .object({
    id: z.string().uuid(),
    thread_id: z.string().uuid(),
    party_type: CommPartyType,
    party_id: z.string().uuid().nullable(),
    joined_at: z.string(),
    left_at: z.string().nullable(),
    /** Per-thread opt-in: this participant is added as a visible Cc on the
     *  thread's outbound email legs (the landlord CC arm) rather than reached
     *  only via a separate relayed copy. Default false. */
    is_cc: z.boolean(),
  })
  .openapi('CommThreadParticipant');

// ---------------------------------------------------------------------------
// Persona inbound capture — the cold-inbound front door (no reply token).
// Routing resolves the SENDER, not the recipient: the transport resolves the
// persona address to an account first (resolve-persona-address), then posts
// the mail here.
// ---------------------------------------------------------------------------

export const CapturePersonaInboundBody = z
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

export const CapturePersonaInboundResponse = z
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
     *  journaled_unverified: the mail failed DMARC but its From named exactly
     *  one KNOWN tenant/vendor — the receipt is journaled into that party's
     *  conversation with attestation='unverified' (claimed, never asserted).
     *  Nothing is learned, no ack is sent, and the transport must relay
     *  nothing. Owner/manager can later retract it (with a reason) or confirm
     *  the sender via the interactions retract / confirm-sender endpoints.
     *  Forward-compat rule: relay nothing on any unrecognized disposition. */
    disposition: z.enum([
      'matched',
      'triaged',
      'duplicate',
      'opted_out',
      'cc_journaled',
      'journaled_unverified',
    ]),
    interaction_id: z.string().uuid().nullable(),
    thread_id: z.string().uuid().nullable(),
    participant: CommThreadParticipant.nullable(),
    /** The triage row id once phase 6 lands; null until then. */
    unmatched_id: z.string().uuid().nullable(),
  })
  .openapi('CapturePersonaInboundResponse');

export const CaptureInboundResponse = z
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

export const CommEvidenceBody = z
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

export const CommInboundProvenance = z
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

export const AccountLegalHold = z
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

export const SetLegalHoldBody = z
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

export const CommOptOut = z
  .object({
    channel: CommChannel,
    address: z.string(),
    opted_out_at: z.string(),
    keyword: z.string().nullable(),
    source_ref: z.string().nullable(),
  })
  .openapi('CommOptOut');

export const CreateOptOutBody = z
  .object({
    channel: CommChannel,
    address: z.string().min(3).max(320),
    /** Normalized keyword that triggered the opt-out (STOP, UNSUBSCRIBE, ...). */
    keyword: z.string().min(1).max(50),
    /** Provider-side reference for the triggering message. */
    source_ref: z.string().min(1).max(200),
  })
  .openapi('CreateCommOptOutBody');

export const OptOutListResponse = z
  .object({ data: z.array(CommOptOut), next_cursor: z.string().nullable() })
  .openapi('CommOptOutListResponse');

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

// ---------------------------------------------------------------------------
// Policies — standing grants; creating one IS the approval act.
// ---------------------------------------------------------------------------

export const CommPolicy = z
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

export const CreatePolicyBody = z
  .object({
    policy_kind: CommPolicyKind,
    channel: CommChannel,
    template_id: z.string().min(1).max(200).optional(),
    params: z.record(z.unknown()).default({}),
    quiet_hours: CommQuietHours.optional(),
  })
  .openapi('CreateCommPolicyBody');

export const PolicyListResponse = z
  .object({ data: z.array(CommPolicy), next_cursor: z.string().nullable() })
  .openapi('CommPolicyListResponse');

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const AccountParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
});
export const AccountAndIdParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});

export const CommAttachment = z
  .object({
    id: z.string().uuid(),
    /** Sender-supplied display name ("lease.pdf"). */
    filename: z.string().nullable(),
    mime_type: z.string().nullable(),
    size_bytes: z.number().int().nullable(),
    /** sha256 (lowercase hex) of the stored bytes. */
    content_hash: z.string(),
    created_at: z.string(),
  })
  .openapi('CommAttachment');

// header-injection-adjacent: `filename` and `content_type` are rendered into
// the download response's content-disposition / content-type headers, and
// undici THROWS on a header value containing C0 controls or DEL — so a stored
// CR/LF/NUL would make the attachment permanently un-downloadable (500).
// Reject those bytes at ingest: `[ -~]` accepts only printable ASCII (0x20
// space … 0x7e tilde), which excludes every C0 control and DEL. (A literal
// control-char range would trip eslint no-control-regex.)
export const UploadCommAttachmentBody = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[ -~]+$/, 'must not contain control characters'),
    content_type: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[ -~]+$/, 'must not contain control characters'),
    /** The attachment bytes, base64. Max 10 MiB decoded; at most 10
     *  attachments per message. */
    data_b64: z
      .string()
      .min(1)
      .max(14_400_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .openapi('UploadCommAttachmentBody');

export const CommAttachmentListResponse = z
  .object({ data: z.array(CommAttachment) })
  .openapi('CommAttachmentListResponse');

export const InteractionAttachmentParams = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  interactionId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'interactionId', in: 'path' } }),
});

export const CommUnmatchedInbound = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    provider: z.string(),
    provider_msg_id: z.string(),
    rfc822_message_id: z.string().nullable(),
    persona_address: z.string(),
    from_address: z.string(),
    from_display_name: z.string().nullable(),
    to_addresses: z.array(z.string()),
    cc_addresses: z.array(z.string()),
    subject: z.string().nullable(),
    body: z.string().nullable(),
    media: z.array(CommInboundMedia),
    spf: z.string().nullable(),
    dkim: z.string().nullable(),
    dmarc: z.string().nullable(),
    /** unknown_sender: nobody recognizes the address. auth_failed: DMARC
     *  failed and something still recognizes the claim — a single
     *  landlord_user claimant, or a valid parent reference with no resolvable
     *  candidate. (Since the unverified-journal tier, a failed-DMARC mail
     *  whose From names exactly ONE known tenant/vendor no longer triages —
     *  it journals as 'journaled_unverified' — so auth_failed is unreachable
     *  for those senders; the value remains for historical rows.)
     *  identity_conflict: the sender's identity evidence contradicts itself
     *  (dual-role address with no selecting context, or an authenticated
     *  alias whose exact address is already bound to another party).
     *  parent_sender_mismatch: an authenticated sender replied to a real
     *  outbound message they were never a recipient of. All but
     *  unknown_sender require human review. */
    reason: z.enum([
      'unknown_sender',
      'auth_failed',
      'identity_conflict',
      'parent_sender_mismatch',
    ]),
    received_at: z.string(),
    status: z.enum(['pending', 'linked', 'dismissed']),
    resolved_by: z.string().uuid().nullable(),
    resolved_at: z.string().nullable(),
    linked_thread_id: z.string().uuid().nullable(),
    linked_interaction_id: z.string().uuid().nullable(),
    linked_party_type: z.string().nullable(),
    linked_party_id: z.string().uuid().nullable(),
    auto_acked_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('CommUnmatchedInbound');

/** A candidate identity for a pending triage row, computed at READ time (a
 *  tenant added after capture must still match). */
export const UnmatchedSuggestion = z
  .object({
    party_type: z.enum(['tenant', 'vendor']),
    party_id: z.string().uuid(),
    title: z.string(),
    subtitle: z.string().nullable(),
    /** email_exact: the sender address appears VERBATIM (case-sensitive) in
     *  the party's contact emails. address_match: trigram match of the sender
     *  address against the party's searchable text — catches case variants
     *  the verbatim probe misses (capture matching is case-insensitive, so
     *  these parties would auto-resolve on capture). name_match: trigram
     *  match of the From display name. */
    source: z.enum(['email_exact', 'address_match', 'name_match']),
  })
  .openapi('CommUnmatchedSuggestion');

export const UnmatchedListResponse = z
  .object({ data: z.array(CommUnmatchedInbound), next_cursor: z.string().nullable() })
  .openapi('CommUnmatchedListResponse');

export const UnmatchedDetailResponse = CommUnmatchedInbound.extend({
  suggestions: z.array(UnmatchedSuggestion),
}).openapi('CommUnmatchedDetailResponse');

export const LinkUnmatchedBody = z
  .object({
    party_type: z.enum(['tenant', 'vendor']),
    party_id: z.string().uuid(),
  })
  .openapi('LinkCommUnmatchedBody');

export const LinkUnmatchedResponse = z
  .object({
    thread_id: z.string().uuid(),
    interaction_id: z.string().uuid(),
  })
  .openapi('LinkCommUnmatchedResponse');

// ---------------------------------------------------------------------------
// Unverified-journal tier (20260723000003) — human follow-ups on a
// journaled_unverified row. Both endpoints are owner|manager, account-pinned.
// ---------------------------------------------------------------------------

export const RetractUnverifiedBody = z
  .object({
    /** Why the entry is being removed from the record (kept as evidence on
     *  the soft-deleted row; the raw receipt in inbound_raw is untouched). */
    reason: z.string().min(1).max(500),
  })
  .openapi('RetractUnverifiedInteractionBody');

export const RetractUnverifiedResponse = z
  .object({
    id: z.string().uuid(),
    deleted_at: z.string(),
    deleted_reason: z.string(),
  })
  .openapi('RetractUnverifiedInteractionResponse');

export const ConfirmSenderResponse = z
  .object({
    id: z.string().uuid(),
    /** The row's new trust tier: a human vouched for the claimed sender. */
    attestation: z.literal('attested'),
    party_type: z.enum(['tenant', 'vendor']),
    party_id: z.string().uuid(),
    /** The sender address now human-linked to the party (account-wide claim,
     *  link_unmatched_inbound semantics) — future mail from it resolves
     *  normally. */
    address: z.string(),
  })
  .openapi('ConfirmUnverifiedSenderResponse');

export const RebindBody = z
  .object({
    /** The counterparty's NEW address for this leg. Email bindings only. */
    address: z.string().min(3).max(320),
  })
  .openapi('RebindCommBindingBody');

export const ResolveReplyAddressResponse = z
  .object({
    account_id: z.string().uuid(),
    thread_id: z.string().uuid(),
    participant_id: z.string().uuid(),
  })
  .openapi('CommResolveReplyAddressResponse');

export const ResolvePersonaAddressResponse = z
  .object({
    account_id: z.string().uuid(),
  })
  .openapi('CommResolvePersonaAddressResponse');

export type OutboxRow = z.infer<typeof CommOutbox>;
export type ParticipantRow = z.infer<typeof CommThreadParticipant>;
