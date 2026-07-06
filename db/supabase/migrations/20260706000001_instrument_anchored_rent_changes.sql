-- ----------------------------------------------------------------------------
-- Instrument-anchored rent changes: provenance columns + change_tenancy_rent
-- RPC + detect_rent_drift. (ADR-0012, written in parallel at
-- docs/adr/0012-instrument-anchored-rent-changes.md.)
--
-- WHY
-- ---
-- Rent lives in three layers: leases.rent_amount_cents (the CONTRACT),
-- rent_schedules.amount_cents (the standing BILLING instruction the generator
-- reads), and charges (the generated invoices, carrying source_schedule_id
-- provenance). Today a rent change is a bare UPDATE of a rent_schedule's
-- amount -- it records the new number but NOT the legal instrument that made
-- the change lawful. That instrument differs by tenancy type:
--
--   * FIXED-TERM tenancies change rent by signing a new/renewal LEASE.
--   * MONTH-TO-MONTH tenancies have no lease to sign; rent changes legally by
--     SERVING A NOTICE (e.g. a statutory rent-increase notice). There is no
--     lease row to point at, so a lease-only provenance model cannot express
--     the single most common change on a periodic tenancy.
--
-- So a rent change must be ANCHORED to a lease OR a served notice (or both --
-- a renewal that follows a notice). This migration adds that provenance to
-- rent_schedules and an ATOMIC operation, change_tenancy_rent, that:
--   - APPENDS a successor schedule and ENDS the prior one (append-don't-edit:
--     each billing era is a distinct, immutable schedule row with its own id,
--     so history reads back as "amount X until date D, amount Y after"),
--   - carries the anchoring instrument onto the successor,
--   - keeps the lease layer consistent (activates a pre-created draft renewal;
--     supersedes the leases the change replaces).
--
-- And detect_rent_drift, which DETECTS-DON'T-PREVENTS divergence between the
-- lease contract and the open billing schedules. Legitimate divergence is
-- real (NY preferential rent below the legal-regulated amount; rent split
-- across kinds like rent + parking), so drift is FLAGGED for a human, never
-- blocked at write time.
--
-- Mid-period proration is explicitly OUT OF SCOPE (ADR-0012): a change ends
-- the old era at effective_date-1 and starts the new era at effective_date, so
-- whole periods move cleanly from one amount to the next.
--
-- Chain compatibility (ADR-0008, same argument as 20260704000002's header):
-- rent_schedules is an audited table. The audit chain hashes row SNAPSHOTS
-- (to_jsonb(NEW) at write time) and verify_chain re-hashes the STORED
-- snapshot, so adding nullable source_lease_id / source_notice_id /
-- change_reason columns cannot invalidate any historical event; new-era
-- schedule rows carry the columns inside the hashed payload automatically.
-- No backfill, no schema_version bump, no verification change.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (1) Provenance columns on rent_schedules
-- ============================================================================
--
-- A schedule era is anchored to the instrument that authorized it. Both
-- columns are nullable (bulk-imported / pre-existing schedules have no anchor,
-- and a schedule is anchored to a lease OR a notice, rarely both). The
-- composite FKs (account_id, <col>) mirror the account-scoped FK style used
-- throughout phase 2 and reuse each parent's `unique (account_id, id)`.
--
-- on delete set null mirrors charges.source_schedule_id (phase 2): rows here
-- are void/soft-deleted, never hard-deleted, so the set-null path is a
-- defensive definition, not an operational path. change_reason has no length
-- CHECK, matching the void_reason / notices.body idiom -- the API bounds it.
alter table public.rent_schedules
  add column source_lease_id  uuid,
  add column source_notice_id uuid,
  add column change_reason    text;

alter table public.rent_schedules
  add constraint rent_schedules_source_lease_fk
    foreign key (account_id, source_lease_id)
    references public.leases(account_id, id) on delete set null,
  add constraint rent_schedules_source_notice_fk
    foreign key (account_id, source_notice_id)
    references public.notices(account_id, id) on delete set null;

comment on column public.rent_schedules.source_lease_id is
  'Provenance: the lease (renewal/new contract) that authorized this schedule '
  'era. Null for month-to-month notice-driven changes and legacy rows.';
comment on column public.rent_schedules.source_notice_id is
  'Provenance: the served notice (statutory rent-increase notice) that '
  'authorized this schedule era. Set for month-to-month changes; may co-exist '
  'with source_lease_id on a renewal that followed a notice.';
comment on column public.rent_schedules.change_reason is
  'Free-text reason for this rent change (API-bounded; no DB length CHECK, per '
  'the void_reason idiom).';

-- Partial indexes: these columns are mostly null (only change-driven eras
-- carry them), so a partial index keyed on the non-null rows is the compact
-- support for FK maintenance and provenance lookups.
create index rent_schedules_source_lease_id_idx
  on public.rent_schedules (source_lease_id)
  where source_lease_id is not null;
create index rent_schedules_source_notice_id_idx
  on public.rent_schedules (source_notice_id)
  where source_notice_id is not null;

-- ============================================================================
-- (2) change_tenancy_rent -- atomic, instrument-anchored rent change
-- ============================================================================
--
-- SECURITY INVOKER is deliberate. Every read/write below runs under the
-- CALLER's RLS. For an authenticated PostgREST caller the *_member_all
-- policies mean a non-member sees zero rows -- the tenancy lookup returns
-- nothing and the caller gets `not_found: tenancy`, never a cross-account
-- write. There is no RLS-bypass surface, so nothing to self-defend against
-- inside the function. Service-role callers bypass RLS as usual (cron/admin).
--
-- GENERATOR COMPATIBILITY (generate_rent_charges, 20260704000002)
-- --------------------------------------------------------------
-- The generator bills the period whose due date falls within
-- [start_date, end_date] of a schedule, deduped by ON CONFLICT
-- (source_schedule_id, period_start). Ending the OLD schedule at
-- effective_date-1 and starting the SUCCESSOR at effective_date hands every
-- period on/after effective_date to the new amount with NO gap and NO overlap.
-- Because the successor is a NEW row with a NEW id, its (source_schedule_id,
-- period_start) key space is disjoint from the old era's, so idempotency is
-- preserved per era -- the generator can never double-bill across the seam.
--
-- ALL error messages use the stable prefixes `not_found: `, `conflict: `,
-- `invalid: ` -- the API maps prefix -> HTTP status (404 / 409 / 400).
create or replace function public.change_tenancy_rent(
  p_account_id       uuid,
  p_tenancy_id       uuid,
  p_amount_cents     bigint,
  p_currency         text,
  p_effective_date   date,
  p_due_day          int  default null,
  p_source_lease_id  uuid default null,
  p_source_notice_id uuid default null,
  p_change_reason    text default null,
  p_kind             text default 'rent'
)
returns table (
  o_schedule_id          uuid,
  o_ended_schedule_ids   uuid[],
  o_superseded_lease_ids uuid[]
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenancy     record;
  v_lease       record;
  v_notice_id   uuid;
  v_rec         record;
  v_ended       uuid[] := '{}';
  v_superseded  uuid[] := '{}';
  v_inherit_due int;
  v_due_day     int;
  v_schedule_id uuid;
begin
  -- 1. Serialize concurrent rent changes for this tenancy. Two racing changes
  --    would otherwise both read the same "open" schedule set and each end it /
  --    insert a successor, producing overlapping eras.
  perform pg_advisory_xact_lock(hashtextextended('rent_change:' || p_tenancy_id::text, 0));

  -- 2. Input validation (stable `invalid:` prefix).
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'invalid: amount_cents must be >= 0';
  end if;
  if p_currency is null or length(p_currency) <> 3 then
    raise exception 'invalid: currency must be a 3-letter code';
  end if;
  if p_kind is null or length(p_kind) = 0 or length(p_kind) > 50 then
    raise exception 'invalid: kind must be a non-empty string of at most 50 characters';
  end if;
  if p_effective_date is null then
    raise exception 'invalid: effective_date is required';
  end if;

  -- 3. Tenancy must exist (account match, not soft-deleted) and not be ended.
  select id, status
    into v_tenancy
    from public.tenancies
   where account_id = p_account_id
     and id         = p_tenancy_id
     and deleted_at is null;
  if v_tenancy.id is null then
    raise exception 'not_found: tenancy';
  end if;
  if v_tenancy.status = 'ended' then
    raise exception 'conflict: tenancy already ended';
  end if;

  -- 4. A rent change must be anchored to an instrument. Both non-null is
  --    allowed (a renewal lease following a rent-increase notice).
  if p_source_lease_id is null and p_source_notice_id is null then
    raise exception 'invalid: a rent change must be anchored to a lease (source_lease_id) or a served notice (source_notice_id)';
  end if;

  -- 5. Lease anchor: must belong to this account AND this tenancy, not deleted.
  --    A draft lease is ACTIVATED by this call (the change is what puts a
  --    pre-created renewal into force). An expired/superseded lease cannot
  --    anchor a new change.
  if p_source_lease_id is not null then
    select id, status
      into v_lease
      from public.leases
     where account_id = p_account_id
       and id         = p_source_lease_id
       and tenancy_id = p_tenancy_id
       and deleted_at is null;
    if v_lease.id is null then
      raise exception 'not_found: source lease';
    end if;
    if v_lease.status in ('expired', 'superseded') then
      raise exception 'conflict: source lease is %', v_lease.status;
    end if;
    if v_lease.status = 'draft' then
      update public.leases
         set status     = 'active',
             updated_at = now()
       where account_id = p_account_id
         and id         = p_source_lease_id;
    end if;
  end if;

  -- 6. Notice anchor: must belong to this account AND this tenancy, not deleted.
  if p_source_notice_id is not null then
    select id
      into v_notice_id
      from public.notices
     where account_id = p_account_id
       and id         = p_source_notice_id
       and tenancy_id = p_tenancy_id
       and deleted_at is null;
    if v_notice_id is null then
      raise exception 'not_found: source notice';
    end if;
  end if;

  -- 7. End the open same-kind schedule era(s). "Open" = kind matches, not
  --    deleted, and still covering periods on/after effective_date. We iterate
  --    most-recently-started first so the FIRST row we see is the one whose
  --    due_day the successor inherits when none is passed (step 8).
  --
  --    A schedule that STARTS on/after effective_date cannot simply be ended at
  --    effective_date-1 (that would invert its date range); it signals an
  --    already-planned future change that must be resolved by a human first.
  for v_rec in
    select id, start_date, due_day
      from public.rent_schedules
     where account_id = p_account_id
       and tenancy_id = p_tenancy_id
       and kind       = p_kind
       and deleted_at is null
       and (end_date is null or end_date >= p_effective_date)
     order by start_date desc, created_at desc
  loop
    if v_rec.start_date >= p_effective_date then
      raise exception 'conflict: a schedule of kind % starting % conflicts with effective_date %; resolve it first',
        p_kind, v_rec.start_date, p_effective_date;
    end if;
    update public.rent_schedules
       set end_date   = p_effective_date - 1,
           updated_at = now()
     where account_id = p_account_id
       and id         = v_rec.id;
    v_ended := v_ended || v_rec.id;
    if v_inherit_due is null then
      v_inherit_due := v_rec.due_day;  -- most-recently-started ended schedule
    end if;
  end loop;

  -- 8. due_day for the successor: explicit override, else inherited from the
  --    schedule we just ended. If neither exists there is nothing to inherit.
  v_due_day := coalesce(p_due_day, v_inherit_due);
  if v_due_day is null then
    raise exception 'invalid: due_day is required when no open schedule exists to inherit it from';
  end if;

  -- 9. Append the successor schedule (start_date = effective_date, open-ended).
  --    currency is stored EXACTLY as passed -- the table only length-checks it
  --    and existing rows come from the API un-folded, so we do not case-fold.
  insert into public.rent_schedules
    (account_id, tenancy_id, kind, amount_cents, currency, due_day,
     start_date, end_date, source_lease_id, source_notice_id, change_reason)
  values
    (p_account_id, p_tenancy_id, p_kind, p_amount_cents, p_currency, v_due_day,
     p_effective_date, null, p_source_lease_id, p_source_notice_id, p_change_reason)
  returning id into v_schedule_id;

  -- 10. Lease-anchored change supersedes the OTHER active leases of this
  --     tenancy (the one we anchored to is the new contract of record).
  --     Notice-only changes touch no leases -- v_superseded stays empty.
  if p_source_lease_id is not null then
    with superseded as (
      update public.leases
         set status     = 'superseded',
             updated_at = now()
       where account_id = p_account_id
         and tenancy_id = p_tenancy_id
         and status     = 'active'
         and deleted_at is null
         and id <> p_source_lease_id
      returning id
    )
    select coalesce(array_agg(id), '{}') into v_superseded from superseded;
  end if;

  -- 11. Deliberately NO set_config('audit.actor', ...): this runs inside the
  --     caller's own transaction, so the audit trigger attributes every write
  --     to the calling user's JWT (same rationale as the end-cascade trigger in
  --     20260704000002). Stamping a synthetic actor would misattribute a human
  --     action.

  -- 12. Return exactly one summary row.
  return query select v_schedule_id, v_ended, v_superseded;
end;
$$;

-- ============================================================================
-- (3) detect_rent_drift -- flag lease-vs-schedule divergence (detect, not prevent)
-- ============================================================================
--
-- For each ACTIVE lease on a live (non-deleted, non-ended) tenancy, compare the
-- lease contract (rent_amount_cents / rent_currency) against the sum + distinct
-- currencies of that tenancy's currently-open kind='rent' schedules. Emit a row
-- only when the totals differ OR any open-schedule currency differs from the
-- lease currency.
--
-- DETECT-DON'T-PREVENT: divergence is not always a bug. NY preferential rent
-- bills BELOW the regulated lease amount; rent may be split into rent + parking
-- schedules of different kinds (only kind='rent' is summed here, so a parking
-- decomposition legitimately shows as drift for a human to acknowledge). So
-- this FLAGS, it never blocks a write.
create or replace function public.detect_rent_drift(p_account_id uuid)
returns table (
  o_tenancy_id           uuid,
  o_lease_id             uuid,
  o_lease_amount_cents   bigint,
  o_lease_currency       text,
  o_schedule_total_cents bigint,
  o_schedule_currencies  text[],
  o_auto_charge_enabled  boolean
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  -- Pin the session to UTC so current_date (the open-schedule cutoff below) is
  -- deterministic regardless of the caller's TimeZone -- same determinism
  -- rationale generate_rent_charges documents. Transaction-local, never leaks.
  perform set_config('timezone', 'UTC', true);

  return query
    select
      t.id                                    as o_tenancy_id,
      l.id                                    as o_lease_id,
      l.rent_amount_cents                     as o_lease_amount_cents,
      l.rent_currency                         as o_lease_currency,
      coalesce(sch.total_cents, 0)            as o_schedule_total_cents,
      coalesce(sch.currencies, '{}'::text[])  as o_schedule_currencies,
      a.auto_charge_enabled                   as o_auto_charge_enabled
    from public.leases l
    join public.tenancies t
      on t.account_id = l.account_id
     and t.id         = l.tenancy_id
    join public.accounts a
      on a.id = l.account_id
    left join lateral (
      select
        sum(s.amount_cents)::bigint      as total_cents,  -- sum() is numeric; the OUT column is bigint
        array_agg(distinct s.currency)   as currencies
      from public.rent_schedules s
      where s.account_id = l.account_id
        and s.tenancy_id = l.tenancy_id
        and s.kind       = 'rent'
        and s.deleted_at is null
        and s.start_date <= current_date
        and (s.end_date is null or s.end_date >= current_date)
    ) sch on true
    where l.account_id = p_account_id
      and l.status     = 'active'
      and l.deleted_at is null
      and t.deleted_at is null
      and t.status <> 'ended'
      and (
        -- amount drift (an empty schedule set totals 0, which drifts from any
        -- non-zero lease amount)
        coalesce(sch.total_cents, 0) <> l.rent_amount_cents
        -- currency drift: any open-schedule currency differs from the lease's
        or exists (
          select 1
            from unnest(coalesce(sch.currencies, '{}'::text[])) c
           where c <> l.rent_currency
        )
      );
end;
$$;

-- ============================================================================
-- (4) Grants
-- ============================================================================
--
-- Both functions are SECURITY INVOKER, so a direct PostgREST call by an
-- authenticated user runs under that user's RLS -- a non-member reads/writes
-- nothing. That makes `authenticated` EXECUTE SAFE here (unlike the
-- RLS-bypassing SECURITY DEFINER generators locked down in 20260628000009).
-- But Supabase's default ACL (pg_default_acl) auto-grants EXECUTE on every new
-- public function to `anon` too, and anon has no legitimate caller (all rent
-- changes/drift reads happen inside an authenticated session). So, following
-- the 20260628000009 convention of pinning grants EXPLICITLY after CREATE,
-- revoke from public + anon and grant only to authenticated + service_role.
--
-- (The CI guard db/test/check_definer_grants.sql only inspects SECURITY
-- DEFINER functions, so these INVOKER functions are correctly out of its
-- scope -- no allowlist entry needed.)
revoke all on function public.change_tenancy_rent(uuid, uuid, bigint, text, date, int, uuid, uuid, text, text) from public, anon;
grant  execute on function public.change_tenancy_rent(uuid, uuid, bigint, text, date, int, uuid, uuid, text, text) to authenticated, service_role;

revoke all on function public.detect_rent_drift(uuid) from public, anon;
grant  execute on function public.detect_rent_drift(uuid) to authenticated, service_role;
