do $$
declare definition text; start_at int; stop_at int; waiver text;
begin
  select pg_get_functiondef('public.commit_rent_adjustment(uuid,uuid,jsonb,text,text,text)'::regprocedure) into definition;
  start_at:=strpos(definition,'select c.account_id,c.tenancy_id,c.type,c.amount_cents');
  stop_at:=strpos(definition,'on conflict(source_schedule_id,period_start)');
  if start_at=0 or stop_at<=start_at then raise exception 'waiver query not found'; end if;
  waiver:=substr(definition,start_at,stop_at-start_at);
  execute replace(definition,waiver,replace(replace(waiver,'c.','waived.'),'public.charges c','public.charges waived'));
end $$;
