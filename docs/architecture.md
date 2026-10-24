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

New journal records can carry immutable `capture_metadata` describing capture
method, time basis and text basis. The manual maintenance RPC records omitted
report dates as `recorded_default` and copied repair wording as `summary`.
`maintenance_requests_with_reporter` projects these facts and the original
journal `logged_at` through the immutable report link. Its `reporter_withdrawn`
projection follows the original report’s correction chain to its current head.
Direct authenticated inserts cannot supply capture metadata; trusted journal and
capture writers assign it. Historical rows remain
unknown; no capture metadata, text or timestamps are backfilled. Journal and
person-history exports label defaulted times as Recorded and retain an unknown
legacy event time as a stored value with unspecified source.

Maintenance creation commits its repair, optional report, response projection and
idempotency receipt in one caller-JWT/RLS transaction. Retry replays that receipt;
a failed HTTP response cannot delete an already completed receipt.

The `interactions` journal is append-only. Corrections and retractions append a
new row rather than overwriting history. The `events` spine stores immutable,
hash-chained mutation snapshots for audited tables.

Incidents are evidence-grade case records: `incidents` rows freeze their
testimony fields (`description`, `occurred_at`) at the database on capture, and
`incident_items` cite existing records (journal entries, maintenance requests,
notices, inspections) through typed FK slots that are insert + soft-unlink
only. A journal entry cited by a live item is write-blocked on its probative
fields — including retraction — until the citation is unlinked; this is the one
DB-enforced exception to the journal's corrections-append story. Incident
writes require owner/manager at the RLS layer, not just the route guard.

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

Applying existing credit creates one immutable allocation slice with an optional
note and a durable request key. A reasoned reversal preserves that slice and
the original payment; both actions append audit events. Multiple slices may
connect the same payment and charge, subject to serialized amount caps.
`lib/ledger-history.ts` supplies the shared cutoff rule for the ledger and PDF:
receipt/due dates select facts, application timestamps select applications, and
later reversals do not change earlier snapshots. PDF period movements are net
applications, not cash receipts or tax classifications. `rent_rollup()` excludes
reversed allocations using the same current-balance rules.

Charges, payments, allocations, schedules, and rent changes form a subledger.
Balances are derived from immutable/reversible facts rather than mutable total
columns. The ledger groups totals by currency; the account rollup returns one
row per tenancy with `currency_totals`, a primary currency and scalar totals
for that currency only. A paid USD balance does not hide unpaid EUR debt.
Opening-balance testimony is returned separately as `adoption`; it never becomes
a charge, receipt, late-fee parent, or received-income total.

Agreement saving belongs to `routes/leases.ts` and writes only a lease. Due
rules preserve days 1–31, last day, other written text, and unknown. Grace is
nullable; fee policy distinguishes unknown, none, fixed cents/currency, and a
written formula. Deposit knowledge distinguishes unknown from none and a stated
amount. Source and predecessor metadata distinguish manual/document/import
facts, corrections, renewals, and amendments. No contractual term certifies fee
enforceability. Drafts remain editable; executed agreement facts require a
reasoned replacement. Replacement re-points source/display references while
retaining the original immutable billing and charge snapshots. See ADR-0016.

Resumable, whole-tenancy setup belongs to `routes/tenancy-setup/`:

```text
private setup draft + staged upload -> read-only proposed people/agreement/money
  -> final reviewed confirmation -> one transaction creates or updates domain facts
  -> immutable setup testimony + completed session result + idempotency result
```

Saving a session creates no tenancy, person, agreement, charge or receipt. Session
revision checks protect draft saves. Final confirmation instead fingerprints the
explicit setup and live domain context, including existing membership: saving
pending-request metadata cannot invalidate its own review. The exact commit key,
setup and context can therefore be parked before sending. A session GET by ID
also returns a completed result when a response was lost; completed session facts
cannot be rewritten.

The transaction supports new tenancy setup and explicit existing-agreement reuse,
correction, renewal or billing-only work. Existing possession changes call the
audited date-correction command inside the same transaction. Existing money is
reused, not reconstructed; receipt matching uses charge type, currency and due
order, excluding deleted or transition-cancelled charges. Partial periods remain
visible while their amount/concession is unconfirmed. Final input, reviewed facts,
optional notes, actor and server time are inserted into the immutable, audited
`tenancy_setup_confirmations` table. A failure rolls all domain writes and final
testimony back together. Draft keystrokes are not evidence events.
Only the setup command owner can write completion and final testimony; its
function uses the caller's JWT and keeps account RLS. Agreement and monthly
billing inputs are normalized before preview and commit, so saved schedules and
cron use the reviewed due rule. Reusing money still reviews possession against
the selected agreement and retained schedules.

Setup collects people without classifying who is on the lease; membership rows
connect people to tenancies and retain their primary, occupant or guarantor role.

Setup-bound document receipts remain private and usable until their active
session expires. Cleanup first claims expired orphan receipts in the database;
the claim excludes active bindings and prevents concurrent consumption or
rebinding. Original/derived provenance is retained together. Expired drafts cannot
be revived after their uploads become eligible for cleanup. Upload authorization
is checked before privileged storage work.

Billing setup and transitions belong to `routes/billing-setup/`:

```text
confirmed agreement or manual/notice basis -> explicit rent/deposit intent
  -> read-only server preview -> reviewed reasons/history/partial periods
  -> idempotent atomic commit -> schedule + charges + actual receipts
  -> allocations + date explanations + independent progress
```

The database classifies initial, initial-rent-with-existing-money, existing-rent,
deposit-only, and deferred modes. Existing rent history requires an explicit
successor instruction. Newly collected facts commit together under the shared
financial lock; retries recover the same IDs. Selecting an existing deposit or
credit reuses its ID. A missing deposit due date supports an unallocated receipt
without manufacturing an obligation date. Setup never enables the account's
generator switch or changes possession status.

Version-2 and version-3 schedules separate coverage from due dates. `_billing_period` owns the
period calculation for preview, commit, scheduled manual creation, and the
generator. Partial first/final periods require explicit amount/due date or a
reasoned zero-charge concession. Immutable period overrides and canonical cycle
keys keep setup and cron from claiming the same cycle twice, including voided
cycles. Legacy version-1 schedules retain their due-grid periods and amounts.
History review includes coverage already started or an obligation already due,
even if its coverage starts later. Explicit overdue future overrides also require
review; the generator does not recover missed historical obligations.
Complete successor instructions replace billing eras without inheriting omitted
policy; the legacy rent-change adapter retains its compatibility semantics.
Version 3 adds a confirmed day-of-month (1–31) or last-day rule. Its explicit
short-month policy either uses that month's last day or requires a manual period
override. Calendar coverage never shifts to the due day. Grace days are nullable
and nonnegative; longer recorded periods are not silently reduced to 30 days.

Schedules and generated charges capture their applicable terms/basis. No process
automatically charges a late fee; a human confirms an ordinary fee charge linked
through `charges.parent_charge_id`. Other written contractual rules remain
recorded; automated billing needs a separately confirmed calculable monthly rule.
Legacy schedule creation still exposes its day 1–28 compatibility contract.

An explicitly undated setup receipt stores `received_at = null` with
`receipt_date_unknown = true` and records when it was entered separately. Current
balances include it; any dated ledger/PDF cutoff excludes it because its receipt
date is unknown. Neither entry time nor possession start becomes a receipt date.
Receipt date knowledge and entry source are immutable. Setup-entered receipt
dates are frozen as well; corrections use reasoned void/re-record rather than
rewriting the captured provenance. Legacy/manual date-edit semantics are unchanged.

The legacy adoption endpoint retains its virgin-timeline restriction (ADR-0013).
The new setup command also handles initial rent with an existing deposit/credit,
without reopening adoption or overwriting opening testimony. The generator
continues to create the next eligible period rather than historical backfill.

## Imports and Background Work

Tenancy possession facts, lease terms, and rent-effective eras are independent.
`tenancies.start_date` retains its wire name; `start_date_basis` distinguishes
legacy unverified meaning from asserted possession entitlement. Optional actual
move-in is separate. Date corrections and explanations go through the tenancy
date RPCs and append `tenancy_date_records`. Correction and idempotency response
commit together. A dedicated function-owner role authorizes protected date
updates; caller-set flags cannot bypass the guard. See ADR-0015.

The context fingerprint captures selected lease/schedule identities, possession
facts, recorded ending and live deposit due dates. Structured findings carry
their rule/version, involved fields/values, and a relationship fingerprint.
Reasons apply to those exact values; unrelated metadata changes do not erase an
applicable reason. A renewal is not compared against original possession start.
New explanation records mark their scoped format explicitly. An empty scope
explains nothing; only older unscoped records infer their covered relationships
from the saved context.
Planned possession ends use the same revision/context correction command.
Actual ending corrections append `ending_correction` records linked to the
original immutable ending and any prior correction; current views resolve the
latest corrected date. Cancellation constraints and ended status remain intact.
Date corrections never mutate the subledger. Evidence exports
include complete date history alongside current metadata, even when financial
activity has a cutoff. Import resolution considers old-start correction aliases
under the same per-unit identity lock used by corrections.

Date differences and future reported actual arrival, actual ending, and receipt
dates use typed warnings. Preview returns exact values, rule/version, UTC clock,
and a fingerprint; commit recomputes them and requires explicit
`warning_acknowledgements`. Notes are optional. A `warning_confirmation` in
`tenancy_date_records` records acceptance separately from an explanation, with
actor, request identity, captured context, and account-safe payment/ending links.
Confirmation without a note never becomes a justification. Financial commands
and history commit atomically under the existing financial lock; transport retries
return the same saved IDs. The narrow date-writer role retains FORCE-RLS and live
account membership when writing billing setup and reviewed receipt/ending commands.

Future actual ending still ends the tenancy and stops generation immediately.
Future receipts still affect today's allocations/balance immediately; an explicit
ledger/PDF cutoff before the receipt date excludes them. Direct inserts, legacy
RPCs, bootstrap and imports cannot bypass confirmation: unreviewed future facts
fail. Creation/import callers first create the base tenancy, then use the audited
date preview/correction flow to confirm a future reported arrival; no field is
silently rewritten or dropped.

`effective_tenancy_status` uses a UTC calendar date, preserving explicit ended
and holdover states. `tenancy_current`, date context, progress, search, recipient
tenancy selection and rollup use this same projection before the daily job
materializes status. Billing/payment/condition completion is not a lifecycle
input. The atomic bootstrap creates the tenancy and primary member together.
Onboarding progress stores selections, revision confirmations and deferrals;
domain records determine whether condition and billing work exists.
Whole-tenancy setup stages proposed facts before final confirmation rather than
bootstrapping domain records merely to continue editing. The independent
bootstrap, agreement, progress and billing APIs remain available for existing
clients and ordinary work. Condition evidence remains independent of possession
and financial setup. The old standalone possession URL redirects to agreement
setup; compatibility progress does not manufacture a possession confirmation.

Imports separate recognition/mapping from execution. Preview and commit share
the same executor semantics. Lease import requires explicit term start/currency
and preserves agreed due/grace/fee/deposit knowledge; possession dates and schedule
defaults never become contractual facts. Runtime PDF extraction remains advisory
and read-only: omissions stay null/unknown until a human confirms them.
In-process jobs use persisted status rows as the
truth; boot recovery marks orphaned work honestly rather than leaving it
pending forever. Horizontal scale-out requires the checklist in ADR-0005.

Daily jobs (rent-charge generation, evidence retention, maintenance janitors)
are one registry, `api/src/admin/scheduled-jobs.ts`, run in-process by
`admin/scheduler.ts` at fixed UTC times and by hand with
`pnpm --filter ./api job <name>`. Every job is idempotent, so a run lost to a
restart heals on the next one. `/healthz` reports each job's last run;
`SCHEDULED_JOBS_ENABLED=false` stops them. A second API instance would
double-run them — the scheduler assumes one instance. This is separate from
the single-concurrency job queue in `admin/job-runner.ts` (exports, imports),
which is not drained on shutdown; its rows record their own failure.

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

## Phone verification authorization

The agent service owns SMS challenges; Core owns `users.phone` and
`phone_verified_at`. The dedicated confirmation path is:

```text
Current human JWT + dedicated verifier key + immutable challenge proof
  → normal JWT/membership middleware
  → owner-phone confirmation route (human principal only)
  → admin owner-phone-verifier capability
  → atomic key/live-role check + receipt + profile write
```

`POST /v1/accounts/{accountId}/owner-phone-verifications/confirm` derives the
user from the JWT. The request carries `verification_id`, E.164 `phone`, and
original `expires_at`, plus `X-Phone-Verifier-Key-Id`, `X-Phone-Verifier-Secret`,
`X-Correlation-Id`, and `Idempotency-Key: owner-phone-<verification_id>`.
It requires live owner/manager membership and an enabled dedicated verifier
key. It does not consult, create, or restore agent grants.

Generic idempotency middleware exempts this exact route because it would replay
before verifier authentication. The privileged RPC owns the atomic receipt,
keyed by logical verifier identity, user, and challenge UUID; account, phone,
and expiry cannot change on replay. Both credentials and live membership are
checked before returning a receipt. An expired proof cannot first commit, but an
authenticated retry may replay the original result without overwriting a newer
phone. First-commit expiry is at most 10 minutes plus 30 seconds in the future.
Receipts are retained indefinitely (any future cleanup must retain 30 days).

`phone_verifier_keys` is inaccessible to user JWTs; only hashed secrets are
stored. The RPC is executable only through the admin boundary. The profile
trigger blocks raw user writes to the verified column and clears verification
when a raw user changes the phone. The legacy agent-principal endpoint remains
for the agent service's explicit rollout mode. Agent access still gates
assistant messaging and optional automatic SMS linking after verification.

## Person communication history

`tenant_communication_records` is a security-invoker read function over the journal
and its immutable participant cast. It selects person-attributed roots and their
explicit correction chains; it never treats current thread membership as history.
The captured Messages feed filters to SMS/email thread roots and pages on
`(occurred_at, id)` under a creation-time snapshot. Tenant communication exports
reuse the same selection with landlord-entered records included, then render all
pages with the requested timezone. Account authorization remains JWT/RLS for
interactive reads and validated account/tenant scope before the export worker.
