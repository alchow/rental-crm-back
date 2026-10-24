# ADR-0015: Independent tenancy dates and reasoned corrections

Status: accepted/current, amended by ADR-0016 and the onboarding date/read-model
extensions. Deployment requires the coordinated rollout
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
capture unchanged facts and apply only while their scoped relationship fingerprint
matches. A reason applies to the exact account/tenancy, selected agreement, and
involved field values; changing an unrelated update timestamp does not erase it,
but changing a relevant date requires fresh review. Existing
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
Planned end dates use ordinary revisioned date corrections, including clearing a
planned end. An actual recorded ending uses the ending-corrections preview/commit
pair: `changes.end_date` is required and non-null. Future actual dates require an
explicit warning confirmation and preserve ended status. Each
correction appends a record linked to the original immutable ending and prior
correction. Current reads resolve the latest evidence; the original is not edited.
An ended tenancy cannot reopen through a correction.

Date context exposes review findings, UTC `as_of_date`/`clock_basis`, and effective
status. GET/list, search, recipient discovery, date previews, bootstrap, and rent
rollup use the same effective occupancy policy before the daily updater runs.
Explicit ended/holdover statuses take priority over date-derived upcoming/active.
Renewal terms are compared without pretending their term start is original
possession; a deposit due after known possession end is reviewable, while an
early actual receipt alone is not a contradiction.

Date-warning acceptance is separate from justification. Notes on date corrections
and warnings are optional. Explicit acknowledgements bind a rule/version, exact
fields, UTC date, resulting facts and material context. A changed input requires
fresh review. Distinct `warning_confirmation` records retain the actor, time,
context and request identity without labeling an empty note as an explanation.
Future arrival remains landlord-reported; future ending still ends now; future
receipts still affect current balances now. The dated statement cutoff stays in
force. Payment/ending references resolve inside the same transaction as the fact.

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
- Runtime lease extraction is advisory and read-only. Human confirmation in Core's
  reviewed workflow owns these writes; onboarding adds no runtime Core mutation
  capability or inferred date command.

## Deployment

Migrations 20261023000002 and 20261023000004 contain expansion/identity binding;
20261023000005 binds preview fingerprints to their account and tenancy;
20261023000003 enforces direct-write protection and updates ending/adoption rules.
The normal migration runner applies them in numerical order. Use a coordinated
maintenance rollout: pause tenancy/import writes, apply the entire batch, deploy
the matching API and callers, verify date context/correction capability, then
resume writes. This API creates rows with the new columns and must not be deployed
against the pre-expansion schema. A zero-downtime expand/contract release would
need a separate compatibility deployment; this batch does not claim to provide it.
Old date PATCH clients receive a correction-required error. Do not run only 04
as a usable correction release: 06 is required on hosted-style auth privileges.

The onboarding extension adds migrations 20261023000006–12, including relationship
findings and linked actual-ending corrections in 12, canonical read projections
in 13, and currency-safe rollup in 14. Apply the complete source migration set
before generating DB types and deploying matching callers.

Changing possession start or planned end through generic PATCH returns
`date_correction_required`; echoing the unchanged value remains compatible.
The reviewed command checks date revision, full selected-context fingerprint,
and expected resulting status in its audited transaction. A stale context returns
409 without changing facts, money, history, or idempotency completion.

Existing dates and money are preserved. New history starts at deployment;
prior audit events are retained without inventing reasons. Rollback disables
the new entry point or uses a forward repair while preserving history/protection.
An old binary relying on unrestricted date UPDATE is not a valid rollback target.

## Verification

API tests cover independent dates, correction previews/history, explanation
staleness and legacy PATCH. DB integration tests cover 13 existing money entries
plus an allocation, retries, concurrent editors, direct-write/role restrictions,
ending differences, planned ends, immutable ending-correction chains, scoped
explanation applicability, canonical UTC read models, and audit-chain integrity.
Import/adoption and PDF tests exercise the dependent behavior. The definer-grant
allowlist explicitly names the authorized correction/explanation/ending wrappers
and the narrow billing explanation writer; helper functions gain no public write
authority.
