# ADR-0006: Agent principal is a service-account user, not a static API token

- **Status:** accepted, 2026-06-12; superseded by ADR-0009 for the live
  multi-tenant agent identity model
- **Context owner:** agent-facing API plan (docs/agent-api-plan.md, Workstream B)

> Current-state note: `AGENT_USER_ID` was retired by ADR-0009. The live API
> classifies an agent from the scoped account membership role (`role='agent'`),
> not from an environment variable match. The decision text below is preserved
> as historical context for the June 12, 2026 design.

## Context

A separate AI-agent service must call this API as a first-class, auditable
principal: journal rows must record `author_type = 'agent'`, and the agent
must pass account scoping. The build request asked for "a static `agent` API
token (env/secret-managed), distinct from any user session."

The constraint that decides this: **all authorization in this codebase flows
through Postgres RLS keyed to `account_members` under a verified Supabase
JWT** (`requireAuth` → `requireAccountMembership` → user-scoped client). The
privileged service-role client is deliberately quarantined to `api/src/admin/`
behind an ESLint rule and a CI grep gate; it is the blast radius for every
RLS-bypass mistake.

## Options considered

- **A. Service-account user (chosen).** One machine-owned Supabase auth user
  per environment; membership rows with a new role `'agent'` per serviced
  account; `AGENT_USER_ID` env identifies it. Every existing route,
  middleware, RLS policy, and the idempotency layer work unchanged. The
  chain records `actor = 'user:<agent-uuid>'` (truthful — it IS that
  principal); journal rows carry the explicit, hash-covered
  `author_type = 'agent'`. Per-account scoping falls out of membership rows
  instead of being a deferred TODO.
- **B. Static token + service-role data path.** Matches the request's
  wording, but every agent-callable endpoint would have to run through the
  service-role quarantine (or duplicate handlers into `admin/`), and
  `audit.actor` can only be set transactionally (the intake RPC pattern) —
  so each agent mutation needs an RPC wrapper. Maximum new code in the most
  dangerous part of the codebase, to rebuild scoping RLS already provides.
- **C. Custom-minted JWTs impersonating PostgREST claims.** Forging
  Supabase-shaped tokens outside Supabase auth; rejected outright (key
  management burden, breaks on Supabase JWT changes, indistinguishable from
  an attack in logs).

## Decision

Option A. The request's own framing — "the point is honesty of authorship,
not authorization sophistication" — is satisfied with near-zero new attack
surface. The single classification point is `api/src/middleware/principal.ts`
comparing `auth.userId` to `AGENT_USER_ID`; no other code may make that
comparison.

Seams left for the explicitly out-of-scope items: rotation = Supabase
credential rotation (no core change); per-account enable/disable = membership
row lifecycle; role-aware route authorization = future middleware reading the
same `principal` context value.

## Revisit triggers

- Multiple agent identities per environment (per-landlord agents), or
- a requirement that agent authentication be revocable independently of
  Supabase auth availability, or
- route-level authorization for the `agent` role grows beyond the journal
  firewall and send endpoints.

Then introduce a first-class principals table + token service; the
`principal` middleware contract means callers don't change.
