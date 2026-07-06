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

## Phase 2 — RFC822 headers + `duplicate` disposition (pending)

## Phase 3 — persona capture: known senders + auto-ack (pending)

## Phase 4 — CC journal-only capture (pending)
