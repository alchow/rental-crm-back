-- Field Log Phase 1 database checks: people matching, billing that follows the lease,
-- percent late fees, proration method, an amount owed from before itemized months,
-- and future rent steps. Everything runs in one transaction and rolls back.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values ('dddddddd-dddd-dddd-dddd-dddddddddddd','phase-one@example.test');
select set_config('request.jwt.claims','{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}',true);
set local role authenticated;
select account_id from public.create_account_for_new_user('Phase one','Test owner','America/Los_Angeles') \gset
select set_config('field_log.account_id', :'account_id', true);
reset role;
update public.accounts set opening_balance_ledger_enabled=true, scheduled_move_out_enabled=true,
  auto_charge_enabled=true where id=:'account_id';
set local role authenticated;

-- billing: the rent intent; start_on: lease and possession start.
create function pg_temp.setup(person uuid, start_on date, rent jsonb, payments jsonb default '[]') returns jsonb
language sql as $$
  select jsonb_build_object(
    'people',jsonb_build_array(jsonb_build_object('key',person,'tenant_id',person)),
    'tenancy',jsonb_build_object('start_date',start_on),
    'agreement',jsonb_build_object('id',gen_random_uuid(),'change_kind','new','term_start',start_on,
      'rent_amount_cents',147500,'rent_currency','USD','deposit_amount_cents',0,'deposit_currency','USD',
      'rent_due_rule','{"kind":"day_of_month","day":1}'::jsonb,'grace_days',5,
      'late_fee_policy','{"kind":"percent","percent":5}'::jsonb,'deposit_knowledge','unknown','terms_source','{"kind":"manual"}'::jsonb),
    'billing',jsonb_build_object(
      'rent',jsonb_build_object('decision','configure','coverage_start',start_on,'regular_anchor',start_on,'due_day',1,
        'billing_due_rule','{"kind":"day_of_month","day":1}'::jsonb,'short_month_policy','last_day',
        'amount_cents',147500,'currency','USD','grace_days',5,'late_fee_policy','{"kind":"percent","percent":5}'::jsonb,
        'history_mode','itemized','charge_keys','[]'::jsonb)||rent,
      'deposit','{"decision":"defer"}'::jsonb,'payments',payments,'credit_allocations','[]'::jsonb,'explanations','[]'::jsonb),
    'receipt_purposes','{}'::jsonb,'warning_notes','{}'::jsonb)
$$;
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
  if (review->>'can_confirm')::boolean is distinct from true then raise exception 'Setup review blocked: %',review->'findings'; end if;
  perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
  return public.commit_tenancy_setup_session(account,draft,setup,review->>'setup_context',true,key,md5(key)||md5(key));
end;
$$;

do $test$
declare place uuid; person uuid; account uuid := current_setting('field_log.account_id')::uuid;
begin
  insert into public.properties(account_id,name) values(account,'418 Juniper Avenue') returning id into place;
  insert into public.tenants(account_id,full_name,emails,phones)
    values(account,'Dana Whitfield',array['Dana.Whitfield@example.test'],array['+15035550123']) returning id into person;
  perform set_config('field_log.place',place::text,true);
  perform set_config('field_log.person',person::text,true);
end;
$test$;

-- WP-01: people matching is off until the flag is on, then exact by email/phone, possible by name.
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; found jsonb;
begin
  found := public.match_setup_people(account,'dana.whitfield@example.test','','');
  if (found->>'enabled')::boolean or jsonb_array_length(found->'exact') <> 0 then
    raise exception 'Matching ran while person_match_enabled was off: %',found;
  end if;
end;
$test$;
reset role;
update public.accounts set person_match_enabled=true where id=:'account_id';
set local role authenticated;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit A');
  found jsonb;
begin
  perform pg_temp.commit_setup(draft,pg_temp.setup(person,(date_trunc('month',now())+interval '1 month')::date,'{}'));
  found := public.match_setup_people(account,' DANA.WHITFIELD@example.test ','','');
  if found->'exact'->0->>'person_id' <> person::text or found->'exact'->0->'matched_on' <> '["email"]'
    or found->'exact'->0->'tenancies'->0->>'door_name' <> 'Unit A'
    or found->'exact'->0->'tenancies'->0->>'property_name' <> '418 Juniper Avenue'
    or found->'exact'->0->'tenancies'->0->>'status' <> 'upcoming' then
    raise exception 'Email match missing context: %',found;
  end if;
  found := public.match_setup_people(account,'','+15035550123','');
  if found->'exact'->0->'matched_on' <> '["phone"]' then raise exception 'Phone match missing: %',found; end if;
  found := public.match_setup_people(account,'other@example.test','','  dana   WHITFIELD ');
  if jsonb_array_length(found->'exact') <> 0 or found->'possible'->0->'matched_on' <> '["name"]' then
    raise exception 'Name-only match should be possible, not exact: %',found;
  end if;
end;
$test$;

-- WP-04 and WP-06: follows_lease is stored with the schedule; a percent late fee is a valid term.
do $test$
declare
  person uuid := current_setting('field_log.person')::uuid;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit B');
begin
  perform pg_temp.commit_setup(draft,pg_temp.setup(person,(date_trunc('month',now())+interval '1 month')::date,
    '{"follows_lease":true}'));
  if (select follows_lease from public.rent_schedules where tenancy_id=draft) is distinct from true
    or (select late_fee_policy->>'kind' from public.leases where tenancy_id=draft) <> 'percent' then
    raise exception 'follows_lease or percent late fee was not stored';
  end if;
  if public._valid_recorded_term('{"kind":"percent","percent":0}',false)
    or public._valid_recorded_term('{"kind":"percent","percent":100.5}',false)
    or public._valid_recorded_term('{"kind":"percent","percent":2.555}',false)
    or not public._valid_recorded_term('{"kind":"percent","percent":2.5}',false) then
    raise exception 'Percent late fee validation is wrong';
  end if;
  begin
    perform public.preview_tenancy_setup_session(current_setting('field_log.account_id')::uuid,
      pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit B2'),
      pg_temp.setup(person,(date_trunc('month',now())+interval '1 month')::date,'{"follows_lease":"yes"}'));
    raise exception 'A non-boolean follows_lease was accepted';
  exception when raise_exception then
    if sqlerrm not like 'invalid: incomplete or unsupported recurring instruction%' then raise; end if;
  end;
end;
$test$;

-- WP-09: an amount owed from before plus itemized months, with no overlap and no early receipts.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
  start_on date := (month_start - interval '4 months')::date;
  itemize date := (month_start - interval '1 month')::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit C');
  review jsonb;
  rent jsonb := jsonb_build_object('opening_balance',jsonb_build_object('amount_cents',65000,'basis','Rent',
    'itemize_from',to_char(itemize,'YYYY-MM')));
begin
  begin
    perform public.preview_tenancy_setup_session(account,draft,pg_temp.setup(person,start_on,
      jsonb_build_object('opening_balance','{"amount_cents":65000,"basis":"Rent"}'::jsonb)));
    raise exception 'Itemized history with an unbounded opening amount was accepted';
  exception when raise_exception then
    if sqlerrm not like 'invalid: opening balance and itemized history are exclusive%' then raise; end if;
  end;
  review := public.preview_tenancy_setup_session(account,draft,pg_temp.setup(person,start_on,rent,
    jsonb_build_array(jsonb_build_object('draft_key','early','amount_cents',30000,'currency','USD',
      'received_at',(itemize-10)::text,'method','check','allocations','[]'::jsonb))));
  if (review->>'can_confirm')::boolean or not exists (select 1 from jsonb_array_elements(review->'findings') f
    where f->>'rule_id' = 'opening_receipt_unanswered:early' and f->>'severity' = 'error'
      and (f->'values'->>'payment_index')::integer = 0 and (f->'values'->>'amount_cents')::bigint = 30000) then
    raise exception 'An unanswered earlier receipt did not block confirm: %',review->'findings';
  end if;
  begin
    perform public.preview_tenancy_setup_session(account,draft,pg_temp.setup(person,start_on,
      rent||jsonb_build_object('charge_keys',jsonb_build_array(jsonb_build_object('cycle_key',to_char(start_on,'YYYY-MM'),'draft_key','old')))));
    raise exception 'A month covered by the opening amount was itemized';
  exception when raise_exception then
    if sqlerrm not like 'invalid: a selected month is covered%' then raise; end if;
  end;
  perform pg_temp.commit_setup(draft,pg_temp.setup(person,start_on,rent,
    jsonb_build_array(jsonb_build_object('draft_key','paid','amount_cents',147500,'currency','USD',
      'received_at',(itemize+2)::text,'method','check','allocations',
      jsonb_build_array(jsonb_build_object('charge_key','rent_'||to_char(itemize,'YYYY_MM'),'amount_cents',147500))))));
  if (select due_date from public.charges where tenancy_id=draft and type='opening_balance') <> itemize-1
    or (select min(period_start) from public.charges where tenancy_id=draft and type='rent') <> itemize
    or (select count(*) from public.charges where tenancy_id=draft and type='rent') <> 2
    or (select rent_balance_cents from public.rent_rollup(account,array['active'],month_start+1) where tenancy_id=draft)
      <> 65000 + 147500 then
    raise exception 'Combined setup double counted or misdated: %',
      (select jsonb_agg(jsonb_build_object('type',type,'due',due_date,'start',period_start,'amount',amount_cents))
         from public.charges where tenancy_id=draft);
  end if;
end;
$test$;

-- WP-09 follow-up: an earlier receipt is answered, never refused, and never invented.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
  start_on date := (month_start - interval '4 months')::date;
  itemize date := (month_start - interval '1 month')::date;
  draft uuid;
  choice text;
  date_unknown boolean;
  opening record;
  receipt record;
  owed bigint;
begin
  -- One answer per receipt: a repeated payment_key would count the receipt twice.
  begin
    perform public.preview_tenancy_setup_session(account,pg_temp.new_draft(current_setting('field_log.place')::uuid,'Earlier twice'),
      pg_temp.setup(person,start_on,
        jsonb_build_object('opening_balance',jsonb_build_object('amount_cents',65000,'basis','Rent',
          'itemize_from',to_char(itemize,'YYYY-MM'),
          'earlier_receipts','[{"payment_key":"early","choice":"add_to_owed"},{"payment_key":"early","choice":"add_to_owed"}]'::jsonb),
          'charge_keys','[]'::jsonb),
        jsonb_build_array(jsonb_build_object('draft_key','early','amount_cents',30000,'currency','USD',
          'received_at',(itemize-10)::text,'method','check','allocations','[]'::jsonb))));
    raise exception 'Two answers for one earlier receipt were accepted';
  exception when raise_exception then
    if sqlerrm not like 'invalid: each earlier-receipt answer names one receipt%' then raise; end if;
  end;
  for choice, date_unknown in select * from (values ('add_to_owed', false), ('keep_owed', false), ('keep_owed', true)) v(c, u) loop
    draft := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Earlier '||choice||date_unknown::text);
    perform pg_temp.commit_setup(draft,pg_temp.setup(person,start_on,
      jsonb_build_object('opening_balance',jsonb_build_object('amount_cents',65000,'basis','Rent',
        'itemize_from',to_char(itemize,'YYYY-MM'),
        'earlier_receipts',jsonb_build_array(jsonb_build_object('payment_key','early','choice',choice))),
        'charge_keys','[]'::jsonb),
      jsonb_build_array(jsonb_build_object('draft_key','early','amount_cents',30000,'currency','USD',
        'received_at',case when date_unknown then null else (itemize-10)::text end,'receipt_date_unknown',date_unknown,
        'method','check','allocations','[]'::jsonb))));
    select c.amount_cents, a.typed_opening_cents, a.earlier_receipts into opening
      from public.charges c join public.tenancy_adoptions a on a.id = c.opening_adoption_id
      where c.tenancy_id = draft and c.type = 'opening_balance';
    select p.received_at, p.receipt_date_unknown, (select sum(x.amount_cents) from public.payment_allocations x
        join public.charges c on c.id = x.charge_id and c.type = 'opening_balance' where x.payment_id = p.id) as applied
      into receipt from public.payments p where p.tenancy_id = draft and p.amount_cents = 30000;
    select coalesce(sum(c.amount_cents - coalesce((select sum(x.amount_cents) from public.payment_allocations x
        where x.charge_id = c.id and x.voided_at is null),0)),0) into owed
      from public.charges c where c.tenancy_id = draft and c.type = 'opening_balance';
    if opening.amount_cents <> (case when choice = 'add_to_owed' then 95000 else 65000 end)
      or opening.typed_opening_cents <> 65000 or opening.earlier_receipts->0->>'choice' <> choice
      or receipt.applied <> 30000 or receipt.receipt_date_unknown <> date_unknown
      or (receipt.received_at is null) <> date_unknown
      or owed <> (case when choice = 'add_to_owed' then 65000 else 35000 end) then
      raise exception 'Earlier receipt % (unknown date %) recorded wrongly: opening %, receipt %, owed %',
        choice, date_unknown, to_jsonb(opening), to_jsonb(receipt), owed;
    end if;
  end loop;
end;
$test$;

-- WP-09: $0 owed before itemized months, and one combined result equal to the ledger.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
  start_on date := (month_start - interval '4 months')::date;
  itemize date := (month_start - interval '1 month')::date;
  draft uuid;
  setup jsonb;
  review jsonb;
  ledger jsonb;
  label text;
  typed bigint;
  receipts jsonb;
  answers jsonb;
  expected jsonb;
  payments jsonb;
begin
  for label, typed, receipts, answers, expected in select * from (values
    ('owed 150', 65000, '[20000,30000]'::jsonb, '["keep_owed","keep_owed"]'::jsonb,
      '{"opening_charge_cents":65000,"applied_cents":50000,"still_owed_cents":15000,"paid_ahead_cents":0,"unanswered_count":0}'::jsonb),
    ('paid ahead 150', 65000, '[50000,30000]', '["keep_owed","keep_owed"]',
      '{"opening_charge_cents":65000,"applied_cents":65000,"still_owed_cents":0,"paid_ahead_cents":15000,"unanswered_count":0}'),
    ('zero, added', 0, '[30000]', '["add_to_owed"]',
      '{"opening_charge_cents":30000,"applied_cents":30000,"still_owed_cents":0,"paid_ahead_cents":0,"unanswered_count":0}'),
    ('zero, kept', 0, '[30000]', '["keep_owed"]',
      '{"opening_charge_cents":0,"applied_cents":0,"still_owed_cents":0,"paid_ahead_cents":30000,"unanswered_count":0}'),
    ('zero, no receipts', 0, '[]', '[]',
      '{"opening_charge_cents":0,"applied_cents":0,"still_owed_cents":0,"paid_ahead_cents":0,"unanswered_count":0}')
  ) cases(l, t, r, a, e) loop
    draft := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Result '||label);
    select coalesce(jsonb_agg(jsonb_build_object('draft_key','r'||n,'amount_cents',amount::bigint,'currency','USD',
        'received_at',(itemize - 20 + n::integer)::text,'method','check','allocations','[]'::jsonb) order by n),'[]')
      into payments from jsonb_array_elements_text(receipts) with ordinality x(amount, n);
    setup := pg_temp.setup(person,start_on,
      jsonb_build_object('opening_balance',jsonb_build_object('amount_cents',typed,
        'itemize_from',to_char(itemize,'YYYY-MM'),
        'earlier_receipts',(select coalesce(jsonb_agg(jsonb_build_object('payment_key','r'||n,'choice',choice) order by n),'[]')
          from jsonb_array_elements_text(answers) with ordinality y(choice, n)))
        || case when typed <> 0 then '{"basis":"Rent"}'::jsonb else '{}'::jsonb end,
      'charge_keys','[]'::jsonb), payments);
    review := public.preview_tenancy_setup_session(account,draft,setup);
    if not (review->'opening_result' @> expected) or (review->'opening_result'->>'typed_cents')::bigint <> typed then
      raise exception '% preview result wrong: %',label,review->'opening_result';
    end if;
    if typed = 0 and not exists (select 1 from jsonb_array_elements(review->'findings') f
        where f->>'rule_id' = 'opening_months_treated_as_paid' and f->>'severity' = 'info') then
      raise exception '% did not explain the paid months: %',label,review->'findings';
    end if;
    perform pg_temp.commit_setup(draft,setup);
    select jsonb_build_object(
      'opening_charge_cents',coalesce((select amount_cents from public.charges where tenancy_id=draft and type='opening_balance'),0),
      'applied_cents',coalesce((select sum(x.amount_cents) from public.payment_allocations x join public.charges c on c.id=x.charge_id
        where c.tenancy_id=draft and c.type='opening_balance' and x.voided_at is null),0),
      'paid_ahead_cents',coalesce((select sum(p.amount_cents) - coalesce(sum((select sum(x.amount_cents) from public.payment_allocations x
        where x.payment_id=p.id and x.voided_at is null)),0) from public.payments p where p.tenancy_id=draft and p.received_at < itemize),0))
      into ledger;
    if (ledger->>'opening_charge_cents')::bigint <> (expected->>'opening_charge_cents')::bigint
      or (ledger->>'applied_cents')::bigint <> (expected->>'applied_cents')::bigint
      or (ledger->>'opening_charge_cents')::bigint - (ledger->>'applied_cents')::bigint <> (expected->>'still_owed_cents')::bigint
      or (ledger->>'paid_ahead_cents')::bigint <> (expected->>'paid_ahead_cents')::bigint
      or (select opening_on from public.tenancy_adoptions where tenancy_id=draft) <> itemize - 1
      or (select min(period_start) from public.charges where tenancy_id=draft and type='rent') < itemize then
      raise exception '% ledger differs from preview: %',label,ledger;
    end if;
  end loop;
end;
$test$;

-- WP-07: the account's 30-day method prorates a move-out's final period.
reset role;
update public.accounts set proration_method='thirty_day_month' where id=:'account_id';
set local role authenticated;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit D');
  key text := 'end-'||gen_random_uuid()::text;
begin
  perform pg_temp.commit_setup(draft,pg_temp.setup(person,(month_start - interval '2 months')::date,
    jsonb_build_object('coverage_start',month_start,'regular_anchor',month_start,
      'history_mode','opening_balance','opening_balance','{"amount_cents":1000,"basis":"Rent","includes_current_rent":true}'::jsonb)));
  perform set_config('field_log.prorate_tenancy',draft::text,true);
end;
$test$;
reset role;
do $test$
declare next_month date := (date_trunc('month',public._account_date(current_setting('field_log.account_id')::uuid))+interval '1 month')::date;
begin
  perform public.generate_rent_charges(current_setting('field_log.account_id')::uuid,
    next_month::timestamp at time zone 'America/Los_Angeles');
end;
$test$;
set local role authenticated;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  tenancy uuid := current_setting('field_log.prorate_tenancy')::uuid;
  next_month date := (date_trunc('month',public._account_date(account))+interval '1 month')::date;
  key text := 'end-'||gen_random_uuid()::text;
begin
  perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
  perform public.record_tenancy_ending(account,tenancy,jsonb_build_object('kind','ended','effective_date',next_month+9,
    'initiated_by','tenant','reason_code','notice'),key,md5(key)||md5(key));
  if (select amount_cents from public.charges where tenancy_id=tenancy and type='rent' and voided_at is null) <> round(147500*10/30.0) then
    raise exception 'Final period ignored the 30-day method: %',
      (select jsonb_agg(amount_cents) from public.charges where tenancy_id=tenancy and type='rent' and voided_at is null);
  end if;
end;
$test$;

-- WP-10: a future rent step changes the generated charge from its month and not before.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit E');
  outcome jsonb;
begin
  outcome := pg_temp.commit_setup(draft,pg_temp.setup(person,(month_start - interval '2 months')::date,
    jsonb_build_object('coverage_start',month_start,'regular_anchor',month_start,
      'history_mode','opening_balance','opening_balance','{"amount_cents":1000,"basis":"Rent","includes_current_rent":true}'::jsonb)));
  perform public.change_tenancy_rent(p_account_id=>account,p_tenancy_id=>draft,p_amount_cents=>155000,p_currency=>'USD',
    p_effective_date=>(month_start+interval '2 months')::date,p_source_lease_id=>(outcome->>'lease_id')::uuid,
    p_change_reason=>'Rent increase agreed');
  perform set_config('field_log.step_tenancy',draft::text,true);
end;
$test$;
reset role;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  tenancy uuid := current_setting('field_log.step_tenancy')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
begin
  perform public.generate_rent_charges(account,(month_start+interval '1 month')::timestamp at time zone 'America/Los_Angeles');
  perform public.generate_rent_charges(account,(month_start+interval '2 months')::timestamp at time zone 'America/Los_Angeles');
  if (select string_agg(period_start||'='||amount_cents,' ' order by period_start) from public.charges
      where tenancy_id=tenancy and type='rent' and voided_at is null)
    <> (month_start+interval '1 month')::date||'=147500 '||(month_start+interval '2 months')::date||'=155000' then
    raise exception 'Rent step did not apply from its month: %',
      (select string_agg(period_start||'='||amount_cents,' ' order by period_start) from public.charges where tenancy_id=tenancy and type='rent');
  end if;
end;
$test$;

-- WP-09: a deposit receipt dated before the itemized months is not an earlier receipt; it
-- keeps its deposit allocation exactly as without itemize_from.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  today date := public._account_date(account);
  itemize date := (date_trunc('month',today) - interval '1 month')::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Deposit before itemized');
  setup jsonb;
  review jsonb;
  deposit_id uuid;
begin
  setup := pg_temp.setup(person,'2025-06-01',
    jsonb_build_object('opening_balance',jsonb_build_object('amount_cents',65000,'basis','Rent',
      'itemize_from',to_char(itemize,'YYYY-MM')),'charge_keys','[]'::jsonb),
    '[{"draft_key":"deposit_paid","amount_cents":185000,"currency":"USD","received_at":"2025-06-01","method":"check",
       "allocations":[{"charge_key":"deposit","amount_cents":185000}]}]'::jsonb);
  setup := jsonb_set(jsonb_set(jsonb_set(setup,'{agreement,deposit_amount_cents}','185000'),
    '{agreement,deposit_knowledge}','"amount"'),'{billing,deposit}',jsonb_build_object('decision','record',
      'draft_key','deposit','amount_cents',185000,'currency','USD','due_date',today))
    || '{"receipt_purposes":{"deposit_paid":"deposit"}}'::jsonb;
  review := public.preview_tenancy_setup_session(account,draft,setup);
  if not (review->>'can_confirm')::boolean
    or exists (select 1 from jsonb_array_elements(review->'findings') f where f->>'rule_id' like 'opening_receipt_unanswered:%')
    or review->'opening_result'->>'unanswered_count' is distinct from '0'
    or review->'opening_result'->>'still_owed_cents' is distinct from '65000'
    or review->'opening_result'->>'answered_receipts_cents' is distinct from '0'
    or review->'billing_intent'->'payments'->0->'allocations' is distinct from '[{"charge_key":"deposit","amount_cents":185000}]'
    or review->'billing_intent'->'payments'->0->>'purpose' is distinct from 'deposit' then
    raise exception 'Deposit receipt was treated as an earlier receipt: %',review;
  end if;
  -- An answer naming the deposit receipt is refused: it is not an earlier receipt.
  begin
    perform public.preview_tenancy_setup_session(account,draft,jsonb_set(setup,'{billing,rent,opening_balance,earlier_receipts}',
      '[{"payment_key":"deposit_paid","choice":"add_to_owed"}]'));
    raise exception 'An earlier-receipt answer for a deposit receipt was accepted';
  exception when raise_exception then
    if sqlerrm not like 'invalid: each earlier-receipt answer names one receipt%' then raise; end if;
  end;
  perform pg_temp.commit_setup(draft,setup);
  select id into strict deposit_id from public.charges where tenancy_id=draft and type='deposit';
  if (select sum(x.amount_cents) from public.payment_allocations x where x.charge_id=deposit_id and x.voided_at is null) is distinct from 185000
    or (select amount_cents from public.charges where tenancy_id=draft and type='opening_balance') is distinct from 65000
    or exists (select 1 from public.payment_allocations x join public.charges c on c.id=x.charge_id
      where c.tenancy_id=draft and c.type='opening_balance')
    or (select earlier_receipts from public.tenancy_adoptions where tenancy_id=draft) is not null then
    raise exception 'Deposit receipt lost its deposit allocation at commit';
  end if;
end;
$test$;

-- WP-09: an amount owed with itemize_from is recorded even when the first itemized cycle
-- has not started (anchor day later than today); preview equals the committed ledger.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  -- Setup decides "started" with the account date; the later of it and the UTC date keeps the anchor ahead.
  today date := greatest(public._account_date(account), (now() at time zone 'UTC')::date);
  month_start date := date_trunc('month',today)::date;
  anchor_day integer := extract(day from today)::integer + 1;
  start_on date := (month_start - interval '5 months')::date + anchor_day - 1;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Itemized not started');
  setup jsonb;
  review jsonb;
begin
  if anchor_day > 28 or to_char(public._account_date(account),'YYYY-MM') <> to_char(today,'YYYY-MM') then
    raise notice 'Skipped: no anchor day later than today in this month';
    return;
  end if;
  setup := pg_temp.setup(person,start_on,jsonb_build_object('due_day',anchor_day,
    'billing_due_rule',jsonb_build_object('kind','day_of_month','day',anchor_day),
    'opening_balance',jsonb_build_object('amount_cents',200000,'basis','Rent','itemize_from',to_char(today,'YYYY-MM')),
    'charge_keys','[]'::jsonb));
  setup := jsonb_set(setup,'{agreement,rent_due_rule}',jsonb_build_object('kind','day_of_month','day',anchor_day));
  review := public.preview_tenancy_setup_session(account,draft,setup);
  if exists (select 1 from jsonb_array_elements(review->'history_periods') h where (h->>'is_elapsed')::boolean) then
    raise exception 'Fixture: an itemized cycle has already started: %',review->'history_periods';
  end if;
  perform pg_temp.commit_setup(draft,setup);
  if (select amount_cents from public.charges where tenancy_id=draft and type='opening_balance' and voided_at is null)
      is distinct from (review->'opening_result'->>'still_owed_cents')::bigint
    or (review->'opening_result'->>'still_owed_cents')::bigint <> 200000
    or (select opening_on from public.tenancy_adoptions where tenancy_id=draft) is distinct from month_start + anchor_day - 2 then
    raise exception 'Amount owed from before was dropped: preview %, ledger %',review->'opening_result',
      (select jsonb_agg(to_jsonb(c)) from public.charges c where tenancy_id=draft);
  end if;
end;
$test$;

-- WP-02: "this month" and the adoption date are the account's date. The zone is chosen so
-- the account date differs from the UTC date right now (UTC-12 before noon UTC, UTC+14 after).
reset role;
update public.accounts set time_zone = case when extract(hour from now() at time zone 'UTC') < 12
  then 'Etc/GMT+12' else 'Pacific/Kiritimati' end where id=:'account_id';
set local role authenticated;
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  today date := public._account_date(account);
  month_start date := date_trunc('month',today)::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Account date');
begin
  if today = (now() at time zone 'UTC')::date then raise exception 'Fixture: account date equals the UTC date'; end if;
  perform pg_temp.commit_setup(draft,pg_temp.setup(person,(month_start - interval '2 months')::date,
    jsonb_build_object('coverage_start',month_start,'regular_anchor',month_start,'history_mode','opening_balance',
      'opening_balance','{"amount_cents":65000,"basis":"Rent","includes_current_rent":false}'::jsonb)));
  if (select adoption_date from public.tenancy_adoptions where tenancy_id=draft) is distinct from today
    or (select due_date from public.charges where tenancy_id=draft and type='opening_balance') is distinct from today
    or (select cycle_key from public.charges where tenancy_id=draft and type='rent') is distinct from to_char(today,'YYYY-MM') then
    raise exception 'Setup used the UTC date instead of the account date';
  end if;
  perform set_config('field_log.account_date_tenancy',draft::text,true);
end;
$test$;
reset role;
update public.accounts set time_zone='America/Los_Angeles' where id=:'account_id';

-- WP-02: includes_current_rent skips rent for the adoption month, never a non-rent schedule.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Parking');
begin
  perform set_config('request.jwt.claims','{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}',true);
  set local role authenticated;
  perform pg_temp.commit_setup(draft,pg_temp.setup(person,(month_start - interval '2 months')::date,
    jsonb_build_object('coverage_start',month_start,'regular_anchor',month_start,'history_mode','opening_balance',
      'opening_balance','{"amount_cents":65000,"basis":"Rent","includes_current_rent":true}'::jsonb)));
  reset role;
  insert into public.rent_schedules(account_id,tenancy_id,kind,amount_cents,currency,due_day,start_date,period_policy_version,
      regular_anchor,terms_snapshot,billing_due_rule,short_month_policy)
    select account_id,tenancy_id,'parking',5000,currency,due_day,start_date,period_policy_version,
      regular_anchor,terms_snapshot,billing_due_rule,short_month_policy
    from public.rent_schedules where tenancy_id=draft and kind='rent';
  perform public.generate_rent_charges(account,month_start::timestamp at time zone 'America/Los_Angeles' + interval '1 hour');
  if exists (select 1 from public.charges where tenancy_id=draft and type='rent')
    or not exists (select 1 from public.charges where tenancy_id=draft and type='other' and period_start=month_start
      and amount_cents=5000) then
    raise exception 'Adoption-month skip is wrong for rent or parking: %',
      (select jsonb_agg(jsonb_build_object('type',type,'period_start',period_start)) from public.charges where tenancy_id=draft);
  end if;
end;
$test$;

rollback;
