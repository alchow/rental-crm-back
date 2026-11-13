-- "Today" is the account's date (accounts.time_zone): tenancy status, rent generation,
-- overdue, the future-date warnings and their commit-time check. Runs in one
-- transaction and rolls back.
--
-- Rent generation takes an explicit instant, so it is tested with real zones at
-- 11:30 pm and 00:05 local. The other functions read the clock, so they are tested
-- with fixed-offset zones built from the current UTC hour: the west zone puts the
-- account at 23:mm on the previous day, the east zone at 00:mm on the next day.
-- Those offsets are POSIX zone specs, so the zone-name check is disabled in this
-- transaction only.
\set ON_ERROR_STOP on
-- Stay inside one UTC hour for the whole run.
select pg_sleep(75 - extract(second from clock_timestamp())) where extract(minute from clock_timestamp() at time zone 'UTC') = 59;
begin;
set local timezone = 'UTC';
insert into auth.users(id,email) values ('dddddddd-0000-0000-0000-dddddddddddd','account-date@example.test');
select set_config('request.jwt.claims','{"sub":"dddddddd-0000-0000-0000-dddddddddddd","role":"authenticated"}',true);
set local role authenticated;
select account_id from public.create_account_for_new_user('Account date','Test owner','UTC') \gset
select set_config('field_log.account_id', :'account_id', true);
reset role;
alter table public.accounts disable trigger accounts_validate_time_zone;
select set_config('field_log.west', format('<-%s>+%s', h + 1, h + 1), true),
  set_config('field_log.east', format('<+%s>-%s', 24 - h, 24 - h), true),
  set_config('field_log.utc_today', (statement_timestamp() at time zone 'UTC')::date::text, true)
  from (select extract(hour from statement_timestamp() at time zone 'UTC')::integer as h) x;

create function pg_temp.zone(z text) returns void language sql as $$
  update public.accounts set time_zone = z where id = current_setting('field_log.account_id')::uuid
$$;
create function pg_temp.tenancy(label text, start_on date) returns uuid language plpgsql as $$
declare account uuid := current_setting('field_log.account_id')::uuid; door uuid; t uuid;
begin
  insert into public.areas(account_id,property_id,kind,name) values(account,current_setting('field_log.place')::uuid,'unit',label)
    returning id into door;
  insert into public.tenancies(account_id,area_id,start_date,status) values(account,door,start_on,'active') returning id into t;
  return t;
end;
$$;

do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; place uuid;
begin
  insert into public.properties(account_id,name) values(account,'12 Larch Street') returning id into place;
  perform set_config('field_log.place',place::text,true);
end;
$test$;

-- The fixture really is on either side of UTC midnight.
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; d date := current_setting('field_log.utc_today')::date;
begin
  perform pg_temp.zone(current_setting('field_log.west'));
  if public._account_date(account) <> d - 1 or extract(hour from statement_timestamp() at time zone current_setting('field_log.west')) <> 23 then
    raise exception 'Fixture: west zone is not 11 pm yesterday';
  end if;
  perform pg_temp.zone(current_setting('field_log.east'));
  if public._account_date(account) <> d + 1 or extract(hour from statement_timestamp() at time zone current_setting('field_log.east')) <> 0 then
    raise exception 'Fixture: east zone is not just after midnight tomorrow';
  end if;
end;
$test$;

-- Rent generation follows the account's date at an exact instant.
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid;
  first_next date := (date_trunc('month', current_setting('field_log.utc_today')::date) + interval '1 month')::date;
  t uuid := pg_temp.tenancy('Generated', (first_next - interval '2 months')::date);
  west_instant timestamptz := (first_next + time '23:30') at time zone 'America/Los_Angeles';
  east_instant timestamptz := ((first_next + 1) + time '00:05') at time zone 'Asia/Tokyo';
  after_next date := (first_next + interval '1 month')::date;
begin
  update public.accounts set auto_charge_enabled = true where id = account;
  insert into public.rent_schedules(account_id,tenancy_id,kind,amount_cents,currency,due_day,start_date)
    values(account,t,'rent',120000,'USD',1,(first_next - interval '2 months')::date);
  -- Tokyo, 00:05 on the 2nd (UTC still the 1st): the 1st has passed, so the next charge is the month after.
  perform pg_temp.zone('Asia/Tokyo');
  perform public.generate_rent_charges(account, east_instant);
  if exists (select 1 from public.charges where tenancy_id=t and due_date=first_next)
    or not exists (select 1 from public.charges where tenancy_id=t and due_date=after_next) then
    raise exception 'East rent generation did not follow the account date: %',
      (select jsonb_agg(due_date) from public.charges where tenancy_id=t);
  end if;
  -- Los Angeles, 11:30 pm on the 1st (UTC already the 2nd): the 1st is still today.
  perform pg_temp.zone('America/Los_Angeles');
  perform public.generate_rent_charges(account, west_instant);
  if not exists (select 1 from public.charges where tenancy_id=t and due_date=first_next) then
    raise exception 'West rent generation did not follow the account date: %',
      (select jsonb_agg(due_date) from public.charges where tenancy_id=t);
  end if;
  -- UTC at the west instant is the 2nd: the 1st is not generated.
  delete from public.charges where tenancy_id=t;
  perform pg_temp.zone('UTC');
  perform public.generate_rent_charges(account, west_instant);
  if exists (select 1 from public.charges where tenancy_id=t and due_date=first_next) then
    raise exception 'UTC rent generation changed';
  end if;
  delete from public.charges where tenancy_id=t;
  delete from public.rent_schedules where tenancy_id=t;
end;
$test$;

-- Tenancy status and overdue, west: today is yesterday in UTC terms.
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; d date := current_setting('field_log.utc_today')::date;
  starts uuid; billed uuid; r record;
begin
  perform pg_temp.zone(current_setting('field_log.west'));
  starts := pg_temp.tenancy('West starts', d);
  if (select status from public.tenancies where id=starts) <> 'upcoming'
    or (select status from public.tenancy_current where id=starts) <> 'upcoming'
    or public._tenancy_current_status((select x from public.tenancies x where x.id=starts)) <> 'upcoming' then
    raise exception 'West tenancy starting on the UTC date is not upcoming';
  end if;
  billed := pg_temp.tenancy('West billed', d - 40);
  insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date) values(account,billed,'other',1000,'USD',d);
  select * into r from public.rent_rollup(account) where tenancy_id=billed;
  if r.non_deposit_upcoming_cents <> 1000 or r.non_deposit_due_today_cents <> 0 or r.non_deposit_overdue_cents <> 0 then
    raise exception 'West rent roll did not use the account date: %', to_jsonb(r);
  end if;
  perform set_config('field_log.west_starts',starts::text,true);
  perform set_config('field_log.west_billed',billed::text,true);
end;
$test$;

-- East: today is tomorrow in UTC terms.
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; d date := current_setting('field_log.utc_today')::date;
  starts uuid; r record;
begin
  perform pg_temp.zone(current_setting('field_log.east'));
  starts := pg_temp.tenancy('East starts', d + 1);
  if (select status from public.tenancies where id=starts) <> 'active'
    or (select status from public.tenancy_current where id=starts) <> 'active' then
    raise exception 'East tenancy starting on the account date is not active';
  end if;
  select * into r from public.rent_rollup(account) where tenancy_id=current_setting('field_log.west_billed')::uuid;
  if r.non_deposit_overdue_cents <> 1000 or r.non_deposit_due_today_cents <> 0 then
    raise exception 'East rent roll did not use the account date: %', to_jsonb(r);
  end if;
  -- An explicit as_of still wins.
  select * into r from public.rent_rollup(account, array['active'], d) where tenancy_id=current_setting('field_log.west_billed')::uuid;
  if r.non_deposit_due_today_cents <> 1000 then raise exception 'Explicit rent roll as_of was ignored: %', to_jsonb(r); end if;
  perform set_config('field_log.east_starts',starts::text,true);
end;
$test$;

-- Warnings, as the landlord.
set local role authenticated;
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; d date := current_setting('field_log.utc_today')::date;
  t uuid := current_setting('field_log.west_billed')::uuid; preview jsonb; warnings jsonb;
begin
  perform pg_temp.zone(current_setting('field_log.west'));
  -- Receipt dated the UTC date is tomorrow for the account.
  preview := public.preview_payment(account, jsonb_build_object('tenancy_id',t,'amount_cents',5000,'currency','USD','received_at',d,'method','check'));
  if preview->>'as_of_date' <> (d - 1)::text or preview->>'clock_basis' <> current_setting('field_log.west')
    or (preview->>'can_commit')::boolean or preview->'findings'->0->>'rule_id' <> 'receipt_in_future'
    or preview->'findings'->0->>'message' like '%UTC%' or preview->'findings'->0->>'message' like '%app date%' then
    raise exception 'West receipt warning did not use the account date: %', preview;
  end if;
  -- A receipt timestamped now has happened, though its UTC date is the account's tomorrow.
  preview := public.preview_payment(account, jsonb_build_object('tenancy_id',t,'amount_cents',5000,'currency','USD','received_at',statement_timestamp(),'method','check'));
  if not (preview->>'can_commit')::boolean or jsonb_array_length(preview->'findings') <> 0 then
    raise exception 'West receipt timestamped now was called future: %', preview;
  end if;
  preview := public.preview_payment(account, jsonb_build_object('tenancy_id',t,'amount_cents',5000,'currency','USD','received_at',statement_timestamp() + interval '2 days','method','check'));
  if (preview->>'can_commit')::boolean or preview->'findings'->0->>'rule_id' <> 'receipt_in_future' then
    raise exception 'West receipt timestamped in two days was not called future: %', preview;
  end if;
  -- An ending dated the UTC date is in the future for the account.
  preview := public.preview_tenancy_ending(account, t, jsonb_build_object('kind','ended','effective_date',d,'reason_code','notice'));
  if preview->>'as_of_date' <> (d - 1)::text or preview->'findings'->0->>'rule_id' <> 'actual_ending_in_future'
    or preview->'findings'->0->>'message' like '%UTC%' then
    raise exception 'West ending warning did not use the account date: %', preview;
  end if;
  warnings := public._actual_date_warnings(jsonb_build_object('account_id',account,'tenancy_id',t,'actual_move_in_date',d), 'ctx');
  if jsonb_array_length(warnings) <> 1 or warnings->0->>'rule_id' <> 'actual_move_in_in_future'
    or warnings->0->'values'->>'as_of_date' <> (d - 1)::text or warnings->0->>'message' like '%UTC%' then
    raise exception 'West arrival warning did not use the account date: %', warnings;
  end if;
  if (public.get_tenancy_date_context(account, t))->>'clock_basis' <> current_setting('field_log.west')
    or (public.get_tenancy_date_context(account, t))->>'as_of_date' <> (d - 1)::text then
    raise exception 'Date context did not report the account clock';
  end if;

  perform pg_temp.zone(current_setting('field_log.east'));
  -- Tomorrow in UTC terms is today for the account: no warning.
  preview := public.preview_payment(account, jsonb_build_object('tenancy_id',t,'amount_cents',5000,'currency','USD','received_at',d + 1,'method','check'));
  if preview->>'as_of_date' <> (d + 1)::text or not (preview->>'can_commit')::boolean or jsonb_array_length(preview->'findings') <> 0 then
    raise exception 'East receipt warning did not use the account date: %', preview;
  end if;
  preview := public.preview_tenancy_ending(account, t, jsonb_build_object('kind','ended','effective_date',d + 1,'reason_code','notice'));
  if jsonb_array_length(preview->'findings') <> 0 then
    raise exception 'East ending warning did not use the account date: %', preview;
  end if;
  if jsonb_array_length(public._actual_date_warnings(jsonb_build_object('account_id',account,'tenancy_id',t,'actual_move_in_date',d + 1), 'ctx')) <> 0 then
    raise exception 'East arrival warning did not use the account date';
  end if;

  perform pg_temp.zone('UTC');
  preview := public.preview_payment(account, jsonb_build_object('tenancy_id',t,'amount_cents',5000,'currency','USD','received_at',d + 1,'method','check'));
  if preview->>'as_of_date' <> d::text or preview->>'clock_basis' <> 'UTC' or (preview->>'can_commit')::boolean then
    raise exception 'UTC receipt warning changed: %', preview;
  end if;
end;
$test$;
reset role;

-- The commit-time check uses the same date as the warning (receipts stored at noon UTC).
do $test$
declare account uuid := current_setting('field_log.account_id')::uuid; d date := current_setting('field_log.utc_today')::date;
  t uuid := current_setting('field_log.west_billed')::uuid;
begin
  perform pg_temp.zone(current_setting('field_log.east'));
  insert into public.payments(account_id,tenancy_id,amount_cents,currency,received_at,method)
    values(account,t,5000,'USD',(d + 1)::timestamp at time zone 'UTC' + interval '12 hours','check');
  set constraints payment_future_date_confirmation immediate;
  set constraints payment_future_date_confirmation deferred;
  perform pg_temp.zone(current_setting('field_log.west'));
  -- A receipt timestamped now is accepted without confirmation.
  insert into public.payments(account_id,tenancy_id,amount_cents,currency,received_at,method)
    values(account,t,5000,'USD',statement_timestamp(),'check');
  set constraints payment_future_date_confirmation immediate;
  set constraints payment_future_date_confirmation deferred;
  -- A date-only receipt for the account's tomorrow (noon UTC of the UTC date). In a real
  -- zone (UTC-12 at most) that noon is still ahead whenever the account is a day behind;
  -- the test's fixed offset can exceed 12 hours, so only check while it is.
  if statement_timestamp() < d::timestamp at time zone 'UTC' + interval '12 hours' then
    begin
      insert into public.payments(account_id,tenancy_id,amount_cents,currency,received_at,method)
        values(account,t,5000,'USD',d::timestamp at time zone 'UTC' + interval '12 hours','check');
      set constraints payment_future_date_confirmation immediate;
      raise exception 'West future receipt was accepted without confirmation';
    exception when invalid_parameter_value then
      if sqlerrm not like '%explicit date warning confirmation required%' then raise; end if;
    end;
  end if;
  -- A receipt two days ahead is refused at any hour.
  begin
    insert into public.payments(account_id,tenancy_id,amount_cents,currency,received_at,method)
      values(account,t,5000,'USD',statement_timestamp() + interval '2 days','check');
    set constraints payment_future_date_confirmation immediate;
    raise exception 'West receipt two days ahead was accepted without confirmation';
  exception when invalid_parameter_value then
    if sqlerrm not like '%explicit date warning confirmation required%' then raise; end if;
  end;
end;
$test$;

rollback;
