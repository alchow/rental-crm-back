create or replace function public._plan_rent_adjustment(p_account_id uuid,p_tenancy_id uuid,p_payload jsonb)
returns jsonb language plpgsql stable set search_path=public,extensions as $$
declare
  t public.tenancies; l public.leases; s public.rent_schedules; c public.charges; n public.notices;
  kind text:=p_payload->>'kind'; terms jsonb; source jsonb:=p_payload->'source'; scope jsonb;
  currency text; amount bigint; eff date; first_due date; last_date date; due int;
  from_date date; to_date date; selected boolean; changed boolean; after_amount bigint;
  lease_effect jsonb:='null'; schedules jsonb:='[]'; segments jsonb:='[]'; bills jsonb:='[]';
  applications jsonb:='[]'; blockers jsonb:='[]'; information jsonb:='[]';
  fingerprint jsonb; result jsonb; plans jsonb:='[]'; plan jsonb; segment jsonb; override jsonb;
  allocation record; applied bigint; carried bigint; remaining bigint; take bigint; total jsonb;
  selected_ids uuid[]:='{}'; affected_ids uuid[]:='{}'; fees uuid[]:='{}'; lease_id uuid;
begin
  if auth.uid() is null or not public.is_account_member(p_account_id) then
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
      if c.amount_cents<>s.amount_cents then blockers:=blockers||jsonb_build_object('code','adjustment_scope_required','message','An affected bill has an adjusted amount. Correct that bill before changing this billing period.'); end if;
    end if;
    plans:=plans||jsonb_build_object('id',c.id,'after_amount_cents',after_amount,'action','replace','segment',segment);
    affected_ids:=array_append(affected_ids,c.id);
  end loop;
  with recursive derived as (
    select id from public.charges where account_id=p_account_id and tenancy_id=p_tenancy_id
      and parent_charge_id=any(affected_ids) and voided_at is null and deleted_at is null
    union select c.id from public.charges c join derived d on c.parent_charge_id=d.id
      where c.account_id=p_account_id and c.voided_at is null and c.deleted_at is null
  ) select coalesce(array_agg(id),'{}') into fees from derived;
  for c in select * from public.charges where id=any(fees) and not(id=any(affected_ids)) order by id loop
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
    bills:=bills||jsonb_build_object('id',c.id,'due_date',c.due_date,'period_start',coalesce(c.period_start,c.due_date),
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
  select jsonb_build_object('version',1,'actor',auth.uid(),'input',p_payload,'tenancy',to_jsonb(t),
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
end $$;

create or replace function public._rent_writer_serialization_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenancy_id uuid;
begin
  if TG_TABLE_NAME = 'payment_allocations' then
    select x.tenancy_id
      into v_tenancy_id
      from (
        select p.tenancy_id
          from public.payments p
         where p.id = case when TG_OP = 'DELETE' then OLD.payment_id else NEW.payment_id end
        union
        select c.tenancy_id
          from public.charges c
         where c.id = case when TG_OP = 'DELETE' then OLD.charge_id else NEW.charge_id end
      ) x
     order by x.tenancy_id
     limit 1;
  else
    v_tenancy_id := case when TG_OP = 'DELETE' then OLD.tenancy_id else NEW.tenancy_id end;
  end if;

  -- UPDATE already owns a row lock, so contention must retry instead of waiting.
  perform public._lock_rent_writer(v_tenancy_id, TG_OP = 'INSERT');

  if TG_TABLE_NAME = 'charges'
     and TG_OP <> 'DELETE'
     and NEW.parent_charge_id is not null
     and (TG_OP = 'INSERT' or NEW.parent_charge_id is distinct from OLD.parent_charge_id)
     and not exists (
       select 1
         from public.charges p
        where p.account_id = NEW.account_id
          and p.id = NEW.parent_charge_id
          and p.tenancy_id = NEW.tenancy_id
          and p.deleted_at is null
          and p.voided_at is null
     )
  then
    raise exception 'parent_charge_id must reference a live charge of the same tenancy'
      using errcode = '23514';
  end if;

  if TG_TABLE_NAME = 'charges'
     and TG_OP = 'INSERT'
     and NEW.source_schedule_id is not null
     and NEW.corrects_charge_id is null
     and not exists (
       select 1
         from public.rent_schedules s
        where s.account_id = NEW.account_id
          and s.id = NEW.source_schedule_id
          and s.tenancy_id = NEW.tenancy_id
          and s.deleted_at is null
          and (NEW.period_start is null or (
            s.start_date <= NEW.period_start
            and (s.end_date is null or s.end_date >= NEW.period_start)
          ))
     )
  then
    raise exception 'source_schedule_id must cover this charge period for the same tenancy'
      using errcode = '23514';
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

