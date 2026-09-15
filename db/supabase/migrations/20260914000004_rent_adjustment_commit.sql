create function public._adjustment_replace_lease(p_account_id uuid,p_lease_id uuid,p_terms jsonb,p_reason text)
returns uuid language plpgsql set search_path=public as $$
declare old public.leases; new_id uuid;
begin
  if current_user<>'rent_adjustment_writer' then raise exception 'forbidden' using errcode='42501'; end if;
  select * into old from public.leases where account_id=p_account_id and id=p_lease_id and voided_at is null and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if old.status='draft' then
    update public.leases set term_start=(p_terms->>'term_start')::date,term_end=(p_terms->>'term_end')::date,
      rent_amount_cents=(p_terms->>'rent_amount_cents')::bigint,rent_currency=p_terms->>'rent_currency',
      deposit_amount_cents=(p_terms->>'deposit_amount_cents')::bigint,deposit_currency=p_terms->>'deposit_currency',updated_at=now()
      where id=old.id and account_id=p_account_id;
    return old.id;
  end if;
  insert into public.leases(account_id,tenancy_id,status,term_start,term_end,rent_amount_cents,rent_currency,
    deposit_amount_cents,deposit_currency,document)
    values(p_account_id,old.tenancy_id,old.status,(p_terms->>'term_start')::date,(p_terms->>'term_end')::date,
      (p_terms->>'rent_amount_cents')::bigint,p_terms->>'rent_currency',(p_terms->>'deposit_amount_cents')::bigint,
      p_terms->>'deposit_currency',old.document) returning id into new_id;
  update public.rent_schedules set source_lease_id=new_id,updated_at=now()
    where account_id=p_account_id and source_lease_id=old.id and deleted_at is null;
  update public.leases set voided_at=now(),void_reason=p_reason,updated_at=now() where id=old.id and account_id=p_account_id;
  update public.leases set corrects_lease_id=old.id where id=new_id and account_id=p_account_id;
  return new_id;
end $$;

create function public.commit_rent_adjustment(p_account_id uuid,p_tenancy_id uuid,p_payload jsonb,
  p_preview_token text,p_request_key text,p_request_fingerprint text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  plan jsonb; preview jsonb; prior public.rent_adjustments; claim public.idempotency_keys;
  receipt jsonb; operation_id uuid:=gen_random_uuid(); saved_at timestamptz:=now();
  item jsonb; app jsonb; segment jsonb; map jsonb:='[]'; new_id uuid; schedule_id uuid; replacement_id uuid;
  c public.charges; s public.rent_schedules; source jsonb:=p_payload->'source'; terms jsonb;
  source_lease uuid; source_notice uuid; change_result record; reason text;
  selected_ids uuid[]; schedule_ids uuid[]:='{}'; charge_ids uuid[]:='{}';
begin
  if auth.uid() is null or not public.is_account_member(p_account_id) then raise exception 'not_found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||p_tenancy_id::text,0));
  select * into claim from public.idempotency_keys where account_id=p_account_id and key=p_request_key for update;
  if not found or claim.request_fingerprint is distinct from p_request_fingerprint then raise exception 'idempotency_conflict'; end if;
  select * into prior from public.rent_adjustments where account_id=p_account_id and request_key=p_request_key;
  if found then
    if prior.request_fingerprint is distinct from p_request_fingerprint or prior.created_by<>auth.uid() or prior.tenancy_id<>p_tenancy_id then
      raise exception 'idempotency_conflict';
    end if;
    receipt:=prior.response_body;
  else
    if claim.completed_at is not null then raise exception 'idempotency_conflict'; end if;
    plan:=public._plan_rent_adjustment(p_account_id,p_tenancy_id,p_payload);
    if plan->>'preview_token' is distinct from p_preview_token then raise exception 'preview_stale'; end if;
    if jsonb_array_length(plan->'blockers')>0 then raise exception '%',plan->'blockers'->0->>'code'; end if;
    preview:=plan-array['_segments','_plans','_selected_ids'];
    reason:=coalesce(nullif(btrim(p_payload->>'reason'),''),'Rent change');
    if length(reason)>500 then raise exception 'invalid_request' using errcode='22023'; end if;
    select coalesce(array_agg(x::uuid),'{}') into selected_ids from jsonb_array_elements_text(plan->'_selected_ids') x;

    -- Release old applications before recreating them; cash receipts remain intact.
    for app in select x from jsonb_array_elements(plan->'applications') x loop
      update public.payment_allocations set voided_at=now(),void_reason=reason,updated_at=now()
        where account_id=p_account_id and id=(app->>'id')::uuid and voided_at is null;
    end loop;
    for item in select x from jsonb_array_elements(plan->'_plans') x loop
      update public.charges set voided_at=now(),void_reason=reason,updated_at=now()
        where account_id=p_account_id and id=(item->>'id')::uuid and voided_at is null;
    end loop;
    if p_payload->>'kind'='correct_rent' then
      update public.rent_schedules set deleted_at=now(),updated_at=now() where account_id=p_account_id and id=any(selected_ids);
    end if;
    if plan->'lease' <> 'null'::jsonb then
      replacement_id:=public._adjustment_replace_lease(p_account_id,(plan->'lease'->>'id')::uuid,plan->'lease'->'after',
        coalesce(p_payload->'details_correction'->>'reason',reason));
    end if;

    if p_payload->>'kind'='change_rent' then
      source_lease:=(source->>'lease_id')::uuid; source_notice:=(source->>'notice_id')::uuid;
      if source_lease=(plan->'lease'->>'id')::uuid then source_lease:=replacement_id; end if;
      if source->>'kind'='new_lease' then
        terms:=source->'terms';
        insert into public.leases(account_id,tenancy_id,status,term_start,term_end,rent_amount_cents,rent_currency,
          deposit_amount_cents,deposit_currency,document) values(p_account_id,p_tenancy_id,'draft',
          (terms->>'term_start')::date,(terms->>'term_end')::date,(terms->>'rent_amount_cents')::bigint,
          terms->>'rent_currency',(terms->>'deposit_amount_cents')::bigint,terms->>'deposit_currency',coalesce(source->'document','{}'))
          returning id into source_lease;
      elsif source->>'kind'='new_notice' then
        insert into public.notices(account_id,tenancy_id,notice_label,served_at,served_method,body,document)
          values(p_account_id,p_tenancy_id,source->>'notice_label',(source->>'served_at')::timestamptz,
            source->>'served_method',source->>'body',coalesce(source->'document','{}')) returning id into source_notice;
      end if;
      select * into change_result from public.change_tenancy_rent(p_account_id,p_tenancy_id,
        (p_payload->>'amount_cents')::bigint,p_payload->>'currency',(p_payload->>'effective_date')::date,
        (p_payload->>'due_day')::int,source_lease,source_notice,reason);
      schedule_id:=change_result.o_schedule_id; schedule_ids:=array_append(schedule_ids,schedule_id);
    elsif p_payload->>'kind'='correct_rent' then
      for segment in select x from jsonb_array_elements(plan->'_segments') x loop
        select * into s from public.rent_schedules where id=(segment->>'old_id')::uuid and account_id=p_account_id;
        insert into public.rent_schedules(account_id,tenancy_id,kind,amount_cents,currency,due_day,start_date,end_date,
          source_lease_id,source_notice_id,change_reason,grace_days,late_fee_cents,corrects_schedule_id)
          values(p_account_id,p_tenancy_id,s.kind,(segment->>'amount_cents')::bigint,s.currency,s.due_day,
            (segment->>'start_date')::date,(segment->>'end_date')::date,replacement_id,s.source_notice_id,reason,
            s.grace_days,s.late_fee_cents,s.id) returning id into new_id;
        map:=map||(segment||jsonb_build_object('new_id',new_id)); schedule_ids:=array_append(schedule_ids,new_id);
      end loop;
    end if;
    for item in select x from jsonb_array_elements(plan->'_plans') x where x->>'action'='replace' loop
      select * into c from public.charges where id=(item->>'id')::uuid and account_id=p_account_id;
      if p_payload->>'kind'='correct_rent' then
        select (x->>'new_id')::uuid into schedule_id from jsonb_array_elements(map) x
          where (x->>'old_id')::uuid=c.source_schedule_id and coalesce(c.period_start,c.due_date)>=(x->>'start_date')::date
            and (x->>'end_date' is null or coalesce(c.period_start,c.due_date)<=(x->>'end_date')::date) limit 1;
      end if;
      insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,
        description,source_schedule_id,corrects_charge_id)
        values(p_account_id,p_tenancy_id,c.type,(item->>'after_amount_cents')::bigint,c.currency,c.due_date,c.period_start,c.period_end,
          c.description,schedule_id,c.id) returning id into new_id;
      charge_ids:=array_append(charge_ids,new_id);
      for app in select x from jsonb_array_elements(plan->'applications') x
        where (x->>'charge_id')::uuid=c.id and (x->>'after_amount_cents')::bigint>0 loop
        insert into public.payment_allocations(account_id,payment_id,charge_id,amount_cents,note,corrects_allocation_id)
          values(p_account_id,(app->>'payment_id')::uuid,new_id,(app->>'after_amount_cents')::bigint,reason,(app->>'id')::uuid);
      end loop;
    end loop;

    -- A new schedule ID must not make an explicitly waived period bill again.
    if p_payload->>'kind'='correct_rent' then
      for segment in select x from jsonb_array_elements(map) x loop
        insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,
          description,source_schedule_id,voided_at,void_reason,corrects_charge_id)
          select c.account_id,c.tenancy_id,c.type,c.amount_cents,c.currency,c.due_date,c.period_start,c.period_end,
            c.description,(segment->>'new_id')::uuid,now(),c.void_reason,c.id from public.charges c
          where c.account_id=p_account_id and c.source_schedule_id=(segment->>'old_id')::uuid
            and c.voided_at is not null and c.deleted_at is null and c.period_start is not null
            and c.period_start>=(segment->>'start_date')::date
            and (segment->>'end_date' is null or c.period_start<=(segment->>'end_date')::date)
          on conflict(source_schedule_id,period_start) where source_schedule_id is not null and period_start is not null do nothing;
      end loop;
    end if;
    receipt:=jsonb_build_object('id',operation_id,'kind',p_payload->>'kind','created_at',saved_at,'preview',preview,
      'replacement_lease_id',replacement_id,'source_notice_id',source_notice,'source_lease_id',source_lease,
      'schedule_ids',to_jsonb(schedule_ids),'charge_ids',to_jsonb(charge_ids));
    insert into public.rent_adjustments(id,account_id,tenancy_id,kind,created_by,created_at,request_key,request_fingerprint,response_body)
      values(operation_id,p_account_id,p_tenancy_id,p_payload->>'kind',auth.uid(),saved_at,p_request_key,p_request_fingerprint,receipt);
  end if;
  update public.idempotency_keys set status_code=200,body=receipt,completed_at=now()
    where account_id=p_account_id and key=p_request_key and request_fingerprint=p_request_fingerprint;
  if not found then raise exception 'idempotency_completion_lost'; end if;
  return receipt;
end $$;

alter function public.commit_rent_adjustment(uuid,uuid,jsonb,text,text,text) owner to rent_adjustment_writer;
revoke create on schema public from rent_adjustment_writer;
revoke all on function public._adjustment_replace_lease(uuid,uuid,jsonb,text),
  public.commit_rent_adjustment(uuid,uuid,jsonb,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public._adjustment_replace_lease(uuid,uuid,jsonb,text),
  public.change_tenancy_rent(uuid,uuid,bigint,text,date,int,uuid,uuid,text,text,int,bigint) to rent_adjustment_writer;
grant execute on function public.commit_rent_adjustment(uuid,uuid,jsonb,text,text,text) to authenticated;
