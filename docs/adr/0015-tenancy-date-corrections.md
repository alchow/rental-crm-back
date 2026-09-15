# ADR-0015: Independent tenancy dates and reasoned corrections

Status: accepted/current implementation. Deployment requires the coordinated rollout
below; no production migration is implied by this document.

## Decision

Possession entitlement, a lease term, a rent era, and actual physical arrival
represent different facts. Existing `start_date` names remain compatible. Old
tenancy dates are marked `legacy_unverified`; we do not infer historical meaning
or rewrite dates to match lease terms. A user may confirm possession meaning.

The database owns correction validation, state transition, stale-context checks,
immutable history, actor attribution, and atomic idempotency completion. HTTP
schemas validate input and expose stable errors. Clients render the server's
preview. The schedule remains the recurring billing instruction. Correcting a
possession fact never changes financial entries.

`tenancy_date_records` captures before/after facts, selected context, reason,
actor, capture time, and source document version/hash references. Explanations
capture unchanged facts and apply only while their fingerprint matches. Existing
audit triggers preserve both domain writes. Public history/feed representations
exclude private idempotency metadata.

The write RPCs execute as `tenancy_date_writer`, a NOLOGIN/NOINHERIT role with
minimal read/column-update grants and no API-role membership. Live membership
is checked inside the command. The date-write trigger checks the execution role,
not a caller-settable session flag. SQL-standard identity/membership bodies bind
`auth.uid` at creation so the narrow role need not resolve the separately owned
Supabase auth schema; the membership predicate is unchanged.

Ordinary recorded endings permit an audited start correction inside their
immutable end bound. Cancelled-before-move-in endings retain their original
start/end relationship and require a separate lifecycle correction design.

## Refactor boundaries

- Tenancy route modules separate CRUD, endings, dates, and history behind a facade.
- Import resolution uses stable IDs and prior-start aliases; multiple candidates
  block instead of selecting the first. Resolver and correction lock account/unit
  identity before tenancy rows. Imports pre-acquire existing-unit locks in order.
- Date mapping distinguishes supplied, invalid, missing, and defaulted values.
- Evidence export has a focused date-history loader/renderer. Date-windowed
  activity still includes complete date context/history.
- Frontend corrections submit the exact reviewed payload and preserve the reason
  when context changes. History exposes the actor, timestamp, and captured evidence.
- The runtime agent's chat-only date skill prepares a typed command plus captured
  review. The deterministic approval plan renders the target and before/after facts;
  only the approved executor sends the command. Generic edits are rejected and stale
  contexts require a new proposal, never an automatic rebase.

## Deployment

Migrations 20260912000004 and 20260912000006 contain expansion/identity binding;
20260912000007 binds preview fingerprints to their account and tenancy;
20260912000005 enforces direct-write protection and updates ending/adoption rules.
The normal migration runner applies them in numerical order. Use a coordinated
maintenance rollout: pause tenancy/import writes, apply the entire batch, deploy
the matching API and callers, verify date context/correction capability, then
resume writes. This API creates rows with the new columns and must not be deployed
against the pre-expansion schema. A zero-downtime expand/contract release would
need a separate compatibility deployment; this batch does not claim to provide it.
Old date PATCH clients receive a correction-required error. Do not run only 04
as a usable correction release: 06 is required on hosted-style auth privileges.

Planned end-date PATCH callers must send the nullable `expected_end_date` captured
when editing began. Core compares it in the UPDATE; stale values return 409
without changing the date or any accompanying status. This is an expected-value
check, not a full revision history or an ABA detector.

Existing dates and money are preserved. New history starts at deployment;
prior audit events are retained without inventing reasons. Rollback disables
the new entry point or uses a forward repair while preserving history/protection.
An old binary relying on unrestricted date UPDATE is not a valid rollback target.

## Verification

API tests cover independent dates, correction previews/history, explanation
staleness and legacy PATCH. DB integration tests cover 13 existing money entries
plus an allocation, retries, concurrent editors, direct-write/role restrictions,
ending differences and audit-chain integrity. Import/adoption and PDF tests
exercise the dependent behavior. The definer-grant allowlist names only the two
authorized mutation wrappers.
