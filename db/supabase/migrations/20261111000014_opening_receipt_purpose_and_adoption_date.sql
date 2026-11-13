begin;

-- Corrections to the amount owed from before (ADR-0013 amendments):
-- 1. Only a rent receipt can be an earlier receipt. A deposit receipt dated before the
--    itemized months keeps its deposit allocation and is never asked add_to_owed/keep_owed.
--    DATA FLOW: setup receipt_purposes -> payment.purpose ('deposit'; absent = rent) ->
--    facts preview, _opening_result and commit skip non-rent receipts.
-- 2. An amount owed with itemize_from always writes the adoption (and so the opening
--    entry), even when no itemized cycle has started yet.
-- 3. With the starting-balance ledger on, "this month" for includes_current_rent and the
--    adoption date are the account's date, not the UTC date. The generator's skip already
--    reads the stored adoption_date, so both agree.
-- 4. The generator's includes_current_rent skip applies to rent schedules only.
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
  body := pg_get_functiondef('public.preview_tenancy_setup_session(uuid,uuid,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    $old$    if r->'opening_balance'->>'itemize_from' is not null and public._receipt_before_itemized(p,$old$,
    $new$    if coalesce(p_setup->'receipt_purposes'->>(p->>'draft_key'),'rent')='rent'
      and r->'opening_balance'->>'itemize_from' is not null and public._receipt_before_itemized(p,$new$);
  -- CONTRACT: the session's receipt_purposes map is the only source of a receipt's purpose.
  body := pg_temp.patched(body,
    $old$    payments:=payments||jsonb_build_array(p||jsonb_build_object('allocations',allocs,'entry_source','entered_at_setup'));$old$,
    $new$    payments:=payments||jsonb_build_array((p-'purpose')||jsonb_build_object('allocations',allocs,'entry_source','entered_at_setup')
      ||case when p_setup->'receipt_purposes'->>(p->>'draft_key')='deposit' then '{"purpose":"deposit"}'::jsonb else '{}'::jsonb end);$new$);
  execute body;

  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    $old$          if public._receipt_before_itemized(early, (v_period->>'period_start')::date) then$old$,
    $new$          if coalesce(early->>'purpose','rent') = 'rent'
            and public._receipt_before_itemized(early, (v_period->>'period_start')::date) then$new$);
  body := pg_temp.patched(body,
    $old$'receipt_date_unknown','entry_source','payer_tenant_id'] <> '{}'$old$,
    $new$'receipt_date_unknown','entry_source','payer_tenant_id','purpose'] <> '{}'
      or coalesce(v_elem->>'purpose','rent') not in ('rent','deposit')$new$);
  body := pg_temp.patched(body,
    $old$      v_period := public._billing_period_for_tenancy(p_account_id,t.id,r, to_char(v_today, 'YYYY-MM'));$old$,
    $new$      v_period := public._billing_period_for_tenancy(p_account_id,t.id,r, to_char(public._account_date(p_account_id), 'YYYY-MM'));$new$);
  execute body;

  body := pg_get_functiondef('public._opening_result(jsonb,jsonb,date)'::regprocedure);
  body := pg_temp.patched(body,
    $old$    where public._receipt_before_itemized(p, p_itemized_start)$old$,
    $new$    where coalesce(p->>'purpose','rent') = 'rent' and public._receipt_before_itemized(p, p_itemized_start)$new$);
  execute body;

  body := pg_get_functiondef('public.commit_billing_setup(uuid,uuid,jsonb,text,text)'::regprocedure);
  body := pg_temp.patched(body,
    $old$if v_preview->>'mode' = 'initial' and (r->>'history_mode' = 'opening_balance' or exists($old$,
    $new$if v_preview->>'mode' = 'initial' and (r->>'history_mode' = 'opening_balance'
      or r->'opening_balance'->>'itemize_from' is not null or exists($new$);
  body := pg_temp.patched(body,
    $old$      values(p_account_id,p_tenancy_id,(v_preview->>'as_of_date')::date,$old$,
    $new$      values(p_account_id,p_tenancy_id,case when exists (select 1 from public.accounts
          where id = p_account_id and opening_balance_ledger_enabled)
        then public._account_date(p_account_id) else (v_preview->>'as_of_date')::date end,$new$);
  body := pg_temp.patched(body,
    $old$on ans->>'payment_key' = rp->>'draft_key' and ans->>'choice' = 'add_to_owed'),0)$old$,
    $new$on ans->>'payment_key' = rp->>'draft_key' and ans->>'choice' = 'add_to_owed'
          where coalesce(rp->>'purpose','rent') = 'rent'),0)$new$);
  body := pg_temp.patched(body,
    $old$ans on ans->>'payment_key' = rp->>'draft_key'
        order by rp->>'received_at' nulls first$old$,
    $new$ans on ans->>'payment_key' = rp->>'draft_key'
        where coalesce(rp->>'purpose','rent') = 'rent'
        order by rp->>'received_at' nulls first$new$);
  execute body;

  body := pg_get_functiondef('public.generate_rent_charges(uuid,timestamp with time zone)'::regprocedure);
  body := pg_temp.patched(body,
    $old$and ac.opening_balance_ledger_enabled and a.includes_current_rent$old$,
    $new$and s.kind = 'rent' and ac.opening_balance_ledger_enabled and a.includes_current_rent$new$);
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
