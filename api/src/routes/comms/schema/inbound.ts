import { z } from '@hono/zod-openapi';
import { CommChannel, CommPartyType } from './outbox';

// ---------------------------------------------------------------------------
// Inbound capture
// ---------------------------------------------------------------------------

export const CommInboundMedia = z
  .object({
    url: z.string().min(1).max(2000),
    content_type: z.string().max(200).optional(),
  })
  .openapi('CommInboundMedia');

/** Provider-evaluated RFC 7601 verdicts. Core stores them with the raw capture
 *  and uses them to gate attribution and automatic replies. */
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
    received_at: z.string().datetime({ offset: true }),
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
    /** Sender display name used for cast-label fallback and triage suggestions. */
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
    received_at: z.string().datetime({ offset: true }),
  })
  .openapi('CapturePersonaInboundBody');

export const CapturePersonaInboundResponse = z
  .object({
    /** Transport action by disposition:
     *  matched -> relay; triaged/duplicate/opted_out/cc_journaled -> no relay;
     *  cc_relayed -> deliver a counterparty leg with
     *  relay_of_interaction_id=interaction_id;
     *  journaled_unverified -> no relay or ack; a human may confirm or retract.
     *  Forward compatibility: never relay an unrecognized disposition. */
    disposition: z.enum([
      'matched',
      'triaged',
      'duplicate',
      'opted_out',
      'cc_journaled',
      'cc_relayed',
      'journaled_unverified',
    ]),
    interaction_id: z.string().uuid().nullable(),
    thread_id: z.string().uuid().nullable(),
    participant: CommThreadParticipant.nullable(),
    /** Triage row ID for `triaged` captures; stable across replays, otherwise null. */
    unmatched_id: z.string().uuid().nullable(),
  })
  .openapi('CapturePersonaInboundResponse');

export const CaptureInboundResponse = z
  .object({
    /** Transport action by disposition:
     *  matched -> relay; matched_direct -> send the group echo with
     *  relay_of_interaction_id=interaction_id;
     *  orphan/opted_out/sender_mismatch/duplicate -> no relay.
     *  Forward compatibility: never relay an unrecognized disposition. */
    disposition: z.enum([
      'matched',
      'matched_direct',
      'orphan',
      'opted_out',
      'sender_mismatch',
      'duplicate',
    ]),
    interaction_id: z.string().uuid().nullable(),
    thread_id: z.string().uuid().nullable(),
    participant: CommThreadParticipant.nullable(),
  })
  .openapi('CaptureCommInboundResponse');

// ---------------------------------------------------------------------------
// Evidence archive — the carrier-signed webhook original, archived
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
    received_at: z.string().datetime({ offset: true }),
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
