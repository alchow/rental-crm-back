begin;

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

-- A receipt is "in the future" by its calendar date (a date-only receipt is stored at
-- noon UTC, so its UTC date is the date entered). A full timestamp that has already
-- happened is never future: west of UTC its UTC date runs a day ahead of the account's
-- date every evening. For a 'UTC' account both tests agree, so nothing changes.
do $migration$
declare body text;
begin
  body := pg_get_functiondef('public._receipt_date_warning(uuid,uuid,jsonb,text)'::regprocedure);
  body := pg_temp.patched(body, $old$if entered is null or entered<=today then return '[]'; end if;$old$,
    $new$if entered is null or entered<=today or ((p_payment->>'received_at') !~ '^\d{4}-\d{2}-\d{2}$'
    and (p_payment->>'received_at')::timestamptz<=statement_timestamp()) then return '[]'; end if;$new$);
  execute body;

  -- INVARIANT: the commit-time check exempts exactly what the preview warning exempts.
  body := pg_get_functiondef('public._require_future_date_confirmation()'::regprocedure);
  body := pg_temp.patched(body,
    'if entered<=public._account_date(NEW.account_id,statement_timestamp()) or entered is null then return null; end if;',
    'if entered<=public._account_date(NEW.account_id,statement_timestamp()) or entered is null then return null; end if;
  if TG_TABLE_NAME=''payments'' and (to_jsonb(NEW)->>''received_at'')::timestamptz<=statement_timestamp() then return null; end if;');
  execute body;

  -- The oldest due date names what is due or late; an amount owed from before is neither.
  body := pg_get_functiondef('public._owed_summaries_base'::regproc);
  body := pg_temp.patched(body,
    '(select min(due_date) from due where due.tenancy_id = k.tenancy_id and due.currency = k.currency),',
    '(select min(due_date) from due where due.tenancy_id = k.tenancy_id and due.currency = k.currency
      and due.type <> ''opening_balance''),');
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
