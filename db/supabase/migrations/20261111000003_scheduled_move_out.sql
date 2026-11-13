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
-- PROVENANCE: a move-out change voids a scheduled period and records its
-- corrected amount as a replacement that points at the original scheduled charge.
alter table public.charges
  add column replaces_charge_id uuid,
  add constraint charges_replaces_charge_fk foreign key (account_id, replaces_charge_id)
    references public.charges(account_id, id),
  add constraint charges_replacement_shape check (
    replaces_charge_id is null or (source_schedule_id is null and cycle_key is null and parent_charge_id is null)
  );
create index charges_replaces_charge_idx on public.charges(account_id, replaces_charge_id)
  where replaces_charge_id is not null;
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

-- INVARIANT: a tenancy whose last day has passed in the account's time zone is
-- ended on read even though its stored status stays active.
create function public._moved_out(p_move_out date, p_account_id uuid)
returns boolean language sql stable set search_path = public as $$
  select coalesce(p_move_out < public._account_date(p_account_id), false)
$$;
revoke all on function public._moved_out(date,uuid) from public, anon;
grant execute on function public._moved_out(date,uuid) to authenticated, service_role, tenancy_date_writer, tenancy_setup_writer;

create function public._tenancy_current_status(p_tenancy public.tenancies)
returns text language sql stable set search_path = public as $$
  select case when p_tenancy.move_out_on is null then public.effective_tenancy_status(p_tenancy.status, p_tenancy.start_date)
    else public._tenancy_status_on(p_tenancy.status, p_tenancy.start_date, p_tenancy.move_out_on,
      public._account_date(p_tenancy.account_id)) end
$$;
revoke all on function public._tenancy_current_status(public.tenancies) from public, anon;
grant execute on function public._tenancy_current_status(public.tenancies) to authenticated, service_role, tenancy_date_writer, tenancy_setup_writer;

create or replace view public.tenancy_current with (security_invoker = true) as
select t.id, t.account_id, t.area_id, t.start_date,
  case when t.move_out_on < d.account_date then t.move_out_on else t.end_date end as end_date,
  case when t.move_out_on is null then public.effective_tenancy_status(t.status,t.start_date)
    else public._tenancy_status_on(t.status,t.start_date,t.move_out_on,d.account_date) end as status,
  t.created_at,t.updated_at,t.deleted_at,t.start_date_basis,t.actual_move_in_date,t.date_revision,
  t.move_out_on, t.move_out_plan, d.account_date, a.scheduled_move_out_enabled
from public.tenancies t
join public.accounts a on a.id = t.account_id
cross join lateral (select (statement_timestamp() at time zone a.time_zone)::date as account_date) d;

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

create function public._guard_charge_replacement() returns trigger
language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.replaces_charge_id is not null and current_user <> 'tenancy_date_writer')
    or (tg_op = 'UPDATE' and new.replaces_charge_id is distinct from old.replaces_charge_id) then
    raise exception 'Move-out replacements are written by the tenancy command' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public._guard_charge_replacement() from public, anon, authenticated, service_role;
create trigger charges_guard_replacement before insert or update of replaces_charge_id on public.charges
  for each row execute function public._guard_charge_replacement();

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

-- The billing planner sees the same move-out-adjusted periods the charge guard enforces.
create function public._billing_period_for_tenancy(p_account_id uuid, p_tenancy_id uuid, p_intent jsonb, p_cycle text)
returns jsonb language sql stable set search_path = public as $$
  select public._move_out_billing_period(
    jsonb_populate_record(null::public.rent_schedules, jsonb_build_object('account_id',p_account_id,
      'tenancy_id',p_tenancy_id,'kind','rent','amount_cents',(p_intent->>'amount_cents')::bigint)),
    public._billing_period(p_intent,p_cycle))
$$;
revoke all on function public._billing_period_for_tenancy(uuid,uuid,jsonb,text) from public, anon;
grant execute on function public._billing_period_for_tenancy(uuid,uuid,jsonb,text) to authenticated, service_role, tenancy_date_writer, tenancy_setup_writer;

-- The period a scheduled charge's cycle covers before any move-out adjustment.
create function public._scheduled_base_period(s public.rent_schedules, p_cycle_key text)
returns jsonb language plpgsql stable set search_path = public as $$
declare v_start date;
begin
  if p_cycle_key is null then return null; end if;
  if s.period_policy_version = 1 then
    if p_cycle_key !~ '^legacy:\d{4}-\d{2}-\d{2}$' then return null; end if;
    v_start := substr(p_cycle_key, 8)::date;
    return jsonb_build_object('period_start',v_start,'period_end',(v_start+interval '1 month'-interval '1 day')::date,
      'due_date',v_start,'amount_cents',s.amount_cents,'cycle_key',p_cycle_key,'needs_override',false);
  end if;
  return public._billing_period(public._schedule_billing_intent(s), p_cycle_key);
end;
$$;
revoke all on function public._scheduled_base_period(public.rent_schedules,text) from public, anon, authenticated, service_role;
grant execute on function public._scheduled_base_period(public.rent_schedules,text) to tenancy_date_writer;

-- DATA FLOW: move-out changes from p_from onward -> each scheduled period ending
-- after p_from is compared with its move-out-adjusted amount -> a differing live
-- charge is voided and, when rent is still owed for that period, replaced.
-- INVARIANT: money a payment or fee already relies on is never changed here;
-- the command fails with move_out_changed so the landlord reviews it.
create function public._reconcile_move_out_charges(p_account_id uuid, p_tenancy_id uuid, p_from date)
returns void language plpgsql set search_path = public as $$
declare
  marker constant text := 'Scheduled move-out changed this period';
  s public.rent_schedules;
  root public.charges;
  live public.charges;
  last_reason text;
  base jsonb;
  target jsonb;
  live_count integer;
begin
  if p_from is null then return; end if;
  for s in select * from public.rent_schedules where account_id = p_account_id and tenancy_id = p_tenancy_id
    and deleted_at is null order by start_date, id loop
    for root in select * from public.charges c where c.account_id = p_account_id and c.tenancy_id = p_tenancy_id
      and c.source_schedule_id = s.id and c.cycle_key is not null and c.deleted_at is null order by c.period_start loop
      base := public._scheduled_base_period(s, root.cycle_key);
      if base is null or coalesce((base->>'needs_override')::boolean, false)
        or (base->>'period_end')::date <= p_from then continue; end if;
      target := public._move_out_billing_period(s, base);
      if coalesce((target->>'amount_cents')::bigint, 0) = 0 then target := null; end if;
      select count(*) into live_count from public.charges m where m.account_id = p_account_id
        and (m.id = root.id or m.replaces_charge_id = root.id) and m.voided_at is null and m.deleted_at is null;
      if live_count > 1 then
        raise exception 'move_out_changed: this period has more than one live rent charge; review it first' using errcode = 'P0001';
      end if;
      select * into live from public.charges m where m.account_id = p_account_id
        and (m.id = root.id or m.replaces_charge_id = root.id) and m.voided_at is null and m.deleted_at is null;
      if found then
        if target is not null and (live.period_start, live.period_end, live.due_date, live.amount_cents)
          = ((target->>'period_start')::date, (target->>'period_end')::date, (target->>'due_date')::date,
             (target->>'amount_cents')::bigint) then continue; end if;
        if exists (select 1 from public.payment_allocations a join public.payments p
            on p.account_id = a.account_id and p.id = a.payment_id
          where a.account_id = p_account_id and a.charge_id = live.id and a.voided_at is null and a.deleted_at is null
            and p.voided_at is null and p.deleted_at is null)
          or exists (select 1 from public.charges f where f.account_id = p_account_id and f.parent_charge_id = live.id
            and f.voided_at is null and f.deleted_at is null) then
          raise exception 'move_out_changed: a payment or fee is applied to rent this move-out changes; review it first'
            using errcode = 'P0001';
        end if;
        update public.charges set voided_at = clock_timestamp(), void_reason = marker, updated_at = clock_timestamp()
          where account_id = p_account_id and id = live.id;
      else
        -- Restore only a period this command emptied, never one the landlord voided.
        select m.void_reason into last_reason from public.charges m where m.account_id = p_account_id
          and (m.id = root.id or m.replaces_charge_id = root.id) and m.deleted_at is null
          order by m.voided_at desc nulls last, m.created_at desc limit 1;
        if last_reason is distinct from marker then continue; end if;
      end if;
      if target is not null then
        insert into public.charges(account_id, tenancy_id, type, amount_cents, currency, due_date,
          period_start, period_end, description, replaces_charge_id)
        values (p_account_id, p_tenancy_id, root.type, (target->>'amount_cents')::bigint, root.currency,
          (target->>'due_date')::date, (target->>'period_start')::date, (target->>'period_end')::date,
          case when target ? 'reason' then 'Rent through ' || (target->>'period_end') || ' (move-out)' else root.description end,
          root.id);
      end if;
    end loop;
  end loop;
end;
$$;
revoke all on function public._reconcile_move_out_charges(uuid,uuid,date) from public, anon, authenticated, service_role;
grant execute on function public._reconcile_move_out_charges(uuid,uuid,date) to tenancy_date_writer;

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
    or public._moved_out(t.move_out_on, p_account_id) or t.status = 'ended' then
    raise exception 'move_out_changed' using errcode='P0001';
  end if;
  if exists (select 1 from public.tenancies successor where successor.account_id=t.account_id
    and successor.area_id=t.area_id and successor.start_date>t.start_date and successor.status<>'ended'
    and successor.deleted_at is null) then
    raise exception 'move_out_overlap' using errcode='P0001';
  end if;
  update public.tenancies set move_out_on=null,move_out_plan=null,date_revision=date_revision+1,updated_at=clock_timestamp()
    where account_id=p_account_id and id=p_tenancy_id;
  perform public._reconcile_move_out_charges(p_account_id, p_tenancy_id, t.move_out_on);
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

-- Replaces each anchor exactly p_count times so a changed body fails the migration.
create or replace function pg_temp.patched(p_body text, p_anchor text, p_replacement text, p_count integer default 1)
returns text language plpgsql as $$
declare found_count integer := (length(p_body) - length(replace(p_body, p_anchor, ''))) / length(p_anchor);
begin
  if found_count <> p_count then
    raise exception 'migration anchor matched % times, expected %: %', found_count, p_count, p_anchor;
  end if;
  return replace(p_body, p_anchor, p_replacement);
end;
$$;

do $migration$
declare body text; anchor text;
begin
  body:=pg_get_functiondef('public.preview_tenancy_ending(uuid,uuid,jsonb)'::regprocedure);
  anchor:='  entered:=public._tenancy_calendar_date(p_payload->>''effective_date'');';
  body:=pg_temp.patched(body,anchor,$patch$
  if exists (select 1 from public.accounts where id=p_account_id and scheduled_move_out_enabled) then
    today:=public._account_date(p_account_id);
  end if;
$patch$ || anchor);
  body:=pg_temp.patched(body,'and entered>today then findings:=', $patch$and entered>today
    and not exists (select 1 from public.accounts where id=p_account_id and scheduled_move_out_enabled) then findings:=$patch$);
  execute body;

  body:=pg_get_functiondef('public.record_tenancy_ending(uuid,uuid,jsonb,text,text)'::regprocedure);
  anchor:='declare preview jsonb;result jsonb;k public.idempotency_keys;';
  body:=pg_temp.patched(body,anchor,anchor||'t public.tenancies;v_today date;v_date date;v_enabled boolean;v_old date;');
  anchor:='  perform pg_advisory_xact_lock(hashtextextended(''rent_change:''||p_tenancy_id::text,0));';
  body:=pg_temp.patched(body,anchor,$patch$
  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('tenancy_identity:'||p_account_id::text||':'||t.area_id::text,0));
$patch$||anchor);
  body:=pg_temp.patched(body,'  perform 1 from public.tenancies where account_id=p_account_id and id=p_tenancy_id for update;',
    '  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null for update;');
  body:=pg_temp.patched(body,'  result:=public.end_tenancy(',$patch$
  select scheduled_move_out_enabled into v_enabled from public.accounts where id=p_account_id;
  v_today:=public._account_date(p_account_id);
  v_date:=(p_payload->>'effective_date')::date;
  if t.move_out_on is distinct from (p_payload->>'expected_move_out_on')::date then
    raise exception 'move_out_changed' using errcode='P0001';
  end if;
  -- A passed move-out is the ending; it is not recorded or rescheduled again.
  if public._moved_out(t.move_out_on,p_account_id) then
    raise exception 'conflict: tenancy already ended';
  end if;
  if v_enabled and p_payload->>'kind'='ended' and v_date>v_today then
    if public.effective_tenancy_status(t.status,t.start_date,v_today) not in ('active','holdover') then
      raise exception 'conflict: a move-out can be scheduled only after the tenancy starts';
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
    v_old:=t.move_out_on;
    update public.tenancies set move_out_on=v_date,
      move_out_plan=jsonb_strip_nulls(p_payload-array['warning_acknowledgements','expected_context_fingerprint','expected_move_out_on'])
        ||jsonb_build_object('scheduled_at',clock_timestamp(),'scheduled_by',public._tenancy_date_actor()),
      date_revision=date_revision+1,updated_at=clock_timestamp()
      where account_id=p_account_id and id=p_tenancy_id;
    perform public._reconcile_move_out_charges(p_account_id,p_tenancy_id,least(v_old,v_date));
    select jsonb_build_object('tenancy',to_jsonb(c),'ending',null) into result
      from public.tenancy_current c where c.account_id=p_account_id and c.id=p_tenancy_id;
    update public.idempotency_keys set status_code=200,body=result,completed_at=clock_timestamp()
      where account_id=p_account_id and key=p_idempotency_key;
    return result;
  end if;
  -- An actual ending replaces the plan; recorded money stays as it is, as for any ending.
  if t.move_out_on is not null then
    update public.tenancies set move_out_on=null,move_out_plan=null,updated_at=clock_timestamp()
      where account_id=p_account_id and id=p_tenancy_id;
  end if;
$patch$||'  result:=public.end_tenancy(');
  execute body;

  body:=pg_get_functiondef('public.generate_rent_charges(uuid,timestamp with time zone)'::regprocedure);
  body:=pg_temp.patched(body,'    if not found or public.effective_tenancy_status(t.status,t.start_date,v_today) = ''ended'' then continue; end if;',$patch$
    if not found then continue; end if;
    v_today := case when t.move_out_on is null then (p_as_of at time zone 'UTC')::date
      else public._account_date(p_account_id,p_as_of) end;
    if public._tenancy_status_on(t.status,t.start_date,t.move_out_on,v_today) = 'ended' then continue; end if;
$patch$);
  body:=pg_temp.patched(body,'candidate := public._billing_period(public._schedule_billing_intent(s),to_char(v_cycle,''YYYY-MM''));',
    'candidate := public._move_out_billing_period(s,public._billing_period(public._schedule_billing_intent(s),to_char(v_cycle,''YYYY-MM'')));');
  anchor:='    else'||chr(10)||'      p := null;';
  body:=pg_temp.patched(body,anchor,$patch$
      p := public._move_out_billing_period(s,p);
      if p is null then continue; end if;
$patch$||anchor);
  execute body;

  body:=pg_get_functiondef('public._charge_billing_basis_guard()'::regprocedure);
  body:=pg_temp.patched(body,'v_period := public._billing_period(public._schedule_billing_intent(v_schedule),v_cycle);',
    'v_period := public._move_out_billing_period(v_schedule,public._billing_period(public._schedule_billing_intent(v_schedule),v_cycle));');
  execute body;

  body:=pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body:=pg_temp.patched(body,'public._billing_period(r,','public._billing_period_for_tenancy(p_account_id,t.id,r,',6);
  body:=pg_temp.patched(body,'if t.status = ''ended'' then raise exception ''conflict: recurring setup',
    'if t.status = ''ended'' or public._moved_out(t.move_out_on,t.account_id) then raise exception ''conflict: recurring setup');
  -- A move-out replacement belongs to its scheduled period: a transition voids it
  -- with the schedule it replaced, and it is not an unscheduled overlap.
  body:=pg_temp.patched(body,'c.account_id = p_account_id and c.source_schedule_id = any(v_ended)',
    'c.account_id = p_account_id and (c.source_schedule_id = any(v_ended) or c.replaces_charge_id in (
          select o.id from public.charges o where o.account_id = p_account_id and o.source_schedule_id = any(v_ended)))');
  body:=pg_temp.patched(body,'c->>''type'' not in (''deposit'',''opening_balance'')) then',
    'c->>''type'' not in (''deposit'',''opening_balance'') and c->>''replaces_charge_id'' is null) then');
  execute body;

  -- Readers of stored tenancy status treat a passed move-out as ended.
  body:=pg_get_functiondef('public.preview_tenancy_setup_session(uuid,uuid,jsonb)'::regprocedure);
  body:=pg_temp.patched(body,'actual_t.status=''ended'' then',
    '(actual_t.status=''ended'' or public._moved_out(actual_t.move_out_on,actual_t.account_id)) then');
  execute body;

  body:=pg_get_functiondef('public.capture_inbound'::regproc);
  body:=pg_temp.patched(body,'ten.status in (''upcoming'', ''active'', ''holdover'')',
    'ten.status in (''upcoming'', ''active'', ''holdover'') and not public._moved_out(ten.move_out_on, ten.account_id)',2);
  execute body;

  body:=pg_get_functiondef('public.change_tenancy_rent'::regproc);
  body:=pg_temp.patched(body,'if v_tenancy.status = ''ended'' then',
    'if v_tenancy.status = ''ended'' or exists (select 1 from public.tenancies x where x.account_id = p_account_id
    and x.id = p_tenancy_id and public._moved_out(x.move_out_on, x.account_id)) then');
  execute body;

  body:=pg_get_functiondef('public.adopt_tenancy_history'::regproc);
  body:=pg_temp.patched(body,'if v_tenancy.status = ''ended'' then',
    'if v_tenancy.status = ''ended'' or exists (select 1 from public.tenancies x where x.account_id = p_account_id
    and x.id = p_tenancy_id and public._moved_out(x.move_out_on, x.account_id)) then');
  execute body;

  body:=pg_get_functiondef('public._tenancy_adoptions_guard()'::regprocedure);
  body:=pg_temp.patched(body,'v_tenancy.status = ''ended'' then',
    'v_tenancy.status = ''ended'' or exists (select 1 from public.tenancies x where x.account_id = NEW.account_id
    and x.id = NEW.tenancy_id and public._moved_out(x.move_out_on, x.account_id)) then');
  execute body;

  body:=pg_get_functiondef('public.detect_rent_drift'::regproc);
  body:=pg_temp.patched(body,'and t.status <> ''ended''',
    'and t.status <> ''ended'' and not public._moved_out(t.move_out_on, t.account_id)');
  execute body;

  body:=pg_get_functiondef('public._tenancy_date_facts'::regproc);
  body:=pg_temp.patched(body,'''status'',public.effective_tenancy_status(p_t.status,p_t.start_date)',
    '''status'',public._tenancy_current_status(p_t)');
  execute body;

  body:=pg_get_functiondef('public._date_context_without_warning(uuid,uuid,uuid,uuid)'::regprocedure);
  body:=pg_temp.patched(body,'''effective_status'',public.effective_tenancy_status(t.status,t.start_date,today)',
    '''effective_status'',public._tenancy_current_status(t)');
  execute body;

  body:=pg_get_functiondef('public.get_tenancy_onboarding_progress(uuid,uuid)'::regprocedure);
  body:=pg_temp.patched(body,'''effective_status'',public.effective_tenancy_status(t.status,t.start_date)',
    '''effective_status'',public._tenancy_current_status(t)');
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
