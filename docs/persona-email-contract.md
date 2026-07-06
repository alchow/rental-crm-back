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

## Phase 4 — CC journal-only capture (pending)
