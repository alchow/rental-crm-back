# ADR-0014: Lease lifecycle — status-gated mutability, void, and replace

- **Status:** accepted, 2026-09-06. Supersedes ADR-0012 rule 4 (the blanket
  PATCH freeze on rent terms) and its "soft-delete + recreate" lease
  correction path.
- **Context owner:** occupancy (leases) + money subledger (docs/api-guide.md §7)
- **Implements:** migration `20260810000002_lease_lifecycle` (columns
  `voided_at` / `void_reason` / `corrects_lease_id`, trigger `leases_guard`,
  RPC `replace_lease`, anchor rule in `_rent_schedules_guard`), routes
  `api/src/routes/leases.ts` (rewritten: void and replace verbs, no DELETE),
  codes in `api/src/routes/_lib/error.ts`.
- **Builds on:** ADR-0012 (instrument-anchored rent changes), ADR-0001/0008
  (audit chain), ADR-0013 (adoption creates schedules with no instrument).

## Context

ADR-0012 rule 4 froze `rent_amount_cents` / `rent_currency` on **every** lease
and let anchoring — a live `rent_schedules` row pointing at the lease — decide
what else could be removed. Both gates read the wrong fact.

A lease's editability follows from whether the document has legal effect, not
from whether the billing engine happens to cite it. Under ADR-0012 a `draft`
lease nobody had signed answered 400 to a corrected rent, while an `active`
lease that had been signed and relied on stayed open for `term_end`, deposit,
and `document` edits as long as no schedule named it. The intended correction
path made that worse: soft-delete + recreate erases the mistaken lease from
every list and leaves the replacement with no link back, so the record shows a
lease that simply appeared, and the audit chain — the only place the deleted
row survives — is not something a client, an operator, or a court reads.

Field Log's §26 ask was for the missing halves of that story: a removal that
records _why_, drafts that are editable while they are still drafts, and a
visible link from a correction to what it corrects.

**Why the record shape matters.** New York's Housing Stability and Tenant
Protection Act of 2019 extended the rent-overcharge damages window from four
to six years and removed the time limit on examining rent history to determine
the legal regulated rent, with matching owner record-retention obligations
([NYSBA][hstpa-nysba], [summary][hstpa-alb]). _Regina Metropolitan Co. v.
DHCR_, 35 N.Y.3d 332 (2020), barred retroactive application of those
provisions but preserved the fraud exception, under which a rent history whose
records **appear altered** opens an unlimited lookback ([opinion][regina],
[analysis][regina-fraud]). The exposure is therefore asymmetric: a _corrected_
record is ordinary, an _altered-looking_ one invites the unbounded inquiry. So
corrections here are visible, reasoned voids with a link to the replacement,
never silent rewrites — and drafts can stay freely editable, because the audit
chain (`public.events`, written by the `leases_audit` DB trigger, hash-chained
per ADR-0001) already carries every lease UPDATE with its full before/after
payload.

[hstpa-nysba]: https://nysba.org/wp-content/uploads/2019/12/JRNL_SeptOct19_NYHousingTenantProtectionAct.pdf
[hstpa-alb]: https://alblawfirm.com/articles/sweeping-reforms/
[regina]: https://law.justia.com/cases/new-york/court-of-appeals/2020/1.html
[regina-fraud]: https://alblawfirm.com/articles/under-regina-just-what-is-fraud/

## Decision

**Status decides what may change; `voided_at` decides whether anything may.**
`draft → active → expired | superseded` is unchanged; `voided_at` is
orthogonal to it and terminal.

| Field                                              | `draft`                           | `active` / `expired`              | `superseded`    | voided |
| -------------------------------------------------- | --------------------------------- | --------------------------------- | --------------- | ------ |
| `id`, `account_id`, `tenancy_id`, `created_at`     | frozen                            | frozen                            | frozen          | frozen |
| `term_start`, `rent_amount_cents`, `rent_currency` | editable                          | **frozen**                        | frozen          | frozen |
| `term_end`, `deposit_*`, `document`                | editable                          | editable                          | frozen          | frozen |
| `status`                                           | → `active`/`expired`/`superseded` | `active` → `expired`/`superseded` | frozen          | frozen |
| `voided_at`, `void_reason`                         | settable                          | settable                          | settable        | frozen |
| `corrects_lease_id`                                | null → set once                   | null → set once                   | null → set once | frozen |

Status moves forward only. `superseded` is a historical record with one
remaining act — voiding it. A voided lease is inert (`updated_at` /
`deleted_at` excepted).

**Removal is a void.** `DELETE /accounts/{accountId}/leases/{id}` no longer
exists. `POST …/leases/{id}/void` takes a required non-blank `void_reason`
(≤500 chars), stamps `voided_at`, and returns the lease. Voided leases stay in
`GET /leases` and `GET /leases/{id}` carrying both fields — the row is the
evidence that a mistake was made and named.

**Corrections are linked, not implied.** `corrects_lease_id` points a
replacement at the voided lease it supersedes (same account, same tenancy,
target must already be voided; set once, enforced by the guard).
`POST …/leases/{id}/replace` is the atomic form: one `replace_lease` RPC
(SECURITY INVOKER, per-tenancy advisory lock in the ADR-0012 idiom) inserts
the replacement with the old lease's `tenancy_id` and `status`, re-points the
old lease's live schedules at it, voids the old lease with the supplied
reason, and sets the back-link — returning `voided`, `replacement`, and
`repointed_schedule_ids`. It refuses (`schedule_conflict`) when an anchored
schedule's rent differs from the replacement's: that is a rent change, and a
rent change is `POST /tenancies/{tenancyId}/rent-changes` (ADR-0012), not a
correction.

**Anchoring keeps two jobs and loses the third.** A live schedule with
`source_lease_id = lease` still blocks voiding that lease
(`instrument_anchored` — an instrument may not vanish under live billing), and
becoming an anchor still requires a real instrument: `_rent_schedules_guard`
now demands the source lease be non-`draft` and non-voided. Anchoring no
longer gates editing at all.

**One enforcement point.** The `leases_guard` BEFORE INSERT/UPDATE trigger
computes the changed-column set by diffing `to_jsonb(NEW)` against
`to_jsonb(OLD)` and raises with the `invalid:` / `conflict:` prefixes the
routes already map. Routes run no pre-checks. Two properties fall out of the
diff rather than being coded: echo-back tolerance (a read-modify-write client
re-sending the stored rent changes nothing, so nothing raises) and uniform
enforcement across every write path, including direct DB access.

| Code                  | HTTP | Raised when                                                                              | Client recovery                                          |
| --------------------- | ---- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `lease_executed`      | 409  | frozen field or backward status transition on an `active`/`expired` lease                | rent-changes for a rent change; replace for a correction |
| `lease_voided`        | 409  | any change to a voided lease                                                             | terminal; nothing to offer                               |
| `lease_superseded`    | 409  | any change to a `superseded` lease other than voiding it (directly or through `replace`) | offer create-new-lease (unchanged from ADR-0012)         |
| `instrument_anchored` | 409  | void of a lease anchoring a live schedule                                                | delete/end the schedule first (ADR-0012 §1 recipes)      |
| `schedule_conflict`   | 409  | replace whose rent differs from an anchored schedule's                                   | offer rent-changes instead                               |
| `invalid_request`     | 400  | `corrects_lease_id` naming a non-voided lease, or one from another tenancy               | void the target first                                    |

## Rejected alternatives

- **`DELETE` with a reason in the body** (the literal §26 ask): the operation
  is not a delete — the row stays readable, listed, and linkable — and the
  idempotency middleware excludes DELETE bodies from its replay fingerprint, so
  two reasons under one key would silently collapse. A named POST verb says
  what happens and fingerprints its body.
- **Keep anchoring as the edit gate:** it makes editability depend on a
  billing accident, leaves signed-but-unanchored leases rewritable, and blocks
  the one edit that is always safe (a draft).
- **Cascade void (voiding a lease voids its schedules and charges):** the
  money side has its own reversal semantics with a permanence rule (a voided
  (schedule, period) pair never re-bills under that schedule id, ADR-0012).
  An implicit cascade would silently un-bill periods with no way back.
- **Hard delete for junk leases:** removes the subject of the audit rows that
  are the defense; a void with a reason costs one row and reads as candor.

## Consequences

- **Contract breaks (deliberate).** `DELETE /leases/{id}` is gone (404). A
  rent edit that was a flat 400 is now 200 on a draft and 409 `lease_executed`
  on an executed lease — clients must branch on status, not on a single error.
  `superseded` leases, previously patchable in `term_end`/deposits/`document`,
  now reject everything but void and replace. Voiding an anchored lease is
  refused.
- **Void does not stop billing.** Voiding an _unanchored_ lease leaves the
  tenancy's rent schedules and the ADR-0011 generator untouched — nothing
  reads the lease at billing time. Stopping money is a schedule act
  (`/end`, `DELETE /rent-schedules/{id}`, or a rent change).
- **Replace is the only multi-row lease act, and it is atomic.** Void, insert,
  re-point, and back-link happen in one transaction under the per-tenancy
  lock, so a schedule is never left pointing at a voided instrument and never
  pointing at nothing.
- **Migration is additive with no data migration.** Three nullable columns,
  two CHECKs, one account-safe FK, a partial index, and function/trigger
  replacement. Existing rows keep their status with `voided_at` null, so the
  old contract's reads are unaffected until the new code ships.
- **Correction chains are readable by query.** `corrects_lease_id` with its
  partial index walks a tenancy's replacement history in either direction; the
  reasons come from `void_reason` and the before/after payloads from
  `public.events`.

## Revisit triggers

- **Adoption and import schedules still cite nothing** (ADR-0013 backfills and
  imported schedules leave `source_lease_id` null because no instrument
  exists) → an **attestation** instrument: a first-class "the landlord states
  this was the rent as of this date" row those schedules can anchor to,
  giving the drift detector and evidence exports a provenance row where they
  currently have a hole. This is the likeliest next step.
- **Execution moments become knowable** (e-signature, countersigned scans) →
  a set-once `executed_at`, with the freeze keyed to it rather than to
  `status = 'active'`.
- **Replacement chains grow long in practice** → a lease-version read model,
  rather than clients walking `corrects_lease_id` hop by hop.
