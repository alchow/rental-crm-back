# Maintainability review — 2026-09-25

Status: point-in-time review and refactoring record, not an architecture reference.

## Coverage

Repository-wide structural inventory of handwritten TypeScript/JavaScript, with
detailed source review of request middleware, documents, interactions, outbox
creation, import execution, export rendering, and the SDK/CLI. Test setup and
operational checks were sampled. This is not an exhaustive line-by-line review
of every test, SQL migration, or generated artifact.

## Refactors applied

- **Documents:** replaced the 999-line mixed module with a stable facade and
  focused records, links, public access, query, and shared-contract modules.
  Public token handling is now visible separately from caller-JWT writes.
  Start at `api/src/routes/documents.ts:1`.
- **Interactions:** extracted correction rules, scope resolution, and participant
  helpers. The comms reader now imports the participant helper directly instead
  of the interaction route registrar. New journal rows share their common fields,
  with provenance and kind-specific fields kept explicit.
  Start at `api/src/routes/interactions.ts:1`.
- **Outbox:** reduced the route module from 902 to 101 lines. The handler names
  each step: validate input → authorize → resolve recipients → verify party hints
  → freeze the platform number → insert intent. Validation and query order are
  preserved. Start at `api/src/routes/comms/outbox/create.ts:1`.
- **Comments:** shortened boundary explanations and removed delivery-history
  narration in the changed flows, app assembly, membership/principal middleware,
  and shared error/role helpers. Security and evidence invariants remain local.

## Next priorities

1. **Separate import planning, lookup state, and result recording.** `ExecCtx`
   combines all three with SQL writes in 997 lines
   (`api/src/admin/import-executor/context.ts:51`). Extract cohesive state owners;
   keep the single transaction and preview rollback in `admin/import-executor.ts`.
   Example: mapped row → resolved parents → validated writes → provenance/result.
2. **Split PDF rendering by evidence section.** `renderExportPdf` spans 628 lines
   (`api/src/admin/export-pdf/render.ts:29`). Extract ledger, journal, inspection,
   and photo sections using the existing incident renderer as the pattern.
   Preserve section order, full correction chains, hashes, and missing-photo markers.
3. **Consolidate integration-test plumbing.** Supabase discovery and HTTP request
   helpers repeat across suites (`api/test/documents.test.ts:13`,
   `api/test/interactions-journal.test.ts:44`). Share setup and request transport;
   keep domain fixtures and assertions beside their tests.
4. **Clarify idempotency exception handling before simplifying it.** The caught
   `handlerError` feeds an empty conditional with contradictory rethrow comments
   (`api/src/middleware/idempotency.ts:156`). Add focused tests for thrown errors,
   response capture, and claim cleanup before changing this failure-sensitive path.
5. **Bound document hydration queries.** The query helper loads versions and then
   attachments through unchunked ID lists (`api/src/routes/documents/queries.ts:6`).
   Test multiple versions and large lists, then reuse a general PostgREST chunking
   helper instead of growing another domain-specific implementation.

Keep explicit account filters, caller-JWT access, and domain-specific error codes
visible. A generic CRUD framework would obscure these boundaries. Prefer small,
named operations and types inferred from existing schemas.

## Validation

- `pnpm check`: passed, including 180 unit tests, all static/architectural checks,
  unchanged OpenAPI/SDK output, and the production bundle smoke test.
- `pnpm --filter ./api ci:integration`: all 46 suites passed against local Supabase.
- Compared executable tokens for all five extracted outbox steps and all eleven
  document helpers with the original source; their bodies are unchanged.
- No migrations, generated contracts, dependencies, or production settings changed.
