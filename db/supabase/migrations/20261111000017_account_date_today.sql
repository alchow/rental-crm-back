begin;

-- "Today" is the account's calendar date (accounts.time_zone) everywhere a function
-- compares against today. Each function keeps the clock it read before (now(),
-- statement_timestamp() or its p_as_of) and only the zone changes, so an account whose
-- zone is 'UTC' (the default) behaves exactly as before. No stored row is rewritten.
-- Left on UTC on purpose: the noon-UTC instant a date-only receipt is stored at, and the
-- UTC date a stored receipt instant falls on (the platform-wide snapshot rule).
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

-- CONTRACT: the zone whose calendar date previews report as as_of_date (clock_basis).
create function public._account_time_zone(p_account_id uuid)
returns text language sql stable set search_path = public as $$
  select coalesce((select time_zone from public.accounts where id = p_account_id), 'UTC')
$$;
revoke all on function public._account_time_zone(uuid) from public, anon;
grant execute on function public._account_time_zone(uuid) to authenticated, service_role, tenancy_date_writer, tenancy_setup_writer;

-- Tenancy status: upcoming until the start date arrives in the account's zone.
do $migration$
declare body text;
begin
  body := pg_get_viewdef('public.tenancy_current'::regclass);
  body := pg_temp.patched(body, 'THEN effective_tenancy_status(t.status, t.start_date)',
    'THEN effective_tenancy_status(t.status, t.start_date, ((now() AT TIME ZONE a.time_zone))::date)');
  execute 'create or replace view public.tenancy_current with (security_invoker = true) as ' || body;

  body := pg_get_functiondef('public._tenancy_current_status(public.tenancies)'::regprocedure);
  body := pg_temp.patched(body, 'public.effective_tenancy_status(p_tenancy.status, p_tenancy.start_date)',
    'public.effective_tenancy_status(p_tenancy.status, p_tenancy.start_date, public._account_date(p_tenancy.account_id, now()))');
  execute body;

  body := pg_get_functiondef('public._normalize_tenancy_lifecycle()'::regprocedure);
  body := pg_temp.patched(body, 'public.effective_tenancy_status(NEW.status,NEW.start_date)',
    'public.effective_tenancy_status(NEW.status,NEW.start_date,public._account_date(NEW.account_id,now()))');
  execute body;

  body := pg_get_functiondef('public.bootstrap_tenancy(uuid,text,text,jsonb)'::regprocedure);
  body := pg_temp.patched(body, 'public.effective_tenancy_status(coalesce(p_payload->>''status'',''upcoming''),start_on)',
    'public.effective_tenancy_status(coalesce(p_payload->>''status'',''upcoming''),start_on,public._account_date(p_account_id,now()))');
  execute body;

  body := pg_get_functiondef('public.advance_tenancy_statuses(timestamp with time zone)'::regprocedure);
  body := pg_temp.patched(body, 'and t.start_date <= p_as_of::date',
    'and t.start_date <= public._account_date(t.account_id, p_as_of)');
  execute body;

  body := pg_get_functiondef('public.preview_tenancy_setup_session(uuid,uuid,jsonb)'::regprocedure);
  body := pg_temp.patched(body, 'today date:=(now() at time zone ''UTC'')::date;',
    'today date:=public._account_date(p_account_id,now());');
  execute body;
end;
$migration$;

-- Date warnings and previews: today, and the zone it was read in.
do $migration$
declare body text;
begin
  body := pg_get_functiondef('public._actual_date_warnings(jsonb,text)'::regprocedure);
  body := pg_temp.patched(body, 'today date:=(statement_timestamp() at time zone ''UTC'')::date;',
    'today date:=public._account_date((p_facts->>''account_id'')::uuid,statement_timestamp());');
  body := pg_temp.patched(body, 'is after the app date %s (UTC).', 'is after today''''s date %s.', 2);
  execute body;

  body := pg_get_functiondef('public._scope_relationship_warnings(jsonb,jsonb,text)'::regprocedure);
  body := pg_temp.patched(body, '''as_of_date'',(statement_timestamp() at time zone ''UTC'')::date)',
    '''as_of_date'',public._account_date((p_facts->>''account_id'')::uuid,statement_timestamp()))');
  execute body;

  body := pg_get_functiondef('public._receipt_date_warning(uuid,uuid,jsonb,text)'::regprocedure);
  body := pg_temp.patched(body, 'declare today date:=(statement_timestamp() at time zone ''UTC'')::date;',
    'declare today date:=public._account_date(p_account,statement_timestamp());');
  body := pg_temp.patched(body, 'is after the app date %s (UTC).', 'is after today''''s date %s.');
  execute body;

  -- INVARIANT: the commit-time check uses the same today as the preview warning.
  body := pg_get_functiondef('public._require_future_date_confirmation()'::regprocedure);
  body := pg_temp.patched(body, 'if entered<=(statement_timestamp() at time zone ''UTC'')::date or entered is null',
    'if entered<=public._account_date(NEW.account_id,statement_timestamp()) or entered is null');
  execute body;

  body := pg_get_functiondef('public._date_context_without_warning(uuid,uuid,uuid,uuid)'::regprocedure);
  body := pg_temp.patched(body, 'today date:=(now() at time zone ''UTC'')::date;',
    'today date:=public._account_date(p_account_id,now());');
  body := pg_temp.patched(body, '''clock_basis'',''UTC''', '''clock_basis'',public._account_time_zone(p_account_id)');
  execute body;

  body := pg_get_functiondef('public._preview_tenancy_date_change(uuid,uuid,jsonb,boolean)'::regprocedure);
  body := pg_temp.patched(body, 'today date:=(now() at time zone ''UTC'')::date;',
    'today date:=public._account_date(p_account_id,now());');
  body := pg_temp.patched(body, '''clock_basis'',''UTC''', '''clock_basis'',public._account_time_zone(p_account_id)');
  execute body;

  body := pg_get_functiondef('public.get_tenancy_onboarding_progress(uuid,uuid)'::regprocedure);
  body := pg_temp.patched(body, '''as_of_date'',(now() at time zone ''UTC'')::date,''clock_basis'',''UTC''',
    '''as_of_date'',public._account_date(p_account_id,now()),''clock_basis'',public._account_time_zone(p_account_id)');
  execute body;

  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body := pg_temp.patched(body, 'v_today date := (now() at time zone ''UTC'')::date;',
    'v_today date := public._account_date(p_account_id,now());');
  body := pg_temp.patched(body, '''clock_basis'',''UTC''', '''clock_basis'',public._account_time_zone(p_account_id)');
  execute body;

  body := pg_get_functiondef('public.preview_payment(uuid,jsonb)'::regprocedure);
  body := pg_temp.patched(body, '(statement_timestamp() at time zone ''UTC'')::date',
    'public._account_date(p_account_id,statement_timestamp())', 2);
  body := pg_temp.patched(body, '''clock_basis'',''UTC''', '''clock_basis'',public._account_time_zone(p_account_id)');
  execute body;

  body := pg_get_functiondef('public.preview_tenancy_ending(uuid,uuid,jsonb)'::regprocedure);
  body := pg_temp.patched(body, 'today date:=(statement_timestamp() at time zone ''UTC'')::date;',
    'today date:=public._account_date(p_account_id,statement_timestamp());');
  body := pg_temp.patched(body, $old$
  if exists (select 1 from public.accounts where id=p_account_id and scheduled_move_out_enabled) then
    today:=public._account_date(p_account_id);
  end if;
$old$, E'\n');
  body := pg_temp.patched(body, 'is after the app date %s (UTC).', 'is after today''''s date %s.');
  body := pg_temp.patched(body, '''clock_basis'',''UTC''', '''clock_basis'',public._account_time_zone(p_account_id)');
  execute body;
end;
$migration$;

-- Rent: generation, the rent roll's overdue buckets, drift and schedule endings.
do $migration$
declare body text;
begin
  body := pg_get_functiondef('public.generate_rent_charges(uuid,timestamp with time zone)'::regprocedure);
  body := pg_temp.patched(body, 'v_today date := (p_as_of at time zone ''UTC'')::date;',
    'v_today date := public._account_date(p_account_id,p_as_of);');
  body := pg_temp.patched(body, 'v_today := case when t.move_out_on is null then (p_as_of at time zone ''UTC'')::date'
    || chr(10) || '      else public._account_date(p_account_id,p_as_of) end;',
    'v_today := public._account_date(p_account_id,p_as_of);');
  execute body;

  -- COMPAT: an explicit p_as_of still classifies against that date.
  body := pg_get_functiondef('public.rent_rollup(uuid,text[],date)'::regprocedure);
  body := pg_temp.patched(body, 'p_as_of date DEFAULT ((now() AT TIME ZONE ''UTC''::text))::date',
    'p_as_of date DEFAULT NULL::date');
  body := pg_temp.patched(body, 'p_as_of),0)', 'coalesce(p_as_of,public._account_date(p_account_id,now()))),0)', 3);
  body := pg_temp.patched(body, '(now() at time zone ''UTC'')::date', 'public._account_date(p_account_id,now())', 4);
  execute body;

  body := pg_get_functiondef('public.detect_rent_drift(uuid)'::regprocedure);
  body := pg_temp.patched(body, $old$  -- Pin the session to UTC so current_date (the open-schedule cutoff below) is
  -- deterministic regardless of the caller's TimeZone -- same determinism
  -- rationale generate_rent_charges documents. Transaction-local, never leaks.
$old$, $new$  -- The open-schedule cutoff is the account's date, independent of the session
  -- TimeZone (pinned to UTC, transaction-local).
$new$);
  body := pg_temp.patched(body, 'and s.start_date <= current_date', 'and s.start_date <= public._account_date(p_account_id, now())');
  body := pg_temp.patched(body, 'and (s.end_date is null or s.end_date >= current_date)',
    'and (s.end_date is null or s.end_date >= public._account_date(p_account_id, now()))');
  execute body;

  body := pg_get_functiondef('public._end_rent_schedules_on_tenancy_end()'::regprocedure);
  body := pg_temp.patched(body, 'v_end := coalesce(NEW.end_date, current_date);',
    'v_end := coalesce(NEW.end_date, public._account_date(NEW.account_id, now()));');
  execute body;
end;
$migration$;

-- Adoption: a history cannot be dated after the account's tomorrow.
do $migration$
declare body text;
begin
  body := pg_get_functiondef('public.adopt_tenancy_history'::regproc);
  body := pg_temp.patched(body, $old$  -- +1 day: a client whose local calendar is ahead of UTC (up to UTC+14) may
  -- legitimately name "today" one day past current_date. Anything further is$old$,
    $new$  -- +1 day of slack past the account's date, kept so a UTC account accepts exactly
  -- what it accepted before. Anything further is$new$);
  body := pg_temp.patched(body, 'if p_adoption_date > current_date + 1 then',
    'if p_adoption_date > public._account_date(p_account_id, now()) + 1 then');
  execute body;

  body := pg_get_functiondef('public._tenancy_adoptions_guard()'::regprocedure);
  body := pg_temp.patched(body, 'if NEW.adoption_date > current_date + 1 then',
    'if NEW.adoption_date > public._account_date(NEW.account_id, now()) + 1 then');
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
