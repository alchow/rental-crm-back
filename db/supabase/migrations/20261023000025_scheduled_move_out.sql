begin;

alter table public.accounts
  add column time_zone text not null default 'UTC',
  add column scheduled_move_out_enabled boolean not null default false;
alter table public.tenancies
  add column move_out_on date,
  add column move_out_plan jsonb,
  add constraint tenancies_move_out_plan_check check (
    (move_out_on is null and move_out_plan is null) or
    (move_out_on >= start_date and jsonb_typeof(move_out_plan) = 'object')
  );
grant update (time_zone) on public.accounts to authenticated;
grant update (move_out_on, move_out_plan) on public.tenancies to tenancy_date_writer;

create function public._validate_account_time_zone() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.time_zone) then
    raise exception 'invalid: choose an IANA time zone' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public._validate_account_time_zone() from public, anon, authenticated, service_role;
create trigger accounts_validate_time_zone before insert or update of time_zone on public.accounts
  for each row execute function public._validate_account_time_zone();

create function public.create_account_for_new_user(p_account_name text, p_display_name text, p_time_zone text)
returns table(account_id uuid, role text)
language plpgsql set search_path = public as $$
begin
  select created.account_id, created.role into account_id, role
  from public.create_account_for_new_user(p_account_name, p_display_name) created;
  update public.accounts a set time_zone = p_time_zone where a.id = account_id;
  return next;
end;
$$;
revoke all on function public.create_account_for_new_user(text,text,text) from public, anon;
grant execute on function public.create_account_for_new_user(text,text,text) to authenticated;

create function public._account_date(p_account_id uuid, p_as_of timestamptz default statement_timestamp())
returns date language sql stable set search_path = public as $$
  select (p_as_of at time zone coalesce((select time_zone from public.accounts where id = p_account_id), 'UTC'))::date
$$;
revoke all on function public._account_date(uuid,timestamptz) from public, anon;
grant execute on function public._account_date(uuid,timestamptz) to authenticated, service_role, tenancy_date_writer, tenancy_setup_writer;

create function public._tenancy_status_on(p_status text, p_start date, p_move_out date, p_today date)
returns text language sql immutable set search_path = public as $$
  select case when p_move_out < p_today then 'ended' else public.effective_tenancy_status(p_status, p_start, p_today) end
$$;
revoke all on function public._tenancy_status_on(text,date,date,date) from public, anon;
grant execute on function public._tenancy_status_on(text,date,date,date) to authenticated, service_role, tenancy_date_writer, tenancy_setup_writer;

create or replace view public.tenancy_current with (security_invoker = true) as
select t.id, t.account_id, t.area_id, t.start_date,
  case when t.move_out_on < public._account_date(t.account_id) then t.move_out_on else t.end_date end as end_date,
  case when t.move_out_on is null then public.effective_tenancy_status(t.status,t.start_date)
    else public._tenancy_status_on(t.status,t.start_date,t.move_out_on,public._account_date(t.account_id)) end as status,
  t.created_at,t.updated_at,t.deleted_at,t.start_date_basis,t.actual_move_in_date,t.date_revision,
  t.move_out_on, t.move_out_plan, public._account_date(t.account_id) as account_date,
  a.scheduled_move_out_enabled
from public.tenancies t join public.accounts a on a.id = t.account_id;

create function public._guard_scheduled_move_out() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' and (new.move_out_on is not null or new.move_out_plan is not null) then
    raise exception 'Schedule move-out through the tenancy command' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.move_out_on,new.move_out_plan) is distinct from (old.move_out_on,old.move_out_plan)
    and current_user <> 'tenancy_date_writer' then
    raise exception 'Schedule move-out through the tenancy command' using errcode = '42501';
  end if;
  if new.deleted_at is not null or new.status = 'ended' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('tenancy_identity:' || new.account_id::text || ':' || new.area_id::text,0));
  if exists (select 1 from public.tenancies t where t.account_id = new.account_id and t.area_id = new.area_id
    and t.id <> new.id and t.deleted_at is null and t.status <> 'ended'
    and ((new.move_out_on is not null and t.start_date > new.start_date and t.start_date <= new.move_out_on)
      or (t.move_out_on is not null and new.start_date >= t.start_date and new.start_date <= t.move_out_on))) then
    raise exception 'move_out_overlap' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public._guard_scheduled_move_out() from public, anon, authenticated, service_role;
create trigger tenancies_guard_scheduled_move_out
  before insert or update of start_date, move_out_on, move_out_plan on public.tenancies
  for each row execute function public._guard_scheduled_move_out();

create function public._move_out_billing_period(s public.rent_schedules, p_period jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  t public.tenancies;
  from_on date := (p_period->>'period_start')::date;
  to_on date := (p_period->>'period_end')::date;
  cents bigint;
  denominator integer;
begin
  if p_period is null then return null; end if;
  select * into t from public.tenancies where account_id = s.account_id and id = s.tenancy_id;
  if t.move_out_on is null or t.move_out_on >= to_on then return p_period; end if;
  if t.move_out_on < from_on then return null; end if;
  if s.kind <> 'rent' then return null; end if;
  if t.move_out_plan->>'final_rent_schedule_id' = s.id::text then
    cents := (t.move_out_plan->>'final_rent_amount_cents')::bigint;
  end if;
  denominator := extract(day from (date_trunc('month',from_on) + interval '1 month - 1 day'))::integer;
  return p_period || jsonb_build_object('period_end',t.move_out_on,
    'due_date',least((p_period->>'due_date')::date,t.move_out_on),
    'amount_cents',coalesce(cents,round(s.amount_cents::numeric *
      least(t.move_out_on - from_on + 1,denominator) / denominator)::bigint),
    'reason','Scheduled move-out', 'needs_override',false);
end;
$$;
revoke all on function public._move_out_billing_period(public.rent_schedules,jsonb) from public, anon;
grant execute on function public._move_out_billing_period(public.rent_schedules,jsonb) to authenticated, service_role, tenancy_date_writer, tenancy_setup_writer;

grant create on schema public to tenancy_date_writer;
create function public.cancel_scheduled_move_out(
  p_account_id uuid, p_tenancy_id uuid, p_expected_move_out_on date,
  p_idempotency_key text, p_request_fingerprint text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k public.idempotency_keys;
  t public.tenancies;
  result jsonb;
begin
  if not exists (select 1 from public.account_members m where m.account_id = p_account_id
    and m.user_id = public._tenancy_date_actor() and m.deleted_at is null and m.role in ('owner','manager')) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into k from public.idempotency_keys where account_id=p_account_id and key=p_idempotency_key for update;
  if not found or k.request_fingerprint is distinct from p_request_fingerprint then raise exception 'idempotency_fingerprint_mismatch'; end if;
  if k.completed_at is not null then return k.body; end if;
  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('tenancy_identity:'||p_account_id::text||':'||t.area_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||p_tenancy_id::text,0));
  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if t.move_out_on is null or t.move_out_on is distinct from p_expected_move_out_on
    or t.move_out_on < public._account_date(p_account_id) or t.status = 'ended' then
    raise exception 'move_out_changed' using errcode='P0001';
  end if;
  if exists (select 1 from public.tenancies successor where successor.account_id=t.account_id
    and successor.area_id=t.area_id and successor.start_date>t.start_date and successor.status<>'ended'
    and successor.deleted_at is null) then
    raise exception 'move_out_overlap' using errcode='P0001';
  end if;
  update public.tenancies set move_out_on=null,move_out_plan=null,date_revision=date_revision+1,updated_at=clock_timestamp()
    where account_id=p_account_id and id=p_tenancy_id;
  select to_jsonb(c) into result from public.tenancy_current c where c.account_id=p_account_id and c.id=p_tenancy_id;
  update public.idempotency_keys set status_code=200,body=result,completed_at=clock_timestamp()
    where account_id=p_account_id and key=p_idempotency_key;
  return result;
end;
$$;
alter function public.cancel_scheduled_move_out(uuid,uuid,date,text,text) owner to tenancy_date_writer;
revoke create on schema public from tenancy_date_writer;
revoke all on function public.cancel_scheduled_move_out(uuid,uuid,date,text,text) from public, anon;
grant execute on function public.cancel_scheduled_move_out(uuid,uuid,date,text,text) to authenticated;
grant select on public.tenancy_current to tenancy_date_writer;

do $migration$
declare body text; anchor text;
begin
  body:=pg_get_functiondef('public.preview_tenancy_ending(uuid,uuid,jsonb)'::regprocedure);
  anchor:='  entered:=public._tenancy_calendar_date(p_payload->>''effective_date'');';
  assert position(anchor in body)>0,'ending date preview changed';
  body:=replace(body,anchor,$patch$
  if exists (select 1 from public.accounts where id=p_account_id and scheduled_move_out_enabled) then
    today:=public._account_date(p_account_id);
  end if;
$patch$ || anchor);
  body:=replace(body,'and entered>today then findings:=', $patch$and entered>today
    and not exists (select 1 from public.accounts where id=p_account_id and scheduled_move_out_enabled) then findings:=$patch$);
  execute body;

  body:=pg_get_functiondef('public.record_tenancy_ending(uuid,uuid,jsonb,text,text)'::regprocedure);
  anchor:='declare preview jsonb;result jsonb;k public.idempotency_keys;';
  assert position(anchor in body)>0,'ending command declaration changed';
  body:=replace(body,anchor,anchor||'t public.tenancies;v_today date;v_date date;v_enabled boolean;');
  anchor:='  perform pg_advisory_xact_lock(hashtextextended(''rent_change:''||p_tenancy_id::text,0));';
  assert position(anchor in body)>0,'ending lock changed';
  body:=replace(body,anchor,$patch$
  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('tenancy_identity:'||p_account_id::text||':'||t.area_id::text,0));
$patch$||anchor);
  anchor:='  perform 1 from public.tenancies where account_id=p_account_id and id=p_tenancy_id for update;';
  assert position(anchor in body)>0,'ending row lock changed';
  body:=replace(body,anchor,'  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null for update;');
  anchor:='  result:=public.end_tenancy(';
  assert position(anchor in body)>0,'actual ending call changed';
  body:=replace(body,anchor,$patch$
  select scheduled_move_out_enabled into v_enabled from public.accounts where id=p_account_id;
  v_today:=public._account_date(p_account_id);
  v_date:=(p_payload->>'effective_date')::date;
  if t.move_out_on is distinct from (p_payload->>'expected_move_out_on')::date then
    raise exception 'move_out_changed' using errcode='P0001';
  end if;
  if v_enabled and p_payload->>'kind'='ended' and v_date>v_today then
    if t.status not in ('active','holdover') or t.move_out_on < v_today then
      raise exception 'conflict: tenancy already ended';
    end if;
    if not exists (select 1 from public.account_members m where m.account_id=p_account_id
      and m.user_id=public._tenancy_date_actor() and m.deleted_at is null and m.role in ('owner','manager')) then
      raise exception 'not_found' using errcode='P0002';
    end if;
    if p_payload->>'source_notice_id' is not null and not exists (select 1 from public.notices n
      where n.account_id=p_account_id and n.tenancy_id=p_tenancy_id and n.id=(p_payload->>'source_notice_id')::uuid and n.deleted_at is null) then
      raise exception 'not_found: source notice' using errcode='P0002';
    end if;
    if p_payload->>'source_interaction_id' is not null and not exists (select 1 from public.interactions i
      where i.account_id=p_account_id and i.tenancy_id=p_tenancy_id and i.id=(p_payload->>'source_interaction_id')::uuid and i.deleted_at is null) then
      raise exception 'not_found: source interaction' using errcode='P0002';
    end if;
    if p_payload->>'final_rent_schedule_id' is not null and not exists (select 1 from public.rent_schedules s
      where s.account_id=p_account_id and s.tenancy_id=p_tenancy_id and s.id=(p_payload->>'final_rent_schedule_id')::uuid
        and s.kind='rent' and s.deleted_at is null and s.start_date<=v_date and (s.end_date is null or s.end_date>=v_date)) then
      raise exception 'move_out_changed' using errcode='P0001';
    end if;
    update public.tenancies set move_out_on=v_date,
      move_out_plan=jsonb_strip_nulls(p_payload-array['warning_acknowledgements','expected_context_fingerprint','expected_move_out_on'])
        ||jsonb_build_object('scheduled_at',clock_timestamp(),'scheduled_by',public._tenancy_date_actor()),
      date_revision=date_revision+1,updated_at=clock_timestamp()
      where account_id=p_account_id and id=p_tenancy_id;
    select jsonb_build_object('tenancy',to_jsonb(c),'ending',null) into result
      from public.tenancy_current c where c.account_id=p_account_id and c.id=p_tenancy_id;
    update public.idempotency_keys set status_code=200,body=result,completed_at=clock_timestamp()
      where account_id=p_account_id and key=p_idempotency_key;
    return result;
  end if;
  if t.move_out_on is not null then
    update public.tenancies set move_out_on=null,move_out_plan=null,updated_at=clock_timestamp()
      where account_id=p_account_id and id=p_tenancy_id;
  end if;
$patch$||anchor);
  execute body;

  body:=pg_get_functiondef('public.generate_rent_charges(uuid,timestamp with time zone)'::regprocedure);
  anchor:='    if not found or public.effective_tenancy_status(t.status,t.start_date,v_today) = ''ended'' then continue; end if;';
  assert position(anchor in body)>0,'rent generator tenancy projection changed';
  body:=replace(body,anchor,$patch$
    if not found then continue; end if;
    v_today := case when t.move_out_on is null then (p_as_of at time zone 'UTC')::date
      else public._account_date(p_account_id,p_as_of) end;
    if public._tenancy_status_on(t.status,t.start_date,t.move_out_on,v_today) = 'ended' then continue; end if;
$patch$);
  anchor:='candidate := public._billing_period(public._schedule_billing_intent(s),to_char(v_cycle,''YYYY-MM''));';
  assert position(anchor in body)>0,'rent generator period planner changed';
  body:=replace(body,anchor,'candidate := public._move_out_billing_period(s,public._billing_period(public._schedule_billing_intent(s),to_char(v_cycle,''YYYY-MM'')));');
  anchor:='    else'||chr(10)||'      p := null;';
  assert position(anchor in body)>0,'legacy rent generator branch changed';
  body:=replace(body,anchor,$patch$
      p := public._move_out_billing_period(s,p);
      if p is null then continue; end if;
$patch$||anchor);
  execute body;

  body:=pg_get_functiondef('public._charge_billing_basis_guard()'::regprocedure);
  anchor:='v_period := public._billing_period(public._schedule_billing_intent(v_schedule),v_cycle);';
  assert position(anchor in body)>0,'scheduled charge validator changed';
  body:=replace(body,anchor,'v_period := public._move_out_billing_period(v_schedule,public._billing_period(public._schedule_billing_intent(v_schedule),v_cycle));');
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
