-- Serialize every tenancy subledger writer with rent changes and corrections.

create function public._lock_rent_writer(p_tenancy_id uuid, p_wait boolean default true)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_tenancy_id is null then
    return;
  end if;

  if p_wait then
    perform pg_advisory_xact_lock(hashtextextended('rent_change:' || p_tenancy_id::text, 0));
  elsif not pg_try_advisory_xact_lock(hashtextextended('rent_change:' || p_tenancy_id::text, 0)) then
    raise exception 'concurrent tenancy money write; retry the transaction'
      using errcode = '40001';
  end if;
end;
$$;

revoke all on function public._lock_rent_writer(uuid, boolean)
  from public, anon, authenticated, service_role;

create function public._rent_writer_serialization_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenancy_id uuid;
begin
  if TG_TABLE_NAME = 'payment_allocations' then
    select x.tenancy_id
      into v_tenancy_id
      from (
        select p.tenancy_id
          from public.payments p
         where p.id = case when TG_OP = 'DELETE' then OLD.payment_id else NEW.payment_id end
        union
        select c.tenancy_id
          from public.charges c
         where c.id = case when TG_OP = 'DELETE' then OLD.charge_id else NEW.charge_id end
      ) x
     order by x.tenancy_id
     limit 1;
  else
    v_tenancy_id := case when TG_OP = 'DELETE' then OLD.tenancy_id else NEW.tenancy_id end;
  end if;

  -- UPDATE already owns a row lock, so contention must retry instead of waiting.
  perform public._lock_rent_writer(v_tenancy_id, TG_OP = 'INSERT');

  if TG_TABLE_NAME = 'charges'
     and TG_OP <> 'DELETE'
     and NEW.parent_charge_id is not null
     and (TG_OP = 'INSERT' or NEW.parent_charge_id is distinct from OLD.parent_charge_id)
     and not exists (
       select 1
         from public.charges p
        where p.account_id = NEW.account_id
          and p.id = NEW.parent_charge_id
          and p.tenancy_id = NEW.tenancy_id
          and p.deleted_at is null
          and p.voided_at is null
     )
  then
    raise exception 'parent_charge_id must reference a live charge of the same tenancy'
      using errcode = '23514';
  end if;

  if TG_TABLE_NAME = 'charges'
     and TG_OP = 'INSERT'
     and NEW.source_schedule_id is not null
     and not exists (
       select 1
         from public.rent_schedules s
        where s.account_id = NEW.account_id
          and s.id = NEW.source_schedule_id
          and s.tenancy_id = NEW.tenancy_id
          and s.deleted_at is null
          and (NEW.period_start is null or (
            s.start_date <= NEW.period_start
            and (s.end_date is null or s.end_date >= NEW.period_start)
          ))
     )
  then
    raise exception 'source_schedule_id must cover this charge period for the same tenancy'
      using errcode = '23514';
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

revoke all on function public._rent_writer_serialization_guard()
  from public, anon, authenticated, service_role;

create trigger "00_rent_writer_serialization"
before insert or update or delete on public.leases
for each row execute function public._rent_writer_serialization_guard();

create trigger "00_rent_writer_serialization"
before insert or update or delete on public.rent_schedules
for each row execute function public._rent_writer_serialization_guard();

create trigger "00_rent_writer_serialization"
before insert or update or delete on public.charges
for each row execute function public._rent_writer_serialization_guard();

create trigger "00_rent_writer_serialization"
before insert or update or delete on public.payments
for each row execute function public._rent_writer_serialization_guard();

create trigger "00_rent_writer_serialization"
before insert or update or delete on public.payment_allocations
for each row execute function public._rent_writer_serialization_guard();

create or replace function public.generate_rent_charges(
  p_account_id uuid,
  p_as_of timestamptz
)
returns table (
  o_charge_id uuid,
  o_schedule_id uuid,
  o_period_start date,
  o_amount_cents bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenancy_id uuid;
begin
  perform set_config('timezone', 'UTC', true);

  if not coalesce((
    select a.auto_charge_enabled
      from public.accounts a
     where a.id = p_account_id and a.deleted_at is null
  ), false) then
    return;
  end if;

  perform set_config('audit.actor', 'system:cron:rent', true);

  for v_tenancy_id in
    select distinct s.tenancy_id
      from public.rent_schedules s
     where s.account_id = p_account_id and s.deleted_at is null
     order by s.tenancy_id
  loop
    perform public._lock_rent_writer(v_tenancy_id);

    return query
      with eligible as (
        select s.*, t.status as tenancy_status, t.end_date as tenancy_end_date,
          case when extract(day from p_as_of)::int > s.due_day
            then (date_trunc('month', p_as_of) + interval '1 month'
                    + make_interval(days => s.due_day - 1))::date
            else (date_trunc('month', p_as_of)
                    + make_interval(days => s.due_day - 1))::date
          end as p_start
          from public.rent_schedules s
          join public.tenancies t
            on t.account_id = s.account_id and t.id = s.tenancy_id
         where s.account_id = p_account_id
           and s.tenancy_id = v_tenancy_id
           and s.deleted_at is null
           and t.deleted_at is null
           and t.status <> 'ended'
      ), inserted as (
        insert into public.charges
          (account_id, tenancy_id, type, amount_cents, currency, due_date,
           period_start, period_end, description, source_schedule_id)
        select e.account_id, e.tenancy_id,
          case when e.kind = 'rent' then 'rent' else 'other' end,
          e.amount_cents, e.currency, e.p_start, e.p_start,
          (e.p_start + interval '1 month' - interval '1 day')::date, null, e.id
          from eligible e
         where e.start_date <= e.p_start
           and (e.end_date is null or e.end_date >= e.p_start)
           and (e.tenancy_status = 'holdover'
             or e.tenancy_end_date is null
             or e.tenancy_end_date >= e.p_start)
        on conflict (source_schedule_id, period_start)
          where source_schedule_id is not null and period_start is not null
          do nothing
        returning id, source_schedule_id, period_start, amount_cents
      )
      select i.id, i.source_schedule_id, i.period_start, i.amount_cents
        from inserted i;
  end loop;
end;
$$;

create or replace function public.replace_lease(
  p_account_id uuid,
  p_lease_id uuid,
  p_void_reason text,
  p_term_start date,
  p_term_end date,
  p_rent_amount_cents bigint,
  p_rent_currency text,
  p_deposit_amount_cents bigint,
  p_deposit_currency text,
  p_document jsonb
)
returns table (
  o_voided_id uuid,
  o_replacement_id uuid,
  o_repointed_schedule_ids uuid[]
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lease public.leases%rowtype;
  v_replacement_id uuid;
  v_repointed uuid[] := '{}';
  v_tenancy_id uuid;
begin
  select l.tenancy_id into v_tenancy_id
    from public.leases l
   where l.account_id = p_account_id
     and l.id = p_lease_id
     and l.deleted_at is null;
  if v_tenancy_id is null then
    raise exception 'not_found: lease';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('rent_change:' || v_tenancy_id::text, 0));

  select * into v_lease
    from public.leases l
   where l.account_id = p_account_id
     and l.id = p_lease_id
     and l.tenancy_id = v_tenancy_id
     and l.deleted_at is null
   for update;
  if v_lease.id is null then
    raise exception 'not_found: lease';
  end if;
  if v_lease.voided_at is not null then
    raise exception 'conflict: lease is voided';
  end if;

  if exists (
    select 1 from public.rent_schedules s
     where s.account_id = p_account_id
       and s.source_lease_id = p_lease_id
       and s.deleted_at is null
       and (s.amount_cents <> p_rent_amount_cents or s.currency <> p_rent_currency)
  ) then
    raise exception 'conflict: lease anchors a rent schedule with a different rent';
  end if;

  insert into public.leases
    (account_id, tenancy_id, status, term_start, term_end, rent_amount_cents,
     rent_currency, deposit_amount_cents, deposit_currency, document)
  values
    (p_account_id, v_tenancy_id, v_lease.status, p_term_start, p_term_end,
     p_rent_amount_cents, p_rent_currency, coalesce(p_deposit_amount_cents, 0),
     p_deposit_currency, coalesce(p_document, '{}'::jsonb))
  returning id into v_replacement_id;

  with repointed as (
    update public.rent_schedules
       set source_lease_id = v_replacement_id, updated_at = now()
     where account_id = p_account_id
       and source_lease_id = p_lease_id
       and deleted_at is null
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_repointed from repointed;

  update public.leases
     set voided_at = now(), void_reason = p_void_reason, updated_at = now()
   where account_id = p_account_id and id = p_lease_id;

  update public.leases
     set corrects_lease_id = p_lease_id, updated_at = now()
   where account_id = p_account_id and id = v_replacement_id;

  return query select p_lease_id, v_replacement_id, v_repointed;
end;
$$;
