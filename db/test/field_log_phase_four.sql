-- Field Log Phase 4 database checks: one owed summary, late-fee suggestions, the next
-- charge, account currency and duplicate properties. Runs in one transaction, rolls back.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','phase-four@example.test');
select set_config('request.jwt.claims','{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated"}',true);
set local role authenticated;
select account_id from public.create_account_for_new_user('Phase four','Test owner','America/Los_Angeles') \gset
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
  insert into public.properties(account_id,name,address) values(account,'418 Juniper Avenue',
    '{"line1":"418 Juniper Avenue","city":"Reedsport","provider_id":"place.123"}') returning id into place;
  insert into public.tenants(account_id,full_name) values(account,'Dana Whitfield') returning id into person;
  perform set_config('field_log.place',place::text,true);
  perform set_config('field_log.person',person::text,true);
end;
$test$;

-- WP-22, WP-23, WP-24 on a tenancy with last month and this month itemized.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  today date := public._account_date(account);
  month_start date := date_trunc('month',today)::date;
  start_on date := (month_start - interval '1 month')::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit A');
  fixed_rent jsonb := '{"late_fee_policy":{"kind":"fixed","amount_cents":7500,"currency":"USD"}}';
  owed record;
  suggestions jsonb;
  last_month uuid;
  this_month uuid;
begin
  perform pg_temp.commit_setup(draft,pg_temp.setup(person,start_on,fixed_rent));
  select id into strict last_month from public.charges where tenancy_id=draft and type='rent' and period_start=start_on;
  select id into strict this_month from public.charges where tenancy_id=draft and type='rent' and period_start=month_start;
  select * into strict owed from public.owed_summaries(account,draft);
  if owed.total_cents <> 295000 or owed.by_type <> '[{"type":"rent","cents":295000}]'
    or owed.oldest_due_on <> start_on
    or owed.overdue_cents <> (case when today > month_start + 5 then 295000 else 147500 end)
    or owed.next_charge <> jsonb_build_object('cents',147500,'due_on',(month_start+interval '1 month')::date,'source','schedule')
    or not owed.rent_tracked then
    raise exception 'Owed summary is wrong: %',to_jsonb(owed);
  end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.due_date),'[]') into suggestions from public.late_fee_suggestions(account,draft) s;
  if suggestions->0->>'charge_id' <> last_month::text or suggestions->0->'fee' <> '{"kind":"fixed","amount_cents":7500}'
    or (suggestions->0->>'eligible_on')::date <> start_on + 6
    or jsonb_array_length(suggestions) <> (case when today > month_start + 5 then 2 else 1 end) then
    raise exception 'Late-fee suggestions are wrong: %',suggestions;
  end if;
  -- Adding the fee or skipping it removes the suggestion; the fee joins what is owed by type.
  insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,parent_charge_id,description)
    values(account,draft,'late_fee',7500,'USD',today,last_month,'Late fee');
  insert into public.late_fee_decisions(account_id,charge_id,decision) values(account,this_month,'skipped');
  if exists (select 1 from public.late_fee_suggestions(account,draft)) then
    raise exception 'A decided rent charge still suggests a late fee';
  end if;
  select * into strict owed from public.owed_summaries(account,draft);
  if owed.total_cents <> 302500 or owed.by_type <> '[{"type":"late_fee","cents":7500},{"type":"rent","cents":295000}]' then
    raise exception 'Late fee missing from what is owed: %',to_jsonb(owed);
  end if;
end;
$test$;

-- Percent fees are a percent of the rent; a starting balance is owed, never overdue, never a fee.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit B');
  opening uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit C');
  owed record;
begin
  perform pg_temp.commit_setup(draft,pg_temp.setup(person,(month_start - interval '1 month')::date,'{}'));
  if (select (fee->>'amount_cents')::bigint from public.late_fee_suggestions(account,draft) s
      where s.due_date = (month_start - interval '1 month')::date) <> 7375 then
    raise exception 'Percent late fee is not a percent of the rent';
  end if;
  perform pg_temp.commit_setup(opening,pg_temp.setup(person,(month_start - interval '2 months')::date,
    jsonb_build_object('coverage_start',month_start,'regular_anchor',month_start,'history_mode','opening_balance',
      'opening_balance','{"amount_cents":65000,"basis":"Rent","includes_current_rent":true}'::jsonb)));
  select * into strict owed from public.owed_summaries(account,opening);
  if owed.total_cents <> 65000 or owed.overdue_cents <> 0
    or owed.by_type <> '[{"type":"opening_balance","cents":65000}]'
    or exists (select 1 from public.late_fee_suggestions(account,opening)) then
    raise exception 'Starting balance owed summary or suggestions are wrong: %',to_jsonb(owed);
  end if;
end;
$test$;

-- WP-24: tracking off has no next charge.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  person uuid := current_setting('field_log.person')::uuid;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Unit D');
  setup jsonb := pg_temp.setup(person,(date_trunc('month',now())+interval '1 month')::date,'{}');
  owed record;
begin
  setup := jsonb_set(setup,'{billing,rent}','{"decision":"defer"}');
  perform pg_temp.commit_setup(draft,setup);
  if exists (select 1 from public.owed_summaries(account,draft) where rent_tracked or next_charge is not null) then
    raise exception 'A tenancy without rent tracking reported a next charge';
  end if;
end;
$test$;

-- WP-15 and WP-26.
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; found jsonb;
begin
  if (select currency from public.accounts where id=account) <> 'USD'
    or (select multi_currency from public.accounts where id=account) then
    raise exception 'New accounts should default to USD, single currency';
  end if;
  found := public.find_duplicate_properties(account,'','418  juniper AVE.');
  if found->0->>'matched_on' <> 'address' or (found->0->>'door_count')::integer < 4 then
    raise exception 'Normalized address did not match: %',found;
  end if;
  found := public.find_duplicate_properties(account,'place.123','somewhere else');
  if found->0->>'matched_on' <> 'provider_id' then raise exception 'Provider id did not match: %',found; end if;
  if jsonb_array_length(public.find_duplicate_properties(account,'','420 Juniper Avenue')) <> 0 then
    raise exception 'A different address matched';
  end if;
end;
$test$;

rollback;
