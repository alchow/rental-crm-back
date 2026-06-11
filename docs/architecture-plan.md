# Architecture review & phased improvement plan

- **Status:** Phases 0 and 1 EXECUTED on 2026-06-11 (all items except the
  Phase 1 stretch goal: auth rate limiting, and Sentry — structured
  logging/error trails shipped instead; add a DSN-backed tracker when an
  account exists). Phases 2 and 3 remain planned.
- **Date:** 2026-06-11
- **Scope reviewed:** full API surface (app assembly, middleware, all routes, admin/privileged layer, import pipeline), all 17 migrations, CI/deploy configs, contract pipeline
- **Dimensions:** Performance / Maintainability / Scalability, with effort estimates

## What's already strong (don't touch)

Composite-FK account scoping mirrored by force-RLS with a CI leak test that proves
its own meaningfulness; the service-role quarantine (ESLint + grep gate); the
contract-drift gates (OpenAPI/SDK/guide); the single-code-path preview/commit
import executor; the tamper-evident audit chain. The plan builds *around* these
invariants, not through them.

The gaps cluster in four places: **request-path efficiency**, **synchronous heavy
work in handlers**, **operational hardening**, and **boilerplate that will rot as
routes multiply**.

---

# Findings inventory

## 1. Correctness-adjacent quick wins

| # | Finding | Perf | Maint | Scale | Effort |
|---|---|---|---|---|---|
| 1.1 | Validation-error envelope inconsistency | — | **High** | — | Small |
| 1.2 | Ledger fetches `payment_allocations` account-wide | **High** | Low | **Med** | Small |
| 1.3 | Global request body limit missing | Med | — | **High** (resilience) | Tiny |
| 1.4 | No graceful shutdown | — | **Med** | Med | Tiny |
| 1.5 | Node version pinning contradiction | — | **Med** | — | Trivial |
| 1.6 | `PATCH /imports/:id/rows` is an N+1 update loop | **Med** | Low | Low | Small |

- **1.1** Only the root app and `importsApp` (`api/src/routes/imports.ts:366`) pass a
  `defaultHook`; the other ~24 sub-apps construct bare `new OpenAPIHono()`. Per the
  project's own comment in `api/src/routes/_lib/error.ts:5`, hooks don't inherit
  across `.route()` mounts — so validation failures on properties/tenants/payments/etc.
  return zod-openapi's default shape, not the `{error:{code,message,details}}` envelope.
  Live contract violation.
- **1.2** `api/src/routes/ledger.ts:149` pulls *every* allocation in the account and
  filters in JS, plus O(n×m) `chargeRows.find()` in the allocation loop. Worst query
  in the codebase.
- **1.3** No `bodyLimit` middleware anywhere. `parseBody()`/`json()` buffer the whole
  body before any size check (the import route's 20 MiB check fires after full
  buffering); unauthenticated endpoints (`/v1/auth/*`, `/v1/intake/:token`) accept
  arbitrary-size bodies. Memory-DoS on a 512 MB instance.
- **1.4** No SIGTERM handler; Render sends it every deploy. `closePool()`
  (`api/src/admin/db-pool.ts:52`) exists but is never called.
- **1.5** `.nvmrc`=22, `engines`>=22, but `render.yaml` pins `NODE_VERSION: "20"`.
- **1.6** `api/src/routes/imports.ts:704` — one UPDATE per row id, sequential.

## 2. Request-path performance

| # | Finding | Perf | Maint | Scale | Effort |
|---|---|---|---|---|---|
| 2.1 | 4–6 PostgREST HTTP round trips per mutating request | **High** (latency) | — | **Med** | Medium |
| 2.2 | New `SupabaseClient` constructed 2–4× per request | Low–Med | Med (positive) | Low | Small |
| 2.3 | Missing composite indexes for keyset pagination | Med now, **High** later | — | **High** | Small |
| 2.4 | RLS `is_account_member()` is a correlated per-row EXISTS | Med at scale | — | Med | Small |
| 2.5 | `interactions_with_chain` computes `is_head` via join | Low now, Med later | — | Med | Defer |

- **2.1** A single authenticated POST: JWKS verify → membership SELECT → possibly
  immediate-parent SELECT → idempotency INSERT claim → handler query → idempotency
  completion UPDATE. Each is an HTTPS call to Supabase. Mitigations: short-TTL
  membership cache (safe because **RLS is the real guard**), and merging the
  idempotency claim/complete choreography into RPCs.
- **2.2** `getUserClient()` is called in each middleware + handler. Memoize per
  request on context.
- **2.3** Lists order by `(created_at, id)` filtered by `account_id` +
  `deleted_at is null`, but only single-column `account_id` indexes exist. Also
  `import_rows` has no index matching its `(session_id, region_index, row_index)`
  keyset.
- **2.4** Standard Supabase optimization — `account_id IN (SELECT account_id FROM
  account_members WHERE user_id = (select auth.uid()) ...)` — lets the planner hash
  one subquery instead of probing per row. Benchmark before adopting.
- **2.5** `latest_only=true` filters on a join-computed column; unindexable by
  construction. Decision, not surprise, when journals get long.

## 3. Heavy work in request handlers (the main scalability theme)

| # | Finding | Perf | Maint | Scale | Effort |
|---|---|---|---|---|---|
| 3.1 | Evidence-export PDF built synchronously in POST | **High** (tail) | Med | **High** | Medium–Large |
| 3.2 | Import upload runs 2–3 Opus calls inside one HTTP request | Med | Med | **High** | Medium |
| 3.3 | Import executor: row-by-row SQL inside one txn | **High** (imports) | — | **Med** | Medium |
| 3.4 | Import preview/commit holds the per-account audit lock for its whole run | — | — | **High** | Medium (design) |
| 3.5 | `events` growth: full before+after JSONB, no retention/partition plan | — | — | Med–High (horizon) | Plan now |

- **3.1** `POST /evidence-exports` builds the whole bundle in-request: unbounded
  reads (full event chain via O(history) `verify_chain`, every photo in memory),
  artifact capped at 200 MiB, single Node process, ~512 MB RAM. OOM risk; most
  important architectural change.
- **3.2** `POST /imports` runs parse → recognize → re-slice → recognize → per-entity
  mapping (Opus, effort:high) before responding; minutes-long requests, proxy
  timeouts, double LLM spend on client retry. The status machine already exists —
  finish the async design.
- **3.3** Several sequential queries per row + per-entity provenance INSERT +
  per-blocker UPDATE loop. 50k-row sheet ≈ 150k+ round trips in one transaction.
- **3.4** First audited INSERT acquires `pg_advisory_xact_lock(account_chain)`
  (`_emit_event`, phase-3 migration) and holds it **to COMMIT — including previews**.
  A big preview blocks every write in the account, intake included.
- **3.5** `verify_chain` re-walks from event #1; phase-11 sweep does this per account
  per tick. Needs a verified watermark + partitioning/retention decision.

## 4. Operational hardening & dependencies

| # | Finding | Perf | Maint | Scale | Effort |
|---|---|---|---|---|---|
| 4.1 | `xlsx` 0.18.5 parses untrusted uploads | — | **High** (security) | — | Small–Med |
| 4.2 | No structured logging / request IDs / metrics | — | **High** | Med | Medium |
| 4.3 | Prod runs `tsx src/index.ts` (runtime transpile) | Low–Med | Med | Low | Small |
| 4.4 | Cursor values interpolated into PostgREST `.or()` strings | Low | Med | — | Small |
| 4.5 | No rate limiting on `/v1/auth/*` | — | Low | Low | Small |

- **4.1** npm `xlsx` is abandoned at 0.18.5 with known CVEs (prototype pollution
  CVE-2023-30533, ReDoS CVE-2024-22363; fixes ship only via SheetJS CDN ≥0.19.3) —
  and it parses attacker-supplied files. Highest-priority dependency action.
- **4.2** `console.*` only; no request correlation, latency numbers, or error tracker.
- **4.3** `tsx` in prod deps; what runs in prod isn't the artifact CI typechecks.
- **4.4** Client-controlled base64 cursors interpolated into `.or()`; malformed
  values 500 instead of 400; silently-ignored bad cursor restarts at page 1.
- **4.5** GoTrue has its own limits; reusing `bump_ip_rate_bucket` is cheap symmetry.

## 5. Maintainability: duplication

| # | Finding | Perf | Maint | Scale | Effort |
|---|---|---|---|---|---|
| 5.1 | Keyset-pagination logic copy-pasted ~14× | — | **High** | — | Small |
| 5.2 | CRUD route boilerplate (~2k duplicated lines) | — | **Med–High** | — | Medium |
| 5.3 | Tests are bespoke `tsx` scripts, no runner | — | **Med–High** | — | Medium (incremental) |
| 5.4 | `z.any()` / `Record<string, unknown>` in import session shapes | — | Med | — | Small–Med |

- **5.1** Extract one `keysetPage()` helper — 80% of the win of a CRUD factory at 20%
  of the risk. Do before 5.2.
- **5.2** A typed CRUD factory could remove ~2k lines, but explicitness is part of why
  the contract gates work. Default: don't, unless route count keeps growing.
- **5.4** `ImportSession.regions/recognition/mapping` are `z.array(z.any())` → the
  generated SDK hands the FE `any` for the shapes the import UI lives on. The TS
  types already exist in `import-catalog.ts` / `import-parser.ts`.

---

# Phase 0 — Correctness & safety quick wins

**Goal:** fix the live contract bug, the worst query, the cheap operational hazards.
**Effort:** 2–4 days. **Dependencies:** none.

### Work items (in order)

1. **Unify validation-error envelopes** — `api/src/routes/_lib/error.ts` + all routes
   - Add `newApiApp()` factory in `_lib/` returning `new OpenAPIHono({ defaultHook })`
     delegating to `validationFailure()`.
   - Replace all ~25 bare `new OpenAPIHono()` constructions (`properties.ts:151`,
     `tenants.ts:122`, …, `admin/intake.ts:294`); `imports.ts` and `app.ts` use the
     factory too.
   - ESLint/grep gate banning direct `new OpenAPIHono(` outside `_lib/`.
2. **Fix ledger allocation query** — `api/src/routes/ledger.ts:146–165`
   - Fetch allocations with `.in('charge_id', chargeIds)` (chunk at ~200 ids);
     replace `chargeRows.find()` with a `Map` built once.
3. **Body limits** — `api/src/app.ts`
   - Hono `bodyLimit`: ~25 MB on `POST /v1/accounts/:accountId/imports` and
     `POST /v1/intake/:token`; ~1 MB everywhere else. Standard envelope on 413.
4. **Graceful shutdown** — `api/src/index.ts`
   - Capture server handle; on SIGTERM/SIGINT: `server.close()`, `await closePool()`,
     force-exit after 10 s.
5. **Node pin** — `render.yaml` → `NODE_VERSION: "22"`.
6. **Batch `PATCH /imports/:id/rows`** — group by `excluded` value; two `.in()` UPDATEs.
7. **Build-to-dist** — `api/package.json`, `render.yaml`
   - ⚠️ ESM + extensionless relative imports means plain `tsc` output won't run under
     Node ESM. Use `tsup`/esbuild to emit bundled `dist/index.js`; `start` becomes
     `node dist/index.js`; `tsx` back to devDependencies.
8. **Harden cursor decoding** — `_lib/cursor.ts`: validate ISO timestamp + UUID shape.
   (400-on-bad-cursor behavior lands with Phase 1's pagination helper, once not 14×.)

### Verification / exit criteria
- `pnpm check` green; drift gate forces regenerated spec/SDK if 413 declared.
- New test (write first — fails today): validation failure on `POST /properties`
  returns the standard envelope.
- Ledger regression test: tenancy A's totals unaffected by tenancy B's allocations.
- Manual: 2 MB JSON body → 413; `kill -TERM` → clean exit; Render deploy boots
  Node 22 running `dist/`.

---

# Phase 1 — Dependencies, observability, read-path efficiency

**Goal:** see what production is doing, remove the risky dependency, make pagination
scale-ready. Observability first — Phase 2 is measured against it.
**Effort:** 1.5–2 weeks. **Dependencies:** Phase 0 merged.

### Work items (in order)

1. **Structured logging + request IDs + error tracking**
   - pino behind `_lib/log.ts` (JSON prod, pretty dev); `hono/request-id` mounted
     first; one request-summary line (method, path template, status, ms,
     accountId/userId, request-id).
   - Sentry (or equivalent) in `onError` + `unhandledRejection`/`uncaughtException`;
     `SENTRY_DSN` optional in `env.ts`.
   - Convert the ~13 existing `console.*` call sites; keep their messages (HEIC
     warnings, import-LLM salvage logs encode operational knowledge).
2. **Replace/patch `xlsx`** — `api/src/admin/import-parser.ts`
   - Step 1 (now): pin patched SheetJS CDN tarball (0.20.x) via package.json
     resolution — API-compatible, closes the CVEs.
   - Step 2 (evaluate): `exceljs` for `.xlsx`/`.csv`; it does **not** read legacy
     `.xls` — keep patched SheetJS for `.xls` only, or drop `.xls` (product decision).
3. **Per-request Supabase client memoization** — `getSb(c)` accessor memoized via
   `c.set`; sweep middleware + handlers.
4. **Keyset pagination helper + 400-on-bad-cursor** — `_lib/cursor.ts`
   - `keysetPage({query, cursor, limit})`: decode → validate (400 `invalid_request`
     when a supplied cursor is invalid) → `.or()` → fetch limit+1 → slice → encode.
   - Refactor ~14 list handlers; rows-endpoint `(region_index, row_index)` variant
     in the same file.
5. **Pagination/index migration** — new `db/supabase/migrations/` file
   - `(account_id, created_at, id) WHERE deleted_at IS NULL` on: properties, areas,
     tenants, tenancies, leases, charges, payments, interactions,
     maintenance_requests, import_sessions.
   - `import_rows (session_id, region_index, row_index)`.
   - Plain `CREATE INDEX` fine at current size; comment that future adds on grown
     tables need `CONCURRENTLY` outside a transaction.
6. **Type the import-session JSONB contract** — replace `z.array(z.any())` with the
   real schemas; regenerate spec + SDK (drift gate enforces commit); removes most
   `Record<string, unknown>` casting in `imports.ts`.
7. **(Stretch) Auth rate limiting** — reuse `bump_ip_rate_bucket` with `scope='auth'`.

### Verification / exit criteria
- All test tiers green incl. isolation meaningfulness check.
- A prod request traceable end-to-end by request-id; a thrown error reaches the
  error tracker with that id.
- `EXPLAIN` on a paginated list: index range scan, no sort node.
- SDK diff reviewed with the frontend (types tighten from `any` to real shapes).

---

# Phase 2 — Get heavy work out of request handlers

> Detailed, file-level implementation plan: `docs/phase-2-implementation.md`
> (written 2026-06-11, supersedes the summary below where they differ).

**Goal:** no handler builds a 200 MB artifact or waits on multi-minute LLM calls;
imports stop being O(rows) round trips; mutating-request latency drops.
**Effort:** 3–4 weeks. **Dependencies:** Phase 1 (metrics, typed import contract).
Items 1/2 share job infrastructure — build it once. Land 2.1 before 2.2 (exports
are the OOM risk).

### Work items

1. **Job infrastructure + async evidence exports**
   - Migration: add `status ('queued'|'running'|'done'|'failed')` + `error` to
     `evidence_exports`; backfill `'done'`.
   - v1 runner: in-process queue, **concurrency 1**; on boot mark stale
     queued/running rows failed (crash recovery).
   - `POST` → insert queued row, enqueue, return **202**; `GET` exposes status;
     `download` 409 until done. Spec + SDK regenerate; coordinate FE poll loop.
   - In `buildEvidenceExport`: photos fetched/embedded one at a time, buffers
     released; 200 MB cap aborts to `failed`, never OOMs.
   - v2 (when metrics demand): Render background worker consuming a jobs table with
     `FOR UPDATE SKIP LOCKED`. v1 schema must already support this.
2. **Async import recognition** — upload handler: validate → create session
   (`status='parsing'`) → archive bytes → **respond 201**; background job does
   parse → recognize → re-slice → persist rows → terminal status. Idempotency
   middleware caches the early-return session (correct: retry gets same session,
   then polls). Update `test:imports` to poll; FakeAnthropic seam unaffected.
3. **Import executor batching** — `api/src/admin/import-executor.ts`
   - Prefetch session caches up front (one SELECT each: live properties, areas,
     tenants → name-keyed maps).
   - Buffer provenance rows (`provenance()`, line 304) + row blockers
     (`persistRowBlockers()`, line 906); flush via `INSERT ... SELECT unnest(...)`
     / UPDATE-from-VALUES.
   - Benchmark 10k-row synthetic sheet before/after (target ≥10× fewer round trips);
     also shrinks the audit-lock window (Phase 3 item 1).
4. **Mutating-request round-trip reduction**
   - Membership TTL cache (30–60 s, key `userId:accountId`, positive hits only,
     size-capped, env flag to disable). Safe: RLS is the actual guard.
   - Idempotency RPCs (`claim_idempotency_key`, `complete_idempotency_key`)
     replacing INSERT-claim + conflict-refetch + completion-UPDATE. Preserve the
     full behavior matrix: fingerprint mismatch 409, in-flight 409, replay cached,
     5xx delete-placeholder.
5. **Test runner migration (incremental)** — vitest at workspace root; port
   `auth.test.ts` as exemplar; all new tests on the runner; CI keeps old tsx steps
   until each file is ported.

### Verification / exit criteria
- Load check on starter-size instance: two concurrent large exports + normal
  traffic → no OOM; p95 of unrelated routes unaffected (Phase 1 metrics prove it).
- 10k-row import: wall-clock + query-count improvement recorded in the PR.
- `test:imports`, `test:phase10` updated and green; FE confirmed against the new
  202/poll contracts before deploy (the one outward-facing breaking change —
  version or feature-flag if FE can't move in lockstep).

---

# Phase 3 — Strategic design decisions (ADRs now, build when triggered)

**Goal:** the constraints that are fine today but expensive to discover under load.
Each is an ADR (e.g. `docs/adr/`) with explicit trigger metrics, observable thanks
to Phase 1. Don't build speculatively.
**Effort:** ~1 week of ADR writing; build items sized when triggered.

1. **ADR: per-account audit-chain write lock** (`_emit_event`)
   - Document: first audited write takes the advisory lock and holds to COMMIT —
     an import preview serializes all account writes, intake included.
   - Options: (a) accept + document; (b) chunked import transactions (changes
     preview-rollback semantics); (c) deferred chaining — writes append events with
     a per-account sequence, background chainer computes hashes in order
     (tamper-evidence lag of seconds; biggest win).
   - **Trigger:** lock-wait p95 > 1 s on `events_chain:*`, or any intake failure
     during an import.
2. **ADR + build: `events` growth — verified watermark and retention**
   - Build now (small): `chain_watermarks` (account_id, last_verified_event_id,
     event_hash, position, verified_at); incremental `verify_chain`; sweep becomes
     O(new events). Export banner wording ("verified from watermark") is an
     evidentiary decision — confirm with product owner.
   - ADR for later: monthly declarative partitioning (partition key must join the
     PK — design needed); diff-only payloads for `updated` events (lean: keep full
     payloads, partition instead).
   - **Trigger:** sweep > 30 s for any account, or `events` > 10 GB.
3. **ADR + benchmark: RLS policy form**
   - Seed 100k+ interactions in one account; `EXPLAIN ANALYZE` per-row EXISTS vs.
     `IN (SELECT …)` initplan form on `events` / `interactions`. Adopt on ≥20% win.
     The CI planted-leak meaningfulness check guards a botched rewrite.
   - **Trigger:** run the benchmark once during this phase; decide on data.
4. **ADR: CRUD route factory — default no**
   - Phases 0/1 already extracted the high-churn duplication. A factory only pays
     if ≥5 more plain-CRUD resources are planned; it costs explicitness.
   - **Trigger:** roadmap adds a batch of flat resources; otherwise close as
     "rejected — revisit at 35+ routes."
5. **ADR: horizontal scale-out checklist**
   - Mostly stateless. Exceptions to enumerate: Phase 2 in-process job runner (must
     move to jobs-table worker before instance count > 1); membership TTL cache
     (safe — RLS backstop); import-health/HEIC probe caches (benign); `pg` pool
     sizing vs. Supabase pooler limits at N instances.
   - **Trigger:** sustained CPU > 70% or p95 SLO breach on the single instance.

### Verification / exit criteria
- Five ADRs merged, each with current state, options, decision-or-trigger, owner.
- Watermark sweep green in `db test:audit` with a new case: tamper *after* the
  watermark still detected; sweep time measured before/after.

---

## Sequencing summary

- **Phase 0** (days): items independent, no design debate; overlap with feature work freely.
- **Phase 1** (1–2 wks): observability early so Phase 2 is measurable.
- **Phase 2** (3–4 wks): 2.1 exports first (OOM risk), then async imports, executor
  batching, round-trip reduction, test runner.
- **Phase 3:** ADRs now; only near-term build is the chain watermark — pull it into
  the tail of Phase 2 if the sweep is already slow in the Phase 1 logs.

One-sentence summary: the security and evidentiary architecture is production-grade;
the work is to stop doing heavy things inside request handlers, cut the per-request
round-trip tax, add operational eyes, and fix the one contract bug (validation
envelopes) and the one risky dependency (`xlsx`) — in roughly that order.
