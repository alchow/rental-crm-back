do $$
declare definition text; changed text;
begin
  select pg_get_functiondef('public._rent_writer_serialization_guard()'::regprocedure) into definition;
  changed:=replace(definition,
    'and NEW.corrects_charge_id is null
       and NEW.period_start is not distinct from NEW.due_date
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
       )',
    'and NEW.corrects_charge_id is null
       and not exists (select 1 from public.charges duplicate
         where duplicate.source_schedule_id=NEW.source_schedule_id
           and duplicate.period_start=NEW.period_start)
       and not exists (
         select 1
           from public.rent_schedules s
          where s.account_id = NEW.account_id
            and s.id = NEW.source_schedule_id
            and s.tenancy_id = NEW.tenancy_id
            and s.deleted_at is null
            and (NEW.period_start is distinct from NEW.due_date or NEW.period_start is null or (
              s.start_date <= NEW.period_start
              and (s.end_date is null or s.end_date >= NEW.period_start)
            ))
       )');
  if changed=definition then raise exception 'charge source guard marker not found'; end if;
  execute changed;
end $$;

create function public._carry_rent_correction_waivers(p_account_id uuid,p_old_id uuid,p_new_id uuid,p_start date,p_end date)
returns void language sql set search_path=public as $$
  insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,
    description,source_schedule_id,voided_at,void_reason,corrects_charge_id)
  select waived.account_id,waived.tenancy_id,waived.type,waived.amount_cents,waived.currency,waived.due_date,
    dates.slot,(dates.slot+interval '1 month'-interval '1 day')::date,
    waived.description,successor.id,now(),waived.void_reason,waived.id
  from public.charges waived
  join public.rent_schedules successor on successor.account_id=waived.account_id and successor.id=p_new_id
  cross join lateral (select public._rent_billing_slot(coalesce(waived.period_start,waived.due_date),successor.due_day) slot) dates
  where waived.account_id=p_account_id and waived.source_schedule_id=p_old_id
    and waived.voided_at is not null and waived.deleted_at is null and waived.period_start is not null
    and dates.slot>=p_start and (p_end is null or dates.slot<=p_end)
  on conflict(source_schedule_id,period_start) where source_schedule_id is not null and period_start is not null do nothing
$$;
revoke all on function public._carry_rent_correction_waivers(uuid,uuid,uuid,date,date) from public,anon,authenticated,service_role;
grant execute on function public._carry_rent_correction_waivers(uuid,uuid,uuid,date,date) to rent_adjustment_writer;

do $$
declare definition text; changed text;
begin
  select pg_get_functiondef('public._plan_rent_adjustment(uuid,uuid,jsonb)'::regprocedure) into definition;
  changed:=replace(definition,
    '      select * into s from public.rent_schedules where id=c.source_schedule_id and account_id=p_account_id;
      if due is distinct from s.due_day',
    '      select * into s from public.rent_schedules where id=c.source_schedule_id and account_id=p_account_id;
      bill_period:=public._rent_billing_slot(coalesce(c.period_start,c.due_date),due);
      bill_end:=(bill_period+interval ''1 month''-interval ''1 day'')::date;
      if due is distinct from s.due_day');
  changed:=replace(changed,
    '  if kind=''change_rent'' and exists (
    select 1 from jsonb_array_elements(plans) entry where entry->>''action''=''replace''',
    '  if kind in (''change_rent'',''correct_rent'') and exists (
    select 1 from jsonb_array_elements(plans) entry where entry->>''action''=''replace''');
  if changed=definition then raise exception 'planner canonical completion markers not found'; end if;
  execute changed;
end $$;

do $$
declare definition text; changed text; old_block text;
begin
  select pg_get_functiondef('public.commit_rent_adjustment(uuid,uuid,jsonb,text,text,text)'::regprocedure) into definition;
  old_block:=$old$        insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,
          description,source_schedule_id,voided_at,void_reason,corrects_charge_id)
          select waived.account_id,waived.tenancy_id,waived.type,waived.amount_cents,waived.currency,waived.due_date,waived.period_start,waived.period_end,
            waived.description,(segment->>'new_id')::uuid,now(),waived.void_reason,waived.id from public.charges waived
          where waived.account_id=p_account_id and waived.source_schedule_id=(segment->>'old_id')::uuid
            and waived.voided_at is not null and waived.deleted_at is null and waived.period_start is not null
            and waived.period_start>=(segment->>'start_date')::date
            and (segment->>'end_date' is null or waived.period_start<=(segment->>'end_date')::date)
          on conflict(source_schedule_id,period_start) where source_schedule_id is not null and period_start is not null do nothing;$old$;
  changed:=replace(definition,old_block,
    '        perform public._carry_rent_correction_waivers(p_account_id,(segment->>''old_id'')::uuid,(segment->>''new_id'')::uuid,(segment->>''start_date'')::date,(segment->>''end_date'')::date);');
  if changed=definition then raise exception 'correction waiver insertion marker not found'; end if;
  execute changed;
end $$;
