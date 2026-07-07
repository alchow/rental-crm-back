# Re: ADR-0012 adoption — answers to the six contract questions

Status: answered 2026-07-06. Questions 1–3 changed the contract; the changes
ship in the same PR that adds this document (regenerate types from
`openapi/openapi.json` after it deploys). Questions 4–6 are answered without
contract changes beyond spec description notes.

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
  (`POST /charges/{id}/void` — it already existed), then DELETE. The next
  daily generator run re-emits the affected periods under whatever schedule
  then owns them.
- **`POST /rent-schedules/{id}/end` now accepts `end_date: null`** — re-opens
  a schedule. You need this when undoing a mistaken rent *change*, because the
  change also ended the predecessor era at `effective_date − 1`.

**Full undo recipe for a mistaken rent change**, in order:

1. Void any charges the mistaken change's successor era emitted
   (`voided_charge_ids` from the original response tells you what the change
   itself voided; `GET /charges?…` filtered on the successor schedule shows
   what it emitted since).
2. `DELETE /rent-schedules/{successor_id}` (409 `schedule_has_charges` until
   step 1 is complete).
3. Re-open the predecessor: `POST /rent-schedules/{predecessor_id}/end` with
   `{"end_date": null}` (the `ended_schedule_ids` from the original response
   identifies it). Order matters: delete the successor **before** re-opening,
   or two open same-kind eras will both bill.
4. Re-issue the rent change correctly.

Lease-state caveat: the recipe undoes the *billing* side only. If the
mistaken change was lease-anchored it also activated the draft anchor and
superseded the previously active lease — those transitions are **not**
undone (superseded is terminal: 409 `lease_superseded`). When the anchor
lease itself was fine and only the amount/date was wrong, just re-anchor the
corrected change to it. When the anchor lease was the mistake, delete it
(possible again once its schedule is gone) and create the lease you meant —
the superseded predecessor stays superseded as a matter of record.

One permanence rule to be aware of: the charge-dedupe key counts voided rows,
so a voided (schedule, period) pair is never re-billed under the **same**
schedule id. The recipe above always ends with a fresh schedule row, so
re-billing works; "just fix the old schedule in place" can never be made to
work, which is why it isn't offered.

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

## 4. Re-billing after voids: asynchronous

The rent change only voids. Re-billing happens at the **next daily generator
run** (08:00 UTC), which re-emits the affected periods at the new amount —
and only for accounts with `auto_charge_enabled = true`; manually-billing
accounts re-create charges themselves. Since an advance charge only exists
once the prior due day has passed, the voided period is re-billed on the very
next run (within 24h). Suggested result-panel copy, gated on the account
flag: "N charges were voided and will be re-billed automatically at the next
daily billing run."

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
