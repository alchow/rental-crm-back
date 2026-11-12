begin;

-- An amount owed from before plus itemized recent months. The opening amount covers
-- every cycle before opening_balance.itemize_from; itemized charges and receipts
-- cover that month onward. INVARIANT: no cycle is in both, and no receipt dated
-- before the itemized months is recorded beside a net amount that already counts it.
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

-- PROVENANCE: the day the opening entry is dated when it precedes itemized months.
alter table public.tenancy_adoptions add column opening_on date;

create or replace function public._materialize_opening_balance(p_adoption public.tenancy_adoptions)
returns void language plpgsql set search_path = public as $$
begin
  if p_adoption.deleted_at is not null or p_adoption.opening_balance_cents = 0 then return; end if;
  if p_adoption.opening_balance_cents > 0 then
    insert into public.charges(account_id, tenancy_id, type, amount_cents, currency, due_date,
      description, opening_adoption_id, opening_category)
    values (p_adoption.account_id, p_adoption.tenancy_id, 'opening_balance', p_adoption.opening_balance_cents,
      p_adoption.currency, coalesce(p_adoption.opening_on, p_adoption.adoption_date), 'Entered at setup', p_adoption.id,
      case lower(btrim(p_adoption.balance_basis))
        when 'rent' then 'rent' when 'fees' then 'fees' when 'utilities' then 'utilities'
        when 'several' then 'mixed' when 'mixed' then 'mixed' else 'unspecified' end)
    on conflict (account_id, opening_adoption_id) where opening_adoption_id is not null do nothing;
  else
    insert into public.payments(account_id, tenancy_id, amount_cents, currency, method, received_at,
      receipt_date_unknown, entry_source, opening_adoption_id, opening_credit_on)
    values (p_adoption.account_id, p_adoption.tenancy_id, -p_adoption.opening_balance_cents,
      p_adoption.currency, null, null, true, 'opening_credit', p_adoption.id,
      coalesce(p_adoption.opening_on, p_adoption.adoption_date))
    on conflict (account_id, opening_adoption_id) where opening_adoption_id is not null do nothing;
  end if;
end;
$$;
revoke all on function public._materialize_opening_balance(public.tenancy_adoptions) from public, anon, authenticated, service_role;

do $migration$
declare body text;
begin
  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    'elsif r->''opening_balance'' is not null then raise exception ''invalid: opening balance and itemized history are exclusive''; end if;',
    $patch$elsif r->'opening_balance' is not null then
      if r->'opening_balance'->>'itemize_from' is null then
        raise exception 'invalid: opening balance and itemized history are exclusive';
      end if;
      if v_existing_money or coalesce((r->'opening_balance'->>'amount_cents')::bigint, 0) = 0
        or length(btrim(coalesce(r->'opening_balance'->>'basis',''))) not between 1 and 200
        or r->'opening_balance'->>'includes_current_rent' is not null
        or not exists (select 1 from public.accounts where id = p_account_id and opening_balance_ledger_enabled) then
        raise exception 'invalid: an amount owed from before itemized months needs the starting-balance ledger, a virgin timeline and testimony';
      end if;
      if r->'opening_balance'->>'itemize_from' !~ '^\d{4}-(0[1-9]|1[0-2])$'
        or r->'opening_balance'->>'itemize_from' > to_char(v_today, 'YYYY-MM') then
        raise exception 'invalid: start itemizing from a past or current month';
      end if;
      v_period := public._billing_period_for_tenancy(p_account_id, t.id, r, r->'opening_balance'->>'itemize_from');
      if v_period is null or (v_period->>'period_start')::date <= v_start then
        raise exception 'invalid: start itemizing after the first billed month';
      end if;
      if exists (select 1 from jsonb_array_elements(coalesce(p_intent->'payments','[]')) p
        where coalesce((p->>'receipt_date_unknown')::boolean, false) or p->>'received_at' is null
          or left(p->>'received_at', 10)::date < (v_period->>'period_start')::date) then
        raise exception 'invalid: a payment before the itemized months is part of the amount owed from before';
      end if;
    end if;$patch$);
  -- Cycles before the itemized months are covered by the amount owed from before.
  body := pg_temp.patched(body,
    'if v_period is not null then
        select value into v_key',
    'if v_period is not null and (r->''opening_balance''->>''itemize_from'' is null
        or v_period->>''cycle_key'' >= r->''opening_balance''->>''itemize_from'') then
        select value into v_key');
  body := pg_temp.patched(body,
    'if v_period is null then raise exception ''invalid: selected cycle outside schedule coverage''; end if;',
    'if v_period is null then raise exception ''invalid: selected cycle outside schedule coverage''; end if;
      if v_key->>''cycle_key'' < r->''opening_balance''->>''itemize_from'' then
        raise exception ''invalid: a selected month is covered by the amount owed from before''; end if;');
  body := pg_temp.patched(body,
    'if v_period is null then raise exception ''invalid: override outside coverage''; end if;',
    'if v_period is null then raise exception ''invalid: override outside coverage''; end if;
      if v_elem->>''cycle_key'' < r->''opening_balance''->>''itemize_from'' then
        raise exception ''invalid: a selected month is covered by the amount owed from before''; end if;');
  execute body;

  body := pg_get_functiondef('public.commit_billing_setup(uuid,uuid,jsonb,text,text)'::regprocedure);
  body := pg_temp.patched(body, 'adoption_date,opening_balance_cents,currency,balance_basis,includes_current_rent)',
    'adoption_date,opening_balance_cents,currency,balance_basis,includes_current_rent,opening_on)');
  body := pg_temp.patched(body,
    'then (r->''opening_balance''->>''includes_current_rent'')::boolean end) returning id into v_adoption_id',
    'then (r->''opening_balance''->>''includes_current_rent'')::boolean end,
        case when r->''opening_balance''->>''itemize_from'' is not null
          then (public._billing_period(r, r->''opening_balance''->>''itemize_from'')->>''period_start'')::date - 1 end)
        returning id into v_adoption_id');
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
