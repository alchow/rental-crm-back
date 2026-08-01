# ADR-0011: Automatic rent charging — opt-in, advance-timed, scheduled in IaC

- **Status:** accepted, 2026-07-04; **decision 1 amended 2026-08-01** — the flag
  now defaults to `true`, so automatic charging is **opt-out**. See
  [Amendment — 2026-08-01](#amendment--2026-08-01-the-default-flips-to-on)
  at the end of this file. Decisions 2–5 stand unchanged and are current.
- **Context owner:** money subledger (docs/api-guide.md §7) + ops (render.yaml)
- **Implements:** migration `20260704000001_auto_rent_charging`, route
  `api/src/routes/settings.ts`, runner `api/src/admin/run-rent-charges.ts`;
  amended by migration `20260801000001_auto_charge_default_on`.

## Context

Phase 9 shipped `generate_rent_charges(account_id, as_of)` — an idempotent SQL
generator that turns `rent_schedules` rows into `charges` rows. It was written
"define, don't schedule": the function existed but nothing ever called it on a
timer. That gap was papered over in the API guide, which claimed "a server-side
cron calls `generate_rent_charges()` daily" — false on two successive phases.
Turning automatic charging on for real forces four decisions that a bare
generator left unmade: **who** gets billed, **when** the charge appears, **what
runs the timer**, and **how billing stops** when a tenancy ends.

Two facts constrain all four:

1. **A `rent_schedules` row is not consent to bill.** Bulk import already wrote
   schedules for existing accounts to record their *lease terms*. Reading those
   as an instruction to auto-charge would surprise-bill every imported account
   the first time a fleet-wide cron ran.
2. **Rent is due on the first of the period it covers.** A charge that only
   appears *on or after* the due date gives the tenant no window to pay on time;
   the invoice has to exist slightly ahead of the date it is owed.

## Decision

**1. Opt-in per account (`accounts.auto_charge_enabled`, default `false`).**
_Amended 2026-08-01: the default is now `true`. The paragraph below is retained
as the original decision and the reasoning that made default-`false` right in
July 2026 — see the Amendment at the end of this file for what replaced it and
why. The per-account flag, the RLS gate, and the single-writable-column shape
are unchanged._
No account is billed until its owner/manager deliberately flips the flag via
`PATCH /accounts/{accountId}/settings`. The write runs under the caller's JWT
through PostgREST, gated by RLS policy `accounts_member_settings_update`
(owner/manager only — a viewer must not be able to start billing tenants). The
API layer exposes exactly one writable column (`auto_charge_enabled`) because
Postgres RLS cannot restrict an UPDATE to a single column; any other member
UPDATE is still captured by the accounts audit chain, so it is tamper-evident
even though RLS alone cannot forbid it.

**2. Advance timing.** The generator emits **next** period's charge the moment
`as_of` passes **this** period's due day (`day > due_day → next month`, else
this month). Running July 2 with `due_day = 1` generates the August 1 charge;
running on July 1 itself still emits July (due day "not yet passed"). The
tenant thus receives each invoice about a month ahead of when it is owed.

**3. Render cron over pg_cron.** Scheduling lives in `render.yaml` as a
`type: cron` service (`rent-charge-generator`, `0 8 * * *` UTC) that runs the
`charges:generate` script (`api/src/admin/run-rent-charges.ts`). Chosen over a
pg_cron job for two reasons: (a) the "define, don't schedule" split is exactly
what let the generator sit un-run — twice; putting the schedule in reviewable
IaC alongside the app makes "is it actually scheduled?" answerable in a diff,
not a database inspection; (b) the runner is TypeScript in-process, so it can
later fan out into **comms notifications** (email/SMS the tenant when the
invoice is created) — an integration that SQL cannot reach cleanly. The runner
enumerates only opted-in accounts and calls the generator **once per account**,
so each call takes the migration's per-account advisory lock and commits a
short, contiguous audit-chain transaction rather than one fleet-wide megatxn.

**4. Tenancy-end cascade.** An `after update` trigger on `tenancies` writes the
end date onto the tenancy's still-open `rent_schedules` only when the tenancy
status flips to `ended`; editing `end_date` alone does not mutate schedules.
The generator already refuses to bill an ended tenancy at runtime; the cascade
makes the stop **durable and visible** — the schedule reads "ended <date>" in
the ledger/UI instead of being silently skipped by the cron. It only ever
*shortens* schedules and never resurrects them (re-opening a tenancy does not
re-extend billing — that would be a second kind of surprise bill).

**5. Defense-in-depth flag check.** The opt-in flag is re-checked in the two —
and only two — places that can trigger billing: the cron **runner** (enumerates
`auto_charge_enabled = true` only) *and* the **generator** itself (returns the
empty set for any account whose flag is false or missing). Either layer alone
would prevent a surprise bill; both are present so that a stray manual RPC (an
admin console, a mis-scoped script) cannot bill an account the runner would
have skipped.

## Consequences

- **No account is billed by accident.** Opt-in default-false plus the double
  flag check means an imported schedule sits inert until a human turns billing
  on; a mis-scoped RPC cannot override that. _(Amended 2026-08-01 — the default
  is now `true`; the guarantee is now "no account is billed without a live rent
  schedule". See the Amendment at the end of this file.)_
- **Scheduling is now a reviewable artifact.** Whether the generator runs, and
  when, is visible in `render.yaml` — the failure mode that shipped twice
  (function defined, never scheduled) is caught in code review.
- **Idempotent + advance-timed ⇒ operationally forgiving.** `ON CONFLICT
  (source_schedule_id, period_start)` plus a ~1-month lead means a missed,
  delayed, retried, or overlapping run cannot double-bill and always has slack
  to heal on the next day's run. Per-account failures in the runner are logged
  loud (`rent_charges_account_failed`) but do not fail the whole pass.
- **Manual charging is unchanged.** `POST /charges` still works at any time and
  produces a byte-identical `Charge` row; the two paths never conflict because
  the generator dedupes on `(source_schedule_id, period_start)`.
- **A per-account UPDATE surface exists on `accounts`.** RLS authorizes an
  owner/manager to UPDATE any column on their own account; the single-column
  restriction is an API-layer guarantee, backstopped by the audit chain — not
  an RLS one. Documented here so a future settings field is added deliberately.

## Revisit triggers

- **Tenant notifications land** → the runner fans each created charge into the
  comms outbox; this is the reason the timer is TypeScript, not pg_cron.
- **Sub-daily or timezone-local billing is required** → the single `0 8 * * *`
  UTC schedule becomes per-account or higher-frequency; the generator's timing
  math and idempotency are unchanged by design.
- **Instance/scale changes** → the cron is a separate one-shot service, so it is
  unaffected by web autoscaling (ADR-0005); revisit only if a second scheduler
  could race it (it cannot today — idempotency makes a double-run safe anyway).

## Amendment — 2026-08-01: the default flips to ON

- **Amends:** decision 1 only. Decisions 2 (advance timing), 3 (Render cron),
  4 (tenancy-end cascade) and 5 (defense-in-depth flag check) are unchanged.
- **Implements:** migration `20260801000001_auto_charge_default_on`.

### What changed

`accounts.auto_charge_enabled` now defaults to `true`, and every live account
that still carried the `false` default was backfilled to `true` in the same
migration. Automatic rent charging is **opt-out**: a landlord who does not want
it flips the flag off via `PATCH /accounts/{accountId}/settings`, the same
owner/manager-gated write as before.

### Why the original rationale expired

Decision 1 rested on one fact: *"a `rent_schedules` row is not consent to
bill"*, because bulk import had already written schedules for accounts that
never asked to be billed. That cohort is gone, and the audit that closed the
question is small enough to state in full (read-only queries against prod,
2026-08-01):

| Fleet fact | Count |
| --- | --- |
| Live accounts | 8 |
| Accounts with at least one live rent schedule | 2 |
| …of those, already `auto_charge_enabled = true` | 2 |
| Accounts with `auto_charge_enabled = false` | 6 |
| …of those, with any live rent schedule | 0 |
| Accounts billing manually *alongside* a live schedule (double-billing risk) | 0 |

So the backfill changes **no billing behaviour for any account that exists
today** — every account it touches has nothing to bill. What it changes is the
expectation for the next schedule anybody records, on any account.

The second reason is a product one. Default-`false` made the money surface lie
by omission: a landlord records "rent is $2,000 on the 1st", the app accepts it,
and the ledger then stays empty because a switch they had no reason to look for
was off. Recording the schedule **is** the instruction to bill. Declining to
bill is the deliberate act, so declining is what should require the explicit
flip.

### What did not change, and why this is not a surprise-billing regression

- A charge is still only minted where a **live rent schedule covers the
  period**. A flag-on account with no schedule is billed exactly nothing, so
  flipping the default cannot by itself create a charge anywhere.
- The generator still **never backfills**: it emits at most one window per
  schedule per run, so turning the flag on cannot produce a stack of back-months
  for a retroactively-imported schedule.
- Decision 5's double flag check is intact — the runner enumerates
  `auto_charge_enabled = true` and the generator re-checks the same flag. The
  flag remains the single switch; only its default moved.
- The ended-tenancy guard and the tenancy-end cascade (decision 4) still stop
  billing when a tenancy ends.

### Consequences that this amendment replaces

- The consequence *"No account is billed by accident"* now reads: no account is
  billed **without a live rent schedule**. Consent is expressed by recording the
  schedule rather than by a second, separate switch.
- The safeguard against a mass-import cohort is now the **absence of that
  cohort** plus the schedule requirement, not the column default. A future bulk
  import that writes `rent_schedules` for accounts that did not ask to be billed
  must set `auto_charge_enabled = false` on the rows it creates — that is the
  new revisit trigger below.

### Revisit trigger added

- **A bulk import (or any mechanical writer) starts creating `rent_schedules`
  rows on behalf of accounts that did not enter them** → the schedule is no
  longer a reliable proxy for consent, and the importer must explicitly opt
  those accounts out, or the default must be reconsidered.
