# ADR-0008: Journal authorship capacity — no chain versioning, no backfill

- **Status:** accepted, 2026-06-12
- **Context owner:** agent-facing API plan (docs/agent-api-plan.md, Workstream A)

## Context

Journal entries gain authorship-capacity fields (`author_type`,
`approved_by`, `approval_ref`, plus `entry_type` and `external_ref`). The
build request assumed historical entries "were hashed without these fields"
and proposed either (a) per-entry `schema_version` with version-aware
verification, or (b) keeping the new fields outside the hashed payload.

Discovery finding that dissolves the dilemma: **the chain hashes row
snapshots, not schemas.** `_emit_event()` stores `to_jsonb(NEW/OLD)` — the
row as it existed at write time — inside the hashed canonical
(`20260605000002_phase4_actor_integrity.sql:119-129`), and `verify_chain`
re-hashes the *stored* snapshot (`payload`), never re-serializing from the
live table. Consequences:

- Adding columns cannot invalidate any historical entry: old snapshots are
  untouched and verify byte-for-byte.
- New entries include the new fields in their hashed snapshot automatically:
  capacity metadata is tamper-evident from the first post-migration write,
  satisfying the request's intent for option (a) with zero mechanism.
- Mixed-era chains need no version dispatch in verification — the snapshot
  is self-describing.

## Options considered

- **Per-entry `schema_version` (request's preference).** Adds a column and
  verification branching that the architecture provably does not need; every
  future column addition would demand a version bump ritual with no
  integrity gain. Rejected as cargo cult — but the *test* the request ties
  to it (full-chain verification over a fixture containing genuine
  pre-migration entries, plus a capacity-field tamper case) is kept and
  gates the migration PR.
- **Capacity fields outside the hashed payload (request's option b).**
  Strictly worse: "who authored this and under what authority" is exactly
  what should be tamper-evident. Rejected.
- **Backfill `author_type='landlord'` (request's assumption).** Historically
  false: the `actor` column proves some rows are tenant-authored (intake,
  `tenant:<token_id>`) and some system-authored. Writing a false constant
  into an evidence table is the one sin this product cannot commit.
  Rejected.
- **Derived backfill via UPDATE.** Historically accurate but churns one
  chained event + `updated_at` bump per journal row for zero information
  gain — `actor` already encodes the answer losslessly. Rejected.
- **No backfill; resolve at read (chosen).** Legacy rows keep
  `author_type = null`; the API resolves the wire value from `actor`
  (`user:` → `landlord`, `tenant:` → `tenant`, `system*` → `system`) in one
  helper (`api/src/routes/_lib/authorship.ts`). All new writes stamp
  `author_type` explicitly from the resolved principal — never
  client-supplied. The wire contract never exposes a null.

## Decision

No `schema_version`, no verification changes, no backfill. One additive
migration; the mixed-era chain-verification test
(`db/test/chain-mixed-era.test.ts`, fixture of verbatim pre-migration event
rows) is the merge gate proving historical verification still passes and
that tampering with a v2 capacity field breaks the chain.

`on_behalf_of_account_id` from the request is dropped: every journal row
already carries `account_id`, which is the account the entry is on behalf
of. To be reconciled against the agent repo's draft extension spec.

Known, accepted gap (out of scope, documented for honesty): the
`events.actor` column itself sits outside the hashed canonical. Journal
authorship is unaffected — `actor` and all capacity fields live inside the
hashed row snapshot — but a future chain-format revision should fold
`events.actor` into the canonical.

## Revisit triggers

- Any change to the canonical preimage or `verify_chain` (a true chain
  format v2): fold `events.actor` in at that moment.
- A requirement to query `author_type` on legacy rows in SQL (not via the
  API): ship the derived backfill then, as its own reviewed migration.
