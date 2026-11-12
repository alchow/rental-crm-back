begin;

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

-- The idempotency middleware releases an unfinished placeholder after a 5xx, and after
-- any non-2xx setup confirm. Without a delete policy that release removed nothing
-- under FORCE RLS, so a failed confirm kept its key. A completed receipt stays.
create policy idempotency_keys_member_release on public.idempotency_keys for delete
  using (completed_at is null and account_id in (select m.account_id from public.account_members m
    where m.user_id = (select auth.uid()) and m.deleted_at is null));

-- People already in the account that a setup person may be. Exact means the same
-- normalized email or E.164 phone; possible means the same normalized name only.
-- Runs under the caller's RLS; returns nothing while person_match_enabled is off.
create function public.match_setup_people(p_account_id uuid, p_email text, p_phone text, p_name text)
returns jsonb language sql stable set search_path = public as $$
  with flag as (
    select coalesce((select person_match_enabled from public.accounts where id = p_account_id), false) as enabled
  ),
  wanted as (
    select nullif(lower(btrim(p_email)), '') as email, nullif(btrim(p_phone), '') as phone,
      nullif(lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')), '') as name
  ),
  people as (
    select t.id, t.full_name,
      array_remove(array[
        case when w.email is not null and w.email in (select lower(btrim(e)) from unnest(t.emails) e) then 'email' end,
        case when w.phone is not null and w.phone = any(t.phones) then 'phone' end,
        case when w.name is not null and w.name = lower(regexp_replace(btrim(t.full_name), '\s+', ' ', 'g')) then 'name' end
      ], null) as matched_on
    from public.tenants t cross join wanted w cross join flag f
    where f.enabled and t.account_id = p_account_id and t.deleted_at is null
  ),
  matches as (
    select p.*, (select coalesce(jsonb_agg(x.tenancy order by x.rank, x.start_date desc), '[]') from (
        select jsonb_build_object('tenancy_id', c.id, 'status', c.status, 'start_date', c.start_date,
          'move_out_on', c.move_out_on, 'door_name', a.name, 'property_name', pr.name) as tenancy,
          case c.status when 'active' then 0 when 'holdover' then 0 when 'upcoming' then 1 else 2 end as rank,
          c.start_date
        from public.tenancy_tenants m
        join public.tenancy_current c on c.account_id = m.account_id and c.id = m.tenancy_id and c.deleted_at is null
        join public.areas a on a.account_id = c.account_id and a.id = c.area_id
        left join public.properties pr on pr.account_id = a.account_id and pr.id = a.property_id
        where m.account_id = p_account_id and m.tenant_id = p.id and m.deleted_at is null
        order by 2, 3 desc limit 3) x) as tenancies
    from people p where cardinality(p.matched_on) > 0
  )
  select jsonb_build_object(
    'enabled', (select enabled from flag),
    'exact', coalesce((select jsonb_agg(jsonb_build_object('person_id', id, 'full_name', full_name,
      'matched_on', to_jsonb(matched_on), 'tenancies', tenancies) order by full_name, id)
      from matches where matched_on && array['email','phone']), '[]'),
    'possible', coalesce((select jsonb_agg(jsonb_build_object('person_id', id, 'full_name', full_name,
      'matched_on', to_jsonb(matched_on), 'tenancies', tenancies) order by full_name, id)
      from matches where not (matched_on && array['email','phone'])), '[]'))
$$;
revoke all on function public.match_setup_people(uuid,text,text,text) from public, anon;
grant execute on function public.match_setup_people(uuid,text,text,text) to authenticated;

-- Late fee "percent of the monthly rent" joins the recorded term kinds.
create or replace function public._valid_recorded_term(p_term jsonb, p_due boolean)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(jsonb_typeof(p_term) = 'object' and case p_term->>'kind'
    when 'unknown' then p_term = '{"kind":"unknown"}'::jsonb
    when 'none' then not p_due and p_term = '{"kind":"none"}'::jsonb
    when 'last_day' then p_due and p_term = '{"kind":"last_day"}'::jsonb
    when 'day_of_month' then p_due and p_term - array['kind','day'] = '{}'::jsonb
      and jsonb_typeof(p_term->'day') = 'number' and (p_term->>'day') ~ '^[0-9]+$'
      and (p_term->>'day')::numeric between 1 and 31
    when 'fixed' then not p_due and p_term - array['kind','amount_cents','currency'] = '{}'::jsonb
      and jsonb_typeof(p_term->'amount_cents') = 'number'
      and (p_term->>'amount_cents') ~ '^[0-9]+$' and (p_term->>'amount_cents')::numeric > 0
      and length(p_term->>'currency') = 3
    when 'percent' then not p_due and p_term - array['kind','percent'] = '{}'::jsonb
      and jsonb_typeof(p_term->'percent') = 'number' and (p_term->>'percent')::numeric > 0
      and (p_term->>'percent')::numeric <= 100 and (p_term->>'percent')::numeric = round((p_term->>'percent')::numeric, 2)
    when 'other' then p_term - array['kind','text'] = '{}'::jsonb
      and jsonb_typeof(p_term->'text') = 'string' and length(btrim(p_term->>'text')) between 1 and 2000
    else false end,false)
$$;

-- Proration method for suggested partial periods and a move-out's final period.
alter table public.accounts add column proration_method text not null default 'actual_days',
  add constraint accounts_proration_method_check check (proration_method in ('actual_days','thirty_day_month'));
grant update (proration_method) on public.accounts to authenticated;

create or replace function public._move_out_billing_period(s public.rent_schedules, p_period jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  t public.tenancies;
  from_on date := (p_period->>'period_start')::date;
  to_on date := (p_period->>'period_end')::date;
  cents bigint;
  denominator integer;
begin
  if p_period is null then return null; end if;
  select * into t from public.tenancies where account_id = s.account_id and id = s.tenancy_id;
  if t.move_out_on is null or t.move_out_on >= to_on then return p_period; end if;
  if t.move_out_on < from_on then return null; end if;
  if s.kind <> 'rent' then return null; end if;
  if t.move_out_plan->>'final_rent_schedule_id' = s.id::text then
    cents := (t.move_out_plan->>'final_rent_amount_cents')::bigint;
  end if;
  denominator := case when (select proration_method from public.accounts where id = s.account_id) = 'thirty_day_month' then 30
    else extract(day from (date_trunc('month',from_on) + interval '1 month - 1 day'))::integer end;
  return p_period || jsonb_build_object('period_end',t.move_out_on,
    'due_date',least((p_period->>'due_date')::date,t.move_out_on),
    'amount_cents',coalesce(cents,round(s.amount_cents::numeric *
      least(t.move_out_on - from_on + 1,denominator) / denominator)::bigint),
    'reason','Scheduled move-out', 'needs_override',false);
end;
$$;

-- Billing follows the lease: true when billing was derived from the agreement,
-- false when the landlord chose different billing, null when never recorded.
alter table public.rent_schedules add column follows_lease boolean;

do $migration$
declare body text;
begin
  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    '''grace_days'',''late_fee_policy'',''billing_due_rule'',''short_month_policy'',''manual_basis'',''period_overrides'',''history_mode'',''opening_balance'',''charge_keys''] <> ''{}''',
    '''grace_days'',''late_fee_policy'',''billing_due_rule'',''short_month_policy'',''manual_basis'',''period_overrides'',''history_mode'',''opening_balance'',''charge_keys'',''follows_lease''] <> ''{}''
      or jsonb_typeof(coalesce(r->''follows_lease'',''null'')) not in (''boolean'',''null'')');
  execute body;

  body := pg_get_functiondef('public.commit_billing_setup(uuid,uuid,jsonb,text,text)'::regprocedure);
  body := pg_temp.patched(body, 'regular_anchor,terms_snapshot,manual_basis,billing_due_rule,short_month_policy)',
    'regular_anchor,terms_snapshot,manual_basis,billing_due_rule,short_month_policy,follows_lease)');
  body := pg_temp.patched(body,
    'case when r?''billing_due_rule'' then coalesce(r->>''short_month_policy'',''last_day'') else null end) returning id into v_schedule_id',
    'case when r?''billing_due_rule'' then coalesce(r->>''short_month_policy'',''last_day'') else null end,(r->>''follows_lease'')::boolean) returning id into v_schedule_id');
  execute body;
end;
$migration$;

-- Existing schedules: follows_lease when every recorded billing term equals its source lease.
do $migration$
declare equal_count integer; different_count integer; unlinked_count integer;
begin
  update public.rent_schedules s set follows_lease = (
      s.amount_cents = l.rent_amount_cents and s.currency = l.rent_currency
      and coalesce(s.billing_due_rule, jsonb_build_object('kind','day_of_month','day',s.due_day))
        = case when l.rent_due_rule->>'kind' in ('day_of_month','last_day') then l.rent_due_rule else null end
      and s.grace_days is not distinct from l.grace_days
      and coalesce(s.terms_snapshot->'late_fee_policy', s.terms_snapshot->'billing'->'late_fee_policy', '{"kind":"unknown"}')
        = coalesce(l.late_fee_policy, '{"kind":"unknown"}')
      and s.end_date is not distinct from l.term_end)
  from public.leases l
  where l.account_id = s.account_id and l.id = s.source_lease_id and s.kind = 'rent';
  update public.rent_schedules set follows_lease = false where kind = 'rent' and follows_lease is null;
  select count(*) filter (where follows_lease), count(*) filter (where not follows_lease and source_lease_id is not null),
    count(*) filter (where source_lease_id is null)
    into equal_count, different_count, unlinked_count from public.rent_schedules where kind = 'rent';
  raise notice 'follows_lease: % schedules equal their lease, % differ, % have no source lease (false)',
    equal_count, different_count, unlinked_count;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
