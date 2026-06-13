# ADR-0009: Per-account scoped agent tokens (multi-tenant agent principal)

- **Status:** proposed, 2026-06-12
- **Context owner:** agent-facing API plan; resolves the single-agent identity
  seam left open by ADR-0006 ("multiple agent identities" revisit trigger).

## Context

The landlord-agent is going multi-tenant for self-serve launch: one agent acts
on behalf of many accounts. Today (ADR-0006) the agent is a single Supabase
service-account user (`AGENT_USER_ID`) holding one session, a `role='agent'`
member of every served account. That single shared session is a **cross-tenant
blast radius** — anything that obtains it is the agent for all tenants at once —
and it is not revocable per-account independently of Supabase auth. ADR-0006
named "a first-class principals table + token service" as the trigger for
revisiting this; multi-tenant self-serve is that trigger.

The hard constraint is unchanged: **all authorization flows through Postgres RLS
keyed to `account_members` under a verified Supabase JWT**; the data path
forwards the caller's token to PostgREST (`api/src/supabase/user-client.ts`);
`service_role` is quarantined to `api/src/admin/`.

## Options considered

- **A. Per-account service-account users (chosen).** One machine Supabase auth
  user per (agent × account), each a `role='agent'` member of *exactly one*
  account. A root principal authenticates to core and exchanges for a
  short-lived session scoped to one account, minted in `admin/`. RLS, the audit
  chain, the messaging/money RPCs, and the `auth.users` FKs all work unchanged
  because every agent identity is a real UUID user with a real membership row.
  Scope = identity = membership ⇒ **fail-closed per account**.

- **C. Core as a third-party JWT issuer (claim-scoped, no membership).
  Rejected on evidence:**
  - `auth.uid()` casts `sub → uuid` (`db/test/supabase_compat.sql:46-57`, mirrors
    Supabase). A non-UUID `sub` (`agent:root`) throws on *any* evaluation, and
    the audit/chain trigger calls `auth.uid()` on every audited write
    (`phase4_actor_integrity.sql:79-81`) → breaks all agent writes globally.
  - Write hot-paths are membership-keyed and marked load-bearing: messaging RLS
    `m.user_id = auth.uid()` and the send RPC ("do not change",
    `messaging.sql:112-115,172`); money atomicity `is_account_member(auth.uid(),…)`
    (`phase61_money_atomicity.sql`). A membership-less agent fails these without
    forking parallel agent RPCs — the dangerous-code expansion ADR-0006 rejected.
  - `account_members.user_id` is `NOT NULL REFERENCES auth.users(id)`
    (`phase2_schema.sql:46`): a third-party identity with no `auth.users` row
    cannot be a member at all.
  - Net: C requires rewriting the audit trigger, the load-bearing RPCs, and the
    FK model to retire a wart, and depends on a Supabase third-party-auth
    platform feature of unconfirmed availability. A needs no new platform feature.

- **B. Single root user + `account_scope` claim + RLS claim-check. Dominated.**
  The root stays a member of every account, so it fails **open** — any agent
  policy missing the scope predicate leaks cross-tenant. Same project-wide TTL
  wart, plus an awkward per-request custom-claim mint. Dominated by A on safety
  and by A on simplicity.

## Decision

Option A. It kills the shared-session blast radius, gives per-account
grant/revoke independent of the root credential, and changes nothing in the
RLS / audit / RPC / FK substrate.

**Principal classification.** Retire the `AGENT_USER_ID` env match in
`api/src/middleware/principal.ts`; classify `type='agent'` iff the resolved
membership role for the scoped account is `'agent'` (`c.get('account').role`,
already resolved and cached by `requireAccountMembership` — no extra round trip,
`account-context.ts:107`). Non-breaking: the current single agent is already a
`role='agent'` member, so role-match and the old id-match agree for it, and it
generalizes to many agent users for free. The single-classification-point
contract (ADR-0006) holds; every `c.get('principal')` consumer (firewall,
authorship, send) is unchanged.

**Root-principal auth.** A dedicated principal credential held by core
(`agent_principals` table, hashed secret; ideally an asymmetric client
assertion), **not** a Supabase user session. This decouples agent auth from
Supabase auth availability (the second ADR-0006 revisit trigger) and removes the
shared session entirely.

**Endpoints.**
- `POST /v1/agent/tokens` — root-authed; body `{ account_id }`. Verifies an
  active `agent_grants` row, then mints a short-lived Supabase session for that
  account's sub-user via the GoTrue admin API (`generateLink` magiclink →
  `verifyOtp`), entirely in `api/src/admin/` (precedent: `mintIntakeToken`,
  `admin/intake.ts`). `service_role` touches the mint path only, never the data
  path. Returns `{ access_token, refresh_token, expires_in, account_id, scopes }`.
- `GET /v1/agent/accounts` — root-authed discovery for fan-out: the root's
  active grants `[{ account_id, scopes, granted_at, account_name? }]`.
  Independent of any per-account token (chicken/egg).
- `POST /v1/accounts/{accountId}/agent-grants` and `…/revoke` — landlord-facing
  self-serve consent, behind `requireAuth` + `requireAccountMembership`.
  Creating/revoking the grant enables/disables the agent per account,
  independent of the root credential.

## Contract item 1 — token refresh boundary

The agent stays **purely an API client of core**. Steady state: mint once via
`POST /v1/agent/tokens`, then refresh via core's existing
`POST /v1/auth/refresh` (`api/src/routes/auth.ts`) with the returned
`refresh_token` — still only core, no Supabase upstream, no Supabase credentials
at the agent. Re-mint via `/v1/agent/tokens` only on (a) a new account or
(b) refresh failure (refresh token expired/revoked).

Why not re-mint every cycle: the `generateLink`→`verifyOtp` mint is cheap (two
GoTrue admin calls; trivial at thousands), **but each mint creates a new GoTrue
session/refresh token** — re-minting on the access-token interval accumulates
sessions in GoTrue, whereas refresh reuses one. So mint-then-refresh is
preferred operationally and equally honors "agent talks only to core."

Access-token TTL is the Supabase project-wide JWT expiry (default ~1h), not
per-token shortenable — but TTL is **not** the security floor here; revocation
(below), enforced live by RLS, is.

## Contract item 2 — firewall vs. proposal-lifecycle exhaust

From the journal constraints (`20260616000001_journal_authorship_capacity.sql`):

- **Non-approval notes are forbidden by the DB.** An agent `kind='note'`
  *requires* `approved_by` AND `approval_ref` (`interactions_agent_note_approval`,
  lines 102-106). So proposal-lifecycle events must **not** be journaled as
  notes — there is no landlord approval at those moments.
- **Journal lifecycle events as `kind='agent_event'`** (channel/direction/party
  forced to `agent_event`/`none`; body ≤1000, structurally incapable of
  conversational payload — lines 79-109). The app-layer firewall requires
  `approval_ref` on every `agent_event`, but `approval_ref` is the agent-side
  **proposal/task correlation id, not a landlord approval** (migration line 17).
  So lifecycle events set `approval_ref = <proposal/task id>`; only
  `entry_type='proposal_approved'` additionally needs `approved_by`, and
  `step_executed` needs ≥1 entity ref. **Non-approval agent_events are allowed.**
- **Vocabulary additions (confirmed with the agent).** The DB `entry_type`
  whitelist is currently
  `('proposal_created','proposal_approved','proposal_rejected','step_executed')`
  (lines 50-52). Add **four**: `'proposal_failed'`, `'proposal_blocked'`,
  `'resume_target_dead'`, and `'proposal_superseded'` (landlord edits to a
  proposal — distinct from `proposal_rejected`; correlation = the superseded
  proposal's id). Firewall branches: all require `approval_ref` (the correlation
  id), none require `approved_by`, none require an entity ref. Two nuances to
  encode in the firewall:
  - `proposal_failed` has no proposal id — its `approval_ref` correlates to the
    triggering event/task id instead.
  - `step_executed`'s entity reference is not always a maintenance/work-order id;
    broaden the firewall's entity-ref check to also accept an interaction id or
    journal-entry id.

## Mid-flight revocation (binding on both designs)

On revoke, core marks the `agent_grants` row revoked, removes the agent
sub-user's `account_members` row, and SHOULD call GoTrue admin logout for that
sub-user to kill its refresh token. Effects, by immediacy:

1. **Data layer, immediate:** RLS re-checks `account_members` on every query, so
   writes fail and reads return empty under any still-valid access token.
2. **Membership guard, within `MEMBERSHIP_CACHE_TTL_MS`:**
   `requireAccountMembership` returns **404** — this codebase returns 404, not
   403, on membership-miss (`account-context.ts:25,97-101`), to avoid confirming
   account existence to non-members. Positive membership is cached up to the
   TTL; negatives are never cached.
3. **Discovery:** `/v1/agent/accounts` stops listing the account;
   `/v1/agent/tokens` 403/404s for it.

**Agent contract:**
- **404** on an account it was previously operating in → treat as revoked: fail
  the in-flight workflow **closed**, drop the account from the fan-out, stop
  refreshing/re-minting for it.
- **401** → token expired → refresh (or re-mint).
- **5xx / network** → transient → retry with backoff; do *not* drop the account.
- Authoritative truth = `GET /v1/agent/accounts`; re-check on any anomaly.

Note: once revoked the agent can no longer write to that account's journal (the
same RLS locks it), so the terminal lifecycle event lands in the agent's own
store, not core's journal.

## Phased rollout (current single-agent path keeps working until cutover)

0. `resolvePrincipal`: switch `AGENT_USER_ID`-match → `role='agent'` match
   (non-breaking; both agree for today's agent). Retire `AGENT_USER_ID`.
1. Schema: `agent_principals` + `agent_grants` tables; the four `entry_type`
   additions + broadened `step_executed` entity-ref check; firewall branches for
   the new lifecycle entry_types.
2. Landlord grant endpoints (`POST` / `revoke` agent-grants).
3. Root-principal auth + `POST /v1/agent/tokens` (mint in `admin/`) +
   `GET /v1/agent/accounts`.
4. Agent cuts over to discovery + per-account exchange; refresh via
   `/v1/auth/refresh`.
5. Decommission the single root's membership-in-every-account once all served
   accounts are grant-driven.

## Revisit triggers

- Per-landlord (not per-account) agent identities.
- A need to shorten agent access-token TTL below the project-wide JWT expiry —
  would force core-controlled issuance; revisit C with `sub` kept UUID-shaped.
- GoTrue session growth from minting becomes material — add session cleanup / a
  per-sub-user session cap, or switch to a password-grant mint.
