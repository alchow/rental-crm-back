create function public._rent_billing_slot(p_basis date,p_due_day integer)
returns date language sql immutable strict
begin atomic
  select date_trunc('month',p_basis)::date+p_due_day-1;
end;
revoke all on function public._rent_billing_slot(date,integer) from public,anon,authenticated,service_role;
grant execute on function public._rent_billing_slot(date,integer) to rent_adjustment_writer;

-- Historical manual bills may retain dates outside their source schedule. Generated bills
-- always have matching due/period dates and must cite a live covering schedule.
do $$
declare definition text; changed text;
begin
  select pg_get_functiondef('public._rent_writer_serialization_guard()'::regprocedure) into definition;
  changed:=replace(definition,
    'and NEW.corrects_charge_id is null
       and not exists',
    'and NEW.corrects_charge_id is null
       and NEW.period_start is not distinct from NEW.due_date
       and not exists');
  if changed=definition then raise exception 'charge source guard marker not found'; end if;
  execute changed;
end $$;

do $$
declare definition text; changed text;
begin
  select pg_get_functiondef('public._plan_rent_adjustment(uuid,uuid,jsonb)'::regprocedure) into definition;
  changed:=replace(definition,
    'if selected and (from_date<s.start_date or to_date<from_date or (s.end_date is not null and (to_date is null or to_date>s.end_date))) then',
    'if selected and (from_date<s.start_date or to_date<from_date or (s.end_date is not null and (to_date is null or to_date>s.end_date))) then');
  changed:=replace(changed,
    '    if kind=''correct_rent'' then
      select x into segment',
    '    if kind=''correct_rent'' then
      select * into s from public.rent_schedules where id=c.source_schedule_id and account_id=p_account_id;
      select x into segment');
  changed:=replace(changed,
    '        selected:=false;
      end if;
    elsif kind=''change_rent'' then',
    '        selected:=false;
      elsif selected and ((from_date<>s.start_date and from_date<>public._rent_billing_slot(from_date,s.due_day))
        or (to_date is distinct from s.end_date and to_date+1<>public._rent_billing_slot(to_date+1,s.due_day))) then
        blockers:=blockers||jsonb_build_object(''code'',''adjustment_scope_required'',''message'',''Correction dates must start on a billing day and end immediately before one.'',''field'',''scope'');
        selected:=false;
      end if;
    elsif kind=''change_rent'' then');
  changed:=replace(changed,
    'where (x->>''old_id'')::uuid=c.source_schedule_id and coalesce(c.period_start,c.due_date)>=(x->>''start_date'')::date
        and (x->>''end_date'' is null or coalesce(c.period_start,c.due_date)<=(x->>''end_date'')::date) limit 1;',
    'where (x->>''old_id'')::uuid=c.source_schedule_id and public._rent_billing_slot(coalesce(c.period_start,c.due_date),s.due_day)>=(x->>''start_date'')::date
        and (x->>''end_date'' is null or public._rent_billing_slot(coalesce(c.period_start,c.due_date),s.due_day)<=(x->>''end_date'')::date) limit 1;');
  changed:=replace(changed,
    '        after_amount:=coalesce((override->>''amount_cents'')::bigint,after_amount);
      end if;
    else',
    '        after_amount:=coalesce((override->>''amount_cents'')::bigint,after_amount);
        bill_period:=public._rent_billing_slot(coalesce(c.period_start,c.due_date),s.due_day);
        bill_end:=(bill_period+interval ''1 month''-interval ''1 day'')::date;
      end if;
    else');
  changed:=replace(changed,
    '''after_due_date'',case when plan->>''action''=''replace'' then plan->>''due_date'' else null end,''period_start'',coalesce(c.period_start,c.due_date),',
    '''after_due_date'',case when plan->>''action''=''replace'' then plan->>''due_date'' else null end,''period_start'',coalesce(c.period_start,c.due_date),''after_period_start'',case when plan->>''action''=''replace'' then plan->>''period_start'' else null end,');
  if changed=definition then raise exception 'planner markers not found'; end if;
  execute changed;
end $$;

do $$
declare definition text; changed text;
begin
  select pg_get_functiondef('public.commit_rent_adjustment(uuid,uuid,jsonb,text,text,text)'::regprocedure) into definition;
  changed:=replace(definition,
    '      if p_payload->>''kind''=''correct_rent'' then
        select (x->>''new_id'')::uuid into schedule_id',
    '      if p_payload->>''kind''=''correct_rent'' then
        select * into s from public.rent_schedules where id=c.source_schedule_id and account_id=p_account_id;
        select (x->>''new_id'')::uuid into schedule_id');
  changed:=replace(changed,
    'where (x->>''old_id'')::uuid=c.source_schedule_id and coalesce(c.period_start,c.due_date)>=(x->>''start_date'')::date
            and (x->>''end_date'' is null or coalesce(c.period_start,c.due_date)<=(x->>''end_date'')::date) limit 1;',
    'where (x->>''old_id'')::uuid=c.source_schedule_id and public._rent_billing_slot(coalesce(c.period_start,c.due_date),s.due_day)>=(x->>''start_date'')::date
            and (x->>''end_date'' is null or public._rent_billing_slot(coalesce(c.period_start,c.due_date),s.due_day)<=(x->>''end_date'')::date) limit 1;');
  if changed=definition then raise exception 'commit schedule mapping marker not found'; end if;
  execute changed;
end $$;

create or replace function public._carry_rent_change_waivers(p_account_id uuid,p_schedule_id uuid,p_old_ids uuid[],p_plans jsonb)
returns void language sql set search_path=public as $$
  insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,
    description,source_schedule_id,voided_at,void_reason,corrects_charge_id)
  select waived.account_id,waived.tenancy_id,waived.type,waived.amount_cents,waived.currency,
    case when successor.due_day=predecessor.due_day then waived.due_date else dates.slot end,
    dates.slot,(dates.slot+interval '1 month'-interval '1 day')::date,
    waived.description,successor.id,now(),waived.void_reason,waived.id
  from public.charges waived
  join public.rent_schedules predecessor on predecessor.id=waived.source_schedule_id
  join public.rent_schedules successor on successor.account_id=waived.account_id and successor.id=p_schedule_id
  cross join lateral (select public._rent_billing_slot(coalesce(waived.period_start,waived.due_date),successor.due_day) slot) dates
  where waived.account_id=p_account_id and waived.source_schedule_id=any(p_old_ids)
    and waived.type='rent' and waived.voided_at is not null and waived.deleted_at is null
    and dates.slot>=successor.start_date and (successor.end_date is null or dates.slot<=successor.end_date)
    and not exists (select 1 from jsonb_array_elements(p_plans) effect where effect->>'id'=waived.id::text)
  on conflict(source_schedule_id,period_start) where source_schedule_id is not null and period_start is not null do nothing
$$;
revoke all on function public._carry_rent_change_waivers(uuid,uuid,uuid[],jsonb) from public,anon,authenticated,service_role;
grant execute on function public._carry_rent_change_waivers(uuid,uuid,uuid[],jsonb) to rent_adjustment_writer;

do $$
declare definition text; changed text;
begin
  select pg_get_functiondef('public.generate_rent_charges(uuid,timestamptz)'::regprocedure) into definition;
  changed:=replace(definition,
    'case when extract(day from p_as_of)::int > s.due_day
            then (date_trunc(''month'', p_as_of) + interval ''1 month''
                    + make_interval(days => s.due_day - 1))::date
            else (date_trunc(''month'', p_as_of)
                    + make_interval(days => s.due_day - 1))::date
          end as p_start',
    'public._rent_billing_slot((case when extract(day from p_as_of)::int>s.due_day then p_as_of+interval ''1 month'' else p_as_of end)::date,s.due_day) as p_start');
  if changed=definition then raise exception 'generator billing marker not found'; end if;
  execute changed;
end $$;
