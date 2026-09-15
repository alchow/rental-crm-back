# ADR-0016: Reviewed rent adjustments

Status: accepted; implementation is local until the additive migrations and API are deployed.

## Decision

Separate three commands instead of inferring intent from an amount:

- `edit_details`: correct lease dates/deposit without changing billing.
- `correct_rent`: correct the recorded rent and explicitly selected billing periods.
- `change_rent`: retain earlier rent and start a new amount on an effective date,
  with an explicit supporting lease/amendment or served notice.

Lease dates, tenancy possession, billing dates, deposit requirement, and received
cash are independent facts. An executed lease correction creates a linked record
with the same lifecycle status; it does not assert another signed agreement.

## Write authority

`routes/rent-adjustments` validates the HTTP shape. `_plan_rent_adjustment` is the
single database authority for both preview and commit. A stable preview snapshot
includes complete relevant row sets, input, and actor in its fingerprint.

```text
$1,500 September bill + $1,500 payment
  -> preview: corrected bill $1,800, payment retained $1,500, remaining $300
  -> tenancy lock + fresh plan + token comparison
  -> reverse old application; void old bill; replace lease/schedule/bill
  -> apply the same $1,500 payment to the replacement bill
  -> immutable receipt + idempotency response in the same transaction
```

Only `rent_adjustment_writer` can create correction lineage. It is a narrow,
non-login role, not a service-role bypass. RLS and account-safe foreign keys
remain active. `_request_actor` uses a SQL-standard body to bind `auth.uid()`
without granting the writer access to Supabase's separately owned auth schema.

Commit re-plans instead of accepting executable mutations from the client. A
stale token or failed invariant rolls back every effect. The immutable receipt
supports same-key replay, recovery, and paginated history; current balances still
come from the ledger, not the receipt.

## Money and periods

Applications are reversed and recreated with `corrects_allocation_id`; payment
amount, date, and reference are untouched. Carryover is capped at the replacement
bill amount in `(created_at,id)` order. Excess remains credit on its original
payment. Unrelated credit is never consumed automatically.

Selected correction ranges split a schedule into unchanged prefix/suffix and
corrected middle. Existing affected bills are reissued synchronously; missing
historical bills are not invented. Manual amounts require explicit overrides.
Dependent fees are voided, their applications released, and no new fee is asserted.
Waived periods get voided successor markers so schedule-ID changes do not make
the generator charge them again.

A genuine change uses the existing rent-change primitive inside the transaction.
Changing the due day maps existing affected monthly bills to the new due day;
periods outside the successor's bounds are voided, with payment released as credit.
No daily prorating is inferred.

## Writer ordering and reports

The generator and commands acquire the tenancy `rent_change:` advisory lock
before reading eligible schedules. Direct row updates already hold row locks
when their trigger runs, so they use a nonblocking advisory lock and return
retryable `40001` on contention instead of deadlocking. Guards recheck retired
schedule and voided-parent references after waits.

`ledgerRowsAt` excludes a backdated replacement created after a report cutoff,
while restoring the original bill if it was voided after that cutoff.
Applications use their own creation/reversal timestamps. Current statements
show the restated ledger and retained history; prior exports are not rewritten.
Rollup `as_of` classifies current balances by due date, not historical knowledge.

## Compatibility and rollout

ADR-0014's legacy `/replace` and ADR-0012's legacy rent-change API remain available.
New clients use preview/commit; old clients keep their documented recovery paths.
Deploy migrations and API before the frontend. Roll back the frontend if needed;
never delete correction receipts or reverse published migration history.

Proof: `rent-adjustments.test.ts`, `ledger-history.spec.ts`, and
`db/test/rent-adjustment-concurrency.test.ts` cover money, cutoff, replay, RLS,
immutable evidence, and writer races.
