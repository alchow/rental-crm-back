# ADR-0005: Horizontal scale-out checklist

- **Status:** accepted (checklist; no build until trigger), 2026-06-11
- **Trigger:** sustained CPU > 70% or a p95 latency SLO breach on the single
  Render instance (read it off the Phase 1 request-summary logs).

## What blocks instance count > 1 (must fix BEFORE scaling)

1. **The in-process job runner** (`api/src/admin/job-runner.ts`). Two
   instances would double-run nothing (jobs enqueue only on the instance that
   took the POST) but boot recovery on instance A would mark instance B's
   in-flight jobs failed. Replace with a jobs table consumed via
   `FOR UPDATE SKIP LOCKED`; job STATE already lives on the domain rows
   (`evidence_exports.status`, `import_sessions.status`), so the swap changes
   no schema or API contract. Boot recovery becomes lease-based (stale
   `running` + heartbeat column) instead of mark-all-failed.
2. **Import recognition's captured request Buffer.** The job closure holds
   the upload bytes in memory; with a jobs table the worker re-reads them
   from the archived `source_path` (already stored for exactly this reason).

## What is already safe

- **Membership TTL cache** (45 s, positive-only): per-instance staleness is
  bounded and RLS is the real guard — no coordination needed.
- **HEIC probe / import-health probe caches:** per-instance, advisory only.
- **JWKS cache (jose):** per-instance with kid-miss refetch — designed for it.
- **Idempotency, audit chain, import executor:** all serialize in Postgres
  (PK claim, advisory lock, single transaction) — instance-count agnostic.
- **Sessions/state:** none in-process; JWTs verified statelessly.

## Sizing notes

- `pg` pool is `max: 4` per instance (db-pool.ts); the Supabase session
  pooler cluster must be sized for `4 × instances` plus PostgREST's own use.
- Render autoscaling should key off CPU; the PDF/import jobs are the spiky
  consumers and they move to the worker in step 1, after which the web
  instances are cheap and flat.

## Order of operations when triggered

jobs table + worker (1, 2) → raise instance count → revisit ADR-0001
(deferred chaining) only if intra-account write concurrency also rose.
