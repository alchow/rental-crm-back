# Re: Statement section design directions — backend review of the rent-setup handoff

Status: reviewed 2026-08-10 against backend `main` (post-PR #130) and Field Log
`origin/main` (post-PR #227). Nothing from this review is built yet. This is a
cross-team reply and decision record, not implementation instructions; when the
adoption work starts it gets its own ADR.

The handoff under review is the `design_handoff_rent_setup_flows` bundle
(README + `Statement Prototype.dc.html` + `Statement Options.dc.html`): two
flows for the tenancy money page — first-time rent setup with lease autofill,
and an adopt-mid-tenancy wizard (Branch A payment backfill / Branch C opening
balance) with a provenance-tag system.

## Verdict

Most of this handoff shipped before it was written. Field Log PRs #225–#227
already rebuilt the statement as bill cards with receipt trails, the
grace-aware green/amber/red hero, propose-confirm late fees, and PDF/CSV
export, on top of backend PR #128 (`rent_schedules.grace_days` /
`late_fee_cents`, `charges.parent_charge_id`). The handoff's "established
tenancy" scenarios, hero system, empty-state spec, and visual respec describe
a pre-#225 app and should be discarded.

What is genuinely new — and worth building — is the adoption story. It is
also much smaller than the handoff implies: **one new table, one new atomic
RPC, one narrow extraction endpoint.** Everything else the design needs
(dual dates on payments, manual date-preserving allocations with DB-enforced
caps, void-not-delete, instrument provenance, hash-chained audit) already
exists and was built for exactly this honesty story.

## What to treat as spec, and what to reject

Treat the two flows (first-time setup, adoption wizard) and the adoption-study
rationale in `Statement Options` as the spec. Reject:

1. **The visual respec.** The README claims its palette "matches the app's
   existing cream/brown/rust theme." It does not: the app has zero hex colors,
   an oklch-only rule (`src/styles.css:7-12`), Instrument Serif reserved for
   place names, and an explicit prohibition on serif for money
   (`Statement.tsx:53-55`) — which the handoff uses for every amount. Map the
   design onto existing tokens; app chrome and type semantics win.
2. **The statement-page respec and empty state.** The OVERDUE stat tile the
   README specs no longer exists; overdue lives in the shipped hero. The
   shipped statement also exceeds the prototype (honesty skeleton before data
   arrives, `recorded {date}` chip, "dated before this charge" warning).
3. **The prototype's behavior as a reference.** It does not implement its own
   README: "every match editable" has no handler; the due-day select
   (including "Last day") is never read — due day 15 is hardcoded; the entered
   rent is validated then discarded; the month derivation has an off-by-one
   that drops a month when the start date falls on the due day. The README is
   the spec; the prototype is a mood board.
4. **The matching algorithm.** The prototype collapses all payments into one
   scalar pool before matching, so payment dates play no role — while the
   confirm screen promises "received-rent reports will use your payment
   dates." Build the honest version instead: walk payments in `received_at`
   order against oldest open charges, submit explicit per-payment allocation
   pairs. The backend's `payment_allocations` model plus its integrity trigger
   (caps, same-tenancy, voided-counterpart exclusion) makes the honest version
   easier than the fake one. Per-match editing is deferred — the prototype
   never had it either.

## Proposed architecture (for the eventual ADR)

The wizard keeps no backend state — `setupDraft` and `wizard` stay
client-local exactly as the handoff's own state-management section says. The
backend surface is:

**`tenancy_adoptions` — one row per adopted tenancy.**
`{tenancy_id, adoption_date, opening_balance_cents (signed), balance_basis,
needs_review, source}`. One table serves four requirements at once: the
"TRACKING SINCE" divider (adoption_date), the Branch C opening balance, the
needs-review flag, and the legal gating — because an opening balance is not a
charge, the late-fee walker structurally cannot select it and payment-based
received-rent exports structurally cannot include it. No special-case code.

**`adopt_tenancy_history` — one atomic RPC behind one idempotency key.**

```text
setup sheet (client draft) -> wizard (client state)
  -> POST /tenancies/{id}/adopt          (single Idempotency-Key)
       one transaction:
         rent_schedule (past start_date, grace/late-fee if set)
         -> N past charges  (source_schedule_id set, past due_date/period)
         -> M payments      (received_at = landlord's dates, created_at = now)
         -> allocations     (client-proposed oldest-first pairs; trigger caps)
         -> deposit charge + allocation (if held)
         -> tenancy_adoptions row
         -> hash-chained audit events (existing triggers)
  -> ledger + rent-rollup grow opening_balance / adoption_date fields
  -> FE derives every provenance chip from data it already receives
```

This follows the house precedent (`create_payment_with_allocations`,
`change_tenancy_rent`) and fixes what the current API cannot express: N
sequential POSTs are N independent idempotency scopes, so a mid-sequence
failure strands half a ledger — exactly what the design's "never half the
charges without the payments" forbids. Manual charges carrying
`source_schedule_id` for elapsed periods are already sanctioned usage (the
`/rent-schedules/{id}/end` route description prescribes it for undo cases).

**No provenance enum.** The tag set is derivable from recorded facts:

- `ENTERED BY LANDLORD` — `created_at` far from `due_date`/`received_at`; the
  FE already renders this chip for payments. The ledger must additionally
  expose charge `created_at` (today it exposes only the payment's — that
  omission is the one contract gap).
- `OPENING BALANCE` — the adoption row.
- `FROM LEASE` — the schedule's `source_lease_id`; ADR-0012's instrument chain
  is the provenance system, already built.
- `FIRST RENT TRACKED IN FIELD LOG` — first charge with period ≥
  adoption_date.

Storing display tags as writable data would create a second, fakeable source
of truth. Deriving them keeps the statement unable to lie — the design's own
principle applied to its implementation.

**Shared bonus:** materializing past-period charges in a transaction is the
same mechanism as ADR-0012's designed-but-deferred fix for the documented
backdated-rent-change hole (synchronous re-emit in step 9b). Build the helper
once; close a known limitation with it.

## Product pushbacks

1. **Cut "Last day" from the due-day select.** `due_day` is CHECK-capped 1–28
   at the DB, the API schema, and the import executor. The prototype never
   implemented it. This persona's rent is due the 1st or the 15th.
2. **The deposit and the schedule must join the atomic commit** on the
   past-start path. The handoff saves the deposit at sheet-time and is
   ambiguous about the schedule — but `auto_charge_enabled` now defaults on
   (a saved schedule starts billing on the next 08:00 UTC cron, mid-wizard)
   and `tenancies.start_date` locks once money exists. The design's own
   atomicity principle, applied consistently, resolves this.
3. **Cut the "import a bank statement" copy.** Money history is a deliberate
   import-scope invariant ("must never be proposed", burned into the import
   LLM prompt). Reversing it is a real decision for another day, not wizard
   copy.
4. **Drop the sticky `FROM LEASE · CHECKED AT SETUP` tag.** The prototype
   keeps it after the landlord hand-edits every value — a false provenance
   claim. Extraction provenance lives on the instrument chain; ledger entries
   get a single entered-at-setup treatment.
5. **Keep the Branch A/C notice asymmetry** (itemized reconstructed months can
   support a nonpayment demand; a lump opening balance cannot) **but carry
   provenance into the notice**: the `nonpayment_demand` notice class must
   render backfilled charges with their recorded-at dates so a reconstructed
   charge never reads as a contemporaneous record.

## Lease autofill

Wrong chassis, right parts. The spreadsheet-import pipeline (sessions,
mapping, `.xlsx/.xls/.csv`-only parser) should not be bent into this — but its
pieces are exactly right: the Anthropic SDK with forced-tool-use strict
schemas already lives in `api/src/admin/`, and the import catalog already
defines every target field (rent amount, due day, start date, deposit).

Flow: upload the lease to the documents vault first (`document_type: 'lease'`
is already accepted) — the lease becomes stored evidence and the schedule's
`source_lease_id` anchor — then one extraction endpoint reads the stored bytes
and returns **draft fields only, never writes**. The recognition/execution
split the import architecture mandates makes "the user must always review
before saving" structural rather than a UI promise.

## Field Log notes

- The adoption wizard would be the fourth copy of the `?step=` machinery;
  extract the shared wizard shell (progress header, `guardStep`, dirty-exit
  blocker) that three flows already reimplement.
- The month-list derivation must be one pure, tested module shared by schedule
  preview, matching, and copy counts. The prototype hardcodes it in four
  places and gets the date math wrong. `heroState`/`billModel` is the
  established pattern.
- Collapsed fully-paid history is a `billModel` projection extension.
- First-time setup and adoption should share one entry point that branches on
  past-vs-future start — the move-in flow already owns rent+deposit setup for
  new tenancies; do not create a third rent-setup surface.

## Rollout dependencies

- Backend prod migrations `20260801000005`–`0008` include unverified/pending
  applies; `scripts/apply-statement-policy-migrations.sh` covers `0007`/`0008`.
  Apply and verify before shipping anything that reads grace/late-fee/parent
  fields.
- The Field Log local checkout trails `origin/main`; pull before implementing.

---

## Appendix — evidence citations

Backend repo unless noted. FE = Field Log at `origin/main`.

**Already shipped.** FE PR #225 `c2d0179` bill cards (`src/components/money/
billModel.ts` + test; old `LedgerList.tsx`/`groupLedger.ts` deleted); PR #226
`8bc3a63` hero (`heroState.ts`, four states), propose-confirm late fee
(`MoneyHero.tsx:47-137`), exports; PR #227 `5aee9e1` fixes. Backend
`20260801000007_statement_late_fee_policy.sql:22-41,65-86` (recorded-not-
enforced policy), `:102-133` (`parent_charge_id` + one-live-fee index),
`:326-341` (era carry-forward). Shipped provenance rendering:
`billModel.ts:66-75,283` (recordedAt + timeInverted chips), `MoneyHero.tsx:
157-159` (honesty skeleton), `money.tsx:261-266` (currency chain).

**Money model.** Charges `20260604000001_phase2_schema.sql:508-537`; payments
`:539-570` (`received_at` vs `created_at`; ledger contract `api/src/routes/
ledger.ts:38-49,396-397` — "Never render it as the payment date"); allocations
caller-specified only (no FIFO/auto anywhere in `api/src`), integrity trigger
`20260703000006:41-167`; atomic precedent `create_payment_with_allocations`
`20260605000006:74-141`; ledger derived, charge entries expose `source:
'manual'|'rent_schedule'` but not `created_at` (`ledger.ts:11-34,382`);
deposits are charges `type='deposit'` (`ledger.ts:8-9`; rollup
`20260718000001:97-100`); lease `deposit_amount_cents` unlinked
(`20260604000001:225-234`).

**Scheduling.** Three layers, tenancy holds no rent fields (ADR-0012
`docs/adr/0012:17-24`; `20260604000001:177-190,488-506`). Generator emits one
window, never backfills (`20260718000001:184-210`; ADR-0011 `docs/adr/
0011:167-169`; `20260801000001:26-30`); `auto_charge_enabled` default true
(`20260801000001:77-120`); plain `POST /rent-schedules` needs no anchor
(`api/src/routes/rent-schedules.ts:291-302`); manual elapsed-period charges
sanctioned (`rent-schedules.ts:305-331`); `due_day` 1–28 at three layers
(`20260604000001:495`; `rent-schedules.ts:52`; `api/src/admin/import-executor/
context.ts:695`); `start_date` locks under money (`api/src/routes/
tenancies.ts:347-373`); backdated-change hole + designed 9b fix
(`docs/adr/0012:250-292`). Idempotency: per-request claims, no cross-request
transaction (`api/src/app.ts:199`; `api/src/middleware/idempotency.ts:
107-148`).

**Absent (grep-verified).** Batch money commit; opening-balance entity (only a
derived PDF-export figure, `api/src/admin/export-pdf/ledger.ts:78-103`);
provenance enum; `needs_review`; any tax concept.

**Extraction.** Import LLM `claude-opus-4-8`, forced strict tools
(`api/src/admin/import-llm.ts:32,206-315`); privacy digest (`import-parser.ts:
314-332`); catalog fields (`import-catalog.ts:58-178`); money-history
exclusion (`import-catalog.ts:11-13`, `import-llm.ts:107-112`); parser
spreadsheets-only (`import-parser.ts:55-63,91`); vault accepts lease PDFs
(`api/src/routes/documents.ts:77,80-86`); no vault→extraction bridge
(separate buckets; `parseImportFile` has one call site).

**Prototype defects.** Scalar-pool matching ignoring dates (`Statement
Prototype.dc.html:442,498` vs promise `:554`); no match-edit handler
(`:137,501-503`); `setupDue` never read, due day 15 hardcoded (`:423-426`);
entered rent discarded (`:741` vs `RENT=7995` `:346`); month-math off-by-one
and hardcoded end bound (`:419-428`); deposit written at sheet-save with
hardcoded date/method (`:745`); "Save as unresolved" bypasses confirm
(`:535`); sticky lease provenance (`ftLease` never cleared on edit); notice
asymmetry (`:594,601`); stale "four setup paths" strings (`:34,365`); the
Options canvas contains no wizard rationale at all.

**FE build surface.** Three `?step=` wizard copies (RequestWizard 657 /
IncidentWizard 487 / ConversationWizard 330) with no shared shell (import's
`WizardShell.tsx` is the only real chrome); move-in derives steps from server
records (`src/lib/move-in.ts:83-136`); money page 658 lines / 3 useState /
9 queries; money code split across `components/money/` and
`components/tenancy/Money*`; oklch-only + serif rules (`src/styles.css:7-12`;
`Statement.tsx:53-55`).
