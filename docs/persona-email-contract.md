# Persona email — core ↔ transport contract (routing v2)

The deterministic contract for mail addressed to an account persona
(`riley@<subdomain>.<EMAIL_PLATFORM_PARENT_DOMAIN>`). Audience: the transport
(landlord-agent repo) and anyone asking "which account, party, and thread
received this evidence — and why?".

This document describes the CURRENT behavior, implemented by the persona
routing v2 migration stack:

- `db/supabase/migrations/20260722000001_persona_routing_v2.sql` — the
  canonical parent-first classifier, `parent_sender_mismatch`, snapshot
  precedence flip, the Message-ID lookup index, the drift guard.
- `db/supabase/migrations/20260722000002_channel_identity_claims.sql` — the
  multi-claim identity model (sources, scopes, supersession) and the one
  resolver every reader uses.
- `db/supabase/migrations/20260722000003_comm_outbox_party_intent.sql` —
  explicit caller party intent for bare sends (`to_party`, `cc_parties`,
  `resolution_source='caller_intent'`).
- `db/supabase/migrations/20260723000001_persona_routing_v2_cleanup.sql` —
  drops the dormant pre-v2 classifier, makes `complete_send` degrade
  gracefully on a duplicate Message-ID, and (when data is clean) enforces
  per-account outbound Message-ID uniqueness.
- `db/supabase/migrations/20260723000003_unverified_journal_tier.sql` — the
  unverified-journal tier: non-DMARC mail from exactly one KNOWN tenant/vendor
  claimant journals as `journaled_unverified` (attestation `'unverified'`)
  instead of triaging; adds the owner/manager retract / confirm-sender
  follow-ups.
- `db/supabase/migrations/20260723000004_cc_relayed_reply_all_completion.sql`
  — the reply-all completion split: a DMARC-pass landlord cc capture whose
  resolved counterparty is NOT on the inbound To/Cc becomes `cc_relayed`
  (deliver, not just journal); counterparty present stays `cc_journaled`.
- `db/supabase/migrations/20260723000005_drop_gmail_alias_canonicalization.sql`
  — drops `_comm_canonical_email_address`: every address comparison in the
  persona door is plain `lower(btrim(…))`, so a different spelling of the same
  mailbox is a different correspondent. This file also holds the CURRENT
  `capture_persona_inbound` body (the digest-check target below).

Pre-v2 phase-by-phase history lives in git; this file no longer accumulates
phases.

## Standing rules

- **Relay only on `matched` and `cc_relayed`.** Never relay on
  `cc_journaled`, `triaged`, `duplicate`, `opted_out`, `journaled_unverified`,
  or any disposition the transport does not recognize (fail-safe forward
  compatibility).

  *Amended 2026-07-18 (PRODUCT DECISION, on record).* Previously the rule was
  "relay only on `matched`", which made a landlord's plain persona reply a
  black hole: the reply journaled (`cc_journaled`) but the tenant/vendor never
  received it. `cc_relayed` is the same landlord cc capture where the resolved
  counterparty was NOT physically on the email's To/Cc (exact lowercase
  compare, no alias folding) — the transport must DELIVER the
  journaled reply to the counterparty, in the delivery shape of "The
  `cc_relayed` delivery shape" below (To counterparty, Cc the landlord's
  authoritative email, From "«landlord» via «persona»"). Duplication is
  accepted: a repeat beats
  a black hole, so the To/Cc check is a discriminator, not a safety-critical
  suppressor — a counterparty addressed under a different spelling of the same
  mailbox reads as ABSENT and is delivered to again. Trust basis: a
  DMARC-verified landlord sender replying within
  their own thread — strictly stronger than the retired token door, which
  relayed on token possession alone.

  **Deploy order for this change — INVERTED from the usual core-first rule:
  the AGENT deploys FIRST** (with a bundled spec enum that accepts
  `cc_relayed`); core's migration + merge follow. The agent AJV-validates
  every capture response against its bundled spec enum, and an unknown
  disposition value THROWS: the webhook 500s, SNS redelivers, and the frozen
  replay returns `cc_relayed` again — a poison loop, NOT a graceful
  journal-only fallback. (The "relay nothing on an unrecognized disposition"
  rule above governs the transport's RELAY decision; it does not make its
  response validation tolerant.) The reverse direction is safe: an agent
  that already accepts the value but predates the relay logic simply
  journals during the transition window.
- Tokens (`t-<32hex>@…`) remain the thread-leg routing mechanism, resolved via
  `GET /v1/comms/resolve-reply-address`. The persona address is an ADDITIONAL
  receiving surface, never a replacement. Persona local parts can never start
  with `t-` (DB CHECK), so the prefix test is a safe discriminator forever.
- The transport resolves the account with
  `GET /v1/comms/resolve-persona-address?address=…` (uniform 404 for anything
  that is not this caller's persona surface) and then posts to
  `POST /v1/accounts/{id}/comms/inbound-persona` (transport-only;
  `auth_results` REQUIRED). Core owns all party/thread policy; the agent must
  not maintain its own account/subdomain map.
- No LLM runs anywhere on this path. Routing is deterministic SQL.
- Deploy ordering: core ships first; the transport starts depending on new
  behavior only after it exists in prod. EXCEPTION: a change that widens a
  response enum the agent AJV-validates (e.g. `cc_relayed`) ships agent-first
  — see the amendment above.

## Relay legs to a landlord rebuild the group thread

The relay leg of a tenant/vendor-initiated mail delivers the message to the
landlord AND rebuilds the group so the landlord can reply-all — the mirror of
the `cc_relayed` delivery shape (next section), and consistent with the
original inspection welcome, which already sends `To: tenant, Cc: landlord`.
Three consequences on `POST …/comms/outbox` for an EMAIL relay leg
(`relay_of_interaction_id` set) whose target participant is a `landlord_user`:

- **Authoritative recipient.** The leg dials the account's owner/manager
  email for that participant's user (auth.users via account_members —
  `resolve_relay_landlord_recipient`), NOT the thread binding: bindings are
  minted from `channel_identities` at thread creation, and a bad claim once
  froze the TENANT's own address as the landlord leg (the tenant was relayed
  their own message back). The binding / explicit `to_address` is only the
  fallback when no authoritative email exists. The chosen address freezes at
  intent time exactly as before.
- **Author Cc (group rebuild).** When the relayed interaction is a
  tenant/vendor-authored inbound, the author's real address (the source
  interaction's `role='sender'` cast address, which capture froze from the
  verified From) is added as a visible Cc, server-derived exactly like the
  `cc_relayed` arm. The landlord's next reply-all then reaches the author
  directly, so the conversation is a self-sustaining group thread rather than a
  per-hop relay treadmill. Best-effort: an unresolvable/malformed author
  address is dropped, never blocks the leg; the opt-out trigger scrubs a
  registered Cc at INSERT.
- **CC-overlap suppression.** When the relayed interaction's cast already
  contains the resolved address (exact lowercase compare — a different
  spelling of the same mailbox does NOT suppress the leg), the
  landlord already physically received the mail — e.g. as a visible Cc on a
  reply-all. The intent is refused with 409
  `error.code='relay_already_delivered'` and NO row is created. The transport
  must treat this as "already satisfied", never as a retryable failure. An
  aliased Cc reads as absent, so the leg goes out anyway: a
  repeat beats a black hole. This is what makes the group topology loop-safe:
  once both parties are on the thread, each reply-all reaches the other
  directly and the persona relay becomes a no-op (a tenant reply-all carrying
  the landlord hits this 409; a landlord reply-all carrying the tenant lands
  `cc_journaled`).

Sms relays and all non-relay sends are byte-identical. A tenant/vendor-target
relay leg is byte-identical too UNLESS it delivers a landlord's persona reply
— that one case gains a server-derived Cc, next section.

## The `cc_relayed` delivery shape (the system completes the reply-all)

PRODUCT DECISION (user, 2026-07-18, final). The relay leg that delivers a
landlord's `cc_relayed` reply is not a bare forward — it re-assembles the
group email the landlord failed to send:

```text
To:   the counterparty (the thread binding, as any 1:1 leg)
Cc:   the landlord's AUTHORITATIVE email
From: "«landlord name» via «persona name»" <persona address>
```

Why: every delivery REBUILDS the group thread. The counterparty's next
reply-all then includes the landlord directly — a self-healing topology that
converges on the visible-CC model — and the landlord's Cc copy doubles as a
delivery receipt ("your reply went out"). Loop-safe by the capture split
itself: that next reply-all carries the landlord on To/Cc, so its persona
capture lands `cc_journaled` (relay nothing).

Mechanism (all server-side; the transport stays thin):

- **The Cc is derived by core at leg creation**, inside
  `POST …/comms/outbox`: an EMAIL relay leg targeting a tenant/vendor whose
  relayed interaction is the capture cc arm's landlord-authored outbound
  (actor `system:comm-persona-cc`) resolves the author's authoritative
  owner/manager email through `resolve_relay_landlord_recipient` (the PR 7
  judge; the frozen sender-cast address is the fallback when no authoritative
  email exists). The RPC's `already_delivered` verdict is deliberately
  ignored here: the landlord AUTHORED this mail — their address in the source
  cast is the sender leg, not evidence of a delivered copy, and the Cc is a
  deliberate receipt. `cc_addresses` on thread legs remains caller-rejected
  (one authority per arm); this derivation and the `is_cc` participant arm
  merge and dedupe.
- **Opt-out scrub still applies**: the derived Cc rides the same
  `cc_addresses` machinery, so a register hit is SCRUBBED at INSERT (the
  counterparty's delivery still goes; the landlord just is not copied), and
  the frozen `recipient_snapshot` records the Cc through the existing
  `role='cc'` identity freeze — the record never claims a copy that was
  suppressed.
- **Best-effort by design**: an unresolvable Cc never blocks the delivery —
  the black hole is the failure mode this arm exists to prevent.
- **From display**: the outbox reads (dispatch scan, single-row read, and
  the delivery claim) derive `relay_source_sender_label` ONLY for email
  relay legs whose source is the capture cc arm's landlord-authored journal
  row (actor `system:comm-persona-cc` — the cc_relayed delivery source): the
  relayed original's frozen sender-cast label, server-side. The transport
  renders `"«relay_source_sender_label» via «persona name»"` over the
  persona address, reusing its existing branded-From identity for the
  persona half; a null label falls back to the plain persona From. The label
  is deliberately null on every other relay leg — an ordinary `matched`
  relay already leads with the "«label» wrote:" body attribution, so a
  via-From there would double-attribute the author. Threading headers are
  unchanged (`relay_source_rfc822_message_id` still derives for ALL email
  relay legs).
- **The capture response carries nothing extra** — interaction_id/thread_id/
  participant already identify the leg to create; Cc and From-label are
  core-frozen/derived afterwards.

## The ordered routing algorithm

One canonical coordinator (`capture_persona_inbound`) does, in order:

```text
authorize agent principal for the account
  -> advisory lock on provider_msg_id
  -> frozen replay return (same provider_msg_id + account => original result)
  -> raw-first evidence insert (inbound_raw)
  -> parent probe (always runs; recorded even on triage)
  -> authentication gate
  -> parent-first party resolution, else no-parent fallback
  -> same-thread RFC Message-ID duplicate check
  -> journal/triage atomically
  -> freeze routing_decision (version 2) on the raw row
```

### 1. Authentication — and the unverified-journal tier

`auth_results.dmarc = 'pass'` is still the sender-TRUST bar, but failing it no
longer always triages. PRODUCT DECISION (on record; legal rationale: notice
law makes RECEIPT the operative fact, a triage queue nobody processes is a
liability, and receipt ≠ attribution): a failed-DMARC capture runs the SAME
account-scope candidate resolution the no-parent arm uses
(`_comm_resolve_persona_candidates`), plus — when a unique parent exists — the
parent ladder's tier-1 `thread_participant` match (a parent-named recipient is
a candidate even when the address carries no live claim). Then:

- **exactly one tenant/vendor candidate** → the receipt is JOURNALED into that
  party's conversation (find-or-create exactly as the matched path; parent
  context honored when the sender is a physical parent recipient) with
  `attestation = 'unverified'` — the claimed-not-asserted marker. The
  disposition is **`journaled_unverified`**, the frozen reason
  `unverified_single_claim`, and the sender cast label is the ADDRESS, not a
  display name. Invariants: NO identity learning, no stranger ack, no relay
  (relay only on `matched`), the same-thread rfc822 dedupe still applies, and
  replays stay frozen;
- **exactly one landlord_user candidate** → triage `auth_failed` (an
  unverified OUTBOUND-authored journal row would put words in the landlord's
  mouth);
- **zero candidates** → triage `auth_failed` when a valid parent reference
  recognizes the mail, else `unknown_sender`;
- **multiple candidates** → triage `identity_conflict`.

A matching `In-Reply-To` never rescues failed DMARC into a TRUSTED route
(reply headers can be copied or forged), and failed auth never learns an
identity. `auth_failed` is therefore unreachable for tenant/vendor
single-claim senders; the enum value remains for historical rows.

An unverified row has two human follow-ups (owner|manager, below): retract it
with a reason, or confirm the sender — it is never trusted on its own.

### 2. Parent probe

Normalize `In-Reply-To` and `References` (trim, strip one `<>`, lowercase) and
match against `comm_outbox` rows that are, all at once:

```text
same account
channel = 'email'
status in ('sent', 'delivered')
non-null normalized rfc822_message_id
```

`In-Reply-To` is probed first; `References` newest-to-oldest only when it
found nothing. One matching row is a `unique` parent. Several rows for one
Message-ID is a collision → `identity_conflict` triage, never "pick the
newest" (the cleanup migration's unique index makes this state impossible for
new sends where historical data was clean). Cross-account rows and
non-completed (queued/failed) rows are invisible to the probe. Legacy parents
that were completed without a Message-ID simply never match — such replies use
the no-parent fallback.

### 3. Parent-first resolution (a unique parent exists)

The authenticated sender is compared against the parent's PHYSICAL recipients
(`to_address` + `cc_addresses`) — exact lowercase equality, and nothing else:
no provider-specific alias folding, so a different spelling of the same
mailbox is a different sender. A landlord who replies from an address other
than the one recorded on their account is therefore triaged
(`parent_sender_mismatch`) rather than attributed to the human whose address
it resembles. `To` vs `Cc` is a message role, never a party type.

Each matched recipient address resolves to its intended party through named
tiers, top wins:

```text
thread_participant   active binding on the parent's thread
tenancy_member /     authoritative context RECOMPUTED from the physical
account_member       parent row (its tenancy's members; the account's
                     owner/manager users)
verified_identity    the claims resolver's winner at an authoritative tier
                     (human_link / authoritative_record / verified_claim)
snapshot_frozen      an authoritatively-sourced frozen snapshot entry
                     (resolution_source in thread_participant / tenancy_member
                     / account_member / human_link / authoritative_record /
                     caller_intent)
snapshot_learned     any other frozen snapshot entry (belief, not authority)
learned_identity     live provider_learned / legacy claims
```

Outcomes:

- sender = exactly one tenant/vendor parent recipient → **`matched`**
  (inbound, tenant/vendor-authored, relayed);
- sender = exactly one landlord parent recipient → the landlord cc arm
  (outbound, landlord-authored, journaled into the parent's PRIMARY
  recipient's conversation), split on whether that counterparty is physically
  on THIS email's To/Cc (exact lowercase compare; an alias of the same mailbox
  does NOT count as present): present → **`cc_journaled`**
  (relay nothing — they received it directly); absent → **`cc_relayed`** (the
  transport delivers the journaled reply to the counterparty — the system
  completes the landlord's reply-all). A null counterparty address (parent
  `to_address` null; party resolved from the frozen snapshot alone) skips the
  split and stays `cc_journaled` — never a relay toward a null recipient;
- sender matches no parent recipient → triage **`parent_sender_mismatch`**
  (never rerouted into the sender's own unrelated thread);
- matches resolve to more than one distinct party, or a leg's claims tie at
  their winning tier → triage **`identity_conflict`**;
- matches resolve to no party at all → triage `unknown_sender`.

A live claim that names a DIFFERENT party than the route selected does not
stop an authoritative-tier route — it is RECORDED in the routing decision
(`conflict_party_*`) for audited repair. If the route's own tier is merely
learned, the contradiction fails closed as `identity_conflict`.

Thread selection with a parent:

- the parent's active thread is reused only while the selected party is still
  a participant;
- a closed thread or departed participant is never silently reopened: a new
  active thread is created, constrained to the parent's exact tenancy
  (`parent_outbox_id` stays in the routing decision);
- a thread-less parent with a tenancy finds-or-creates the party's active
  thread IN that tenancy — "the party's most recent tenancy" inference never
  runs against explicit parent context;
- a tenant whose parent named a conversation but left no usable tenancy is
  triaged, not guessed.

### 4. No-parent fallback

Only when no valid parent reference exists:

1. All non-superseded, scope-applicable claims for the authenticated sender
   (the claims resolver, below) — exactly one party proceeds; zero →
   `unknown_sender`; several at the winning tier → `identity_conflict`.
2. A landlord sender enters the CC arm: the conversation comes from a To/Cc
   address bound in an active email thread, else a To/Cc address resolving
   (uniquely, tenant/vendor only) to a known counterparty — outbound-cold
   thread creation — else triage. The reply-all completion split runs here
   too, but because the counterparty is resolved FROM the inbound To/Cc the
   outcome is always `cc_journaled` in this arm (`cc_relayed` is reachable
   only via the parent path).
3. A tenant/vendor sender journals into their active thread, creating one
   (single active/holdover tenancy for tenants) when none exists.

### 5. Duplicate and opt-out

Token door and persona door of one email (same normalized RFC Message-ID, same
thread) produce ONE journal row; the second door returns `duplicate` pointing
at the original. Opted-out known senders still journal (`opted_out`; relay
nothing).

## Identity claims (`channel_identities`)

One row per CLAIM: unique
`(account_id, channel, address, party_type, party_id, scope_type, scope_id)
NULLS NOT DISTINCT`. Addresses are trigger-normalized (lower/trim) at the
door.

- **Sources** (closed vocabulary): `human_link`, `thread_rebind`,
  `parent_recipient`, `provider_learned`, `authoritative_import`, `legacy`.
- **Scopes**: account-wide is stored as `scope_type NULL / scope_id NULL` (the
  only representation); `('tenancy', <id>)` and `('thread', <id>)` claims
  apply only inside that conversation scope.
- **Supersession**: `superseded_at` is a stamp, never a delete — superseded
  claims are invisible to routing but remain queryable evidence.

**The one resolver** (`_comm_resolve_identity_claims`) returns ALL distinct
parties at the single highest non-empty tier over live, scope-applicable
claims plus the authoritative record books:

```text
human_link            a human said so
authoritative_record  tenants.emails match / owner-manager member email match
verified_claim        verified_at set, or source in thread_rebind /
                      parent_recipient / authoritative_import
provider_learned      capture-time learning
legacy                pre-claims rows (unknown provenance)
```

One winner routes; several winners at the same tier is a conflict the caller
fails closed on. Every consumer — persona capture, outbox snapshots, thread
creation, triage link, `complete_send`'s legacy fallback — reads through this
resolver.

Write rules:

- **Capture learns additively only** (`source='provider_learned'`): landlord
  aliases account-wide, counterparty learning scoped to the resolved tenancy
  when there is one. Capture never supersedes or overwrites anything; a
  contradiction rides the routing decision instead.
- **A human link takes effect**: `link_unmatched_inbound` writes an
  account-wide `human_link` claim, supersedes differing learned/legacy claims,
  and upgrades/revives a same-party row. A differing LIVE human claim fails
  the link loudly (409 `conflicting human claim…`) — two humans who disagree
  are reconciled by humans, not write order.

## Worked example — use case A (the incident this stack fixed)

```text
Parent outbox: bare send, To tenant@example.test, Cc owner@example.test,
               tenancy A, completed with Message-ID <m1>
Bad claim:     channel_identities says tenant@example.test -> landlord_user
Inbound:       From tenant@example.test, DMARC pass, In-Reply-To <m1>

riley@acme.mail.example.com
  -> subdomain "acme" resolves the account (resolve-persona-address)
  -> DMARC pass: the From is trusted
  -> <m1> matches exactly one sent outbox row of the account: unique parent
  -> sender equals the parent's physical To recipient
  -> that address resolves through the ladder: tenancy A's member list names
     the TENANT (tier tenancy_member) — the learned landlord claim is
     outranked, recorded as conflict_party_*, and left untouched
  -> the parent is thread-less but names tenancy A: the tenant's active
     thread in tenancy A is found or created
  -> disposition 'matched'; the interaction is tenant-authored, filed under
     tenancy A; the transport relays it
```

## Dispositions and triage reasons

Capture dispositions (relay ONLY on `matched` and `cc_relayed`):
`matched` | `cc_journaled` | `cc_relayed` | `triaged` | `duplicate` |
`opted_out` | `journaled_unverified`.

`comm_unmatched_inbound.reason` (all but `unknown_sender` require human
review):

- `unknown_sender` — nobody recognizes the address (or a known party has no
  safely selectable conversation).
- `auth_failed` — DMARC failed and something still recognizes the claim: a
  single landlord_user claimant, or a valid parent reference with no
  resolvable candidate. (Unreachable for tenant/vendor single-claim senders
  since the unverified-journal tier — those journal instead; the value stays
  for historical rows.)
- `identity_conflict` — the evidence contradicts itself: a Message-ID
  collision across parents, a dual-role address with no selecting context,
  claims tied at their winning tier, or a learned-tier route contradicted by
  another live claim.
- `parent_sender_mismatch` — an authenticated sender replied to a real
  outbound message they were never a recipient of.

Triage rows land in the member-visible queue
(`GET/POST …/comms/unmatched[…]`; link/dismiss as before). `unmatched_id` is
stable across replays.

## Unverified journal rows — retract / confirm (owner|manager)

A `journaled_unverified` row is a receipt whose sender is claimed, never
asserted. Two account-pinned follow-ups exist (both 403 for viewers and the
agent principal; both only apply to `attestation='unverified'` rows — anything
else is 409):

- `POST /v1/accounts/{id}/interactions/{iid}/retract` with body
  `{ "reason": "<1..500 chars>" }` — soft-deletes the row (`deleted_at` /
  `deleted_by` / `deleted_reason` stamped, `updated_at` advances with it), so
  it disappears from every default timeline read. The `inbound_raw` receipt is
  untouched — the evidence that the mail ARRIVED survives the retraction.
  Evidence exports keep the row but render ONLY its retraction marker
  (attestation, who, when, reason — never the repudiated body): silent
  omission from a legal bundle would look like spoliation.
  Retracting an already-retracted row is 409; a foreign/missing id is 404.
- `POST /v1/accounts/{id}/interactions/{iid}/confirm-sender` (no body) — "yes,
  that really was them": flips attestation to `'attested'` (stamping
  `confirmed_by`/`confirmed_at`; the ONLY legal attestation transition,
  enforced at the trigger) and writes an account-wide `human_link` claim for
  (sender address → the row's party) with the SAME semantics as
  `link_unmatched_inbound` — differing learned/legacy claims are superseded, a
  differing live human claim fails the whole call with 409 `conflicting human
  claim…`. Future mail from that address then resolves normally (DMARC pass →
  `matched`). Confirming a retracted row is 404.

## The frozen `routing_decision` (v2)

Every fresh capture freezes its decision onto `inbound_raw.payload
.routing_decision` — identifiers and enums only, never message bodies, and
never mutated on replay:

```json
{
  "version": 2,
  "account_source": "persona_subdomain",
  "auth": "pass",
  "parent_match": "none | unique | multiple",
  "parent_outbox_id": "uuid | null",
  "party_source": "tier name | null",
  "candidate_count": 1,
  "selected_party_type": "tenant | vendor | landlord_user | null",
  "selected_party_id": "uuid | null",
  "selected_thread_id": "uuid | null",
  "selected_tenancy_id": "uuid | null",
  "disposition": "matched | cc_journaled | cc_relayed | triaged | duplicate | opted_out | journaled_unverified",
  "reason": "parent_unique_match | sender_unique_claim | cc_counterparty_not_addressed | unverified_single_claim | duplicate_rfc822_message_id | <triage reason>",
  "conflict_party_type": "…| null",
  "conflict_party_id": "uuid | null"
}
```

`party_source` carries the winning tier name — a parent-ladder tier
(`thread_participant`, `tenancy_member`, `account_member`,
`verified_identity`, `snapshot_frozen`, `snapshot_learned`,
`learned_identity`) on parent routes, or a resolver tier (`human_link`,
`authoritative_record`, `verified_claim`, `provider_learned`, `legacy`) on
no-parent routes.

## Outbox snapshot `resolution_source`

`_comm_outbox_snapshot_recipients` stamps every 1:1/cc snapshot entry with the
tier that resolved it (caller-supplied snapshots are always discarded):

```text
caller_intent         an explicit, independently VERIFIED to_party/cc_parties
                      hint (PR 3; an unverifiable hint fails the insert)
thread_participant    active binding on the intent's thread
tenancy_member        the intent's tenancy resolves the address to a tenant
account_member        the address is an owner/manager member's email
human_link | authoritative_record | verified_claim
                      | provider_learned | legacy
                      the claims resolver's winning tier (single winner only;
                      a tie freezes 'unknown')
unknown               nothing resolved the address
```

Parent routing trusts frozen entries whose source is authoritative
(`thread_participant`, `tenancy_member`, `account_member`, `human_link`,
`authoritative_record`, `caller_intent`) above learned ones; entries frozen
before v2 have no `resolution_source` and rank as learned belief.

Bare email sends may state what the caller already knows —
`to_party {party_type, party_id}` and
`cc_parties [{address, party_type, party_id}]`, pre-checked via
`check_outbox_party_intent` (stable field-scoped 422s) and independently
re-verified by the trigger before freezing.

## Outbound Message-ID integrity

- `POST …/outbox/{id}/complete` records the provider-stamped
  `rfc822_message_id` (normalized) on the outbox row and journal entry — this
  is what makes the row a findable parent. Report it on every email complete.
- Per-account uniqueness: completing a send whose Message-ID already lives on
  a DIFFERENT email row of the account stamps NULL instead (WARNING with both
  row ids; the completion itself never fails) — evidence stays on the first
  row. Where historical data was clean, the partial unique index
  `comm_outbox_email_msgid_uniq` enforces the invariant structurally.

## Deploy drift guard

- `select public.comm_persona_routing_version();` → `2` (authenticated
  callable) — the cheap "which routing generation is live?" probe after every
  deploy.
- Every fresh capture carries `routing_decision.version = 2`.
- For byte-level certainty, compare
  `md5(pg_get_functiondef('public.capture_persona_inbound(uuid,text,text,text,text,text,text[],text[],text,text,jsonb,text,text,text[],text,text,text,timestamptz,text)'::regprocedure))`
  in prod against a freshly-migrated local database. Do not trust the
  migration version row alone (that failure mode is why this guard exists).

## Current limitations (reviewed at v2 cleanup; deliberate)

- **A landlord CC addressed to multiple known recipients journals into ONE
  thread** (most-recently-active binding wins). Multi-thread fan-out of one CC
  capture remains a follow-up.
- **The human-link scope is account-wide** — the triage UI offers no scope
  picker yet, so a link on a genuinely shared inbox speaks for the address
  account-wide until scoped links ship.
- **Attachment filenames are printable-ASCII only** (rendered into download
  headers); the transport should transliterate or rename before upload.
- **Addresses compare exactly** (`lower(btrim(…))`, no alias folding —
  20260723000005). A correspondent who writes from a different spelling of the
  same mailbox (any `+tag`, or a Gmail dot variant) is a different
  correspondent: their mail triages instead of being attributed to the wrong
  human, and their presence on a To/Cc does not suppress a duplicate delivery.
  Both consequences are deliberate, not regressions.

Retired v1 limitations (no longer true): first-writer-wins address book and
silent no-op human links (claims model + supersession), oldest-tenant
`tenants.emails` fallback (account-unique tenant emails since 20260721000002 +
conflict-aware resolution), trusted-but-unenforced lowercase addresses
(normalization trigger), and the CC arm's hard dependency on pre-existing
`landlord_user` identities (owner/manager member emails now resolve at the
authoritative_record tier).
