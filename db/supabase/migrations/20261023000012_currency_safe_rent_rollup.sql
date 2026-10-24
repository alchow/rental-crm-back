-- One cursor row per tenancy; amounts stay in their recorded currencies.
drop function public.rent_rollup(uuid,text[],date);
create function public.rent_rollup(p_account_id uuid,
  p_statuses text[] default array['active','holdover'],
  p_as_of date default (now() at time zone 'UTC')::date)
returns table(tenancy_id uuid,status text,currency text,rent_balance_cents bigint,
  deposit_balance_cents bigint,unapplied_credit_cents bigint,non_deposit_overdue_cents bigint,
  non_deposit_due_today_cents bigint,non_deposit_upcoming_cents bigint,
  deposit_owed_cents bigint,deposit_held_cents bigint,currency_totals jsonb,
  has_other_currency_balance boolean,adoption jsonb)
language sql stable set search_path = public as $$
  with t as (
    select id,status from public.tenancy_current where account_id=p_account_id and deleted_at is null
      and status=any(coalesce(p_statuses,array['active','holdover']))
  ),
  live_charges as (
    select c.id,c.tenancy_id,c.currency,c.type,c.amount_cents,c.due_date from public.charges c
      join t on t.id=c.tenancy_id where c.account_id=p_account_id and c.deleted_at is null and c.voided_at is null
  ),
  allocation_totals as (
    select c.id as charge_id,c.tenancy_id,c.currency,sum(a.amount_cents)::bigint as allocated
      from live_charges c join public.payment_allocations a on a.account_id=p_account_id and a.charge_id=c.id
      join public.payments p on p.account_id=a.account_id and p.id=a.payment_id and p.tenancy_id=c.tenancy_id and p.currency=c.currency
      where a.deleted_at is null and a.voided_at is null and p.deleted_at is null and p.voided_at is null
      group by c.id,c.tenancy_id,c.currency
  ),
  charge_balances as (
    select c.*,coalesce(a.allocated,0)::bigint as allocated,(c.amount_cents-coalesce(a.allocated,0))::bigint as balance
      from live_charges c left join allocation_totals a on a.charge_id=c.id
  ),
  balances as (
    select cb.tenancy_id,cb.currency,
      coalesce(sum(cb.balance) filter(where cb.type<>'deposit'),0)::bigint as rent_balance_cents,
      coalesce(sum(cb.balance) filter(where cb.type='deposit'),0)::bigint as deposit_owed_cents,
      coalesce(sum(cb.allocated) filter(where cb.type='deposit'),0)::bigint as deposit_held_cents,
      coalesce(sum(cb.balance) filter(where cb.type<>'deposit' and cb.due_date<p_as_of),0)::bigint as non_deposit_overdue_cents,
      coalesce(sum(cb.balance) filter(where cb.type<>'deposit' and cb.due_date=p_as_of),0)::bigint as non_deposit_due_today_cents,
      coalesce(sum(cb.balance) filter(where cb.type<>'deposit' and cb.due_date>p_as_of),0)::bigint as non_deposit_upcoming_cents,
      coalesce(sum(cb.allocated),0)::bigint as total_allocated
      from charge_balances cb group by cb.tenancy_id,cb.currency
  ),
  receipts as (
    select p.tenancy_id,p.currency,sum(p.amount_cents)::bigint as received from public.payments p join t on t.id=p.tenancy_id
      where p.account_id=p_account_id and p.deleted_at is null and p.voided_at is null group by p.tenancy_id,p.currency
  ),
  adopted as (
    select a.tenancy_id,a.currency,a.opening_balance_cents,jsonb_build_object('adoption_date',a.adoption_date,
      'opening_balance_cents',a.opening_balance_cents,'currency',a.currency,'balance_basis',a.balance_basis,
      'needs_review',a.needs_review,'created_at',a.created_at) as adoption
      from public.tenancy_adoptions a join t on t.id=a.tenancy_id
      where a.account_id=p_account_id and a.deleted_at is null
  ),
  available as (
    select c.tenancy_id,c.currency from public.charges c join t on t.id=c.tenancy_id where c.account_id=p_account_id and c.deleted_at is null
    union select p.tenancy_id,p.currency from public.payments p join t on t.id=p.tenancy_id where p.account_id=p_account_id and p.deleted_at is null
    union select tenancy_id,currency from adopted
    union select s.tenancy_id,s.currency from public.rent_schedules s join t on t.id=s.tenancy_id
      where s.account_id=p_account_id and s.deleted_at is null and s.kind='rent'
        and s.start_date<=(now() at time zone 'UTC')::date and (s.end_date is null or s.end_date>=(now() at time zone 'UTC')::date)
  ),
  currency_rows as (
    select a.tenancy_id,a.currency,jsonb_build_object('currency',a.currency,
      'rent_balance_cents',coalesce(b.rent_balance_cents,0),'deposit_balance_cents',coalesce(b.deposit_owed_cents,0),
      'unapplied_credit_cents',coalesce(r.received,0)-coalesce(b.total_allocated,0),
      'non_deposit_overdue_cents',coalesce(b.non_deposit_overdue_cents,0),
      'non_deposit_due_today_cents',coalesce(b.non_deposit_due_today_cents,0),
      'non_deposit_upcoming_cents',coalesce(b.non_deposit_upcoming_cents,0),
      'deposit_owed_cents',coalesce(b.deposit_owed_cents,0),'deposit_held_cents',coalesce(b.deposit_held_cents,0)) as totals
      from available a left join balances b on b.tenancy_id=a.tenancy_id and b.currency=a.currency
      left join receipts r on r.tenancy_id=a.tenancy_id and r.currency=a.currency
  ),
  primary_currency as (
    select t.id,coalesce((select s.currency from public.rent_schedules s where s.account_id=p_account_id and s.tenancy_id=t.id
      and s.deleted_at is null and s.kind='rent' and s.start_date<=(now() at time zone 'UTC')::date
      and (s.end_date is null or s.end_date>=(now() at time zone 'UTC')::date)
      order by s.start_date desc,s.created_at desc,s.id desc limit 1),
      (select min(a.currency) from available a where a.tenancy_id=t.id)) as currency from t
  )
  select t.id,t.status,pc.currency,
    coalesce((cr.totals->>'rent_balance_cents')::bigint,0),coalesce((cr.totals->>'deposit_balance_cents')::bigint,0),
    coalesce((cr.totals->>'unapplied_credit_cents')::bigint,0),coalesce((cr.totals->>'non_deposit_overdue_cents')::bigint,0),
    coalesce((cr.totals->>'non_deposit_due_today_cents')::bigint,0),coalesce((cr.totals->>'non_deposit_upcoming_cents')::bigint,0),
    coalesce((cr.totals->>'deposit_owed_cents')::bigint,0),coalesce((cr.totals->>'deposit_held_cents')::bigint,0),
    coalesce((select jsonb_agg(x.totals order by x.currency) from currency_rows x where x.tenancy_id=t.id),'[]'),
    exists(select 1 from currency_rows x where x.tenancy_id=t.id and x.currency is distinct from pc.currency
      and ((x.totals->>'rent_balance_cents')::bigint>0 or (x.totals->>'deposit_owed_cents')::bigint>0)),
    ad.adoption
    from t join primary_currency pc on pc.id=t.id
    left join currency_rows cr on cr.tenancy_id=t.id and cr.currency=pc.currency
    left join adopted ad on ad.tenancy_id=t.id
    where t.status<>'ended' or coalesce(ad.opening_balance_cents,0)<>0 or exists(select 1 from currency_rows x where x.tenancy_id=t.id
      and ((x.totals->>'rent_balance_cents')::bigint<>0 or (x.totals->>'deposit_owed_cents')::bigint<>0
        or (x.totals->>'deposit_held_cents')::bigint<>0 or (x.totals->>'unapplied_credit_cents')::bigint<>0))
$$;
revoke all on function public.rent_rollup(uuid,text[],date) from public,anon;
grant execute on function public.rent_rollup(uuid,text[],date) to authenticated,service_role;
