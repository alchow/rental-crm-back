# Re: ADR-0012 adoption — answers to the six contract questions

Status: answered 2026-07-06. Questions 1–3 changed the contract; the changes
ship in the same PR that adds this document (regenerate types from
`openapi/openapi.json` after it deploys). Questions 4–6 are answered without
contract changes beyond spec description notes.

> **Rev 2 (2026-07-06, after your follow-up analysis):** the undo recipe in
> §1 was corrected — the original re-open-based ending had a silent
> revenue-loss hole you correctly identified. See §1 and the addendum at the
> end for what changed and why.
>
> **Rev 3 (2026-07-06, after your window finding):** you were right again —
> "re-bills automatically" holds only until the voided period's own due day
> (the generator bills one window and never backfills). Verifying that, we
> found the same window bites the **normal flow too**: a backdated rent
> change (applied after the effective period's due day) un-bills that period
> with no automatic replacement. Both are now documented limitations with
> manual endings — see §1, §4, and the addendum. Deadline rule everywhere:
> **automatic re-billing reaches only periods whose due day is still
> ahead.**

## 1. Correction path for a mistaken rent change (was blocking)

You were right that the 409 was a dead end: no schedule delete existed, and
`/end` can never clear a future schedule out of the conflict (the DB requires
`end_date >= start_date`, and anything `>= start_date` keeps it in the RPC's
open set). Do **not** work around it by re-issuing at a later effective date —
that leaves a sliver era at the mistaken amount which the generator will
happily bill and the void step won't touch.

The blessed path now exists:

- **`DELETE /accounts/{a}/rent-schedules/{id}`** — soft-deletes a
  **never-billed** schedule. This is the resolution for the
  `schedule_conflict` 409 and for the "typo'd change, caught immediately"
  case. Refused with 409 `schedule_has_charges` while any non-voided charge
  references the schedule.
- **Era that already advance-billed:** void those charges first
  (`POST /charges/{id}/void` — it already existed), then DELETE. Re-billing
  then depends on which schedule ends up owning the period — see the
  permanence rule below; the undo recipe is shaped entirely around it.
- **`POST /rent-schedules/{id}/end` now accepts `end_date: null`** — re-opens
  a schedule. Scope: cancelling a planned end, or undoing a rent change that
  voided nothing. It is the **wrong tool** when the change voided advance
  charges (next section).

**The permanence rule that shapes the undo** (rev 2 — this section replaces
the original recipe): the charge-dedupe key counts **voided** rows, so a
voided (schedule, period) pair is never re-billed under the **same** schedule
id, ever — there is no un-void, and the generator's insert silently skips the
occupied slot. An undo must therefore never hand a voided period back to the
schedule it was voided under. Branch on `voided_charge_ids` from the mistaken
change's response:

**Case A — `voided_charge_ids` was empty** (caught before any advance
billing; the common catch-it-immediately case):

1. Void any charges the successor era emitted since
   (`GET /charges?…` filtered on the successor schedule).
2. `DELETE /rent-schedules/{successor_id}` (409 `schedule_has_charges` until
   step 1 is complete).
3. Re-open the predecessor: `POST /rent-schedules/{predecessor_id}/end` with
   `{"end_date": null}` — safe here because the *change* voided none of its
   periods. (A period voided manually before the change — a waiver — stays
   unbilled through the undo; that's the void's purpose, and re-open
   preserves the exact pre-change state.) Order matters: delete the
   successor **before** re-opening, or two open same-kind eras will both
   bill.
4. If a different change was intended, re-issue it now.
5. Deadline caveat (same window rule as Case B): if step 1 voided a
   successor charge whose period's **due day has already passed**, the
   re-opened predecessor never re-bills it (that period was billed under the
   successor's id, and the generator never backfills). Re-create it
   manually: `POST /charges` at the old amount with `source_schedule_id` =
   the **predecessor** — its key for that period is free in Case A.

**Case B — `voided_charge_ids` was non-empty** (the change voided the
predecessor's advance-billed period(s)):

1. Void the successor's charges, as above.
2. `DELETE /rent-schedules/{successor_id}`.
3. Do **not** re-open the predecessor — its voided periods are permanently
   blocked under its id. Instead create a **continuation schedule**:
   `POST /rent-schedules` with the old amount/due day,
   `start_date` = the mistaken effective date, optionally the same
   `source_lease_id`/`source_notice_id`, and a `change_reason` noting the
   undo. Fresh id → fresh dedupe keys → the next daily generator run
   re-bills a voided period automatically at the old amount **only while
   that period's due day is still ahead** (the generator bills one window,
   never backfills — verified both directions). For an undo performed after
   the due day — the late-discovery timeline — re-create the elapsed
   period(s) manually: `POST /charges` at the old amount with
   `source_schedule_id` = the **continuation** (its key is fresh, so
   provenance is preserved; this is the one manual step automation can't
   cover today).
4. If a different change was intended, re-issue it on top — the continuation
   schedule is open, so the corrected change ends it and inherits normally.

A correction UI should hard-sequence these steps (never expose
delete/re-open/create as independent buttons) and pick the case from the
stored `voided_charge_ids`, not from user judgment.

Lease-state caveat: the recipe undoes the *billing* side only. If the
mistaken change was lease-anchored it also activated the draft anchor and
superseded the previously active lease — those transitions are **not**
undone (superseded is terminal: 409 `lease_superseded`). When the anchor
lease itself was fine and only the amount/date was wrong, just re-anchor the
corrected change to it. When the anchor lease was the mistake, delete it
(possible again once its schedule is gone) and create the lease you meant —
the superseded predecessor stays superseded as a matter of record.

Related fix that shipped with rev 2: a manual `POST /charges` naming a
(schedule, period) that already has a row — voided included — now returns a
clean **409 `conflict`** telling you to omit `source_schedule_id` (it was an
opaque 500). Manual re-billing of a voided period is the escape hatch, not
the blessed path — Case B's continuation schedule makes it unnecessary.

The DB now also enforces the delete rule directly (migration
`20260706000002`): a schedule with live charges cannot be soft-deleted by any
path, API or otherwise.

## 2. Writes blocked on an anchored instrument (was blocking)

The ADR's §6 overstated for leases; the implementation is deliberately
asymmetric and the ADR text has been corrected. The actual contract:

| Write | Anchored **lease** | Anchored **notice** |
|---|---|---|
| PATCH `term_end`, `deposit_*`, `document`, allowed `status` | **200 — allowed** | 409 `instrument_anchored` (all PATCH) |
| PATCH rent fields (differing value) | 400 (all leases, anchored or not; unchanged echo tolerated) | n/a |
| PATCH `status` out of `superseded` | 409 `lease_superseded` (all leases) | n/a |
| DELETE (soft) | 409 `instrument_anchored` | 409 `instrument_anchored` |

So: **do not hide LeaseSheet's "Add a term end" editor for anchor leases** — a
`term_end` edit succeeds. Anchoring blocks only deletion of a lease. The
rationale: a lease's probative field for the rent change (the rent terms) is
already immutable everywhere; `term_end`/deposits/document have their own
legitimate lifecycles (early-termination agreements, deposit corrections),
and the evidence-grade artifact is the content-hashed attachment, not the
mutable `document` json. Notices are locked entirely because every field on a
served notice *is* the record of what was served.

Deleting the anchored schedule (question 1) releases the instrument's lock.

## 3. Machine-readable codes (shipped)

All ADR-0012 conflicts now return fine-grained `error.code` values, and the
409s are declared in the spec (they previously weren't documented at all):

| Code | Where | Recovery UX it enables |
|---|---|---|
| `notice_not_served` | rent-change with unserved notice anchor | offer the serve action, retry |
| `instrument_not_current` | rent-change anchored to expired/superseded lease | pick/create a current lease |
| `tenancy_ended` | rent-change on an ended tenancy | terminal; nothing to offer |
| `schedule_conflict` | a same-kind schedule starts on/after `effective_date` | offer delete-the-future-schedule (question 1) or a later date |
| `lease_superseded` | any transition out of `status=superseded` | offer create-new-lease |
| `instrument_anchored` | PATCH/DELETE of an anchoring notice; DELETE of an anchoring lease | explain the lock; offer supersede-flow |
| `schedule_has_charges` | DELETE of a schedule with non-voided charges | offer void-charges-first |

`conflict` remains the fallback for anything unrecognized — keep a generic
branch.

## 4. Re-billing after voids: asynchronous — and only forward (rev 3)

The rent change only voids. Re-billing happens at the **next daily generator
run** (08:00 UTC), which re-emits the affected periods at the new amount —
and only for accounts with `auto_charge_enabled = true`; manually-billing
accounts re-create charges themselves.

**Rev 3 deadline rule:** the generator bills exactly one window per run
(this month's period, or next month's once the due day passes) and **never
backfills**. So automatic re-billing reaches a voided period only while its
due day is still ahead:

- Change applied **before** the voided period's due day (the common
  forward-dated case): re-billed on the very next run, within 24h.
- Change applied **after** the voided period's due day — i.e. a **backdated
  change** ("rent went up on the 1st, I entered it on the 5th"): that
  period's charge is voided and **never re-created automatically**. The FE
  should detect this at result time — any entry in `voided_charge_ids` whose
  `period_start` (== its due date) is before today needs a manual follow-up:
  `POST /charges` at the **new** amount with `source_schedule_id` = the
  successor (`rent_schedule.id` from the same response; its key for that
  period is free). Strongly recommend the result panel surfaces this as an
  action item rather than a toast.

Suggested result-panel copy, gated on the account flag: "N charges were
voided; future periods will be re-billed automatically at the next daily
billing run" + when applicable "M elapsed period(s) need to be re-billed
manually — create charge now?"

## 5. served_at as midnight UTC: acceptable, with one rendering rule

The column is a full timestamp on purpose (real service moments exist:
e-service, certified-delivery scans — send them when you have them).
Midnight-UTC for date-only knowledge is now the documented convention, with
one requirement: **render it back as a UTC calendar date**, never through the
viewer's local timezone — `2026-07-06T00:00:00Z` formatted in any US timezone
displays as July 5, which for a legal service date is a real hazard. No
date-only field is planned. (Convention is now in the spec's `served_at`
description.)

## 6. Raw POST /rent-schedules: not deprecated

"The blessed path is optional by design" is in the ADR verbatim — direct
create/end stays supported for imports and edge cases, and your residual use
(first-time auto-charge setup, passing `source_lease_id` when the amount
matches the active lease) is exactly the intended one; the DB guard validates
the anchor's tenancy on that path too. FYI only: the rent-changes endpoint
also handles first-time setup (pass `due_day`, since there is no open era to
inherit it from; it anchors the era and activates a draft anchor lease) if
you ever prefer a single write path — there is no requirement to move.

## FYI items (both fixed in the spec)

- `RentChangeBody.source_lease_id` / `source_notice_id` descriptions now state
  the ≥1-anchor requirement (it's a validation refinement JSON Schema's
  `required` can't express — both fields stay individually optional).
- `due_day`'s description now states it is required when the tenancy has no
  open same-kind schedule to inherit from (first-time setup case).

## Addendum (rev 2) — responses to your post-adoption analysis

**1. The pure-undo hole: confirmed, reproduced, recipe corrected.** Your
trace was right on every link — the dedupe index has no voided carve-out,
`ON CONFLICT DO NOTHING` skips silently, no un-void exists, and rev 1's
"re-emits under whatever schedule then owns them" was false exactly when the
owner is the re-opened predecessor. We reproduced it live: advance-billed
September, mistaken change, rev-1 pure undo → three generator runs across
September's whole window emitted nothing. The fix is the rev-2 recipe above:
the undo ends with a **continuation schedule** (fresh id, fresh dedupe key),
which we verified re-bills the voided period on the next run with no engine
change. We considered making the generator re-emit past voided rows and
rejected it: voiding a charge by hand is also how a landlord *waives* a
month, and that fix would silently re-bill every waived month on open
schedules. The manual-recharge escape hatch also got its footgun fixed
(409 instead of 500, message says to omit provenance). If a real operator
case ever needs enforcement rather than recipe discipline, an un-void
endpoint with a double-billing guard is the design we'd ship.

**2. The code swap breaking your `code === "conflict"` branches: our miss.**
Granting fine-grained codes on *already-shipped* 409s was a
consumer-breaking change and rev 1 should have flagged it; it shipped
without a heads-up. Your patch is the right one (treat the seven codes as a
conflict-class set); for future reference our error-code policy is
"add finer codes, never repurpose" — this was the one deliberate exception,
made because the sole consumer had requested the codes, and we'll flag any
such swap explicitly from now on.

**3 (rev 3). The window deadline: confirmed — and it's bigger than the undo
recipe.** Your "next run re-bills automatically holds only while the voided
period is still in the generation window" is exactly right (verified against
the generator's period derivation: one window per run, no backfill —
deliberate since ADR-0011, so retroactively-imported schedules never
surprise-bill stacks of back-months). While verifying we found the same
window bites the **normal rent-change flow**: a backdated change voids the
elapsed period's advance charge and nothing re-creates it (reproduced:
change entered Sep 15 effective Sep 1 → September never billed at any
amount). Both are now documented limitations with precise manual endings
(§1 recipes, §4) rather than engine changes, weighed as follows:
generator backfill contradicts ADR-0011's no-surprise-billing posture;
**un-void** is blocked from being a quick fix by a load-bearing ledger
invariant (the allocation-integrity proof in migration `20260703000006`
literally assumes "un-voiding is not a supported operation" — resurrection
of dormant payment allocations could over-apply a payment, so un-void needs
a caps-re-asserting guard); **synchronous re-emit inside the RPC** (it knows
what it voided) is the designed fix for the backdated case and the likely
next step if manual re-billing proves error-prone in practice. Until then:
branch on `voided_charge_ids` + due-day-passed, and make the manual
re-charge a first-class UI action.

**Your surviving caveats, confirmed:** `ErrorEnvelope.code` stays
`type: string` (hand-maintain your union; our regex mapping is pinned by CI
tests, and your generic `conflict` fallback should stay forever);
"never-billed" precisely means *no non-voided charges* (don't grey out
delete just because charges once existed); anchored notices reject even
unchanged-echo PATCHes (no read-modify-write on notices); undo is
billing-side only (superseded stays superseded); hard SQL DELETE bypasses
the delete guard (nothing app-side issues one — the guard's UPDATE-only
scope is deliberate: hard deletes cascade from tenancy removal, which must
not be blocked); and yes, the guard narrows rather than closes the generator
race (per-account vs per-tenancy locks) — the migration header documents the
benign residue, and "any path" in rev 1 overstated it.
