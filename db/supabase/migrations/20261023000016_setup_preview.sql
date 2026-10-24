begin;

create function public.preview_tenancy_setup_session(p_account_id uuid,p_id uuid,p_setup jsonb) returns jsonb
language plpgsql set search_path=public as $$
declare d public.tenancy_setup_sessions;actual_t public.tenancies;old_l public.leases;
  t jsonb;l jsonb;billing jsonb;r jsonb;preview jsonb;cycles jsonb;payments jsonb:='[]';
  p jsonb;c jsonb;targets jsonb;allocs jsonb;remaining jsonb:='{}';amount_left bigint;available bigint;applied bigint;ref text;
  people_context jsonb:='[]';person jsonb;existing_person jsonb;fingerprint text;today date:=(now() at time zone 'UTC')::date;
  tenant_id uuid;lease_id uuid;is_existing boolean;
begin
  if auth.uid() is null or not public.is_account_member(p_account_id) then raise exception 'not_found' using errcode='P0002';end if;
  select * into d from public.tenancy_setup_sessions where account_id=p_account_id and id=p_id and expires_at>now();
  if not found then raise exception 'not_found' using errcode='P0002';end if;
  if d.completed_at is not null then raise exception 'conflict: setup already completed';end if;
  if jsonb_typeof(p_setup->'people')<>'array' or jsonb_array_length(p_setup->'people') not between 1 and 50 then raise exception 'invalid: add at least one person';end if;
  for person in select value from jsonb_array_elements(p_setup->'people') loop
    if person->>'tenant_id' is not null then
      select to_jsonb(x) into existing_person from public.tenants x where account_id=p_account_id and id=(person->>'tenant_id')::uuid and deleted_at is null;
      if existing_person is null then raise exception 'not_found' using errcode='P0002';end if;
      people_context:=people_context||jsonb_build_array(existing_person);
    elsif length(btrim(coalesce(person->>'full_name',''))) not between 1 and 200 then raise exception 'invalid: enter each person''s name';end if;
  end loop;
  if d.tenancy_id is not null then
    select * into actual_t from public.tenancies where account_id=p_account_id and id=d.tenancy_id and area_id=d.area_id and deleted_at is null;
    if not found or actual_t.status='ended' then raise exception 'conflict: tenancy is unavailable or ended';end if;
  end if;
  tenant_id:=coalesce(d.tenancy_id,d.id);
  t:=coalesce(to_jsonb(actual_t),'{}')||jsonb_build_object('id',tenant_id,'account_id',p_account_id,'area_id',d.area_id,
    'start_date',p_setup->'tenancy'->'start_date','end_date',p_setup->'tenancy'->'end_date',
    'start_date_basis','possession_entitlement','status',public.effective_tenancy_status('upcoming',(p_setup->'tenancy'->>'start_date')::date,today));
  if (t->>'start_date') is null or (t->>'end_date')::date<(t->>'start_date')::date then raise exception 'invalid: check move-in and planned ending dates';end if;
  l:=p_setup->'agreement';
  if l->>'existing_id' is not null then
    select * into old_l from public.leases where account_id=p_account_id and tenancy_id=tenant_id and id=(l->>'existing_id')::uuid and voided_at is null and deleted_at is null;
    if not found then raise exception 'not_found' using errcode='P0002';end if;
  end if;
  if l->>'change_kind' in ('reuse','billing_only') then
    if old_l.id is null then raise exception 'invalid: select a saved agreement';end if;
    l:=to_jsonb(old_l);
  else
    if l->>'change_kind' in ('correction','renewal') and length(btrim(coalesce(p_setup->>'change_reason',''))) not between 1 and 500 then raise exception 'invalid: say what changed';end if;
    lease_id:=(l->>'id')::uuid;
    l:=l||jsonb_build_object('account_id',p_account_id,'tenancy_id',tenant_id,'status','active',
      'agreement_kind',case when l->>'change_kind'='renewal' then 'renewal' else 'original' end);
  end if;
  if (l->>'rent_amount_cents')::bigint<=0 or length(l->>'rent_currency')<>3 or (l->>'term_start') is null or
    (l->>'term_end')::date<(l->>'term_start')::date or not public._valid_recorded_term(l->'rent_due_rule',true)
    or not public._valid_recorded_term(l->'late_fee_policy',false) then raise exception 'invalid: check the agreed rent and lease terms';end if;
  billing:=p_setup->'billing';r:=billing->'rent';
  if r->>'decision'='configure' then
    r:=r||jsonb_build_object('source_lease_id',l->'id');
    billing:=jsonb_set(billing,'{rent}',r);
  end if;
  billing:=jsonb_set(billing,'{operation}',to_jsonb(case when coalesce((p_setup->>'transition')::boolean,false) then 'transition' else 'initial' end));
  -- The server chooses exact periods before matching; no provisional financial rows are inserted.
  preview:=public.preview_billing_setup_facts(p_account_id,tenant_id,billing||jsonb_build_object('payments','[]'::jsonb),t,l);
  if r->>'decision'='configure' and r->>'history_mode'<>'opening_balance' then
    cycles:=coalesce(r->'charge_keys','[]');
    for c in select value from jsonb_array_elements(preview->'history_periods') where coalesce((value->>'is_elapsed')::boolean,false) loop
      if not exists(select 1 from jsonb_array_elements(cycles) x where x->>'cycle_key'=c->>'cycle_key') then
        cycles:=cycles||jsonb_build_array(jsonb_build_object('cycle_key',c->>'cycle_key','draft_key',c->>'draft_key'));
      end if;
    end loop;
    r:=jsonb_set(r,'{charge_keys}',cycles);billing:=jsonb_set(billing,'{rent}',r);
    preview:=public.preview_billing_setup_facts(p_account_id,tenant_id,billing||jsonb_build_object('payments','[]'::jsonb),t,l);
  end if;
  targets:=coalesce(preview->'charge_candidates','[]')||(select coalesce(jsonb_agg(value),'[]') from jsonb_array_elements(preview->'existing'->'charges') where value->>'voided_at' is null and (value->>'balance_cents')::bigint>0);
  for p in select value from jsonb_array_elements(coalesce(billing->'payments','[]')) with ordinality order by value->>'received_at' nulls last,ordinality loop
    amount_left:=(p->>'amount_cents')::bigint;allocs:='[]';
    for c in select value from jsonb_array_elements(targets) where value->>'type'=coalesce(p_setup->'receipt_purposes'->>(p->>'draft_key'),'rent') order by value->>'due_date',coalesce(value->>'draft_key',value->>'id') loop
      ref:=coalesce(c->>'draft_key',c->>'id');
      available:=coalesce((remaining->>ref)::bigint,(c->>'balance_cents')::bigint,(c->>'amount_cents')::bigint);
      applied:=least(available,amount_left);
      if applied>0 then
        allocs:=allocs||jsonb_build_array(jsonb_build_object(case when c?'draft_key' then 'charge_key' else 'charge_id' end,ref,'amount_cents',applied));
        remaining:=remaining||jsonb_build_object(ref,available-applied);amount_left:=amount_left-applied;
      end if;
      exit when amount_left=0;
    end loop;
    payments:=payments||jsonb_build_array(p||jsonb_build_object('allocations',allocs,'entry_source','entered_at_setup'));
  end loop;
  billing:=jsonb_set(billing,'{payments}',payments);
  preview:=public.preview_billing_setup_facts(p_account_id,tenant_id,billing,t,l);
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('draft_revision',d.revision,'setup',p_setup,'current_tenancy',to_jsonb(actual_t),
    'current_lease',to_jsonb(old_l),'people',people_context,'billing_context',preview->'context_fingerprint','today',today)::text,'UTF8')),'hex');
  return preview||jsonb_build_object('setup_context',fingerprint,'draft_revision',d.revision,'proposed_tenancy',t,'proposed_agreement',l,
    'billing_intent',billing,'can_confirm',not exists(select 1 from jsonb_array_elements(preview->'findings') f where f->>'severity'='error'));
end $$;
revoke all on function public.preview_tenancy_setup_session(uuid,uuid,jsonb) from public,anon;
grant execute on function public.preview_tenancy_setup_session(uuid,uuid,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
