# ADR-0007: Outbox-first, journal on confirmed send

- **Status:** accepted and CURRENT, generalized implementation restored
  2026-07-01 by `20260701000002_comms_ledger.sql`
- **Originally accepted:** 2026-06-12
- **Context owner:** communications ledger and evidence journal

## History

The first implementation was tied directly to Twilio and was removed on
2026-06-27. The durable ordering decision was not rejected. It was restored as
the provider-neutral communications ledger: core owns intent and evidence
state, while a separate transport service owns provider calls.

This ADR supersedes its own Twilio-specific wording. The current tables and
RPCs are `comm_outbox`, `complete_send`, `fail_send`, and the communications
capture paths.

## Context

Two invariants must hold simultaneously:

1. A message is never sent without a durable record of the intent.
2. The immutable journal never claims a send that did not happen.

The journal cannot carry mutable delivery progress. A provider HTTP call also
cannot participate in a Postgres transaction. The ordering of partial failures
therefore has to be explicit.

## Decision

Use a mutable operational outbox before the provider call and append immutable
journal evidence only after provider acceptance:

```text
create intent
  -> commit comm_outbox row
  -> transport claims row
  -> provider call
  -> complete_send RPC
       -> mark outbox sent
       -> append interaction
       -> append participant cast
       -> emit audit events
     (one database transaction)
```

Definitive provider refusal uses `fail_send` and creates no interaction because
nothing was sent. Delivery callbacks may advance the outbox after confirmation;
they never rewrite the journal.

## Failure Matrix

| Failure point                             | Durable state                          | Resolution                                              |
| ----------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| Before intent insert                      | Nothing happened                       | Idempotent retry starts fresh                           |
| After intent commit, before provider call | Queued/claimed outbox, no journal      | Transport retry or stale-claim recovery                 |
| Provider accepted, response lost          | Ambiguous outbox, provider may have id | Reconcile by provider id/callback; never redial blindly |
| Provider definitive refusal               | Failed outbox, no journal              | Surface failure; a new intent is a new decision         |
| During `complete_send`                    | Whole transaction rolls back           | Safe retry of the completion RPC                        |
| After `complete_send`                     | Sent outbox + exactly one interaction  | Idempotent replay returns existing state                |

## Supporting Rules

- Intent fields and recipient snapshots become immutable once queued.
- Idempotency keys deduplicate caller intent creation.
- Provider message ids and database constraints deduplicate completion.
- Status changes are monotonic; terminal rows do not move backwards.
- Ambiguous sends are reconciled, never automatically re-sent.
- Opt-out and authorization checks happen before an intent becomes dispatchable.
- `complete_send` is the only confirmed-send journal boundary for transport
  sends; transports must not write a second manual communication row.

## Ownership Boundary

Core owns:

- outbox, thread, binding, opt-out, policy, and evidence state;
- authorization and frozen recipient/provenance snapshots;
- completion/failure/callback RPCs;
- immutable journal and audit events.

The external transport owns:

- provider credentials and API calls;
- provider webhook signature verification and normalization;
- driving core's capture, completion, failure, and delivery endpoints.

## Revisit Triggers

- Multi-instance dispatch requires a durable worker/lease design rather than
  in-process assumptions.
- A provider offers reliable request idempotency that can narrow the ambiguous
  acceptance window.
- A new channel cannot express its confirmation semantics through the existing
  provider-id and completion contract.

Any replacement must preserve both top-level invariants and include an explicit
partial-failure matrix.
