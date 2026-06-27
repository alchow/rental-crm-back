# ADR-0007: Outbound send/record ordering — outbox-first, journal on confirmed send

> **Status: Superseded** — the Twilio outbound integration was removed on 2026-06-27 (migration `20260627000001_drop_messaging`). This ADR is retained as the historical record of the send-ordering decision while it was in force.

- **Status:** accepted, 2026-06-12
- **Context owner:** agent-facing API plan (docs/agent-api-plan.md, Workstream E)

## Context

Core gains outbound SMS via Twilio. Two invariants must hold simultaneously:

1. **A message is never sent without a record** (an unrecorded send is
   invisible liability in an evidence product).
2. **A record never claims a send that didn't happen** (a fabricated send is
   worse — the journal would lie).

The journal (`interactions`) is append-only and immutable, so it cannot carry
mutable send state (queued → sent → delivered). An external HTTP call cannot
sit inside a database transaction, so "send + record atomically" is
physically impossible; the ordering of partial failures must be designed,
not wished away.

## Options considered

- **A. Journal-first, send after.** Violates invariant 2 on any post-record
  failure: the journal claims a contact that never happened, and the only
  "fix" is a correction row — manufactured evidence churn. Rejected.
- **B. Send-first, record after.** Violates invariant 1 in the crash window:
  Twilio delivered, nothing anywhere says so. Worst possible failure mode
  for this product. Rejected.
- **C. Operational outbox first, journal entry only on confirmed send
  (chosen).** Intent is committed *before* the provider call as a mutable
  `message_outbox` row (`status='sending'`); the immutable journal entry is
  appended only when Twilio returns a MessageSid, in the same transaction
  that marks the outbox row `sent`. The outbox table is attached to the
  `_emit_event` audit trigger, so every state transition — including
  `delivered` from the status callback — is hash-chained and tamper-evident
  without ever mutating the journal. Delivery state is exposed on
  interactions as a derived view join (the `is_head` pattern), never a
  stored journal field.

## Decision

Option C, with this failure matrix as the contract:

| Crash / failure point | Resulting state | Resolution |
|---|---|---|
| Before outbox insert | nothing happened | idempotent retry executes fresh |
| After outbox commit, before Twilio call | `sending`, no SID, nothing at Twilio | reconcile janitor finds no SID → `failed`; retryable |
| Twilio accepted, response lost | `sending`; Twilio has SID | status callback carries `?outbox_id=` and re-associates; janitor SID lookup is backstop; journal entry appended by the completion path |
| After `sent` + journal transaction | fully consistent | idempotency key replays stored response |
| Twilio definitive 4xx | `failed`, error recorded | surfaced to caller; **no journal entry** — nothing was sent |

Supporting rules:

- The `Idempotency-Key` (existing middleware) is the request-level dedupe: a
  retried request returns the cached response and never creates a second
  outbox row, so at most one Twilio call per key.
- The status callback URL carries the outbox row id, so delivery state can
  always re-associate even when the synchronous response was lost.
- Status transitions are monotonic (`sending → sent → delivered`;
  `failed`/`undelivered` terminal); late or duplicate callbacks are ignored.
- The reconcile janitor never auto-retries a send; ambiguous rows park in
  `needs_reconcile` for the documented manual procedure.
- Opt-out (`sms_opt_outs`) is checked before the outbox insert; refusing a
  send leaves no journal trace (nothing happened), only the API error.

## Revisit triggers

- Send volume or latency requires asynchronous dispatch → flip the endpoint
  to insert `status='queued'` and add a worker; schema and invariants are
  unchanged by design (the outbox already is the queue record).
- A second channel (email) lands → same outbox table, same ordering, new
  `MessagingProvider` implementation.
- Twilio ships request idempotency keys for the Messages API → the
  `sending`-window reconcile can be simplified.
