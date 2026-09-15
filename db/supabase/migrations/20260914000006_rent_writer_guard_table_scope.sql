-- Table-specific NEW fields must only be resolved for charge triggers.
create or replace function public._rent_writer_serialization_guard()
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

  if TG_TABLE_NAME = 'charges' then
    if TG_OP <> 'DELETE'
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

    if TG_OP = 'INSERT'
       and NEW.source_schedule_id is not null
       and NEW.corrects_charge_id is null
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
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

revoke all on function public._rent_writer_serialization_guard()
  from public, anon, authenticated, service_role;
