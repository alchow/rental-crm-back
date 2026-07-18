# Rental CRM Backend

The system of record for a landlord CRM. It is API-first and treats operational
facts—messages, inspections, documents, rent, and maintenance—as auditable
evidence.

## Five-Minute Orientation

1. `api/src/app.ts` assembles the Hono API and its middleware.
2. `api/src/routes/` contains caller-scoped HTTP contracts and handlers.
3. `api/src/admin/` contains privileged capabilities and background work.
4. `db/supabase/migrations/` is the forward-only database history.
5. Route Zod schemas generate `openapi/openapi.json`, which generates the SDK.

Read `docs/architecture.md` before changing a cross-domain flow. Read
`docs/README.md` before relying on an older plan or coordination document.

## Local Setup

Requirements: Node 22, pnpm 11, and the Supabase CLI for integration work.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Fill `.env.local` with local/development values. Never commit credentials.

## Verification

```sh
# Same fast preflight used by CI
pnpm check

# Full API integration tier (requires the local Supabase stack)
cd db && supabase start && cd ..
pnpm --filter ./api ci:integration
cd db && supabase stop --no-backup && cd ..
```

API tests are classified in `api/test/test-manifest.json`. Adding a `test:*`
package script without classifying it makes `pnpm check` fail.

## Common Change Flows

API contract change:

```text
route Zod schema -> handler -> OpenAPI emit -> generated SDK -> guide/tests
```

Database change:

```text
forward-only migration -> local migrated DB -> generated DB types -> route/admin code -> tests
```

Outbound communication:

```text
caller intent -> comm_outbox -> external transport/provider -> complete_send RPC -> interaction journal
```

## Repository Guide

- `api/`: HTTP API, workers, storage, and tests.
- `db/`: Supabase configuration, migrations, and DB-level tests.
- `openapi/`: emitted OpenAPI document and emitter.
- `sdk/`: generated TypeScript client contract.
- `cli/`: reference client using only the SDK.
- `docs/`: current architecture, contracts, runbooks, ADRs, and historical plans.
- `scripts/`: drift guards and guarded operational workflows.

Production migrations and operational scripts are intentionally guarded. Do
not run a production apply command merely to validate a code change.
