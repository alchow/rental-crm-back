do $$
declare definition text; changed text;
begin
  select pg_get_functiondef('public._rent_writer_serialization_guard()'::regprocedure) into definition;
  changed:=replace(definition,
    'and (NEW.period_start is distinct from NEW.due_date or NEW.period_start is null or (
              s.start_date <= NEW.period_start
              and (s.end_date is null or s.end_date >= NEW.period_start)
            ))',
    'and (NEW.period_start is null or (
              s.start_date <= public._rent_billing_slot(coalesce(NEW.period_start,NEW.due_date),s.due_day)
              and (s.end_date is null or s.end_date >= public._rent_billing_slot(coalesce(NEW.period_start,NEW.due_date),s.due_day))
            ))');
  if changed=definition then raise exception 'canonical charge source guard marker not found'; end if;
  execute changed;
end $$;
