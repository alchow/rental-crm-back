begin;

-- INVARIANT: one answer per earlier receipt. A repeated payment_key would add the
-- receipt to the opening entry twice and apply it twice.
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

do $migration$
declare body text;
begin
  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    $old$or (jsonb_array_length(coalesce(p_intent->'payments','[]')) > 0 and not (e->>'payment_key' = any(early_keys)))) then$old$,
    $new$or (jsonb_array_length(coalesce(p_intent->'payments','[]')) > 0 and not (e->>'payment_key' = any(early_keys))))
          or (select count(*) <> count(distinct value->>'payment_key')
            from jsonb_array_elements(coalesce(r->'opening_balance'->'earlier_receipts','[]'))) then$new$);
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
