# Current Architecture

This document describes the repository as it exists now. Update it when a
change moves a security boundary, source of truth, or cross-service data flow.
Historical sequencing and rejected alternatives belong in ADRs and plans.

## System Role

The backend is the authoritative state and evidence service. The API accepts
landlord, tenant-link, and agent-service actions; Postgres enforces account
scope and invariants; the audit/event spine records consequential mutations.
External transport services call communications APIs but this repository does
not call SMS/email providers from request handlers.

## Request Boundary

Account-scoped member request:

```text
JWT
  -> requireAuth
  -> requireAccountMembership
  -> resolvePrincipal
  -> optional immediate-parent guard
  -> idempotency middleware
  -> route handler using getSb(c)
  -> account_id filter
  -> PostgREST + RLS
```

`api/src/app.ts` mounts this stack once for `/v1/accounts/:accountId/*`. Route
modules must not recreate or bypass it.

Public token request:

```text
signed/hashed token
  -> admin-quarantined handler verifies token
  -> account and resource scope derived from token row
  -> bounded privileged operation
  -> audited database mutation
```

Public intake, document access, inspection capture, and unsubscribe routes use
this shape. They must not accept authoritative account scope from request JSON.

## Authorization Boundary

RLS is the authorization floor. Member handlers use the caller JWT through
`getSb(c)`. Service-role client construction is quarantined in `api/src/admin/`
and protected by lint plus regression guards. Admin modules expose narrow
capabilities; importing a capability does not authorize a route to construct a
service-role client itself.

Every account-scoped table follows this ownership model:

```text
row.account_id
  -> composite account-safe foreign keys
  -> FORCE ROW LEVEL SECURITY
  -> membership policy using auth.uid()
  -> API account_id filter as defense in depth
```

## Evidence and Events

The `interactions` journal is append-only. Corrections and retractions append a
new row rather than overwriting history. The `events` spine stores immutable,
hash-chained mutation snapshots for audited tables.

Evidence-changing flow:

```text
validated intent/fact
  -> database RPC or constrained row mutation
  -> invariant trigger
  -> domain row(s)
  -> _emit_event audit snapshot
  -> read model / evidence export
```

## Communications

Core owns communications state; an external transport owns provider calls.

```text
caller creates intent
  -> comm_outbox queued row (durable before dialing)
  -> transport claims row
  -> provider accepts or rejects
  -> complete_send / fail_send RPC
  -> confirmed send appends exactly one interaction
  -> later delivery callbacks advance mutable outbox state
```

The atomic `complete_send` RPC is the boundary that prevents both unrecorded
sends and journal rows that falsely claim a send. See ADR-0007.

## Inspections, Documents, and Storage

Inspection templates seed inspections; inspection items/checks become
immutable after completion. Tenant capture links are token-scoped public
capabilities. Generated reports and uploaded documents preserve original
evidence hashes and use private storage with mediated downloads.

Heavy PDF, image, storage, and import implementations live under
`api/src/admin/`. Routes validate caller scope before invoking them.

## Money

Charges, payments, allocations, schedules, and rent changes form a subledger.
Balances are derived from immutable/reversible facts rather than mutable total
columns. Rent changes are anchored to lease/notice instruments and execute
through database transactions that preserve schedule and charge integrity.

## Imports and Background Work

Imports separate recognition/mapping from execution. Preview and commit share
the same executor semantics. In-process jobs use persisted status rows as the
truth; boot recovery marks orphaned work honestly rather than leaving it
pending forever. Horizontal scale-out requires the checklist in ADR-0005.

## Contract Pipeline

```text
route Zod schemas
  -> openapi/emit.ts
  -> openapi/openapi.json
  -> openapi-typescript
  -> sdk/src/generated/types.ts
```

Generated files are committed and checked for drift. The human API guide is
curated and its endpoint-table check is intentionally guide-to-spec only.

## Database Pipeline

```text
forward-only migrations
  -> fully migrated local database
  -> generated schema reference + database.types.ts
  -> typed Supabase clients and RPC calls
```

Migrations are the change history. The generated schema reference is the
preferred way to read the current database because important RPCs may have
several historical definitions across the migration chain.

## Verification Tiers

- `pnpm check:static`: lint, typecheck, architecture guards, and generated-file
  drift.
- `pnpm check`: the CI-fast preflight; adds Vitest and the production bundle.
- API integration manifest: real local Supabase authentication, PostgREST,
  storage, RLS, and RPC behavior.
- DB isolation job: full migration chain plus leak-meaningfulness and audit
  tests against Postgres.

`api/test/test-manifest.json` classifies every API `test:*` script so adding a
test without adding it to CI is a checked failure.
