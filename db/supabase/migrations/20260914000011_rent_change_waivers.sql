create function public._carry_rent_change_waivers(p_account_id uuid,p_schedule_id uuid,p_old_ids uuid[],p_plans jsonb)
returns void language sql set search_path=public as $$
  insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,
    description,source_schedule_id,voided_at,void_reason,corrects_charge_id)
  select waived.account_id,waived.tenancy_id,waived.type,waived.amount_cents,waived.currency,
    dates.due_date,dates.period_start,(dates.period_start+interval '1 month'-interval '1 day')::date,
    waived.description,successor.id,now(),waived.void_reason,waived.id
  from public.charges waived
  join public.rent_schedules predecessor on predecessor.id=waived.source_schedule_id
  join public.rent_schedules successor on successor.account_id=waived.account_id and successor.id=p_schedule_id
  cross join lateral (
    select case when successor.due_day=predecessor.due_day then waived.due_date
      else date_trunc('month',waived.period_start)::date+successor.due_day-1 end as due_date,
      case when successor.due_day=predecessor.due_day then waived.period_start
      else date_trunc('month',waived.period_start)::date+successor.due_day-1 end as period_start
  ) dates
  where waived.account_id=p_account_id and waived.source_schedule_id=any(p_old_ids)
    and waived.type='rent' and waived.voided_at is not null and waived.deleted_at is null
    and dates.period_start>=successor.start_date
    and (successor.end_date is null or dates.period_start<=successor.end_date)
    and not exists (select 1 from jsonb_array_elements(p_plans) effect where effect->>'id'=waived.id::text)
  on conflict(source_schedule_id,period_start) where source_schedule_id is not null and period_start is not null do nothing
$$;
revoke all on function public._carry_rent_change_waivers(uuid,uuid,uuid[],jsonb) from public,anon,authenticated,service_role;
grant execute on function public._carry_rent_change_waivers(uuid,uuid,uuid[],jsonb) to rent_adjustment_writer;

do $$
declare definition text; marker text:='    receipt:=jsonb_build_object(''id'',operation_id';
begin
  select pg_get_functiondef('public.commit_rent_adjustment(uuid,uuid,jsonb,text,text,text)'::regprocedure) into definition;
  if strpos(definition,marker)=0 then raise exception 'receipt insertion not found'; end if;
  execute replace(definition,marker,$body$
    if p_payload->>'kind'='change_rent' then
      perform public._carry_rent_change_waivers(p_account_id,schedule_id,selected_ids,plan->'_plans');
    end if;
$body$||marker);
end $$;
