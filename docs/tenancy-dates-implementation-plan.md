# Tenancy dates and audited corrections

Status: implemented and locally verified across backend, frontend, and runtime agent.
Production/staging rollout remains an operator step; no deployment was performed.
Prepared: 2026-09-13. Owner: backend CTO/design review.

This is a build specification for Sol agents. Read `AGENTS.md`, `README.md`,
`docs/architecture.md`, and this document before implementing a packet. Source
references below preserve the planning-time checkout; use the current architecture
and ADR-0015 for implemented behavior, not the historical line numbers below.

## Implementation notes (2026-09-14)

- The actual frontend is `/Users/albert/Projects/rentalnotesagent`; the runtime
  API consumer is `/Users/albert/Projects/RentalAgent`. The unrelated
  `/Users/albert/Projects/Rental/rental-os` checkout was not changed.
- Backend checks passed: `pnpm check` (165 unit tests plus static checks/build),
  all 46 API integration scripts, and generated database drift verification.
  A disposable Postgres 16 build also passed the migration chain, definer grants,
  67-table account isolation, audit-chain, and tenancy-status checks.
- The money-preservation test uses 12 charges, one payment, and an allocation.
  It also checks concurrent editors, transaction rollback, durable retry, source
  version snapshots, direct-write protection, and recorded ending boundaries.
- Frontend verification passed: 2,366 unit tests, 11 targeted browser tests,
  typecheck, architecture audit, and production build. Existing unrelated changes
  in that checkout were preserved.
- Runtime verification passed: all 1,596 tests with a disposable migrated database,
  typecheck, lint, documentation checks, both contract generators, and production
  build. The chat-only date skill binds a supplied reason and selected tenancy,
  shows the captured preview in its approval plan, and executes only approved
  commands. Stale commands fail without rebasing; generic edits require a new
  preview/proposal.
- Deployment sequencing below is the original design. The implemented batch
  requires the coordinated maintenance rollout in ADR-0015; do not deploy the
  new-column API against the old schema. No production or staging deployment
  was performed as part of these local implementation checks.

## 1. Product outcome and scope

Record three independent facts: possession entitlement, a lease term, and a
rent schedule's effective period. Correct a mistaken possession record with a
reason and history while preserving valid financial transactions. Explain
differences without declaring them unlawful or automatically aligning dates.

Example: a lease starts May 1, physical arrival is May 5, and a documented May
concession means the regular rent schedule starts June 1. Each fact stays in
its own field. A renewal also has a later term start than the original tenancy.

Implement this plan only after review of the proposal. This planning change
does not authorize production migration or modification of live tenant data.

In scope: database correction boundary; API contracts; date terminology;
imports/adoption; status transitions; evidence exports; generated SDK; client
and agent integration handoff; targeted refactors of those paths.

Excluded: a general workflow engine, a new accounting engine, legal rules by
jurisdiction, automated concessions/proration, retroactive billing generation,
and automatic edits to executed leases. Existing financial correction and
lease-replacement workflows remain their respective domain boundaries.

## 2. Findings that determine the design

| Current source | Finding and implication |
| --- | --- |
| `api/src/routes/tenancies.ts:37`, `:328` | Tenancy start is called move-in; changing it is blocked by any live charge/payment in an API workflow guard. Replace that correction path. |
| `api/src/routes/leases.ts:265` | Lease term start is inserted independently. Preserve this independence. |
| `api/src/routes/rent-schedules.ts:22`, `:443` | Rent schedules emit charges and have their own start. Preserve their lifecycle. |
| `db/current-schema.sql:7413` | Generator uses schedule start/due day, tenancy status/end; it does not use tenancy start. Never add an equality condition here. |
| `db/current-schema.sql:3561` | Daily status advancement uses tenancy start. Preview and apply must explain any status change. |
| `db/current-schema.sql:1782` | A recorded ending freezes start, end, and ended status. Ordinary ended tenancies and cancelled tenancies need different treatment. |
| `api/src/admin/import-executor/context.ts:540`, `:616`, `:696` | Import identity includes start date; lease/schedule dates can default to it. Corrections need identity protection and visible defaults. |
| `db/current-schema.sql:3350`, `api/src/routes/adoption.ts:268` | Adoption rejects a schedule earlier than tenancy start. Remove this cross-date assumption without changing its virgin-ledger rules. |
| `api/src/admin/export-pdf/render.ts:91`, `api/src/admin/export-pdf.ts:542` | PDFs show current tenancy context even with an activity date filter. Expose corrections explicitly. |
| `db/current-schema.sql:1277`, `:15248` | Existing audit spine records before/after snapshots and actor. Reuse it. |
| `api/src/routes/inspections/records.ts:153` | Existing RPC pattern completes an idempotency claim atomically. Reuse its contract. |
| `api/src/app.ts:194` | Nested tenancy paths have an immediate-parent guard. Use `{tenancyId}` consistently. |

Only this backend checkout was inspected. The exact source of the quoted UI
warning and the frontend/agent repository layouts are not established. Packet
S6 begins by finding those callers and confirming their actual files; do not
invent external file paths or claim external refactors are complete here.

## 3. Date vocabulary and compatibility

| Stored field | User label | Definition |
| --- | --- | --- |
| `tenancies.start_date` | Possession start | Recorded date the tenant is entitled or scheduled to become entitled to occupy. It is not a billing instruction. |
| `leases.term_start` | Lease term start | Start of this particular lease term, not signature date. There can be successive leases for one tenancy. |
| `rent_schedules.start_date` | Rent effective from | Start of this particular recurring rent era, not invoice creation time or the date cash was received. |
| New nullable `tenancies.actual_move_in_date` | Actual move-in | Optional physical arrival date; never drives rent generation or tenancy activation. |

Keep existing wire/database names. Avoid a rename migration and duplicate
`possession_start_date` storage. Use explicit labels and schema descriptions.

Add `tenancies.start_date_basis`, enum-like text constrained to
`legacy_unverified | possession_entitlement`, default `legacy_unverified`.
Existing values stay unchanged and unverified. Old clients/imports omitting
the basis remain unverified. Updated creation forms request an explicit date
and send `possession_entitlement` when the user confirms its meaning. This is
a provenance classification, not a legal certification or proof that future
possession has already been delivered. A reviewed unchanged date can confirm
its meaning through the correction command with a basis-only change.

Actual move-in may be null. Do not infer it from old start dates. Require a
valid calendar date no later than the server's UTC date when supplied; a
planned physical move belongs outside this factual field. Differences from
possession or lease dates are informational, including early access cases.

`start_date_basis`, actual move-in, and the authoritative start may be supplied
on creation. After creation they use the reasoned correction command. Date
schema validation uses the existing `CalendarDate`, not a regex-only parser.

## 4. User flows and ASCII mocks

### 4.1 Date card

```text
+--------------------------------------------------------------+
| Tenancy dates                                                |
| Possession start       Jul 01, 2026  [Meaning unverified]      |
| Actual move-in         Not recorded                           |
|                                                              |
| Lease: [Original lease v]     Term starts May 01, 2026         |
| Rent:  [Initial schedule v]   Effective from Jun 01, 2026      |
|                              Due on day 1 of each month      |
|                                                              |
| These dates differ. Confirm what each date represents.        |
| A renewal or concession may explain the difference.           |
|                                                              |
| [Record explanation] [Correct possession record] [History]    |
+--------------------------------------------------------------+
```

Lease/schedule selectors use stable IDs and existing paginated lists. Never
assume there is one lease or one billing start for the entire tenancy. Do not
silently pick the earliest lease as an original lease: imported history may
be incomplete. With no selected lease/schedule, show possession facts and a
selection prompt. Renewal comparisons are informational, never an error badge.

### 4.2 Correction preview

```text
+--------------------------------------------------------------+
| Correct possession record                                    |
| Possession start       Jul 01 -> May 01, 2026                 |
| Meaning                Unverified -> Possession entitlement   |
| Actual move-in         Not recorded -> May 05, 2026            |
| Reason                 [Data entry error v]                  |
| Explanation*           [Keys available May 1; July was typo.] |
| Supporting document    [Select existing document]             |
|                                                              |
| Preview                                                      |
| Status                 Active -> Active                      |
| Money                  13 live entries; 0 will be changed     |
| Review candidates      2 charges overlap the changed period   |
| Lease / rent schedule  No changes                            |
|                                                              |
| [Cancel]                         [Save correction and reason]|
+--------------------------------------------------------------+
```

The 13/2 counts are illustrative. Counts are sampled at the displayed preview
time, not a guaranteed inventory at commit. Review candidates are not declared
invalid, automatically voided, or required to be voided before saving.

If a selected date fact changes before save, show `The dates changed. Refresh
the preview.` Keep the user's unsaved explanation and require a new save.

### 4.3 Explanation without a correction

```text
+--------------------------------------------------------------+
| Explain these dates                                          |
| Possession Jul 1 | Selected lease May 1 | Selected rent Jun 1  |
| Reason       [Other documented arrangement v]                 |
| Explanation* [Describe what each date represents...]          |
| Evidence     [Select existing document]                       |
|                                                              |
| This records an explanation for these specific date values.   |
| [Cancel]                                [Record explanation] |
+--------------------------------------------------------------+
```

Never prefill an invented explanation. If any referenced date/context changes,
the old explanation remains history and the UI requests a fresh review. A
review is not permission to bill or a finding of legal compliance.

### 4.4 History

```text
Recorded Sep 13 by Albert
  Possession start: Jul 1 -> May 1
  Basis: legacy unverified -> possession entitlement
  Actual move-in: not recorded -> May 5
  Reason: data entry error
  Evidence: Key handover.pdf
  Charges, payments, allocations: unchanged

Earlier explanation: retained; its referenced dates have changed
```

## 5. Rules to implement once

1. No equality constraint between possession, lease term, and rent era.
2. Only a rent schedule instructs recurring billing. A date correction never
   creates, deletes, voids, reallocates, backfills, or reprices money.
3. Every post-creation date/basis correction requires a nonblank explanation;
   append a durable record in the same transaction as the change.
4. Changes to a confirmed fact preserve its prior value and source. A further
   correction appends another record; history is immutable.
5. Existing money is never a possession-correction blocker. Invalid calendar
   dates, start after end, stale context, forbidden scope, and incompatible
   ending state are blockers.
6. No universal warning for every renewal. Findings name the selected lease
   and rent era; clients do not infer legal invalidity from date ordering.
7. Keep UTC calendar boundaries for current status behavior; changing account
   timezone semantics is a separate project.
8. Keep money, due dates, lease terms, and correction-record timestamps as
   distinct concepts in API descriptions, imports, exports, and agent tools.

Status decision table for a correction to start (the client previews this and
sends the expected resulting status; the database recomputes it):

| Existing state | New start | Result |
| --- | --- | --- |
| upcoming or active, no recorded ending | future | upcoming |
| upcoming or active, no recorded ending | today/past | active |
| holdover | today/past | holdover |
| holdover | future | reject `date_status_conflict` |
| ended, no ending fact (legacy) | on/before existing end and today | stay ended |
| ended, ordinary `ended` fact | on/before immutable effective end and today | allow audited start correction; stay ended; end unchanged |
| cancelled_before_move_in ending | any different start | reject `date_fixed_by_cancellation` |

For an ended legacy record without an end date, allow only a start on/before
today and preserve ended status; show `legacy_ending_incomplete` information.
An actual-move-in date cannot be newly asserted for a cancelled-before-move-in
record; resolving that contradictory ending is a separate lifecycle correction.
Changing only basis/actual move-in leaves status unchanged.

The cancellation exception is deliberate: its current end boundary equals the
original scheduled start. A safe correction requires an ending replacement
workflow, which is out of scope. Ordinary ended tenancies must not be lumped
into that exception. Do not reopen ended tenancies as part of this feature.

## 6. Database and transaction design

Add `start_date_basis`, nullable `actual_move_in_date`, and
`date_revision bigint not null default 0` to tenancies. Revision increments
once per correction, including a basis-only correction, not on unrelated edits.

Add one domain-specific append-only table, `tenancy_date_records`:

```text
id, account_id, tenancy_id
kind                         correction | explanation
before_facts                 typed/validated JSON snapshot, version 1
after_facts                  same schema
context_snapshot             selected lease/schedule IDs and date facts
context_fingerprint          server-derived
reason_code                  data_entry_error | possession_delayed |
                             concession | renewal | early_access | other
reason_note                  trimmed, 1..2000 characters
source_document_id           optional existing document
source_document_snapshot     immutable version/hash reference when available
created_by                   authenticated user ID, never caller-supplied
created_at                   database timestamp
request_key                  durable request identity for this command
request_fingerprint          principal-bound existing middleware fingerprint
```

Snapshot keys are fixed in the DB and OpenAPI: `start_date`, `start_date_basis`,
`actual_move_in_date`, `status`, `end_date`, `date_revision`. Context captures
selected lease ID, term dates/status/void status/updated_at and selected schedule
ID, effective dates/due_day/updated_at, plus ending ID/kind/effective date.
Snapshots are data, not arbitrary client-supplied JSON. Explanation records
have identical before/after facts. A correction reason describes a recorded
error; a concession explanation does not itself amend the lease or schedule.

Use account-safe FKs, FORCE RLS, explicit authenticated read policy, indexes
on `(account_id, tenancy_id, created_at, id)` and correction old-start lookup.
Do not permit caller INSERT/UPDATE/DELETE on history. Corrections/explanations
are allowed to existing account members under the current tenancy-write role
policy; no new agent privilege or approval exemption is introduced. Recheck
membership in the database so middleware caching cannot authorize revoked users.

Reference validation: evidence document must belong to the same account and
tenancy and be live at capture. Capture its immutable attachment/version/hash
identity using the existing document evidence model after inspecting that
model in S1. A document title/URL alone is not immutable evidence. If no file
version exists, retain the document ID and mark `unversioned_reference`;
never fabricate a hash. Later deletion does not remove the historical citation.

Implement narrowly named functions (final signatures generated from migrations):

- `preview_tenancy_date_correction`: read-only, one consistent database
  statement/snapshot; returns proposed state, blockers, information, and counts.
- `correct_tenancy_dates`: one authorized transaction.
- `record_tenancy_date_explanation`: append-only explanation for selected facts.
- Private helpers for validated snapshots, status result, context fingerprint,
  and record insertion only where actually shared by these functions.

Do not build a generic correction framework. The database owns mutation
eligibility, status result, and snapshot construction. TypeScript owns HTTP
validation/error mapping; clients own display text keyed by stable codes.

Correction transaction:

```text
caller JWT + principal-bound idempotency claim
  -> verify account membership and tenancy
  -> lock tenancy row
  -> compare expected date_revision, status/end, and selected context
  -> validate date ordering, source, ending policy, expected result
  -> append correction record with server-built before/after
  -> update tenancy date fields/status/revision
  -> existing audit triggers emit events for both domain writes
  -> complete idempotency response atomically
  -> commit
```

Use durable `(account_id, request_key)` uniqueness and compare request
fingerprints before replay. Same key/body/principal returns the original
result; a different payload/principal conflicts. Mirror the existing atomic
inspection RPC integration, including `idempotencyCompletedAtomically`.
Fault injection between domain writes and response persistence must roll back
both, or replay a fully committed result; never append a second correction.

Protect direct PostgREST writes as well as API writes. Add a trigger preventing
post-creation changes to the three date/basis fields and revision outside the
correction boundary. Do not trust a client-settable session/GUC flag as an
authorization bypass. Use a dedicated NOLOGIN, NOINHERIT function-owner role
with only required privileges, no membership grants to API callers, and safe
search_path; the date-write guard recognizes that execution role. The RPC
still verifies `auth.uid()` membership and tenancy scope internally. FORCE RLS
policies for this role must remain account-scoped. Test that authenticated,
agent, and service_role REST callers cannot bypass with direct UPDATE or a
forged setting. Never grant this role to those callers. Migration-owner repair
access remains an operator capability, not an API feature.

Adjust `_guard_recorded_tenancy_ending` narrowly: the authorized correction can
change start for `kind=ended` within its immutable end bound; it cannot change
that ending, reopen the tenancy, or bypass cancellation rules. Preserve all
existing ordinary PATCH restrictions on recorded endings.

For import identity, both correction and import tenancy resolution take the
same transaction advisory lock keyed by account and unit (`tenancy_identity:`)
before locking tenancy rows. Recheck the tenancy/unit relationship after the
row lock. This serializes identity-changing work for one unit, not an account.
Document this ordering beside the RPC and resolver after checking it against
existing ending, lease-replacement, and rent-change locks. Correction never writes or
locks money rows. Selected context changes may make an explanation stale; do
not acquire portfolio-wide locks to prevent that. Add concurrency tests against
ending/status advancement to establish a valid serialized outcome.

## 7. API contract

All endpoints below are beneath `/v1/accounts/{accountId}/tenancies/{tenancyId}`.
Keep new schemas, routes, and handlers under `api/src/routes/tenancies/`.

| Endpoint | Contract |
| --- | --- |
| `GET /date-context?lease_id=...&rent_schedule_id=...` | Current possession facts, explicitly selected lease/schedule, ending summary, context fingerprint, applicable explanation, capabilities and information codes. Selections optional; validate same tenancy. |
| `POST /date-corrections/preview` | Proposed patch plus optional selections; returns current/proposed facts, expected revision/context, blockers, information, financial review counts and sampled_at. No domain record. |
| `POST /date-corrections` | Apply proposed patch with expected revision/context/result, reason and optional evidence. Return updated tenancy plus correction record atomically. |
| `POST /date-explanations` | Same context fingerprint, reason, optional evidence; append explanation without changing dates. |
| `GET /date-history?cursor=...&limit=...` | Keyset page of records, max 100, including stale explanations and original source references. |

POST preview uses the existing required Idempotency-Key convention even though
it writes no domain record. A refreshed preview uses a new key; retrying an old
key deliberately returns that old preview. Apply always revalidates.

Example apply body (field omission means unchanged; null clears actual move-in):

```json
{
  "changes": {
    "start_date": "2026-05-01",
    "start_date_basis": "possession_entitlement",
    "actual_move_in_date": "2026-05-05"
  },
  "expected_date_revision": 0,
  "expected_context_fingerprint": "server-issued-value",
  "expected_resulting_status": "active",
  "lease_id": "selected-lease-uuid",
  "rent_schedule_id": "selected-schedule-uuid",
  "reason_code": "data_entry_error",
  "reason_note": "July was entered in error; keys were available May 1.",
  "source_document_id": "existing-document-uuid"
}
```

Require at least one actual date/basis difference. A new request containing
only unchanged values gets `400 no_date_change`; a retry of an already-applied
request replays before this check. Use explanation endpoint for commentary.

Information codes: `date_values_differ`, `legacy_date_unverified`,
`charges_in_changed_interval`, `billing_precedes_possession`,
`legacy_ending_incomplete`. Blockers: `invalid_date_order`,
`date_status_conflict`, `date_fixed_by_cancellation`, `source_scope_invalid`.
Return stale revision/context as `409 date_context_changed`; missing/out-of-
scope tenancy or selected resource follows existing 404 non-disclosure rules.
Do not reuse `tenancy_has_money` for any date correction.

Context fingerprint hashes a canonically ordered, versioned server snapshot
of tenancy dates/revision/status/end and selected lease/schedule/ending facts.
It excludes money counts. Applicable explanation means matching context;
changing referenced facts invalidates applicability without deleting history.

Financial preview: report total live charges/payments separately and counts
of live charges whose period overlaps `[min(old_start,new_start),
max(old_start,new_start))`; when period is absent, use due_date and label that
fallback. A period_end in the current schema is inclusive. Handle open/missing
period bounds explicitly. Counts are informational, sampled from one snapshot,
and not an assertion that those charges are wrong. Money could change later.
Provide a link to the existing ledger for inspection instead of embedding an
unbounded ledger. No payment-date comparison implies invalidity: prepayments
are possible. Never sum mixed currencies for this preview.

Legacy PATCH transition: retain start_date as a deprecated request field for
one release. If supplied unchanged, permit the existing no-op behavior. If
different, return `409 date_correction_required` with a machine-readable link
to the new endpoint, whether or not money exists. A mixed PATCH with a changed
start must fail atomically, applying none of the other fields. Do not fabricate
a reason for an old client. End/status-only PATCH follows existing behavior.

## 8. Upstream and downstream refactors

### Imports

Extract tenancy resolution from the large executor context into
`api/src/admin/import-executor/tenancy-resolution.ts`, with a small typed input
and result (`reused | created | ambiguous`). Keep preview and commit calling
the same resolver and the existing transaction behavior. Extract lease/schedule
date mapping into `date-mapping.ts`; no generic entity framework.

Resolve import identity in this order:

1. Optional mapped existing tenancy ID, verified against account and unit.
2. Candidate set from live tenancies with current start matching the sheet OR
   historical old starts in correction records for that account and unit.
3. Exactly one distinct candidate: reuse its stable ID and retain corrected
   current values. Multiple candidates: block row as `ambiguous_tenancy` and
   request explicit ID; never pick `limit 1`. No candidate: normal creation.

This prevents a corrected July-to-May tenancy from being recreated when the
old July sheet is reimported. If an old date also identifies a real different
occupancy, block instead of merging. Explicit ID remains the escape hatch.
Do not overwrite corrected tenancy/lease/schedule dates from an old sheet.
If an explicit ID conflicts with unit scope, block rather than fall back.

When an alias resolves an old start, downstream defaulted lease/schedule
values must use the resolved tenancy's current facts, not the stale sheet
date. Before creating a lease/schedule on that reused tenancy, resolve existing
records with the same explicit dates or report ambiguity; a missing explicit
date is insufficient reason to create another era on an existing tenancy.

Keep legacy defaults only where a new tenancy is being created. Preview must
show `defaulted from possession start` and commit must preserve that mapping
decision in existing import reporting. Supplied invalid dates are errors,
never silently replaced by defaults. Rename catalog descriptions that conflate
move-in and lease start. Add optional basis/actual-move-in/existing-ID mappings.
Never infer confirmed possession meaning from an ambiguous old spreadsheet.

Test concurrent resolution/correction. Acquire the shared account/unit identity
lock before resolving candidates and keep it through insert/reuse within the
existing import transaction. Correction takes the same lock before changing
start and appending its alias-bearing history. Recheck candidates after acquiring
the lock. For multi-unit batches, pre-acquire locks in stable unit-ID order
before resolution; preserve existing preview/commit transaction guarantees.
Do not silently weaken all-or-nothing import behavior or add an account-wide mutex.

### Adoption

Remove the schedule-start-before-tenancy rejection and obsolete error mapping.
Present the same informational date comparison in the caller's preview. Keep
adoption's existing ledger, schedule, currency, charge-window, payment-window,
and permission invariants. It still does not permit existing ledger activity.
A recorded explanation can be added after successful adoption through the
same explanation endpoint; do not make date equality an adoption prerequisite.

### Billing, lifecycle, search, and balances

Generator: retain schedule start/due-day eligibility, its no-backfill behavior,
and existing end/status handling. Test that an upcoming tenancy can still have
a legitimate schedule and that possession corrections create no catch-up rent.

Status job: preserve its upcoming-to-active purpose and UTC basis. Test races
with date correction. Corrections moving start into the future explicitly
preview active-to-upcoming; this can affect status-filtered portfolio displays.

Search/context resolution: inspect SQL consumers ordering/selecting tenancies
by start/status (`db/current-schema.sql:2161`, `:8996` onward). Confirm they
continue to represent the same tenancy ID after correction. Document that
status filters/order can change; no money total for that ID changes. Do not
replace start-based historical ordering with lease/schedule dates.

Ledger/rent rollup: prove unchanged per-tenancy charges, payments, allocation
IDs, reversals, and balances before/after correction. Assert equality with
explicit tenancy/status scope so changing portfolio membership is not
misreported as changing a financial balance.

### Evidence and events

Add a typed date-history export loader/renderer module under
`api/src/admin/export-pdf/`. Include current date meanings and complete
correction/explanation context alongside activity-window output. Label dates
as current records as of generation; label correction capture time separately
from the date being corrected. A statement cutoff does not imply a historical
reconstruction of every tenancy metadata field.

Use paginated loads for complete history and chunked cited IDs. Include new
history IDs and relevant schedule IDs in audit-event collection. Link source
documents/versions without allowing cross-tenancy evidence access. Published
old exports retain their original bytes/hashes; only new exports render the
new context. Verify PDF and manifest agree on correction IDs and sources.

The existing event feed can deliver `tenancy_date_records` snapshots. Update
consumer documentation/invalidation for date context/history and tenancy
status views; no new event-type string is necessary. Keep audit actor identity
as the authenticated identity; resolve human/agent presentation through the
existing principal/membership model without rewriting event history.

### Frontend and runtime agent

Find the exact quoted warning plus all uses of `tenancy_has_money`, date
equality checks, and automatic copy-from-tenancy behavior. Replace them with
the shared context/preview/command contract and the mocks above. UI components
should accept typed SDK data, not reproduce eligibility logic.

Expose narrow agent tools for reading context, previewing correction, applying
correction, and recording explanation. Tool descriptions must distinguish
possession, lease term, actual arrival, rent effective period, and payment due
day. Existing action authorization rules still apply. An LLM cannot invent
evidence or call money voids to satisfy a date mismatch. Agent prompts consume
stable result codes and the preview; no string-matching prose for control flow.

## 9. File boundaries for maintainability

```text
api/src/routes/tenancies.ts          stable exported facade
api/src/routes/tenancies/
  index.ts                          one domain registrar
  schemas.ts                        shared tenancy response/params
  records.ts                        CRUD schemas/routes/handlers
  endings.ts                        ending schemas/routes/handlers
  dates.ts                          context/correction schemas/routes/handlers
  date-history.ts                   history/explanation schemas/routes/handlers
api/src/admin/import-executor/
  tenancy-resolution.ts             stable identity resolution
  date-mapping.ts                   explicit vs defaulted date mapping
api/src/admin/export-pdf/
  tenancy-dates.ts                   date facts/history loading and rendering
api/test/
  tenancy-dates.test.ts              correction/preview/history integration
  tenancy-dates-concurrency.test.ts  serialization and idempotency
```

These are proposed paths. Prefer 150-400 lines per new module, split at domain
responsibilities, retain the enforced 1,000-line limit. No miscellaneous
`utils.ts`, universal temporal framework, or duplicated DB business rules in
TypeScript. Keep endpoint-specific request schema, registration, and handler
together; shared response types may live in `schemas.ts`.

Add one concise accepted ADR during implementation, including this rule map:
DB owns permitted corrections and provenance; HTTP owns request validation;
schedule owns recurring billing; import resolver owns identity; exports own
evidence presentation. Current architecture describes only shipped behavior.

## 10. Sol execution packets

Each packet is a bounded PR with a single owner. A Sol agent reads this plan
and its listed files, implements only its packet, and reports changed files,
tests, evidence of acceptance, and any remaining dependency. No agent should
make new product decisions silently. Rebase dependent packets on completed
contracts. Only the integrator regenerates shared artifacts per merged stage.

| Packet | Dependency | Work/owned files | Done when |
| --- | --- | --- | --- |
| S0: Domain extraction | approved plan | tenancy facade and new records/endings/schema modules | Existing routes/OpenAPI remain behaviorally identical; tenancy/start/end tests pass; no date policy changes. |
| S1: DB boundary | S0 | forward migrations, DB tests, generated DB artifacts | New fields/history/RPCs/direct-write guard, ending exception, RLS, evidence capture, stale state and atomic retry tests pass. Owns SQL helper/signature decisions within this spec. |
| S2: API contract | S1 | dates/history routes, app mounting as needed, API tests, OpenAPI/SDK/guide | Exact endpoint/code examples work, immediate-parent/RLS isolation holds, legacy PATCH directs to correction and never voids money. |
| S3: Import/adoption | S1 + S2 contract | import extraction/catalog/schema/tests; adoption route and forward RPC migration | Old-date reimport reuses stable ID, ambiguity blocks, defaults visible, distinct adoption dates accepted with money constraints retained. |
| S4: Lifecycle/billing verification | S1 + S2 | targeted auto-charge, status, ending, search, ledger/rollup tests; only necessary fixes | Status transitions/races behave as specified; same-tenancy money unchanged; no generator backfill/equality coupling. |
| S5: Evidence/events | S1 + S2 | export date module/load/render/manifest integration and tests; event-feed tests | New exports show complete reasoned history and evidence links; old exports unchanged; event invalidation contract documented. |
| S6: Client/agent integration | S2 | discover actual external repos, typed UI components/tools, prompts and consumer tests | All four mocks work; stale preview preserves input; explanations become stale correctly; no automatic date-alignment/void recommendations; report exact external files. |
| S7: Integration/release | S3-S6 | docs/ADR, generated artifacts, manifest/CI classification and rollout checklist | Required checks pass and full example works end to end on staging, including real client/agent paths. |

S3-S6 may be assigned to separate Sol agents after S2's contracts are stable;
do not run them as concurrent writers on the same files. All migrations get
unique versions from the current repository maximum at merge time. S1/S3
must not allocate colliding versions in isolated branches.

Suggested packet handoff prompt:

```text
Implement packet S<N> from docs/tenancy-dates-implementation-plan.md.
Read AGENTS.md and current architecture first. Verify dependencies landed.
Use the approved field meanings, endpoint codes, status table and exclusions.
Do not change files owned by another active packet without coordinating.
Preserve unrelated edits; do not apply migrations to production.
Add the specified behavioral tests and run the relevant repository checks.
Report what changed, why, test results, and exact remaining dependencies.
```

## 11. Acceptance matrix and required verification

| Scenario | Required assertion |
| --- | --- |
| Three dates differ, including renewal | Can create/read records; informational comparison, no forced equality. |
| 13 live money entries | Correct start with reason; every charge/payment/allocation ID and financial value stays identical. |
| Basis-only confirmation | Same date retained; new revision/history records explicit confirmation. |
| Physical arrival correction | Audit history appended; status, rent era, and money unchanged. |
| Missing reason/invalid actual date | 400, no partial history or tenancy update. |
| Same request retried after response loss | Same response and record ID, one correction only. |
| Same key with different body/principal | 409; no new facts. |
| Concurrent editors / stale status / selected lease replaced | Exactly one applicable correction or explicit stale-context result; no overwrite. |
| Money arrives after preview | Date correction can succeed; new payment retained; counts marked as sampled. |
| Ordinary ended tenancy | Within-end correction succeeds; ending/end/status remain immutable. |
| Cancelled-before-move-in tenancy | Changed start/physical arrival assertion blocked with specific explanation; no reopen. |
| Direct SQL/REST forgery | Authenticated/agent/service REST cannot mutate protected dates/history outside command; forged GUC fails. |
| Cross-account/tenancy evidence or resource | Rejected without disclosure or partial mutation. |
| Old spreadsheet rerun / alias collision | Reuse corrected tenancy ID / block ambiguity; no duplicate occupancy or rent era. |
| Explicit invalid import date | Report error, never use fallback. |
| Adoption schedule precedes possession | Accepted under other adoption invariants; not treated as legal approval. |
| Narrow-window evidence export | Current metadata labeled, correction history/source included, monetary cutoff semantics intact. |
| Explanation then referenced date changes | Old record visible; no longer applies to current context. |
| Future correction and daily sweep | Deterministic serialized status result, billing follows schedule. |

During implementation run relevant existing tests (`test:tenancy-start-date`,
`test:tenancy-endings`, `test:auto-charge`, `test:adoption`, `test:imports`,
`test:lease-lifecycle`, `test:ledger`, `test:rent-rollup`, `test:events-feed`) and
new targeted tests. Replace obsolete start-date expectations rather than
retaining tests that demand all money be voided. Register every new API test
script in `api/test/test-manifest.json`; follow the DB test classification
already in CI for isolation/definer-grant/audit-chain tests.

Use `pnpm db:migration:new <name>` to allocate forward migration versions.
Apply to a local stack, run `pnpm db:generate`, then regenerate OpenAPI/SDK
through existing scripts (inspect script definitions, do not hand-edit outputs).
Integration owner runs `pnpm check`, `pnpm check:db-generated` against the fully
migrated stack, and `pnpm --filter ./api ci:integration`. Inspect the rendered
PDF output for S5; its agent must follow the PDF skill when working on PDFs.

## 12. Rollout and rollback

Use an expand/migrate/enforce rollout to avoid an API that writes dates the
database suddenly rejects. First add nullable/defaulted fields, history and
RPCs. Then deploy API endpoints with new response/error contracts, exports,
and updated clients/imports. Finally enforce the direct-write guard and the
legacy-PATCH correction-required behavior together after callers have moved.
Before enforcement, inventory direct start-date writers and record the cutover
time. Historical pre-cutover events remain history without invented reasons.

Do not enable the new UI save until API capability detection succeeds. Apply
the final enforcement migration only once the API version that understands
its errors is running. Staging must exercise each mixed-version stage.

Backfill only `legacy_unverified`, null actual-move-in, and revision zero;
do not adjust dates, schedules, amounts, or manufacture explanation records.
Document the rollout's audit-history coverage start.

Rollback means disabling the new correction entry point while retaining
history and the database protection, or deploying a forward repair. Do not
drop history or restore the old unrestricted direct-update path. Once guard
enforcement lands, an old binary that assumes raw date PATCH is not a supported
rollback target. Track stale-context failures, blocked legacy PATCH calls,
import ambiguities, and export failures using existing logging; do not log
private reasons or document contents into operational logs.

## 13. Research context for the design

This design preserves explainable records; it does not determine what rent is
legally owed. State/program-specific advice stays outside automatic rules.
The prior research used these sources, which support distinguishing concepts
and retaining trustworthy records, not mandating this implementation:

- Virginia Code sections 55.1-1200, 1204, 1238: agreement effectiveness,
  possession entitlement, rent terms and possession-related abatement:
  https://law.lis.virginia.gov/vacodefull/title55.1/chapter12/
- Oregon ORS 90.147: delivery of possession/right to occupy:
  https://www.oregonlegislature.gov/bills_laws/ors/ors090.html
- Federal Rule of Evidence 803(6): contemporaneous business records and
  trustworthiness; forum-specific admissibility is a separate legal question:
  https://www.law.cornell.edu/rules/fre/rule_803

The architecture recommendation is our engineering judgment. Date differences
need appropriate factual context; equality alone does not prove correctness.
