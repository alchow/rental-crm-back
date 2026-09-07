# Re: lease lifecycle — answers to Field Log §26

Status: answered 2026-09-06. Ships with ADR-0014 and migration
`20260810000002_lease_lifecycle`; regenerate your types from
`openapi/openapi.json` after it deploys. The contract table is
docs/api-guide.md § Leases.

## 1. What you asked for vs what shipped

| Your ask                                                | What shipped                                                                               | Why it differs                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DELETE /leases/{id}` carrying a reason in the body     | `POST /leases/{id}/void` with `{ "void_reason": "…" }`                                     | Nothing here is deleted: the row stays listed and readable with `voided_at`/`void_reason` set, which is the point of recording the reason. A named verb says so, and it keeps the reason inside the idempotency replay fingerprint (this API deliberately excludes DELETE bodies from it). |
| "let us edit a lease that isn't anchored to a schedule" | Editability follows the lease's **status**; anchoring no longer gates editing at all       | Anchoring is a billing accident, not a legal fact. It left signed leases rewritable and drafts frozen — exactly backwards.                                                                                                                                                                 |
| a link from a corrected lease to the one it replaces    | `corrects_lease_id` on every lease, plus `POST /leases/{id}/replace` which sets it for you | Same reason we did not give you a hard delete: a replacement that appears from nowhere reads as an altered record. A void with a reason plus a back-link reads as a corrected one.                                                                                                         |

## 2. Lists never returned soft-deleted leases

Worth settling because §26 assumed otherwise: `GET /leases` has always filtered
`deleted_at is null` (`api/src/routes/leases.ts:186`), as has `GET
/leases/{id}`. The old soft-delete correction path therefore made the mistaken
lease _invisible_ to every client — the reason it is gone.

Voided leases behave the opposite way: they are **returned** by both the list
and the single fetch. If a screen should show only live contracts, filter
`voided_at === null` yourself; where a lease's history matters, render the
voided row with its `void_reason` and follow `corrects_lease_id` to the
replacement.

## 3. Breaking changes to code you have today

- `DELETE /accounts/{a}/leases/{id}` → **404**. Use `POST …/void`.
- A rent edit that was always 400 is now **200 on a `draft`** and **409
  `lease_executed`** on `active`/`expired`. Any "rent terms are immutable"
  copy has to become draft-aware — on a draft, the rent field is just a field.
- PATCHing `term_end`/deposits/`document` on a `superseded` lease was 200; it
  is now **409 `lease_superseded`**. Superseded leases are read-only apart
  from being voided or replaced.
- Voiding an anchored lease returns **409 `instrument_anchored`** — the same
  code the old anchored DELETE returned, on the new verb.
- `Lease` gains `voided_at`, `void_reason`, `corrects_lease_id` (all
  nullable), and `POST /leases` accepts `corrects_lease_id`.
- Two new codes, `lease_executed` and `lease_voided`: add them to your
  conflict-class union and keep the generic `conflict` fallback branch.

Echo-back still works, and now on every field: the database guard diffs the new
row against the old one, so a whole-object PATCH that re-sends the stored
values unchanged is a no-op, never a rejection. Only a _differing_ value on a
frozen field raises.

## 4. Void does not stop billing

Voiding a lease that anchors nothing leaves the tenancy's rent schedules and
the nightly generator running — no billing path reads the lease. Voiding a
lease that _does_ anchor a live schedule is refused (`instrument_anchored`)
precisely so the two cannot drift apart silently.

So "this lease was a mistake" and "stop billing this rent" are two separate
acts. If the operator means both, do the money side first (§5b): the schedule
is what bills.

## 5. Recipes

**(a) Wrong terms on a lease, nothing billed against it.** If it is still a
`draft`, just `PATCH` it — every field is open. If it is executed, `POST
/leases/{id}/replace` with `void_reason` (e.g. "term start typo") and the
corrected `lease` body. One call: old lease voided, replacement created with
`corrects_lease_id` and the same status, live schedules re-pointed. If the
lease anchors a schedule and the replacement's rent differs, you get 409
`schedule_conflict` — that case is (b).

**(b) Wrong rent, already billed.** Order matters; hard-sequence it in the UI:

1. Void the charges emitted at the wrong amount (`POST /charges/{id}/void`).
2. `DELETE /rent-schedules/{id}` — allowed once no non-voided charge cites it,
   and it releases the lease's anchor lock.
3. `POST /leases/{id}/replace` with the correct rent (now unanchored, so the
   rent may differ).
4. `POST /tenancies/{tenancyId}/rent-changes` anchored to the **replacement**
   lease to re-establish billing at the right amount.

Re-billing of the voided periods follows the ADR-0012 window rule unchanged:
automatic only while the period's due day is still ahead, otherwise a manual
`POST /charges` — see docs/rent-changes-fe-reply.md §1 and §4.

**(c) Junk lease** (created by accident, anchors nothing): `POST
/leases/{id}/void` with the reason. Do not try to hide it; a voided row with
"created in error, duplicate of <id>" is a better record than a gap.

## 6. Result handling for `replace`

The response is `{ voided, replacement, repointed_schedule_ids }`. Two things
to do with it: navigate to `replacement.id` (the old id is now a historical
row, not a 404 — links to it keep working), and, when
`repointed_schedule_ids` is non-empty, say so — the schedules those ids name
now cite the new lease, and any schedule detail view you have cached is stale.
