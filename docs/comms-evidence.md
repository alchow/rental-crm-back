# Comms evidence archive — transport contract (EV-A / EV-B)

Audience: the transport driver (landlord-agent repo) and whoever operates it.
Core side: migrations `20260703000003` (participants cast + attestation) and
`20260703000004` (provenance + legal holds), endpoints in
`api/src/routes/comms.ts`, blob store in `api/src/admin/evidence.ts`.

## Why this exists

The communications journal records what the transport *told* core a provider
delivered. Verification of the provider's webhook signature happens at the
transport's edge and the signed original is then discarded — so, before this
work, nothing carrier-attested survived, and the only per-delivery recipient
record (`inbound_raw.payload`, itself a parameter echo) was pruned after 90
days. In a dispute that left two gaps:

1. **Self-containment** — an inbound journal row didn't say who the message
   was addressed to. Now every comms-journaled row carries a frozen **cast**
   (`interaction_participants`, one row per person-per-role:
   `sender`/`recipient`/`cc` on the wire, `attendee` in person), written by
   `capture_inbound` / `complete_send` in the same transaction as the journal
   row. Each cast row keeps the three layers of truth SEPARATE so they can be
   examined independently: `address` (the wire fact as the transport reported
   it), `party_id` (OUR resolution of who that address was, frozen at capture
   time), `label` (display-name snapshot — later renames never rewrite
   history). The cast is member-readable and hard insert-only: client-role
   INSERT/UPDATE/DELETE are revoked at the DB, so post-hoc tampering is
   denied, not merely audited. The legacy `party_*` single slot stays
   populated as the derived headline ("filed under"), which classify
   corrections may fill — **evidence and discovery queries run on the cast,
   never the headline**, with one chain-aware caveat: a `classify`
   correction currently records its resolved attribution in the correction
   row's party fields, not as a cast row (minting cast rows from classify is
   a tracked follow-up). Until then, an exhaustive per-person sweep should
   union the cast with classify corrections' `party_id`.
2. **Independent verifiability** — "our software wrote its own evidence" is a
   real cross-examination line. Now the verbatim signed webhook is archived
   and hash-anchored into the per-account audit chain, so anyone can
   re-verify the provider signature against the provider's published public
   key — without trusting this codebase. On top of that, every journal row
   states its trust tier in **`attestation`**: `provider_verified` (a
   carrier-confirmed transmission — stampable ONLY inside the verified comms
   write paths, enforced by a DB gate on the transaction-local
   `comm.verified_write` setting, so no other writer — member, agent, or
   service job — can forge the tier), `attested` (a human's account of an
   off-platform event, e.g. a logged phone call or in-person meeting),
   `imported` (bulk import), `null` (STRICTLY legacy: a DB default fills
   `attested`/`imported` on every new communication/note that doesn't state
   a tier, so a null tier can only mean "journaled before the column
   existed"). Attestation is immutable once written. Outbound casts are
   copied from a recipient snapshot frozen at INTENT time
   (`comm_outbox.recipient_snapshot`, trigger-stamped, immutable) — an
   identity edited while a send sits queued can never rewrite who the send
   is recorded as reaching. Note the two axes are independent:
   an AI-authored send (`author_type='agent'`) can be `provider_verified`,
   and a `provider_verified` email can still carry a `sender` cast row of
   `party_type='unknown'` (sender_mismatch) — trust of the wire and certainty
   of identity are different questions with different fields.

## What the driver MUST do per inbound webhook

Order matters: **verify → archive → process.**

1. **Verify the provider signature** on the raw request body, exactly as
   today. Reject failures; never archive or capture an unverified payload.
   - Telnyx: Ed25519 over `<telnyx-timestamp>|<raw_body>`, headers
     `telnyx-signature-ed25519` (base64) + `telnyx-timestamp`, public key
     published in the Telnyx portal/docs.
2. **Archive the verbatim body** — the EXACT bytes received, before any
   parsing or re-serialization (a re-encoded JSON body will not re-verify):

   ```
   POST /v1/accounts/{accountId}/comms/evidence      (agent principal)
   {
     "provider":            "telnyx",
     "provider_msg_id":     "<the id you will pass to /comms/inbound>",
     "raw_body_b64":        "<base64 of the exact request body bytes>",
     "signature":           "<telnyx-signature-ed25519 header value>",
     "signature_timestamp": "<telnyx-timestamp header value>",
     "received_at":         "<ISO 8601>"
   }
   ```

   - Core computes the sha256 server-side, records the audit-anchored
     `inbound_provenance` row, and stores the bytes at
     `comm-evidence/<account>/<sha256>.bin`.
   - Idempotent on `provider_msg_id`: same body → 200 with the original row
     (and the upload heals a previously crashed attempt); **different body →
     409** — first archived claim wins, never a silent overwrite.
   - Max 5 MiB decoded. Media (MMS photo bytes) is NOT this endpoint's job —
     media persistence is a tracked follow-up.
   - Failure handling: archive failures must be retried from a durable queue
     but must NOT block step 3 — losing a provenance blob is bad, dropping a
     tenant's message is worse. Alert on a queue that doesn't drain.
3. **Process as today**: `POST /comms/inbound` (`capture_inbound`), then any
   relay legs. No changes to that call — the cast and the attestation stamp
   are derived server-side from the fields it already carries (and, for
   outbound, from the FROZEN intent — the transport reports only
   `{provider, provider_sid}` and cannot influence who a send is recorded as
   reaching).

For unsigned email providers, omit `signature`/`signature_timestamp` — the
body still gets hash-anchoring (weaker: integrity from archive time, no
carrier attestation). Prefer providers whose inbound webhooks are signed, and
record DKIM/SPF verdicts inside the payload where available.

## Retention & legal holds (ops)

- `inbound_provenance` rows are **never deleted** (the `provider_msg_id`
  subpoena handle and the chained hash survive indefinitely).
- Blobs are removed by the retention janitor once past
  `COMM_EVIDENCE_RETENTION_DAYS` (default 2555 ≈ 7 years — the outer edge of
  US written-lease limitation periods). Each removal stamps `purged_at`,
  which the audit trigger records: destruction is an audited event.
- The evidence-retention janitor is scheduled in `render.yaml` as
  `evidence-retention`; the same command remains safe to run manually:

  ```
  pnpm --filter ./api retention:evidence
  ```

- The raw-capture prune runs through the `maintenance-janitors` Render cron
  (`pnpm --filter ./api janitors:maintenance`), alongside the other SQL
  janitors.
- **Legal hold**: `PUT /v1/accounts/{id}/comms/legal-hold {"active": true,
  "reason": "..."}` (owner/manager; the agent principal is denied — a
  transport that could release a hold could re-enable destruction). While
  active, BOTH the evidence janitor and `prune_inbound_raw` skip the account.
  Set it the moment litigation is reasonably anticipated (demand letter,
  filed case, notice of claim) — FRCP 37(e)'s safe harbor covers routine
  good-faith destruction only up to that point.

## Verifying an archived webhook later (dispute playbook)

1. Fetch the provenance row (member `GET` via PostgREST/SDK or export
   tooling): `provider_msg_id`, `body_sha256`, `signature`,
   `signature_timestamp`, `storage_path`.
2. Fetch the blob from `comm-evidence` (service tier / export tooling) and
   check `sha256(blob) == body_sha256`.
3. Check the row's insert event in the `events` hash chain
   (`verify_chain(account_id)` still green ⇒ the hash was recorded at
   capture time and not edited since).
4. Re-verify the provider signature over
   `<signature_timestamp>|<blob bytes>` against the provider's published
   public key (Telnyx: Ed25519).
5. Correlate with the journal row via `external_ref == provider_msg_id`; the
   row's **cast** (`interaction_participants`) states the addressed set of
   that delivery — each recipient as wire address + frozen identity
   resolution + name snapshot — and its `attestation` states the tier
   (`provider_verified` here, backed by steps 2–4). For "every interaction
   involving <person>" questions, query the cast by
   `(account_id, party_type, party_id)` — it is indexed for exactly that —
   NOT the single-slot `party_*` headline, which is a display/filing field.

Steps 2–4 need nothing from this codebase — that independence is the point.
