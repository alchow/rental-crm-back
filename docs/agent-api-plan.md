# Agent-facing API: architecture & implementation plan (Group 1)

- **Historical note:** this plan records the June 12, 2026 single-agent design.
  ADR-0009 superseded the live identity model on June 13, 2026:
  `AGENT_USER_ID` is retired, and current agent classification comes from the
  account membership role `role='agent'`. Treat any `AGENT_USER_ID` setup
  language below as legacy design context, not current ops guidance.
- **Status:** EXECUTED 2026-06-12 — PRs 0–6 implemented and green on the full
  suite (migrations 20260616000001–04). NOT yet deployed: prod requires
  migrations pushed BEFORE the code deploy (the interactions insert path
  writes the new columns), plus env (`AGENT_USER_ID`, `TWILIO_*`,
  `PUBLIC_BASE_URL`), agent provisioning (docs/agent-runbook.md), janitor
  scheduling, and the real-credential smoke test. Open: reconcile
  `core-api-agent-extension.yaml` when the agent repo provides it; CTO
  product decision on what `approval_ref` points at (per-message vs
  standing approval).
- **Date:** 2026-06-12
- **Source:** external build request "Core API — Agent-Facing Changes (Group 1)";
  discovery findings and amendments accepted by CTO 2026-06-12
- **Decision records:** ADR-0006 (agent principal), ADR-0007 (send/record
  ordering), ADR-0008 (journal authorship capacity)
- **Companion docs to keep in sync:** `docs/api-guide.md` (CI gate
  `check:guide-drift`), `openapi/openapi.json` + `sdk/` (CI gate `check:drift`)

## 0. What this enables

A separate AI-agent service (different repo) becomes a first-class, auditable
API client of this system of record. The agent can: append a *restricted*
vocabulary of journal entries, send SMS to tenants/vendors **through** core
(send and record are inseparable), poll the journal losslessly, and read
ledger balances — all under an identity the evidence tier names honestly.

What it must never be able to do: write free-form prose into the journal
without explicit landlord approval, mutate or supersede history, send a
message twice for one intent, or appear in evidence as anything other than
`agent`.

---

## 1. Architecture overview

### 1.1 The two tiers (unchanged, load-bearing)

```
EVIDENCE TIER (immutable)            OPERATIONAL TIER (mutable state machines)
─────────────────────────            ─────────────────────────────────────────
interactions   append-only journal   message_outbox      send intent/progress
events         hash-chained audit    sms_opt_outs        carrier compliance
               of EVERY domain       twilio_inbound_raw  webhook capture +
               write (row snapshots)                     unmatched queue
                                     idempotency_keys    replay cache (exists)
```

Rule that makes everything below safe: **the chain hashes row *snapshots*
taken at write time** (`_emit_event()` stores `to_jsonb(NEW/OLD)`;
`verify_chain` re-hashes the *stored* snapshot, never the live row). Adding
columns therefore never invalidates historical verification, and every new
column is tamper-evident the moment it is written. See ADR-0008.

### 1.2 Principals after this work

| Principal | Auth | `actor` in chain | `author_type` on journal rows |
|---|---|---|---|
| Landlord user (PWA) | Supabase JWT | `user:<uuid>` | `landlord` |
| Tenant (intake link) | hashed token | `tenant:<token_id>` | `tenant` |
| Agent service | Supabase JWT of a **machine-owned service-account user**, membership role `agent` | `user:<agent-uuid>` | `agent` |
| Jobs/cron | service-role + `audit.actor` | `system:<job>` | `system` |

The agent is a real account member (ADR-0006): zero new auth code, RLS and
the idempotency layer work unchanged, and per-account scoping falls out of
membership rows instead of being deferred. `AGENT_USER_ID` (env, per
environment) is the single switch that classifies a request as the agent
principal.

### 1.3 Request flow for the agent

```
agent service ──JWT──▶ requireAuth ─▶ requireAccountMembership ─▶ resolvePrincipal
                                                                      │
              ┌───────────────────────────────────────────────────────┤
              ▼                          ▼                            ▼
   POST /interactions          POST /messages/sms            GET /events?after_seq=N
   (journal firewall:          (approval_ref required;       GET /tenancies/:id/ledger
    whitelist + schemas)        outbox → Twilio → journal)        (?as_of=date)
```

---

## 2. Workstream A — journal authorship capacity (Req 1)

### 2.1 Migration `2026xxxx_journal_authorship_capacity.sql`

One migration carries both the capacity columns and the agent-event
vocabulary (Workstream D's schema), so there is exactly one journal ALTER and
one mixed-era chain test.

```sql
alter table public.interactions
  add column author_type  text  check (author_type in ('landlord','tenant','agent','system')),
  add column approved_by  uuid  references public.users(id),
  add column approval_ref text  check (length(approval_ref) between 1 and 200),
  add column entry_type   text  check (entry_type in
    ('proposal_created','proposal_approved','proposal_rejected','step_executed')),
  add column external_ref text  check (length(external_ref) between 1 and 255);

-- kind/channel vocabulary: + 'agent_event' (sentinel pattern, same as 'note')
--   kind check    -> ('communication','note','agent_event')
--   channel check -> + 'agent_event'
--   (kind='agent_event') = (channel='agent_event')
--   agent_event shape: direction='none', party_type='none', party_id/label null
--   entry_type pairing: (entry_type is not null) = (kind='agent_event')

-- Evidence-grade invariants the DB enforces (not just the app):
--   1. agent-authored prose requires explicit approval:
--      check (not (kind='note' and author_type='agent')
--             or (approved_by is not null and approval_ref is not null))
--   2. agent_event bodies are bounded (no conversational payloads):
--      check (kind <> 'agent_event' or body is null or length(body) <= 1000)
```

**No backfill. No `schema_version`.** Legacy rows keep `author_type = null`;
the API resolves display authorship from the existing `actor` column
(`user:` → `landlord`, `tenant:` → `tenant`, `system*` → `system`). A blanket
backfill would write false history (intake rows are tenant-authored) and a
derived backfill would churn an events row per journal entry for zero
information gain — `actor` already is the source of truth. Rationale and
rejected options: ADR-0008.

`on_behalf_of_account_id` from the request is **dropped** (redundant with
`account_id`; reconcile with the agent repo's draft spec).

### 2.2 API changes

- `Interaction` response schema: `author_type` (always resolved, never null
  on the wire), `approved_by`, `approval_ref`, `entry_type`, `external_ref`
  nullable. List/get/create all emit them. Additive only.
- Create path: server stamps `author_type` from the resolved principal —
  never client-supplied. Landlord writes are byte-for-byte unchanged
  otherwise (test-pinned).
- Resolution helper lives in one module: `api/src/routes/_lib/authorship.ts`
  (`resolveAuthorType(row)`, `principalAuthorType(principal)`).

### 2.3 Evidence export

`api/src/admin/export-pdf.ts` already prints `actor=` per entry (line ~936).
Append capacity when present:
`authored by agent (approved by <user>, ref <approval_ref>)`. Delivery status
(Workstream E) renders as `delivered <ts> (Twilio <sid>)` on sent messages.

### 2.4 Mixed-era chain verification test (the Req 1 gate)

New `db/test/chain-mixed-era.test.ts` + fixture
`db/test/fixtures/pre_capacity_events.sql`:

1. Fixture inserts events rows **verbatim** (as table owner; triggers don't
   fire on `events`) whose payload snapshots were captured on the
   pre-migration schema — i.e., genuinely missing the new keys — seq 1..k.
2. Live test writes post-migration journal rows; `_emit_event` chains them at
   seq k+1.. on top of the fixture rows.
3. `verify_chain(account)` → `ok = true` over the mixed chain.
4. Tamper a v2 row's `payload->'after'->>'author_type'` → `ok = false` at
   that row (proves capacity fields are tamper-evident).
5. Restore → `ok = true`.

---

## 3. Workstream B — agent principal (Req 2)

Decision and trade-offs: **ADR-0006** (service-account user, not a static
bearer token).

- Migration: `account_members.role` check gains `'agent'`.
- Env: `AGENT_USER_ID` (uuid). Absent → no request can classify as agent
  (safe default in every environment).
- New middleware `api/src/middleware/principal.ts`, mounted right after
  `requireAccountMembership`: sets
  `c.set('principal', { type: 'agent' | 'user', userId })` by comparing
  `auth.userId` to `AGENT_USER_ID`. **The only place** this comparison may
  appear — firewall, sends, and authorship all read `c.get('principal')`.
- Provisioning runbook (`docs/agent-runbook.md`): create the auth user per
  environment (email `agent@<env>.internal`, strong secret in the secret
  manager), set `AGENT_USER_ID`, insert `account_members(role='agent')` per
  serviced account. The agent service owns login/refresh (ordinary Supabase
  auth); core stays stateless.
- **Seams left, clearly marked:** token rotation = Supabase password rotation
  (no core change); per-account enable/disable = membership row
  insert/soft-delete; finer route-level authorization for the `agent` role =
  future middleware on the same `principal` value. Out of scope per request.
- PWA note (other repo): member lists will show the agent membership; UI may
  want to label role `agent`.

## 4. Workstream C — idempotency deltas (Req 3)

The mechanism already exists and is broader than requested (required on every
account-scoped mutation; replay/conflict/in-flight semantics; janitor).
Deltas only:

1. **TTL**: completed-key retention 24h → 30 days (request's spec):
   `expires_at` default and `prune_idempotency_keys` default. Storage is
   bounded (one small jsonb per mutation per account; janitor unchanged).
2. **Fingerprint hardening**: include the authenticated `userId` in the
   sha256 preimage (`api/src/middleware/idempotency.ts`) so a landlord and
   the agent can never replay each other's cached responses within an
   account. Deploy-window effect: a key claimed pre-deploy and retried
   post-deploy gets 409 instead of a replay — acceptable, transient.
3. **Send-path coverage** is NOT this table's job — an external HTTP call
   cannot sit inside a DB transaction. Send safety comes from the outbox
   ordering (ADR-0007); the idempotency key still guards the request layer
   (same key → cached response → no second outbox row → no second Twilio
   call). The crash matrix lives in §6.4.

## 5. Workstream D — journal firewall (Req 7)

Enforcement module `api/src/routes/_lib/agent-firewall.ts`, called from the
interactions create handler when `principal.type === 'agent'`:

| Entry | Maps to | Required | Forbidden |
|---|---|---|---|
| `proposal_created` | `kind='agent_event'` | `approval_ref` (proposal id) | free prose > 1000 ch |
| `proposal_approved` | `kind='agent_event'` | `approval_ref`, `approved_by` | — |
| `proposal_rejected` | `kind='agent_event'` | `approval_ref` | — |
| `step_executed` | `kind='agent_event'` | `approval_ref` + ≥1 entity ref (`work_order_id`/`maintenance_request_id`/`vendor_id`/`tenancy_id`) | — |
| `note_logged` | `kind='note'` | `approved_by` + `approval_ref` (also DB-enforced) | — |
| ~~`vendor_contacted`~~ | **not appendable** | — | — |

Deviations from the request, with rationale:

- **`vendor_contacted` is removed from the direct-append whitelist.** A
  communication record must be *produced by the send pipeline* (Workstream
  E), which guarantees a Twilio SID behind it. Letting the agent append
  "vendor_contacted" directly would let it claim a contact that never
  happened — exactly what the journal exists to prevent. The agent gets the
  entry by calling the send endpoint.
- **The agent cannot use `corrects_id`** (no corrections/retractions; 403
  `agent_forbidden`). Only landlords supersede history.
- The agent cannot author `kind='communication'` via direct append (same
  fabrication argument), and cannot supply `author_type` (server-stamped).

Anything not on the table → 403 with a stable error code
(`agent_entry_type_forbidden`), per-type zod schemas give 400s with field
paths. Landlord-user writes hit none of this code.

## 6. Workstream E — outbound messaging via Twilio (Req 6 + Req 4)

> **Superseded (2026-06-27):** the Twilio integration described in this workstream was removed; see migration `20260627000001_drop_messaging`.

Ordering decision and crash matrix: **ADR-0007** (outbox-first; journal entry
only on confirmed send). Channel seam: `api/src/messaging/provider.ts`
(`MessagingProvider.sendSms(...)`), Twilio impl `twilio.ts`, injected fake in
tests; email is a future second implementation of the same interface — not
built.

### 6.1 Schema (operational tier), migration `2026xxxx_messaging.sql`

```sql
message_outbox (
  id, account_id,
  channel        'sms'                              -- email later, same table
  recipient_type 'tenant'|'vendor', recipient_id,    -- composite-FK per house pattern
  to_phone       text,                               -- resolved E.164, frozen at send time
  body           text,
  status         'sending'|'sent'|'delivered'|'failed'|'undeliverable'|'needs_reconcile',
  provider_sid   text unique,                        -- Twilio MessageSid
  error_code, error_message,
  interaction_id uuid references interactions(id),   -- set when journal entry lands
  created_by_author_type, approval_ref,              -- capacity mirror for ops debugging
  created_at, updated_at, delivered_at
)
-- RLS: member select/insert/update (composite-FK account scoping like
-- every domain table). AUDITED: added to the _emit_event trigger list, so
-- every status transition is hash-chained -> delivered-status is
-- tamper-evident WITHOUT touching journal immutability.

sms_opt_outs (
  phone text primary key,            -- E.164; global per environment, since
  opted_out_at, last_keyword, source_sid  -- one Messaging Service serves all accounts
)
-- No member RLS read (cross-account phone oracle); send path checks via
-- SECURITY DEFINER is_phone_opted_out(p_phone) returning boolean.

twilio_inbound_raw (
  id, provider_sid unique,           -- webhook replay dedupe
  from_phone, to_phone, body, payload jsonb,
  match_status 'matched'|'unmatched'|'ambiguous',
  matched_account_id, matched_interaction_id,
  received_at
)
-- Service-level (no account_id until matched): admin-path writes only.
```

`interactions_with_chain` view recreated with a left join to `message_outbox`
on `interaction_id` → derived read-only fields `delivery_status`,
`delivered_at` on every interaction (same derived-not-stored pattern as
`is_head`).

### 6.2 Send endpoint

`POST /v1/accounts/{accountId}/messages` body:
`{ channel:'sms', recipient_type, recipient_id, body (1..1600 ch), occurred_context refs?, approval_ref? }`

1. Validate; resolve principal. **Agent → `approval_ref` required (400
   without); landlord → forbidden (400)**, mirroring the journal firewall's
   "approval fields are agent-only" rule (Req 4: spec documents the
   conditional, server enforces — there is no pre-existing client to break
   since the endpoint is new).
2. Resolve recipient → phone: tenants = `phones[0]` (documented convention:
   first entry is primary), vendors = `contact->>'phone'`; normalize to
   E.164; 422 `no_sms_destination` if absent/unparseable. Raw numbers from
   the client are rejected by schema (no such field).
3. Opt-out check → 409 `sms_opted_out` (no Twilio call).
4. Insert outbox row `status='sending'` (committed = the intent record).
5. Call Twilio (Messaging Service SID; `statusCallback` URL carries
   `?outbox_id=<uuid>` so delivery state can always re-associate even if the
   send response is lost).
6. Outcomes (full matrix in ADR-0007): success → one transaction updates
   outbox to `sent`+SID **and** inserts the journal interaction
   (`channel='sms'`, `direction='outbound'`, party ref, body, capacity
   fields, `external_ref=SID`), links `interaction_id`, returns 201 with
   both ids. Definitive Twilio 4xx → outbox `failed`, 422 `send_failed` to
   caller, **no journal entry** (nothing was sent; the operational record
   carries the attempt). Timeout/unknown → outbox stays `sending`, **409
   `send_state_unknown`** — deliberately a 4xx, because the idempotency
   middleware caches 4xx (replay returns the same answer, never re-dials)
   but frees the key on 5xx (a retry could double-send); the status
   callback or the reconcile janitor resolves the row, and the caller uses
   a new key only after confirming via `GET /messages/{id}`.

Synchronous in-request for v1 (one outbound HTTP call; no queue
infrastructure at single-landlord scale). **Scale seam:** the outbox row is
already the queue record — moving to `status='queued'` + a worker later
changes no schema and no contract beyond returning 202.

### 6.3 Webhooks (public, signature-validated; live in `api/src/admin/` per the intake precedent)

- `POST /v1/twilio/inbound`: validate `X-Twilio-Signature` (auth token,
  exact URL, sorted params) → 403 on failure. Dedupe on MessageSid. Detect
  STOP/UNSTOP/START/HELP keywords → upsert/clear `sms_opt_outs` (Twilio
  Advanced Opt-Out sends the carrier-required auto-replies; we keep the
  authoritative local state so the **send path can refuse before dialing**).
  Match `from_phone` against tenant `phones` / vendor contact across
  accounts: exactly one match → journal interaction (`direction='inbound'`,
  `author_type='tenant'|'vendor'... party ref`, actor `system:twilio-inbound`
  via the admin RPC pattern); zero or multiple → store `unmatched|ambiguous`
  in `twilio_inbound_raw`, structured warn log. **Never auto-create
  contacts.** Unmatched surfacing v1 = ops (log + documented admin query +
  /healthz counter `messaging.unmatched_inbound`); a landlord-facing
  resolution endpoint is a marked seam.
- `POST /v1/twilio/status?outbox_id=`: signature-validated; verify SID
  matches the row; monotonic transitions only
  (`sending→sent→delivered`, `failed/undelivered` terminal; out-of-order
  callbacks ignored). `delivered` stamps `delivered_at` durably; Twilio
  21610 (carrier opt-out) also upserts `sms_opt_outs`.
- Reconcile janitor (existing job-runner pattern): outbox rows `sending`
  older than 15 min → query Twilio by SID if known, else mark
  `needs_reconcile` for the documented manual procedure. Never auto-retries
  a send.

### 6.4 Why a message can't double-send and can't be unrecorded

| Crash point | State | Outcome |
|---|---|---|
| before outbox insert | nothing | retry executes fresh (idempotency placeholder freed per existing 5xx rule) |
| after outbox commit, before Twilio | `sending`, no SID | janitor: nothing at Twilio → `failed`; retry-able |
| after Twilio accepts, before outbox update | `sending`; Twilio has SID | status callback (`?outbox_id=`) or janitor SID lookup completes the record; journal entry appended by the completion path, attributed correctly |
| after `sent`+journal txn | consistent | idempotency replays the stored 201 |

Send without record: impossible (intent row precedes the call). Record
claiming an un-sent message: impossible (journal entry requires a returned
SID). The single residual window — Twilio accepted but the response was lost
**and** callbacks never arrive — converges via the janitor's SID-less
reconcile (`needs_reconcile`, manual), and the idempotency key keeps retries
from double-sending meanwhile.

### 6.5 Env & ops

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`,
`PUBLIC_BASE_URL` (callback URLs; render.yaml). Missing env → send endpoints
503 `messaging_unconfigured`; webhooks 404; /healthz reports
`capabilities.messaging`. 10DLC brand/campaign registration is operational,
outside this repo. Real-credential smoke test procedure → README (Phase 3
exit).

## 7. Workstream F — lossless polling + ledger as-of (Req 5)

**The interactions list is NOT poller-safe** (paginates on client-supplied,
backdatable `occurred_at`) — confirmed gap, exactly what the request feared.

Fix: expose the chain's own ordering. `events.account_seq` is per-account,
gap-free, strictly increasing, assigned under the chain lock and therefore
**committed and visible in order** (ADR-0001) — a provably lossless cursor.

- `GET /v1/accounts/{accountId}/events?after_seq=<int>&entity_type=interactions&limit≤200`
  → `{ data: [{account_seq, entity_type, entity_id, event_type, occurred_at,
  actor, snapshot}], next_seq }`. `snapshot` = `payload->'after'` (the events
  RLS already grants members exactly this read; no new exposure). Plain
  integer cursor — no opaque encoding needed; semantics documented in the
  spec: "poll with `after_seq` = last seen; you can never miss or double-see
  a committed entry."
- Read path: existing `events_account_id_seq_idx` (account_id, account_seq)
  + post-filter on entity_type. **Deliberately no new index** — a composite
  (account_id, entity_type, account_seq) would tax every audited write in
  the system to speed one poller; revisit trigger: feed p95 > 200 ms or
  > 20k events/account.
- Ledger: optional `?as_of=YYYY-MM-DD` on the existing endpoint. Semantics
  (documented in spec): charges by `due_date <= as_of`, payments by
  `received_at <= as_of`, voids respected only when `voided_at <= as_of`,
  allocations counted when both sides qualify. In-memory filter on the
  already-fetched rows — no query change, no new index.

## 8. Contract & SDK workflow (correcting the request's assumption)

This repo is code-first: zod route definitions → `openapi/emit.ts` →
`openapi/openapi.json` → generated SDK, with CI failing on drift. The
request's "spec first in each PR" rule maps to: **schema/route definitions
change in the same commit as their handlers; `pnpm --filter @rentalcrm/openapi
emit && pnpm --filter @rentalcrm/sdk generate` runs before commit; CI proves
cleanliness.** All changes additive; existing test suite untouched and green
is a merge gate on every PR. When the agent repo provides
`core-api-agent-extension.yaml`, diff it against our emitted spec in Phase 0
of their integration — core's spec remains the source of truth.

## 9. Test matrix (request's minimums → concrete tests)

| # | Request requirement | Test |
|---|---|---|
| 1 | mixed-era chain verification + capacity tamper | `db/test/chain-mixed-era.test.ts` (§2.4) |
| 2 | idempotent replay / conflict / crash-retry / exactly-one-Twilio-call | extend `api/test/phase12.test.ts` patterns + `api/test/messaging.test.ts` with fake provider call-counter |
| 3 | agent without `approval_ref` rejected; landlord unaffected | `api/test/agent-principal.test.ts` |
| 4 | agent authorship persisted + rendered in export | same + export assertion (pattern: `api/test/phase10.test.ts`) |
| 5 | concurrent writers vs paginating poller: no gaps/dupes | `api/test/events-feed.test.ts` — N writers + reader on `after_seq`, assert exact multiset |
| 6 | send→journal+SID; inbound sig valid/invalid; unmatched→no contact; STOP→refusal | `api/test/messaging.test.ts`, signature fixtures with real HMAC computation |
| 7 | firewall: non-whitelisted/oversized/unapproved-note rejected; landlord byte-identical | `api/test/agent-principal.test.ts`; landlord regression = existing `interactions-journal.test.ts` runs untouched |

Integration tests follow the house `tsx test/*.test.ts` tier against a
migrated local DB; pure validation logic lands in vitest `*.spec.ts`.

## 10. Phasing (each PR independently revertible, conventional commits)

| PR | Contents | Gate |
|---|---|---|
| 0 | this plan + ADRs 0006–0008 | CTO sign-off |
| 1 | journal migration (§2.1) + API capacity fields + export rendering + mixed-era chain test | **stop for review** (only journal-touching PR) |
| 2 | `agent` role migration, `AGENT_USER_ID`, principal middleware, firewall + tests, idempotency deltas, runbook | suite green |
| 3 | events feed + ledger `as_of` + poller contract test | suite green |
| 4 | messaging schema + provider seam + send endpoint + Req 4 conditional + fake-provider tests | **stop for review** (highest-risk: external side effects) |
| 5 | webhooks (inbound/status/signature) + opt-outs + janitor + compliance tests | suite green |
| 6 | spec/SDK/api-guide finalization, full regression, README smoke-test doc, reconcile `core-api-agent-extension.yaml` | release |

Risk re-rank vs the request: PR 1 (its "highest-risk") is low risk here
(ADR-0008); PR 4–5 carry the real risk and get the longest review.

## 11. Performance / scalability notes (CTO review)

- **Advisory-lock pressure (ADR-0001):** auditing `message_outbox` adds ~3–4
  chained events per message, and webhook-driven updates serialize with
  other same-account writes. At single-landlord volumes this is noise; the
  ADR-0001 revisit triggers (p95 lock-wait > 1 s) already cover the
  escape hatch (deferred chaining).
- **Events feed:** index-backed range scan per poll; integer cursor; no
  offset pagination anywhere. Revisit trigger documented in §7.
- **Idempotency at 30-day TTL:** rows are one small jsonb per mutation;
  janitor unchanged; no index changes needed.
- **Sends synchronous by design** (one HTTP call), with the outbox as the
  pre-built upgrade path to a worker — no rearchitecture later.
- **No new N+1s:** delivery status joins via the view; feed embeds snapshots
  to spare the poller a GET per entry.

## 12. Open items (external to this repo)

1. `core-api-agent-extension.yaml` from the agent repo — needed by PR 6.
2. **Product decision (owner: CTO):** per-message landlord approval vs
   standing approval for outbound tenant messages — what `approval_ref`
   points at. Blocks nothing until PR 4; decide before it merges.
3. Twilio account + 10DLC registration (operational; blocks PR 5 smoke test
   only — fake-provider tests are not blocked).
4. Agent repo conventions: idempotency keys are UUIDv4 per logical action;
   polling cadence; `phones[0]`-is-primary convention acknowledged.
5. PWA: display of the `agent` membership role.
