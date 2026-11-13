begin;

-- WP-09 owner decisions 2026-11-12:
-- C. "allow but explain implication": $0 owed before the itemized months is accepted.
--    Months before itemize_from count as paid, are not listed, and cannot be itemized
--    or overridden. No opening entry is written for 0; the adoption still records the
--    statement (opening_on, amount 0). Testimony (basis) is optional for 0. Preview adds
--    an informational finding opening_months_treated_as_paid (severity info: it needs
--    no acknowledgement or reason).
-- D. One combined result across earlier receipts: preview returns opening_result,
--    computed with the same rules the commit applies.
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

-- DATA FLOW: typed amount + receipts answered add_to_owed -> opening entry (a charge when
-- positive, a credit when negative); answered receipts are applied to a charge oldest
-- first up to its amount; what they do not cover is paid ahead (unapplied credit).
create function public._opening_result(p_rent jsonb, p_payments jsonb, p_itemized_start date)
returns jsonb language sql stable set search_path = public as $$
  with early as (
    select (p->>'amount_cents')::bigint as amount, e->>'choice' as choice
    from jsonb_array_elements(coalesce(p_payments, '[]')) p
    left join lateral (select value as e from jsonb_array_elements(coalesce(p_rent->'opening_balance'->'earlier_receipts', '[]'))
      where value->>'payment_key' = p->>'draft_key' and value->>'choice' in ('add_to_owed','keep_owed') limit 1) answer on true
    where public._receipt_before_itemized(p, p_itemized_start)
  ),
  totals as (
    select coalesce((p_rent->'opening_balance'->>'amount_cents')::bigint, 0) as typed,
      coalesce(sum(amount) filter (where choice = 'add_to_owed'), 0)::bigint as added,
      coalesce(sum(amount) filter (where choice is not null), 0)::bigint as answered,
      count(*) filter (where choice is null)::integer as unanswered
    from early
  ),
  result as (
    select typed, answered, unanswered, typed + added as opening,
      case when typed + added > 0 then least(typed + added, answered) else 0 end as applied
    from totals
  )
  select jsonb_build_object(
    'typed_cents', typed,
    'opening_charge_cents', greatest(opening, 0),
    'opening_credit_cents', greatest(-opening, 0),
    'answered_receipts_cents', answered,
    'applied_cents', applied,
    'still_owed_cents', greatest(opening, 0) - applied,
    'paid_ahead_cents', answered - applied + greatest(-opening, 0),
    'unanswered_count', unanswered)
  from result
$$;
revoke all on function public._opening_result(jsonb,jsonb,date) from public, anon;
grant execute on function public._opening_result(jsonb,jsonb,date) to authenticated, service_role, tenancy_date_writer, tenancy_setup_writer;

do $migration$
declare body text;
begin
  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    $old$      if v_existing_money or coalesce((r->'opening_balance'->>'amount_cents')::bigint, 0) = 0
        or length(btrim(coalesce(r->'opening_balance'->>'basis',''))) not between 1 and 200$old$,
    $new$      if v_existing_money or r->'opening_balance'->>'amount_cents' is null
        or ((r->'opening_balance'->>'amount_cents')::bigint <> 0 or r->'opening_balance' ? 'basis')
          and length(btrim(coalesce(r->'opening_balance'->>'basis',''))) not between 1 and 200$new$);
  body := pg_temp.patched(body,
    $old$        raise exception 'invalid: start itemizing after the first billed month';
      end if;$old$,
    $new$        raise exception 'invalid: start itemizing after the first billed month';
      end if;
      if (r->'opening_balance'->>'amount_cents')::bigint = 0 then
        v_findings := v_findings || jsonb_build_array(jsonb_build_object('rule_id','opening_months_treated_as_paid',
          'severity','info','reason_required',false,'fields',jsonb_build_array('rent.opening_balance.amount_cents'),
          'values',jsonb_build_object('itemize_from',r->'opening_balance'->>'itemize_from',
            'first_itemized_start',v_period->>'period_start'),
          'message','Nothing is owed from before the itemized months, so those months are treated as paid and are not listed.'));
      end if;$new$);
  body := pg_temp.patched(body,
    $old$    'transition',case when v_transition then jsonb_build_object('ended_schedule_ids',v_ended,'voided_charge_ids',v_voided) else null end);$old$,
    $new$    'opening_result',case when r->>'decision' = 'configure' and r->'opening_balance'->>'itemize_from' is not null then
      public._opening_result(r, p_intent->'payments',
        (public._billing_period_for_tenancy(p_account_id, t.id, r, r->'opening_balance'->>'itemize_from')->>'period_start')::date) end,
    'transition',case when v_transition then jsonb_build_object('ended_schedule_ids',v_ended,'voided_charge_ids',v_voided) else null end);$new$);
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
