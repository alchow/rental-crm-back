# Re: usability-test findings + Field Log backend asks — answers and what's shipping

Status: answered 2026-07-10. We investigated every item against both codebases (your `main` as of
`e4f72a9`, ours at `d0060e1`) rather than taking the entries at face value — two of the asks
describe problems that no longer exist or never did, and one turned out to be a deeper contract
hole on our side than the finding suggested. Ship list at the bottom.

---

## C2 — intake 400s: root-caused; fixed server-side, no frontend change required

You reported every tenant submission answering 400 "Required". Confirmed, and the root cause is
on us. The chain:

```
your intake page                              our API (before the fix)
────────────────                              ─────────────────────────
POST /v1/intake/{secret}
{title, severity, description}       →        area_id (uuid) was REQUIRED
                                              → missing → 400
                                              → message dropped the field path:
                                                literally "Required"
```

Three compounding problems, only one of them yours — and yours was caused by ours:

1. **`area_id` was required, but a tenant client cannot supply it.** The tenant is unauthenticated;
   there is no endpoint that lists area UUIDs for a token. The requirement was unsatisfiable.
2. **Our published OpenAPI spec omitted this endpoint's request body entirely** — your generated
   types said `requestBody?: never`, which is why the page hand-rolls an untyped `fetch` and no
   tooling caught the gap. (A stale comment in our handler claimed the body was documented. It
   wasn't.)
3. **Our 400 messages dropped Zod field paths**, and a malformed JSON body was silently parsed as
   `{}`, which also surfaced as "Required".

**Shipped (PR 1):**

- `area_id` is now **optional and defaults to the tenancy's own unit** — the token already binds
  exactly one tenancy, and a tenancy is one unit. Your current payload now returns **201 as-is**:

  ```
  POST /v1/intake/{secret} {title: "Leaky faucet", severity: "routine"}
    → 201 {maintenance_request_id, interaction_id, ...}
    → request filed on the tenant's unit; audit actor = tenant:<token_id>
  ```

  If a submitter does send `area_id`, it is still validated against the token's property.
- The request body is now in the spec (both `application/json` and `multipart/form-data`) —
  regenerate your client and the hand-rolled fetch can become typed.
- Errors are actionable: `"title: Required"` plus a structured `details.fieldErrors` map;
  malformed JSON gets its own distinct 400.

**The "Used 6×" counter.** `use_count` was never a usage total — it is rate-limit state
(attempts in the current 10-minute sliding window; failures count, and it resets every window).
Rendering it as "Used N×" was wrong even before the 400s inflated it. Token rows now carry
**`submission_count`** — lifetime successful submissions, bumped only on 201 — which is the number
to render. Please switch the People-sheet label to it; `use_count` stays for back-compat but its
spec description now says what it is.

---

## B1/B13 (remainder) — "server-side FIFO" never existed; nothing changed on 7/7

Your NEW entry asked us to confirm intended semantics after observing that omitted `allocations`
"no longer FIFO-allocates", contradicting the morning's behavior. We checked every commit in the
repository's history: **the server has never auto-allocated a payment.** The create-payment RPC
has only ever inserted the allocation rows the client passed; omitted `allocations` has always
meant zero allocations.

What actually happened on 7/7: the morning payment (Dana's) was allocated by **your own client** —
your `allocateOldestFirst` (`src/lib/money.ts`) computes an oldest-first plan and sends it
explicitly. The deposit charge was the oldest open charge, so the plan targeted it. Your comment
"the backend would FIFO it" (`MoneyRecordForms.tsx`) is a belief our API never implemented; you can
delete the defensive framing, though **always sending an explicit plan remains the right call** —
it makes the UI's preview and the ledger agree by construction.

**Confirmed semantics, safe to rely on:** a payment with no allocations is **unapplied credit** —
counted in `totals.unapplied_credit_cents` (your MoneySheet already renders this), never lost,
allocatable later via `POST /payments/{id}/allocations`. Old/third-party clients that omit the
field do not "strand" money; they record money received without asserting what it pays for, which
is a legitimate state.

**Declined: refusing/warning on "time-inverted" allocations.** A 2024-received payment applied to
a 2026 charge is prepaid credit; a 2026 payment applied to a 2024 charge is arrears catch-up. Both
are ordinary bookkeeping, so the server will not police allocation dates. The wart the usability
test surfaced — money landing on an *unintended* charge — is solved by the explicit targeting you
now always send.

---

## B11 — the premise is stale: void has released allocations since 7/6

"Voiding does not release its charge allocation (known bug)" was true and was fixed the day before
your entry: migration `20260703000006` (in prod since 2026-07-06) makes the integrity trigger
ignore voided counterparts in **both** directions. Covered by DB tests.

So Dana's record is fixable today, with no new API:

```
Dana paid $1,000; it sits fully allocated to the deposit charge.

1. POST /payments/{id}/void   {void_reason: "misallocated — intended for June rent"}
     → the deposit charge's $1,000 of capacity is RELEASED
2. POST /payments  {amount_cents: 100000, received_at: <original date>, method, reference,
                    allocations: [{charge_id: <June rent charge>, amount_cents: 100000}]}
     → June rent shows paid; deposit shows open; the voided original stays
       visible with its reason — the history remains court-honest
```

**Declined: an edit/reallocate-in-place endpoint.** Allocations are deliberately immutable —
"correcting a misallocation is itself a reversal" is the ledger's design, and it is what keeps the
evidence trail intact. The two-step above is the blessed recipe (now also in the API guide). If
your users demonstrably fumble the two-step we'll consider a one-call `supersede` convenience that
does void+recreate atomically; ask again with data.

---

## Ledger `rent_*` totals — you're right; an honest per-type breakdown is coming (PR 2)

Confirmed: `rent_charges_cents` / `rent_balance_cents` mean "all non-deposit charge types", so a
$120 utility charge inflates what your UI labels "Rent balance". We can't rename the buckets —
they're in the spec's `required` list, the published SDK, our CLI, and the evidence-PDF export —
so the fix is additive:

```jsonc
"totals": {
  ...existing buckets unchanged (rent_* now documented as legacy "all non-deposit")...,
  "by_type": {
    "rent":    {"charges_cents": 120000, "allocated_cents": 0, "balance_cents": 120000},
    "utility": {"charges_cents":  12000, "allocated_cents": 0, "balance_cents":  12000},
    "deposit": {...}, "late_fee": {...}, "parking": {...},
    "repair_chargeback": {...}, "nsf_fee": {...}, "other": {...}   // all 8, zeros included
  }
}
```

Payments attribute to a type through their allocations — the same rule the existing deposit split
uses, so `by_type.deposit` always equals the legacy deposit buckets, and the non-deposit rows sum
to the legacy `rent_*`. Label the headline honestly and prefill "record rent payment" from
`by_type.rent.balance_cents`.

---

## C3 — tenancy `start_date` correction path: shipping with guards (PR 3)

Agreed this is real corruption in an evidence-grade record. `PATCH /tenancies/{id}` will accept
`start_date` with rules that keep the timeline honest:

- **Allowed while the tenancy has no non-voided charges or payments.** Once money is on the books
  the timeline is anchored; correcting then means the ADR-0012-style void/recreate recipes.
  Refusal is a typed `409 {code: "tenancy_has_money"}`, not a mystery.
- **Status must stay coherent:** a future `start_date` requires `status: "upcoming"` in the same
  PATCH (the nightly sweep re-activates it on the new date).
- `end_date >= start_date` still holds.

Jordan Kim's record (created Jul 7, meant Jul 15, no money yet): one PATCH fixes it.
Two side effects to know about, documented rather than blocked: evidence PDFs show the corrected
span from then on (that's the point), and re-running an *old import sheet* against a corrected
tenancy can duplicate it (import dedupe keys on start_date) — don't re-import old sheets after a
correction.

---

## C1/E1 + E2 — landlord-agent repo, with one useful fact

The verbatim system-prompt leak (C1/E1) is entirely the agent codebase; we've flagged it to that
team. On E2 ("claims no payments or ledger table"): **rental-crm-api already serves payments and
the ledger to agent-scoped tokens** — the agent firewall restricts journal *writes* only; reads
were never blocked. The fix is agent-side tool wiring, not new API surface. No "honest capability
statement" needed once the tool exists.

---

## Field Log asks

**#1 server-side search on /tenants, /properties — deferred.** Your own `data-layer.md` says
client-side search is fine at v1 scale, and the directory needs the full list anyway for attention
signals — a `q=` param wouldn't remove a single request from your current pages. The trigram
indexes already exist server-side, so this is cheap to add the day it pays for itself; revisit
trigger: an account approaching ~1k tenants, or the directory dropping full-list loading.

**#2 multi-status filter — accepted (PR 6).** `?status=open,triaged,in_progress` on
`/maintenance-requests` and `/tenancies` (comma-separated; single value keeps working). Note the
spec's `status` param widens from enum to string — regenerate and keep passing your typed values.

**#3 by-tenant membership — accepted, as the bulk endpoint (PR 4).**
`GET /accounts/{id}/tenancy-members` (keyset-paginated, optional `tenant_id` / `tenancy_id`
filters). One call replaces the whole members fan-out on /tenants **and** serves tenant detail via
`?tenant_id=`. We chose this over a `tenant_id` filter on `/tenancies` because your directory needs
*all* memberships, not per-tenant queries. One semantic note: a cross-account filter value returns
an empty 200 (RLS floor), not a 404 — same as `/interactions?tenancy_id=`.

**#4 account-wide rent rollup — accepted (PR 5).** `GET /accounts/{id}/rent-rollup` → one row per
current tenancy: `{tenancy_id, status, currency, rent_balance_cents, deposit_balance_cents,
unapplied_credit_cents}`, default `status=active,holdover`, overridable. Computed in one SQL pass
with the ledger's exact rules (still derived on read, never stored), and guarded by a parity test
that asserts rollup == per-tenancy ledger, so the two can't drift. This removes your
`RENT_DUE_FANOUT_CAP` — every door can be priced with one call.

**#5 interactions filters — accepted, scoped (PR 6).** `?party_type=&party_id=` for "everything
involving this vendor/tenant" (served by the participants index; complete across history thanks to
the 20260703000005 backfill — and we're closing the one write path that still skipped the
participants cast), plus `?area_id=`. Caveat we'll document: corrected entries' *head* rows carry
no cast, so `party_id` + `latest_only=true` composes with care.

---

## Ship list

| PR | Contents | Status |
|----|----------|--------|
| 1 | Intake fix (area_id default, spec body, field-path 400s, `submission_count`) + this doc | this PR |
| 2 | Ledger `totals.by_type` | next |
| 3 | `start_date` PATCH + guards | next |
| 4 | `GET /accounts/{id}/tenancy-members` | next |
| 5 | `GET /accounts/{id}/rent-rollup` + parity test | next |
| 6 | Multi-status + interactions `party_id`/`area_id` filters | next |

After PR 1 deploys, your existing intake page works unchanged; regenerate the SDK when you want the
typed request body and `submission_count`.
