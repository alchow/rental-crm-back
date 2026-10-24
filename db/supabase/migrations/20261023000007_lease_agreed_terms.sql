-- Agreement facts are independent of billing; absent historical terms stay unknown.
alter table public.leases
  add column rent_due_rule jsonb not null default '{"kind":"unknown"}',
  add column grace_days integer check (grace_days >= 0),
  add column late_fee_policy jsonb not null default '{"kind":"unknown"}',
  add column deposit_knowledge text not null default 'unknown'
    check (deposit_knowledge in ('unknown','none','amount')),
  add column terms_source jsonb,
  add column terms_recorded_by uuid,
  add column terms_recorded_at timestamptz,
  add column agreement_kind text not null default 'original'
    check (agreement_kind in ('original','renewal','amendment')),
  add column predecessor_lease_id uuid,
  add constraint leases_predecessor_account_fk foreign key (account_id,predecessor_lease_id)
    references public.leases(account_id,id),
  add constraint leases_predecessor_not_self check (predecessor_lease_id is distinct from id);
update public.leases set deposit_knowledge = 'amount' where deposit_amount_cents > 0;

create function public._valid_recorded_term(p_term jsonb,p_due boolean)
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
    when 'other' then p_term - array['kind','text'] = '{}'::jsonb
      and jsonb_typeof(p_term->'text') = 'string' and length(btrim(p_term->>'text')) between 1 and 2000
    else false end,false)
$$;
revoke all on function public._valid_recorded_term(jsonb,boolean) from public,anon;
grant execute on function public._valid_recorded_term(jsonb,boolean) to authenticated,service_role;

alter table public.leases
  add constraint leases_due_rule_valid check (public._valid_recorded_term(rent_due_rule,true)),
  add constraint leases_late_policy_valid check (public._valid_recorded_term(late_fee_policy,false)),
  add constraint leases_deposit_knowledge_valid check
    ((deposit_knowledge <> 'none' or deposit_amount_cents = 0)
      and (deposit_knowledge <> 'amount' or deposit_amount_cents > 0)),
  add constraint leases_terms_source_valid check (terms_source is null or
    (jsonb_typeof(terms_source) = 'object' and terms_source->>'kind' in ('manual','document','import')
      and terms_source - array['kind','document_id','note'] = '{}'::jsonb));

create function public._lease_agreed_terms_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'UPDATE' and OLD.status in ('active','expired') and OLD.voided_at is null and
    (NEW.term_end,NEW.deposit_amount_cents,NEW.deposit_currency,NEW.rent_due_rule,
     NEW.grace_days,NEW.late_fee_policy,NEW.deposit_knowledge,NEW.terms_source,
     NEW.agreement_kind,NEW.predecessor_lease_id,NEW.terms_recorded_by,NEW.terms_recorded_at)
    is distinct from
    (OLD.term_end,OLD.deposit_amount_cents,OLD.deposit_currency,OLD.rent_due_rule,
     OLD.grace_days,OLD.late_fee_policy,OLD.deposit_knowledge,OLD.terms_source,
     OLD.agreement_kind,OLD.predecessor_lease_id,OLD.terms_recorded_by,OLD.terms_recorded_at)
  then raise exception 'conflict: lease is executed; use reasoned replacement for agreed terms'; end if;
  if NEW.predecessor_lease_id is not null and not exists
    (select 1 from public.leases l where l.account_id = NEW.account_id
      and l.id = NEW.predecessor_lease_id and l.tenancy_id = NEW.tenancy_id
      and l.deleted_at is null)
  then raise exception 'invalid: predecessor lease must belong to the same tenancy'; end if;
  if (NEW.agreement_kind = 'original') <> (NEW.predecessor_lease_id is null)
  then raise exception 'invalid: renewal/amendment requires a predecessor'; end if;
  if NEW.terms_source->>'document_id' is not null and not exists
    (select 1 from public.documents d where d.account_id = NEW.account_id
      and d.id = (NEW.terms_source->>'document_id')::uuid and d.deleted_at is null)
  then raise exception 'invalid: terms document must belong to the same account'; end if;
  if TG_OP = 'INSERT' or OLD.status = 'draft' then
    NEW.terms_recorded_by := auth.uid();
    NEW.terms_recorded_at := case when NEW.terms_source is null then null else clock_timestamp() end;
  end if;
  return NEW;
end $$;
revoke all on function public._lease_agreed_terms_guard() from public,anon;
grant execute on function public._lease_agreed_terms_guard() to authenticated,service_role;
create trigger lease_agreed_terms_guard before insert or update on public.leases
for each row execute function public._lease_agreed_terms_guard();

create function public.replace_lease_terms(p_account_id uuid,p_lease_id uuid,p_void_reason text,
  p_term_start date,p_term_end date,p_rent_amount_cents bigint,p_rent_currency text,
  p_deposit_amount_cents bigint,p_deposit_currency text,p_document jsonb,p_terms jsonb)
returns table(o_voided_id uuid,o_replacement_id uuid,o_repointed_schedule_ids uuid[])
language plpgsql set search_path = public as $$
declare v_lease public.leases; v_id uuid; v_ids uuid[];
begin
  select * into v_lease from public.leases where account_id = p_account_id
    and id = p_lease_id and deleted_at is null;
  if not found then raise exception 'not_found: lease'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||v_lease.tenancy_id::text,0));
  select * into v_lease from public.leases where account_id = p_account_id
    and id = p_lease_id and deleted_at is null for update;
  if v_lease.voided_at is not null then raise exception 'conflict: lease is voided'; end if;
  if length(btrim(coalesce(p_void_reason,''))) not between 1 and 500
  then raise exception 'invalid: void reason required'; end if;
  if exists (select 1 from public.rent_schedules s where s.account_id = p_account_id
    and s.source_lease_id = p_lease_id and s.deleted_at is null
    and (s.amount_cents <> p_rent_amount_cents or s.currency <> p_rent_currency))
  then raise exception 'conflict: lease anchors a rent schedule with a different rent'; end if;
  insert into public.leases(account_id,tenancy_id,status,term_start,term_end,
    rent_amount_cents,rent_currency,deposit_amount_cents,deposit_currency,document,
    rent_due_rule,grace_days,late_fee_policy,deposit_knowledge,terms_source,
    agreement_kind,predecessor_lease_id)
  values(p_account_id,v_lease.tenancy_id,v_lease.status,p_term_start,p_term_end,
    p_rent_amount_cents,p_rent_currency,coalesce(p_deposit_amount_cents,0),p_deposit_currency,
    coalesce(p_document,'{}'),coalesce(p_terms->'rent_due_rule','{"kind":"unknown"}'),
    (p_terms->>'grace_days')::integer,coalesce(p_terms->'late_fee_policy','{"kind":"unknown"}'),
    coalesce(p_terms->>'deposit_knowledge','unknown'),nullif(p_terms->'terms_source','null'::jsonb),
    coalesce(p_terms->>'agreement_kind',v_lease.agreement_kind),
    case when p_terms ? 'predecessor_lease_id' then (p_terms->>'predecessor_lease_id')::uuid
      else v_lease.predecessor_lease_id end) returning id into v_id;
  with changed as (update public.rent_schedules set source_lease_id = v_id,updated_at = now()
    where account_id = p_account_id and source_lease_id = p_lease_id and deleted_at is null returning id)
  select coalesce(array_agg(id),'{}') into v_ids from changed;
  update public.leases set voided_at = now(),void_reason = p_void_reason,updated_at = now()
    where account_id = p_account_id and id = p_lease_id;
  update public.leases set corrects_lease_id = p_lease_id,updated_at = now()
    where account_id = p_account_id and id = v_id;
  return query select p_lease_id,v_id,v_ids;
end $$;
revoke all on function public.replace_lease_terms(uuid,uuid,text,date,date,bigint,text,bigint,text,jsonb,jsonb) from public,anon;
grant execute on function public.replace_lease_terms(uuid,uuid,text,date,date,bigint,text,bigint,text,jsonb,jsonb) to authenticated,service_role;
