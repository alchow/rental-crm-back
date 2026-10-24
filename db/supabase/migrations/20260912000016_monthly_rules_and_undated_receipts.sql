begin;

alter table public.rent_schedules add column billing_due_rule jsonb;
alter table public.rent_schedules add column short_month_policy text;
alter table public.rent_schedules drop constraint rent_schedules_due_day_check;
alter table public.rent_schedules add constraint rent_schedules_due_day_check check (
  due_day between 1 and 31 and (period_policy_version = 3 or due_day <= 28));
alter table public.rent_schedules drop constraint rent_schedules_grace_days_check;
alter table public.rent_schedules add constraint rent_schedules_grace_days_check check (grace_days >= 0);
alter table public.rent_schedules drop constraint rent_schedules_period_policy_version_check;
alter table public.rent_schedules add constraint rent_schedules_period_policy_version_check check (period_policy_version in (1,2,3));
alter table public.rent_schedules add constraint rent_schedules_due_rule_check check (
  (billing_due_rule is null and short_month_policy is null) or
  (period_policy_version = 3 and public._valid_recorded_term(billing_due_rule,true)
    and billing_due_rule->>'kind' in ('day_of_month','last_day')
    and short_month_policy in ('last_day','manual')));

create or replace function public._billing_period(p_rent jsonb,p_cycle_key text) returns jsonb
language plpgsql immutable set search_path=public as $$
declare m date;regular date;start_on date;end_on date;full_end date;override jsonb;due_on date;
  day_no integer;last_no integer;rule jsonb;missing_day boolean:=false;
begin
  if p_cycle_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'invalid: invalid cycle key';end if;
  m:=(p_cycle_key||'-01')::date;
  regular:=m+extract(day from (p_rent->>'regular_anchor')::date)::integer-1;
  full_end:=(regular+interval '1 month'-interval '1 day')::date;
  start_on:=greatest(regular,(p_rent->>'coverage_start')::date);
  end_on:=least(full_end,coalesce((p_rent->>'coverage_end')::date,full_end));
  if start_on>end_on then return null;end if;
  rule:=coalesce(nullif(p_rent->'billing_due_rule','null'),jsonb_build_object('kind','day_of_month','day',(p_rent->>'due_day')::integer));
  last_no:=extract(day from (m+interval '1 month'-interval '1 day'))::integer;
  day_no:=case when rule->>'kind'='last_day' then last_no else (rule->>'day')::integer end;
  if day_no not between 1 and 31 then raise exception 'invalid: unsupported monthly due rule';end if;
  missing_day:=day_no>last_no and coalesce(p_rent->>'short_month_policy','manual')='manual';
  due_on:=m+least(day_no,last_no)-1;
  select value into override from jsonb_array_elements(coalesce(p_rent->'period_overrides','[]')) where value->>'cycle_key'=p_cycle_key;
  if override is not null then
    if (override->>'period_start')::date<>start_on or (override->>'period_end')::date<>end_on
      or (override->>'amount_cents')::bigint<0 or length(btrim(coalesce(override->>'reason',''))) not between 1 and 2000
    then raise exception 'invalid: override must match exact schedule coverage and record amount and reason';end if;
    due_on:=(override->>'due_date')::date;
  end if;
  return jsonb_build_object('cycle_key',p_cycle_key,'type','rent','period_start',start_on,'period_end',end_on,
    'due_date',due_on,'amount_cents',coalesce((override->>'amount_cents')::bigint,(p_rent->>'amount_cents')::bigint),
    'currency',p_rent->>'currency','reason',override->>'reason',
    'needs_override',(start_on<>regular or end_on<>full_end or missing_day) and override is null);
end $$;
revoke all on function public._billing_period(jsonb,text) from public,anon;
grant execute on function public._billing_period(jsonb,text) to authenticated,service_role,tenancy_date_writer;

alter table public.payments alter column received_at drop not null;
alter table public.payments add column receipt_date_unknown boolean not null default false;
alter table public.payments add column entry_source text not null default 'manual';
alter table public.payments add constraint payments_receipt_date_knowledge check ((received_at is null)=receipt_date_unknown);
alter table public.payments add constraint payments_entry_source check (entry_source in ('manual','entered_at_setup','import'));
alter table public.tenancy_tenants add column on_lease boolean;

create table public.account_rent_defaults (
  id uuid not null default gen_random_uuid() unique,
  account_id uuid primary key references public.accounts(id),
  grace_days integer check (grace_days>=0),
  late_fee_policy jsonb not null default '{"kind":"unknown"}' check (public._valid_recorded_term(late_fee_policy,false)),
  updated_at timestamptz not null default now()
);
alter table public.account_rent_defaults enable row level security;
alter table public.account_rent_defaults force row level security;
create policy account_rent_defaults_read on public.account_rent_defaults for select to authenticated using(public.is_account_member(account_id));
create policy account_rent_defaults_write on public.account_rent_defaults for all to authenticated
  using(exists(select 1 from public.account_members m where m.account_id=account_rent_defaults.account_id and m.user_id=auth.uid() and m.deleted_at is null and m.role in ('owner','manager')))
  with check(exists(select 1 from public.account_members m where m.account_id=account_rent_defaults.account_id and m.user_id=auth.uid() and m.deleted_at is null and m.role in ('owner','manager')));
grant select,insert,update on public.account_rent_defaults to authenticated;
grant all on public.account_rent_defaults to service_role;
create trigger account_rent_defaults_audit after insert or update or delete on public.account_rent_defaults for each row execute function public._emit_event();

do $migration$
declare body text;old text;new text;
begin
  select pg_get_functiondef('public._schedule_billing_intent(public.rent_schedules)'::regprocedure) into body;
  execute replace(body,'''regular_anchor'',p_schedule.regular_anchor,','''billing_due_rule'',p_schedule.billing_due_rule,''short_month_policy'',p_schedule.short_month_policy,''regular_anchor'',p_schedule.regular_anchor,');
  select pg_get_functiondef('public._schedule_terms_snapshot_guard()'::regprocedure) into body;
  body:=replace(body,'NEW.period_policy_version,NEW.regular_anchor','NEW.billing_due_rule,NEW.short_month_policy,NEW.period_policy_version,NEW.regular_anchor');
  body:=replace(body,'OLD.period_policy_version,OLD.regular_anchor','OLD.billing_due_rule,OLD.short_month_policy,OLD.period_policy_version,OLD.regular_anchor');
  body:=replace(body,'OLD.period_policy_version = 2','OLD.period_policy_version >= 2');
  body:=replace(body,'NEW.period_policy_version = 2','NEW.period_policy_version >= 2');
  execute replace(body,'''due_day'',NEW.due_day,','''billing_due_rule'',NEW.billing_due_rule,''short_month_policy'',NEW.short_month_policy,''due_day'',NEW.due_day,');
  select pg_get_functiondef('public._period_override_guard()'::regprocedure) into body;
  execute replace(body,'v_schedule.period_policy_version <> 2','v_schedule.period_policy_version < 2');
  select pg_get_functiondef('public.preview_billing_setup(uuid,uuid,jsonb)'::regprocedure) into body;
  body:=replace(body,'''grace_days'',''late_fee_policy'',''manual_basis''','''grace_days'',''late_fee_policy'',''billing_due_rule'',''short_month_policy'',''manual_basis''');
  body:=replace(body,'(r->>''due_day'')::integer not between 1 and 28','(r->>''due_day'')::integer not between 1 and 31');
  body:=replace(body,'(r->>''grace_days'')::integer not between 0 and 30','(r->>''grace_days'')::integer < 0');
  old:=E'      if l.rent_due_rule->>''kind'' not in (''unknown'',''day_of_month'') or (l.rent_due_rule->>''day'')::integer > 28\n      then raise exception ''invalid: selected agreement due rule requires manual billing''; end if;';
  new:=E'      if coalesce(r->''billing_due_rule'',jsonb_build_object(''kind'',''day_of_month'',''day'',(r->>''due_day'')::integer))->>''kind'' not in (''day_of_month'',''last_day'') then raise exception ''invalid: confirm a calculable monthly due rule''; end if;';
  assert position(old in body)>0,'billing due rule guard changed';body:=replace(body,old,new);
  body:=replace(body,'(l.rent_due_rule->>''kind'' = ''day_of_month'' and (l.rent_due_rule->>''day'')::integer <> (r->>''due_day'')::integer)',
    '(l.rent_due_rule->>''kind'' <> ''unknown'' and l.rent_due_rule is distinct from coalesce(r->''billing_due_rule'',jsonb_build_object(''kind'',''day_of_month'',''day'',(r->>''due_day'')::integer)))');
  body:=replace(body,'''billing_outside_agreement'',''billing_outside_possession''','''billing_outside_agreement'',''billing_outside_possession'',''billing_terms_differ''');
  body:=replace(body,'or length(coalesce(v_elem->>''currency'','''')) <> 3 or v_elem->>''received_at'' is null',
    'or length(coalesce(v_elem->>''currency'','''')) <> 3 or ((v_elem->>''received_at'' is null) <> coalesce((v_elem->>''receipt_date_unknown'')::boolean,false))');
  body:=replace(body,'''method'',''reference'',''notes'',''allocations'']','''method'',''reference'',''notes'',''allocations'',''receipt_date_unknown'',''entry_source'']');
  execute body;
  select pg_get_functiondef('public.commit_billing_setup(uuid,uuid,jsonb,text,text)'::regprocedure) into body;
  body:=replace(body,'regular_anchor,terms_snapshot,manual_basis)','regular_anchor,terms_snapshot,manual_basis,billing_due_rule,short_month_policy)');
  body:=replace(body,'else null end,2,(r->>''regular_anchor'')::date,','else null end,case when r?''billing_due_rule'' or (r->>''due_day'')::integer>28 then 3 else 2 end,(r->>''regular_anchor'')::date,');
  body:=replace(body,'r->>''manual_basis'') returning id into v_schedule_id;', 'r->>''manual_basis'',r->''billing_due_rule'',case when r?''billing_due_rule'' then coalesce(r->>''short_month_policy'',''last_day'') else null end) returning id into v_schedule_id;');
  body:=replace(body,'received_at,method,reference,notes)','received_at,method,reference,notes,receipt_date_unknown,entry_source)');
  body:=replace(body,'e->>''method'',e->>''reference'',e->>''notes'') returning id into v_payment;',
    'e->>''method'',e->>''reference'',e->>''notes'',coalesce((e->>''receipt_date_unknown'')::boolean,false),coalesce(e->>''entry_source'',''manual'')) returning id into v_payment;');
  execute body;
  select pg_get_functiondef('public._receipt_date_warning(uuid,uuid,jsonb,text)'::regprocedure) into body;
  execute replace(body,'if entered<=today then','if entered is null or entered<=today then');
end $migration$;

notify pgrst,'reload schema';
commit;
