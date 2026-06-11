# Phase 2 — detailed implementation plan

- **Status:** planned (not started)
- **Parent:** `docs/architecture-plan.md` (Phases 0+1 shipped 2026-06-11, PR #7)
- **Goal:** no request handler builds a 200 MB artifact or waits on multi-minute
  LLM calls; imports stop being O(rows) round trips; mutating-request latency
  drops. Estimated 3–4 weeks; items ordered by risk retired per week.

## Context

Phase 1 shipped the observability needed to measure this phase (request-id +
per-request summary lines). The two remaining production risks are synchronous
heavy work in handlers: `POST /evidence-exports` builds the whole PDF bundle
in-request (OOM + tail-latency risk on a 512 MB instance), and `POST /imports`
runs 2–3 Opus calls before responding (minutes-long requests, proxy timeouts,
double LLM spend on retry). Both already have status-machine-shaped resources;
this phase finishes the async design they imply.

## Sequencing

2.1 (job runner + async exports) → 2.2 (async import recognition; reuses the
runner) → 2.3 (executor batching) → 2.4 (round-trip reduction) → 2.5 (vitest,
incremental alongside). Each item is independently shippable.

---

## 2.1 Job runner + async evidence exports (week 1, the OOM risk)

**Design decision:** the `evidence_exports` row IS the job (mirrors how
`import_sessions` already carries its status machine). No generic jobs table in
v1 — that arrives only with the multi-instance worker (Phase 3 scale-out ADR),
and the schema below doesn't preclude it.

### Migration `2026xxxxxxxxx1_evidence_export_async.sql`
- `evidence_exports`: add `status text not null default 'done'
  check (status in ('queued','running','done','failed'))` (default backfills
  existing rows), add `error text`.
- Drop NOT NULL on `chain_verified`, `chain_message`, `attachment_id` (their
  composite-FK stays; null until completion). `generated_at` keeps its default;
  overwritten at completion.
- Partial index `(status) where status in ('queued','running')`.
- New SECURITY DEFINER RPC `create_evidence_export(p_account_id, p_tenancy_id,
  p_area_id, p_from_date, p_to_date, p_exporter)`: membership-checked insert of
  the queued row with `audit.actor = 'user:<exporter>'`; returns the row.
  (Write-path discipline: members have SELECT-only on this table; all writes
  via RPC, same as today.)
- Rework `record_evidence_export` → `complete_evidence_export(p_evidence_export_id,
  …artifact fields…)`: one txn that INSERTs the attachment row and UPDATEs the
  export row to `status='done'`, actor pinned to the exporter (read off the row).
- Small `fail_evidence_export(p_id, p_error)` RPC (actor `system:job-runner`).

### Runner — new `api/src/admin/job-runner.ts`
- In-process queue, **concurrency 1** (single Render instance), promise-chain;
  `enqueue(label, fn)` + structured log lines (`event: 'job_started'/'job_done'/
  'job_failed'`, ms, label) through `getLogger()`.
- Boot recovery in `buildApp()` (fire-and-forget, like `assertImageStackAtBoot`):
  mark any `queued`/`running` evidence_exports rows `failed` with error
  `'server restarted before processing; retry the export'` — the in-process
  queue does not survive a restart and a truthful failed-state beats a
  forever-pending row.

### Route changes — `api/src/routes/evidence-exports.ts`
- POST: scope pre-validation unchanged → `create_evidence_export` RPC →
  `enqueue('evidence-export', () => buildEvidenceExport(exportId))` → **202**
  with the full row. `ExportResponse` is replaced by the row schema (`ExportRow`
  + `status` + `error`; artifact fields nullable).
- GET list/get: include `status`/`error` (free — `select('*')`).
- `download`: 409 `conflict` with `'export is not ready (status=<s>)'` until
  `status='done'`.

### Builder changes — `api/src/admin/export-pdf.ts`
- `buildEvidenceExport` takes the pre-created export id; on entry flips status
  to `running` (admin update), on success calls `complete_evidence_export`,
  on any throw calls `fail_evidence_export` and logs with the export id.
- Memory bounds: photos fetched + embedded strictly one at a time, buffer
  released before the next (verify current loop in `renderExportPdf`; fix if
  it preloads). The 200 MB cap aborts to `failed`, never OOMs.

### Contract / FE coordination (breaking)
- POST 201→202; response gains `status`; `chain_verified`/`attachment_id`/
  `content_hash`/`size_bytes` nullable until done. Regenerate spec + SDK (drift
  gate forces the commit). FE adds a poll loop on GET until `status` ∈
  {done, failed}. Land FE + BE together; the endpoint has one consumer.

### Tests (vitest where new — see 2.5)
- Update `api/test/phase10.test.ts`: poll after POST; assert 202 → done →
  download succeeds; chain-status checks unchanged after completion.
- New checks: download 409 while queued/running; a builder throw lands
  `status='failed'` + error message; boot recovery flips a planted `running`
  row to `failed`.
- Load check (manual, documented in PR): two concurrent large exports + normal
  traffic on a starter-sized container; p95 of unrelated routes unaffected
  (Phase 1 request logs prove it).

---

## 2.2 Async import recognition (week 2)

### Handler split — `api/src/routes/imports.ts` upload handler
- Keep inline: multipart validation, session INSERT (`status='parsing'`),
  `uploadImportSource` (archive bytes). Then `enqueue('import-recognition',
  job)` closing over the in-memory `Buffer` and **return 201 with the session
  immediately**.
- Job: `parseImportFile` → `recognizeAndSuggest` → persist rows (chunked
  insert, unchanged) → final session UPDATE (`awaiting_mapping` /
  `no_importable_data` / `failed`) — i.e. today's steps 3–5 verbatim, moved
  into the closure with the existing `fail()` handling.
- Idempotency middleware caches the early 201 — a client retry returns the
  same session and polls. Correct by construction.

### Status guards
- `loadSession` gains an optional `requireStatusNot: ['parsing']` (or a tiny
  `assertNotParsing(session)` helper) used by mapping/parents/chat/rows-PATCH/
  preview/confirm: 409 `'recognition in progress; poll the session'`.
  Reads (GET session/rows) stay open.
- Boot recovery: sessions stuck in `parsing` → `failed` with
  `'server restarted during recognition; re-upload'`. (v2 option, not now:
  re-run from the archived `source_path` instead.)

### Tests
- `api/test/imports.test.ts`: after upload, poll session until terminal
  (FakeAnthropic resolves in ms); add checks for the 409 guards and the
  retry-returns-same-session behavior.

---

## 2.3 Import executor batching (week 2–3)

All inside `api/src/admin/import-executor.ts`; preview/commit single-code-path
and blocker semantics unchanged.

- **Prefetch** at `ExecCtx` init (3 queries replace per-row existence SELECTs):
  - properties: `select id, lower(name) … group-aware` — build
    `Map<lowerName, id | 'AMBIGUOUS'>` (preserve the `limit 2` ambiguity
    semantics: names with >1 live row map to a sentinel that triggers the
    existing `ambiguous_match` blocker).
  - areas: keyed `propertyId::kind::lowerName`, same ambiguity sentinel.
  - tenants: keyed `lowerName`, first-by-created_at (matches today's
    `order by created_at asc limit 1`).
  - Rows created during the run keep using the existing in-memory caches.
  - leases/rent_schedules/tenancies existence checks are per-(tenancy,key) and
    rarer — leave per-row in v1; revisit if the benchmark says otherwise.
- **Provenance buffering**: `provenance()` pushes to an array; flush every 500
  and at end-of-run via
  `insert into import_provenance … select * from unnest($1::uuid[], …)`.
- **Blocker persistence**: `persistRowBlockers()` becomes one
  `update … from (select unnest(...) ) v` statement plus the existing clear.
- **Benchmark (in the PR description)**: synthetic 10k-row CSV through
  preview; report query count (wrap `client.query` with a counter in the test)
  and wall clock before/after. Target ≥10× fewer round trips. This also
  shrinks the per-account audit advisory-lock window (Phase 3 ADR input).

### Tests
- `test:imports` must pass unchanged (semantics frozen). Add one case seeding
  two same-named live properties → still `ambiguous_match`.

---

## 2.4 Mutating-request round-trip reduction (week 3)

### Membership TTL cache — `api/src/middleware/account-context.ts`
- `Map<'userId:accountId', { role, expiresAt }>`, TTL via env
  `MEMBERSHIP_CACHE_TTL_MS` (default 45000; 0 disables), positive hits only,
  size-capped at 10k (clear-all on overflow — simplest correct eviction).
- Safe because RLS is the actual guard: a stale entry cannot read or write
  anything the DB refuses; staleness only delays the 404 convenience.
- Export `_clearMembershipCacheForTests()`.

### Idempotency RPCs — migration + `api/src/middleware/idempotency.ts`
- `claim_idempotency_key(p_account_id, p_key, p_fingerprint)` (SECURITY
  INVOKER — existing member RLS on `idempotency_keys` applies): single
  statement `insert … on conflict do nothing returning`, falling back to
  selecting the existing row; returns
  `(claimed bool, fingerprint_matches bool, in_flight bool, status_code int, body jsonb)`.
  Collapses today's claim + conflict-refetch (2 round trips, 3 in the race
  path) into 1.
- `complete_idempotency_key(p_account_id, p_key, p_status, p_body)` and the
  5xx path keeps its DELETE (rare; not worth an RPC).
- The middleware's behavior matrix is frozen: fingerprint mismatch 409,
  in-flight 409, replay served verbatim, 5xx deletes the placeholder. Port the
  file's comment block into the migration as the RPC spec.

### Tests
- api-isolation's idempotency checks must pass unchanged. Add: membership
  cache disabled via env in cross-account tests (or assert 404 still immediate
  after a revocation by clearing the cache seam).

---

## 2.5 Vitest migration (alongside, incremental)

- Root devDep `vitest`; `api/vitest.config.ts` (node environment,
  `test/**/*.spec.ts`).
- Port `test/auth.test.ts` and `test/envelope.test.ts` as exemplars
  (`*.spec.ts`, keep the originals' env-bootstrap pattern as a shared
  `test/helpers/env.ts`).
- CI `check` job: add `pnpm --filter ./api test:unit` (`vitest run`). The tsx
  integration scripts stay until individually ported — no big-bang.
- All NEW tests in this phase are specs where they don't need the live stack.

---

## Verification (phase exit)

1. `pnpm check` green; spec/SDK regenerated for the 202 contract.
2. Full integration tier green locally (`supabase start` + all suites),
   including the updated phase10/imports flows.
3. Load check: two concurrent large exports + traffic → no OOM, flat p95.
4. 10k-row import benchmark recorded (queries + wall clock, before/after).
5. FE confirmed against the 202/poll contracts **before** deploy (the one
   outward-facing break). Deploy via the validated path: migrations first
   (`bash` script via pooler URL), then manual Render deploy trigger
   (autoDeploy flag is unreliable — see prod-deploy-topology note 2026-06-11),
   then healthz + logs.

## Out of scope (explicitly)

- Multi-instance worker / jobs table with `SKIP LOCKED` (Phase 3, triggered by
  instance count > 1).
- Chain-watermark sweep optimization (Phase 3 item 2 — pull forward only if
  the Phase 1 logs show `verify_chain_sweep` duration growing).
- Auth rate limiting (still deferred).
