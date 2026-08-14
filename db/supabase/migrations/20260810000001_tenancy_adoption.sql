-- ----------------------------------------------------------------------------
-- Tenancy adoption: atomic historical backfill + opening balance (ADR-0013).
--
-- DATA FLOW:
--   adoption wizard (client-local state)
--     -> POST /accounts/{a}/tenancies/{t}/adoption (one Idempotency-Key)
--     -> adopt_tenancy_history RPC (this file, one transaction)
--        -> tenancy_adoptions row FIRST (RLS veto + guard trigger, before
--           anything else exists)
--        -> rent_schedule (past start_date)
--        -> N past rent charges (source_schedule_id = the new schedule)
--        -> M payments + caller-proposed allocations
--        -> optional held deposit (charge + payment + allocation)
--     -> ledger read model surfaces the adoption block
--
-- INVARIANT: the whole backfill commits atomically — never half the charges
-- without the payments. Any rejection (including _assert_allocation_integrity)
-- rolls the entire adoption back.
--
-- INVARIANT: backfilled charge periods are DERIVED here, never
-- caller-supplied: period_start is SNAPPED to the schedule's due-day grid
-- (the grid window containing due_date), period_end one month minus a day
-- later, while due_date stays the landlord's verbatim date. That makes the
-- generator dedupe structural: a backfilled period can neither escape the
-- (source_schedule_id, period_start) key (NULL or off-grid period) nor
-- pre-claim a future window the cron still owes.
--
-- INVARIANT: an opening balance is a recorded fact, NOT a ledger row. It can
-- never take a late fee (the fee walker iterates charges) and never appears in
-- payment-dated received-rent exports, because it is neither a charge nor a
-- payment.
--
-- The generator is untouched: it still bills one advance window and never
-- backfills (ADR-0011). Backfilled periods and cron periods cannot collide —
-- both sides dedupe on (source_schedule_id, period_start).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (1) tenancy_adoptions — at most one live adoption per tenancy
-- ============================================================================

create table public.tenancy_adoptions (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null,
  tenancy_id            uuid not null,
  -- The day tracking began. Drives the statement's "tracking since" divider;
  -- every backfilled date in the adoption is on or before it.
  adoption_date         date not null,
  -- Signed: > 0 the tenant owed money at adoption, < 0 the tenant held a
  -- credit, 0 for itemized backfills (the charges carry the arrears).
  opening_balance_cents bigint not null default 0,
  currency              text not null check (char_length(currency) = 3),
  -- Landlord's free-text answer to "what does this balance relate to"
  -- (rent / fees / several things / not sure). Never an enum: it is the
  -- landlord's words, not vocabulary the system interprets.
  balance_basis         text check (balance_basis is null
                                    or length(balance_basis) between 1 and 200),
  -- The wizard's "save as unresolved for now": the landlord committed the
  -- ledger while disagreeing with (or unsure about) the reconciled total.
  needs_review          boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  foreign key (account_id, tenancy_id)
    references public.tenancies(account_id, id) on delete restrict,
  unique (account_id, id)
);

-- One LIVE adoption per tenancy. Partial on deleted_at so an operator
-- correction (soft-delete + void the backfill) permits a clean re-adoption.
create unique index tenancy_adoptions_one_live_per_tenancy
  on public.tenancy_adoptions (account_id, tenancy_id)
  where deleted_at is null;

alter table public.tenancy_adoptions enable row level security;
alter table public.tenancy_adoptions force row level security;

create policy tenancy_adoptions_member_select
  on public.tenancy_adoptions
  for select
  using (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ));

-- Writes are owner/manager AT THE DATABASE (incidents posture for new
-- evidence tables). adopt_tenancy_history is SECURITY INVOKER, so this policy
-- gates the entire atomic commit: a viewer's adoption fails here and rolls
-- back every row the transaction wrote.
create policy tenancy_adoptions_member_insert
  on public.tenancy_adoptions
  for insert
  with check (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
       and m.role in ('owner', 'manager')
  ));

create policy tenancy_adoptions_member_update
  on public.tenancy_adoptions
  for update
  using (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
       and m.role in ('owner', 'manager')
  ))
  with check (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
       and m.role in ('owner', 'manager')
  ));

-- No DELETE for anyone: correcting a mistaken adoption is an audited
-- soft-delete UPDATE plus voiding the backfilled rows (ADR-0013).
revoke all on public.tenancy_adoptions
  from public, anon, authenticated, service_role;
grant select, insert, update on public.tenancy_adoptions
  to authenticated, service_role;

create trigger tenancy_adoptions_audit
  after insert or update or delete on public.tenancy_adoptions
  for each row execute function public._emit_event();

-- Direct-write backstops. tenancy_adoptions is member-writable through
-- PostgREST (the RLS role policy doubles as the RPC's atomicity veto), and
-- this schema's posture is that member-writable money tables carry their
-- invariants at the database, not only in routes/RPCs (precedent:
-- 20260706000002's rent_schedules delete guard).

-- INSERT: the virgin-timeline and date-bound invariants. adopt_tenancy_history
-- inserts the adoption row FIRST — before the schedule and money rows — so its
-- own insert passes this guard; a direct insert onto a tenancy that already
-- has live billing or money is exactly the bypass this stops.
create or replace function public._tenancy_adoptions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_tenancy record;
begin
  -- Same per-tenancy lock every schedule writer takes, so a direct insert
  -- serializes with adopt_tenancy_history and with rent changes.
  perform pg_advisory_xact_lock(hashtextextended('rent_change:' || NEW.tenancy_id::text, 0));
  -- A pre-deleted row would be a plantable dead record: paired with a later
  -- resurrection it composes into a full virgin-invariant bypass.
  if NEW.deleted_at is not null then
    raise exception 'an adoption cannot be inserted already soft-deleted'
      using errcode = 'check_violation';
  end if;
  if NEW.adoption_date > current_date + 1 then
    raise exception 'adoption_date cannot be in the future'
      using errcode = 'check_violation';
  end if;
  -- Mirror the RPC's tenancy-state refusal (ended or soft-deleted).
  select status, deleted_at into v_tenancy
    from public.tenancies
   where account_id = NEW.account_id and id = NEW.tenancy_id;
  if v_tenancy.deleted_at is not null or v_tenancy.status = 'ended' then
    raise exception 'adoption requires a live, un-ended tenancy'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.rent_schedules
     where account_id = NEW.account_id and tenancy_id = NEW.tenancy_id
       and deleted_at is null
  ) or exists (
    select 1 from public.charges
     where account_id = NEW.account_id and tenancy_id = NEW.tenancy_id
       and voided_at is null and deleted_at is null
  ) or exists (
    select 1 from public.payments
     where account_id = NEW.account_id and tenancy_id = NEW.tenancy_id
       and voided_at is null and deleted_at is null
  ) then
    raise exception 'adoption requires a virgin money timeline; record history through adopt_tenancy_history'
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

create trigger tenancy_adoptions_guard
  before insert on public.tenancy_adoptions
  for each row execute function public._tenancy_adoptions_guard();

-- UPDATE: the adoption is testimony. After commit only the review flag and
-- the audited soft-delete may change; the fail-closed jsonb diff freezes
-- every other column, including ones added later (incidents pattern).
-- Resurrection is refused outright: money recorded after a soft-delete would
-- coexist with the revived adoption, silently bypassing the virgin
-- invariant. Operator recovery is a fresh adoption, never an un-delete.
create or replace function public._tenancy_adoptions_freeze()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_mutable constant text[] := array['needs_review', 'deleted_at', 'updated_at'];
begin
  if (to_jsonb(NEW) - v_mutable) is distinct from (to_jsonb(OLD) - v_mutable) then
    raise exception 'adoption facts are frozen; only needs_review and soft-delete may change'
      using errcode = 'check_violation';
  end if;
  if OLD.deleted_at is not null and NEW.deleted_at is null then
    raise exception 'a soft-deleted adoption cannot be resurrected; re-adopt through adopt_tenancy_history'
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

create trigger tenancy_adoptions_freeze
  before update on public.tenancy_adoptions
  for each row execute function public._tenancy_adoptions_freeze();

-- Trigger functions are not application RPCs (incidents pattern).
revoke all on function public._tenancy_adoptions_guard()
  from public, anon, authenticated, service_role;
revoke all on function public._tenancy_adoptions_freeze()
  from public, anon, authenticated, service_role;

-- ============================================================================
-- (2) adopt_tenancy_history — the atomic adoption commit
-- ============================================================================
--
-- SECURITY INVOKER (like change_tenancy_rent): every read and write runs under
-- the CALLER's RLS. A non-member's tenancy lookup returns nothing
-- (`not_found: tenancy`), and the owner/manager insert policy on
-- tenancy_adoptions gates the whole transaction.
--
-- p_charges:  [{amount_cents, due_date, description?}] — all type='rent',
--              all carrying the new schedule's id (the sanctioned marker for
--              manually materialized schedule periods, per the
--              /rent-schedules/{id}/end contract). Periods are derived from
--              due_date, never accepted from the caller (see INVARIANT above).
-- p_payments: [{amount_cents, received_at, method, reference?, notes?,
--               allocations: [{charge_index, amount_cents}]}] — charge_index
--              is 0-based into p_charges. Matching is the CALLER's proposal;
--              _assert_allocation_integrity remains the backstop.
-- p_deposit:  {amount_cents, received_on, method?} — a HELD deposit: deposit
--              charge + payment + full allocation, all dated received_on.

create or replace function public.adopt_tenancy_history(
  p_account_id            uuid,
  p_tenancy_id            uuid,
  p_adoption_date         date,
  p_currency              text,
  p_rent_amount_cents     bigint,
  p_due_day               int,
  p_schedule_start_date   date,
  p_grace_days            int     default null,
  p_late_fee_cents        bigint  default null,
  p_charges               jsonb   default '[]'::jsonb,
  p_payments              jsonb   default '[]'::jsonb,
  p_deposit               jsonb   default null,
  p_opening_balance_cents bigint  default 0,
  p_balance_basis         text    default null,
  p_needs_review          boolean default false
)
returns table (
  o_adoption_id       uuid,
  o_schedule_id       uuid,
  o_charge_ids        uuid[],
  o_payment_ids       uuid[],
  o_deposit_charge_id uuid
)
language plpgsql
set search_path to 'public'
as $$
declare
  v_tenancy         record;
  v_elem            jsonb;
  v_alloc           jsonb;
  v_schedule_id     uuid;
  v_adoption_id     uuid;
  v_deposit_charge  uuid;
  v_charge_ids      uuid[] := '{}';
  v_charge_amounts  bigint[] := '{}';
  v_charge_alloc    bigint[] := '{}';
  v_payment_ids     uuid[] := '{}';
  v_n_charges       int;
  v_amount          bigint;
  v_due             date;
  v_pstart          date;
  v_pend            date;
  v_received        timestamptz;
  v_method          text;
  v_idx             int;
  v_pay_total       bigint;
  v_pay_allocs      int;
  v_pay_seen_idx    int[];
  v_seen_periods    date[] := '{}';
  v_id              uuid;
  v_methods constant text[] :=
    array['cash', 'check', 'ach', 'card', 'zelle_venmo', 'money_order', 'other'];
begin
  -- 1. Take the SAME per-tenancy lock every other rent_schedules writer takes
  --    ('rent_change:' — change_tenancy_rent and the schedule-write guard), so
  --    the step-4 virgin checks cannot race a concurrent schedule creation
  --    into two live schedules that both bill. Concurrent plain charge/payment
  --    inserts take no tenancy-level lock anywhere in the schema, so that
  --    narrower race remains (same exposure the tenancies.start_date guard
  --    accepts); the schedule race is the double-billing one.
  perform pg_advisory_xact_lock(hashtextextended('rent_change:' || p_tenancy_id::text, 0));

  -- 2. Input validation (stable `invalid:` prefix -> 400 at the route).
  if p_adoption_date is null then
    raise exception 'invalid: adoption_date is required';
  end if;
  -- +1 day: a client whose local calendar is ahead of UTC (up to UTC+14) may
  -- legitimately name "today" one day past current_date. Anything further is
  -- a future-dated history — the fat-fingered-year case — and must not commit.
  if p_adoption_date > current_date + 1 then
    raise exception 'invalid: adoption_date cannot be in the future';
  end if;
  if p_opening_balance_cents is null then
    raise exception 'invalid: opening_balance_cents must not be null (0 = no opening balance)';
  end if;
  if p_needs_review is null then
    raise exception 'invalid: needs_review must not be null';
  end if;
  if p_currency is null or length(p_currency) <> 3 then
    raise exception 'invalid: currency must be a 3-letter code';
  end if;
  if p_rent_amount_cents is null or p_rent_amount_cents < 0 then
    raise exception 'invalid: rent_amount_cents must be >= 0';
  end if;
  if p_due_day is null or p_due_day < 1 or p_due_day > 28 then
    raise exception 'invalid: due_day must be between 1 and 28';
  end if;
  if p_schedule_start_date is null or p_schedule_start_date > p_adoption_date then
    raise exception 'invalid: schedule start_date must be on or before adoption_date';
  end if;
  if p_grace_days is not null and (p_grace_days < 0 or p_grace_days > 30) then
    raise exception 'invalid: grace_days must be between 0 and 30';
  end if;
  if p_late_fee_cents is not null and p_late_fee_cents <= 0 then
    raise exception 'invalid: late_fee_cents must be greater than 0';
  end if;
  if jsonb_typeof(coalesce(p_charges, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid: charges and payments must be arrays';
  end if;
  -- Reject, never skip: a malformed deposit silently ignored would return
  -- success while the deposit went unrecorded.
  if p_deposit is not null and jsonb_typeof(p_deposit) <> 'object' then
    raise exception 'invalid: deposit must be a json object';
  end if;
  v_n_charges := jsonb_array_length(coalesce(p_charges, '[]'::jsonb));
  if v_n_charges > 120 then
    raise exception 'invalid: at most 120 backfilled charges per adoption';
  end if;
  if jsonb_array_length(coalesce(p_payments, '[]'::jsonb)) > 200 then
    raise exception 'invalid: at most 200 backfilled payments per adoption';
  end if;
  -- Branch exclusivity (the wizard's A xor C): an opening balance summarizes
  -- an UNitemized past, so itemized history alongside it would double-count.
  -- The deposit is allowed with either branch.
  if p_opening_balance_cents <> 0
     and (v_n_charges > 0 or jsonb_array_length(coalesce(p_payments, '[]'::jsonb)) > 0) then
    raise exception 'invalid: an opening balance and itemized charges/payments are mutually exclusive';
  end if;

  -- 3. Tenancy must exist under the caller's RLS and not be ended.
  select id, status, start_date
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

  -- 4. The money timeline must be virgin. Adoption REPLACES a missing
  --    history; a tenancy that already has live billing or recorded money is
  --    corrected through the ordinary flows, never re-founded.
  if exists (
    select 1 from public.tenancy_adoptions
     where account_id = p_account_id and tenancy_id = p_tenancy_id
       and deleted_at is null
  ) then
    raise exception 'conflict: tenancy already adopted';
  end if;
  if exists (
    select 1 from public.rent_schedules
     where account_id = p_account_id and tenancy_id = p_tenancy_id
       and deleted_at is null
  ) then
    raise exception 'conflict: tenancy already has a rent schedule';
  end if;
  if exists (
    select 1 from public.charges
     where account_id = p_account_id and tenancy_id = p_tenancy_id
       and voided_at is null and deleted_at is null
  ) or exists (
    select 1 from public.payments
     where account_id = p_account_id and tenancy_id = p_tenancy_id
       and voided_at is null and deleted_at is null
  ) then
    raise exception 'conflict: tenancy already has ledger activity';
  end if;
  -- Checked AFTER the virgin conflicts (those name the more actionable
  -- problem). Adoption money would otherwise permanently trip the PATCH
  -- /tenancies start_date guard (409 tenancy_has_money) while the ledger
  -- contradicts the recorded move-in date. Correcting start_date FIRST is
  -- cheap now — the timeline is still virgin — and impossible later.
  if p_schedule_start_date < v_tenancy.start_date then
    raise exception 'conflict: schedule starts % but the tenancy''s recorded start_date is %; correct the tenancy start_date first',
      p_schedule_start_date, v_tenancy.start_date;
  end if;

  -- 5. The adoption row FIRST: its BEFORE INSERT guard re-asserts the virgin
  --    timeline at the database (nothing is written yet, so the RPC's own
  --    insert passes), and the owner/manager RLS insert policy vetoes an
  --    under-privileged caller before any other row exists to roll back.
  insert into public.tenancy_adoptions
    (account_id, tenancy_id, adoption_date, opening_balance_cents, currency,
     balance_basis, needs_review)
  values
    (p_account_id, p_tenancy_id, p_adoption_date, p_opening_balance_cents,
     p_currency, p_balance_basis, p_needs_review)
  returning id into v_adoption_id;

  -- 6. The schedule. Unanchored (no source instrument): adoption records the
  --    landlord's testimony about existing terms, not a rent CHANGE — the
  --    instrument-anchor requirement stays where eras fork (ADR-0012).
  insert into public.rent_schedules
    (account_id, tenancy_id, kind, amount_cents, currency, due_day,
     start_date, grace_days, late_fee_cents)
  values
    (p_account_id, p_tenancy_id, 'rent', p_rent_amount_cents, p_currency,
     p_due_day, p_schedule_start_date, p_grace_days, p_late_fee_cents)
  returning id into v_schedule_id;

  -- 7. Backfilled rent charges, in input order. due_date bounds make the
  --    backfill incapable of asserting bills the adoption never witnessed:
  --    nothing before the schedule started, nothing after adoption day.
  --
  --    INVARIANT: the PERIOD is snapped to the schedule's due-day grid — the
  --    grid window containing due_date — while due_date itself stays the
  --    landlord's verbatim date. The generator only ever emits grid-aligned
  --    period_starts, so the (source_schedule_id, period_start) dedupe holds
  --    for ANY due_date: an off-grid backfill (records dated the 1st under a
  --    due-day-15 schedule) occupies its true grid window instead of a key
  --    the cron can't see, which would re-bill the same month.
  for v_elem in
    select value from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb))
  loop
    v_amount := (v_elem->>'amount_cents')::bigint;
    v_due    := (v_elem->>'due_date')::date;
    if v_amount is null or v_amount <= 0 then
      raise exception 'invalid: every charge amount_cents must be greater than 0';
    end if;
    if v_due is null or v_due > p_adoption_date or v_due < p_schedule_start_date then
      raise exception 'invalid: every charge due_date must fall between the schedule start and adoption_date';
    end if;
    v_pstart := make_date(extract(year from v_due)::int, extract(month from v_due)::int, p_due_day);
    if v_pstart > v_due then
      v_pstart := (v_pstart - interval '1 month')::date;
    end if;
    v_pend := (v_pstart + interval '1 month' - interval '1 day')::date;
    if v_pstart = any (v_seen_periods) then
      raise exception 'invalid: two charges land in the same billing period (the month containing %)', v_due;
    end if;
    v_seen_periods := v_seen_periods || v_pstart;
    insert into public.charges
      (account_id, tenancy_id, type, amount_cents, currency, due_date,
       period_start, period_end, source_schedule_id, description)
    values
      (p_account_id, p_tenancy_id, 'rent', v_amount, p_currency, v_due,
       v_pstart, v_pend, v_schedule_id, v_elem->>'description')
    returning id into v_id;
    v_charge_ids     := v_charge_ids || v_id;
    v_charge_amounts := v_charge_amounts || v_amount;
    v_charge_alloc   := v_charge_alloc || 0::bigint;
  end loop;

  -- 8. Payments with the caller's proposed matching. Sums are pre-validated
  --    for stable `invalid:` messages; _assert_allocation_integrity still
  --    runs per allocation row as the backstop and any rejection rolls back
  --    the entire adoption.
  for v_elem in
    select value from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb))
  loop
    v_amount   := (v_elem->>'amount_cents')::bigint;
    v_received := (v_elem->>'received_at')::timestamptz;
    v_method   := v_elem->>'method';
    if v_amount is null or v_amount <= 0 then
      raise exception 'invalid: every payment amount_cents must be greater than 0';
    end if;
    -- +1 day: the comparison date is UTC, but a payment received the evening
    -- of adoption day in a western timezone lands on the NEXT UTC date; a
    -- strict bound would reject the landlord's accurate same-day receipt.
    -- CONTRACT: a payment inside that slack day appears in ?as_of snapshots
    -- from its UTC date onward — the platform-wide snapshot rule.
    if v_received is null
       or (v_received at time zone 'utc')::date > p_adoption_date + 1 then
      raise exception 'invalid: every payment received_at must be on or before adoption_date';
    end if;
    -- Lower bound, symmetric with charges: a payment predating the schedule
    -- by more than a month is a transcription typo (wrong year), not history.
    if (v_received at time zone 'utc')::date < (p_schedule_start_date - interval '1 month')::date then
      raise exception 'invalid: payment received_at predates the schedule start by more than a month (check the year)';
    end if;
    if v_method is null or v_method <> all (v_methods) then
      raise exception 'invalid: payment method must be one of %', array_to_string(v_methods, ', ');
    end if;
    insert into public.payments
      (account_id, tenancy_id, amount_cents, currency, received_at, method,
       reference, notes)
    values
      (p_account_id, p_tenancy_id, v_amount, p_currency, v_received, v_method,
       v_elem->>'reference', v_elem->>'notes')
    returning id into v_id;
    v_payment_ids := v_payment_ids || v_id;

    v_pay_total    := 0;
    v_pay_allocs   := 0;
    v_pay_seen_idx := '{}';
    for v_alloc in
      select value from jsonb_array_elements(coalesce(v_elem->'allocations', '[]'::jsonb))
    loop
      -- The route caps allocations at 24 per payment, but the RPC is
      -- EXECUTE-granted to authenticated PostgREST callers, so the RPC is the
      -- real contract boundary — re-assert the cap here.
      v_pay_allocs := v_pay_allocs + 1;
      if v_pay_allocs > 24 then
        raise exception 'invalid: at most 24 allocations per payment';
      end if;
      v_idx    := (v_alloc->>'charge_index')::int;
      v_amount := (v_alloc->>'amount_cents')::bigint;
      if v_idx is null or v_idx < 0 or v_idx >= v_n_charges then
        raise exception 'invalid: allocation charge_index % is out of range', v_idx;
      end if;
      -- One allocation row per (payment, charge) — the UNIQUE constraint
      -- would reject a duplicate anyway, but as a raw 23505; catch it here
      -- as a stable `invalid:` instead.
      if v_idx = any (v_pay_seen_idx) then
        raise exception 'invalid: duplicate allocation charge_index % within one payment (merge the amounts)', v_idx;
      end if;
      v_pay_seen_idx := v_pay_seen_idx || v_idx;
      if v_amount is null or v_amount <= 0 then
        raise exception 'invalid: every allocation amount_cents must be greater than 0';
      end if;
      v_pay_total := v_pay_total + v_amount;
      if v_pay_total > (v_elem->>'amount_cents')::bigint then
        raise exception 'invalid: allocations exceed their payment amount';
      end if;
      v_charge_alloc[v_idx + 1] := v_charge_alloc[v_idx + 1] + v_amount;
      if v_charge_alloc[v_idx + 1] > v_charge_amounts[v_idx + 1] then
        raise exception 'invalid: allocations exceed the charge at index %', v_idx;
      end if;
      insert into public.payment_allocations
        (account_id, payment_id, charge_id, amount_cents)
      values
        (p_account_id, v_id, v_charge_ids[v_idx + 1], v_amount);
    end loop;
  end loop;

  -- 9. Held deposit: deposit charge + payment + full allocation, all dated
  --    received_on. Deposits stay their own subledger (type='deposit'), so
  --    the rent totals never absorb them. (Shape validated in step 2.)
  if p_deposit is not null then
    v_amount := (p_deposit->>'amount_cents')::bigint;
    v_due    := (p_deposit->>'received_on')::date;
    v_method := coalesce(p_deposit->>'method', 'other');
    if v_amount is null or v_amount <= 0 then
      raise exception 'invalid: deposit amount_cents must be greater than 0';
    end if;
    if v_due is null or v_due > p_adoption_date then
      raise exception 'invalid: deposit received_on must be on or before adoption_date';
    end if;
    -- Same year-typo guard the payments get.
    if v_due < (p_schedule_start_date - interval '1 month')::date then
      raise exception 'invalid: deposit received_on predates the schedule start by more than a month (check the year)';
    end if;
    if v_method <> all (v_methods) then
      raise exception 'invalid: deposit method must be one of %', array_to_string(v_methods, ', ');
    end if;
    insert into public.charges
      (account_id, tenancy_id, type, amount_cents, currency, due_date, description)
    values
      (p_account_id, p_tenancy_id, 'deposit', v_amount, p_currency, v_due,
       'Security deposit')
    returning id into v_deposit_charge;
    -- Noon UTC, not midnight: midnight UTC renders as the PREVIOUS day in
    -- every western timezone, making the deposit payment visibly contradict
    -- its own charge date. Noon renders as the entered day across UTC-11..+11.
    insert into public.payments
      (account_id, tenancy_id, amount_cents, currency, received_at, method)
    values
      (p_account_id, p_tenancy_id, v_amount, p_currency,
       ((v_due::timestamp + interval '12 hours') at time zone 'utc'), v_method)
    returning id into v_id;
    insert into public.payment_allocations
      (account_id, payment_id, charge_id, amount_cents)
    values
      (p_account_id, v_id, v_deposit_charge, v_amount);
    v_payment_ids := v_payment_ids || v_id;
  end if;

  -- 10. Deliberately NO set_config('audit.actor', ...): the audit trigger
  --     attributes every row to the calling user's JWT. Adoption is a human
  --     act of testimony, never a system action.

  return query select v_adoption_id, v_schedule_id, v_charge_ids,
                      v_payment_ids, v_deposit_charge;
end;
$$;

revoke all on function public.adopt_tenancy_history(
  uuid, uuid, date, text, bigint, int, date, int, bigint,
  jsonb, jsonb, jsonb, bigint, text, boolean
) from public, anon;
grant execute on function public.adopt_tenancy_history(
  uuid, uuid, date, text, bigint, int, date, int, bigint,
  jsonb, jsonb, jsonb, bigint, text, boolean
) to authenticated, service_role;

notify pgrst, 'reload schema';

-- VERIFICATION:
--   table exists with force RLS:
--   select relforcerowsecurity from pg_class
--    where oid = 'public.tenancy_adoptions'::regclass;            -- true
--   one live adoption per tenancy:
--   select indexdef from pg_indexes
--    where indexname = 'tenancy_adoptions_one_live_per_tenancy';  -- partial UNIQUE
--   audit wired:
--   select tgname from pg_trigger
--    where tgrelid = 'public.tenancy_adoptions'::regclass
--      and tgname = 'tenancy_adoptions_audit';                    -- 1 row
--   exactly one adopt_tenancy_history, taking 15 arguments:
--   select pronargs from pg_proc
--    where proname = 'adopt_tenancy_history';                     -- one row, 15
--   invoker security (not definer):
--   select prosecdef from pg_proc
--    where proname = 'adopt_tenancy_history';                     -- false
--   direct-write backstops wired:
--   select tgname from pg_trigger
--    where tgrelid = 'public.tenancy_adoptions'::regclass
--      and tgname in ('tenancy_adoptions_guard',
--                     'tenancy_adoptions_freeze');                -- 2 rows
--   period snapping is in the body:
--   select prosrc like '%v_seen_periods%' from pg_proc
--    where proname = 'adopt_tenancy_history';                     -- true
