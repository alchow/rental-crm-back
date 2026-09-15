-- Enforce after the date-command API and callers have been deployed.
create function public._guard_tenancy_date_write() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.date_revision <> 0 then raise exception 'date_revision_managed' using errcode='22023'; end if;
    if NEW.actual_move_in_date > (now() at time zone 'UTC')::date then
      raise exception 'actual_move_in_in_future' using errcode='22023';
    end if;
  elsif (NEW.start_date,NEW.start_date_basis,NEW.actual_move_in_date,NEW.date_revision)
    is distinct from (OLD.start_date,OLD.start_date_basis,OLD.actual_move_in_date,OLD.date_revision)
    and current_user <> 'tenancy_date_writer' then
    raise exception 'date_correction_required' using errcode='42501';
  end if;
  return NEW;
end $$;
revoke all on function public._guard_tenancy_date_write() from public,anon,authenticated,service_role;
create trigger tenancies_date_command_guard before insert or update on public.tenancies
for each row execute function public._guard_tenancy_date_write();

CREATE OR REPLACE FUNCTION "public"."_guard_recorded_tenancy_ending"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY INVOKER
    SET "search_path" TO 'public'
    AS $$
declare
  v_ending public.tenancy_endings%rowtype;
  v_expected_end_date date;
begin
  select te.*
    into v_ending
    from public.tenancy_endings te
   where te.account_id = NEW.account_id
     and te.tenancy_id = NEW.id;

  if v_ending.id is null then
    return NEW;
  end if;

  -- Once an ending is recorded, both boundaries are historical facts. In
  -- particular, a cancelled tenancy's operational end_date is its ORIGINAL
  -- scheduled start. Deriving this from NEW.start_date would let a caller
  -- rewrite both dates together and preserve the equality while changing
  -- history.
  if NEW.start_date is distinct from OLD.start_date
    and not (current_user = 'tenancy_date_writer' and v_ending.kind = 'ended'
      and NEW.start_date <= v_ending.effective_date) then
    raise exception 'conflict: start_date is fixed by the immutable tenancy ending'
      using errcode = 'check_violation';
  end if;

  v_expected_end_date := case
    when v_ending.kind = 'cancelled_before_move_in' then OLD.start_date
    else v_ending.effective_date
  end;

  if NEW.status <> 'ended' then
    raise exception 'conflict: a tenancy with an immutable ending cannot be reopened'
      using errcode = 'check_violation';
  end if;

  if NEW.end_date is distinct from v_expected_end_date then
    raise exception 'conflict: end_date is fixed by the immutable tenancy ending'
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."adopt_tenancy_history"("p_account_id" "uuid", "p_tenancy_id" "uuid", "p_adoption_date" "date", "p_currency" "text", "p_rent_amount_cents" bigint, "p_due_day" integer, "p_schedule_start_date" "date", "p_grace_days" integer DEFAULT NULL::integer, "p_late_fee_cents" bigint DEFAULT NULL::bigint, "p_charges" "jsonb" DEFAULT '[]'::"jsonb", "p_payments" "jsonb" DEFAULT '[]'::"jsonb", "p_deposit" "jsonb" DEFAULT NULL::"jsonb", "p_opening_balance_cents" bigint DEFAULT 0, "p_balance_basis" "text" DEFAULT NULL::"text", "p_needs_review" boolean DEFAULT false) RETURNS TABLE("o_adoption_id" "uuid", "o_schedule_id" "uuid", "o_charge_ids" "uuid"[], "o_payment_ids" "uuid"[], "o_deposit_charge_id" "uuid")
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
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
  -- Possession and rent effective dates are independent facts.

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

