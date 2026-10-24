alter table public.rent_schedules
  add column period_policy_version integer not null default 1 check (period_policy_version in (1,2)),
  add column regular_anchor date,
  add column terms_snapshot jsonb not null default '{}',
  add column manual_basis text;
alter table public.charges
  add column cycle_key text,
  add column terms_snapshot jsonb;
-- Legacy invalid periods remain untouched; the schedule/period-start index still reserves their slots.
update public.charges set cycle_key = 'legacy:'||period_start::text
where source_schedule_id is not null and period_start is not null
  and period_end is not null and period_end >= period_start;
create unique index charges_one_per_schedule_cycle on public.charges(source_schedule_id,cycle_key)
where source_schedule_id is not null and cycle_key is not null;

create table public.rent_schedule_period_overrides(
  id uuid primary key default gen_random_uuid(),account_id uuid not null,tenancy_id uuid not null,
  schedule_id uuid not null,cycle_key text not null check (cycle_key ~ '^\d{4}-\d{2}$'),
  period_start date not null,period_end date not null,due_date date not null,
  amount_cents bigint not null check (amount_cents >= 0),reason text not null check(length(btrim(reason)) between 1 and 2000),
  created_by uuid not null default auth.uid(),created_at timestamptz not null default clock_timestamp(),
  unique(account_id,id),unique(schedule_id,cycle_key),check(period_end >= period_start),
  foreign key(account_id,tenancy_id) references public.tenancies(account_id,id),
  foreign key(account_id,schedule_id) references public.rent_schedules(account_id,id));
alter table public.rent_schedule_period_overrides enable row level security;
alter table public.rent_schedule_period_overrides force row level security;
create policy period_overrides_member_select on public.rent_schedule_period_overrides for select
using(public.is_account_member(account_id));
create policy period_overrides_manager_insert on public.rent_schedule_period_overrides for insert
with check(exists(select 1 from public.account_members m where m.account_id = rent_schedule_period_overrides.account_id
  and m.user_id = auth.uid() and m.deleted_at is null and m.role in ('owner','manager')));
grant select,insert on public.rent_schedule_period_overrides to authenticated;
grant all on public.rent_schedule_period_overrides to service_role;
create trigger rent_schedule_period_overrides_audit after insert on public.rent_schedule_period_overrides
for each row execute function public._emit_event();

create function public._billing_period(p_rent jsonb,p_cycle_key text) returns jsonb
language plpgsql immutable set search_path = public as $$
declare v_month date;v_regular date;v_start date;v_end date;v_full_end date;v_override jsonb;v_due date;
begin
  if p_cycle_key !~ '^\d{4}-\d{2}$' then raise exception 'invalid: invalid cycle key'; end if;
  v_month := (p_cycle_key||'-01')::date;
  v_regular := v_month + (extract(day from (p_rent->>'regular_anchor')::date)::integer-1);
  v_full_end := (v_regular+interval '1 month'-interval '1 day')::date;
  v_start := greatest(v_regular,(p_rent->>'coverage_start')::date);
  v_end := least(v_full_end,coalesce((p_rent->>'coverage_end')::date,v_full_end));
  if v_start > v_end then return null; end if;
  select value into v_override from jsonb_array_elements(coalesce(p_rent->'period_overrides','[]'))
    where value->>'cycle_key' = p_cycle_key;
  v_due := v_month+(p_rent->>'due_day')::integer-1;
  if v_override is not null then
    if (v_override->>'period_start')::date <> v_start or (v_override->>'period_end')::date <> v_end
      or (v_override->>'amount_cents')::bigint < 0 or length(btrim(coalesce(v_override->>'reason',''))) not between 1 and 2000
    then raise exception 'invalid: override must match exact schedule coverage and record amount and reason'; end if;
    v_due := (v_override->>'due_date')::date;
  end if;
  return jsonb_build_object('cycle_key',p_cycle_key,'type','rent','period_start',v_start,'period_end',v_end,
    'due_date',v_due,'amount_cents',coalesce((v_override->>'amount_cents')::bigint,(p_rent->>'amount_cents')::bigint),
    'currency',p_rent->>'currency','reason',v_override->>'reason',
    'needs_override',(v_start <> v_regular or v_end <> v_full_end) and v_override is null);
end $$;
revoke all on function public._billing_period(jsonb,text) from public,anon;
grant execute on function public._billing_period(jsonb,text) to authenticated,service_role;

create function public._schedule_billing_intent(p_schedule public.rent_schedules) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('coverage_start',p_schedule.start_date,'coverage_end',p_schedule.end_date,
    'regular_anchor',p_schedule.regular_anchor,'due_day',p_schedule.due_day,
    'amount_cents',p_schedule.amount_cents,'currency',p_schedule.currency,
    'period_overrides',coalesce((select jsonb_agg(to_jsonb(o)) from public.rent_schedule_period_overrides o
      where o.account_id = p_schedule.account_id and o.schedule_id = p_schedule.id),'[]'))
$$;
revoke all on function public._schedule_billing_intent(public.rent_schedules) from public,anon;
grant execute on function public._schedule_billing_intent(public.rent_schedules) to authenticated,service_role;

create function public._serialize_tenancy_financial_write() returns trigger
language plpgsql set search_path = public as $$
declare v_tenancy uuid;
begin
  if TG_TABLE_NAME = 'payment_allocations' then
    select p.tenancy_id into v_tenancy from public.payments p where p.account_id = NEW.account_id and p.id = NEW.payment_id;
  else v_tenancy := NEW.tenancy_id; end if;
  if v_tenancy is not null then
    perform pg_advisory_xact_lock(hashtextextended('rent_change:'||v_tenancy::text,0));
  end if;
  return NEW;
end $$;
revoke all on function public._serialize_tenancy_financial_write() from public,anon;
grant execute on function public._serialize_tenancy_financial_write() to authenticated,service_role;
create trigger a00_charges_financial_lock before insert on public.charges for each row execute function public._serialize_tenancy_financial_write();
create trigger a00_payments_financial_lock before insert on public.payments for each row execute function public._serialize_tenancy_financial_write();
create trigger a00_allocations_financial_lock before insert on public.payment_allocations for each row execute function public._serialize_tenancy_financial_write();

create function public._schedule_terms_snapshot_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_lease jsonb;v_notice jsonb;
begin
  if TG_OP = 'UPDATE' and (NEW.period_policy_version,NEW.regular_anchor,NEW.terms_snapshot,NEW.manual_basis)
    is distinct from (OLD.period_policy_version,OLD.regular_anchor,OLD.terms_snapshot,OLD.manual_basis)
  then raise exception 'invalid: billing basis is immutable; record a successor schedule'; end if;
  if TG_OP = 'UPDATE' and OLD.period_policy_version = 2 and
    (NEW.grace_days,NEW.late_fee_cents) is distinct from (OLD.grace_days,OLD.late_fee_cents)
  then raise exception 'invalid: confirmed policy is immutable; record a successor billing instruction'; end if;
  if TG_OP = 'INSERT' then
    if NEW.period_policy_version = 2 and (NEW.regular_anchor is null
      or extract(day from NEW.regular_anchor) > 28
      or NEW.regular_anchor < NEW.start_date or NEW.regular_anchor >= (NEW.start_date+interval '1 month')::date)
    then raise exception 'invalid: regular anchor must be within the first coverage month and use day 1 through 28'; end if;
    if NEW.source_lease_id is not null then
      select to_jsonb(l) into v_lease from public.leases l where l.account_id = NEW.account_id
        and l.tenancy_id = NEW.tenancy_id and l.id = NEW.source_lease_id and l.deleted_at is null and l.voided_at is null;
    end if;
    if NEW.source_notice_id is not null then
      select to_jsonb(n) into v_notice from public.notices n where n.account_id = NEW.account_id
        and n.tenancy_id = NEW.tenancy_id and n.id = NEW.source_notice_id and n.deleted_at is null;
    end if;
    NEW.terms_snapshot := jsonb_build_object('version',1,
      'source',case when NEW.period_policy_version = 1 then 'legacy_billing' else
        case when v_lease is not null then 'lease' when v_notice is not null then 'notice' else 'manual' end end,
      'agreement',case when NEW.period_policy_version = 2 then v_lease else null end,
      'notice',case when NEW.period_policy_version = 2 then v_notice else null end,
      'billing',jsonb_build_object('amount_cents',NEW.amount_cents,'currency',NEW.currency,
        'due_day',NEW.due_day,'grace_days',NEW.grace_days,'late_fee_policy',
        coalesce(nullif(NEW.terms_snapshot->'late_fee_policy','null'::jsonb),
          case when NEW.late_fee_cents is null then '{"kind":"unknown"}'::jsonb else
            jsonb_build_object('kind','fixed','amount_cents',NEW.late_fee_cents,'currency',NEW.currency) end)),
      'manual_basis',NEW.manual_basis,'recorded_by',auth.uid(),'recorded_at',clock_timestamp());
  end if;
  return NEW;
end $$;
revoke all on function public._schedule_terms_snapshot_guard() from public,anon;
grant execute on function public._schedule_terms_snapshot_guard() to authenticated,service_role;
create trigger schedule_terms_snapshot_guard before insert or update on public.rent_schedules
for each row execute function public._schedule_terms_snapshot_guard();

create function public._charge_billing_basis_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_schedule public.rent_schedules;v_period jsonb;v_cycle text;v_grid date;
begin
  if TG_OP = 'UPDATE' then
    if (NEW.cycle_key,NEW.terms_snapshot) is distinct from (OLD.cycle_key,OLD.terms_snapshot)
    then raise exception 'invalid: charge billing basis is immutable'; end if;
    return NEW;
  end if;
  if NEW.source_schedule_id is null then
    if NEW.cycle_key is not null then raise exception 'invalid: manual charge cannot claim a scheduled cycle'; end if;
    return NEW;
  end if;
  select * into v_schedule from public.rent_schedules s where s.account_id = NEW.account_id
    and s.tenancy_id = NEW.tenancy_id and s.id = NEW.source_schedule_id and s.deleted_at is null;
  if not found then raise exception 'invalid: schedule must belong to charge tenancy'; end if;
  if v_schedule.period_policy_version = 1 then
    v_grid := date_trunc('month',NEW.due_date)::date+v_schedule.due_day-1;
    if v_grid > NEW.due_date then v_grid := (v_grid-interval '1 month')::date; end if;
    NEW.cycle_key := 'legacy:'||v_grid::text;
  else
    if NEW.period_start is null or NEW.period_end is null then raise exception 'invalid: scheduled charge requires both coverage dates'; end if;
    v_grid := date_trunc('month',NEW.period_start)::date;
    if extract(day from NEW.period_start) < extract(day from v_schedule.regular_anchor) then v_grid := (v_grid-interval '1 month')::date; end if;
    v_cycle := coalesce(NEW.cycle_key,to_char(v_grid,'YYYY-MM'));
    v_period := public._billing_period(public._schedule_billing_intent(v_schedule),v_cycle);
    if v_period is null or (v_period->>'needs_override')::boolean
      or (v_period->>'period_start')::date <> NEW.period_start or (v_period->>'period_end')::date <> NEW.period_end
      or (v_period->>'due_date')::date <> NEW.due_date or (v_period->>'amount_cents')::bigint <> NEW.amount_cents
      or v_schedule.currency <> NEW.currency
    then raise exception 'invalid: scheduled charge must match authoritative billing period'; end if;
    NEW.cycle_key := v_cycle;
  end if;
  NEW.terms_snapshot := case when v_schedule.period_policy_version = 1 then
    jsonb_build_object('version',1,'source','legacy_billing','agreement',null,'billing',
      jsonb_build_object('amount_cents',v_schedule.amount_cents,'currency',v_schedule.currency,'due_day',v_schedule.due_day,
        'grace_days',v_schedule.grace_days,'late_fee_policy',case when v_schedule.late_fee_cents is null
          then '{"kind":"unknown"}'::jsonb else jsonb_build_object('kind','fixed','amount_cents',v_schedule.late_fee_cents,'currency',v_schedule.currency) end))
    else v_schedule.terms_snapshot end;
  return NEW;
end $$;
revoke all on function public._charge_billing_basis_guard() from public,anon;
grant execute on function public._charge_billing_basis_guard() to authenticated,service_role;
create trigger charge_billing_basis_guard before insert or update on public.charges for each row execute function public._charge_billing_basis_guard();

create function public._period_override_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_schedule public.rent_schedules;v_period jsonb;v_rent jsonb;
begin
  if TG_OP <> 'INSERT' then raise exception 'invalid: billing period decisions are immutable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||NEW.tenancy_id::text,0));
  select * into v_schedule from public.rent_schedules where account_id = NEW.account_id
    and tenancy_id = NEW.tenancy_id and id = NEW.schedule_id and deleted_at is null;
  if not found or v_schedule.period_policy_version <> 2 then raise exception 'invalid: override needs a coverage-based schedule of the same tenancy'; end if;
  if exists(select 1 from public.charges where source_schedule_id = NEW.schedule_id and cycle_key = NEW.cycle_key)
  then raise exception 'conflict: scheduled cycle already has financial evidence'; end if;
  v_rent := public._schedule_billing_intent(v_schedule);
  v_rent := jsonb_set(v_rent,'{period_overrides}',jsonb_build_array(to_jsonb(NEW)));
  v_period := public._billing_period(v_rent,NEW.cycle_key);
  if v_period is null then raise exception 'invalid: override is outside schedule coverage'; end if;
  NEW.created_by := auth.uid();NEW.created_at := clock_timestamp();
  return NEW;
end $$;
revoke all on function public._period_override_guard() from public,anon;
grant execute on function public._period_override_guard() to authenticated,service_role;
create trigger period_override_guard before insert or update or delete on public.rent_schedule_period_overrides for each row execute function public._period_override_guard();

create or replace function public.generate_rent_charges(p_account_id uuid,p_as_of timestamptz)
returns table(o_charge_id uuid,o_schedule_id uuid,o_period_start date,o_amount_cents bigint)
language plpgsql security definer set search_path = public as $$
declare s public.rent_schedules;t public.tenancies;p jsonb;v_start date;v_cycle date;v_today date := (p_as_of at time zone 'UTC')::date;v_id uuid;v_i integer;
begin
  if not exists(select 1 from public.accounts where id = p_account_id and deleted_at is null and auto_charge_enabled) then return; end if;
  perform set_config('audit.actor','system:cron:rent',true);
  for s in select * from public.rent_schedules where account_id = p_account_id and deleted_at is null order by tenancy_id,id loop
    perform pg_advisory_xact_lock(hashtextextended('rent_change:'||s.tenancy_id::text,0));
    select * into s from public.rent_schedules where id = s.id and account_id = p_account_id and deleted_at is null;
    if not found then continue; end if;
    select * into t from public.tenancies where id = s.tenancy_id and account_id = p_account_id and deleted_at is null;
    if not found or public.effective_tenancy_status(t.status,t.start_date,v_today) = 'ended' then continue; end if;
    if s.period_policy_version = 1 then
      v_start := date_trunc('month',v_today)::date+s.due_day-1;
      if v_start < v_today then v_start := (v_start+interval '1 month')::date; end if;
      if s.start_date > v_start or (s.end_date is not null and s.end_date < v_start) then continue; end if;
      p := jsonb_build_object('period_start',v_start,'period_end',(v_start+interval '1 month'-interval '1 day')::date,
        'due_date',v_start,'amount_cents',s.amount_cents,'cycle_key','legacy:'||v_start::text);
    else
      p := null;
      for v_i in -1..1 loop
        v_cycle := (date_trunc('month',v_today)+make_interval(months=>v_i))::date;
        declare candidate jsonb;
        begin
          candidate := public._billing_period(public._schedule_billing_intent(s),to_char(v_cycle,'YYYY-MM'));
          if candidate is not null and not (candidate->>'needs_override')::boolean
            and (candidate->>'due_date')::date >= v_today
            and (p is null or (candidate->>'due_date')::date < (p->>'due_date')::date)
          then p := candidate; end if;
        end;
      end loop;
      if p is null then continue; end if;
      v_start := (p->>'period_start')::date;
    end if;
    if (p->>'amount_cents')::bigint = 0 or (t.status <> 'holdover' and t.end_date is not null and t.end_date < v_start) then continue; end if;
    insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,source_schedule_id,cycle_key)
    values(p_account_id,s.tenancy_id,case when s.kind = 'rent' then 'rent' else 'other' end,
      (p->>'amount_cents')::bigint,s.currency,(p->>'due_date')::date,v_start,(p->>'period_end')::date,s.id,p->>'cycle_key')
    on conflict do nothing returning id into v_id;
    if v_id is not null then
      o_charge_id := v_id;o_schedule_id := s.id;o_period_start := v_start;o_amount_cents := (p->>'amount_cents')::bigint;return next;
    end if;
  end loop;
end $$;
revoke all on function public.generate_rent_charges(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.generate_rent_charges(uuid,timestamptz) to service_role;
