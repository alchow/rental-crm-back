begin;

-- An amount owed from before plus itemized months: a receipt dated before the itemized
-- months (or with an unknown date) needs the landlord's answer instead of a refusal.
--   add_to_owed: the typed amount was already net of the receipt, so the opening charge
--                is typed + receipt and the receipt is applied to it (owed = typed).
--   keep_owed:   the typed amount did not count the receipt, so the opening charge is the
--                typed amount and the receipt is applied to it (owed = typed - receipt).
-- Either way the receipt keeps its real date or unknown-date marker.
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

-- PROVENANCE: the amount the landlord typed and each earlier receipt's answer, kept with
-- the adoption so the statement can show why the opening entry differs from what was typed.
alter table public.tenancy_adoptions
  add column typed_opening_cents bigint,
  add column earlier_receipts jsonb;

-- True when a setup receipt predates the first itemized period (or has no known date).
create function public._receipt_before_itemized(p_payment jsonb, p_itemized_start date)
returns boolean language sql immutable set search_path = public as $$
  select p_itemized_start is not null and (coalesce((p_payment->>'receipt_date_unknown')::boolean, false)
    or p_payment->>'received_at' is null or left(p_payment->>'received_at', 10)::date < p_itemized_start)
$$;
grant execute on function public._receipt_before_itemized(jsonb,date) to authenticated, service_role, tenancy_date_writer, tenancy_setup_writer;

do $migration$
declare body text;
begin
  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    $old$      if exists (select 1 from jsonb_array_elements(coalesce(p_intent->'payments','[]')) p
        where coalesce((p->>'receipt_date_unknown')::boolean, false) or p->>'received_at' is null
          or left(p->>'received_at', 10)::date < (v_period->>'period_start')::date) then
        raise exception 'invalid: a payment before the itemized months is part of the amount owed from before';
      end if;$old$,
    $new$      declare early jsonb; idx integer; answer jsonb; early_keys text[] := '{}';
      begin
        -- Setup previews once without receipts; answers are matched once receipts are present.
        for early, idx in select value, ordinality::integer
          from jsonb_array_elements(coalesce(p_intent->'payments','[]')) with ordinality loop
          if public._receipt_before_itemized(early, (v_period->>'period_start')::date) then
            early_keys := array_append(early_keys, early->>'draft_key');
            if jsonb_array_length(coalesce(early->'allocations','[]')) > 0 then
              raise exception 'invalid: a receipt from before the itemized months is applied to the amount owed from before';
            end if;
            select value into answer from jsonb_array_elements(coalesce(r->'opening_balance'->'earlier_receipts','[]'))
              where value->>'payment_key' = early->>'draft_key' and value->>'choice' in ('add_to_owed','keep_owed');
            if answer is null then
              v_findings := v_findings || jsonb_build_array(jsonb_build_object(
                'rule_id','opening_receipt_unanswered:'||(early->>'draft_key'),'severity','error',
                'message','Say whether the amount owed from before already counts this receipt.','reason_required',false,
                'values',jsonb_build_object('payment_index',idx-1,'draft_key',early->>'draft_key',
                  'amount_cents',(early->>'amount_cents')::bigint,'received_at',early->'received_at')));
            end if;
          end if;
        end loop;
        if jsonb_typeof(coalesce(r->'opening_balance'->'earlier_receipts','[]')) <> 'array' or exists (
          select 1 from jsonb_array_elements(coalesce(r->'opening_balance'->'earlier_receipts','[]')) e
          where e - array['payment_key','choice'] <> '{}' or e->>'choice' not in ('add_to_owed','keep_owed')
            or (jsonb_array_length(coalesce(p_intent->'payments','[]')) > 0 and not (e->>'payment_key' = any(early_keys)))) then
          raise exception 'invalid: each earlier-receipt answer names one receipt from before the itemized months and add_to_owed or keep_owed';
        end if;
      end;$new$);
  body := pg_temp.patched(body,
    $old$      if r->'opening_balance'->>'itemize_from' is null then
        raise exception 'invalid: opening balance and itemized history are exclusive';
      end if;$old$,
    $new$      if r->'opening_balance'->>'itemize_from' is null then
        raise exception 'invalid: opening balance and itemized history are exclusive';
      end if;
      if (r->'opening_balance') - array['amount_cents','basis','includes_current_rent','itemize_from','earlier_receipts'] <> '{}' then
        raise exception 'invalid: an amount owed from before itemized months needs the starting-balance ledger, a virgin timeline and testimony';
      end if;$new$);
  execute body;

  -- Setup matches receipts to charges itself; a receipt from before the itemized months
  -- is left for the commit to apply to the opening entry.
  body := pg_get_functiondef('public.preview_tenancy_setup_session(uuid,uuid,jsonb)'::regprocedure);
  body := pg_temp.patched(body, $old$    amount_left:=(p->>'amount_cents')::bigint;allocs:='[]';$old$,
    $new$    amount_left:=(p->>'amount_cents')::bigint;allocs:='[]';
    if r->'opening_balance'->>'itemize_from' is not null and public._receipt_before_itemized(p,
      (public._billing_period(r, r->'opening_balance'->>'itemize_from')->>'period_start')::date) then
      payments:=payments||jsonb_build_array(p||jsonb_build_object('allocations','[]'::jsonb,'entry_source','entered_at_setup'));
      continue;
    end if;$new$);
  execute body;

  body := pg_get_functiondef('public.commit_billing_setup(uuid,uuid,jsonb,text,text)'::regprocedure);
  body := pg_temp.patched(body,
    'insert into public.tenancy_adoptions(account_id,tenancy_id,adoption_date,opening_balance_cents,currency,balance_basis,includes_current_rent,opening_on)',
    'insert into public.tenancy_adoptions(account_id,tenancy_id,adoption_date,opening_balance_cents,currency,balance_basis,includes_current_rent,opening_on,typed_opening_cents,earlier_receipts)');
  body := pg_temp.patched(body,
    $old$        coalesce((r->'opening_balance'->>'amount_cents')::bigint,0),r->>'currency',$old$,
    $new$        coalesce((r->'opening_balance'->>'amount_cents')::bigint,0) + coalesce((select sum((rp->>'amount_cents')::bigint)
          from jsonb_array_elements(coalesce(p_intent->'payments','[]')) rp
          join jsonb_array_elements(coalesce(r->'opening_balance'->'earlier_receipts','[]')) ans
            on ans->>'payment_key' = rp->>'draft_key' and ans->>'choice' = 'add_to_owed'),0),r->>'currency',$new$);
  body := pg_temp.patched(body,
    $old$          then (public._billing_period(r, r->'opening_balance'->>'itemize_from')->>'period_start')::date - 1 end)
        returning id into v_adoption_id;$old$,
    $new$          then (public._billing_period(r, r->'opening_balance'->>'itemize_from')->>'period_start')::date - 1 end,
        case when jsonb_array_length(coalesce(r->'opening_balance'->'earlier_receipts','[]')) > 0
          then (r->'opening_balance'->>'amount_cents')::bigint end,
        (select jsonb_agg(ans || jsonb_build_object('amount_cents',(rp->>'amount_cents')::bigint,'received_at',rp->'received_at',
            'receipt_date_unknown',coalesce((rp->>'receipt_date_unknown')::boolean,false)) order by ans->>'payment_key')
          from jsonb_array_elements(coalesce(r->'opening_balance'->'earlier_receipts','[]')) ans
          join jsonb_array_elements(coalesce(p_intent->'payments','[]')) rp on rp->>'draft_key' = ans->>'payment_key'))
        returning id into v_adoption_id;$new$);
  -- After the receipts exist, apply each answered earlier receipt to the opening entry,
  -- oldest first; anything beyond the opening charge stays unapplied credit.
  body := pg_temp.patched(body,
    $old$  for a in select value from jsonb_array_elements(coalesce(p_intent->'credit_allocations','[]')) loop$old$,
    $new$  declare opening public.charges; early jsonb; left_cents bigint; applied bigint;
  begin
    select * into opening from public.charges where account_id = p_account_id and opening_adoption_id = v_adoption_id
      and type = 'opening_balance';
    if found then
      left_cents := opening.amount_cents;
      for early in select rp from jsonb_array_elements(coalesce(p_intent->'payments','[]')) rp
        join jsonb_array_elements(coalesce(r->'opening_balance'->'earlier_receipts','[]')) ans on ans->>'payment_key' = rp->>'draft_key'
        order by rp->>'received_at' nulls first, rp->>'draft_key' loop
        applied := least(left_cents, (early->>'amount_cents')::bigint);
        exit when applied <= 0;
        insert into public.payment_allocations(account_id,payment_id,charge_id,amount_cents)
        values (p_account_id,(v_payment_ids->>(early->>'draft_key'))::uuid,opening.id,applied) returning id into v_id;
        v_alloc_ids := array_append(v_alloc_ids,v_id);
        left_cents := left_cents - applied;
      end loop;
    end if;
  end;
  for a in select value from jsonb_array_elements(coalesce(p_intent->'credit_allocations','[]')) loop$new$);
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
