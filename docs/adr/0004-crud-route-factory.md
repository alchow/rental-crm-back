# ADR-0004: CRUD route factory

- **Status:** REJECTED (revisit trigger below), 2026-06-11

## Context

~14 route files repeat the same list/get/create/patch/soft-delete shape
(~250 lines each). A typed factory (`makeCrudRoutes({table, schemas, ...})`)
could remove ~2k lines.

## Decision

Do not build it. Reasons:

1. **The high-churn duplication is already extracted.** Phases 0–1 removed
   the parts that actually rotted: `newApiApp()` (envelope hook),
   `keysetPage()`/`keysetPageIndexed()` (pagination), `getSb()` (client),
   shared error/cursor helpers. What remains per file is mostly the zod
   schemas and route declarations — which are the *contract*, and the
   explicit per-resource spelling is why the OpenAPI/SDK drift gates and the
   import executor's schema reuse (`CreatePropertyBody` etc.) work so well.
2. **Divergence is the norm, not the exception.** leases, tenancies,
   payments, charges, interactions all carry custom verbs (void, corrections,
   RPC-backed creates). A factory either grows escape hatches until it is a
   second framework, or forces divergent resources out of it — both worse
   than the duplication.
3. The remaining boilerplate is stable: it changes when the contract changes,
   which is exactly when a human should be editing it.

## Revisit trigger

The roadmap adds **≥5 new plain-CRUD resources in one phase** (no custom
verbs, no RPC writes). Then build the factory for those new resources only;
do not retrofit the existing files.
