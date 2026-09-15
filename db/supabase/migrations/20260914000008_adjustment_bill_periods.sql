-- Bind auth.uid at creation; the narrow writer cannot resolve Supabase's auth schema.
create function public._request_actor() returns uuid language sql stable
begin atomic
  select auth.uid();
end;
revoke all on function public._request_actor() from public,anon,authenticated,service_role;
grant execute on function public._request_actor() to authenticated,rent_adjustment_writer;

-- Bind auth.uid at creation so the narrow adjustment writer can retain membership checks.
create or replace function public.is_account_member(p_account_id uuid)
returns boolean language sql stable security invoker set search_path=public
begin atomic
  select exists (
    select 1 from public.account_members m
    where m.account_id=p_account_id and m.user_id=auth.uid() and m.deleted_at is null
  );
end;

CREATE OR REPLACE FUNCTION public._plan_rent_adjustment(p_account_id uuid, p_tenancy_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  t public.tenancies; l public.leases; s public.rent_schedules; c public.charges; n public.notices;
  kind text:=p_payload->>'kind'; terms jsonb; source jsonb:=p_payload->'source'; scope jsonb;
  currency text; amount bigint; eff date; first_due date; last_date date; due int;
  from_date date; to_date date; bill_due date; bill_period date; bill_end date; bill_action text; selected boolean; changed boolean; after_amount bigint;
  lease_effect jsonb:='null'; schedules jsonb:='[]'; segments jsonb:='[]'; bills jsonb:='[]';
  applications jsonb:='[]'; blockers jsonb:='[]'; information jsonb:='[]';
  fingerprint jsonb; result jsonb; plans jsonb:='[]'; plan jsonb; segment jsonb; override jsonb;
  allocation record; applied bigint; carried bigint; remaining bigint; take bigint; total jsonb;
  selected_ids uuid[]:='{}'; affected_ids uuid[]:='{}'; fees uuid[]:='{}'; lease_id uuid;
begin
  if public._request_actor() is null or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode='P0002';
  end if;
  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if kind not in ('edit_details','correct_rent','change_rent') or kind is null then
    raise exception 'invalid_request' using errcode='22023';
  end if;
  lease_id:=coalesce((p_payload->>'lease_id')::uuid,(p_payload->'details_correction'->>'lease_id')::uuid);
  if lease_id is not null then
    select * into l from public.leases where account_id=p_account_id and tenancy_id=p_tenancy_id
      and id=lease_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
    terms:=coalesce(p_payload->'terms',p_payload->'details_correction'->'terms');
    if l.voided_at is not null then
      blockers:=blockers||jsonb_build_object('code','lease_voided','message','This lease was already corrected or voided.');
    end if;
    if terms->>'term_start' is null or (terms->>'term_end')::date < (terms->>'term_start')::date
      or (terms->>'rent_amount_cents')::bigint < 0 or (terms->>'deposit_amount_cents')::bigint < 0
      or length(terms->>'rent_currency') <> 3
      or ((terms->>'deposit_amount_cents')::bigint > 0 and terms->>'deposit_currency' is null) then
      raise exception 'invalid_request' using errcode='22023';
    end if;
    lease_effect:=jsonb_build_object('id',l.id,'before',public._rent_adjustment_terms(l),'after',terms);
    if kind='edit_details' and public._rent_adjustment_terms(l)=terms then
      blockers:=blockers||jsonb_build_object('code','no_change','message','No lease details have changed.');
    end if;
    if kind <> 'correct_rent' and l.status <> 'draft' and
      (l.rent_amount_cents <> (terms->>'rent_amount_cents')::bigint or l.rent_currency <> terms->>'rent_currency') then
      blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','Choose whether rent changed or the original amount was incorrect.','field','terms.rent_amount_cents');
    end if;
  elsif kind <> 'change_rent' then
    raise exception 'invalid_request' using errcode='22023';
  end if;
  currency:=coalesce(p_payload->>'currency',terms->>'rent_currency');
  amount:=coalesce((p_payload->>'amount_cents')::bigint,(terms->>'rent_amount_cents')::bigint);
  if currency is null or amount is null or amount<0 then raise exception 'invalid_request' using errcode='22023'; end if;
  if l.id is not null and currency<>l.rent_currency then
    blockers:=blockers||jsonb_build_object('code','adjustment_not_supported','message','A rent correction cannot convert currency.','field','terms.rent_currency');
  end if;
  if kind='change_rent' then
    eff:=(p_payload->>'effective_date')::date;
    if eff is null or source->>'kind' not in ('existing_lease','existing_notice','new_lease','new_notice') then
      raise exception 'invalid_request' using errcode='22023';
    end if;
    if t.status='ended' then blockers:=blockers||jsonb_build_object('code','tenancy_ended','message','This tenancy has ended.'); end if;
    if source->>'kind'='existing_lease' then
      select * into l from public.leases where account_id=p_account_id and tenancy_id=p_tenancy_id
        and id=(source->>'lease_id')::uuid and deleted_at is null and voided_at is null;
      if not found then raise exception 'not_found' using errcode='P0002'; end if;
      if l.status not in ('active','draft') then
        blockers:=blockers||jsonb_build_object('code','instrument_not_current','message','Choose the current lease or a renewal.','field','source');
      end if;
      if l.rent_amount_cents<>amount or l.rent_currency<>currency then
        blockers:=blockers||jsonb_build_object('code','source_amount_mismatch','message','This lease records a different rent. Choose the amendment or notice supporting the new amount.','field','source');
      end if;
    elsif source->>'kind'='existing_notice' then
      select * into n from public.notices where account_id=p_account_id and tenancy_id=p_tenancy_id
        and id=(source->>'notice_id')::uuid and deleted_at is null;
      if not found then raise exception 'not_found' using errcode='P0002'; end if;
      if n.served_at is null then blockers:=blockers||jsonb_build_object('code','notice_not_served','message','Choose a notice that has been served.','field','source'); end if;
    elsif source->>'kind'='new_lease' then
      if (source->'terms'->>'rent_amount_cents')::bigint is distinct from amount or source->'terms'->>'rent_currency' is distinct from currency then
        blockers:=blockers||jsonb_build_object('code','source_amount_mismatch','message','The new lease must record the proposed rent.','field','source');
      end if;
    elsif source->>'served_at' is null or nullif(btrim(source->>'notice_label'),'') is null then
      raise exception 'invalid_request' using errcode='22023';
    end if;
  end if;

  for s in select * from public.rent_schedules where account_id=p_account_id and tenancy_id=p_tenancy_id
    and deleted_at is null and rent_schedules.kind='rent' order by start_date desc,id loop
    scope:=null;
    if kind='correct_rent' then
      select x into scope from jsonb_array_elements(p_payload->'scope'->'schedules') x where x->>'schedule_id'=s.id::text;
      if scope is not null and s.source_lease_id is distinct from lease_id then
        blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','Selected billing must cite the lease being corrected.','field','scope');
      end if;
      selected:=scope is not null;
      if not selected and s.source_lease_id is distinct from lease_id then continue; end if;
      from_date:=coalesce((scope->>'start_date')::date,s.start_date);
      to_date:=coalesce((scope->>'end_date')::date,s.end_date);
      if selected and (from_date<s.start_date or to_date<from_date or (s.end_date is not null and (to_date is null or to_date>s.end_date))) then
        blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','Correction dates must be inside the selected billing period.','field','scope');
        selected:=false;
      end if;
    elsif kind='change_rent' then
      selected:=s.end_date is null or s.end_date>=eff;
      if not selected then continue; end if;
      from_date:=eff; to_date:=s.end_date;
      if s.start_date>=eff then
        blockers:=blockers||jsonb_build_object('code','schedule_conflict','message','A planned billing period starts on or after this date. Correct that period or choose a later effective date.','field','effective_date');
      end if;
      if due is null then due:=coalesce((p_payload->>'due_day')::int,s.due_day); last_date:=s.end_date; end if;
    else continue;
    end if;
    schedules:=schedules||jsonb_build_object('id',s.id,'start_date',from_date,'end_date',to_date,'due_day',s.due_day,
      'selected',selected,'before_amount_cents',s.amount_cents,'after_amount_cents',case when selected then amount else s.amount_cents end);
    if not selected then continue; end if;
    if s.currency<>currency then blockers:=blockers||jsonb_build_object('code','adjustment_not_supported','message','Selected billing uses a different currency.'); end if;
    selected_ids:=array_append(selected_ids,s.id);
    if kind='correct_rent' then
      if from_date>s.start_date then segments:=segments||jsonb_build_object('old_id',s.id,'start_date',s.start_date,'end_date',from_date-1,'amount_cents',s.amount_cents); end if;
      segments:=segments||jsonb_build_object('old_id',s.id,'start_date',from_date,'end_date',to_date,'amount_cents',amount);
      if to_date is not null and (s.end_date is null or to_date<s.end_date) then
        segments:=segments||jsonb_build_object('old_id',s.id,'start_date',to_date+1,'end_date',s.end_date,'amount_cents',s.amount_cents);
      end if;
    end if;
  end loop;
  if kind='correct_rent' then
    if exists (
      select 1 from jsonb_array_elements(coalesce(p_payload->'scope'->'charges','[]')) entry
      left join public.charges bill on bill.id=(entry->>'charge_id')::uuid
        and bill.account_id=p_account_id and bill.tenancy_id=p_tenancy_id
        and bill.deleted_at is null and bill.voided_at is null
      where bill.id is null or (bill.source_schedule_id is not null and not(bill.source_schedule_id=any(selected_ids)))
        or (entry->>'amount_cents')::bigint<0
    ) then
      blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','Some selected bills are unavailable or outside the selected billing periods.','field','scope.charges');
    end if;
    if cardinality(selected_ids) <> jsonb_array_length(p_payload->'scope'->'schedules') then
      blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','Some selected billing periods are unavailable.','field','scope');
    end if;
    if cardinality(selected_ids)=0 and jsonb_array_length(schedules)>0 then
      blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','Select the billing periods containing the incorrect amount.','field','scope');
    end if;
    if jsonb_array_length(schedules)=0 then information:=information||'"No billing is set up; this corrects lease details only."'::jsonb; end if;
  end if;
  if kind='change_rent' then
    due:=coalesce((p_payload->>'due_day')::int,due);
    if due is null or due not between 1 and 28 then blockers:=blockers||jsonb_build_object('code','invalid_request','message','Choose the monthly due day.','field','due_day');
    else
      first_due:=date_trunc('month',eff)::date+due-1;
      if first_due<eff then first_due:=(date_trunc('month',eff)+interval '1 month')::date+due-1; end if;
      if last_date is not null and first_due>last_date then first_due:=null; end if;
    end if;
  end if;

  for c in select * from public.charges where account_id=p_account_id and tenancy_id=p_tenancy_id
    and deleted_at is null and voided_at is null and
      ((source_schedule_id=any(selected_ids) and (kind='correct_rent' or period_start>=eff)) or
       id in (select (x->>'charge_id')::uuid from jsonb_array_elements(coalesce(p_payload->'scope'->'charges','[]')) x))
    order by due_date,id loop
    select x into override from jsonb_array_elements(coalesce(p_payload->'scope'->'charges','[]')) x where x->>'charge_id'=c.id::text;
    if c.currency<>currency or c.type<>'rent' then
      blockers:=blockers||jsonb_build_object('code','adjustment_not_supported','message','Only rent bills in the selected currency can be corrected.','field','scope.charges');
    end if;
    segment:=null;
    bill_due:=c.due_date; bill_period:=c.period_start; bill_end:=c.period_end; bill_action:='replace';
    if kind='correct_rent' then
      select x into segment from jsonb_array_elements(segments) x
        where (x->>'old_id')::uuid=c.source_schedule_id and coalesce(c.period_start,c.due_date)>=(x->>'start_date')::date
        and (x->>'end_date' is null or coalesce(c.period_start,c.due_date)<=(x->>'end_date')::date) limit 1;
      if segment is null then
        if override is null then blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','A bill falls outside the schedule dates; enter its corrected amount.','field','scope.charges'); end if;
        after_amount:=coalesce((override->>'amount_cents')::bigint,c.amount_cents);
      else
        select * into s from public.rent_schedules where id=c.source_schedule_id and account_id=p_account_id;
        changed:=(segment->>'amount_cents')::bigint<>s.amount_cents;
        after_amount:=case when changed then (segment->>'amount_cents')::bigint else c.amount_cents end;
        if changed and (c.amount_cents<>s.amount_cents or c.period_start is null) and override is null then
          blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','A manual or adjusted bill needs an explicit corrected amount.','field','scope.charges');
        end if;
        after_amount:=coalesce((override->>'amount_cents')::bigint,after_amount);
      end if;
    else
      after_amount:=amount;
      select * into s from public.rent_schedules where id=c.source_schedule_id and account_id=p_account_id;
      if due is distinct from s.due_day and due between 1 and 28 then
        bill_due:=date_trunc('month',coalesce(c.period_start,c.due_date))::date+due-1;
        bill_period:=bill_due;
        bill_end:=(bill_due+interval '1 month'-interval '1 day')::date;
        if bill_due<eff or (last_date is not null and bill_due>last_date) then
          bill_action:='void'; after_amount:=0;
        end if;
      end if;
      if c.amount_cents<>s.amount_cents then blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','An affected bill has an adjusted amount. Correct that bill before changing this billing period.'); end if;
    end if;
    plans:=plans||jsonb_build_object('id',c.id,'after_amount_cents',after_amount,'action',bill_action,'segment',segment,'due_date',bill_due,'period_start',bill_period,'period_end',bill_end);
    affected_ids:=array_append(affected_ids,c.id);
  end loop;
  if kind='change_rent' and exists (
    select 1 from jsonb_array_elements(plans) entry where entry->>'action'='replace'
      group by entry->>'period_start' having count(*)>1
  ) then
    blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','Multiple bills would cover the same new period. Resolve the duplicate bills before changing rent.');
  end if;
  with recursive derived as (
    select id from public.charges where account_id=p_account_id and tenancy_id=p_tenancy_id
      and parent_charge_id=any(affected_ids) and voided_at is null and deleted_at is null
    union select child.id from public.charges child join derived d on child.parent_charge_id=d.id
      where child.account_id=p_account_id and child.voided_at is null and child.deleted_at is null
  ) select coalesce(array_agg(id),'{}') into fees from derived;
  for c in select * from public.charges where id=any(fees) and not(id=any(affected_ids)) order by id loop
    if c.currency<>currency then
      blockers:=blockers||jsonb_build_object('code','adjustment_not_supported','message','A dependent fee uses a different currency. Resolve that fee before correcting rent.');
    end if;
    plans:=plans||jsonb_build_object('id',c.id,'after_amount_cents',0,'action','void','segment',null);
  end loop;
  for plan in select x from jsonb_array_elements(plans) x loop
    select * into c from public.charges where id=(plan->>'id')::uuid and account_id=p_account_id;
    remaining:=(plan->>'after_amount_cents')::bigint; applied:=0; carried:=0;
    for allocation in select a.* from public.payment_allocations a join public.payments p on p.id=a.payment_id
      where a.account_id=p_account_id and a.charge_id=c.id and a.voided_at is null and a.deleted_at is null
        and p.voided_at is null and p.deleted_at is null order by a.created_at,a.id loop
      take:=least(remaining,allocation.amount_cents); remaining:=remaining-take;
      applied:=applied+allocation.amount_cents; carried:=carried+take;
      applications:=applications||jsonb_build_object('id',allocation.id,'payment_id',allocation.payment_id,'charge_id',c.id,
        'before_amount_cents',allocation.amount_cents,'after_amount_cents',take);
    end loop;
    bills:=bills||jsonb_build_object('id',c.id,'due_date',c.due_date,'after_due_date',case when plan->>'action'='replace' then plan->>'due_date' else null end,'period_start',coalesce(c.period_start,c.due_date),
      'before_amount_cents',c.amount_cents,'after_amount_cents',(plan->>'after_amount_cents')::bigint,
      'applied_cents',applied,'carried_cents',carried,'credit_cents',applied-carried,
      'balance_before_cents',c.amount_cents-applied,'balance_after_cents',remaining,'action',plan->>'action');
  end loop;
  select jsonb_build_object('currency',currency,
    'billed_before_cents',coalesce(sum((x->>'before_amount_cents')::bigint),0),
    'billed_after_cents',coalesce(sum((x->>'after_amount_cents')::bigint),0),
    'applied_before_cents',coalesce(sum((x->>'applied_cents')::bigint),0),
    'applied_after_cents',coalesce(sum((x->>'carried_cents')::bigint),0),
    'credit_released_cents',coalesce(sum((x->>'credit_cents')::bigint),0),
    'balance_before_cents',coalesce(sum((x->>'balance_before_cents')::bigint),0),
    'balance_after_cents',coalesce(sum((x->>'balance_after_cents')::bigint),0))
    into total from jsonb_array_elements(bills) x;

  -- Complete sets catch insertions, reversals, and generator runs between preview and save.
  select jsonb_build_object('version',1,'actor',public._request_actor(),'input',p_payload,'tenancy',to_jsonb(t),
    'leases',(select jsonb_agg(to_jsonb(x) order by id) from public.leases x where account_id=p_account_id and tenancy_id=p_tenancy_id),
    'schedules',(select jsonb_agg(to_jsonb(x) order by id) from public.rent_schedules x where account_id=p_account_id and tenancy_id=p_tenancy_id),
    'charges',(select jsonb_agg(to_jsonb(x) order by id) from public.charges x where account_id=p_account_id and tenancy_id=p_tenancy_id),
    'payments',(select jsonb_agg(to_jsonb(x) order by id) from public.payments x where account_id=p_account_id and tenancy_id=p_tenancy_id),
    'applications',(select jsonb_agg(to_jsonb(x) order by x.id) from public.payment_allocations x join public.payments p on p.id=x.payment_id where x.account_id=p_account_id and p.tenancy_id=p_tenancy_id),
    'notices',(select jsonb_agg(to_jsonb(x) order by id) from public.notices x where account_id=p_account_id and tenancy_id=p_tenancy_id)) into fingerprint;
  result:=jsonb_build_object('kind',kind,'currency',currency,'input',p_payload,'lease',lease_effect,
    'schedules',schedules,'bills',bills,'applications',applications,'totals',jsonb_build_array(total),
    'blockers',blockers,'information',information,'first_bill',case when first_due is null then null else
      jsonb_build_object('due_date',first_due,'period_start',first_due,'amount_cents',amount) end,
    'preview_token',encode(extensions.digest(fingerprint::text,'sha256'),'hex'),
    '_segments',segments,'_plans',plans,'_selected_ids',to_jsonb(selected_ids));
  return result;
end $function$;


create or replace function public.commit_rent_adjustment(p_account_id uuid,p_tenancy_id uuid,p_payload jsonb,
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
  if public._request_actor() is null or not public.is_account_member(p_account_id) then raise exception 'not_found' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||p_tenancy_id::text,0));
  select * into claim from public.idempotency_keys where account_id=p_account_id and key=p_request_key for update;
  if not found or claim.request_fingerprint is distinct from p_request_fingerprint then raise exception 'idempotency_conflict'; end if;
  select * into prior from public.rent_adjustments where account_id=p_account_id and request_key=p_request_key;
  if found then
    if prior.request_fingerprint is distinct from p_request_fingerprint or prior.created_by<>public._request_actor() or prior.tenancy_id<>p_tenancy_id then
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
        values(p_account_id,p_tenancy_id,c.type,(item->>'after_amount_cents')::bigint,c.currency,(item->>'due_date')::date,(item->>'period_start')::date,(item->>'period_end')::date,
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
      values(operation_id,p_account_id,p_tenancy_id,p_payload->>'kind',public._request_actor(),saved_at,p_request_key,p_request_fingerprint,receipt);
  end if;
  update public.idempotency_keys set status_code=200,body=receipt,completed_at=now()
    where account_id=p_account_id and key=p_request_key and request_fingerprint=p_request_fingerprint;
  if not found then raise exception 'idempotency_completion_lost'; end if;
  return receipt;
end $$;
