\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','phase-zero@example.test');
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}',true);
set local role authenticated;
select account_id from public.create_account_for_new_user('Phase zero','Test owner','America/Los_Angeles') \gset
select set_config('field_log.account_id', :'account_id', true);
reset role;
update public.accounts set person_match_enabled=true, opening_balance_ledger_enabled=true, scheduled_move_out_enabled=true,
  auto_charge_enabled=true where id=:'account_id';
insert into public.idempotency_keys(account_id,key,request_fingerprint,created_at)
  values (:'account_id','abandoned-setup','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',now()-interval '31 seconds');
set local role authenticated;
do $test$
begin
  if not (select claimed from public.claim_idempotency_key(
    current_setting('field_log.account_id')::uuid,'abandoned-setup',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',true
  )) then raise exception 'Setup could not reclaim its abandoned confirmation after 30 seconds'; end if;
end;
$test$;

do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  today date := public._account_date(account);
  month_start date := date_trunc('month',today)::date;
  place uuid;
  door uuid;
  person uuid;
  draft uuid;
  setup jsonb;
  review jsonb;
  outcome jsonb;
  rent_schedule uuid;
  charge uuid;
  balance record;
  plan_day date := (date_trunc('month',today)+interval '1 month')::date + 14;
  end_request jsonb;
  key text;
  scenario integer;
begin
  if public._account_date(account,'2026-12-01 07:59Z') <> '2026-11-30'
    or public._account_date(account,'2026-12-01 08:00Z') <> '2026-12-01' then
    raise exception 'Account timezone did not use local midnight';
  end if;

  insert into public.properties(account_id,name) values(account,'418 Juniper Avenue') returning id into place;
  insert into public.tenants(account_id,full_name,emails,phones)
    values(account,'Dana Whitfield',array['dana@example.test'],array['+15035550123']) returning id into person;

  for scenario in 1..3 loop
    draft := gen_random_uuid();
    key := 'setup-'||draft::text;
    insert into public.areas(account_id,property_id,kind,name)
      values(account,place,'unit','Door '||scenario) returning id into door;
    perform public.save_tenancy_setup_session(account,draft,door,null,0,'{"version":4}');
    setup := jsonb_build_object(
      'people',jsonb_build_array(jsonb_build_object('key',person,'tenant_id',person)),
      'tenancy',jsonb_build_object('start_date',month_start - interval '2 months'),
      'agreement',jsonb_build_object('id',gen_random_uuid(),'change_kind','new',
        'term_start',(month_start - interval '2 months')::date,
        'rent_amount_cents',147500,'rent_currency','USD','deposit_amount_cents',0,'deposit_currency','USD',
        'rent_due_rule','{"kind":"day_of_month","day":1}'::jsonb,'grace_days',0,
        'late_fee_policy','{"kind":"none"}'::jsonb,'deposit_knowledge','unknown','terms_source','{"kind":"manual"}'::jsonb),
      'billing',jsonb_build_object(
        'rent',jsonb_build_object('decision','configure','coverage_start',month_start,'regular_anchor',month_start,
          'due_day',1,'billing_due_rule','{"kind":"day_of_month","day":1}'::jsonb,'short_month_policy','last_day',
          'amount_cents',147500,'currency','USD','grace_days',0,'late_fee_policy','{"kind":"none"}'::jsonb,
          'history_mode','opening_balance','charge_keys','[]'::jsonb,
          'opening_balance',jsonb_build_object('amount_cents',case when scenario=3 then -65000 else 65000 end,
            'basis','Rent','includes_current_rent',scenario<>2)),
        'deposit','{"decision":"defer"}'::jsonb,'payments','[]'::jsonb,'credit_allocations','[]'::jsonb,'explanations','[]'::jsonb),
      'receipt_purposes','{}'::jsonb,'warning_notes','{}'::jsonb);
    if scenario=1 then
      begin
        perform public.preview_tenancy_setup_session(account,draft,setup||jsonb_build_object(
          'people','[{"full_name":"Dana","emails":["DANA@example.test"]}]'::jsonb));
        raise exception 'Expected a contact conflict';
      exception when sqlstate 'PT409' then null;
      end;
    end if;
    review := public.preview_tenancy_setup_session(account,draft,setup);
    if (review->>'can_confirm')::boolean is distinct from true then
      raise exception 'Setup review blocked case %: %',scenario,review;
    end if;
    perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
    outcome := public.commit_tenancy_setup_session(account,draft,setup,review->>'setup_context',true,key,md5(key)||md5(key));
    if (outcome->>'tenancy_id')::uuid is distinct from draft or not exists (
      select 1 from public.tenancy_tenants where tenancy_id=draft and tenant_id=person
    ) then raise exception 'Setup did not link the saved tenant: %',outcome; end if;

    select * into balance from public.rent_rollup(account,array['active'],today+1) where tenancy_id=draft;
    if scenario=3 then
      if balance.unapplied_credit_cents is distinct from 65000 or not exists (
        select 1 from public.payments where tenancy_id=draft and entry_source='opening_credit'
          and received_at is null and method is null
      ) then raise exception 'Starting credit was not available with setup provenance'; end if;
      continue;
    end if;
    select id into strict charge from public.charges where tenancy_id=draft and type='opening_balance'
      and amount_cents=65000 and opening_category='rent' and period_start is null;
    if (select count(*) from public.charges where tenancy_id=draft and type='rent') <> scenario - 1 then
      raise exception 'Setup used wrong current rent choice in case %',scenario;
    end if;
    if scenario=2 then
      key := 'end-today-'||draft::text;
      perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
      outcome := public.record_tenancy_ending(account,draft,jsonb_build_object(
        'kind','ended','effective_date',today,'initiated_by','tenant','reason_code','notice'
      ),key,md5(key)||md5(key));
      if outcome->'tenancy'->>'status' is distinct from 'ended'
        or outcome->'ending'->>'effective_date' is distinct from today::text then
        raise exception 'Ending today did not record the actual ending: %',outcome;
      end if;
      continue;
    end if;
    if balance.rent_balance_cents is distinct from 65000
      or balance.non_deposit_overdue_cents is distinct from 0
      or (balance.currency_totals->0->>'opening_owed_cents')::bigint is distinct from 65000 then
      raise exception 'Opening debt did not appear as payable: %',balance;
    end if;
    perform public.create_payment_with_allocations(account,draft,65000,'USD',now(),'check',null,person,null,
      jsonb_build_array(jsonb_build_object('charge_id',charge,'amount_cents',65000)));
    select * into balance from public.rent_rollup(account,array['active'],today+1) where tenancy_id=draft;
    if balance.rent_balance_cents is distinct from 0 then
      raise exception 'Payment did not clear the opening balance: %',balance;
    end if;

    select id into strict rent_schedule from public.rent_schedules where tenancy_id=draft and kind='rent';
    end_request := jsonb_build_object('kind','ended','effective_date',plan_day,
      'initiated_by','tenant','reason_code','notice','final_rent_schedule_id',rent_schedule,'final_rent_amount_cents',70000);
    if public.preview_tenancy_ending(account,draft,end_request)->'findings' <> '[]'::jsonb then
      raise exception 'Scheduled move-out requested a second confirmation';
    end if;
    key := 'schedule-'||draft::text;
    perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
    outcome := public.record_tenancy_ending(account,draft,end_request,key,md5(key)||md5(key));
    if (outcome->'tenancy'->>'move_out_on')::date is distinct from plan_day
      or outcome->'tenancy'->>'status' is distinct from 'active'
      or outcome->'ending' is distinct from 'null'::jsonb
      or exists(select 1 from public.tenancy_endings where tenancy_id=draft) then
      raise exception 'Scheduling recorded an actual ending or changed occupancy: %',outcome;
    end if;
    if public.record_tenancy_ending(account,draft,end_request,key,md5(key)||md5(key)) is distinct from outcome then
      raise exception 'Move-out retry did not replay the saved result';
    end if;
    if public._tenancy_status_on('active',month_start,plan_day,plan_day) <> 'active'
      or public._tenancy_status_on('active',month_start,plan_day,plan_day+1) <> 'ended' then
      raise exception 'Occupancy did not turn over after the last day';
    end if;
    begin
      insert into public.tenancies(account_id,area_id,start_date,status) values(account,door,plan_day,'upcoming');
      raise exception 'Overlapping tenancy was allowed';
    exception when raise_exception then
      if sqlerrm <> 'move_out_overlap' then raise; end if;
    end;
    key := 'cancel-'||draft::text;
    perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
    outcome := public.cancel_scheduled_move_out(account,draft,plan_day,key,md5(key)||md5(key));
    if outcome->>'move_out_on' is not null or outcome->>'status' is distinct from 'active' then
      raise exception 'Cancel did not restore ongoing tenancy: %',outcome;
    end if;
    key := 'reschedule-'||draft::text;
    perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
    perform public.record_tenancy_ending(account,draft,end_request,key,md5(key)||md5(key));
    insert into public.tenancies(account_id,area_id,start_date,status) values(account,door,plan_day+1,'upcoming');
    perform set_config('field_log.scheduled_tenancy',draft::text,true);
    perform set_config('field_log.move_out_on',plan_day::text,true);
  end loop;
end;
$test$;

reset role;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  tenancy uuid := current_setting('field_log.scheduled_tenancy')::uuid;
  last_day date := current_setting('field_log.move_out_on')::date;
  final_month date := date_trunc('month',last_day)::date;
begin
  perform public.generate_rent_charges(account,(final_month-interval '1 month')::timestamp at time zone 'America/Los_Angeles');
  if exists(select 1 from public.charges where tenancy_id=tenancy and type='rent') then
    raise exception 'Included current rent was generated again';
  end if;
  perform public.generate_rent_charges(account,final_month::timestamp at time zone 'America/Los_Angeles');
  perform public.generate_rent_charges(account,final_month::timestamp at time zone 'America/Los_Angeles');
  perform public.generate_rent_charges(account,(last_day+1)::timestamp at time zone 'America/Los_Angeles');
  if (select count(*) from public.charges where tenancy_id=tenancy and type='rent') <> 1
    or not exists(select 1 from public.charges where tenancy_id=tenancy and type='rent'
      and period_start=final_month and period_end=last_day and amount_cents=70000) then
    raise exception 'Final period was re-billed, generated after move-out or did not use adjusted rent';
  end if;
end;
$test$;

rollback;
