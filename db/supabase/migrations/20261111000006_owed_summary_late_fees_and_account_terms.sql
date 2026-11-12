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

comment on policy idempotency_keys_member_release on public.idempotency_keys is
  'Any account member may release an unfinished key: the table records no requesting user, so the policy cannot narrow to the caller''s own keys.';

-- WP-07: whether a period's amount is the proration suggestion or the landlord's own.
alter table public.rent_schedule_period_overrides add column amount_source text
  check (amount_source in ('suggested', 'landlord'));

-- WP-15: the account's currency and whether it records more than one.
alter table public.accounts
  add column currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  add column multi_currency boolean not null default false;
grant update (currency, multi_currency) on public.accounts to authenticated;

do $migration$
declare body text; multi_count integer; non_usd_count integer;
begin
  body := pg_get_functiondef('public.commit_billing_setup(uuid,uuid,jsonb,text,text)'::regprocedure);
  body := pg_temp.patched(body,
    'insert into public.rent_schedule_period_overrides(account_id,tenancy_id,schedule_id,cycle_key,period_start,period_end,due_date,amount_cents,reason)',
    'insert into public.rent_schedule_period_overrides(account_id,tenancy_id,schedule_id,cycle_key,period_start,period_end,due_date,amount_cents,reason,amount_source)');
  body := pg_temp.patched(body, '(e->>''due_date'')::date,(e->>''amount_cents'')::bigint,e->>''reason'');',
    '(e->>''due_date'')::date,(e->>''amount_cents'')::bigint,e->>''reason'',e->>''amount_source'');');
  -- WP-20: a setup receipt may name who paid.
  body := pg_temp.patched(body,
    'insert into public.payments(account_id,tenancy_id,amount_cents,currency,received_at,method,reference,notes,receipt_date_unknown,entry_source)',
    'insert into public.payments(account_id,tenancy_id,amount_cents,currency,received_at,method,reference,notes,receipt_date_unknown,entry_source,payer_tenant_id)');
  body := pg_temp.patched(body,
    'coalesce((e->>''receipt_date_unknown'')::boolean,false),coalesce(e->>''entry_source'',''manual'')) returning id into v_payment;',
    'coalesce((e->>''receipt_date_unknown'')::boolean,false),coalesce(e->>''entry_source'',''manual''),(e->>''payer_tenant_id'')::uuid) returning id into v_payment;');
  execute body;

  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    'if v_elem - array[''draft_key'',''amount_cents'',''currency'',''received_at'',''method'',''reference'',''notes'',''allocations'',''receipt_date_unknown'',''entry_source''] <> ''{}''',
    'if v_elem - array[''draft_key'',''amount_cents'',''currency'',''received_at'',''method'',''reference'',''notes'',''allocations'',''receipt_date_unknown'',''entry_source'',''payer_tenant_id''] <> ''{}''');
  execute body;

  -- Existing accounts: the currency most of their rent uses; more than one currency recorded marks multi-currency.
  update public.accounts a set currency = c.currency
  from (select distinct on (account_id) account_id, currency from (
      select account_id, currency, count(*) n from (
        select account_id, currency from public.rent_schedules where deleted_at is null
        union all select account_id, rent_currency from public.leases where deleted_at is null and rent_currency is not null
        union all select account_id, currency from public.charges where deleted_at is null) money
      group by account_id, currency) counted
    order by account_id, n desc, currency) c
  where c.account_id = a.id and c.currency ~ '^[A-Z]{3}$';
  update public.accounts a set multi_currency = true where (select count(distinct currency) from (
      select currency from public.rent_schedules s where s.account_id = a.id and s.deleted_at is null
      union select rent_currency from public.leases l where l.account_id = a.id and l.deleted_at is null
      union select deposit_currency from public.leases l where l.account_id = a.id and l.deleted_at is null and l.deposit_amount_cents > 0
      union select currency from public.charges c where c.account_id = a.id and c.deleted_at is null
      union select currency from public.payments p where p.account_id = a.id and p.deleted_at is null) used) > 1;
  select count(*) filter (where multi_currency), count(*) filter (where currency <> 'USD')
    into multi_count, non_usd_count from public.accounts;
  raise notice 'accounts: % marked multi-currency, % with a currency other than USD', multi_count, non_usd_count;
end;
$migration$;

-- WP-23: a landlord's decision not to add a suggested late fee for one rent charge.
-- An added fee is the live late_fee charge parented on the rent charge.
create table public.late_fee_decisions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  charge_id uuid not null,
  decision text not null check (decision = 'skipped'),
  decided_by uuid not null default auth.uid(),
  decided_at timestamptz not null default now(),
  unique (account_id, charge_id),
  foreign key (account_id, charge_id) references public.charges(account_id, id)
);
alter table public.late_fee_decisions enable row level security;
alter table public.late_fee_decisions force row level security;
create policy late_fee_decisions_member_select on public.late_fee_decisions for select
  using (account_id in (select m.account_id from public.account_members m
    where m.user_id = (select auth.uid()) and m.deleted_at is null));
create policy late_fee_decisions_manager_insert on public.late_fee_decisions for insert
  with check (decided_by = (select auth.uid()) and account_id in (select m.account_id from public.account_members m
    where m.user_id = (select auth.uid()) and m.deleted_at is null and m.role in ('owner','manager')));
grant select, insert on public.late_fee_decisions to authenticated;
create trigger late_fee_decisions_audit after insert or update or delete on public.late_fee_decisions
  for each row execute function public._emit_event();

-- Grace and late-fee terms a rent charge was billed under.
create function public._charge_late_terms(p_account_id uuid, p_schedule_id uuid, p_terms jsonb)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'grace_days', coalesce(s.grace_days, (p_terms->'billing'->>'grace_days')::integer),
    'late_fee_policy', coalesce(p_terms->'late_fee_policy', p_terms->'billing'->'late_fee_policy',
      case when s.late_fee_cents is not null then jsonb_build_object('kind','fixed','amount_cents',s.late_fee_cents,'currency',s.currency) end,
      '{"kind":"unknown"}'))
  from (select 1) one left join public.rent_schedules s on s.account_id = p_account_id and s.id = p_schedule_id
$$;
revoke all on function public._charge_late_terms(uuid,uuid,jsonb) from public, anon;
grant execute on function public._charge_late_terms(uuid,uuid,jsonb) to authenticated, service_role;

-- WP-22 and WP-24: one owed summary per tenancy and currency.
-- DATA FLOW: live charges and allocations -> unpaid balance per charge -> due today or
-- earlier counts as owed; past due date + grace is overdue except a starting balance;
-- the next charge is the earliest unpaid future charge or unbilled schedule period.
create function public.owed_summaries(p_account_id uuid, p_tenancy_id uuid default null)
returns table(tenancy_id uuid, currency text, as_of date, total_cents bigint, by_type jsonb,
  overdue_cents bigint, oldest_due_on date, deposit_owed_cents bigint, unapplied_credit_cents bigint,
  next_charge jsonb, rent_tracked boolean)
language sql stable set search_path = public as $$
  with today as (select public._account_date(p_account_id) as d),
  tenancies as (
    select t.id from public.tenancies t where t.account_id = p_account_id and t.deleted_at is null
      and (p_tenancy_id is null or t.id = p_tenancy_id)
  ),
  balances as (
    select c.*, c.amount_cents - coalesce((select sum(a.amount_cents) from public.payment_allocations a
        join public.payments p on p.account_id = a.account_id and p.id = a.payment_id
        where a.account_id = c.account_id and a.charge_id = c.id and a.voided_at is null and a.deleted_at is null
          and p.voided_at is null and p.deleted_at is null), 0) as unpaid
    from public.charges c join tenancies t on t.id = c.tenancy_id
    where c.account_id = p_account_id and c.voided_at is null and c.deleted_at is null
  ),
  due as (
    select b.*, case when b.type = 'rent' then coalesce((public._charge_late_terms(b.account_id, b.source_schedule_id, b.terms_snapshot)->>'grace_days')::integer, 0) else 0 end as grace
    from balances b, today where b.unpaid > 0 and b.due_date <= today.d and b.type <> 'deposit'
  ),
  receipts as (
    select p.tenancy_id, p.currency, sum(p.amount_cents - coalesce((select sum(a.amount_cents) from public.payment_allocations a
        join public.charges c on c.account_id = a.account_id and c.id = a.charge_id
        where a.account_id = p.account_id and a.payment_id = p.id and a.voided_at is null and a.deleted_at is null
          and c.voided_at is null and c.deleted_at is null), 0))::bigint as credit
    from public.payments p join tenancies t on t.id = p.tenancy_id
    where p.account_id = p_account_id and p.voided_at is null and p.deleted_at is null
    group by p.tenancy_id, p.currency
  ),
  schedule_next as (
    select s.tenancy_id, s.currency, (period->>'amount_cents')::bigint as cents, (period->>'due_date')::date as due_on
    from public.rent_schedules s join tenancies t on t.id = s.tenancy_id, today,
      lateral generate_series(-1, 2) as step,
      lateral (select public._move_out_billing_period(s, public._billing_period(public._schedule_billing_intent(s),
        to_char(date_trunc('month', today.d) + make_interval(months => step), 'YYYY-MM'))) as period) p
    where s.account_id = p_account_id and s.deleted_at is null and s.period_policy_version >= 2
      and period is not null and not coalesce((period->>'needs_override')::boolean, false)
      and (period->>'due_date')::date > today.d and (period->>'amount_cents')::bigint > 0
      and not exists (select 1 from public.charges c where c.account_id = s.account_id
        and c.source_schedule_id = s.id and c.cycle_key = period->>'cycle_key')
  ),
  upcoming as (
    select b.tenancy_id, b.currency, b.unpaid as cents, b.due_date as due_on, 'charge' as source
      from balances b, today where b.unpaid > 0 and b.due_date > today.d and b.type <> 'deposit'
    union all select tenancy_id, currency, cents, due_on, 'schedule' from schedule_next
  ),
  keys as (
    select b.tenancy_id, b.currency from balances b
    union select r.tenancy_id, r.currency from receipts r
    union select u.tenancy_id, u.currency from upcoming u
  )
  select k.tenancy_id, k.currency, (select d from today),
    coalesce((select sum(unpaid) from due where due.tenancy_id = k.tenancy_id and due.currency = k.currency), 0)::bigint,
    coalesce((select jsonb_agg(jsonb_build_object('type', type, 'cents', cents) order by type) from (
        select type, sum(unpaid)::bigint as cents from due where due.tenancy_id = k.tenancy_id and due.currency = k.currency
        group by type) grouped), '[]'),
    coalesce((select sum(unpaid) from due, today where due.tenancy_id = k.tenancy_id and due.currency = k.currency
      and due.type <> 'opening_balance' and due.due_date + due.grace < today.d), 0)::bigint,
    (select min(due_date) from due where due.tenancy_id = k.tenancy_id and due.currency = k.currency),
    coalesce((select sum(unpaid) from balances b, today where b.tenancy_id = k.tenancy_id and b.currency = k.currency
      and b.type = 'deposit' and b.unpaid > 0 and b.due_date <= today.d), 0)::bigint,
    coalesce((select credit from receipts r where r.tenancy_id = k.tenancy_id and r.currency = k.currency), 0),
    (select jsonb_build_object('cents', u.cents, 'due_on', u.due_on, 'source', u.source) from upcoming u
      where u.tenancy_id = k.tenancy_id and u.currency = k.currency order by u.due_on, u.source limit 1),
    exists (select 1 from public.rent_schedules s, today where s.account_id = p_account_id and s.tenancy_id = k.tenancy_id
      and s.kind = 'rent' and s.deleted_at is null and (s.end_date is null or s.end_date >= today.d))
  from keys k
$$;
revoke all on function public.owed_summaries(uuid,uuid) from public, anon;
grant execute on function public.owed_summaries(uuid,uuid) to authenticated, service_role;

-- WP-23: suggested late fees, computed on read. Never for a starting balance, never
-- once a fee is added or skipped, never without a recorded grace period.
create function public.late_fee_suggestions(p_account_id uuid, p_tenancy_id uuid default null)
returns table(charge_id uuid, tenancy_id uuid, due_date date, grace_days integer, eligible_on date,
  rent_amount_cents bigint, unpaid_cents bigint, currency text, fee jsonb)
language sql stable set search_path = public as $$
  with today as (select public._account_date(p_account_id) as d),
  rent as (
    select c.*, public._charge_late_terms(c.account_id, c.source_schedule_id, c.terms_snapshot) as terms,
      c.amount_cents - coalesce((select sum(a.amount_cents) from public.payment_allocations a
        join public.payments p on p.account_id = a.account_id and p.id = a.payment_id
        where a.account_id = c.account_id and a.charge_id = c.id and a.voided_at is null and a.deleted_at is null
          and p.voided_at is null and p.deleted_at is null), 0) as unpaid
    from public.charges c
    where c.account_id = p_account_id and c.type = 'rent' and c.voided_at is null and c.deleted_at is null
      and (p_tenancy_id is null or c.tenancy_id = p_tenancy_id)
      and not exists (select 1 from public.charges f where f.account_id = c.account_id and f.parent_charge_id = c.id
        and f.type = 'late_fee' and f.voided_at is null and f.deleted_at is null)
      and not exists (select 1 from public.late_fee_decisions d where d.account_id = c.account_id and d.charge_id = c.id)
  )
  select r.id, r.tenancy_id, r.due_date, (r.terms->>'grace_days')::integer,
    r.due_date + (r.terms->>'grace_days')::integer + 1, r.amount_cents, r.unpaid, r.currency,
    case r.terms->'late_fee_policy'->>'kind'
      when 'fixed' then jsonb_build_object('kind','fixed','amount_cents',(r.terms->'late_fee_policy'->>'amount_cents')::bigint)
      when 'percent' then jsonb_build_object('kind','percent','percent',(r.terms->'late_fee_policy'->>'percent')::numeric,
        'amount_cents',round(r.amount_cents * (r.terms->'late_fee_policy'->>'percent')::numeric / 100)::bigint)
      else jsonb_build_object('kind','other','amount_cents',null,'text',r.terms->'late_fee_policy'->>'text') end
  from rent r, today
  where r.unpaid > 0 and r.terms->>'grace_days' is not null
    and r.terms->'late_fee_policy'->>'kind' in ('fixed','percent','other')
    and today.d > r.due_date + (r.terms->>'grace_days')::integer
    and exists (select 1 from public.tenancies t where t.account_id = r.account_id and t.id = r.tenancy_id and t.deleted_at is null)
$$;
revoke all on function public.late_fee_suggestions(uuid,uuid) from public, anon;
grant execute on function public.late_fee_suggestions(uuid,uuid) to authenticated, service_role;

-- WP-26: properties that look like the one being added. Normalized address: lower case,
-- punctuation removed, whitespace collapsed, common street suffixes abbreviated.
create function public._normalized_address(p_text text)
returns text language sql immutable set search_path = public as $$
  select nullif(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9 ]+', ' ', 'g'),
      '\mstreet\M', 'st', 'g'), '\mavenue\M', 'ave', 'g'), '\mroad\M', 'rd', 'g'), '\mdrive\M', 'dr', 'g'),
      '\mboulevard\M', 'blvd', 'g'), '\mlane\M', 'ln', 'g'), '\mcourt\M', 'ct', 'g'), '\mplace\M', 'pl', 'g'),
      '\mcrescent\M', 'cres', 'g'), '\s+', ' ', 'g')), '')
$$;
grant execute on function public._normalized_address(text) to authenticated, service_role;

create function public.find_duplicate_properties(p_account_id uuid, p_provider_id text, p_address text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('property_id', p.id, 'name', p.name, 'address', p.address,
      'door_count', (select count(*) from public.areas a where a.account_id = p.account_id and a.property_id = p.id
        and a.kind = 'unit' and a.deleted_at is null),
      'matched_on', case when nullif(btrim(p_provider_id), '') is not null and p.address->>'provider_id' = btrim(p_provider_id)
        then 'provider_id' else 'address' end) order by p.created_at), '[]')
  from public.properties p
  where p.account_id = p_account_id and p.deleted_at is null and (
    (nullif(btrim(p_provider_id), '') is not null and p.address->>'provider_id' = btrim(p_provider_id))
    or (public._normalized_address(p_address) is not null and public._normalized_address(p_address) in (
      public._normalized_address(p.name), public._normalized_address(p.address->>'line1'))))
$$;
revoke all on function public.find_duplicate_properties(uuid,text,text) from public, anon;
grant execute on function public.find_duplicate_properties(uuid,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
