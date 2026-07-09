# Agent Notes

Explain changes simply. Prefer concrete data-flow examples.

## Load-Bearing Rules

- RLS is the authorization floor. Request handlers use the caller's JWT through
  `getSb(c)`; service-role code stays in `api/src/admin/`.
- Account-scoped routes should flow like this:
  `JWT -> requireAccountMembership -> getSb(c) -> account_id filter -> DB/RLS`.
- Mutations that create evidence should preserve audit truth. Example:
  `send intent -> outbox row -> provider callback -> interaction journal row`.
- Soft deletes are updates. Use `softDeleteStamp()` so both `deleted_at` and
  `updated_at` advance together.
- Large export lookups should chunk `IN` filters. Example:
  `400 interaction ids -> 4 PostgREST queries of 100 ids -> merge rows`.

## Drift Guards

- `pnpm check` is the local preflight. Keep it aligned with CI when adding a
  new guard.
- OpenAPI/SDK drift: update route schemas, then run `pnpm check:drift`.
- API guide drift: if a guide table documents an endpoint, it must exist in
  `openapi/openapi.json`.
- Render env drift: if `api/src/env.ts` adds a production operator knob, add it
  to `render.yaml` or explicitly keep it out of `scripts/check-render-env-drift.mjs`.

## LLM-Friendly Editing

- Prefer small helpers with domain names over copy-pasted route logic.
- Leave short comments where a rule is architectural, not obvious from syntax.
- Do not broaden shared contracts casually; generated OpenAPI/SDK diffs can be
  huge. Prefer targeted route responses unless the whole client contract should
  change.
