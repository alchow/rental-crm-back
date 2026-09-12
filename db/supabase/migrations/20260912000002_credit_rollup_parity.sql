CREATE OR REPLACE FUNCTION "public"."generate_rent_charges"("p_account_id" "uuid", "p_as_of" timestamp with time zone) RETURNS TABLE("o_charge_id" "uuid", "o_schedule_id" "uuid", "o_period_start" "date", "o_amount_cents" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_actor   text := 'system:cron:rent';
  v_enabled boolean;
begin
  perform set_config('timezone', 'UTC', true);

  select a.auto_charge_enabled
    into v_enabled
    from public.accounts a
   where a.id = p_account_id
     and a.deleted_at is null;

  if not coalesce(v_enabled, false) then
    return;
  end if;

  perform set_config('audit.actor', v_actor, true);

  return query
    with derived as (
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
        null,
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

CREATE OR REPLACE FUNCTION "public"."rent_rollup"("p_account_id" "uuid", "p_statuses" "text"[] DEFAULT ARRAY['active'::"text", 'holdover'::"text"], "p_as_of" "date" DEFAULT CURRENT_DATE) RETURNS TABLE("tenancy_id" "uuid", "status" "text", "currency" "text", "rent_balance_cents" bigint, "deposit_balance_cents" bigint, "unapplied_credit_cents" bigint, "non_deposit_overdue_cents" bigint, "non_deposit_due_today_cents" bigint, "non_deposit_upcoming_cents" bigint, "deposit_owed_cents" bigint, "deposit_held_cents" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  with t as (
    select id, tenancies.status
      from public.tenancies
     where account_id = p_account_id
       and deleted_at is null
       and tenancies.status = any(coalesce(p_statuses, array['active', 'holdover']))
  ),
  live_charges as (
    select c.id, c.tenancy_id, c.type, c.amount_cents, c.due_date
      from public.charges c
      join t on t.id = c.tenancy_id
     where c.account_id = p_account_id
       and c.deleted_at is null
       and c.voided_at is null
  ),
  live_payments as (
    select p.tenancy_id, sum(p.amount_cents) as received
      from public.payments p
      join t on t.id = p.tenancy_id
     where p.account_id = p_account_id
       and p.deleted_at is null
       and p.voided_at is null
     group by p.tenancy_id
  ),
  active_allocations_by_charge as (
    select c.id as charge_id, c.tenancy_id, sum(a.amount_cents) as allocated
      from public.payment_allocations a
      join live_charges c on c.id = a.charge_id
      join public.payments p
        on p.account_id = a.account_id
       and p.id = a.payment_id
       and p.tenancy_id = c.tenancy_id
     where a.account_id = p_account_id
       and a.deleted_at is null
       and a.voided_at is null
       and p.deleted_at is null
       and p.voided_at is null
     group by c.id, c.tenancy_id
  ),
  charge_balances as (
    select c.*,
           coalesce(a.allocated, 0)::bigint as allocated,
           (c.amount_cents - coalesce(a.allocated, 0))::bigint as open_balance
      from live_charges c
      left join active_allocations_by_charge a on a.charge_id = c.id
  ),
  money as (
    select cb.tenancy_id,
           coalesce(sum(cb.open_balance) filter (where cb.type <> 'deposit'), 0)::bigint
             as rent_balance,
           coalesce(sum(cb.open_balance) filter (where cb.type = 'deposit'), 0)::bigint
             as deposit_owed,
           coalesce(sum(cb.allocated) filter (where cb.type = 'deposit'), 0)::bigint
             as deposit_held,
           coalesce(sum(cb.open_balance) filter (
             where cb.type <> 'deposit' and cb.due_date < p_as_of
           ), 0)::bigint as overdue,
           coalesce(sum(cb.open_balance) filter (
             where cb.type <> 'deposit' and cb.due_date = p_as_of
           ), 0)::bigint as due_today,
           coalesce(sum(cb.open_balance) filter (
             where cb.type <> 'deposit' and cb.due_date > p_as_of
           ), 0)::bigint as upcoming,
           coalesce(sum(cb.allocated), 0)::bigint as total_allocated
      from charge_balances cb
     group by cb.tenancy_id
  ),
  currencies as (
    select t.id as tenancy_id,
           (select min(c.currency) from public.charges c
             where c.account_id = p_account_id and c.tenancy_id = t.id
               and c.deleted_at is null) as charge_currency,
           (select min(p.currency) from public.payments p
             where p.account_id = p_account_id and p.tenancy_id = t.id
               and p.deleted_at is null) as payment_currency
      from t
  )
  select t.id,
         t.status,
         coalesce(cu.charge_currency, cu.payment_currency),
         coalesce(m.rent_balance, 0)::bigint,
         coalesce(m.deposit_owed, 0)::bigint,
         (coalesce(lp.received, 0) - coalesce(m.total_allocated, 0))::bigint,
         coalesce(m.overdue, 0)::bigint,
         coalesce(m.due_today, 0)::bigint,
         coalesce(m.upcoming, 0)::bigint,
         coalesce(m.deposit_owed, 0)::bigint,
         coalesce(m.deposit_held, 0)::bigint
    from t
    left join money         m  on m.tenancy_id = t.id
    left join live_payments lp on lp.tenancy_id = t.id
    left join currencies    cu on cu.tenancy_id = t.id
   where t.status <> 'ended'
      or coalesce(m.rent_balance, 0) <> 0
      or coalesce(m.deposit_owed, 0) <> 0
      or coalesce(m.deposit_held, 0) <> 0
      or (coalesce(lp.received, 0) - coalesce(m.total_allocated, 0)) <> 0
$$;

