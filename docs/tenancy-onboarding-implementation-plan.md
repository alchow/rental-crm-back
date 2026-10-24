# Tenancy onboarding implementation plan for Sol

Status: the baseline and the resumable-setup/date-warning revision are implemented
in local source; production rollout is not authorized. The revision below
supersedes conflicting baseline requirements for its stated scope. The delivery
notes and original packets preserve the earlier specification. See
`architecture.md` and ADR-0016 for current contracts and boundaries.

## Three-stage UI amendment

The standalone possession-date step is removed. Current onboarding is:

1. Lease and agreed terms, with a compact possession-date summary and Change.
2. Condition record.
3. Rent and deposit setup.

Kickoff already records possession entitlement. Step 1 rechecks its date context
against the saved agreement; only a warning or legacy unverified meaning opens
the shared audited date editor. A normal date requires no second confirmation.
Old possession-step URLs redirect to step 1. Existing date facts, audit records,
and compatibility progress fields remain intact; no migration or fabricated
possession-confirmation write is needed. The four-stage packets below preserve
historical implementation decisions and are superseded on screen count/placement.

Verification: 2,485 frontend unit tests and all 33 affected onboarding, condition,
and tenancy-detail browser journeys pass. TypeScript, structure audit, and the
Render-target production build pass; lint has no errors and two existing warnings.

## Requested revision for resumable setup and date warnings

### Product changes

1. Reopening incomplete onboarding preloads the latest saved, non-voided lease,
   ordered by creation time with an ID tie-breaker, not the latest lease start.
   Continue without edits reuses its ID and creates no lease. Changes use draft
   editing or the existing linked correction workflow, not another unrelated
   agreement. Preserve the original agreement, documents, and financial evidence.
   Update the onboarding selection after a successful correction. Require an
   explicit separate action for a genuine new agreement or renewal.
2. Step 2 condition work is unchanged. Step 3's note is optional, including when
   dates differ. Recording who changed a value, when, and the before/after facts
   does not depend on the landlord providing a justification.
3. Step 4 asks one recurring-rent date question: **First full month to bill**.
   Do not ask for separate billing coverage and regular monthly start dates.
   The implementation uses calendar months: November means November 1–30,
   not a rolling month beginning on a separately chosen day.
4. Future reported actual-arrival dates, actual-ending dates, and rent/deposit
   receipt dates become warnings that can be explicitly confirmed with no note.
   Do not replace these with planned-date or promised-payment records silently.
5. Date differences use the same warning, optional note, Change, and Confirm
   pattern. Valid date syntax, end-before-start checks, account scope, allocation
   caps, duplicate-charge protection, and concurrent-write guards remain errors.
   This revision does not remove the existing safeguards for conflicting billing
   successors, financial reversals, or corrections to executed agreements.

### One full month selection

For the calendar-month variant, choosing November 2026 means November 1–30. Set
both `rent.coverage_start` and `rent.regular_anchor` to `2026-11-01`. Keep the lease
as the agreement basis; do not edit its start to match billing. Default from the
saved lease: its month when it starts on the 1st, otherwise the following month.
Show the exact first period and amount before confirmation.

```text
STEP 4 OF 4
Rent and deposit billing

Lease starts: Oct 1, 2026
Monthly rent: $969.96

First full month to bill
[ November 2026                         v ]

First regular charge covers Nov 1–30.

! This starts after the lease date.
  This schedule will not create October rent.

Note (optional)
[                                        ]

[ Change month ]  [ Confirm this month ]
```

The current two start restrictions are satisfied by construction: the internal
dates are equal and both fall on the 1st. Do not globally remove legacy guards or
rewrite old schedules merely to simplify this screen. This replaces the earlier
proposal to expose arbitrary regular start dates and add month-end fallback rules;
calendar-month starts need neither. Rent due day remains a different contractual
instruction; its current automation limit is not changed by a month picker.

Earlier coverage is neither automatically billed nor waived. Show any gap from
the lease start, preserve existing money, and offer the existing ordinary charge
entry for an earlier one-time amount if the landlord needs it. Do not reopen a
second recurring-start question. Use the existing history/backfill questions for
elapsed months within the chosen recurring schedule. Confirmation of a later
start does not assert that earlier rent was free or already paid.

Keep explicit billing end handling and final partial-period review. If the lease
ends before the selected full month, offer deferral or the ordinary one-time
charge flow rather than presenting a nonexistent full month as billable. The
scope of this simplification is initial onboarding; do not infer new billing eras
or alter existing successor schedules when the setup already has rent history.

Older unsaved drafts may contain independent start dates or non-calendar monthly
periods. Show their original values and the proposed single-month conversion for
review; do not silently erase earlier intended charges, receipts, or allocations.
An unresolved pending commit always recovers its exact original intent and key;
it must never be migrated into a different financial request.

### Shared warning and confirmation pattern

```text
Date entered
       |
       v
Server checks exact values and current saved context
       |
       +--> Invalid record ------> Field error; correct it
       |
       +--> Date warning --------> Explain date and consequence
                                     |
                               Note (optional)
                                     |
                          [ Change ] [ Confirm ]
                              |           |
                         Edit value    Save exact confirmed values
                                       and confirmation history
```

Each warning shows the field, entered value, comparison value/date, and concrete
effect of continuing. Confirm is enabled with an empty note. Change returns focus
to the affected field and preserves the rest of the form. Multiple warnings can
be confirmed together only when each is visible in a clearly labeled review.
The final financial Save is still separate from a provisional editor preview.

Use typed server findings rather than parsing error messages. A finding includes
rule ID and version, affected record or stable draft-row ID, exact values, a
fingerprint, message, and whether confirmation is required. Submit an explicit
acknowledgement with the fingerprint and optional note, not a fake reason string.
The server recomputes findings at commit. A changed date, receipt amount/target,
agreement, resulting status, or material saved context invalidates confirmation.
Recheck the authoritative UTC date across midnight and show that clock basis.

Extend the existing `tenancy_date_records` capability with a distinct warning
confirmation kind and optional notes. Keep confirmation separate from explanation:
no note means confirmed without justification, not explained or legally approved.
Retain actor, recording timestamp, rule/version, exact field values, context,
request identity, and account-safe subject references. Resolve receipt draft IDs
to saved payment IDs in the same financial transaction. A rollback leaves neither
the payment nor its confirmation; retries recover the same records. Do not create
a second generic audit log or a configurable rules language.

### Future dates and their effects

Future dates are accepted after explicit confirmation. Do not silently change
posting or lifecycle semantics as part of removing date prohibitions:

| Entry                          | Required warning consequence                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Future actual arrival          | The entered actual-arrival date is after the app's current date. It is a landlord-reported date, not a system observation. Possession and billing dates stay unchanged.                                                                   |
| Future actual ending           | Recording a new actual ending through the existing End action marks the tenancy ended now and stops automatic rent generation now. Correcting an already recorded ending preserves ended status. Show this before confirmation.           |
| Future rent or deposit receipt | This records a payment now with the entered future receipt date. Allocations affect the current balance now; it does not schedule a bank transfer. A dated statement before the receipt date excludes it under the existing cutoff rules. |

```text
Received date: [ Nov 1, 2026 ]

! This receipt date is in the future.
  Confirming records the $2,000 payment now.
  Applying it to charges changes the current
  balance now; this does not schedule a transfer.

Note (optional)
[                                        ]

[ Change date ]  [ Confirm future date ]
```

A future-effective ending that leaves occupancy current until that date, or a
pending payment excluded from today's balance, is a different feature. Do not
implement either without a separate product decision. The warning-and-confirm
change accepts the entered dates without disguising the existing action's effect.
Do not automatically certify an entry as observed or a payment as bank-cleared
when its entered date arrives.

### Code changes and delivery order

1. **Resume the agreement.** Change FE
   `src/routes/_app/tenancies.$tenancyId.move-in.rent.tsx`, `LeaseWizard.tsx`, and
   `leaseTermsModel.ts` to select and preload the latest saved lease, reuse the
   same lease on unchanged Continue, and reuse `LeaseTermsSheet.tsx`'s draft/edit
   and linked-correction behavior. Handle the lease-save/progress-save boundary
   so a failed progress confirmation does not create another lease on retry.
2. **One month input.** Replace the two start controls in
   `BillingSetupFields.tsx`. In `billingSetupModel.ts`, derive both start values
   from the selected month. Add an optional marker to the existing draft and update
   `tenancy-setup-draft-schema.ts`, draft recovery, and review. Preserve already
   saved version-1/version-2 schedules and the common `_billing_period` calculator.
3. **Shared review.** Extract a small shared warning/confirmation component from
   `DateRelationshipReview.tsx`; use it in possession, actual ending, ordinary
   receipts, and onboarding receipts. Put pure presentation-state transitions in
   one focused helper. Do not overload the invalid-input verdict with warnings.
4. **Authoritative findings and persistence.** Extend Core
   `routes/tenancies/{schemas,dates,date-history,endings}.ts`,
   `routes/billing-setup/schemas.ts`, and `routes/payments.ts` with typed findings
   and acknowledgements. Evolve the existing date-record writer and schema with a
   forward-only migration. Notes can be absent; a blank note must never be a
   manufactured justification. Reuse date/setup previews and add narrow read-only
   preview capabilities for ordinary receipt creation and a new actual ending,
   which do not currently have the same finding contract. Apply the existing
   caller-JWT/account-membership/RLS scope to those previews. Preview paths remain
   read-only; changing an acknowledgement or its note is a changed intent and
   requires a new request key, while transport retries retain their original key.
5. **Remove all relevant future-date refusals.** Replace future-arrival insert
   and correction checks in `_guard_tenancy_date_write` and
   `_preview_tenancy_date_change`, the future-date refusal in `end_tenancy`, and
   the receipt refusal in `preview_billing_setup` with the shared review policy.
   Check bootstrap/import entry points and ending corrections too; do not relax
   unrelated cancellation or date-order rules. Server/RPC writes must validate
   confirmation, rather than accepting a client-only bypass flag.
6. **Unify receipts.** Change FE `paymentVerdict.ts`, `adoptionModel.ts`,
   `PaymentFormCard.tsx`, and setup receipt editors so valid future dates produce
   warnings rather than `notAfter` failures. Ordinary payment entry already calls
   the verdict without `notAfter`; align its currently permissive path with the
   same warning and durable confirmation. Preserve same-account currency and
   allocation checks and atomic payment-plus-allocation writes.
7. **Downstream consistency.** Review ending dialogs, tenancy status projections,
   the rent generator, current ledger/rollup, dated ledger/PDF, exports, import
   execution, and runtime tool contracts. Preserve their current timing semantics
   and render future entries/confirmation history explicitly. Regenerate DB,
   OpenAPI, SDK, and frontend contracts; document the behavior in current guides
   only when it is implemented. Do not edit generated files or applied migrations.

Planning-time source anchors (historical; use current architecture for behavior):

- FE `BillingSetupFields.tsx:124`, `billingSetupModel.ts:82,258`: the two inputs,
  lease defaults, and separate coverage/anchor request fields.
- BE migration `20260912000010_billing_period_foundation.sql:36,103`: shared
  period calculation and existing regular-start constraints.
- FE `adoptionModel.ts:500`, `paymentVerdict.ts:34`,
  `PaymentFormCard.tsx:203`: inconsistent future-receipt acceptance today.
- BE migration `20260912000011_atomic_billing_setup.sql:241,294,315,359`:
  future-receipt rejection, mandatory reasons, existing reason writer, and locked
  commit/re-preview. Required non-date financial explanations are not implicitly
  removed by changing date warnings.
- BE migration `20260912000012_onboarding_date_relationships.sql:186,239,304`:
  arrival insertion/correction guards and mandatory date reason notes.
- BE `db/current-schema.sql:8168,8212`: future ending rejection followed by the
  immediate ended-status write. The generator skips ended tenancies in migration
  `20260912000010_billing_period_foundation.sql:214`.
- BE `api/src/lib/ledger-history.ts:2`, `routes/ledger.ts:307`: no cutoff means
  all current rows; an explicit cutoff excludes later receipt dates.

### Acceptance tests

- Reopen, refresh, back navigation, duplicate click, progress-write failure, and
  two-tab conflict do not create an additional live lease on unchanged Continue.
- November 2026 becomes coverage November 1–30 with both internal starts equal.
  Defaults from first-of-month and mid-month leases, February/leap years, earlier
  or later lease comparisons, history, and final partial coverage are explicit.
- Blank notes allow confirmation for date warnings. Invalid dates, reversed
  ranges, invalid allocations, and conflicting successor schedules remain errors.
- Future arrival works through the audited correction after base tenancy creation;
  direct bootstrap/import writes of future actual arrival require manual review
  rather than bypassing confirmation or silently discarding the entered value.
  Ordinary and setup receipts
  use the same review; new and corrected future endings show their immediate
  effects. Warning notes and confirmations appear in durable history and exports.
- Date/amount/context edits invalidate only affected confirmations. Server
  midnight, stale preview, old tab, failed response, and idempotent retry cannot
  bypass confirmation, duplicate money, or misapply an old acknowledgement.
- Future allocated/unallocated receipts have verified current-balance behavior;
  dated statements before/on their receipt date retain documented cutoff rules.
- Legacy drafts preserve old values until reviewed; unresolved commits retain
  their original request. Existing schedules and charges are not recalculated.
- Run affected unit, API/RPC integration, export, and browser tests on an isolated
  migrated database, then generated-contract, RLS/definer, and normal preflight
  checks. A documentation-only revision does not claim these tests passed.

## Revision delivery and verification

The resumable-setup/date-warning revision is implemented locally:

- Step 1 preloads the latest live saved lease and reuses its ID on unchanged
  Continue. Draft edits and linked executed-agreement corrections share the
  existing agreement editor.
- Step 3 notes are optional. Shared server findings support Change and explicit
  confirmation without a note for date differences and future reported facts.
- Step 4 derives both internal start dates from one calendar-month input. Old
  drafts retain their original intent until explicit conversion; conversion
  previews every unsaved period/allocation selection before clearing it and
  preserves raw receipt input.
- Ordinary receipts, Roll Call, ending dialogs, and onboarding receipts reuse
  the warning review. A pending date/money request locks edits and retries its
  original endpoint, body, acknowledgement snapshots, and idempotency key.
  Reloading a billing draft preserves acknowledgements inside its pending intent.
- Forward migration 15 extends the existing date history with distinct warning
  confirmations and account-safe payment/ending links. The server recomputes
  findings before atomic writes; optional notes are not fabricated justifications.

Verification on October 16, 2026:

- Frontend: 207 files / 2,483 unit tests pass; TypeScript, structure audit, and
  Render-target production build pass. Lint has no errors and two existing warnings.
  The 20 affected browser journeys pass. The final broad browser run passed
  97 of 98 cases; the new mobile ending test used an exact button name that
  omitted the visible subtitle. After correcting that test locator, all four
  ending/provenance browser cases pass, including mobile future-date confirmation
  without a note. No later all-suite run is claimed.
- Core: billing setup, onboarding, date correction/concurrency, ending, ledger,
  auto-charge and direct date-warning integration scripts pass on disposable
  Supabase. The 198 unit tests outside the pre-existing missing-module suite pass.
  Contract, documentation, manifest, source-size and security guards pass.
- `pnpm check` remains blocked by the existing `postgrest-pages.spec.ts` import
  of missing `payment-receipt-dates`. Phase 9/10 HEIC-success cases require image
  transformation disabled in the disposable stack; they are not claimed green.
- Migration 15 was applied forward to the isolated demo without resetting it.
  Tenancy/payment/lease row counts stayed unchanged. The restarted API health
  and frontend return successfully; a member-scoped read-only preview rejects an
  unconfirmed future receipt with `receipt_in_future`.
- No production rollout, commit, or real financial action was performed.

## Baseline local delivery and verification

The implementation uses Core checkout `/Users/albert/.codex/worktrees/abd8/RentalCRMBack`,
the frontend `/Users/albert/Projects/rentalnotesagent`, and runtime `/Users/albert/Projects/RentalAgent`.
The inspection table below retains the original historical source anchors.

- Shared agreement fields save no money. Possession dates use the audited editor,
  including planned and linked actual-end corrections. Initial kickoff still
  requires a possession date; the later question about an unknown date was not
  treated as approval to add an unknown-date lifecycle.
- Four independently resumable stages replace payment/key-gated activation.
  Rent/deposit setup and successor billing use server previews and atomic commits.
  Backfill questions and receipt fields are reused; dates, currencies, partial
  amounts/concessions, credits and reasons remain explicit.
- New schedule and charge snapshots preserve their original basis. Currency
  groups keep rent, deposits, credit, rollup and statement amounts separate.
  No migration creates historical money or changes account-wide charging consent.
- Migrations 08–14 apply in order in an isolated, disposable local Supabase stack.
  Generated database, HTTP and SDK contracts were refreshed. No production
  database, real tenancy record or deployment was changed.

The retirement list in the frontend is: `useLeaseActivation`, the obsolete
`lease-submit` planner and test, the unused `leaseWizardState` reducer (constants
remain), `LeaseDateFields`, `LeaseStartNotice`, `MoveInCelebration`, `AdoptionWizard`
orchestration (its reusable child screens remain), `depositFlow` and its test,
`MoneyRentChangeRecovery`, and `unbilledPeriods` and its test. Old Core money
adapters remain for compatible clients; they are not used for the new setup.

Verification covers database rollback/retry, competing setup/cron requests,
source corrections, 13 preserved ledger entries, due/receipt date independence,
renewal separation, currencies, and shared UI journeys. Full-check limitations
remain explicit: the pre-existing untracked `postgrest-pages.spec.ts` imports a
missing `payment-receipt-dates` module; HEIC-success integration cases require
Storage image conversion unavailable in the isolated local stack; live model
evaluations are not run without credentials. These are not claimed green.

The final safety review also added revision-checked draft saves/deletes and
serialized draft writes. An old tab cannot overwrite a newer pending money
confirmation; an uncertain response reloads read-only and retries the original
intent and request key. Deposit-only setup checks its date relationships too.
Changing only arrival or an end date does not silently verify a legacy possession
date's meaning. Statements preserve the original agreement, notice service date,
or manual explanation attached to a charge.
The shared money parsers reject negative receipt/obligation input rather than
stripping its sign. The explicit opening-balance parser still supports a signed
credit, and its existing regression test passes.

Local checks on October 12, 2026:

- Frontend: 198 unit-test files / 2,443 tests and all 95 browser journeys pass;
  TypeScript and structure audit pass; lint has zero errors and two existing
  warnings. The full browser run used stable source without concurrent edits.
  The final Render-target production build passes.
- Core: the final 14 affected integration scripts pass on the isolated fully
  migrated database; 198 unit tests pass with the pre-existing missing-module
  suite explicitly excluded. Database-generation drift and definer grants pass.
- Runtime: 118 unit-test files / 1,479 tests pass, with 21 files / 138 tests
  skipped by its existing configuration. TypeScript and documentation checks pass.
- Mobile screenshots of all four steps, partial-period review, shared date
  corrections, and lease corrections were visually inspected.

### Independent review follow-up

All nine reported findings have local fixes and regression coverage:

1. Started coverage or already-due rent requires explicit history review,
   including a due-today obligation and supplied overdue future overrides.
2. A restored final review rebuilds and re-previews its exact money intent before
   enabling confirmation. A late baseline read cannot replace that review.
3. Display, matching and allocation targets share one oldest-due-first ordering.
4. Future final partial coverage exposes the same amount/concession editor.
5. Opening balance clears itemized charge selections without discarding typed
   receipt input. Incompatible independent deposit receipts remain visible.
6. An unrelated billing/progress write clears inherited stale possession
   confirmation; an explicitly submitted stale confirmation is still rejected.
7. An explicitly empty explanation scope explains nothing. Genuine legacy
   reasons remain applicable only to unchanged relationship fingerprints.
8. Agreement corrections preserve omitted renewal/amendment lineage and honor
   an explicit null predecessor.
9. Legacy scheduled charges retain optional coverage dates; modern schedules
   retain authoritative period validation and canonical duplicate protection.

Fresh follow-up review found and resolved two additional draft-recovery
regressions: unfinished receipts/opening testimony retain their editable stage,
and a rejected restored review still loads existing-money reuse choices.
Provisional editor previews cannot authorize a financial commit. Fresh source
reviews found no remaining introduced regressions in these fixes; database and
browser regression results above were verified separately.

Build one consistent workflow for lease terms, condition records, possession dates, and rent/deposit setup. Reuse its domain components in existing lease, tenancy, renewal, and money screens. Do not preserve duplicated behavior merely because it exists. Do preserve financial evidence, explicit user decisions, authorization, and safe retries.

This is a multi-repository implementation specification, not permission to deploy, run production migrations, or change real tenancy records. Complete the packets in dependency order. An incomplete packet must not be presented as a completed redesign.

## Plain language summary

The lease records what was agreed. The tenancy records when the tenant is entitled to occupy the unit. Billing records what the software should charge and when. Payments record money actually received. These are related records, not interchangeable dates or actions.

For example: a lease starts November 1; the tenant has agreed early access October 28; November rent is due November 1; the deposit is due October 20 and received October 18. The application keeps all four facts, explains the early-access difference, and does not invent another payment or change the agreement to make the dates match.

The largest simplifications are:

- One lease-terms form, without hidden billing writes.
- One possession-date editor and explanation panel, used in sheets and the wizard.
- One rent/deposit setup controller, with the existing backfill UI adapted into it.
- One authoritative calculation of scheduled rent periods, used by preview, commit, and the generator.
- No key-handover action, paid-rent gate, or second tenancy activation mechanism.
- Thin routes that compose these pieces; no universal wizard framework or generic rules language.

## Scope and source anchors

The source inspection used these local checkouts. These are not assertions about deployed code:

| Repository    | Checkout                                            | HEAD at inspection |
| ------------- | --------------------------------------------------- | ------------------ |
| Core backend  | `/Users/albert/.codex/worktrees/f44f/RentalCRMBack` | `9db9a2f`          |
| Frontend      | `/Users/albert/Projects/rentalnotesagent`           | `55d3597`          |
| Runtime agent | `/Users/albert/Projects/RentalAgent`                | `a7c20f4`          |

All paths prefixed `BE`, `FE`, or `Agent` below are relative to these roots. Line numbers identify the inspected source; locate the named symbol again after edits. Re-read each repository's instructions and current documentation before implementation. Preserve unrelated dirty files, especially the frontend feature map and backend export, error, rollup, and date-concurrency work.

### Existing behavior that determines the plan

| Verified source                                                                                     | Current behavior                                                                                                                                           | Required consequence                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `FE src/lib/lease-submit.ts:47`, `src/components/tenancy/useLeaseActivation.ts:61`                  | A current lease is created as a draft, then a rent change activates it.                                                                                    | Split saving an agreement from applying billing. Do not merely hide the billing date field.                               |
| `FE src/routes/_app/tenancies.$tenancyId.move-in.rent.tsx:38`                                       | Completion can asynchronously create a deposit charge due on tenancy start.                                                                                | Delete this side effect; deposit creation belongs to the explicit money confirmation.                                     |
| `BE api/src/routes/leases.ts:30`, `db/current-schema.sql:1974`                                      | Leases lack due/grace/late-fee terms; the executed-lease guard freezes only selected existing fields.                                                      | Extend both contract and database guards, not just the frontend form.                                                     |
| `BE db/current-schema.sql:9155`                                                                     | Lease correction voids/replaces the lease and re-points schedules without changing billed amounts.                                                         | Preserve correction lineage; preserve the original billing basis separately from the updated display reference.           |
| `FE src/components/tenancy/RenewalSheet.tsx:127`                                                    | Renewal chooses whether to extend lease or tenancy based partly on which end date drives the alert.                                                        | Replace this with explicit agreement, possession, and billing actions. An alert must not choose which legal fact to edit. |
| `FE src/components/tenancy/EditDatesSheet.tsx:115`; `BE api/src/routes/tenancies/records.ts:21`     | The frontend still gates start edits on a clean ledger and uses ordinary PATCH; Core now requires audited corrections.                                     | Migrate all callers to the existing date-context/preview/correction APIs.                                                 |
| `BE api/src/routes/tenancies/dates.ts:8`, `date-history.ts:24`                                      | Core already has selected context, fingerprints, immutable explanations, and document snapshots.                                                           | Extend this model; do not build a second exception log.                                                                   |
| `FE src/components/movein/MoveInKickoff.tsx:96`, `src/api/tenancies.ts:337`                         | Kickoff requires a date; tenancy and primary member are created in two requests.                                                                           | Preserve truthful bootstrap dates, remove duplicate entry, and make creation with the member atomic.                      |
| `FE src/lib/move-in.ts:78`                                                                          | Step completion is inferred from schedule existence and tenancy status.                                                                                    | Separate setup progress from billing and occupancy lifecycle.                                                             |
| `FE src/routes/_app/tenancies.$tenancyId.move-in.money.tsx:121`                                     | First rent uses tenancy start; charge creation supplies only `period_start`; handover PATCHes status active.                                               | Remove the screen's orchestration, incomplete period payload, wrong anchor, and handover mutation.                        |
| `BE db/current-schema.sql:3799`; `api/src/admin/maintenance-janitors.ts:73`, `scheduled-jobs.ts:29` | A scheduled RPC already advances upcoming tenancies by date.                                                                                               | Reuse this lifecycle capability instead of adding a parallel activation service.                                          |
| `FE src/components/money/MoneyAutoChargeSetupForm.tsx:130`                                          | Setup derives a deposit receipt date; some paths clamp rent start and sequentially save schedule/deposit.                                                  | Require actual receipt input, show the real billing start, and replace partial-write orchestration with atomic setup.     |
| `FE src/components/money/adoption/AdoptionWizard.tsx:55`, `adoption/PaymentFields.tsx:1`            | Backfill already composes separate schedule, payment, matching, balance, and confirmation screens; its payment rows already reuse ordinary receipt fields. | Reuse those components and extract orchestration only. Do not rebuild a second history UI.                                |
| `FE src/api/tenancySetupDrafts.ts:132`, `src/lib/tenancy-setup-drafts.functions.ts:55`              | Draft serialization drops deposit receipt date, and its input schema does not include it or the new terms.                                                 | Update both serialization and server validation; test exact resume of all newly collected facts.                          |
| `BE api/src/routes/adoption.ts:27`, `db/current-schema.sql:3563`                                    | Adoption derives periods and refuses schedules or live money already on the tenancy.                                                                       | Reuse the history questions, not blindly the old commit endpoint. Keep adoption's virgin-history protection.              |
| `FE src/components/money/depositFlow.ts:40`                                                         | Deposit receipt creates a charge and payment separately, using receipt date as due date.                                                                   | Separate obligation from receipt and commit a newly collected charge/receipt together.                                    |
| `BE db/current-schema.sql:7640`                                                                     | Generator uses the due-day grid for coverage, creates full amounts, deduplicates by schedule/period, skips ended tenancies, and obeys account opt-in.      | Explicitly model partial coverage and overrides; preserve opt-in and duplicate protection.                                |
| `BE api/src/admin/import-executor/lease-import.ts:27`                                               | Import can default lease dates from new-tenancy dates and inserts lease rows directly.                                                                     | Update imports and database invariants, not only HTTP handlers.                                                           |
| `Agent src/lease-extract/schema.ts:47`, `prompt.ts:8`                                               | Extraction is advisory and lacks lease end, due rule, grace, and fee fields.                                                                               | Extend the extraction contract without converting omissions into invented terms.                                          |

The separate frontend plan `docs/plans/shared-charge-creation-and-recharge-removal.md` is planned, not evidence of completed code. Coordinate with it: use ordinary charge creation for manual corrections; do not recreate special recharge buttons or missing-period recovery warnings. Its frontend period helper can remain a presentation helper, but must not become a competing authority for scheduled billing.

## Approved product requirements

### Step 1 Lease and agreed terms

Keep upload/extraction/manual entry and document provenance. Collect lease start/end or open-ended term, rent amount/currency, rent due rule, grace period, late-fee terms, and security-deposit amount. Remove “New rent starts.” Saving this step creates or updates agreement records only: no schedule, deposit charge, rent charge, or payment.

Unknown grace is not zero. Late-fee states are unknown, no fee, fixed amount, or another written formula. A formula may be recorded without being automated. Displaying a contractual term does not assert that it is legally enforceable. A lease without a scanned document must remain recordable, with its stated source; do not fabricate a signed-document reference.

### Step 2 Condition record

Retain create, upload, and defer. Reuse the existing inspection scratchpad, capture, and document flows. A sent inspection is in progress; a completed inspection or filed condition record is complete; deferred is visibly deferred. No condition action controls occupancy status or rent billing.

### Step 3 Possession date

Use “When can the tenant take possession?” with helper copy: “Record the date the tenant is entitled to occupy the unit under your agreement. Their actual arrival can be different.” Record the agreed date's basis explicitly. Optional actual move-in remains separate and never gates activation.

Show the existing value first. Offer Change, then the shared editor; do not ask users to type the same date again. Present relevant lease/billing comparisons and allow correcting the appropriate fact or keeping the dates with a reason. Corrections preserve existing money.

There is no “Record key handover,” “Go live,” or “Rent must be paid before activation” action.

### Step 4 Rent and deposit setup

Offer independent choices to set up rent and to record a deposit obligation. Either may be deferred. Deposit billing is one-time, not recurring. Rent start/end suggestions come from the selected lease, but remain explicitly confirmed billing instructions.

“Already received money?” opens amount, actual receipt date, method, reference, and allocations. Do not implement a mutable paid checkbox. Support partial and multiple receipts. An existing charge/payment is shown and reused by ID, never recreated merely because the wizard was reopened.

Use the historical questions whenever the preview includes elapsed billing periods, including earlier this month. A one-period history can use a compact view of the same controller. Future recurring charges are handled by the existing generator; advance creation and early payment remain possible. Creation time, due date, coverage, and receipt date must be separately labeled.

Show a final review inside step 4, with exact obligations, periods, payments, future schedule, and explanations. Save the newly collected money facts atomically. Previously saved lease and possession facts are not rolled back when step 4 is abandoned.

## Technical decisions and boundaries

### Keep the existing tenancy bootstrap

The current database/API requires `start_date` before lease and move-in records can reference a tenancy. This plan retains the existing tenant/unit/date kickoff, using the shared possession fields. Step 3 confirms or corrects that same date; it is not a second date-entry requirement. The kickoff must explicitly describe the date's meaning and must not silently submit today's date.

This is a deliberate scope choice, not a claim that the current code can create an undated tenancy. Do not introduce a fake date, nullable date throughout the system, a new draft-tenancy lifecycle, or authoritative records in frontend draft storage. Moving first-ever date collection exclusively to step 3 would require a separate pre-tenancy staging design for steps 1 and 2; that is not hidden inside this refactor.

Add a narrow Core command to create a tenancy and its primary member in one transaction. Reuse the existing tables, validation, account-safe foreign keys, and identity/overlap rules. Existing creation APIs remain available to other clients; the new kickoff uses the atomic command.

### Own agreement terms on the lease and billing instructions on the schedule

Extend the lease with typed agreed terms. Suggested wire shapes, to be finalized in packet 1:

| Field             | Meaning and validation                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `rent_due_rule`   | Discriminated rule: day of month, last day, other written rule, or unknown. Preserve a stated 29th–31st; never silently clamp it to 28. |
| `grace_days`      | Nullable nonnegative integer. Unknown remains null; unsupported automation ranges are not rewritten as contractual facts.               |
| `late_fee_policy` | `unknown`, `none`, `fixed` with positive integer cents/currency, or `other` with the recorded formula text.                             |
| Source metadata   | Human-confirmed source, optional document/version reference, and recording actor/time. Extraction is a suggestion until confirmed.      |

Keep existing term, rent, deposit, document, status, and correction fields. Use a focused lease-terms schema shared by lease create/edit/replace contracts. Do not casually widen unrelated importable schemas. For current deposit amounts that cannot distinguish unknown from none, add an explicit knowledge state for new records; do not reclassify legacy zero values without evidence.

For the initial rollout, automatic monthly billing may retain the existing 1–28 due-day capability. The lease form can record other rules, but setup must say that the rule requires manual billing; it must not promise automation or substitute a supported day. Broader recurrence support is a distinct feature, not an accidental side effect of accepting a lease field.

Schedules remain explicit billing instructions. Add a validated, immutable snapshot of the confirmed billing terms and their source to each new schedule; each generated rent charge captures the applicable policy/basis. This is intentionally duplicated evidence, not two mutable sources of contractual truth. Do not calculate fees for old charges from whichever schedule happens to be current today.

For example: November's charge captures a $50 fixed-fee policy. A January agreement changes the policy to $60. November's stored basis does not become $60. No fee is automatically charged by this redesign.

### Separate save, correction, amendment, and apply billing

Use explicit commands and UI labels:

- Save draft or record confirmed lease terms: no financial write.
- Correct a recorded lease: reasoned replacement using the existing correction lineage.
- Record a renewal/amendment: a new agreement record with its own effective term and a typed predecessor link; do not void a genuine old agreement as if it were a typo.
- Apply billing instructions: a separately confirmed operation against the chosen agreement/notice/manual basis.

Extend executed-lease protection to the newly recorded contractual fields and stop ordinary renewal PATCH from rewriting executed terms. Reuse `replace_lease` for corrections, but preserve the immutable original billing snapshot when a display/source reference is re-pointed. A change that would make the referenced billing inconsistent needs a reviewed billing operation; it must not silently update schedule amounts, policy, or existing charges.

Refactor `change_tenancy_rent` so lease saving does not depend on it and new billing terms do not silently inherit the previous era's due/grace/fee policy. Keep its useful atomic schedule transition and affected-charge evidence. Legacy callers can use a compatibility adapter with existing semantics during migration. The new UI submits a complete, confirmed successor instruction.

Agreement lifecycle selection must also be independent of applying billing: recording a renewal must not accidentally supersede today's agreement early. Use explicit effective terms and selected agreement IDs; do not select a source simply because its rent amount matches. Do not build a new general event-sourcing platform or a second ledger.

### One period calculator and one scheduled charge identity

The current due-day grid is not a complete model of independent coverage and due dates. Extract a small database calculation capability used by setup preview, commit, historical scheduled charges, and generation. A server preview exposes its output to the frontend. Date-picker presentation helpers may exist, but their result cannot authorize scheduled charges.

Represent these inputs explicitly: billing coverage start/end, regular monthly coverage anchor, due-day/first regular due date, amount/currency, and any confirmed first/final partial-period instruction. Store exceptional periods in a narrow schedule-period override structure, not UI flags or a generic recurrence DSL. An override includes a stable cycle identity, coverage start/end, due date, amount, reason, and recording provenance.

Use a canonical cycle key separate from actual covered dates when partial-period coverage differs from the regular cycle. Preserve the existing occupied cycle semantics, including voided scheduled charges, during index migration. A partial interval must not leave a second regular bill available to the cron job for the same cycle. Ordinary manual charges without a schedule remain explicitly manual; do not attach them to today's schedule by guesswork.

Keep calculation and selection separate: calculating a selected monthly interval, selecting elapsed intervals for history, and selecting the next interval for the generator are different named operations over the same period rules. Never use “today's next bill” to infer which historical bill the user intended.

Examples the implementation must support:

- Coverage November 1–30, rent due November 5: due date is not coverage start.
- Coverage begins October 15, first regular period November 1–30: ask for October 15–31 amount/due date, or an explicitly confirmed no-charge concession. Do not infer half rent or skip October silently.
- Coverage ends December 10: show a final December 1–10 instruction requiring confirmed amount or concession. Do not charge December 1–31 merely because the schedule end is after December 1.
- A future November bill created in October stays due in November. An October receipt stays an October receipt.

For existing schedules, preserve their existing due-grid coverage and amounts. Do not reinterpret all historic periods using the new model. Version the period policy so preview and generation know which semantics apply.

### Extend the existing date explanation capability

Keep `tenancy_date_records`, selected-source context, document snapshots, preview, and stale-context protection. Extend their versioned contracts to cover lease and billing starts/ends and deposit obligation dates. Domain-specific commands still own each mutation; a shared evaluator returns findings and accepts reasons. A generic “edit every date” endpoint must not bypass lease or money invariants.

Return structured findings with a stable rule ID/version, affected fields/record IDs, actual values, expected relationship, severity, and existing applicable explanation. Hash the relevant source values and identities; explanations must become historical when their relevant facts change. Store corrections and applicable explanations in the same transaction as the action they justify.

| Situation                                                                        | Response                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| End precedes start for one interval, invalid calendar date, cross-account source | Hard validation failure; a reason does not bypass it.                                                      |
| First lease start differs from agreed possession start                           | Reviewable relationship warning; allow correction or reasoned difference.                                  |
| A renewal lease starts after the original tenancy start                          | Recognize renewal context; do not demand that the original tenancy date be changed.                        |
| Billing coverage falls outside its selected agreement or possession interval     | Show the exact difference and require an explicit basis for a permitted exception.                         |
| Lease, planned possession, and billing end differ                                | Compare the selected facts; never automatically extend all three.                                          |
| Receipt precedes deposit due date                                                | Normal prepayment, not an error by itself.                                                                 |
| Actual receipt or refund happened late                                           | Record the fact honestly; flag relevant timing for review rather than rejecting evidence of a late action. |
| Law-specific deadline cannot be established from available jurisdiction/facts    | “Not evaluated,” not “Compliant.” No guessed nationwide deadline.                                          |

Explain “reason recorded,” never “legally approved.” Suppress repeated prompts only for the same applicable context. Do not compare every renewal against every historic schedule or create a blanket all-dates-equal rule.

Preserve the distinction between a planned tenancy end and an immutable recorded ending. Extend planned-end correction with expected revision/value and history. Corrections to an actual ending require a reasoned, linked correction record, not an ordinary PATCH of the original evidence.

Ending/cancelling a tenancy continues to stop ordinary recurring generation by default. A user explanation does not silently bypass that safeguard. Post-possession liabilities can be recorded through explicit ordinary charges with an agreement basis. Allowing recurring generation after a recorded ending requires a separate explicit capability and is not implied by differing date fields.

### Deposit dates are events rather than a date range

The deposit amount on the agreement, obligation due date, actual receipts, and eventual accounting/refund are distinct. Do not add `deposit_start` and `deposit_end` columns.

Step 4 uses the existing deposit charge, payment, and allocation records. A proposed new obligation has its own due date; receipts have their own dates and amounts. Reuse existing credit only through an explicit allocation, never a second “received” payment. If the obligation due date is unknown, allow recording an unallocated receipt with clear messaging and defer creating a due-dated obligation; never substitute receipt date as the agreed due date.

The shared date context should accommodate deposit disposition events later, but this onboarding change does not invent a refund ledger, escrow-accounting system, or US-wide statutory deadline calculator. Refund/accounting events need their own typed, auditable capability and jurisdiction-specific research before enforcement. Do not claim this four-step release implements those capabilities.

### Lifecycle and progress have different owners

Reuse `advance_tenancy_statuses` and the existing scheduler. Introduce one authoritative effective-status calculation for ordinary upcoming/active transitions, shared by create, date correction, read/filter projections, and materialization. Recorded endings/cancellation and explicit holdover retain priority. Money and setup completion are not inputs.

Use an explicit server calendar date. Preserve the current UTC operational convention for this release, returning `as_of_date`/clock basis with previews; do not make different browsers choose different billing branches. Do not describe this as activation at the property's local midnight. Property-local clock support requires an explicit IANA timezone policy and is a separate capability. Test UTC/US date boundaries and delayed jobs. Read/filter projections must not show contradictory occupancy merely because the daily materialization has not run yet.

Persist only progress decisions that cannot be derived from domain records: condition deferred, selected agreement, step confirmation against a revision, rent/deposit deferred. A small account-scoped onboarding-progress row can hold those decisions. Completion is derived from facts plus those decisions; do not maintain a second mutable balance, paid state, or occupancy status there. A lease/date change invalidates only the confirmations it affects.

Ephemeral draft storage remains for unsaved form input, not legal facts or durable completion. Reuse the existing `tenancySetupDrafts` facade and server gate rather than adding another autosave service. Its setup-draft TTL is 90 days (`FE src/lib/tenancy-setup-drafts.functions.ts:13`), distinct from the generic drafts store. Draft unavailability must show a recovery message without blocking already saved domain records. Saved documents, inspections, lease terms, and money cannot depend on an expiring UI draft surviving.

## Atomic money setup contract

Create a narrow module under `BE api/src/routes/billing-setup/`, registered through the normal caller-JWT stack. Proposed endpoints are tenancy-scoped `billing-setup/preview` and `billing-setup/commit`; these names are proposals, not existing API routes.

The preview accepts desired changes, reads authoritative state, and returns:

- Applicable agreement/notice and immutable terms snapshot; existing schedule, obligations, receipts, and allocatable credit.
- Server `as_of_date`, policy version, context revision/fingerprint, and setup mode.
- Exact charge candidates with stable draft keys, both coverage dates where applicable, due dates, and integer amounts/currencies.
- Existing record IDs that will be reused; explicit payment/allocation proposals.
- Date/term findings, required reasons, and whether account-level automatic charging is enabled.
- What will be written now, what is deferred, and the next scheduled action. Preview itself writes no financial facts.

The commit sends the same typed intent, expected context, explanations, and a stable idempotency key. The server recomputes and validates; a hash supplied by a client is not authority. Resolve new allocation references by draft key, existing references by verified ID. Validate that allocations do not exceed either receipt availability or charge balance, including pending writes in this transaction. Preserve separately recorded deposit/rent currencies and reject cross-currency allocation; never sum unlike currencies into one total.

Use these modes, classified by the server rather than a frontend `virginTimeline` boolean:

| State                                                                          | Permitted operation                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No schedule or live financial history                                          | Full initial setup with itemized history or an explicitly confirmed opening balance, never both. Reuse adoption's testimony and invariants. |
| Only an existing deposit or unrelated one-time money; no rent schedule/history | Initial rent setup with itemized rent facts, reusing existing deposit/payment IDs. No opening-balance re-foundation.                        |
| Existing rent schedule, adoption, rent charges, or ambiguous history           | Show current setup. Use explicit schedule transition/manual charge/payment actions; do not rerun initial history adoption.                  |
| Deposit-only setup                                                             | One-time obligation and optional receipts; no rent schedule required.                                                                       |
| Both choices deferred                                                          | Save progress decisions only; no financial rows.                                                                                            |

Keep the old adoption endpoint's strict guard while migrating callers. Extract shared transaction primitives and have the new command deliberately support the second mode; do not simply remove the old virgin check. Refuse ambiguous history instead of interpreting missing setup flags as permission to adopt again.

Commit all newly requested schedule/charge/payment/allocation/history/explanation/progress records in one database transaction. Complete the durable idempotency response in that transaction, following the date-command pattern. On a dropped response, retry the identical key/payload and recover the original IDs; do not generate a new key each click. A changed payload is a new reviewed operation.

Audit the lock order across setup, ordinary charge/payment writers, rent changes, lease replacements, and the generator. The existing adoption function explicitly leaves a race with plain charge/payment inserts. Fix that boundary with shared per-tenancy financial serialization and consistent lock ordering, not a client refetch. Recheck eligibility under the lock. Prove concurrent generation/receipt/second setup cannot create an extra obligation or overallocate. Preserve account isolation and existing role restrictions.

Do not enable automatic charges for the whole account as a side effect of one tenancy's setup. If the account switch is off, the review says the schedule is configured but automatic generation is paused; changing the account setting is a separately scoped, explicit action. An explicitly confirmed immediate bill may still be created without promising future cron work.

## Shared frontend structure

Use domain folders within the existing component organization, not another application framework. File names below describe proposed ownership and may be adapted to repository naming conventions.

| Shared unit                                                  | Responsibility                                                                                                                                                   | Callers to migrate                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `LeaseTermsFields` and `leaseTermsModel`                     | Controlled values, field validation, parse/serialize, provenance labels; no money mutation.                                                                      | LeaseWizard, LeaseTermsSheet, lease creation, step 1, renewal/amendment.                        |
| `useLeaseEditor`                                             | Explicit create/draft-edit/correct/amend command, upload association and retry identity.                                                                         | Thin page and sheet wrappers; replaces billing-oriented lease activation orchestration.         |
| `TenancyDateFields`, `TenancyDatesEditor`, `useTenancyDates` | Shared input fields; existing server context/preview/commit; reasons and conflicts.                                                                              | Kickoff fields, step 3, EditDatesSheet, MoveInHub inline editing, unit tenancy panel.           |
| `DateRelationshipReview`                                     | Render server findings, record reasons, show source and stale-context recovery.                                                                                  | Lease confirmation, date editing, billing setup, renewal/end flows.                             |
| `BillingSetup` and `useBillingSetup`                         | One reducer/controller for deposit/rent/history/review/save; explicit intent and durable retry state.                                                            | Step 4, first-time Money setup, direct backfill entry.                                          |
| Existing `adoption/` screens and history model               | Reuse ScheduleSteps, PaymentsStep, PaymentReviewSteps, BalanceSteps, ConfirmSteps, and their existing receipt fields; remove independent final-submit ownership. | Embedded setup and standalone history wrapper using the same controller.                        |
| Existing `PaymentReceivedFields`                             | Actual receipt data and shared validation.                                                                                                                       | New setup receipt rows, ordinary payment form, deposit receipt and compatible roll-call fields. |
| Existing `ChargeFormCard`                                    | Ordinary manual charge entry, complete rent coverage where required.                                                                                             | Money, extra-charge actions, manual post-ending liabilities. No recharge mode.                  |

Do not merge normal payment recording, batch rent roll-call, and adoption into one giant component. They share field components and server validation, but have different transaction boundaries and progress behavior. Do not mount a second independently submitting wizard inside step 4.

Routes supply resource IDs and navigation; controllers own mutation/preview/retry; fields render values/errors; Core owns financial/lifecycle decisions. Use discriminated states such as `editing`, `previewing`, `reviewing`, `committing`, `conflict`, and `saved`. Derive totals and completion from the relevant authoritative response, not redundant boolean combinations.

Preserve dirty input when a conflict arrives, refresh authoritative context, and require re-review. Do not silently reseed edited fields when a query refetches. Autosave only explicitly unsaved draft data, schema-version it, and never replay a persisted financial commit as though it were an unsaved draft.

## Implementation packets

### Packet 0 Characterization and contract inventory

Before changing behavior, add tests that expose the current lease-to-billing coupling, one-sided rent period, duplicate date editors, inherited policy, and deposit partial-write path. Establish a baseline for existing tests; identify pre-existing failures separately.

Trace every writer and reader of lease due/grace/fee terms, tenancy status/date, schedule boundaries, and adoption. Include direct SQL imports, cron, SDK/CLI examples, runtime extraction, and frontend caches. Inspect both current source and tests; plans are not implementation evidence. Compare the shared-charge plan and retain its intentional removal of recharge behavior.

Deliver a short ownership map and compatibility matrix in the new ADR. Record exact API/schema generation commands. No application refactor is complete in this packet.

### Packet 1 Agreement model and independent saving

Dependencies: packet 0.

Primary files: `BE api/src/routes/leases.ts`, focused lease schema modules, `api/src/schemas/importable.ts`, new forward migration; `FE src/lib/lease-submit.ts`, `LeaseWizard.tsx`, `LeaseTermsSheet.tsx`, `useLeaseActivation.ts`, step-1 route.

Add typed terms, knowledge/provenance states, correction/amendment semantics, guards, and immutable billing-basis support. Make lease creation/confirmation independent of rent changes. Reuse shared lease fields in creation and correction before deleting the old controller. Preserve upload failures and same-operation retries without creating duplicate leases.

Delete step 1's asynchronous deposit creation. Keep financial state unchanged when a lease is saved. Update lease lifecycle selection and renewal callers so removing rent-change activation does not strand leases as drafts or activate future renewals early.

Acceptance: save a $2,200 lease with $4,400 deposit, due day 1, five grace days, and a recorded $50 fee; lease facts persist with zero new money rows. A missing fee remains unknown. Correcting an executed record preserves its prior version and old billing basis.

### Packet 2 Shared dates and lifecycle

Dependencies: packet 1's contract shape; existing date commands remain the foundation.

Primary files: `BE api/src/routes/tenancies/{schemas,dates,date-history,records,endings,rpc}.ts`, current date RPCs and lifecycle function through new migrations, scheduled-job capability; `FE src/api/tenancies.ts`, `EditDatesSheet.tsx`, `MoveInKickoff.tsx`, `MoveInHub.tsx`, `UnitTenancyPanel.tsx`, `RenewalSheet.tsx`.

Add frontend bindings for existing date APIs before building new screens. Remove `moneyClean` gating and ordinary PATCH of changed start dates. Extend explanation context and planned-end updates. Implement atomic tenancy/member creation and shared effective status. Keep actual endings on the evidence path.

Replace renewal's alert-driven field selection with explicit “record agreement,” “change planned possession end,” and “update billing” choices. A lease renewal does not automatically end possession; a possession correction does not change a lease. Remove stale warnings instructing landlords to void all money to correct dates.

Acceptance: a start correction with live charges succeeds through audited preview/commit, leaves amounts/payments unchanged, and updates all relevant occupancy views. A stale tab conflicts. A future date cannot be bypassed by the old handover status PATCH. Existing ended/holdover cases retain their intended lifecycle.

### Packet 3 Billing period and transaction foundation

Dependencies: packets 1 and 2.

Primary files: `BE api/src/routes/billing-setup/` (new), `adoption.ts`, `rent-schedules.ts`, `charges.ts`, `payments.ts` and allocation owners as needed, `api/src/admin/rent-charges.ts`; new database functions/constraints; existing ledger and integration suites.

Implement versioned period policy, narrow partial-period overrides, canonical cycle identity, immutable terms snapshots, shared preview/commit validation, financial locks, and atomic idempotency. Migrate the generator to shared period rules without turning it into an automatic historical backfill job.

Retain legacy period behavior on old schedules. Prevent duplicate cycle creation across manual scheduled creation, setup, and cron. Ordinary unanchored manual charges must not be falsely advertised as covered by schedule uniqueness; surface possible overlap for explicit review when starting a schedule.

Implement server-classified setup modes. Keep opening-balance testimony separate from charges and income. Support deposit-only and existing-deposit-plus-new-rent cases without weakening legacy adoption. Respect the account-level generator switch.

Acceptance: failure during any new money write rolls back the whole setup; lost-response retry returns the same IDs; concurrent cron/setup/payment operations preserve one obligation and allocation caps. Both period dates are always present together.

### Packet 4 Consolidate setup and backfill UI

Dependencies: packet 3's generated API contract.

Primary files: `FE src/components/money/{MoneyAutoChargeSetupForm,MoneyAutoChargeSection,adoptionModel,DepositFormCard,depositFlow,PaymentReceivedFields,ChargeFormCard}.tsx/.ts`, `src/components/money/adoption/AdoptionWizard.tsx` and its existing child screens, `src/api/tenancySetupDrafts.ts`, `src/lib/tenancy-setup-drafts.functions.ts`, `src/routes/_app/tenancies.$tenancyId.money_.adopt.tsx`, money API hooks.

Reuse the already-separated history questions and receipt fields; implement one setup controller and one review. Keep useful explicit session defaults in the payment grid, including a human-confirmed “received on due date” shortcut, without silently asserting dates. Replace derived deposit receipt dates, silent start clamping, amount-matched lease anchoring, rent-then-deposit orchestration, and half-written-deposit recovery with explicit previewed intent and atomic commit.

Route wrappers restore a versioned draft by ID/context instead of passing a partially duplicated money object through query parameters. Extend both `SetupDraftPayload` and the server-side `payloadInput` validator to retain independent deposit due/receipt dates, policy/source selection, end bounds, overrides, reasons, and stable draft item keys. A frontend-only type change would still lose fields during server validation. Keep direct URLs usable through a wrapper/redirect; opening an old URL must not perform a write. Resume against current server context, never trust stale eligibility.

Adapt late-policy editing to agreed terms or an explicit recorded manual billing basis. Keep fee confirmation manual. Display policy for the charge's applicable era, not the most recent schedule.

Acceptance: identical inputs from Money setup and step 4 produce equivalent preview/commit payloads. A deposit already recorded is not billed or received again. Leaving before confirmation creates no new money. Same-month history and partial periods are visible.

### Packet 5 Compose the four step wizard and remove obsolete behavior

Dependencies: packets 1, 2, and 4.

Primary files: `FE src/lib/move-in.ts`, `src/components/movein/MoveInHub.tsx`, move-in routes, shared progress/API module, narrowly scoped onboarding-progress storage.

Replace the three-step derived model with four steps. Step 1 completion depends on confirmed agreement/setup choice, not schedule existence. Step 2 distinguishes in-progress, complete, and deferred. Step 3 confirms the current possession revision. Step 4 distinguishes configured, deferred, and needing review independently for rent/deposit.

Delete the Money-in-keys-out controller, paid-rent activation gate, handover dialog/mutation, keys-based progress language, first-rent special charge writer, and celebration assumptions tied to manual status activation. Reuse any ordinary extra-charge or payment entry through its shared component, not copied orchestration. Keep rekey reminders only if they remain a separately identified checklist concern; they are not a fourth financial state or handover prerequisite.

Retain route compatibility for existing bookmarks and drafts. Do not treat an already-active tenant as having completed all onboarding. Preserve existing inspections and documents; replacing a condition record retains the current confirmation/evidence safety behavior.

Acceptance: the four steps work for new, existing, future, partially configured, and resumed tenancies. Completing/deferring billing never changes possession status. There is no separate key-handover action anywhere in this flow.

### Packet 6 Upstream and downstream consistency

Dependencies: relevant prior packets; finish before release.

| Consumer                                       | Required work                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime extraction                             | Update `Agent src/lease-extract/{schema,prompt,engine}.ts`, runtime OpenAPI, frontend `src/lib/lease-extract.ts`, provenance labels, fixtures/evaluations. Extract explicit end/due/grace/fee terms; null/unknown for missing or ambiguous terms. No model-authorized Core mutation. |
| Import mapping/execution                       | Update lease import catalog, preview, executor, validation, and source labels. Do not promote defaulted tenancy dates or legacy schedule policy into confirmed contractual facts.                                                                                                    |
| Renewal and rent change                        | Shared lease fields and billing preview; explicit era selection; no automatic tenancy end extension, inherited policy surprise, or restored recharge workflow.                                                                                                                       |
| Date explanations                              | All editing entry points use the same rules and history; old explanations remain readable when no longer applicable.                                                                                                                                                                 |
| Ledger, rollup, CSV, PDF                       | Keep server balances; render due/coverage/receipt distinctly, preserve void reasons, show relevant date history and recorded source. Do not restate deposit receipts as rent income or opening balances as charges.                                                                  |
| Late-fee suggestions                           | Read applicable recorded terms and uncertainty, retain human confirmation, avoid using a new policy on an old charge.                                                                                                                                                                |
| Portfolio, attention, selection, entity search | Use consistent effective occupancy and separate missing-setup attention from upcoming/active. Ensure recipient selection is not accidentally changed by billing deferral.                                                                                                            |
| Events and caches                              | Extend `FE src/api/events.ts` for new records plus existing money/occupancy/lease invalidators. Event polling supplements mutation invalidation; it does not replace it.                                                                                                             |
| SDK, CLI, runtime Core contracts               | Regenerate from the reviewed Core spec; update examples and handwritten adapters. Do not add agent mutation capabilities solely because new endpoints exist.                                                                                                                         |
| Current docs                                   | Update backend architecture, ADRs, API guide, frontend invariants/feature map, runtime contracts and tests. Mark obsolete plans/history accurately.                                                                                                                                  |

Acceptance: a corrected date or newly configured schedule is consistent after reload across unit, tenant, money, attention, roll-call, search, and evidence views. Notice/communication eligibility and rent-only balances do not accidentally acquire deposit debt or speculative dates.

### Packet 7 Migration rehearsal and release verification

Dependencies: all previous packets.

Use additive schema deployment, then new server capabilities, generated clients, feature cutover, and finally removal of obsolete adapters. Expose a specific capability/version for the new setup contract. New UI against old Core shows an unsupported-capability message; never catch an arbitrary error and retry with the old multi-write path.

No existing money is regenerated by migration. Leave historic lease terms unknown when unsupported by evidence. Preserve legacy schedule policy as legacy billing evidence. Backfill cycle identity/snapshot fields only when the derivation is exact; otherwise retain versioned legacy handling and a review marker. Migration scripts must not manufacture receipts, reasons, consent, or verified possession dates.

Allocate migration versions using the repository's helper and current maximum; this repository has future-allocated versions. Do not edit applied migrations. Fully migrate a local stack, run `pnpm db:generate`, and commit both generated DB artifacts. Every new account-scoped table needs force-RLS, ownership policy, account-safe foreign keys, audit behavior, and explicit function privileges. Keep service-role construction quarantined under `admin/`.

Deployments and production migration execution require their normal authorization outside this planning task. For rollback, disable the new frontend entry point and retain readable new facts; do not reverse schema by dropping evidence or re-enable old writers that cannot represent new policies. Keep a compatible read-only fallback until old writer compatibility is demonstrated.

## Required test matrix

| Scenario                                             | Required result                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Save lease without billing                           | No schedule, charge, payment, or allocation; correct lease status/source.                                                |
| Unknown fee or grace                                 | Unknown stays unknown; no guessed default or proposed fee.                                                               |
| Fixed versus no fee versus formula                   | Distinct round trips; manual review for unsupported computation.                                                         |
| Unsupported due rule                                 | Contract preserved; automation clearly unavailable; no clamping.                                                         |
| Lease correction and genuine renewal                 | Different lineage/meaning; no rewriting old billing basis or early supersession.                                         |
| Early possession or delayed rent                     | Exact comparison plus reason; no date copying or money reset.                                                            |
| Renewal within long tenancy                          | No false demand to move original tenancy start.                                                                          |
| Start change with 13 live money entries              | Audited correction; every charge/payment/allocation retained.                                                            |
| Competing date/source edits                          | Stale context rejected; draft input preserved for re-review.                                                             |
| Invalid interval or foreign-account source           | Rejected by API and DB, even with a reason.                                                                              |
| New tenancy and primary member                       | Atomic creation and stable retry; no orphan created on member failure.                                                   |
| Upcoming date passes, no rent paid                   | Effective active status; no handover click required.                                                                     |
| Date moved forward after active                      | Use reviewed lifecycle outcome; no invisible occupancy flip or money change.                                             |
| Ended/cancelled/holdover                             | Explicit lifecycle facts prevail; wizard cannot reactivate accidentally.                                                 |
| Condition deferred or inspection in progress         | Distinct progress; neither means completed nor blocks status.                                                            |
| Deposit due October 20, received October 18          | Independent facts; no false error for prepayment.                                                                        |
| Deposit $4,400, receipts $1,000 and $3,400           | One obligation, two receipts, correct server balance.                                                                    |
| Separate rent/deposit currencies                     | No mixed-currency totals or allocations.                                                                                 |
| Deposit received with unknown due date               | Honest unallocated receipt; no invented obligation date.                                                                 |
| Existing deposit then initial historical rent setup  | No duplicate deposit; itemized history only if server eligibility permits.                                               |
| Existing rent/adoption                               | No re-adoption or opening-balance overwrite; explicit ordinary correction path.                                          |
| Past start earlier this month                        | Current elapsed period explicitly reviewed; not silently clamped or omitted.                                             |
| Partial first/final period                           | Explicit coverage, amount or concession; no automatic full-month charge.                                                 |
| Due date differs from coverage                       | All views and submitted facts retain both meanings.                                                                      |
| Future schedule and prepayment                       | Correct future obligation and actual early receipt; no duplicate cron charge.                                            |
| Account auto-charge disabled                         | Honest paused schedule state; no hidden account-wide opt-in.                                                             |
| Cron races setup or a second setup                   | One cycle obligation; valid receipts/allocations; no partial commit.                                                     |
| Lost response and retry                              | Same stable operation returns same IDs; no duplicated money.                                                             |
| Voided scheduled cycle                               | Existing history/occupied-slot semantics preserved; no resurrection by cron.                                             |
| Ordinary manual overlapping charge                   | Not falsely protected by schedule index; review/explicit handling.                                                       |
| Opening balance                                      | Mutually exclusive with itemized history; not rent income or a late-fee parent.                                          |
| Later fee-policy change                              | Old charge retains its recorded basis; new charge gets new applicable basis.                                             |
| Cancel/end then outstanding liability                | Recurrence stops by default; explicit charges/receipts remain possible.                                                  |
| UTC and US local date boundary, leap year, month end | Same server preview/commit/generation results; no browser date shift.                                                    |
| Old drafts, URLs, API clients, legacy rows           | Safe versioned handling; no silent writes or false completion.                                                           |
| Edit, autosave, exit, resume                         | Exact deposit receipt/due dates, policy, coverage, reasons, and partial input survive; obsolete context requires review. |
| Role/RLS bypass and direct SQL writer                | Same financial/date invariants; cross-account data inaccessible.                                                         |
| Export and cache reload                              | Evidence remains complete; all views agree with server facts.                                                            |

Use unit tests for pure state/field/period presentation models, local-Supabase integration tests for transactions/guards/concurrency, and hermetic browser tests for navigation, retries, and shared entry points. Do not claim mocked frontend tests establish financial atomicity.

Core gates: `pnpm check`, `pnpm --filter ./api ci:integration` against a fully migrated local stack, generated DB/contract drift checks, and the existing definer-grant/RLS tests. Register new integration scripts in `api/package.json`, `api/test/test-manifest.json`, and CI ordering. Extend existing lease lifecycle, dates/concurrency/endings, adoption, auto-charge, rent-change, ledger, rollup, and export suites rather than replacing them wholesale.

Frontend gates: `bunx tsc --noEmit`, `bun run test`, `bun run lint`, `bun run audit:structure`, `bun run build:render`, and `bun run test:e2e`. Its current `api:types` script downloads production OpenAPI; generate against the reviewed local Core spec during development instead of accidentally restoring stale production types. Keep normal transport/error/refresh hooks.

Runtime gates: read its current instructions, regenerate Core/runtime specs through supported scripts, run docs/lint/typecheck/tests and extraction contract fixtures. Run credentialed model evaluations only when available and authorized; report skipped evaluations separately.

Finish with local screenshots of all four steps, the shared date sheet, lease correction, Money setup, partial-history review, and a stale-context recovery state. Use synthetic local records. Include test results, unresolved limitations, migration/compatibility notes, and the complete deletion list in the handoff.

## Maintainability and deletion checklist

Optimize for predictable ownership and small reviewable changes, not the shortest possible code. This is intended to make human and LLM maintenance easier; it is not a measured claim about LLM performance.

- One schema per domain command; generate clients rather than hand-maintaining duplicate wire interfaces.
- One authoritative period policy, one relationship evaluator, one setup transaction, and shared field components with no hidden writes.
- No all-purpose workflow engine, generic metadata bag for financial facts, or component controlled by many unrelated mode booleans.
- Keep API files below the repository's 1,000-line cap. Split by command/owner, not arbitrary line chunks.
- Co-locate pure models and tests. Add concrete invariant examples, not long comments narrating this migration.
- Delete abandoned controllers and their exclusive state, props, queries, effects, tests, and obsolete success-copy promises after every caller migrates.
- Specifically retire lease-create-then-bill orchestration, move-in deposit side effects, clean-ledger date locks, handover status mutation, special first-rent charge creation, guessed deposit receipt dates, and schedule-then-deposit retries.
- Consolidate existing ordinary charge work with the separate shared-charge plan. Do not restore recharge detection under a new component name.
- Keep legitimate reusable capabilities: uploads/extraction, condition evidence flows, payment fields, manual charges, atomic rent transitions, date history, allocation/void evidence, and the scheduler.
- Re-run searches for removed APIs/props/labels. Delete an old facade only after imports and route compatibility are accounted for.

## Architecture and design references

These sources inform the proposed structure; they do not establish application behavior or substitute for legal review.

- [React state structure guidance](https://react.dev/learn/choosing-the-state-structure) supports removing redundant/contradictory state. Apply it to wizard controllers and progress, while retaining immutable financial snapshots as evidence.
- [GOV.UK form structure guidance](https://www.gov.uk/service-manual/design/form-structure) supports organizing questions around user tasks. Use four clearly named stages and conditional history questions; do not turn internal database entities into extra required steps.
- [Microsoft tactical domain design guidance](https://learn.microsoft.com/en-us/azure/architecture/microservices/model/tactical-domain-driven-design) informs explicit ownership and transaction boundaries. Apply the principles within the existing modular backend; this plan does not call for microservices.

The warning rules here are product consistency rules, not a claim that different dates are unlawful. Legal deadlines and fee enforceability require applicable jurisdiction, facts, and reviewed sources. A documented reason never turns an impermissible action into a permitted one.
