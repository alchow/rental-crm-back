# Agent Notes

Explain changes simply. Prefer concrete data-flow examples.

## Start Here

- Read `README.md` for setup and the repository map.
- Read `docs/architecture.md` for the current system. Historical plans are not
  architecture references; `docs/README.md` classifies every document.
- Read only the domain files needed for the task. Do not start with generated
  contracts or the full migration history.

## Repository Map

- `api/src/app.ts`: middleware order and route assembly.
- `api/src/routes/`: caller-JWT HTTP routes and request/response schemas.
- `api/src/admin/`: privileged capabilities, service-role access, workers, and
  storage/PDF/import implementations.
- `api/src/middleware/`: authentication, account membership, principal,
  immediate-parent, timeout, and idempotency guards.
- `db/supabase/migrations/`: forward-only database change history.
- `api/src/supabase/database.types.ts`: generated current DB shape; never edit.
- `openapi/openapi.json` and `sdk/src/generated/types.ts`: generated API
  contract; never edit directly.
- `api/test/test-manifest.json`: source of truth for API test classification and
  CI integration ordering.

## Load-Bearing Rules

- RLS is the authorization floor. Request handlers use the caller's JWT through
  `getSb(c)`; service-role client construction stays in `api/src/admin/`.
- Account-scoped routes flow like this:
  `JWT -> requireAccountMembership -> getSb(c) -> account_id filter -> DB/RLS`.
- Public token routes derive account scope from a verified token, never from
  client-supplied account data.
- Mutations that create evidence preserve audit truth. Example:
  `send intent -> comm_outbox -> provider -> complete_send -> interaction`.
- Soft deletes are updates. Use `softDeleteStamp()` so `deleted_at` and
  `updated_at` advance together.
- Large PostgREST `IN` lookups must be chunked. Example:
  `400 ids -> 4 queries of 100 -> merge rows`.
- Keep request schemas, route registration, and handlers in the same domain
  module or directory. Prefer registrar modules like `routes/comms.ts` over one
  file containing several sub-apps.

## Sources of Truth and Change Flows

- HTTP contract:
  `route Zod schema -> OpenAPI emit -> generated SDK -> guide/reference update`.
- Database shape:
  `new migration -> local reset/apply -> generate database types -> API code`.
- Evidence mutation:
  `intent/fact -> DB invariant/RPC -> audit event -> read model -> integration test`.
- New integration behavior:
  `test file -> api/package.json test:* script -> test-manifest classification -> CI`.

Do not broaden shared schemas casually; generated OpenAPI/SDK diffs can be
large. Prefer a targeted response schema unless the whole client contract
should change.

## Database Changes

- Migrations are forward-only. Never edit a migration that may have been
  applied outside your local database.
- Migration versions must be unique and lexically greater than the current
  repository maximum. The repository contains deliberately future-allocated
  versions, so today's wall-clock timestamp may sort too early.
- Every account-scoped table needs an `account_id` ownership path, force-RLS,
  an account-membership policy, and account-safe foreign keys.
- Security-definer functions must set a safe `search_path`, validate scope
  internally, and have explicit grants. Keep the definer-grant test green.
- After a migration, run `pnpm db:generate` against a fully migrated local
  stack and commit both generated artifacts. CI runs `pnpm check:db-generated`
  against its freshly migrated integration stack.

## Checks

- `pnpm check` is the local/CI fast preflight: static checks, architectural
  guards, generated-contract drift, test-manifest validation, Vitest, and the
  production bundle smoke test.
- `pnpm check:static` skips Vitest and the bundle when iterating on prose or
  scripts.
- Live-Supabase integration tests are classified in
  `api/test/test-manifest.json`; run them with
  `pnpm --filter ./api ci:integration` after starting the local stack.
- Handwritten API source files are capped at 1,000 lines. Split a growing
  domain behind a stable facade instead of raising the cap.
- `test:imports-live` is manual because it uses real Anthropic credentials.
- When adding a guard, wire it into `check:static`; CI calls `pnpm check`
  directly so local and CI-fast behavior cannot diverge.

## Documentation Rules

- `docs/architecture.md` describes what exists now.
- ADRs explain durable decisions and must state whether they are current,
  superseded, or historical.
- Plans and cross-team replies preserve decision history; do not treat them as
  current implementation instructions unless `docs/README.md` says they are.
- If a guide table documents an endpoint, it must exist in OpenAPI. The guide
  drift check is one-way, so update the guide deliberately when adding routes.
- If `api/src/env.ts` adds a production operator setting, add it to
  `render.yaml` or explicitly exclude it in the Render env drift guard.

Leave short comments where a rule is architectural rather than obvious from
syntax. Comments should explain why a boundary exists, not narrate the code.
