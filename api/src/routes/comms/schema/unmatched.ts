import { z } from '@hono/zod-openapi';
import type { CommOutbox } from './outbox';
import type { CommThreadParticipant } from './inbound';
import { CommInboundMedia } from './inbound';

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
