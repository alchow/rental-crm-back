# Persona email — core ↔ transport contract

Accumulating contract notes for the persona-address feature ("Riley"), one
section per shipped core phase. Audience: the transport (landlord-agent repo).

## Standing rules

- **Unrecognized disposition ⇒ do not relay.** Future phases add capture
  disposition values; a transport that sees a disposition it does not know
  must journal nothing further and relay nothing (fail-safe forward compat).
- Tokens (`t-<32hex>@…`) remain the relay-leg routing mechanism, resolved via
  `GET /v1/comms/resolve-reply-address` exactly as today. The persona address
  is an ADDITIONAL receiving surface, never a replacement.
- Deploy ordering: core ships first; the transport starts routing persona
  mail only after the corresponding core endpoint exists in prod.

## Phase 1 — persona identity + resolution (shipped with migration 20260707000001)

**What exists**

- Accounts may carry `persona_local_part` alongside the existing branding
  fields. `GET/PATCH /v1/accounts/{accountId}/email-branding` now reads/writes
  it (owner/manager write) and the response adds two fields:
  - `persona_local_part: string | null`
  - `persona_address: string | null` — computed
    `<local>@<email_subdomain>.<EMAIL_PLATFORM_PARENT_DOMAIN>`; non-null only
    when the local part, the branded subdomain, AND the platform parent env
    are all set. **The persona is branded-subdomain-only** — nothing on the
    shared `EMAIL_REPLY_DOMAIN` ever resolves as a persona.
- `GET /v1/comms/resolve-persona-address?address=<full address>` — the
  transport's cold-inbound directory lookup. Same posture as
  `resolve-reply-address`: mounted outside `/accounts/*`, authenticated with
  the transport's normal per-account session, RLS + agent-role fenced,
  **uniform 404** for unknown local parts, unknown subdomains, foreign
  domains, multi-label subdomains, non-persona accounts, and accounts the
  caller does not transport. 200 body: `{ "account_id": "<uuid>" }`.
  Matching is trim + lowercase on the full address.
- `sender_display_name` now DEFAULTS to the account name at signup and has
  been backfilled for existing accounts — the transport's
  `"<display name>" <t-…@domain>` From rendering no longer needs its bare-hex
  fallback for typical accounts (keep the fallback; the value is still
  nullable).

**What the transport should do with it (routing sketch)**

```
inbound rcpt <addr>:
  local starts with 't-'  → resolve-reply-address → existing token capture
  else                    → resolve-persona-address
                              404 → not ours / drop per current policy
                              200 → HOLD until Phase 3 (no persona capture
                                    endpoint exists yet — do not call
                                    /comms/inbound with persona mail; it
                                    would only ever produce orphans)
```

**Namespace guarantee**: persona local parts can never start with `t-`
(DB CHECK), so the `t-` prefix test above is a safe discriminator forever.

## Phase 2 — RFC822 headers + `duplicate` disposition (shipped with migration 20260707000002)

**What exists**

- `POST /accounts/{id}/comms/inbound` accepts five NEW optional email-only
  fields (a 400 on any other channel): `subject`, `rfc822_message_id`,
  `in_reply_to`, `references[]`, and
  `auth_results {spf, dkim, dmarc}` (RFC 7601 verdict enums). All ride into
  the raw capture; the normalized Message-ID also lands on the journal row.
  Message-IDs are normalized trim + strip-one-`<>` + lowercase server-side.
- **New capture disposition `duplicate`**: the token resolved AND this
  email's own Message-ID already journaled into the SAME thread — the second
  delivery door of one send. Nothing new is written;
  `interaction_id/thread_id/participant` point at the ORIGINAL row. Treat as
  success-no-op; relay nothing. (Reminder of the standing rule: relay
  nothing on ANY unrecognized disposition.)
- `POST /accounts/{id}/comms/outbox/{id}/complete` accepts optional
  `rfc822_message_id` — the Message-ID the provider stamped on the SENT
  mail. It is recorded on the outbox row (`rfc822_message_id` in reads) and
  the journal entry.
- Outbox reads (`GET .../comms/outbox`, `GET .../comms/outbox/{id}`) expose
  `relay_source_rfc822_message_id` on email relay legs: the Message-ID of
  the inbound original the leg relays.

**What the transport should do with it**

- Pass `rfc822_message_id`, `subject`, `in_reply_to`, `references`, and the
  provider's auth verdicts on every email capture (phases 3–4 gate
  attribution and auto-acks on the verdicts — captures without them will be
  treated as unauthenticated).
- Report the sent Message-ID on every email `complete`.
- When rendering an email relay leg, set `In-Reply-To:
  <relay_source_rfc822_message_id>` and append it to `References` — relayed
  conversations then thread natively in recipients' mail clients.

## Phase 3 — persona capture: known senders + auto-ack (shipped with migration 20260708000001)

**What exists**

- `POST /v1/accounts/{accountId}/comms/inbound-persona` (transport-only) —
  capture for mail addressed to the persona. Body mirrors token capture plus:
  `persona_address`, `from_display_name?`, `to_addresses[]`, `cc_addresses[]`,
  and **`auth_results` is REQUIRED** (sender identity is the routing key, so
  attribution is DMARC-gated; a capture without verdicts is treated as
  unauthenticated). Same `provider_msg_id` idempotency space as token capture.
- Dispositions (standing rule still applies — relay nothing on anything
  unrecognized):
  - `matched` — sender resolved to a known tenant/vendor AND DMARC passed;
    journaled into their active email thread. When none existed, the thread
    was **created atomically**: counterparty token minted under the branded
    domain (their FUTURE replies ride the token path), landlord participant =
    the account owner (bound only if an email identity is on file — in-app
    reply works regardless). **Relay onward like any thread inbound**
    (`approval_ref='thread:<id>'` relay legs).
  - `triaged` — unknown sender, or a claimed-known sender that failed DMARC.
    Raw-tier captured; nothing journaled; **relay nothing**. Phase 6 adds the
    visible triage queue; `unmatched_id` stays null until then.
  - `duplicate` — this email's Message-ID already journaled into the resolved
    thread (the token door landed first). Success-no-op; relay nothing.
  - `opted_out` — journaled; relay nothing.
  - `cc_journaled` — reserved for phase 4.
- **Auto-ack**: a `triaged` capture from an unknown sender with DMARC pass
  queues at most ONE `system:persona_ack` email intent per sender per day
  (and ≤20/account/day) — the transport dispatches it like any other system
  send. Nothing for the transport to do at capture time; the intent shows up
  in the normal outbox scan.

**Routing update (supersedes the phase-1 HOLD)**

```
inbound rcpt <addr>:
  local starts with 't-'  → resolve-reply-address → POST /comms/inbound
  else                    → resolve-persona-address
                              404 → not ours / drop per current policy
                              200 → POST /accounts/{id}/comms/inbound-persona
                                    (relay ONLY on 'matched')
```

## Phase 4 — CC journal-only capture (shipped with migration 20260708000002)

**What exists**

- `POST /comms/inbound-persona` now recognizes the account's OWN landlord as
  the sender (their email identity + **DMARC pass** — a landlord From that
  fails DMARC is triaged, never attributed). The mail is journaled
  **outbound, landlord-authored** into the conversation matched by a To/CC
  address bound in an active email thread; when no thread exists but a To/CC
  address resolves to a known tenant/vendor, the thread is created
  outbound-cold (the landlord opened the conversation from their own inbox;
  they are bound with their own address + a minted token). Unknown
  counterparties → `triaged`.
- **Disposition `cc_journaled`: journal-only. Relay NOTHING** — both humans
  already have the mail; re-sending would duplicate the conversation.
- The reply-all two-door is closed in both orders: one email arriving via a
  reply token AND via the persona CC produces one journal row + one
  `duplicate`.

**What the transport should do with it**

Nothing new mechanically — same endpoint, same rule: relay only on
`matched`. The practical upshot for rendering/UX: landlords can be told
"CC riley@… from your own inbox and it lands in the file."

## Phase 5 — mismatch hygiene (no migration; FE/landlord-facing)

- `GET /accounts/{id}/interactions?party_type=unspecified` is the
  unresolved-sender queue (sender_mismatch captures awaiting a human
  classify); `direction` filter added alongside.
- `POST /accounts/{id}/comms/threads/{threadId}/bindings/{bindingId}/rebind
  {address}` (owner|manager, email bindings only): after a human confirms a
  mismatch was really the participant on a new address, rebinding stops every
  FUTURE reply from mismatching. Reply token untouched; the address is
  learned into `channel_identities` (so persona capture recognizes it too).
- Transport impact: none — capture verification just starts passing for the
  rebound address.

## Phase 6 — unknown-sender triage (shipped with migration 20260709000001)

- `triaged` persona captures now land in a durable, member-visible store
  (`comm_unmatched_inbound`) carrying their own copy of the message — they
  outlive the raw-tier prune. `unmatched_id` in the persona capture response
  is now real (and stable across replays).
- `reason` distinguishes `unknown_sender` from `auth_failed` (a RECOGNIZED
  tenant/vendor/landlord identity whose mail failed DMARC — the suspicious
  kind).
- Landlord surface (owner|manager): `GET /accounts/{id}/comms/unmatched`
  (queue, status filter), `GET …/unmatched/{id}` (detail + read-time
  suggestions: exact contact-email hits, trigram name matches),
  `POST …/unmatched/{id}/link {party_type, party_id}` (journals the stored
  original into the party's thread — created atomically if needed;
  `provider_verified` when the stored DMARC passed, else `attested`; learns
  the address so future mail auto-resolves), `POST …/unmatched/{id}/dismiss`.
- Transport impact: none beyond reading `unmatched_id` if useful for
  logging. A linked sender's future mail starts resolving as `matched`.

## Phase 7 — attachment ingestion (shipped with migration 20260709000002)

- After a capture returns `matched` / `cc_journaled`, the transport may store
  the original attachment bytes:
  `POST /accounts/{id}/interactions/{interactionId}/attachments`
  `{filename, content_type, data_b64}` — ≤10 MiB decoded per file, ≤10 per
  message, base64. Idempotent per (interaction, content-hash): retries return
  the existing row. **Skip on `duplicate`** (the original already carries
  them) and on `triaged` (nothing journaled; the triage row keeps the
  provider media URLs).
- Only provider-verified capture rows accept attachments (400 otherwise);
  the endpoint is transport-only (403).
- Members list via GET on the same path and stream bytes from
  `…/attachments/{attachmentId}/download` (forced Content-Disposition,
  nosniff, CSP sandbox).
- Storage: private `comm-attachments` bucket, no authenticated policies —
  bytes move only through the API; paths are content-addressed per message.

## Known limitations (reviewed 2026-07-06; deliberate, tracked as follow-ups)

- **Address book is first-writer-wins.** Every learning upsert
  (capture, rebind, triage link) uses on-conflict-do-nothing: an address that
  already maps to a different party keeps its OLD mapping. Consequence: on a
  genuinely shared address (a couple sharing one inbox), cold/persona mail
  attributes to whichever party was learned first, even after a human rebinds
  or links the other party. Moving to last-human-wins is a cross-cutting
  decision (it must not let a capture path overwrite a human's mapping).
- **Shared `tenants.emails` fallback picks the oldest tenant** (stable
  `created_at` order) and the learning step makes that sticky. Same root as
  above.
- **A landlord CC addressed to multiple known recipients journals into ONE
  thread** (most-recently-active binding wins); the other recipients' threads
  carry no record of that mail. Multi-thread fan-out of a single CC capture is
  a deliberate follow-up, not v1.
- **The CC arm requires `landlord_user` email identities.** They are created
  when a landlord makes an email thread with an explicit address, on rebind,
  or by ops. Until an account has one, that landlord's CCs land in triage
  (they are never acked — the stranger ack suppresses recognized landlords
  and, defensively, anyone until identities exist means: unknown senders only).
- **Attachment filenames are printable-ASCII only** (rejected otherwise):
  the value is rendered into download response headers. The transport should
  transliterate or generically rename non-ASCII filenames before upload.
- **`channel_identities.address` is trusted-lowercase, not enforced.** All
  in-repo writers normalize; a future writer that stores mixed case would
  silently miss the exact-hit lookups. A normalization trigger is a candidate
  hardening.
