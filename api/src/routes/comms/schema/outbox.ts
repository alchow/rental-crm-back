import { z } from '@hono/zod-openapi';

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
     *  original carried no Message-ID; absent on non-relay rows. Attached on
     *  the dispatch scan, the single-row read, and the delivery (claim)
     *  response. */
    relay_source_rfc822_message_id: z.string().nullable().optional(),
    /** Derived, read-only (email relay legs): the frozen sender-cast label of
     *  the relayed original — SET ONLY when that original is the capture cc
     *  arm's landlord-authored journal row (a cc_relayed delivery). The
     *  transport renders the From display as
     *  "«this label» via «persona name»" over the persona address; when
     *  null, it renders the plain persona From. Deliberately null on every
     *  other relay leg: an ordinary matched relay already leads with the
     *  "«label» wrote:" body attribution, so a via-From there would
     *  double-attribute the author. Absent on non-relay rows. Attached on
     *  the dispatch scan, the single-row read, and the delivery (claim)
     *  response. */
    relay_source_sender_label: z.string().nullable().optional(),
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
     *  already carries that exact address (lowercase compare, no alias
     *  folding — the landlord received the original physically). */
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
