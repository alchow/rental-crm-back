-- Application facts remain fixed; a reasoned void appends an audit event.
alter table public.payment_allocations
  add column note text check (length(note) <= 1000),
  add column voided_at timestamptz,
  add column void_reason text,
  add column request_key text,
  add constraint allocation_void_reason check (
    (voided_at is null and void_reason is null) or
    (voided_at is not null and length(btrim(void_reason)) between 1 and 500)
  );
create unique index payment_allocation_request_key
  on public.payment_allocations(account_id, request_key) where request_key is not null;

create or replace function public._assert_allocation_integrity()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_payment      record;
  v_charge       record;
  v_alloc_sum    bigint;
begin
  if TG_OP = 'DELETE' then
    raise exception 'allocations cannot be deleted; void the application' using errcode = '23514';
  end if;
  if TG_OP = 'UPDATE' then
    if (to_jsonb(NEW) - array['voided_at','void_reason','updated_at'])
       is distinct from (to_jsonb(OLD) - array['voided_at','void_reason','updated_at'])
       or OLD.voided_at is not null or NEW.voided_at is null
       or nullif(btrim(NEW.void_reason), '') is null then
      raise exception 'only a reasoned allocation void is allowed' using errcode = '23514';
    end if;
    NEW.voided_at := now();
    NEW.updated_at := now();
    return NEW;
  end if;
  if NEW.voided_at is not null or NEW.deleted_at is not null then
    raise exception 'new allocation must be live' using errcode = '23514';
  end if;
  NEW.created_at := now();
  NEW.updated_at := now();
  if NEW.amount_cents is null or NEW.amount_cents <= 0 then
    raise exception 'allocation amount_cents must be positive (got %)', NEW.amount_cents
      using errcode = 'check_violation';
  end if;
  select id, account_id, tenancy_id, amount_cents, currency, voided_at
    into v_payment
    from public.payments where id = NEW.payment_id;
  if v_payment.id is null then
    raise exception 'payment % not found', NEW.payment_id
      using errcode = 'foreign_key_violation';
  end if;

  select id, account_id, tenancy_id, amount_cents, currency, voided_at
    into v_charge
    from public.charges where id = NEW.charge_id;
  if v_charge.id is null then
    raise exception 'charge % not found', NEW.charge_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_payment.account_id <> NEW.account_id then
    raise exception 'allocation/payment account mismatch (alloc=%, payment=%)',
      NEW.account_id, v_payment.account_id
      using errcode = 'check_violation';
  end if;
  if v_charge.account_id <> NEW.account_id then
    raise exception 'allocation/charge account mismatch (alloc=%, charge=%)',
      NEW.account_id, v_charge.account_id
      using errcode = 'check_violation';
  end if;
  if v_payment.tenancy_id <> v_charge.tenancy_id then
    raise exception 'cross-tenancy allocation: payment.tenancy=% charge.tenancy=%',
      v_payment.tenancy_id, v_charge.tenancy_id
      using errcode = 'check_violation';
  end if;
  if v_payment.currency <> v_charge.currency then
    raise exception 'currency mismatch in allocation: payment=% charge=%',
      v_payment.currency, v_charge.currency
      using errcode = 'check_violation';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'cannot allocate from a voided payment'
      using errcode = 'check_violation';
  end if;
  if v_charge.voided_at is not null then
    raise exception 'cannot allocate to a voided charge'
      using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('payment_alloc:' || NEW.payment_id::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('charge_alloc:'  || NEW.charge_id::text,  0)
  );
  select coalesce(sum(pa.amount_cents), 0) into v_alloc_sum
    from public.payment_allocations pa
    join public.charges ch on ch.id = pa.charge_id
    where pa.payment_id = NEW.payment_id
      and (TG_OP = 'INSERT' or pa.id <> NEW.id)
      and pa.deleted_at is null
      and pa.voided_at is null
      and ch.voided_at is null;
  v_alloc_sum := v_alloc_sum + NEW.amount_cents;
  if v_alloc_sum > v_payment.amount_cents then
    raise exception 'allocations (%) exceed payment amount (%) for payment %',
      v_alloc_sum, v_payment.amount_cents, NEW.payment_id
      using errcode = 'check_violation';
  end if;
  select coalesce(sum(pa.amount_cents), 0) into v_alloc_sum
    from public.payment_allocations pa
    join public.payments pm on pm.id = pa.payment_id
    where pa.charge_id = NEW.charge_id
      and (TG_OP = 'INSERT' or pa.id <> NEW.id)
      and pa.deleted_at is null
      and pa.voided_at is null
      and pm.voided_at is null;
  v_alloc_sum := v_alloc_sum + NEW.amount_cents;
  if v_alloc_sum > v_charge.amount_cents then
    raise exception 'allocations (%) exceed charge amount (%) for charge %',
      v_alloc_sum, v_charge.amount_cents, NEW.charge_id
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

drop trigger payment_allocations_integrity on public.payment_allocations;
create trigger payment_allocations_integrity
  before insert or update or delete on public.payment_allocations
  for each row execute function public._assert_allocation_integrity();

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
  perform set_config('timezone', 'UTC', true);

  select a.auto_charge_enabled
    into v_enabled
    from public.accounts a
   where a.id = p_account_id
     and a.deleted_at is null
       and a.voided_at is null;

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

