-- ----------------------------------------------------------------------------
-- Automatic rent charging: opt-in flag, period-timing rewrite, end cascade.
--
-- Phase 9 shipped generate_rent_charges as an idempotent generator, but it
-- was never wired to a cron and its timing rule ("charge the period whose
-- due day we've reached") only ever billed the CURRENT or PAST month. Turning
-- automatic charging on for real needs three things this migration supplies:
--
--   (1) An explicit per-account OPT-IN. Bulk-import has already written
--       rent_schedules rows for existing accounts (they describe the lease
--       terms, not an instruction to auto-bill). If we flipped a global cron
--       on, every one of those accounts would be surprise-billed on the next
--       run. auto_charge_enabled defaults FALSE so nobody is billed until the
--       landlord deliberately turns it on.
--
--   (2) ADVANCE timing. Rent is due on the FIRST of the period it covers, so
--       the charge must exist slightly BEFORE that date (a tenant needs the
--       invoice in hand to pay on time). The rewritten generator emits NEXT
--       period's charge the moment we pass THIS period's due day.
--
--   (3) An END CASCADE. Ending a tenancy must stop its future auto-charges.
--       The generator already guards on tenancy status/end_date, but we also
--       end the schedule rows themselves so the stop is durable and visible,
--       not merely a runtime filter.
--
-- Chain compatibility (ADR-0008, same argument as 20260616000001's header):
-- accounts is an audited table. The audit chain hashes row SNAPSHOTS
-- (to_jsonb(NEW) at write time) and verify_chain re-hashes the STORED
-- snapshot, so adding auto_charge_enabled cannot invalidate any historical
-- event; new-era account rows carry the flag inside the hashed payload
-- automatically. No backfill, no schema_version, no verification change.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (1) Opt-in flag
-- ============================================================================
--
-- default false: bulk-import has already created rent_schedules rows for
-- existing accounts. Those rows record the lease terms; they are NOT an
-- instruction to auto-bill. Flipping the cron on globally must not
-- surprise-bill any account that never asked for it -- so the runner (and the
-- generator, defensively) only touches accounts that have explicitly set this
-- flag true.
alter table public.accounts
  add column auto_charge_enabled boolean not null default false;

comment on column public.accounts.auto_charge_enabled is
  'Opt-in switch for the automatic rent-charge cron. Default false so '
  'existing accounts (whose rent_schedules were created by bulk import) are '
  'never surprise-billed when auto-charging is enabled fleet-wide. Only the '
  'account owner/manager may flip it (RLS policy accounts_member_settings_update); '
  'generate_rent_charges returns empty for any account where this is false.';

-- ============================================================================
-- (2) RLS: who may flip the flag
-- ============================================================================
--
-- Phase 2 gave accounts a member-only SELECT policy and NO update policy at
-- all (account writes went through the admin path). The settings PATCH route
-- runs under the USER's JWT via PostgREST, so a member-scoped UPDATE policy is
-- what authorizes the toggle -- without one, the PATCH is denied by
-- default-deny RLS.
--
-- Scope to owner/manager, mirroring account_legal_holds_manager_write
-- (20260703000004): a viewer must not be able to start billing tenants. Uses
-- the ADR-0003 initplan IN-subquery form (membership set evaluated once per
-- statement) rather than the per-row is_account_member() helper.
--
-- COLUMN-LEVEL NOTE: Postgres RLS cannot restrict an UPDATE to a single
-- column, so this policy technically authorizes an owner/manager to UPDATE any
-- accounts column on their own account. Column-level protection is enforced by
-- the API layer: the settings PATCH route exposes ONLY auto_charge_enabled and
-- writes nothing else. Any direct member UPDATE of other columns is still
-- fully captured by the audit chain (accounts is audited), so it is
-- tamper-evident even though RLS alone cannot forbid it.
create policy accounts_member_settings_update on public.accounts
  for update
  using (id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid())
       and m.role in ('owner', 'manager')
       and m.deleted_at is null))
  with check (id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid())
       and m.role in ('owner', 'manager')
       and m.deleted_at is null));

-- ----------------------------------------------------------------------------
-- Column-level guard for the member UPDATE path.
--
-- The policy above is the FIRST client-writable UPDATE ever allowed on
-- accounts, and Postgres RLS is row-level, not column-level: on its own it
-- would let an owner/manager PATCH ANY column of their own account row straight
-- through PostgREST (bypassing the settings route's one-column allow-list) --
-- e.g. rename the account, or set/clear deleted_at outside the controlled admin
-- deletion flow. This BEFORE UPDATE trigger re-imposes the single-column intent
-- at the DB: on a USER-facing write (auth.uid() present -- the PostgREST/JWT
-- path) the ONLY column that may change is auto_charge_enabled.
--
-- The privileged paths are unaffected: the admin client and every SECURITY
-- DEFINER maintenance function run as service_role with auth.uid() = null, so
-- the guard is skipped and the legitimate soft-delete / rename / lifecycle
-- writes still work. If a future column becomes member-writable, add it to the
-- allow-list below explicitly (fail-closed: unknown column change is rejected).
create or replace function public._accounts_reject_member_column_writes()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null
     and (NEW.name       is distinct from OLD.name
       or NEW.deleted_at is distinct from OLD.deleted_at
       or NEW.id         is distinct from OLD.id
       or NEW.created_at is distinct from OLD.created_at)
  then
    raise exception
      'a member may only change account settings (auto_charge_enabled), not other account columns'
      using errcode = 'insufficient_privilege';
  end if;
  return NEW;
end;
$$;

create trigger accounts_member_column_guard
  before update on public.accounts
  for each row execute function public._accounts_reject_member_column_writes();

-- ============================================================================
-- (3) generate_rent_charges -- advance-timing rewrite
-- ============================================================================
--
-- TIMING RULE (the substance of this rewrite)
-- -------------------------------------------
-- For each active schedule, let day := day-of-month of p_as_of. We generate
-- the charge for the period whose due date is the NEXT one at or after the
-- moment p_as_of crosses this month's due day:
--
--   * day <= due_day  -> THIS month's due date (we haven't passed it yet;
--                        this period's invoice is the one still owed).
--   * day >  due_day  -> NEXT month's due date (this month's is already
--                        billed on a prior run; generate the upcoming one in
--                        advance so the tenant has the invoice before it's due).
--
-- Concrete example, due_day = 1:
--   * running any time June 2 .. July 1 generates JULY's charge
--     (period_start 2026-07-01).
--   * running any time July 2 .. Aug 1 generates AUGUST's charge
--     (period_start 2026-08-01).
-- So on July 1 itself we still emit July (day == due_day, "not yet passed");
-- on July 2 we roll forward to August.
--
-- due_day is CHECK-constrained to 1..28, so (due_day - 1) days into a
-- month-truncated date always lands inside the same month -- no month overflow.
--
-- DEFENSE IN DEPTH: opt-in re-checked here
-- ----------------------------------------
-- (a) If the account's auto_charge_enabled is false we return the empty set
-- immediately. The cron RUNNER also filters to opted-in accounts, but a stray
-- manual RPC call (admin console, a mis-scoped script) must NOT bill an
-- account that never opted in. The flag is checked in exactly the two places
-- that can trigger billing.
--
-- Everything else (security definer, audit.actor, ON CONFLICT dedupe, return
-- shape) is preserved from the Phase 9 version.

create or replace function public.generate_rent_charges(
  p_account_id uuid,
  p_as_of      timestamptz
)
returns table (
  o_charge_id    uuid,
  o_schedule_id  uuid,
  o_period_start date,
  o_amount_cents bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   text := 'system:cron:rent';
  v_enabled boolean;
begin
  -- Pin the session to UTC so extract(day ...) and date_trunc('month', ...) on
  -- the timestamptz p_as_of are deterministic regardless of the caller's
  -- TimeZone (same requirement advance_tenancy_statuses documents). The prod
  -- cron already fires at 08:00 UTC, but a manual RPC from a localized psql
  -- session would otherwise shift the day-of-month / period_start by up to a
  -- day. transaction-local, so it never leaks past this call.
  perform set_config('timezone', 'UTC', true);

  -- (a) opt-in gate. Empty set for a non-opted-in (or missing) account.
  select a.auto_charge_enabled
    into v_enabled
    from public.accounts a
   where a.id = p_account_id
     and a.deleted_at is null;

  if not coalesce(v_enabled, false) then
    return;  -- returns zero rows for a table-returning function
  end if;

  perform set_config('audit.actor', v_actor, true);

  return query
    with derived as (
      -- (b) period derivation: p_start is the due date of the period we bill.
      select
        s.id, s.account_id, s.tenancy_id, s.kind, s.amount_cents, s.currency,
        s.due_day, s.start_date, s.end_date,
        case
          when extract(day from p_as_of)::int > s.due_day
          then (date_trunc('month', p_as_of) + interval '1 month'
                  + make_interval(days => s.due_day - 1))::date
          else (date_trunc('month', p_as_of)
                  + make_interval(days => s.due_day - 1))::date
        end as p_start
      from public.rent_schedules s
      where s.account_id = p_account_id
        and s.deleted_at is null
    ),
    eligible as (
      -- (c) schedule bounds filter on the PERIOD (p_start), not on p_as_of.
      -- This both prevents charging a period AFTER the schedule ends and
      -- allows advance-generating the FIRST charge of a schedule that starts
      -- next month (start_date <= p_start even though start_date > today).
      --
      -- (d) tenancy guard. Of the four statuses -- upcoming, active, ended,
      -- holdover -- only 'ended' is excluded: 'upcoming' must be billable so the
      -- first month can be generated in advance, and a 'holdover' tenant still
      -- owes rent.
      --
      -- The tenancy's OWN end_date bounds billing for a still-running tenancy
      -- (a planned move-out date auto-stops billing after it) -- EXCEPT for a
      -- holdover, who by definition stayed PAST the fixed-term end_date and
      -- keeps owing rent, so the end_date bound must not silence them. The
      -- durable, visible off-switch is status='ended' + the cascade trigger
      -- below writing the SCHEDULE's own end_date; the tenancy end_date here is
      -- only a runtime convenience for an active tenancy with a planned move-out.
      -- (This is why the cascade fires on END, not on every end_date edit --
      -- otherwise extending a tenancy would leave its schedules stuck short.)
      select d.*
        from derived d
        join public.tenancies t
          on t.account_id = d.account_id
         and t.id = d.tenancy_id
       where d.start_date <= d.p_start
         and (d.end_date is null or d.end_date >= d.p_start)
         and t.deleted_at is null
         and t.status <> 'ended'
         and (t.status = 'holdover' or t.end_date is null or t.end_date >= d.p_start)
    ),
    inserted as (
      insert into public.charges
        (account_id, tenancy_id, type, amount_cents, currency, due_date,
         period_start, period_end, description, source_schedule_id)
      select
        e.account_id,
        e.tenancy_id,
        case when e.kind = 'rent' then 'rent' else 'other' end,
        e.amount_cents,
        e.currency,
        e.p_start,
        e.p_start,
        (e.p_start + interval '1 month' - interval '1 day')::date,
        'auto-generated from rent_schedule ' || e.kind,
        e.id
      from eligible e
      on conflict (source_schedule_id, period_start)
        where source_schedule_id is not null and period_start is not null
        do nothing
      returning id, source_schedule_id, period_start, amount_cents
    )
    select i.id, i.source_schedule_id, i.period_start, i.amount_cents
      from inserted i;
end;
$$;

-- Re-apply the grant lockdown (20260628000009): CREATE OR REPLACE re-runs the
-- Supabase default ACL, which re-grants EXECUTE to anon + authenticated on
-- every new public function. This function is RLS-bypassing (security definer)
-- and service-role-only -- a direct PostgREST call by anon/authenticated must
-- not reach it. Revoke from public/anon/authenticated, grant to service_role.
revoke execute on function public.generate_rent_charges(uuid, timestamptz) from public, anon, authenticated;
grant  execute on function public.generate_rent_charges(uuid, timestamptz) to service_role;

-- ============================================================================
-- (4) Cascade: ending a tenancy ends its still-open rent schedules
-- ============================================================================
--
-- When a tenancy is ENDED this trigger makes the stop DURABLE by writing the
-- end_date onto the schedule rows themselves: the schedule then visibly reads
-- "ended <date>" and the generator's schedule-bound filter (s.end_date >=
-- p_start) stops it, independent of tenancy state.
--
-- FIRES ONLY on a genuine end: status transitions INTO 'ended'. It deliberately
-- does NOT fire on an end_date edit alone. Reason (this is the fix for a real
-- bug): if it fired on end_date changes and only ever SHORTENED schedules
-- (end_date > v_end guard), then a landlord who set a planned move-out date and
-- later EXTENDED it -- or cleared it because the tenant renewed -- would leave
-- the schedule rows stuck at the old, earlier end_date, and billing would
-- silently stop for the extended term. For a still-running tenancy the
-- generator already bounds billing by the LIVE tenancy.end_date at runtime
-- (guard (d) above), so no durable schedule write is needed until the tenancy
-- actually ends. v_end := coalesce(NEW.end_date, current_date): an end with no
-- date closes the schedules as of today.
--
-- We only shorten schedules that outlive v_end (end_date is null or > v_end);
-- a schedule already ending earlier is left untouched.
--
-- NO audit.actor OVERRIDE (deliberate): unlike the cron generator, this
-- trigger runs inside the landlord's own UPDATE transaction. Leaving
-- audit.actor unset lets the existing audit trigger attribute the schedule
-- updates to WHOEVER ended the tenancy (the landlord) -- which is exactly
-- right. Stamping 'system:cron:*' here would misattribute a human action.
--
-- DELIBERATE NON-BEHAVIOR: re-opening a tenancy (status moving off 'ended')
-- does NOT resurrect the schedules -- the condition only fires on the
-- transition INTO 'ended', and even then only SHORTENS, never re-extends.
-- Silent resurrection would be surprise billing; the landlord recreates the
-- schedule explicitly if they want billing to resume.
create or replace function public._end_rent_schedules_on_tenancy_end()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end date;
begin
  if NEW.status = 'ended' and OLD.status is distinct from NEW.status then
    v_end := coalesce(NEW.end_date, current_date);

    update public.rent_schedules
       set end_date   = v_end,
           updated_at = now()
     where account_id = NEW.account_id
       and tenancy_id = NEW.id
       and deleted_at is null
       and (end_date is null or end_date > v_end);
  end if;

  return NEW;
end;
$$;

create trigger tenancies_end_rent_schedules_on_end
  after update on public.tenancies
  for each row execute function public._end_rent_schedules_on_tenancy_end();
