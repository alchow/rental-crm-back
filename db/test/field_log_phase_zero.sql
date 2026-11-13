-- Field Log Phase 0 database checks: contact matching, ledger starting balances
-- and scheduled move-outs. Everything runs in one transaction and rolls back.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','phase-zero@example.test');
select set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}',true);
set local role authenticated;
select account_id from public.create_account_for_new_user('Phase zero','Test owner','America/Los_Angeles') \gset
select set_config('field_log.account_id', :'account_id', true);
reset role;
update public.accounts set person_match_enabled=false, opening_balance_ledger_enabled=true, scheduled_move_out_enabled=true,
  auto_charge_enabled=true where id=:'account_id';
insert into public.idempotency_keys(account_id,key,request_fingerprint,created_at)
  values (:'account_id','abandoned-setup','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',now()-interval '31 seconds');
set local role authenticated;

-- Shared fixtures: one property, an existing tenant, and a setup builder.
create function pg_temp.setup_payload(person uuid, start_on date, opening jsonb) returns jsonb
language sql as $$
  select jsonb_build_object(
    'people',jsonb_build_array(jsonb_build_object('key',person,'tenant_id',person)),
    'tenancy',jsonb_build_object('start_date',start_on),
    'agreement',jsonb_build_object('id',gen_random_uuid(),'change_kind','new','term_start',start_on,
      'rent_amount_cents',147500,'rent_currency','USD','deposit_amount_cents',0,'deposit_currency','USD',
      'rent_due_rule','{"kind":"day_of_month","day":1}'::jsonb,'grace_days',0,
      'late_fee_policy','{"kind":"none"}'::jsonb,'deposit_knowledge','unknown','terms_source','{"kind":"manual"}'::jsonb),
    'billing',jsonb_build_object(
      'rent',jsonb_build_object('decision','configure','coverage_start',date_trunc('month',now())::date,
        'regular_anchor',date_trunc('month',now())::date,'due_day',1,
        'billing_due_rule','{"kind":"day_of_month","day":1}'::jsonb,'short_month_policy','last_day',
        'amount_cents',147500,'currency','USD','grace_days',0,'late_fee_policy','{"kind":"none"}'::jsonb,
        'history_mode','opening_balance','charge_keys','[]'::jsonb,'opening_balance',opening),
      'deposit','{"decision":"defer"}'::jsonb,'payments','[]'::jsonb,'credit_allocations','[]'::jsonb,'explanations','[]'::jsonb),
    'receipt_purposes','{}'::jsonb,'warning_notes','{}'::jsonb)
$$;
-- Creates a door and a setup draft; returns the draft (and future tenancy) id.
create function pg_temp.new_draft(place uuid, label text) returns uuid
language plpgsql as $$
declare door uuid; draft uuid := gen_random_uuid();
begin
  insert into public.areas(account_id,property_id,kind,name)
    values(current_setting('field_log.account_id')::uuid,place,'unit',label) returning id into door;
  perform public.save_tenancy_setup_session(current_setting('field_log.account_id')::uuid,draft,door,null,0,'{"version":4}');
  return draft;
end;
$$;
create function pg_temp.commit_setup(draft uuid, setup jsonb) returns jsonb
language plpgsql as $$
declare account uuid := current_setting('field_log.account_id')::uuid; review jsonb; key text := 'setup-'||draft::text;
begin
  review := public.preview_tenancy_setup_session(account,draft,setup);
  if (review->>'can_confirm')::boolean is distinct from true then raise exception 'Setup review blocked: %',review; end if;
  perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
  return public.commit_tenancy_setup_session(account,draft,setup,review->>'setup_context',true,key,md5(key)||md5(key));
end;
$$;
create function pg_temp.end_request(tenancy uuid, payload jsonb) returns jsonb
language plpgsql as $$
declare account uuid := current_setting('field_log.account_id')::uuid; key text := 'end-'||gen_random_uuid()::text;
begin
  perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
  return public.record_tenancy_ending(account,tenancy,payload,key,md5(key)||md5(key));
end;
$$;
create function pg_temp.cancel_move_out(tenancy uuid, expected date) returns jsonb
language plpgsql as $$
declare account uuid := current_setting('field_log.account_id')::uuid; key text := 'cancel-'||gen_random_uuid()::text;
begin
  perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
  return public.cancel_scheduled_move_out(account,tenancy,expected,key,md5(key)||md5(key));
end;
$$;
-- Live rent for one tenancy as "period_start..period_end=amount" rows, oldest first.
create function pg_temp.live_rent(tenancy uuid) returns text
language sql as $$
  select coalesce(string_agg(period_start||'..'||period_end||'='||amount_cents, ' ' order by period_start),'')
  from public.charges where tenancy_id=tenancy and type='rent' and voided_at is null and deleted_at is null
$$;

do $test$
declare place uuid; person uuid;
begin
  insert into public.properties(account_id,name) values(current_setting('field_log.account_id')::uuid,'418 Juniper Avenue')
    returning id into place;
  insert into public.tenants(account_id,full_name,emails,phones)
    values(current_setting('field_log.account_id')::uuid,'Dana Whitfield',array['dana@example.test'],array['+15035550123'])
    returning id into person;
  perform set_config('field_log.place',place::text,true);
  perform set_config('field_log.person',person::text,true);
end;
$test$;

do $test$
begin
  if not (select claimed from public.claim_idempotency_key(
    current_setting('field_log.account_id')::uuid,'abandoned-setup',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',true
  )) then raise exception 'Setup could not reclaim its abandoned confirmation after 30 seconds'; end if;
  if public._account_date(current_setting('field_log.account_id')::uuid,'2026-12-01 07:59Z') <> '2026-11-30'
    or public._account_date(current_setting('field_log.account_id')::uuid,'2026-12-01 08:00Z') <> '2026-12-01' then
    raise exception 'Account timezone did not use local midnight';
  end if;
end;
$test$;

-- WP-01: duplicate-contact blocking follows person_match_enabled.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Contact door');
  setup jsonb := pg_temp.setup_payload(current_setting('field_log.person')::uuid,
    (date_trunc('month',now()) - interval '2 months')::date,'{"amount_cents":65000,"basis":"Rent","includes_current_rent":true}')
    || jsonb_build_object('people','[{"key":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","full_name":"Dana","emails":["DANA@example.test"]}]'::jsonb);
begin
  perform public.preview_tenancy_setup_session(account,draft,setup);
  perform set_config('field_log.contact_draft',draft::text,true);
end;
$test$;
reset role;
update public.accounts set person_match_enabled=true where id=:'account_id';
set local role authenticated;
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid;
begin
  begin
    perform public.preview_tenancy_setup_session(account,current_setting('field_log.contact_draft')::uuid,
      pg_temp.setup_payload(current_setting('field_log.person')::uuid,(date_trunc('month',now()) - interval '2 months')::date,
        '{"amount_cents":65000,"basis":"Rent","includes_current_rent":true}')
      || jsonb_build_object('people','[{"key":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","full_name":"Dana","emails":["DANA@example.test"]}]'::jsonb));
    raise exception 'Expected a contact conflict';
  exception when sqlstate 'PT409' then null;
  end;
end;
$test$;

-- WP-02: the current-month answer is required for an amount owed and refused for a credit.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Question door');
  start_on date := (date_trunc('month',now()) - interval '2 months')::date;
begin
  begin
    perform public.preview_tenancy_setup_session(account,draft,
      pg_temp.setup_payload(person,start_on,'{"amount_cents":65000,"basis":"Rent"}'));
    raise exception 'Owed starting balance did not require the current-month answer';
  exception when raise_exception then
    if sqlerrm not like 'invalid: say whether%' then raise; end if;
  end;
  begin
    perform public.preview_tenancy_setup_session(account,draft,
      pg_temp.setup_payload(person,start_on,'{"amount_cents":-65000,"basis":"Rent","includes_current_rent":true}'));
    raise exception 'Starting credit accepted the current-month answer';
  exception when raise_exception then
    if sqlerrm not like 'invalid: only an amount owed%' then raise; end if;
  end;
end;
$test$;

-- WP-02 and WP-03: setup scenarios, payment, scheduling, cancel and overlap.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  today date := public._account_date(account);
  month_start date := date_trunc('month',today)::date;
  draft uuid;
  outcome jsonb;
  rent_schedule uuid;
  charge uuid;
  balance record;
  plan_day date := (date_trunc('month',today)+interval '1 month')::date + 14;
  end_request jsonb;
  scenario integer;
  findings jsonb;
begin
  for scenario in 1..3 loop
    draft := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Door '||scenario);
    outcome := pg_temp.commit_setup(draft,pg_temp.setup_payload(person,(month_start - interval '2 months')::date,
      case scenario when 1 then '{"amount_cents":65000,"basis":"Rent","includes_current_rent":true}'::jsonb
        when 2 then '{"amount_cents":65000,"basis":"Rent","includes_current_rent":false}'::jsonb
        else '{"amount_cents":-65000,"basis":"Rent"}'::jsonb end));
    if (outcome->>'tenancy_id')::uuid is distinct from draft or not exists (
      select 1 from public.tenancy_tenants where tenancy_id=draft and tenant_id=person
    ) then raise exception 'Setup did not link the saved tenant: %',outcome; end if;

    select * into balance from public.rent_rollup(account,array['active'],today+1) where tenancy_id=draft;
    if scenario=3 then
      if balance.unapplied_credit_cents is distinct from 65000 or not exists (
        select 1 from public.payments where tenancy_id=draft and entry_source='opening_credit'
          and received_at is null and method is null
      ) or (select includes_current_rent from public.tenancy_adoptions where tenancy_id=draft) is not null
      then raise exception 'Starting credit was not available with setup provenance'; end if;
      continue;
    end if;
    select id into strict charge from public.charges where tenancy_id=draft and type='opening_balance'
      and amount_cents=65000 and opening_category='rent' and period_start is null;
    if (select count(*) from public.charges where tenancy_id=draft and type='rent') <> scenario - 1 then
      raise exception 'Setup used wrong current rent choice in case %',scenario;
    end if;
    if scenario=2 then
      outcome := pg_temp.end_request(draft,jsonb_build_object('kind','ended','effective_date',today,
        'initiated_by','tenant','reason_code','notice'));
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

    -- WP-23 rule: no late fee hangs off a starting balance.
    begin
      insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,parent_charge_id)
        values(account,draft,'late_fee',7500,'USD',today,charge);
      raise exception 'A late fee was parented on a starting balance';
    exception when check_violation then
      if sqlerrm not like 'invalid: a starting balance cannot take a late fee%' then raise; end if;
    end;

    -- A recorded starting balance is not reported as an unscheduled history overlap.
    findings := public.preview_billing_setup(account,draft,jsonb_build_object('operation','transition',
      'rent',jsonb_build_object('decision','configure','source_lease_id',outcome->>'lease_id',
        'coverage_start',(month_start+interval '1 month')::date,'regular_anchor',(month_start+interval '1 month')::date,
        'due_day',1,'billing_due_rule','{"kind":"day_of_month","day":1}'::jsonb,'short_month_policy','last_day',
        'amount_cents',147500,'currency','USD','grace_days',0,'late_fee_policy','{"kind":"none"}'::jsonb,
        'history_mode','itemized','charge_keys','[]'::jsonb),
      'deposit','{"decision":"keep"}'::jsonb,'payments','[]'::jsonb,'credit_allocations','[]'::jsonb,'explanations','[]'::jsonb))->'findings';
    if exists (select 1 from jsonb_array_elements(findings) f where f->>'rule_id' like '%manual_history_overlap%') then
      raise exception 'Starting balance was reported as a manual history overlap: %',findings;
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
    outcome := pg_temp.end_request(draft,end_request);
    if (outcome->'tenancy'->>'move_out_on')::date is distinct from plan_day
      or outcome->'tenancy'->>'status' is distinct from 'active'
      or outcome->'ending' is distinct from 'null'::jsonb
      or exists(select 1 from public.tenancy_endings where tenancy_id=draft) then
      raise exception 'Scheduling recorded an actual ending or changed occupancy: %',outcome;
    end if;
    if public._tenancy_status_on('active',month_start,plan_day,plan_day) <> 'active'
      or public._tenancy_status_on('active',month_start,plan_day,plan_day+1) <> 'ended' then
      raise exception 'Occupancy did not turn over after the last day';
    end if;
    begin
      insert into public.tenancies(account_id,area_id,start_date,status)
        values(account,(select area_id from public.tenancies where id=draft),plan_day,'upcoming');
      raise exception 'Overlapping tenancy was allowed';
    exception when raise_exception then
      if sqlerrm <> 'move_out_overlap' then raise; end if;
    end;
    outcome := pg_temp.cancel_move_out(draft,plan_day);
    if outcome->>'move_out_on' is not null or outcome->>'status' is distinct from 'active' then
      raise exception 'Cancel did not restore ongoing tenancy: %',outcome;
    end if;
    perform pg_temp.end_request(draft,end_request||jsonb_build_object('expected_move_out_on',null));
    insert into public.tenancies(account_id,area_id,start_date,status)
      values(account,(select area_id from public.tenancies where id=draft),plan_day+1,'upcoming');
    perform set_config('field_log.scheduled_tenancy',draft::text,true);
    perform set_config('field_log.scheduled_lease',outcome->>'lease_id',true);
    perform set_config('field_log.move_out_on',plan_day::text,true);
  end loop;
end;
$test$;

-- WP-03: a door with charges already generated past the move-out.
do $test$
declare
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Money door');
  planner uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Planner door');
  outcome jsonb;
begin
  perform pg_temp.commit_setup(draft,pg_temp.setup_payload(current_setting('field_log.person')::uuid,
    (date_trunc('month',now()) - interval '2 months')::date,'{"amount_cents":65000,"basis":"Rent","includes_current_rent":true}'));
  perform set_config('field_log.money_tenancy',draft::text,true);
  outcome := pg_temp.commit_setup(planner,pg_temp.setup_payload(current_setting('field_log.person')::uuid,
    (date_trunc('month',now()) - interval '2 months')::date,'{"amount_cents":65000,"basis":"Rent","includes_current_rent":true}'));
  perform set_config('field_log.planner_tenancy',planner::text,true);
  perform set_config('field_log.planner_lease',outcome->>'lease_id',true);
end;
$test$;
reset role;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  next_month date := (date_trunc('month',public._account_date(account))+interval '1 month')::date;
begin
  perform public.generate_rent_charges(account,next_month::timestamp at time zone 'America/Los_Angeles');
  perform public.generate_rent_charges(account,(next_month+1)::timestamp at time zone 'America/Los_Angeles');
end;
$test$;
set local role authenticated;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  tenancy uuid := current_setting('field_log.money_tenancy')::uuid;
  next_month date := (date_trunc('month',public._account_date(account))+interval '1 month')::date;
  after_month date := (next_month+interval '1 month')::date;
  month_end date := (after_month-1);
  expected text;
  rent_charge uuid;
begin
  expected := next_month||'..'||month_end||'=147500 '||after_month||'..'||((after_month+interval '1 month')::date-1)||'=147500';
  if pg_temp.live_rent(tenancy) <> expected then
    raise exception 'Fixture expected the next two months billed, got %',pg_temp.live_rent(tenancy);
  end if;

  perform pg_temp.end_request(tenancy,jsonb_build_object('kind','ended','effective_date',next_month+9,
    'initiated_by','tenant','reason_code','notice'));
  expected := next_month||'..'||(next_month+9)||'='||round(147500*10/(month_end-next_month+1)::numeric);
  if pg_temp.live_rent(tenancy) <> expected then
    raise exception 'Scheduling did not void later rent and prorate the final period: % (expected %)',pg_temp.live_rent(tenancy),expected;
  end if;
  if (select count(*) from public.charges where tenancy_id=tenancy and type='rent' and void_reason='Scheduled move-out changed this period') <> 2 then
    raise exception 'Superseded rent was not voided with a reason';
  end if;

  perform pg_temp.end_request(tenancy,jsonb_build_object('kind','ended','effective_date',next_month+19,
    'initiated_by','tenant','reason_code','notice','expected_move_out_on',next_month+9));
  expected := next_month||'..'||(next_month+19)||'='||round(147500*20/(month_end-next_month+1)::numeric);
  if pg_temp.live_rent(tenancy) <> expected then
    raise exception 'Changing the date did not re-prorate the final period: %',pg_temp.live_rent(tenancy);
  end if;

  perform pg_temp.cancel_move_out(tenancy,next_month+19);
  expected := next_month||'..'||month_end||'=147500 '||after_month||'..'||((after_month+interval '1 month')::date-1)||'=147500';
  if pg_temp.live_rent(tenancy) <> expected then
    raise exception 'Cancelling did not restore the full rent: %',pg_temp.live_rent(tenancy);
  end if;

  select id into strict rent_charge from public.charges where tenancy_id=tenancy and type='rent'
    and voided_at is null and period_start=next_month;
  perform public.create_payment_with_allocations(account,tenancy,50000,'USD',now(),'check',null,null,null,
    jsonb_build_array(jsonb_build_object('charge_id',rent_charge,'amount_cents',50000)));
  begin
    perform pg_temp.end_request(tenancy,jsonb_build_object('kind','ended','effective_date',next_month+9,
      'initiated_by','tenant','reason_code','notice'));
    raise exception 'Scheduling silently changed rent that a payment covers';
  exception when raise_exception then
    if sqlerrm not like 'move_out_changed: a payment or fee%' then raise; end if;
  end;
  if pg_temp.live_rent(tenancy) <> expected or (select move_out_on from public.tenancies where id=tenancy) is not null then
    raise exception 'A refused move-out changed money or the tenancy';
  end if;
end;
$test$;
reset role;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  tenancy uuid := current_setting('field_log.money_tenancy')::uuid;
  next_month date := (date_trunc('month',public._account_date(account))+interval '1 month')::date;
begin
  perform public.generate_rent_charges(account,(next_month+interval '1 month')::timestamp at time zone 'America/Los_Angeles' + interval '1 day');
  if (select count(*) from public.charges where tenancy_id=tenancy and type='rent' and voided_at is null) <> 3
    or exists (select period_start from public.charges where tenancy_id=tenancy and type='rent' and voided_at is null
      group by period_start having count(*) > 1) then
    raise exception 'Generator duplicated restored rent: %',pg_temp.live_rent(tenancy);
  end if;
end;
$test$;

-- WP-03: the planner and the charge guard agree on a final partial period.
set local role authenticated;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  draft uuid := current_setting('field_log.planner_tenancy')::uuid;
  next_month date := (date_trunc('month',public._account_date(account))+interval '1 month')::date;
  intent jsonb;
  review jsonb;
  key text := 'transition-'||gen_random_uuid()::text;
  candidate jsonb;
begin
  perform pg_temp.end_request(draft,jsonb_build_object('kind','ended','effective_date',next_month+9,
    'initiated_by','tenant','reason_code','notice'));
  if not exists (select 1 from public.charges where tenancy_id=draft and replaces_charge_id is not null and voided_at is null) then
    raise exception 'Planner fixture has no move-out replacement charge: %',pg_temp.live_rent(draft);
  end if;
  intent := jsonb_build_object('operation','transition',
    'rent',jsonb_build_object('decision','configure','source_lease_id',current_setting('field_log.planner_lease'),
      'coverage_start',next_month,'regular_anchor',next_month,'due_day',1,
      'billing_due_rule','{"kind":"day_of_month","day":1}'::jsonb,'short_month_policy','last_day',
      'amount_cents',160000,'currency','USD','grace_days',0,'late_fee_policy','{"kind":"none"}'::jsonb,
      'history_mode','itemized','charge_keys',jsonb_build_array(jsonb_build_object('cycle_key',to_char(next_month,'YYYY-MM'),'draft_key','final'))),
    'deposit','{"decision":"keep"}'::jsonb,'payments','[]'::jsonb,'credit_allocations','[]'::jsonb,'explanations','[]'::jsonb);
  review := public.preview_billing_setup(account,draft,intent);
  select value into candidate from jsonb_array_elements(review->'charge_candidates') where value->>'draft_key'='final';
  if (candidate->>'period_end')::date is distinct from next_month+9
    or (candidate->>'amount_cents')::bigint is distinct from round(160000*10/((next_month+interval '1 month')::date-next_month)::numeric) then
    raise exception 'Planner ignored the scheduled move-out: %',candidate;
  end if;
  intent := intent || jsonb_build_object(
    'explanations',(select coalesce(jsonb_agg(jsonb_build_object('rule_id',f->>'rule_id','reason','Rent increase agreed')),'[]')
      from jsonb_array_elements(review->'findings') f
      where f->>'severity'='review' and not coalesce((f->>'confirmation_required')::boolean,false)),
    'warning_acknowledgements',(select coalesce(jsonb_agg(jsonb_build_object('relationship_fingerprint',f->'relationship_fingerprint')),'[]')
      from jsonb_array_elements(review->'findings') f where coalesce((f->>'confirmation_required')::boolean,false)));
  review := public.preview_billing_setup(account,draft,intent);
  if not (review->>'can_commit')::boolean then raise exception 'Transition fixture blocked: %',review->'findings'; end if;
  perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
  perform public.commit_billing_setup(account,draft,intent||jsonb_build_object('expected_context',review->'context_fingerprint'),key,md5(key)||md5(key));
  if pg_temp.live_rent(draft) <> next_month||'..'||(next_month+9)||'='||(candidate->>'amount_cents') then
    raise exception 'Transition left the old final period live or billed it wrongly: %',pg_temp.live_rent(draft);
  end if;
end;
$test$;

-- WP-03: scheduling uses effective status, not a not-yet-advanced stored status.
reset role;
set constraints all immediate;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  door uuid;
  tenancy uuid;
  today date := public._account_date(account);
begin
  insert into public.areas(account_id,property_id,kind,name)
    values(account,current_setting('field_log.place')::uuid,'unit','Waiting door') returning id into door;
  insert into public.tenancies(account_id,area_id,start_date,status) values(account,door,today+5,'upcoming') returning id into tenancy;
  alter table public.tenancies disable trigger tenancies_lifecycle;
  alter table public.tenancies disable trigger tenancies_date_command_guard;
  update public.tenancies set start_date=today-5 where id=tenancy;
  alter table public.tenancies enable trigger tenancies_lifecycle;
  alter table public.tenancies enable trigger tenancies_date_command_guard;
  perform set_config('field_log.waiting_tenancy',tenancy::text,true);
end;
$test$;
set local role authenticated;
do $test$
declare tenancy uuid := current_setting('field_log.waiting_tenancy')::uuid; outcome jsonb;
begin
  outcome := pg_temp.end_request(tenancy,jsonb_build_object('kind','ended',
    'effective_date',public._account_date(current_setting('field_log.account_id')::uuid)+30,
    'initiated_by','tenant','reason_code','notice'));
  if outcome->'tenancy'->>'move_out_on' is null then raise exception 'Started tenancy could not schedule a move-out: %',outcome; end if;
end;
$test$;

-- WP-03: after the last day, readers treat the tenancy as ended without a job.
reset role;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  tenancy uuid := current_setting('field_log.scheduled_tenancy')::uuid;
  last_day date := current_setting('field_log.move_out_on')::date;
  final_month date := date_trunc('month',last_day)::date;
begin
  perform public.generate_rent_charges(account,(final_month-interval '1 month')::timestamp at time zone 'America/Los_Angeles');
  if exists(select 1 from public.charges where tenancy_id=tenancy and type='rent' and voided_at is null and period_start<final_month) then
    raise exception 'Included current rent was generated again';
  end if;
  perform public.generate_rent_charges(account,final_month::timestamp at time zone 'America/Los_Angeles');
  perform public.generate_rent_charges(account,final_month::timestamp at time zone 'America/Los_Angeles');
  perform public.generate_rent_charges(account,(last_day+1)::timestamp at time zone 'America/Los_Angeles');
  if (select count(*) from public.charges where tenancy_id=tenancy and type='rent' and voided_at is null and period_start>=final_month) <> 1
    or not exists(select 1 from public.charges where tenancy_id=tenancy and type='rent' and voided_at is null
      and period_start=final_month and period_end=last_day and amount_cents=70000) then
    raise exception 'Final period was re-billed, generated after move-out or did not use adjusted rent: %',pg_temp.live_rent(tenancy);
  end if;
  set local role tenancy_date_writer;
  update public.tenancies set move_out_on=public._account_date(account)-1 where id=tenancy;
  reset role;
end;
$test$;
set local role authenticated;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  tenancy uuid := current_setting('field_log.scheduled_tenancy')::uuid;
  row public.tenancy_current;
begin
  select * into strict row from public.tenancy_current where id=tenancy;
  if row.status <> 'ended' or row.end_date is distinct from row.move_out_on
    or (select status from public.tenancies where id=tenancy) <> 'active' then
    raise exception 'Passed move-out did not read as ended: %',to_jsonb(row);
  end if;
  if public.get_tenancy_onboarding_progress(account,tenancy)->>'effective_status' <> 'ended'
    or public.get_tenancy_date_context(account,tenancy)->'facts'->>'status' <> 'ended' then
    raise exception 'Date context or progress still reads the tenancy as active';
  end if;
  begin
    perform pg_temp.end_request(tenancy,jsonb_build_object('kind','ended','effective_date',row.move_out_on,
      'initiated_by','tenant','reason_code','notice','expected_move_out_on',row.move_out_on));
    raise exception 'A passed move-out was ended again';
  exception when raise_exception then
    if sqlerrm <> 'conflict: tenancy already ended' then raise; end if;
  end;
  begin
    perform pg_temp.cancel_move_out(tenancy,row.move_out_on);
    raise exception 'A passed move-out was cancelled';
  exception when raise_exception then
    if sqlerrm <> 'move_out_changed' then raise; end if;
  end;
  begin
    perform public.preview_billing_setup(account,tenancy,jsonb_build_object('operation','transition',
      'rent',jsonb_build_object('decision','configure','source_lease_id',current_setting('field_log.scheduled_lease'),
        'coverage_start',row.account_date,'regular_anchor',row.account_date,'due_day',1,
        'amount_cents',147500,'currency','USD','history_mode','itemized','charge_keys','[]'::jsonb),
      'deposit','{"decision":"keep"}'::jsonb));
    raise exception 'Billing setup reopened a moved-out tenancy';
  exception when raise_exception then
    if sqlerrm not like 'conflict: recurring setup cannot reopen%' then raise; end if;
  end;
end;
$test$;

rollback;
