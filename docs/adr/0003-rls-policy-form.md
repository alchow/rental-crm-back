# ADR-0003: RLS policy form — initplan membership subquery

- **Status:** accepted and BUILT (migration `20260615000002_rls_initplan_policies.sql`), 2026-06-11

## Context

Phase 2 policies guarded every domain table with
`using (public.is_account_member(account_id))`. The function is STABLE and
takes the row's `account_id` as an argument, so Postgres cannot hoist it: on
scans it runs **once per candidate row** (an index probe into
`account_members` each time).

The alternative binds no per-row argument, so the planner evaluates the
caller's membership set once per statement (hashed initplan):

```sql
using (account_id in (
  select m.account_id from public.account_members m
   where m.user_id = (select auth.uid()) and m.deleted_at is null))
```

## Measurement (db/test/bench-rls.ts; adoption bar was ≥20%)

100k interactions, local Supabase stack, role `authenticated` with real JWT
claims GUC, medians of 5:

| query | per-row EXISTS (A) | initplan IN (B) | delta |
|---|---|---|---|
| full-scan `count(*)` | 471 ms | 9 ms | **−98%** |
| keyset page (limit 50) | 2.8 ms | 1.3 ms | −54% |

## Decision

Adopt form B for **every** policy that referenced
`is_account_member(account_id)` — 33 policies rewritten dynamically over
`pg_policies` (a hand-kept list would silently miss tables; the migration
asserts zero leftovers). `accounts_member_select` keeps the helper (its
argument is `accounts.id` — point lookups, nothing to hoist), and
`is_account_member()` itself remains for future point-lookup policies.

Both forms enforce the identical predicate; the CI isolation suite (36
tables, two accounts) and its planted-leak meaningfulness check pass
unchanged against form B, and the CI restore step now reinstalls form B.

## Consequences

- The membership set is snapshotted per statement instead of per row —
  semantically identical under READ COMMITTED for our usage (membership
  changes mid-statement were never a defended case).
- New tables MUST copy form B; copying the old helper form re-introduces the
  per-row cost. The benchmark script stays in-repo to re-litigate with data.
