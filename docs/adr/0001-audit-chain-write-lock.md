# ADR-0001: Per-account audit-chain write lock

- **Status:** accepted (option A — keep, with documented triggers), 2026-06-11
- **Context owner:** architecture plan Phase 3

## Context

Every audited write takes `pg_advisory_xact_lock(hashtextextended('events_chain:' || account_id))`
inside `_emit_event()` and holds it **until COMMIT**. Two consequences:

1. All writes within one account serialize. Cross-account writes never block
   each other.
2. A long transaction holds the lock for its entire duration. The import
   executor (one transaction for preview AND commit) is the extreme case:
   while an import runs, every other write in that account — including tenant
   intake — waits.

Why the lock exists: each event's hash chains from the previous event's hash.
Two concurrent writers must serialize so each computes from the other's
committed hash; without the lock the chain forks or gaps.

## Options considered

- **A. Keep + document (chosen).** Single-landlord accounts have near-zero
  intra-account write concurrency; Phase 2.3 cut the import transaction's
  duration ~70% (10k rows: 23.9s → 7.2s), shrinking the worst-case window.
  Zero risk, zero work.
- **B. Chunked import transactions.** Splits the lock hold into per-chunk
  windows but breaks the preview-rollback invariant (one savepoint, one
  txn = the entire correctness story of preview/commit parity). Rejected
  while A suffices: high design cost against the import's core guarantee.
- **C. Deferred chaining.** Writers append events with only `account_seq`
  (taken from a sequence; no lock); a background chainer computes hashes in
  seq order. Removes the serialization entirely; cost: tamper-evidence lags
  by the chainer's cadence (seconds), and "chain verified" must distinguish
  hashed vs pending-hash suffixes. The right destination if B2B/multi-user
  accounts arrive.

## Decision

Keep the lock (A). The serialization is per-account by design, the accounts
are single-operator, and Phase 2.3 already shrank the longest hold by 3.3×.

## Revisit triggers (measurable, from the Phase 1 request logs / pg)

- p95 lock-wait on `events_chain:*` advisory locks exceeds 1 second
  (`pg_stat_activity.wait_event = 'advisory'` sampling), or
- any user-visible intake/API write failure or timeout during an import, or
- the product adds multi-user accounts with concurrent writers.

Then implement C (deferred chaining); B remains rejected.
