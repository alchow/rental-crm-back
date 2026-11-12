begin;

alter table public.accounts add column opening_balance_ledger_enabled boolean not null default false;
alter table public.tenancy_adoptions add column includes_current_rent boolean;
alter table public.charges
  add column opening_adoption_id uuid,
  add column opening_category text,
  add constraint charges_opening_adoption_fk foreign key (account_id, opening_adoption_id)
    references public.tenancy_adoptions(account_id, id),
  add constraint charges_opening_provenance check (
    (type = 'opening_balance') = (opening_adoption_id is not null)
    and (opening_category is null or opening_category in ('rent','fees','utilities','mixed','unspecified'))
    and (type <> 'opening_balance' or
      (opening_category is not null and period_start is null and period_end is null and source_schedule_id is null and parent_charge_id is null))
  ),
  drop constraint charges_type_check,
  add constraint charges_type_check check (type in (
    'rent','late_fee','deposit','utility','parking','repair_chargeback','nsf_fee','other','opening_balance'
  ));
create unique index charges_one_per_opening_adoption on public.charges(account_id, opening_adoption_id)
  where opening_adoption_id is not null;

alter table public.payments
  add column opening_adoption_id uuid,
  add column opening_credit_on date,
  alter column method drop not null,
  add constraint payments_opening_adoption_fk foreign key (account_id, opening_adoption_id)
    references public.tenancy_adoptions(account_id, id),
  drop constraint payments_entry_source,
  add constraint payments_entry_source check (entry_source in ('manual','entered_at_setup','import','opening_credit')),
  add constraint payments_opening_provenance check (
    case when entry_source = 'opening_credit' then
      opening_adoption_id is not null and opening_credit_on is not null and received_at is null
      and method is null and payer_tenant_id is null and processor_ref is null
    else opening_adoption_id is null and opening_credit_on is null and method is not null end
  );
create unique index payments_one_per_opening_adoption on public.payments(account_id, opening_adoption_id)
  where opening_adoption_id is not null;

create function public._materialize_opening_balance(p_adoption public.tenancy_adoptions)
returns void language plpgsql set search_path = public as $$
begin
  if p_adoption.deleted_at is not null or p_adoption.opening_balance_cents = 0 then return; end if;
  if p_adoption.opening_balance_cents > 0 then
    insert into public.charges(account_id, tenancy_id, type, amount_cents, currency, due_date,
      description, opening_adoption_id, opening_category)
    values (p_adoption.account_id, p_adoption.tenancy_id, 'opening_balance', p_adoption.opening_balance_cents,
      p_adoption.currency, p_adoption.adoption_date, 'Entered at setup', p_adoption.id,
      case lower(btrim(p_adoption.balance_basis))
        when 'rent' then 'rent' when 'fees' then 'fees' when 'utilities' then 'utilities'
        when 'several' then 'mixed' when 'mixed' then 'mixed' else 'unspecified' end)
    on conflict (account_id, opening_adoption_id) where opening_adoption_id is not null do nothing;
  else
    insert into public.payments(account_id, tenancy_id, amount_cents, currency, method, received_at,
      receipt_date_unknown, entry_source, opening_adoption_id, opening_credit_on)
    values (p_adoption.account_id, p_adoption.tenancy_id, -p_adoption.opening_balance_cents,
      p_adoption.currency, null, null, true, 'opening_credit', p_adoption.id, p_adoption.adoption_date)
    on conflict (account_id, opening_adoption_id) where opening_adoption_id is not null do nothing;
  end if;
end;
$$;
revoke all on function public._materialize_opening_balance(public.tenancy_adoptions) from public, anon, authenticated, service_role;

create function public._record_opening_balance_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  enabled boolean;
begin
  -- Serialize the flag read with the per-account backfill so new setups cannot miss it.
  select opening_balance_ledger_enabled into enabled from public.accounts where id = new.account_id for share;
  if enabled then perform public._materialize_opening_balance(new); end if;
  return new;
end;
$$;
revoke all on function public._record_opening_balance_ledger() from public, anon, authenticated, service_role;
create trigger tenancy_adoptions_record_opening_balance after insert on public.tenancy_adoptions
  for each row execute function public._record_opening_balance_ledger();

create function public._guard_opening_balance_provenance() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.opening_adoption_id is not null and current_user <> 'postgres' then
      raise exception 'Opening ledger entries must originate at setup' using errcode = '42501';
    end if;
  elsif new.opening_adoption_id is distinct from old.opening_adoption_id
    or (old.opening_adoption_id is not null and
      (new.account_id, new.tenancy_id, new.amount_cents, new.currency)
      is distinct from (old.account_id, old.tenancy_id, old.amount_cents, old.currency)) then
    raise exception 'Opening ledger entry provenance is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public._guard_opening_balance_provenance() from public, anon, authenticated, service_role;
create trigger charges_opening_balance_provenance before insert or update on public.charges
  for each row execute function public._guard_opening_balance_provenance();
create trigger payments_opening_balance_provenance before insert or update on public.payments
  for each row execute function public._guard_opening_balance_provenance();

create function public._guard_opening_balance_parent() returns trigger
language plpgsql set search_path = public as $$
begin
  -- INVARIANT: a starting balance is owed but never late, so nothing derives from it.
  if new.parent_charge_id is not null and exists (select 1 from public.charges p
    where p.account_id = new.account_id and p.id = new.parent_charge_id and p.type = 'opening_balance') then
    raise exception 'invalid: a starting balance cannot take a late fee' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public._guard_opening_balance_parent() from public, anon, authenticated, service_role;
create trigger charges_opening_balance_parent before insert or update of parent_charge_id on public.charges
  for each row execute function public._guard_opening_balance_parent();

-- Replaces each anchor exactly p_count times so a changed body fails the migration.
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

-- Both setup entry points use the same planner. Its current-period candidate
-- is committed alongside the starting balance and shares normal cycle uniqueness.
do $migration$
declare body text; anchor text;
begin
  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  anchor := '    v_snapshot := jsonb_build_object';
  body := pg_temp.patched(body, anchor, $patch$
    -- The current-month question applies only to an amount owed on a flagged account.
    if r->>'history_mode' = 'opening_balance' then
      if jsonb_typeof(r->'opening_balance'->'includes_current_rent') not in ('boolean', 'null')
        or ((r->'opening_balance'->>'amount_cents')::bigint <= 0
          and r->'opening_balance'->>'includes_current_rent' is not null) then
        raise exception 'invalid: only an amount owed says whether it includes this month''s rent';
      end if;
      if (r->'opening_balance'->>'amount_cents')::bigint > 0
        and r->'opening_balance'->>'includes_current_rent' is null
        and exists (select 1 from public.accounts where id = p_account_id and opening_balance_ledger_enabled) then
        raise exception 'invalid: say whether the amount owed includes this month''s rent';
      end if;
    end if;
    if r->>'history_mode' = 'opening_balance'
      and r->'opening_balance'->>'includes_current_rent' = 'false'
      and exists (select 1 from public.accounts where id = p_account_id and opening_balance_ledger_enabled) then
      v_period := public._billing_period(r, to_char(v_today, 'YYYY-MM'));
      if v_period is null then
        raise exception 'invalid: choose billing coverage that includes this month to add its rent';
      end if;
      if (v_period->>'needs_override')::boolean then
        v_findings := v_findings || jsonb_build_array(jsonb_build_object(
          'rule_id','partial_period:'||(v_period->>'cycle_key'),'severity','error',
          'message','Confirm this month’s rent amount before adding it.','reason_required',false));
      elsif (v_period->>'amount_cents')::bigint > 0 then
        v_candidates := v_candidates || jsonb_build_array(v_period-'needs_override' ||
          jsonb_build_object('draft_key','opening_current_rent'));
      end if;
    end if;
$patch$ || anchor);
  -- A recorded starting balance is not an unscheduled history overlap.
  body := pg_temp.patched(body,
    'and c->>''voided_at'' is null and c->>''deleted_at'' is null and c->>''type'' <> ''deposit'') then',
    'and c->>''voided_at'' is null and c->>''deleted_at'' is null and c->>''type'' not in (''deposit'',''opening_balance'')) then');
  execute body;

  body := pg_get_functiondef('public.commit_billing_setup(uuid,uuid,jsonb,text,text)'::regprocedure);
  body := pg_temp.patched(body, 'adoption_date,opening_balance_cents,currency,balance_basis)',
    'adoption_date,opening_balance_cents,currency,balance_basis,includes_current_rent)');
  body := pg_temp.patched(body, 'r->''opening_balance''->>''basis'') returning id into v_adoption_id',
    $patch$r->'opening_balance'->>'basis',case when exists (select 1 from public.accounts
        where id = p_account_id and opening_balance_ledger_enabled)
        then (r->'opening_balance'->>'includes_current_rent')::boolean end) returning id into v_adoption_id$patch$);
  execute body;

  body := pg_get_functiondef('public.generate_rent_charges(uuid,timestamp with time zone)'::regprocedure);
  anchor := '    insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,source_schedule_id,cycle_key)';
  body := pg_temp.patched(body, anchor, $patch$
    if exists (select 1 from public.tenancy_adoptions a join public.accounts ac on ac.id = a.account_id
      where a.account_id = p_account_id and a.tenancy_id = s.tenancy_id and a.deleted_at is null
        and ac.opening_balance_ledger_enabled and a.includes_current_rent
        and v_start < (date_trunc('month', a.adoption_date) + interval '1 month')::date) then continue; end if;
$patch$ || anchor);
  execute body;

  body := pg_get_functiondef('public.rent_rollup(uuid,text[],date)'::regprocedure);
  body := pg_temp.patched(body, 'cb.type<>''deposit'' and cb.due_date<p_as_of',
    'cb.type not in (''deposit'',''opening_balance'') and cb.due_date<p_as_of');
  body := pg_temp.patched(body, 'cb.type<>''deposit'' and cb.due_date=p_as_of',
    'cb.type not in (''deposit'',''opening_balance'') and cb.due_date=p_as_of');
  body := pg_temp.patched(body, 'cb.type<>''deposit'' and cb.due_date>p_as_of',
    'cb.type not in (''deposit'',''opening_balance'') and cb.due_date>p_as_of');
  body := pg_temp.patched(body, 'coalesce(sum(cb.allocated),0)::bigint as total_allocated',
    'coalesce(sum(cb.balance) filter(where cb.type=''opening_balance''),0)::bigint as opening_owed_cents,
      coalesce(sum(cb.allocated),0)::bigint as total_allocated');
  body := pg_temp.patched(body, '''deposit_owed_cents'',coalesce(b.deposit_owed_cents,0)',
    '''opening_owed_cents'',coalesce(b.opening_owed_cents,0),''deposit_owed_cents'',coalesce(b.deposit_owed_cents,0)');
  body := pg_temp.patched(body, 'a.opening_balance_cents,''currency'',a.currency', $patch$
      a.opening_balance_cents,'recorded_in_ledger',(
        exists(select 1 from public.charges c where c.account_id=a.account_id and c.opening_adoption_id=a.id)
        or exists(select 1 from public.payments p where p.account_id=a.account_id and p.opening_adoption_id=a.id)
      ),'currency',a.currency$patch$);
  body := pg_temp.patched(body, 'coalesce(ad.opening_balance_cents,0)<>0',
    '(coalesce(ad.opening_balance_cents,0)<>0 and not coalesce((ad.adoption->>''recorded_in_ledger'')::boolean,false))');
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
