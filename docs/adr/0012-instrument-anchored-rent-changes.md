# ADR-0012: Instrument-anchored rent changes

- **Status:** accepted, 2026-07-06
- **Context owner:** money subledger (docs/api-guide.md §7) + occupancy (leases,
  notices)
- **Implements:** migration `20260706000001_instrument_anchored_rent_changes`,
  routes `api/src/routes/rent-schedules.ts` (rent-changes verb),
  `api/src/routes/notices.ts` (new), `api/src/routes/leases.ts` (PATCH guard),
  allowlist `api/src/admin/storage.ts`, runner warning
  `api/src/admin/rent-charges.ts`.
- **Builds on:** ADR-0011 (auto rent charging), ADR-0001/0008 (audit chain),
  ADR-0010 (evidence posture).

## Context

Rent lives in three separately-stored layers, all audited but previously
unlinked:

1. **Contract** — `leases.rent_amount_cents`: what was agreed.
2. **Billing instruction** — `rent_schedules.amount_cents`: what the generator
   is told to bill (ADR-0011 turned this into real, automatic invoicing).
3. **Ledger** — `charges.amount_cents`: what was actually billed, with
   `source_schedule_id` provenance.

Nothing tied layer 1 to layer 2. A renewal signed at $2,100 with a forgotten
schedule kept auto-billing $2,000 — silently, forever. Over-billing in the
other direction is genuine legal exposure. And the two layers contradicting
each other weakens _both_ as evidence: "contract says $2,100, your own invoices
say $2,000" is the first thing opposing counsel reads out.

The obvious fix — derive billing from the lease, or a DB constraint forcing the
amounts equal — is **legally wrong**, not merely inconvenient. What legally
effects a rent change depends on the tenancy form:

- **Fixed-term:** rent is locked for the term; changing it takes an escalation
  clause already in the lease, a signed amendment, or a renewal — a _lease-side
  instrument_.
- **Month-to-month:** rent changes by **unilateral written notice** with a
  statutory lead time (30–180 days depending on jurisdiction and increase
  size; e.g. Cal. Civ. Code §827, NY RPL §226-c, ORS 90.600, WA HB 1217,
  Seattle SMC 180-day). **No lease exists or is signed.** The evidence a court
  asks for is the served notice: what, when, how served, effective date.
- **Regulated units** (e.g. NYC rent-stabilized): a prescribed renewal-lease
  process (RTP-8) — again lease-side, with jurisdiction-specific mechanics.

The schema has always known this: "a tenancy never requires a lease"
(phase 2), and `notices` has carried `served_at` / `served_method` since
phase 2 — but notices had no API surface, and neither leases nor notices could
anchor a schedule. Two smaller warts compounded it: lease `PATCH` allowed
in-place `rent_amount_cents` edits (despite `status = 'superseded'` existing
precisely for append-style changes), and the attachments allowlist excluded
`leases`/`notices`, so a signed renewal PDF or served-notice scan had nowhere
evidence-grade to live.

## Decision

**A rent change is an event anchored to a legal instrument — a lease or a
served notice — never an in-place edit.** Divergence between layers is
_detected and attributed_, not prevented: the same record-and-detect posture as
void-not-delete, derived-not-stored balances, and tamper-evident-not-proof.

**1. Provenance columns on `rent_schedules`.** `source_lease_id` and
`source_notice_id` (both nullable, composite-FK'd within the account,
`on delete set null`) plus optional free-text `change_reason`. With
`charges.source_schedule_id` this completes an unbroken evidentiary chain:
**instrument → schedule → charge** — "why did you bill $2,000?" now has a
row-level answer. Nullable because imports and legacy rows predate the flow.

**2. One atomic verb: `change_tenancy_rent` (SECURITY INVOKER).**
`POST /accounts/{accountId}/tenancies/{tenancyId}/rent-changes` calls a single
RPC that, in one transaction under a per-tenancy advisory lock: validates the
anchor (≥1 of lease/notice, same account _and_ tenancy), ends open same-kind
schedules at `effective_date − 1`, inserts the successor schedule
(`start_date = effective_date`) carrying the provenance, supersedes other
active leases when lease-anchored, and activates a `draft` anchor lease.
INVOKER, not DEFINER: every statement runs under the caller's RLS, so
membership is enforced by the same `*_member_all` policies as direct writes and
the audit chain attributes the change to the caller's JWT. Generator
compatibility falls out of the era split: the successor has a new id, so
ON CONFLICT `(source_schedule_id, period_start)` idempotency is preserved per
era; periods ≥ effective date belong to the new amount with no gap or overlap.

**3. Drift is detected, never blocked.** `detect_rent_drift(account_id)`
reports tenancies whose active-lease rent ≠ the sum of open `kind='rent'`
schedules (or whose currencies mismatch). The cron runner (ADR-0011) calls it
per opted-in account after generating and logs `rent_drift_detected` loud — for
auto-charge accounts, drift _is_ wrong invoices. It is not a constraint because
legitimate divergence exists: NY legal-vs-preferential rent, rent+parking
decomposition across schedule kinds, no-lease tenancies. A hard equality
constraint would also force update-ordering choreography across two aggregates
— exactly the coupling ADR-0004 declined for routes, here at the data layer.

**4. Lease rent terms become immutable via PATCH.** `rent_amount_cents` /
`rent_currency` are removed from the PATCH contract and explicitly rejected
with a 400 pointing at the rent-changes endpoint (explicit rejection, not
zod-strip, so an old client's rent edit fails loudly instead of silently
no-oping). Deposits stay patchable. A mistyped lease is corrected the append
way: soft-delete + recreate — never billed, never load-bearing.

**5. Instruments take attachments; documents stay optional.** `leases` and
`notices` join the attachments allowlist, so a signed renewal PDF or a
served-notice scan attaches directly to its instrument and inherits
`content_hash` (SHA-256) + server-set `received_at` — tamper-evident from
upload. The _anchor row_ is required; the _document_ is corroboration. A
mandatory upload would push landlords who served a paper notice back outside
the system, destroying the trail entirely. Completeness ("no document attached
to this instrument") is an evidence-export concern, not an entry gate.

**6. Notices get a minimal CRUD API.** The table predates this ADR; the flow
makes it load-bearing, so it gets list/get/create/patch/soft-delete, shaped
like leases. `served_at`/`served_method` are plain audited columns —
set-once triggers (the `logged_at` treatment) are a deliberate non-goal until
serving workflows firm up.

**Corrections policy** (the typo case): never billed → soft-delete the schedule
and recreate against the _same_ instrument; already billed → void the wrong
charges (`void_reason`) and end-and-replace the schedule. The audit chain
showing "created wrong, fixed 40 seconds later" is a feature — courts distrust
altered records, not corrected ones.

## Rejected alternatives

- **Derive billing from the lease** (schedule loses its amount): breaks
  no-lease and holdover tenancies outright — the month-to-month majority has no
  lease to derive from.
- **DB equality constraint / trigger between lease and schedule:** blocks
  legitimate divergence, ill-defined under decomposition, and turns every
  legitimate change into deferred-constraint choreography.
- **Require a document upload per rent change:** falsifies the legal reality
  (the _served notice_, not the PDF, is the instrument) and incentivizes
  off-system changes.
- **Do nothing:** ADR-0011 made drift automatic — a stale schedule no longer
  waits for a human to notice it before billing wrongly.

## Consequences

- **Contract break (deliberate):** lease PATCH no longer accepts
  `rent_amount_cents`/`rent_currency`; clients get an explicit 400 with the
  replacement flow. Front-end must move rent edits to the rent-changes
  endpoint.
- **Migration before deploy, additive:** the migration is nullable columns +
  two INVOKER functions — safe to apply to prod ahead of the code deploy
  (nothing reads the new objects until the new code ships). Same order as
  every migration here: schema first, code second. A human runs prod
  `migrate`/`db push`.
- **The blessed path is optional by design.** Direct schedule create/end
  remains (imports, edge cases) and now carries optional provenance; the drift
  detector is the backstop for whatever bypasses the verb.
- **Jurisdictional compliance is out of scope, on purpose.** Notice-period
  math (30/60/90/180 days), increase caps, first-year freezes, prescribed
  forms: policy-layer material, per-jurisdiction, needs counsel — not schema.
  The data model records _what happened_; a future compliance layer can judge
  _whether it was enough_.
- **Mid-period proration is out of scope.** An effective date off the due-day
  boundary changes which _era_ bills a period; it does not split a period.

## Revisit triggers

- **Serving workflows land** (mail-service integration, e-signatures) →
  revisit set-once triggers on `served_at` and a proof-of-service attachment
  convention.
- **A compliance layer is funded** → per-jurisdiction notice/cap validation
  reads the same instrument rows; nothing here changes.
- **Evidence exports grow an instrument view** → surface the
  instrument → schedule → charge chain and the "no document attached"
  completeness flag in export-pdf.
