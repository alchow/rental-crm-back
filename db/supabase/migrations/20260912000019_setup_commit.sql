begin;

create function public.commit_tenancy_setup_session(p_account_id uuid,p_id uuid,p_setup jsonb,p_expected_context text,
  p_accept_warnings boolean,p_idempotency_key text,p_request_fingerprint text) returns jsonb
language plpgsql set search_path=public as $$
declare d public.tenancy_setup_sessions;k public.idempotency_keys;review jsonb;fresh jsonb;billing jsonb;ack jsonb;
  t public.tenancies;l public.leases;person jsonb;person_id uuid;member_id uuid;people_ids uuid[]:='{}';parties jsonb:='[]';
  agreed jsonb;p_kind text;doc jsonb;doc_id uuid;lease_id uuid;money jsonb;v_result jsonb;first_person boolean:=true;
  date_changes jsonb:='{}';date_ctx jsonb;date_review jsonb;date_payload jsonb;child_key text;notes jsonb:=coalesce(p_setup->'warning_notes','{}');
begin
  if auth.uid() is null or not exists(select 1 from public.account_members where account_id=p_account_id and user_id=auth.uid() and deleted_at is null and role in ('owner','manager')) then raise exception 'not_found' using errcode='P0002';end if;
  select * into k from public.idempotency_keys where account_id=p_account_id and key=p_idempotency_key for update;
  if not found or k.request_fingerprint is distinct from p_request_fingerprint then raise exception 'invalid: idempotency claim missing';end if;
  if k.completed_at is not null then return k.body;end if;
  select * into d from public.tenancy_setup_sessions where account_id=p_account_id and id=p_id for update;
  if not found then raise exception 'not_found' using errcode='P0002';end if;
  if d.completed_at is not null then raise exception 'conflict: setup already completed';end if;
  perform pg_advisory_xact_lock(hashtextextended('tenancy_identity:'||p_account_id::text||':'||d.area_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||coalesce(d.tenancy_id,d.id)::text,0));
  review:=public.preview_tenancy_setup_session(p_account_id,p_id,p_setup);
  if review->>'setup_context' is distinct from p_expected_context then raise exception 'conflict: setup context changed; review again';end if;
  if not (review->>'can_confirm')::boolean then raise exception 'invalid: fix the blocking findings before confirming';end if;
  if not p_accept_warnings then raise exception 'invalid: confirm the reviewed setup and listed differences';end if;
  if d.tenancy_id is null then
    insert into public.tenancies(id,account_id,area_id,start_date,end_date,start_date_basis,status)
      values(d.id,p_account_id,d.area_id,(review->'proposed_tenancy'->>'start_date')::date,
        (review->'proposed_tenancy'->>'end_date')::date,'possession_entitlement',review->'proposed_tenancy'->>'status') returning * into t;
  else
    select * into t from public.tenancies where account_id=p_account_id and id=d.tenancy_id and deleted_at is null for update;
    if t.start_date is distinct from (review->'proposed_tenancy'->>'start_date')::date then date_changes:=date_changes||jsonb_build_object('start_date',review->'proposed_tenancy'->'start_date');end if;
    if t.end_date is distinct from (review->'proposed_tenancy'->>'end_date')::date then date_changes:=date_changes||jsonb_build_object('end_date',review->'proposed_tenancy'->'end_date');end if;
    if t.start_date_basis<>'possession_entitlement' then date_changes:=date_changes||'{"start_date_basis":"possession_entitlement"}'::jsonb;end if;
    if date_changes<>'{}' then
      date_ctx:=public.get_tenancy_date_context(p_account_id,t.id);
      date_payload:=jsonb_build_object('changes',date_changes,'expected_date_revision',date_ctx->'facts'->'date_revision',
        'expected_context_fingerprint',date_ctx->'context_fingerprint','reason_code','other','reason_note',coalesce(p_setup->>'move_in_note',''));
      date_review:=public.preview_tenancy_date_correction(p_account_id,t.id,date_payload);
      select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('relationship_fingerprint',f->'relationship_fingerprint','note',notes->>(f->>'rule_id')))),'[]') into ack
        from jsonb_array_elements(date_review->'findings') f where coalesce((f->>'confirmation_required')::boolean,false);
      child_key:=p_idempotency_key||'_dates';perform public.claim_idempotency_key(p_account_id,child_key,p_request_fingerprint);
      perform public.correct_tenancy_dates(p_account_id,t.id,child_key,p_request_fingerprint,date_payload||jsonb_build_object('warning_acknowledgements',ack));
    end if;
  end if;
  for person in select value from jsonb_array_elements(p_setup->'people') loop
    person_id:=coalesce((person->>'tenant_id')::uuid,(person->>'key')::uuid);
    if person->>'tenant_id' is null then
      insert into public.tenants(id,account_id,full_name,phones,emails)
      values(person_id,p_account_id,btrim(person->>'full_name'),array(select jsonb_array_elements_text(coalesce(person->'phones','[]'))),array(select jsonb_array_elements_text(coalesce(person->'emails','[]'))));
    elsif not exists(select 1 from public.tenants where id=person_id and account_id=p_account_id and deleted_at is null) then raise exception 'not_found' using errcode='P0002';end if;
    if person_id=any(people_ids) then raise exception 'invalid: the same person was added twice';end if;
    people_ids:=array_append(people_ids,person_id);
    select id into member_id from public.tenancy_tenants where account_id=p_account_id and tenancy_id=t.id and tenant_id=person_id and deleted_at is null order by created_at limit 1;
    if member_id is null then
      insert into public.tenancy_tenants(account_id,tenancy_id,tenant_id,role,on_lease)
        values(p_account_id,t.id,person_id,case when first_person and not exists(select 1 from public.tenancy_tenants where tenancy_id=t.id and deleted_at is null and role='primary') then 'primary' else 'occupant' end,(person->>'on_lease')::boolean);
    else
      update public.tenancy_tenants set on_lease=(person->>'on_lease')::boolean,updated_at=clock_timestamp() where account_id=p_account_id and id=member_id;
    end if;
    parties:=parties||jsonb_build_array(jsonb_build_object('tenant_id',person_id,'on_lease',person->'on_lease'));
    first_person:=false;
  end loop;
  update public.tenancy_tenants set deleted_at=clock_timestamp(),updated_at=clock_timestamp() where account_id=p_account_id and tenancy_id=t.id and deleted_at is null and not(tenant_id=any(people_ids)) and role<>'guarantor';
  if not exists(select 1 from public.tenancy_tenants where account_id=p_account_id and tenancy_id=t.id and deleted_at is null and role='primary') then
    update public.tenancy_tenants set role='primary',updated_at=clock_timestamp() where id=(select id from public.tenancy_tenants where account_id=p_account_id and tenancy_id=t.id and tenant_id=people_ids[1] and deleted_at is null limit 1);
  end if;
  agreed:=review->'proposed_agreement';p_kind:=p_setup->'agreement'->>'change_kind';
  if p_setup->'document'->>'receipt_id' is not null then
    if p_setup->'document'->>'original_receipt_id' is not null then
      doc:=public.create_tenancy_document_from_image(p_account_id,t.id,'lease',coalesce(p_setup->'document'->>'name','Lease'),false,
        (p_setup->'document'->>'original_receipt_id')::uuid,(p_setup->'document'->>'receipt_id')::uuid);
    else
      doc:=public.create_tenancy_document_from_upload(p_account_id,t.id,'lease',coalesce(p_setup->'document'->>'name','Lease'),false,(p_setup->'document'->>'receipt_id')::uuid);
    end if;
    doc_id:=(doc->'document'->>'id')::uuid;
    agreed:=jsonb_set(agreed,'{terms_source}',jsonb_build_object('kind','document','document_id',doc_id));
  end if;
  if p_kind in ('reuse','billing_only') then lease_id:=(agreed->>'id')::uuid;
  elsif p_kind='correction' then
    select o_replacement_id into lease_id from public.replace_lease_terms(p_account_id,(p_setup->'agreement'->>'existing_id')::uuid,p_setup->>'change_reason',
      (agreed->>'term_start')::date,(agreed->>'term_end')::date,(agreed->>'rent_amount_cents')::bigint,agreed->>'rent_currency',
      (agreed->>'deposit_amount_cents')::bigint,agreed->>'deposit_currency',coalesce(agreed->'document','{}')||jsonb_build_object('parties',parties),agreed);
  else
    insert into public.leases(id,account_id,tenancy_id,status,term_start,term_end,rent_amount_cents,rent_currency,deposit_amount_cents,deposit_currency,
      rent_due_rule,grace_days,late_fee_policy,deposit_knowledge,terms_source,agreement_kind,predecessor_lease_id,document)
    values((agreed->>'id')::uuid,p_account_id,t.id,'active',(agreed->>'term_start')::date,(agreed->>'term_end')::date,
      (agreed->>'rent_amount_cents')::bigint,agreed->>'rent_currency',coalesce((agreed->>'deposit_amount_cents')::bigint,0),agreed->>'deposit_currency',
      agreed->'rent_due_rule',(agreed->>'grace_days')::integer,agreed->'late_fee_policy',agreed->>'deposit_knowledge',agreed->'terms_source',
      case when p_kind='renewal' then 'renewal' else 'original' end,(p_setup->'agreement'->>'existing_id')::uuid,
      jsonb_build_object('parties',parties,'setup_session_id',d.id,'change_reason',p_setup->>'change_reason')) returning id into lease_id;
  end if;
  billing:=review->'billing_intent';
  if billing->'rent'->>'decision'='configure' then billing:=jsonb_set(billing,'{rent,source_lease_id}',to_jsonb(lease_id));end if;
  fresh:=public.preview_billing_setup(p_account_id,t.id,billing);
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('relationship_fingerprint',f->'relationship_fingerprint','note',notes->>(f->>'rule_id')))),'[]') into ack
    from jsonb_array_elements(fresh->'findings') f where coalesce((f->>'confirmation_required')::boolean,false);
  billing:=billing||jsonb_build_object('expected_context',fresh->'context_fingerprint','warning_acknowledgements',ack);
  money:=public.commit_billing_setup(p_account_id,t.id,billing,p_idempotency_key,p_request_fingerprint);
  perform public.update_tenancy_onboarding_progress(p_account_id,t.id,jsonb_build_object('selected_lease_id',lease_id,'agreement_confirmed',true,'condition_decision','deferred'));
  if coalesce((p_setup->>'save_defaults')::boolean,false) then
    insert into public.account_rent_defaults(account_id,grace_days,late_fee_policy) values(p_account_id,(agreed->>'grace_days')::integer,agreed->'late_fee_policy')
      on conflict(account_id) do update set grace_days=excluded.grace_days,late_fee_policy=excluded.late_fee_policy,updated_at=clock_timestamp();
  end if;
  v_result:=jsonb_build_object('session_id',d.id,'tenancy_id',t.id,'lease_id',lease_id,'status',t.status,'billing',money);
  update public.tenancy_setup_sessions set completed_at=clock_timestamp(),result=v_result,updated_at=clock_timestamp(),revision=revision+1 where id=d.id;
  update public.idempotency_keys set status_code=201,body=v_result,completed_at=clock_timestamp() where account_id=p_account_id and key=p_idempotency_key;
  return v_result;
end $$;
revoke all on function public.commit_tenancy_setup_session(uuid,uuid,jsonb,text,boolean,text,text) from public,anon;
grant execute on function public.commit_tenancy_setup_session(uuid,uuid,jsonb,text,boolean,text,text) to authenticated;

notify pgrst,'reload schema';
commit;
