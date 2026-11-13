begin;

-- WP-22 (owner decision 2026-11-12): the headline subtracts unapplied credit and keeps
-- deposits separate; credit beyond what is owed is reported, never a negative headline.
-- A starting balance is owed from before setup, so it counts as owed even when its
-- entry is dated later in UTC than the account's local date (set-up day near midnight).
drop function public.owed_summaries(uuid, uuid);
create function public._owed_summaries_base(p_account_id uuid, p_tenancy_id uuid default null)
returns table(tenancy_id uuid, currency text, as_of date, total_cents bigint, by_type jsonb,
  overdue_cents bigint, oldest_due_on date, deposit_owed_cents bigint, unapplied_credit_cents bigint,
  next_charge jsonb, rent_tracked boolean, headline_cents bigint, credit_remaining_cents bigint)
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
    from balances b, today where b.unpaid > 0 and b.type <> 'deposit'
      and (b.due_date <= today.d or b.type = 'opening_balance')
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
      from balances b, today where b.unpaid > 0 and b.due_date > today.d and b.type not in ('deposit','opening_balance')
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
      and s.kind = 'rent' and s.deleted_at is null and (s.end_date is null or s.end_date >= today.d)),
    null::bigint, null::bigint
  from keys k
$$;
revoke all on function public._owed_summaries_base(uuid,uuid) from public, anon;
grant execute on function public._owed_summaries_base(uuid,uuid) to authenticated, service_role;
create function public.owed_summaries(p_account_id uuid, p_tenancy_id uuid default null)
returns table(tenancy_id uuid, currency text, as_of date, total_cents bigint, by_type jsonb,
  overdue_cents bigint, oldest_due_on date, deposit_owed_cents bigint, unapplied_credit_cents bigint,
  next_charge jsonb, rent_tracked boolean, headline_cents bigint, credit_remaining_cents bigint)
language sql stable set search_path = public as $$
  select b.tenancy_id, b.currency, b.as_of, b.total_cents, b.by_type, b.overdue_cents, b.oldest_due_on,
    b.deposit_owed_cents, b.unapplied_credit_cents, b.next_charge, b.rent_tracked,
    greatest(b.total_cents - b.unapplied_credit_cents, 0), greatest(b.unapplied_credit_cents - b.total_cents, 0)
  from public._owed_summaries_base(p_account_id, p_tenancy_id) b
$$;
revoke all on function public.owed_summaries(uuid,uuid) from public, anon;
grant execute on function public.owed_summaries(uuid,uuid) to authenticated, service_role;

-- WP-15 (owner decision 2026-11-12): an unfinished setup draft holding a currency that
-- is not an ISO 4217 code takes the account's currency. Drafts hold no recorded money.
create function pg_temp.iso_drafts(p_value jsonb, p_currency text) returns jsonb
language plpgsql immutable as $$
declare iso constant text[] := array['AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BGN','BHD','BIF','BMD','BND','BOB','BRL','BSD','BTN','BWP','BYN','BZD','CAD','CDF','CHF','CLP','CNY','COP','CRC','CUC','CUP','CVE','CZK','DJF','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP','GBP','GEL','GHS','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HRK','HTG','HUF','IDR','ILS','INR','IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR','KMF','KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR','LRD','LSL','LYD','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','OMR','PAB','PEN','PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD','SCR','SDG','SEK','SGD','SHP','SLE','SLL','SOS','SRD','SSP','STN','SVC','SYP','SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS','UAH','UGX','USD','UYU','UZS','VES','VND','VUV','WST','XAF','XCD','XCG','XDR','XOF','XPF','XSU','YER','ZAR','ZMW','ZWG','ZWL'];
begin
  if jsonb_typeof(p_value) = 'object' then
    return (select coalesce(jsonb_object_agg(k, case
        when k ~ 'currency$' and jsonb_typeof(v) = 'string' and not ((v #>> '{}') = any(iso)) then to_jsonb(p_currency)
        else pg_temp.iso_drafts(v, p_currency) end), '{}') from jsonb_each(p_value) e(k, v));
  elsif jsonb_typeof(p_value) = 'array' then
    return (select coalesce(jsonb_agg(pg_temp.iso_drafts(v, p_currency) order by n), '[]') from jsonb_array_elements(p_value) with ordinality e(v, n));
  end if;
  return p_value;
end;
$$;

do $migration$
declare changed integer;
begin
  update public.tenancy_setup_sessions s
     set payload = pg_temp.iso_drafts(s.payload, a.currency), revision = s.revision + 1, updated_at = clock_timestamp()
    from public.accounts a
   where a.id = s.account_id and s.completed_at is null
     and pg_temp.iso_drafts(s.payload, a.currency) is distinct from s.payload;
  get diagnostics changed = row_count;
  raise notice 'setup drafts: % changed to the account currency', changed;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
