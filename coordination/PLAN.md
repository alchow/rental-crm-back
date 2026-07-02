# Comms Build — Plan A: rental-crm-back (the communications ledger)

You are the **core** worker in a three-repo build. Two sibling Claude Code
instances work `landlord-agent` (Plan B) and `rentalnotesagent` (Plan C) on the
same branch name. A coordinator watches all three repos from a sandbox and
communicates through `coordination/INBOX.md`. **You own the contract everyone
else consumes — your M0 unblocks both siblings. Start immediately.**

## Architecture you are implementing (context)

The product is adding a communications function (SMS now; email/voice next)
with three interaction types: (1) System→Tenant reminders under standing,
landlord-approved policies; (2) Landlord↔AI chat (already exists in the agent);
(3) bridged tenant↔landlord threads where the system relays, logs, and may
interject via approved proposals.

Decided placement ("Option D — split by concern"):
- **core (you)** owns all communications *state*: threads, outbox/delivery
  ledger, opt-outs, standing grants, and the journal. Core NEVER calls a
  messaging provider and NEVER terminates a provider webhook. You are
  resurrecting — generalized — the messaging subsystem that was deliberately
  removed on 2026-06-27 (`db/supabase/migrations/20260627000001_drop_messaging.sql`).
  The dropped migrations `20260616000003_messaging.sql` and
  `20260616000004_inbound_messaging.sql` plus `docs/adr/0007-outbound-send-record-ordering.md`
  are your blueprint — read all three before writing any code.
- **landlord-agent** hosts an LLM-fenced transport module that makes the
  provider calls and drives your ledger via API: it writes an outbox *intent*
  before dialing and confirms/fails after. ADR-0007's guarantee must hold
  across the process boundary: intent durable in core before any provider
  call; journal entry appended only with a provider message id, in the same
  transaction that marks the outbox row sent.
- **frontend** renders threads, delivery state, and policy provenance, and
  manages grants.

Authorization provenance convention (used across all repos):
- `approval_ref = 'proposal:<id>'` + `approved_by = <user uuid>` → a human
  approved this exact message.
- `approval_ref = 'grant:<id>'` + `approved_by IS NULL` → sent under a
  standing policy; no human read this specific message. The journal must be
  honest about the difference.

## Coordination protocol (your duties)

- Before starting each milestone: `git pull --rebase`, read
  `coordination/INBOX.md`.
- After finishing each milestone, and whenever blocked or you have a question:
  update `coordination/STATUS.md`, commit, `git pull --rebase`, push.
- You write ONLY `coordination/STATUS.md` inside `coordination/` (plus your
  normal code changes). Never edit `PLAN.md` or `INBOX.md`.
- If anything in this plan conflicts with what you find in the codebase, do
  NOT improvise around an invariant: write the question to STATUS.md, push,
  and continue with unblocked work.
- Announce contract-affecting changes loudly: any time `openapi/openapi.json`
  changes, note the commit sha in STATUS.md under "Contract".
- Run the repo gates before every push (see Gates).

## Invariants (do not violate)

1. Core makes no provider calls: no provider SDKs, no fetches to messaging
   APIs, no provider webhooks terminated here.
2. The `interactions` journal is append-only; a `kind='communication'` row is
   created only via `complete_send`-style confirmed paths (or existing
   landlord manual logging) — never speculatively.
3. Agent-principal writes of `kind='communication'` require BOTH
   `approved_by`-or-grant provenance AND `approval_ref`; corrections/
   retractions by the agent remain forbidden.
4. Every new table: force-RLS, `is_account_member(account_id)` policy where
   account-scoped, composite `(account_id, id)` unique for FK targets, and
   attached to the `_emit_event()` audit trigger (delivery-state transitions
   must be hash-chained). `comm_opt_outs` is the exception: RLS-enabled with
   NO member policy (service-role/SECURITY DEFINER access only), keyed by
   address, not account.
5. Migrations are forward-only, timestamped `YYYYMMDDNNNNNN_name.sql`.
6. Outbox status transitions are monotonic:
   `queued → sending → sent → delivered`; `failed`/`undeliverable` terminal;
   `needs_reconcile` parks ambiguity for manual resolution. Late/duplicate
   callbacks are ignored.
7. Idempotency: all mutating endpoints go through the existing
   `Idempotency-Key` middleware (automatic under `/v1/accounts/:accountId/*`);
   `capture_inbound` is idempotent on `provider_msg_id`.

## Milestones

### M0 — Contract first + firewall relaxation  (UNBLOCKS PLANS B & C — do this first, push immediately when green)

1. **Firewall** (`api/src/routes/_lib/agent-firewall.ts`): allow the agent
   principal to create `kind='communication'` interactions IFF the row carries
   `approval_ref` and either `approved_by` (proposal-approved) or a
   `grant:`-prefixed `approval_ref` (policy-authorized). Mirror the existing
   agent-note rule's structure. Keep: 403 on agent corrections/retractions,
   403 on free-text communications without provenance. Tests for all
   branches. (Rationale doc lives in the sibling repo:
   `landlord-agent/docs/agent-sends-core-records.md`.)
2. **Contract stubs**: define ALL `/v1/accounts/{accountId}/comms/*` routes as
   `@hono/zod-openapi` route definitions with typed request/response schemas
   and stub handlers (`501 not_implemented` via the standard error envelope).
   Endpoints (transport = agent principal; landlord = owner|manager):
   - `POST   .../comms/outbox` (transport + landlord) — create send intent:
     `{channel, to_address?, thread_id?, participant_ref?, body, approval_ref,
     approved_by?, not_before?, relay_of_interaction_id?, template_id?}` →
     outbox row (status `queued`).
   - `GET    .../comms/outbox?status=&eligible_at=` (transport) — dispatch scan.
   - `POST   .../comms/outbox/{id}/complete` (transport) —
     `{provider, provider_sid}` → marks `sent` + appends journal atomically;
     returns `{interaction_id}`.
   - `POST   .../comms/outbox/{id}/fail` (transport) — `{error_code, detail?, reconcile?}`.
   - `POST   .../comms/outbox/{id}/delivery` (transport) — `{status, provider_ts}` monotonic.
   - `POST   .../comms/inbound` (transport) — capture: `{provider,
     provider_msg_id, to_number, from_address, channel, body, media?,
     received_at}` → `{interaction_id, thread_id?, participant?, disposition:
     matched|orphan|opted_out}` (idempotent replay returns same result).
   - `POST   .../comms/opt-outs` (transport) — `{channel, address, keyword, source_ref}`.
   - `GET    .../comms/opt-outs` (landlord, read-only).
   - `GET    .../comms/threads` / `GET .../comms/threads/{id}` (landlord) —
     thread + participants + journal rows (by `thread_id`) + delivery state.
   - `POST   .../comms/threads` (landlord) — create thread + participants +
     bindings for a tenancy.
   - `POST   .../comms/threads/{id}/messages` (landlord) — landlord-authored
     outbound: creates outbox intents to the other participants,
     `approved_by = self`, `approval_ref = 'self:<user_id>'`.
   - `GET/POST .../comms/policies`, `POST .../comms/policies/{id}/revoke`
     (landlord) — standing grants; create = approve (`approved_by` = caller).
   - `GET    .../comms/reconcile` (transport) — stale `sending` rows past TTL.
3. `pnpm` emit the OpenAPI spec (`openapi/openapi.json`) and regen the SDK;
   `check:drift` green. Commit + push. **Record the spec sha in STATUS.md** —
   the coordinator broadcasts it to Plans B/C.

### M1 — Ledger migrations

Generalize the dropped blueprint (read it first). One or more migrations:

- `comm_outbox`: account_id, channel `sms|email|voice`, to_address,
  thread_id?, participant refs?, body, template_id?, `not_before timestamptz?`,
  `relay_of_interaction_id uuid?`, status (enum above), error fields,
  provider, `provider_sid` UNIQUE (nullable), `client_ref` UNIQUE (for
  provider-side re-association), `approval_ref` NOT NULL, `approved_by uuid?`,
  `interaction_id uuid?` (set on completion), timestamps. Audit-attached.
- `comm_opt_outs`: `(channel, address)` PK, opted_out_at, keyword,
  source_ref. + `is_address_opted_out(channel, address)` SECURITY DEFINER.
- `inbound_raw`: provider, `provider_msg_id` UNIQUE, payload jsonb,
  received_at.
- `comm_threads`: account_id, kind `bridged_tenant|vendor`, status
  `active|closed`, tenancy_id?, maintenance_request_id?. Audit-attached.
- `comm_thread_participants`: thread_id, party_type
  `tenant|landlord_user|vendor|agent`, party_id, joined_at, left_at?.
- `channel_identities`: account_id, party_type, party_id, channel, address,
  verified_at?, label; UNIQUE (account_id, channel, address).
- `platform_numbers`: number PK, provider, capabilities, account_id, status.
- `thread_channel_bindings`: thread_id, participant ref, platform_number,
  participant_address, active flag; **partial UNIQUE
  (platform_number, participant_address) WHERE active** — this is the inbound
  routing key; a counterparty may have only one active thread per platform
  number.
- `comm_policies`: account_id, policy_kind
  `rent_reminder|thread_autonomy|voice_autonomy`, channel, template_id?,
  params jsonb, quiet_hours jsonb (tz-aware window), status, approved_by,
  approved_at, revoked_by?, revoked_at?. Audit-attached.
- `interactions.thread_id uuid?` FK; resurrect the agent-capacity trigger
  requiring `external_ref` on agent-authored `kind='communication'` rows.
- RPCs (SECURITY DEFINER, `audit.actor` set inside, per house pattern):
  - `capture_inbound(...)`: insert `inbound_raw` (ON CONFLICT provider_msg_id
    → return prior result); resolve binding
    (platform_number, from_address) → thread+participant; append journal row
    (`kind='communication'`, `direction='inbound'`, thread_id, party fields,
    `external_ref = provider_msg_id`); return disposition. Opt-out keyword
    handling happens in transport (agent repo) BEFORE relay, but the message
    is still journaled here first.
  - `complete_send(outbox_id, provider, provider_sid)`: guarded UPDATE
    `WHERE status IN ('queued','sending')` → `sent`; append journal row with
    `external_ref = provider_sid` and the outbox row's provenance; link
    `interaction_id`; ALL IN ONE TRANSACTION. Idempotent on replay.
  - `fail_send(outbox_id, error, reconcile bool)`; `update_delivery(outbox_id,
    status, ts)` monotonic; `reconcile_scan(ttl)` returns stale `sending`.
- Derived view: extend/mirror the dropped `interactions_with_chain` join so a
  journal row exposes its delivery state (and per-leg states for relays via
  `relay_of_interaction_id`).

### M2 — Real handlers

Replace the M0 stubs with implementations calling the RPCs / RLS-scoped
queries. Transport endpoints require the agent principal
(`resolvePrincipal` → `type==='agent'`); landlord endpoints owner|manager.
Wire new entity types into whatever the events feed needs (audit trigger
attachment should surface them automatically — verify `entity_type` values
appear in `GET /v1/accounts/{id}/events`). Re-emit spec + SDK; `check:drift`
green; update the spec sha in STATUS.md ("Contract" section).

### M3 — Tests + gates

- db tests: `complete_send` atomicity (no journal row on failed send; exactly
  one on replay), monotonic delivery, binding partial-unique, RLS denial
  cross-account, opt-out lookup, capture idempotency.
- api tests: firewall branches, idempotency replay on `POST /comms/outbox`,
  principal gating (agent vs landlord vs viewer).
- Full gates green (typecheck, lint, tests, drift checks per repo scripts).

## Gates

Use this repo's standard scripts (see `package.json` / CI workflow):
typecheck, lint (including `scripts/lint-service-role.sh`), unit + db tests,
`check:drift`, `check:guide-drift` if applicable. All green before each push.

## Definition of done

All milestones ✅ in STATUS.md; spec sha recorded; gates green; no provider
SDK anywhere in this repo; coordinator has acknowledged final contract sha in
INBOX.md.
