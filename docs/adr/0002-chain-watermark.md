# ADR-0002: Chain watermark — incremental verification with a bounded full-pass cadence

- **Status:** accepted and BUILT (migration `20260615000001_chain_watermarks.sql`), 2026-06-11

## Context

`verify_chain_sweep` re-walked every account's full event chain from event #1
on every cron tick: O(history) per account per tick, forever growing. Measured
cost ≈ **57 µs/event** (local stack) → a 100k-event account costs ~5.7 s per
tick; 10 such accounts make the sweep a minute-long job that only gets worse.

## Decision

`chain_watermarks` records "verified intact through `account_seq` N with chain
hash H at time T". The sweep resumes from N — **O(new events)** per tick
(measured: 70-event genesis walk 3–4 ms; resumed walk ~1 ms, 0 events
re-checked) — with three guardrails:

1. **Anchor re-check (O(1)):** before resuming, the event at seq N must still
   carry hash H; any drift falls back to a full verify.
2. **Bounded full-pass cadence:** the sweep runs a FULL from-genesis verify
   whenever `last_full_at` is older than 24 h. This bounds the detection
   window for the one thing incremental verification cannot see (below).
3. **The evidence export never relies on the watermark.** The PDF banner's
   verification (`verify_chain` via export-pdf.ts) remains full-walk — the
   artifact a court sees is always backed by a complete re-verification.

## The trade-off, stated plainly

Tamper **after** the watermark: caught on the next tick (DoD-tested).
Tamper **at or behind** the watermark: invisible to the incremental walk —
those rows are attested by the watermark, not re-read. Detection latency is
bounded by the 24 h full pass (DoD-tested: behind-watermark tamper passes
incrementally, then the stale-cadence sweep catches it and raises the alert).
The watermark row itself is operational state, not evidence; an attacker who
can move it can also rewrite events — the threat model is unchanged from
Phase 11, only the detection cadence for the historical prefix moved from
"every tick" to "≤ 24 h".

Fixed en route: re-detection of a previously-resolved break now REOPENS the
alert (`resolved_at = null` on conflict) — the Phase 11 upsert left it
resolved, which the new DoD tests surfaced.

## Revisit triggers

- Even the 24 h full pass becomes too slow (≈ events > ~50 M per account at
  57 µs/event ≈ 47 min): add per-epoch sub-watermarks or move full passes to
  a low-priority queue.
- Evidentiary requirements demand per-tick full verification: revert the
  sweep to full and accept the cost (one-line change; the watermark stays
  useful for ops dashboards).
