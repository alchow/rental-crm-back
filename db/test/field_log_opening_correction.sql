-- Starting-balance correction ("void and re-enter"): history kept, money re-applied,
-- balances before and after. Runs in one transaction and rolls back.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values ('ffffffff-ffff-ffff-ffff-ffffffffffff','opening-correction@example.test');
select set_config('request.jwt.claims','{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated"}',true);
set local role authenticated;
select account_id from public.create_account_for_new_user('Opening correction','Test owner','America/Los_Angeles') \gset
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

create function pg_temp.correct(tenancy uuid, payload jsonb) returns jsonb
language plpgsql as $$
declare account uuid := current_setting('field_log.account_id')::uuid; key text := 'correct-'||gen_random_uuid()::text;
begin
  perform public.claim_idempotency_key(account,key,md5(key)||md5(key));
  return public.correct_opening_balance(account,tenancy,payload,key,md5(key)||md5(key));
end;
$$;
create function pg_temp.owed(tenancy uuid) returns jsonb
language sql as $$
  select to_jsonb(s) - 'as_of' - 'next_charge' - 'by_type' from public.owed_summaries(current_setting('field_log.account_id')::uuid, tenancy) s
$$;
-- A tenancy whose setup recorded `typed` owed from before (positive) or a credit (negative).
create function pg_temp.opening_tenancy(label text, typed bigint) returns uuid
language plpgsql as $$
declare draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid, label);
  month_start date := date_trunc('month', public._account_date(current_setting('field_log.account_id')::uuid))::date;
begin
  perform pg_temp.commit_setup(draft, pg_temp.setup(current_setting('field_log.person')::uuid,
    (month_start - interval '2 months')::date,
    jsonb_build_object('coverage_start',month_start,'regular_anchor',month_start,'history_mode','opening_balance',
      'opening_balance',jsonb_build_object('amount_cents',typed,'basis','Rent')
        || case when typed > 0 then '{"includes_current_rent":true}'::jsonb else '{}'::jsonb end)));
  return draft;
end;
$$;
create function pg_temp.pay(tenancy uuid, cents bigint, apply_cents bigint) returns uuid
language plpgsql as $$
declare account uuid := current_setting('field_log.account_id')::uuid; payment jsonb;
begin
  select p.payment into payment from public.create_payment_with_allocations(account,tenancy,cents,'USD',now()-interval '1 day','check',null,null,null,
    case when apply_cents > 0 then jsonb_build_array(jsonb_build_object('charge_id',(select id from public.charges
      where tenancy_id=tenancy and type='opening_balance' and voided_at is null),'amount_cents',apply_cents)) else '[]'::jsonb end) p;
  return (payment->>'id')::uuid;
end;
$$;

do $test$
declare place uuid; person uuid; account uuid := current_setting('field_log.account_id')::uuid;
begin
  insert into public.properties(account_id,name) values(account,'418 Juniper Avenue') returning id into place;
  insert into public.tenants(account_id,full_name) values(account,'Sean Example') returning id into person;
  perform set_config('field_log.place',place::text,true);
  perform set_config('field_log.person',person::text,true);
end;
$test$;

do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  t uuid;
  before jsonb;
  preview jsonb;
  result jsonb;
  old_charge uuid;
begin
  -- 6500 -> 650 with nothing paid; preview equals commit; history kept.
  t := pg_temp.opening_tenancy('No payments', 650000);
  select id into old_charge from public.charges where tenancy_id=t and type='opening_balance';
  before := pg_temp.owed(t);
  preview := public.preview_opening_balance_correction(account,t,'{"amount_cents":65000,"basis":"Rent","reason":"Typed one zero too many"}');
  result := pg_temp.correct(t,'{"amount_cents":65000,"basis":"Rent","reason":"Typed one zero too many"}');
  if (before->>'total_cents')::bigint <> 650000 or (result->'owed_after'->>'total_cents')::bigint <> 65000
    or preview->'owed_after' <> result->'owed_after' or (preview->'next') - 'entry' <> (result->'next') - 'entry'
    or not exists (select 1 from public.charges where id=old_charge and voided_at is not null
      and void_reason='Starting balance corrected: Typed one zero too many')
    or not exists (select 1 from public.charges where tenancy_id=t and type='opening_balance' and voided_at is null
      and amount_cents=65000 and replaces_charge_id=old_charge)
    or not exists (select 1 from public.opening_balance_corrections where tenancy_id=t and previous_typed_cents=650000
      and typed_cents=65000 and corrected_by='ffffffff-ffff-ffff-ffff-ffffffffffff') then
    raise exception 'Plain correction is wrong: before %, preview %, result %',before,preview,result;
  end if;
  -- A second correction replaces the corrected entry and keeps both corrections.
  result := pg_temp.correct(t,'{"amount_cents":70000,"basis":"Rent","reason":"Landlord rechecked the statement"}');
  if (result->'previous'->>'typed_cents')::bigint <> 65000 or (result->'owed_after'->>'total_cents')::bigint <> 70000
    or (select count(*) from public.opening_balance_corrections where tenancy_id=t) <> 2
    or (select count(*) from public.charges where tenancy_id=t and type='opening_balance' and voided_at is null) <> 1
    or (select count(*) from public.charges where tenancy_id=t and type='opening_balance') <> 3 then
    raise exception 'Second correction is wrong: %',result;
  end if;
  -- Corrections in one transaction are strictly ordered, so "latest" is never a tie.
  if (select count(distinct corrected_at) from public.opening_balance_corrections where tenancy_id=t) <> 2
    or (select typed_cents from public.opening_balance_corrections where tenancy_id=t
        order by corrected_at desc limit 1) <> 70000 then
    raise exception 'Corrections are not strictly ordered by corrected_at';
  end if;
  begin
    perform pg_temp.correct(t,'{"amount_cents":70000,"basis":"Rent","reason":"Same again"}');
    raise exception 'An unchanged amount was accepted';
  exception when raise_exception then
    if sqlerrm <> 'invalid: opening_unchanged' then raise; end if;
  end;

  -- A partial payment moves to the new entry.
  t := pg_temp.opening_tenancy('Partial payment', 650000);
  perform pg_temp.pay(t, 20000, 20000);
  result := pg_temp.correct(t,'{"amount_cents":65000,"basis":"Rent","reason":"Typed one zero too many"}');
  if (result->'owed_before'->>'total_cents')::bigint <> 630000 or (result->'owed_after'->>'total_cents')::bigint <> 45000
    or (result->'owed_after'->>'unapplied_credit_cents')::bigint <> 0
    or (result->'allocations'->0->>'moved_cents')::bigint <> 20000 or (result->'allocations'->0->>'released_cents')::bigint <> 0 then
    raise exception 'Partial payment correction is wrong: %',result;
  end if;

  -- A payment larger than the new amount: the excess becomes unapplied credit.
  t := pg_temp.opening_tenancy('Large payment', 650000);
  perform pg_temp.pay(t, 100000, 100000);
  result := pg_temp.correct(t,'{"amount_cents":65000,"basis":"Rent","reason":"Typed one zero too many"}');
  if (result->'owed_after'->>'total_cents')::bigint <> 0 or (result->'owed_after'->>'headline_cents')::bigint <> 0
    or (result->'owed_after'->>'credit_remaining_cents')::bigint <> 35000
    or (result->'allocations'->0->>'moved_cents')::bigint <> 65000 or (result->'allocations'->0->>'released_cents')::bigint <> 35000 then
    raise exception 'Large payment correction is wrong: %',result;
  end if;

  -- Owed -> credit: the paid amount and the new credit are both unapplied credit.
  t := pg_temp.opening_tenancy('To credit', 650000);
  perform pg_temp.pay(t, 10000, 10000);
  result := pg_temp.correct(t,'{"amount_cents":-20000,"basis":"Rent","reason":"Tenant had paid ahead"}');
  if (result->'owed_after'->>'total_cents')::bigint <> 0 or (result->'owed_after'->>'unapplied_credit_cents')::bigint <> 30000
    or result->'next'->'entry'->>'kind' <> 'credit'
    or not exists (select 1 from public.payments where tenancy_id=t and entry_source='opening_credit' and amount_cents=20000 and voided_at is null) then
    raise exception 'Owed to credit correction is wrong: %',result;
  end if;
  -- Credit -> credit keeps the link to the replaced credit.
  result := pg_temp.correct(t,'{"amount_cents":-15000,"basis":"Rent","reason":"Smaller credit"}');
  if (result->'owed_after'->>'unapplied_credit_cents')::bigint <> 25000 or not exists (select 1 from public.payments
      where tenancy_id=t and entry_source='opening_credit' and amount_cents=15000 and voided_at is null and replaces_payment_id is not null) then
    raise exception 'Credit to credit correction is wrong: %',result;
  end if;

  -- A credit applied to charges: 500 applied as 400 + 100, corrected to 200, is
  -- re-applied oldest first (200 to the first charge), so the first owes 200 and the
  -- second owes 100 again.
  t := pg_temp.opening_tenancy('Credit applied', -50000);
  declare credit uuid; first_charge uuid; second_charge uuid;
    month_start date := date_trunc('month', public._account_date(account))::date;
  begin
    select id into strict credit from public.payments where tenancy_id=t and entry_source='opening_credit' and voided_at is null;
    insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,description)
      values(account,t,'rent',40000,'USD',month_start-20,'Rent A') returning id into first_charge;
    insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,description)
      values(account,t,'rent',10000,'USD',month_start-19,'Rent B') returning id into second_charge;
    insert into public.payment_allocations(account_id,payment_id,charge_id,amount_cents)
      values(account,credit,first_charge,40000),(account,credit,second_charge,10000);
    result := pg_temp.correct(t,'{"amount_cents":-20000,"basis":"Rent","reason":"Credit was 200"}');
    if (select amount_cents - coalesce((select sum(x.amount_cents) from public.payment_allocations x
          where x.charge_id=c.id and x.voided_at is null),0) from public.charges c where c.id=first_charge) <> 20000
      or (select amount_cents - coalesce((select sum(x.amount_cents) from public.payment_allocations x
          where x.charge_id=c.id and x.voided_at is null),0) from public.charges c where c.id=second_charge) <> 10000
      or (result->'owed_after'->>'total_cents')::bigint <> 30000
      or (result->'owed_after'->>'unapplied_credit_cents')::bigint <> 0
      or (result->'allocations'->0->>'charge_id')::uuid <> first_charge
      or (result->'allocations'->0->>'moved_cents')::bigint <> 20000 or (result->'allocations'->0->>'released_cents')::bigint <> 20000
      or (result->'allocations'->1->>'moved_cents')::bigint <> 0 or (result->'allocations'->1->>'released_cents')::bigint <> 10000 then
      raise exception 'Applied credit correction is wrong: %',result;
    end if;
  end;

  -- Owed -> 0: no opening entry remains.
  t := pg_temp.opening_tenancy('To zero', 650000);
  result := pg_temp.correct(t,'{"amount_cents":0,"reason":"Nothing was owed"}');
  if (result->'owed_after'->>'total_cents')::bigint <> 0 or result->'next'->'entry'->>'kind' <> 'none'
    or exists (select 1 from public.charges where tenancy_id=t and type='opening_balance' and voided_at is null) then
    raise exception 'Owed to zero correction is wrong: %',result;
  end if;
  -- And back from 0 to an amount owed.
  result := pg_temp.correct(t,'{"amount_cents":5000,"basis":"Fees","reason":"A fee was owed after all"}');
  if (result->'owed_after'->>'total_cents')::bigint <> 5000 then raise exception 'Zero to owed correction is wrong: %',result; end if;
end;
$test$;

-- Earlier receipts: the corrected typed amount keeps add_to_owed receipts on top, and the
-- combined opening result for the corrected state matches the ledger.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
  start_on date := (month_start - interval '4 months')::date;
  itemize date := (month_start - interval '1 month')::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Earlier receipts');
  rent jsonb := jsonb_build_object('opening_balance',jsonb_build_object('amount_cents',65000,'basis','Rent',
    'itemize_from',to_char(itemize,'YYYY-MM'),'earlier_receipts','[{"payment_key":"early","choice":"add_to_owed"}]'::jsonb),
    'charge_keys','[]'::jsonb);
  payments jsonb := jsonb_build_array(jsonb_build_object('draft_key','early','amount_cents',30000,'currency','USD',
    'received_at',(itemize-10)::text,'method','check','allocations','[]'::jsonb));
  result jsonb;
  expected jsonb;
begin
  perform pg_temp.commit_setup(draft,pg_temp.setup(current_setting('field_log.person')::uuid,start_on,rent,payments));
  result := pg_temp.correct(draft,'{"amount_cents":50000,"basis":"Rent","reason":"Statement said 500"}');
  rent := jsonb_set(rent,'{opening_balance,amount_cents}','50000');
  expected := public._opening_result(rent,payments,itemize);
  if (result->'next'->>'opening_cents')::bigint <> 80000
    or (select amount_cents from public.charges where tenancy_id=draft and type='opening_balance' and voided_at is null)
      <> (expected->>'opening_charge_cents')::bigint
    or (select sum(x.amount_cents) from public.payment_allocations x join public.charges c on c.id=x.charge_id
        where c.tenancy_id=draft and c.type='opening_balance' and c.voided_at is null and x.voided_at is null)
      <> (expected->>'applied_cents')::bigint
    or (result->'owed_after'->>'total_cents')::bigint - (select coalesce(sum(amount_cents),0) from public.charges
        where tenancy_id=draft and type='rent' and voided_at is null)
      + (select coalesce(sum(x.amount_cents),0) from public.payment_allocations x join public.charges c on c.id=x.charge_id
        where c.tenancy_id=draft and c.type='rent' and x.voided_at is null) <> (expected->>'still_owed_cents')::bigint then
    raise exception 'Earlier-receipt correction does not match the opening result: %, expected %',result,expected;
  end if;
end;
$test$;

-- Refusals: ledger off, no ledger entry, no starting balance.
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; t uuid;
begin
  t := pg_temp.opening_tenancy('Refusals', 650000);
  begin
    perform public.preview_opening_balance_correction(account,gen_random_uuid(),'{"amount_cents":1,"basis":"Rent","reason":"x"}');
    raise exception 'A tenancy without a starting balance was corrected';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform public.preview_opening_balance_correction(account,t,'{"amount_cents":100,"reason":"no basis"}');
    raise exception 'A non-zero correction without a basis was accepted';
  exception when raise_exception then
    if sqlerrm not like 'invalid: send the corrected amount%' then raise; end if;
  end;
  perform set_config('field_log.refusal_tenancy',t::text,true);
end;
$test$;
reset role;
update public.accounts set opening_balance_ledger_enabled=false where id=:'account_id';
set local role authenticated;
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; t uuid;
begin
  begin
    perform public.preview_opening_balance_correction(account,current_setting('field_log.refusal_tenancy')::uuid,
      '{"amount_cents":100,"basis":"Rent","reason":"x"}');
    raise exception 'Correction ran with the ledger off';
  exception when raise_exception then
    if sqlerrm <> 'conflict: opening_ledger_disabled' then raise; end if;
  end;
  t := pg_temp.opening_tenancy('Legacy', 650000);
  perform set_config('field_log.legacy_tenancy',t::text,true);
end;
$test$;
reset role;
update public.accounts set opening_balance_ledger_enabled=true where id=:'account_id';
set local role authenticated;
do $test$
begin
  begin
    perform public.preview_opening_balance_correction(current_setting('field_log.account_id')::uuid,
      current_setting('field_log.legacy_tenancy')::uuid,'{"amount_cents":100,"basis":"Rent","reason":"x"}');
    raise exception 'A legacy starting balance without a ledger entry was corrected';
  exception when raise_exception then
    if sqlerrm <> 'conflict: opening_not_in_ledger' then raise; end if;
  end;
end;
$test$;

-- A typed-0 itemized opening has no ledger entry and can still be corrected later.
do $test$
declare
  account uuid := current_setting('field_log.account_id')::uuid;
  month_start date := date_trunc('month',public._account_date(account))::date;
  itemize date := (month_start - interval '1 month')::date;
  draft uuid := pg_temp.new_draft(current_setting('field_log.place')::uuid,'Typed zero');
  result jsonb;
begin
  perform pg_temp.commit_setup(draft,pg_temp.setup(current_setting('field_log.person')::uuid,(month_start - interval '4 months')::date,
    jsonb_build_object('opening_balance',jsonb_build_object('amount_cents',0,'itemize_from',to_char(itemize,'YYYY-MM')),
      'charge_keys','[]'::jsonb)));
  if exists (select 1 from public.charges where tenancy_id=draft and type='opening_balance') then
    raise exception 'Fixture: a typed 0 wrote an opening entry';
  end if;
  result := pg_temp.correct(draft,'{"amount_cents":30000,"basis":"Rent","reason":"Statement showed 300 owed"}');
  if result->'previous'->'entry'->>'kind' <> 'none' or result->'next'->'entry'->>'kind' <> 'charge'
    or not exists (select 1 from public.charges where tenancy_id=draft and type='opening_balance' and voided_at is null
      and amount_cents=30000 and replaces_charge_id is null and due_date=itemize-1) then
    raise exception 'Typed-0 itemized opening was not correctable: %',result;
  end if;
  -- Corrected once, then the corrected entry is soft-deleted (not voided).
  draft := pg_temp.opening_tenancy('Soft deleted', 650000);
  perform pg_temp.correct(draft,'{"amount_cents":65000,"basis":"Rent","reason":"Typed one zero too many"}');
  perform set_config('field_log.deleted_tenancy',draft::text,true);
end;
$test$;
-- A soft-deleted (not voided) opening entry is refused with a clear code, not a unique-index error.
reset role;
update public.charges set deleted_at=now(), updated_at=now()
  where tenancy_id=current_setting('field_log.deleted_tenancy')::uuid and type='opening_balance' and voided_at is null;
set local role authenticated;
do $test$
begin
  begin
    perform pg_temp.correct(current_setting('field_log.deleted_tenancy')::uuid,'{"amount_cents":70000,"basis":"Rent","reason":"x"}');
    raise exception 'A deleted opening entry was replaced';
  exception when raise_exception then
    if sqlerrm <> 'conflict: opening_entry_deleted' then raise; end if;
  end;
end;
$test$;

rollback;
