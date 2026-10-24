# ADR-0016: Separate agreements, possession, billing instructions and receipts

Status: accepted/current backend implementation. Production rollout remains a
separate operation. Supersedes the current-instruction portions of ADR-0012–0015
that conflict with the explicit contracts below; legacy adapters remain supported.

## Decision

Each fact has one owner. Lease create/edit/replace owns agreed terms and source
provenance. Tenancy date commands own possession entitlement and actual arrival.
Billing setup/transition commands own confirmed billing instructions and new money.
Payments record actual receipts. Progress records choices and revision confirmations,
not balances or a second occupancy lifecycle.

For example: an agreement begins November 1, early possession begins October 28,
rent covers November 1–30 and is due November 5, and the deposit is due October 20
and received October 18. Those are independent facts. Saving the agreement does
not create a bill or payment, and early receipt does not rewrite the due date.

### Agreement evidence

The lease's typed due/grace/fee terms preserve uncertainty. Missing grace is null,
missing fee is unknown, and absent deposit evidence remains unknown even when a
legacy numeric deposit column contains zero. A stated due day 31 remains 31.
Written formulas are evidence, not executable fee rules or an enforceability claim.
Source metadata records human-confirmed manual/document/import basis and recording
actor/time. Renewals/amendments use their own effective term and predecessor link.

Executed terms, including term end, deposit and new contractual fields, are frozen.
`replace_lease_terms` preserves reasoned correction lineage and updates source/display
references without changing existing money or immutable billing snapshots. A billing
change is reviewed separately. Draft terms remain editable; recording an agreement
does not depend on applying rent billing.

### Billing and transaction boundary

`preview_billing_setup` computes exact proposed obligations, coverage, due dates,
actual receipts, allocations, applicable basis, history and required reasons.
`commit_billing_setup` recomputes against the expected context and writes all newly
collected schedule/charge/payment/allocation/explanation/progress facts in one
transaction, with stable idempotency completion. It reuses existing IDs rather
than recreating deposits or receipts on resume.

Modes distinguish a virgin timeline, existing non-rent money with initial rent,
existing rent, deposit-only and deferral. Legacy adoption retains its strict virgin
guard. Opening balance is mutually exclusive with itemized history and remains
separate, currency-denominated testimony. Initial money with an existing deposit
cannot re-found an opening balance. Setup never changes account-wide auto-charge
consent or possession status.

A transition submits the complete confirmed successor instruction. Its preview
identifies predecessor schedules and affected advance charges; commit ends the old
era and preserves voided evidence. It does not activate/supersede leases or extend
possession automatically. The legacy rent-change endpoint retains its inherited
policy behavior for compatibility; new callers use explicit transition contracts.

### Period and currency ownership

Version-2 schedules use `_billing_period` for coverage/due calculations shared by
preview, commit, generation and scheduled charge validation. Partial first/final
cycles require an explicit override, including a confirmed zero concession.
Cycle identity is independent of truncated coverage; a voided scheduled cycle
remains occupied. Version-1 schedules keep legacy due-grid semantics. No automatic
historical backfill or fee charging is introduced.

Schedules freeze their confirmed basis; charges capture the applicable snapshot.
The ledger and rollup group currencies independently. Primary scalar totals refer
to one currency only; rollup exposes other positive debt explicitly. USD rent paid
in full cannot turn EUR deposit debt into zero or consume CAD credit. Opening
balance stays in `adoption`, outside every charge/payment total and income export.

### Date evidence and occupancy

Planned end-date corrections use the same revision/fingerprint/history transaction
as starts. Actual ending corrections append a linked immutable date record; the
original ending and all earlier corrections remain readable. They preserve ended
status and existing money. Cancellation boundaries remain protected.

Each relationship finding carries its rule/version and exact scoped values.
Explanations suppress only matching relationships. Changing a relevant date/source
requires review; changing unrelated metadata does not erase the reason. Renewals
are not mistaken for changes to original possession start.

`effective_tenancy_status` uses UTC today for upcoming/active projection and preserves
ended/holdover priority. Read views, search, recipient tenancy resolution, rollup,
date context and progress share it before the daily materializer runs. Optional
actual arrival, inspection state, payments and setup completion are not status inputs.
There is no separate handover activation command in this workflow.

## Ownership and compatibility

- Lease schemas/routes: `api/src/schemas/lease-terms.ts`, `api/src/routes/leases.ts`.
- Billing contracts: `api/src/routes/billing-setup/`; migrations 10–11 in the
  `202609120000` allocation define period and transaction capabilities.
- Dates/relationships: `api/src/routes/tenancies/{schemas,dates,date-history,endings}.ts`;
  migration `20260912000012_onboarding_date_relationships.sql`.
- UTC read projection and currency rollup: migrations
  `20260912000013_onboarding_occupancy_reads.sql` and
  `20260912000014_currency_safe_rent_rollup.sql`.
- Import/extraction: imports require explicit contractual dates and currency;
  runtime model suggestions never authorize Core mutation.

Old writer compatibility does not permit silently dropping new terms, replaying
multi-request money setup, or inventing facts. New setup returns version 1. Deploy
additive schema and matching contracts before callers; an old binary with unrestricted
date writes or mutable confirmed policy is not a rollback target. Preserve new facts
and immutable snapshots during rollback. No production migration is authorized here.

## Verification

Local integration tests cover no-money lease save, correction lineage, explicit
policy states, atomic failure/retry, financial serialization, partial cycles,
elapsed current-month history, account opt-out, separate due/receipt dates and
cross-currency allocation rejection. Date tests preserve 13 money entries plus an
allocation through corrections, stale editors, planned ends and linked actual endings.
Read tests simulate a delayed materializer and compare search/recipient/rollup/context
under UTC and cross-account RLS. Import/extraction fixtures preserve missing facts
and copied formulas; credentialed model evaluations are a separate gate.
