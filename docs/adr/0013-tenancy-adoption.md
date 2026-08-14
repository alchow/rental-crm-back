# ADR-0013: Tenancy adoption — atomic historical backfill and opening balance

Status: accepted (2026-08-10). Implements the architecture agreed in
`docs/statement-setup-design-reply.md`. Not yet triggered in production until
the Field Log adoption wizard ships.

## Context

A landlord who starts using the app months into a live tenancy has no honest
way to represent the past. The generator deliberately never backfills
(ADR-0011), `POST /charges` is single-row, and every mutation holds its own
idempotency scope — so reconstructing N months of history takes N+M sequential
requests, and a mid-sequence failure strands half a ledger. There is also no
way to say "the tenant owes $X from before tracking began" without minting a
charge that claims a specific billing history the landlord never witnessed.

The Field Log adoption wizard needs exactly two commit shapes, both atomic:

- **Itemized backfill**: a rent schedule with a past start date, one charge
  per elapsed month, the payments actually received (with their real dates),
  and the landlord's proposed payment→charge matching.
- **Opening balance**: the same schedule, no past charges or payments, and a
  single signed "owed / credit as of adoption" amount that is *not* a charge.

## Decision

One new table and one new SECURITY INVOKER RPC.

**`tenancy_adoptions`** — at most one live row per tenancy:
`adoption_date` (the day tracking began; drives the statement's "tracking
since" divider), signed `opening_balance_cents` (positive = tenant owes,
negative = credit; 0 for itemized backfills), `currency`, free-text
`balance_basis`, and `needs_review` (the wizard's "save as unresolved").
Owner/manager write policy at the DB (the incidents posture for new evidence
tables); member-wide reads; audited by `_emit_event`; no DELETE grant.

**`adopt_tenancy_history`** — one transaction that creates the rent schedule,
the past rent charges (each carrying `source_schedule_id`, the already
sanctioned marker for manually materialized schedule periods), the payments,
the caller-proposed allocations, an optional held deposit
(charge + payment + allocation), and the adoption row. SECURITY INVOKER: every
write runs under the caller's RLS, so the owner/manager insert policy on
`tenancy_adoptions` gates the whole commit. Errors use the stable
`invalid:` / `conflict:` / `not_found:` prefixes (ADR-0012 idiom).

Guards, in order: the same `rent_change:` per-tenancy advisory lock every
other schedule writer takes (so the virgin checks cannot race a concurrent
schedule creation into two billing eras); the tenancy must exist and not be
ended; the money timeline must be virgin (no live schedule, no non-voided
charge or payment, no live adoption); the schedule must not start before the
tenancy's recorded `start_date` (`tenancy_start_date_conflict` — correcting
the tenancy start is cheap while the timeline is virgin and impossible after
adoption money trips the `tenancy_has_money` guard); an opening balance and
itemized history are mutually exclusive; `adoption_date` cannot be in the
future and every backfilled date must be on or before it (payment timestamps
get a one-day UTC slack so a same-day receipt in a western timezone is not
rejected — the accepted trade-off is that such a payment appears in `?as_of`
snapshots from its UTC date onward, the platform-wide snapshot rule) and no
earlier than one month before the schedule start (year-typo guard). A
malformed `deposit` is rejected, never skipped. Allocation sums, counts, and
duplicates are pre-validated for clean 400s, with
`_assert_allocation_integrity` as the unchanged backstop.

Backfilled charge periods are **derived, never accepted, and snapped to the
schedule's due-day grid**: `period_start` is the grid date (day =
`due_day`) of the window containing `due_date`, `period_end` one month minus
a day later — while `due_date` stays the landlord's verbatim date. The
generator only ever emits grid-aligned windows, so the
`(source_schedule_id, period_start)` dedupe holds for ANY due date: a
caller-supplied period could escape the key (NULL/off-grid → the cron
re-bills the same month) or pre-claim a future window (→ silently missing
bill), and an un-snapped `period_start = due_date` re-opened the same hole
for off-grid dates (records dated the 1st under a due-day-15 schedule).

**The adoption row is written FIRST and backstopped at the database.** The
RPC inserts it before the schedule and money rows, so the owner/manager RLS
policy vetoes an under-privileged caller before anything exists to roll
back, and a `BEFORE INSERT` guard trigger re-asserts the virgin-timeline and
future-date invariants against **direct PostgREST writes** (the posture
precedent is the `rent_schedules` delete guard: member-writable money tables
carry their invariants at the DB, not only in routes). After commit the row
is frozen testimony — a `BEFORE UPDATE` trigger permits only `needs_review`
(resolved via `PATCH /tenancies/{id}/adoption`) and the audited soft-delete.

**Opening balance is a recorded fact, not a ledger row.** It is returned by
the ledger endpoint in a separate `adoption` block, never mixed into
charge/payment totals. Consequences fall out of the data model instead of
being enforced by code: it cannot take a late fee (the fee walker iterates
charges), cannot anchor a nonpayment notice line item, and never appears in
payment-dated received-rent exports.

## Alternatives considered

- **Loosen the generator to backfill past periods.** Rejected: "one window,
  never backfill" (ADR-0011) is load-bearing for idempotent cron behavior, and
  backfill needs human-reviewed amounts anyway — history is testimony, not
  derivation.
- **Model the opening balance as a `type='other'` charge.** Rejected: a charge
  asserts a billing event with a due date; the design's legal posture is that
  an opening balance cannot support fees or notices, which would then need
  API-level special-casing on an ordinary charge.
- **Sequential client-side POSTs.** Rejected: no atomicity, K idempotency
  scopes, and a torn ledger on failure.
- **Provenance tags stored on rows.** Rejected: derivable from recorded facts
  (`created_at` vs `due_date`/`received_at`, `source_schedule_id`,
  `source_lease_id`, the adoption row). Stored display tags would be a second,
  fakeable source of truth.

## Consequences

- The ledger response gains charge-entry `created_at` (the recording date —
  the payment side always had it) and a nullable `adoption` block, honored by
  `?as_of` (included only when `adoption_date <= as_of`).
- The evidence-export PDF includes the adoption opening balance with the
  same date-gating as the ledger's `?as_of` (absent when the range ends
  before `adoption_date`), renders the composition explicitly (itemized
  closing vs. total including the pre-tracking balance), and carries the
  `needs_review`/`balance_basis` qualifiers; a failed adoption read fails
  the export rather than printing a wrong figure.
- `GET /rent-rollup` does **not** include opening balances yet; a portfolio
  tile can understate an adopted tenancy's arrears. Revisit when the FE
  portfolio surfaces adoption state.
- Re-adoption requires operator help (soft-delete the adoption row and void
  the backfill); there is deliberately no un-adopt endpoint.
- The generator's `on conflict do nothing` dedupe key `(source_schedule_id,
  period_start)` makes cron emission and backfilled periods collision-safe in
  both directions.
- After a successful adoption the account's default-on auto-charging bills the
  next window from the new schedule on the next 08:00 UTC run; the current
  not-yet-due period intentionally appears then, not at commit time.
