-- Confirmation records preserve acceptance of exact date facts without inventing a justification.
alter table public.tenancy_date_records
  drop constraint tenancy_date_records_kind_check,
  add constraint tenancy_date_records_kind_check check(kind in ('correction','explanation','ending_correction','warning_confirmation')),
  drop constraint tenancy_date_records_reason_note_check,
  alter column reason_note drop not null,
  add constraint tenancy_date_records_reason_note_check check(reason_note is null or length(btrim(reason_note))<=2000),
  add column subject_payment_id uuid,
  add column subject_ending_id uuid,
  add constraint date_warning_payment_fk foreign key(account_id,subject_payment_id) references public.payments(account_id,id),
  add constraint date_warning_ending_fk foreign key(account_id,subject_ending_id) references public.tenancy_endings(account_id,id);

create function public._date_warning(p_rule text,p_subject jsonb,p_fields text[],p_values jsonb,p_message text,p_context text)
returns jsonb language sql immutable set search_path=public as $$
  select jsonb_build_object('rule_id',p_rule,'version',1,'severity','review','subject',p_subject,
    'fields',p_fields,'values',p_values,'message',p_message,'reason_required',false,'explained',false,
    'confirmation_required',true,'confirmed',false,'relationship_fingerprint',encode(sha256(convert_to(
      jsonb_build_object('rule_id',p_rule,'version',1,'subject',p_subject,'values',p_values,'context',p_context)::text,'UTF8')),'hex'))
$$;

create function public._review_date_warnings(p_account uuid,p_tenancy uuid,p_findings jsonb,p_acknowledgements jsonb default '[]')
returns jsonb language plpgsql stable set search_path=public as $$
declare f jsonb;a jsonb;result jsonb:='[]';confirmed boolean;
begin
  if jsonb_typeof(p_acknowledgements) is distinct from 'array' or jsonb_array_length(p_acknowledgements)>250 then
    raise exception 'invalid_request: invalid warning acknowledgements' using errcode='22023'; end if;
  for a in select value from jsonb_array_elements(p_acknowledgements) loop
    if jsonb_typeof(a) is distinct from 'object' or a-array['relationship_fingerprint','note']<>'{}'
      or length(coalesce(a->>'relationship_fingerprint','')) not between 1 and 256
      or length(coalesce(a->>'note',''))>2000
      or not exists(select 1 from jsonb_array_elements(p_findings) w where w->>'relationship_fingerprint'=a->>'relationship_fingerprint') then
      raise exception 'date_context_changed: warning acknowledgement no longer matches' using errcode='22023'; end if;
  end loop;
  for f in select value from jsonb_array_elements(p_findings) loop
    confirmed:=exists(select 1 from jsonb_array_elements(p_acknowledgements) ack
      where ack->>'relationship_fingerprint'=f->>'relationship_fingerprint') or exists(
      select 1 from public.tenancy_date_records r where r.account_id=p_account and r.tenancy_id=p_tenancy
        and r.kind='warning_confirmation' and exists(select 1 from jsonb_array_elements(r.relationship_snapshots) s
          where s->>'relationship_fingerprint'=f->>'relationship_fingerprint'));
    result:=result||jsonb_build_array(f||jsonb_build_object('confirmation_required',true,'confirmed',confirmed,'reason_required',false));
  end loop;
  return result;
end $$;

create function public._save_date_warning_confirmations(p_account uuid,p_tenancy uuid,p_findings jsonb,p_acknowledgements jsonb,
  p_context jsonb,p_request_key text,p_request_fingerprint text,p_payment_ids jsonb default '{}',p_ending_id uuid default null)
returns void language plpgsql security definer set search_path=public as $$
declare f jsonb;a jsonb;t public.tenancies;payment_id uuid;context_after jsonb;snapshots jsonb;
begin
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account) then raise exception 'not_found' using errcode='P0002'; end if;
  select * into t from public.tenancies where account_id=p_account and id=p_tenancy and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  for f in select value from jsonb_array_elements(public._review_date_warnings(p_account,p_tenancy,p_findings,p_acknowledgements)) loop
    if not (f->>'confirmed')::boolean then raise exception 'invalid_request: explicit date warning confirmation required' using errcode='22023'; end if;
    select value into a from jsonb_array_elements(p_acknowledgements) ack where ack->>'relationship_fingerprint'=f->>'relationship_fingerprint';
    if a is null then continue; end if;
    payment_id:=coalesce((f->'subject'->>'id')::uuid,(p_payment_ids->>(f->'subject'->>'draft_key'))::uuid);
    if f->'subject'->>'type'<>'payment' then payment_id:=null; end if;
    if payment_id is not null and not exists(select 1 from public.payments p where p.account_id=p_account and p.tenancy_id=p_tenancy and p.id=payment_id) then
      raise exception 'not_found' using errcode='P0002'; end if;
    if p_ending_id is not null and not exists(select 1 from public.tenancy_endings e where e.account_id=p_account and e.tenancy_id=p_tenancy and e.id=p_ending_id) then
      raise exception 'not_found' using errcode='P0002'; end if;
    snapshots:=jsonb_build_array(f);
    if p_ending_id is not null and f->>'rule_id'='actual_ending_in_future' and (f->'values'->>'effective_date')::date=t.end_date then
      context_after:=public._date_context_without_warning(p_account,p_tenancy,null,null);
      select snapshots||coalesce(jsonb_agg(w),'[]') into snapshots from jsonb_array_elements(
        public._actual_date_warnings(context_after->'facts',public._date_warning_context(context_after))) w
        where w->>'rule_id'='actual_ending_in_future';
    end if;
    if p_context?'existing' and f->'values'?'finding' then
      context_after:=public._date_context_without_warning(p_account,p_tenancy,
        (p_context->'terms_snapshot'->'agreement'->>'id')::uuid,(p_context->>'saved_schedule_id')::uuid);
      select snapshots||public._scope_relationship_warnings(coalesce(jsonb_agg(w),'[]'),context_after->'facts',public._date_warning_context(context_after))
        into snapshots from jsonb_array_elements(context_after->'findings') w
        where w->>'rule_id'=f->>'rule_id' and w->'values'=f->'values'->'finding'->'values';
    end if;
    insert into public.tenancy_date_records(account_id,tenancy_id,kind,before_facts,after_facts,context_snapshot,
      context_fingerprint,reason_code,reason_note,created_by,request_key,request_fingerprint,response_body,relationship_snapshots,
      subject_payment_id,subject_ending_id)
    values(p_account,p_tenancy,'warning_confirmation',public._tenancy_date_facts(t),public._tenancy_date_facts(t),p_context,
      p_context->>'context_fingerprint','other',nullif(btrim(a->>'note'),''),public._tenancy_date_actor(),
      p_request_key||':warning:'||(f->>'relationship_fingerprint'),p_request_fingerprint,'{}',snapshots,payment_id,p_ending_id);
  end loop;
end $$;
grant create on schema public to tenancy_date_writer;
alter function public._save_date_warning_confirmations(uuid,uuid,jsonb,jsonb,jsonb,text,text,jsonb,uuid) owner to tenancy_date_writer;
revoke create on schema public from tenancy_date_writer;
revoke all on function public._save_date_warning_confirmations(uuid,uuid,jsonb,jsonb,jsonb,text,text,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public._save_date_warning_confirmations(uuid,uuid,jsonb,jsonb,jsonb,text,text,jsonb,uuid) to tenancy_date_writer;

create function public._actual_date_warnings(p_facts jsonb,p_context text)
returns jsonb language plpgsql stable set search_path=public as $$
declare result jsonb:='[]';today date:=(statement_timestamp() at time zone 'UTC')::date;entered date;
begin
  entered:=(p_facts->>'actual_move_in_date')::date;
  if entered>today then result:=result||jsonb_build_array(public._date_warning('actual_move_in_in_future',
    jsonb_build_object('type','tenancy','id',p_facts->'tenancy_id'),array['tenancy.actual_move_in_date'],
    p_facts||jsonb_build_object('as_of_date',today),format('Actual arrival %s is after the app date %s (UTC). This is a landlord-reported date. Possession and billing dates stay unchanged.',entered,today),p_context)); end if;
  entered:=(p_facts->>'end_date')::date;
  if p_facts->>'status'='ended' and entered>today then result:=result||jsonb_build_array(public._date_warning('actual_ending_in_future',
    jsonb_build_object('type','ending'),array['tenancy.end_date'],p_facts||jsonb_build_object('as_of_date',today),
    format('Actual ending %s is after the app date %s (UTC). The tenancy is ended now and automatic rent generation stops now. Correcting this date preserves ended status.',entered,today),p_context)); end if;
  return result;
end $$;

create function public._date_warning_message(p_finding jsonb) returns text
language plpgsql immutable set search_path=public as $$
declare dates text;start_on date;lease_on date;
begin
  select string_agg(k||': '||v,'; ' order by k) into dates from jsonb_each_text(coalesce(p_finding->'values','{}')) e(k,v)
    where v ~ '^\d{4}-\d{2}-\d{2}$';
  start_on:=(p_finding->'values'->>'schedule.start_date')::date;
  lease_on:=(p_finding->'values'->>'lease.term_start')::date;
  return coalesce(p_finding->>'message','Review these dates.')||coalesce(' '||dates||'.','')||
    case when p_finding->>'rule_id'='billing_lease_start' and start_on>lease_on then
      format(' This schedule will not create rent for %s through %s. Earlier rent is not automatically billed or waived; record an ordinary one-time charge if needed.',lease_on,start_on-1)
      else '' end;
end $$;

create function public._scope_relationship_warnings(p_findings jsonb,p_facts jsonb,p_context text)
returns jsonb language sql stable set search_path=public as $$
  select coalesce(jsonb_agg(public._date_warning(f->>'rule_id',jsonb_strip_nulls(jsonb_build_object('type','tenancy','id',p_facts->'tenancy_id')),
    array(select jsonb_array_elements_text(f->'fields')),f->'values'||jsonb_build_object('proposed_facts',p_facts,
      'as_of_date',(statement_timestamp() at time zone 'UTC')::date),public._date_warning_message(f),p_context)||jsonb_build_object('explained',f->'explained','explanation_fingerprint',f->'relationship_fingerprint')),'[]')
  from jsonb_array_elements(p_findings) f
$$;

create function public._date_warning_context(p_context jsonb) returns text
language sql immutable set search_path=public as $$
  select encode(sha256(convert_to(jsonb_build_object('lease',p_context->'lease','schedule',p_context->'schedule',
    'deposits',p_context->'deposits','ending',coalesce(nullif(p_context->'ending','null'::jsonb),'{}')-array['effective_date','correction_record_id'])::text,'UTF8')),'hex')
$$;

create function public._receipt_date_warning(p_account uuid,p_tenancy uuid,p_payment jsonb,p_context text)
returns jsonb language plpgsql stable set search_path=public as $$
declare today date:=(statement_timestamp() at time zone 'UTC')::date;entered date;
begin
  entered:=case when (p_payment->>'received_at') ~ '^\d{4}-\d{2}-\d{2}$' then public._tenancy_calendar_date(p_payment->>'received_at')
    else ((p_payment->>'received_at')::timestamptz at time zone 'UTC')::date end;
  if entered<=today then return '[]'; end if;
  return jsonb_build_array(public._date_warning('receipt_in_future',jsonb_strip_nulls(jsonb_build_object('type','payment',
    'id',p_payment->'id','draft_key',p_payment->'draft_key')),array['payment.received_at'],
    jsonb_build_object('account_id',p_account,'tenancy_id',p_tenancy,'payment',p_payment,'as_of_date',today),
    format('Receipt date %s is after the app date %s (UTC). This records the %s %s payment now. Allocations change the current balance now; this does not schedule a transfer. Statements before the receipt date exclude it.',
      entered,today,(p_payment->>'amount_cents')::numeric/100,p_payment->>'currency'),p_context));
end $$;

-- Adapt the existing routines in place while retaining their locks, scope checks and immutable evidence writes.
do $migration$
declare body text;old text;new text;
begin
  body:=pg_get_functiondef('public.get_tenancy_onboarding_progress(uuid,uuid)'::regprocedure);
  execute replace(body,'auth.uid()','public._tenancy_date_actor()');
  body:=pg_get_functiondef('public._schedule_terms_snapshot_guard()'::regprocedure);
  execute replace(body,'auth.uid()','public._tenancy_date_actor()');
  body:=pg_get_functiondef('public._period_override_guard()'::regprocedure);
  execute replace(body,'auth.uid()','public._tenancy_date_actor()');
  body:=pg_get_functiondef('public._guard_tenancy_date_write()'::regprocedure);
  old:=E'    if NEW.actual_move_in_date>(now() at time zone ''UTC'')::date then\n      raise exception ''actual_move_in_in_future'' using errcode=''22023''; end if;';
  assert position(old in body)>0,'arrival insert guard source mismatch';
  execute replace(body,old,'');

  body:=pg_get_functiondef('public._preview_tenancy_date_change(uuid,uuid,jsonb,boolean)'::regprocedure);
  body:=replace(body,'if actual>today then blockers:=array_append(blockers,''actual_move_in_in_future''); end if;','');
  body:=replace(body,'if new_end>today then blockers:=array_append(blockers,''date_status_conflict''); end if;','');
  body:=regexp_replace(body,E'\n[ \t]+\n',E'\n\n','g');
  old:='  return jsonb_build_object(''current'',old_f';
  new:=E'  findings:=public._review_date_warnings(p_account_id,p_tenancy_id,public._scope_relationship_warnings(findings,new_f,public._date_warning_context(ctx))||public._actual_date_warnings(new_f,public._date_warning_context(ctx)),coalesce(p_payload->''warning_acknowledgements'',''[]''));\n  return jsonb_build_object(''current'',old_f';
  assert position(old in body)>0,'date preview source mismatch';execute replace(body,old,new);

  body:=pg_get_functiondef('public._applicable_date_findings(uuid,uuid,jsonb)'::regprocedure);
  body:=replace(body,'and (r.context_snapshot','and r.kind<>''warning_confirmation'' and nullif(btrim(r.reason_note),'''') is not null and (r.context_snapshot');
  execute body;

  body:=pg_get_functiondef('public.get_tenancy_date_context(uuid,uuid,uuid,uuid)'::regprocedure);
  body:=replace(body,'from public.tenancy_date_records r where r.account_id=p_account_id and r.tenancy_id=t.id',
    'from public.tenancy_date_records r where r.account_id=p_account_id and r.tenancy_id=t.id and r.kind<>''warning_confirmation'' and nullif(btrim(r.reason_note),'''') is not null');
  -- The public context adds confirmations below through its wrapper; internal context fingerprints retain their existing scope.
  execute replace(body,'FUNCTION public.get_tenancy_date_context(','FUNCTION public._date_context_without_warning(');

  body:=pg_get_functiondef('public._write_tenancy_date_record(uuid,uuid,text,text,jsonb,text)'::regprocedure);
  body:=replace(body,'''source_document_id'',''explained_rule_ids'']','''source_document_id'',''explained_rule_ids'',''warning_acknowledgements'']');
  body:=replace(body,'not between 1 and 2000','not between 0 and 2000');
  body:=replace(body,'btrim(p_payload->>''reason_note'')','coalesce(btrim(p_payload->>''reason_note''),'''')');
  old:='    if p_payload->>''source_document_id'' is not null then';
  new:=E'    perform public._save_date_warning_confirmations(p_account_id,p_tenancy_id,coalesce(preview->''findings'',ctx->''findings''),\n      coalesce(p_payload->''warning_acknowledgements'',''[]''),ctx,p_idempotency_key,p_request_fingerprint);\n    if nullif(btrim(p_payload->>''reason_note''),'''') is null then relationships:=''[]''; end if;\n'||old;
  assert position(old in body)>0,'date writer source mismatch';execute replace(body,old,new);

  body:=pg_get_functiondef('public.preview_billing_setup(uuid,uuid,jsonb)'::regprocedure);
  body:=replace(body,'''expected_context'',''operation'']','''expected_context'',''operation'',''warning_acknowledgements'']');
  old:=E'      or (case when (v_elem->>''received_at'') ~ ''^\\d{4}-\\d{2}-\\d{2}$''\n        then (v_elem->>''received_at'')::date > v_today\n        else (v_elem->>''received_at'')::timestamptz > clock_timestamp() end)';
  assert position(old in body)>0,'billing receipt source mismatch';body:=replace(body,old,'');
  body:=replace(body,'where value->>''severity'' = ''review'' and not','where value->>''severity'' = ''review'' and value->>''rule_id'' not in (''billing_outside_agreement'',''billing_outside_possession'') and not coalesce((value->>''confirmation_required'')::boolean,false) and not');
  -- Shared relationship findings and the billing date comparisons require confirmation, not a reason.
  old:=E'  v_seen := ''{}'';\n  for v_elem in select value from jsonb_array_elements(v_candidates) loop';
  new:=E'  select coalesce(jsonb_agg(case when f?''relationship_fingerprint'' or f->>''rule_id'' in (''billing_outside_agreement'',''billing_outside_possession'') then\n    public._date_warning(f->>''rule_id'',jsonb_build_object(''type'',''tenancy'',''id'',p_tenancy_id),coalesce(array(select jsonb_array_elements_text(f->''fields'')),array[''rent.coverage_start'']),\n      jsonb_build_object(''finding'',f,''rent'',r,''deposit'',d,''as_of_date'',v_today),public._date_warning_message(f),encode(sha256(convert_to(jsonb_build_object(''tenancy'',to_jsonb(t),''lease'',to_jsonb(l),''schedules'',v_schedules,''charges'',v_charges,''payments'',v_payments,''allocations'',v_allocations,''intent'',p_intent-array[''warning_acknowledgements'',''expected_context''])::text,''UTF8'')),''hex'')) else f end),''[]'') into v_findings from jsonb_array_elements(v_findings) f;\n'||old;
  assert position(old in body)>0,'billing finding review source mismatch';body:=replace(body,old,new);
  old:='  v_hash := encode(sha256(convert_to(v_context::text,''UTF8'')),''hex'');';
  new:=old||E'\n  for v_elem in select value from jsonb_array_elements(coalesce(p_intent->''payments'',''[]'')) loop\n    v_findings:=v_findings||public._receipt_date_warning(p_account_id,p_tenancy_id,v_elem,v_hash);\n  end loop;\n  select coalesce(jsonb_agg(f),''[]'') into v_shared_findings from jsonb_array_elements(v_findings) f where coalesce((f->>''confirmation_required'')::boolean,false);\n  v_shared_findings:=public._review_date_warnings(p_account_id,p_tenancy_id,v_shared_findings,coalesce(p_intent->''warning_acknowledgements'',''[]''));\n  select coalesce(jsonb_agg(f),''[]'') into v_findings from jsonb_array_elements(v_findings) f where not coalesce((f->>''confirmation_required'')::boolean,false);\n  v_findings:=v_findings||v_shared_findings;';
  assert position(old in body)>0,'billing context source mismatch';body:=replace(body,old,new);
  body:=replace(body,'where f->>''severity'' = ''error''','where f->>''severity'' = ''error'' or (coalesce((f->>''confirmation_required'')::boolean,false) and not (f->>''confirmed'')::boolean)');
  execute body;

  body:=pg_get_functiondef('public.commit_billing_setup(uuid,uuid,jsonb,text,text)'::regprocedure);
  body:=replace(body,'auth.uid()','public._tenancy_date_actor()');
  old:='  insert into public.tenancy_onboarding_progress';
  new:=E'  perform public._save_date_warning_confirmations(p_account_id,p_tenancy_id,(select coalesce(jsonb_agg(f),''[]'') from jsonb_array_elements(v_preview->''findings'') f where coalesce((f->>''confirmation_required'')::boolean,false)),\n    coalesce(p_intent->''warning_acknowledgements'',''[]''),v_preview||jsonb_build_object(''saved_schedule_id'',v_schedule_id),p_idempotency_key,p_request_fingerprint,v_payment_ids);\n'||old;
  assert position(old in body)>0,'billing commit source mismatch';execute replace(body,old,new);
end $migration$;

create or replace function public.get_tenancy_date_context(p_account_id uuid,p_tenancy_id uuid,p_lease_id uuid default null,p_rent_schedule_id uuid default null)
returns jsonb language plpgsql stable set search_path=public as $$
declare ctx jsonb;
begin
  ctx:=public._date_context_without_warning(p_account_id,p_tenancy_id,p_lease_id,p_rent_schedule_id);
  return ctx||jsonb_build_object('findings',public._review_date_warnings(p_account_id,p_tenancy_id,
    public._scope_relationship_warnings(ctx->'findings',ctx->'facts',public._date_warning_context(ctx))||public._actual_date_warnings(ctx->'facts',public._date_warning_context(ctx))));
end $$;

-- Guard actual future inserts even when the caller bypasses HTTP/RPC commands.
create function public._require_future_date_confirmation() returns trigger
language plpgsql set search_path=public as $$
declare entered date;subject_id uuid;
begin
  entered:=case when TG_TABLE_NAME='payments' then ((to_jsonb(NEW)->>'received_at')::timestamptz at time zone 'UTC')::date
    when TG_TABLE_NAME='tenancy_endings' then (to_jsonb(NEW)->>'effective_date')::date
    else (to_jsonb(NEW)->>'actual_move_in_date')::date end;
  if entered<=(statement_timestamp() at time zone 'UTC')::date or entered is null then return null; end if;
  if TG_TABLE_NAME='tenancy_endings' and to_jsonb(NEW)->>'kind'<>'ended' then return null; end if;
  if not exists(select 1 from public.tenancy_date_records r where r.account_id=NEW.account_id and r.kind='warning_confirmation'
    and case when TG_TABLE_NAME='payments' then r.subject_payment_id=NEW.id
      when TG_TABLE_NAME='tenancy_endings' then r.subject_ending_id=NEW.id else r.tenancy_id=NEW.id end
    and exists(select 1 from jsonb_array_elements(r.relationship_snapshots) f where
      case when TG_TABLE_NAME='payments' then (case when (f->'values'->'payment'->>'received_at') ~ '^\d{4}-\d{2}-\d{2}$'
        then (f->'values'->'payment'->>'received_at')::date else ((f->'values'->'payment'->>'received_at')::timestamptz at time zone 'UTC')::date end)=entered
        when TG_TABLE_NAME='tenancy_endings' then (f->'values'->>'effective_date')::date=entered
        else (f->'values'->>'actual_move_in_date')::date=entered end)) then
    raise exception 'invalid_request: explicit date warning confirmation required' using errcode='22023'; end if;
  return null;
end $$;
create constraint trigger payment_future_date_confirmation after insert on public.payments deferrable initially deferred
  for each row execute function public._require_future_date_confirmation();
create constraint trigger ending_future_date_confirmation after insert on public.tenancy_endings deferrable initially deferred
  for each row execute function public._require_future_date_confirmation();
create constraint trigger arrival_future_date_confirmation after insert or update of actual_move_in_date on public.tenancies deferrable initially deferred
  for each row execute function public._require_future_date_confirmation();

revoke all on function public._date_warning(text,jsonb,text[],jsonb,text,text),public._review_date_warnings(uuid,uuid,jsonb,jsonb),
  public._actual_date_warnings(jsonb,text),public._scope_relationship_warnings(jsonb,jsonb,text),public._date_warning_context(jsonb),public._date_warning_message(jsonb),public._receipt_date_warning(uuid,uuid,jsonb,text),public._date_context_without_warning(uuid,uuid,uuid,uuid)
  from public,anon;
grant execute on function public._date_warning(text,jsonb,text[],jsonb,text,text),public._review_date_warnings(uuid,uuid,jsonb,jsonb),
  public._actual_date_warnings(jsonb,text),public._scope_relationship_warnings(jsonb,jsonb,text),public._date_warning_context(jsonb),public._date_warning_message(jsonb),public._receipt_date_warning(uuid,uuid,jsonb,text),public._date_context_without_warning(uuid,uuid,uuid,uuid)
  to authenticated,service_role,tenancy_date_writer;

create function public.preview_payment(p_account_id uuid,p_payload jsonb) returns jsonb
language plpgsql stable set search_path=public as $$
declare t public.tenancies;context jsonb;fingerprint text;findings jsonb;intent jsonb:=p_payload-array['warning_acknowledgements','expected_context_fingerprint'];
begin
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then raise exception 'not_found' using errcode='P0002'; end if;
  select * into t from public.tenancies where account_id=p_account_id and id=(p_payload->>'tenancy_id')::uuid and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if (p_payload->>'amount_cents')::bigint<=0 or length(p_payload->>'currency')<>3 or p_payload->>'received_at' is null then
    raise exception 'invalid_request' using errcode='22023'; end if;
  context:=jsonb_build_object('intent',intent,'tenancy',to_jsonb(t),'as_of_date',(statement_timestamp() at time zone 'UTC')::date,
    'charges',(select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]') from public.charges c where c.account_id=p_account_id and c.tenancy_id=t.id),
    'allocations',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.payment_allocations a join public.charges c on c.account_id=a.account_id and c.id=a.charge_id
      where c.account_id=p_account_id and c.tenancy_id=t.id));
  fingerprint:=encode(sha256(convert_to(context::text,'UTF8')),'hex');
  findings:=public._review_date_warnings(p_account_id,t.id,public._receipt_date_warning(p_account_id,t.id,intent||jsonb_build_object('draft_key','receipt'),fingerprint),coalesce(p_payload->'warning_acknowledgements','[]'));
  return jsonb_build_object('as_of_date',(statement_timestamp() at time zone 'UTC')::date,'clock_basis','UTC',
    'context_fingerprint',fingerprint,'findings',findings,'can_commit',not exists(select 1 from jsonb_array_elements(findings) f where not (f->>'confirmed')::boolean));
end $$;

create function public.preview_tenancy_ending(p_account_id uuid,p_tenancy_id uuid,p_payload jsonb) returns jsonb
language plpgsql stable set search_path=public as $$
declare ctx jsonb;intent jsonb:=p_payload-array['warning_acknowledgements','expected_context_fingerprint'];fingerprint text;
  findings jsonb:='[]';today date:=(statement_timestamp() at time zone 'UTC')::date;entered date;
begin
  ctx:=public.get_tenancy_date_context(p_account_id,p_tenancy_id);
  entered:=public._tenancy_calendar_date(p_payload->>'effective_date');
  if p_payload->>'kind'='ended' and entered<(ctx->'facts'->>'start_date')::date then raise exception 'invalid_date_order' using errcode='22023'; end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('intent',intent,'context',ctx->>'context_fingerprint','as_of_date',today)::text,'UTF8')),'hex');
  if p_payload->>'kind'='ended' and entered>today then findings:=jsonb_build_array(public._date_warning('actual_ending_in_future',
    jsonb_build_object('type','ending'),array['ending.effective_date'],intent||jsonb_build_object('account_id',p_account_id,'tenancy_id',p_tenancy_id,'as_of_date',today,'resulting_status','ended'),
    format('Actual ending %s is after the app date %s (UTC). Recording this ends the tenancy now and stops automatic rent generation now.',entered,today),fingerprint)); end if;
  findings:=public._review_date_warnings(p_account_id,p_tenancy_id,findings,coalesce(p_payload->'warning_acknowledgements','[]'));
  return jsonb_build_object('as_of_date',today,'clock_basis','UTC','context_fingerprint',fingerprint,'findings',findings,
    'can_commit',not exists(select 1 from jsonb_array_elements(findings) f where not (f->>'confirmed')::boolean));
end $$;

create function public.record_payment(p_account_id uuid,p_payload jsonb,p_idempotency_key text,p_request_fingerprint text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare preview jsonb;result jsonb;k public.idempotency_keys;t uuid:=(p_payload->>'tenancy_id')::uuid;
begin
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then raise exception 'not_found' using errcode='P0002'; end if;
  select * into k from public.idempotency_keys where account_id=p_account_id and key=p_idempotency_key for update;
  if not found or k.request_fingerprint is distinct from p_request_fingerprint then raise exception 'idempotency_fingerprint_mismatch'; end if;
  if k.completed_at is not null then return k.body; end if;
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||t::text,0));
  preview:=public.preview_payment(p_account_id,p_payload);
  if p_payload->>'expected_context_fingerprint' is not null and p_payload->>'expected_context_fingerprint' is distinct from preview->>'context_fingerprint'
    then raise exception 'date_context_changed'; end if;
  if not (preview->>'can_commit')::boolean then raise exception 'invalid_request: explicit date warning confirmation required' using errcode='22023'; end if;
  select jsonb_build_object('payment',p.payment,'allocations',p.allocations) into result from public.create_payment_with_allocations(
    p_account_id,t,(p_payload->>'amount_cents')::bigint,p_payload->>'currency',
    case when (p_payload->>'received_at') ~ '^\d{4}-\d{2}-\d{2}$' then ((p_payload->>'received_at')::date::timestamp+interval '12 hours') at time zone 'UTC'
      else (p_payload->>'received_at')::timestamptz end,p_payload->>'method',
    p_payload->>'reference',(p_payload->>'payer_tenant_id')::uuid,p_payload->>'notes',coalesce(p_payload->'allocations','[]')) p;
  perform public._save_date_warning_confirmations(p_account_id,t,preview->'findings',coalesce(p_payload->'warning_acknowledgements','[]'),preview,
    p_idempotency_key,p_request_fingerprint,jsonb_build_object('receipt',result->'payment'->'id'));
  -- Ordinary receipt findings use a stable draft identity until the payment receives its database ID.
  update public.idempotency_keys set status_code=201,body=result,completed_at=clock_timestamp() where account_id=p_account_id and key=p_idempotency_key;
  return result;
end $$;

create function public.record_tenancy_ending(p_account_id uuid,p_tenancy_id uuid,p_payload jsonb,p_idempotency_key text,p_request_fingerprint text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare preview jsonb;result jsonb;k public.idempotency_keys;
begin
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then raise exception 'not_found' using errcode='P0002'; end if;
  select * into k from public.idempotency_keys where account_id=p_account_id and key=p_idempotency_key for update;
  if not found or k.request_fingerprint is distinct from p_request_fingerprint then raise exception 'idempotency_fingerprint_mismatch'; end if;
  if k.completed_at is not null then return k.body; end if;
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||p_tenancy_id::text,0));
  perform 1 from public.tenancies where account_id=p_account_id and id=p_tenancy_id for update;
  preview:=public.preview_tenancy_ending(p_account_id,p_tenancy_id,p_payload);
  if p_payload->>'expected_context_fingerprint' is not null and p_payload->>'expected_context_fingerprint' is distinct from preview->>'context_fingerprint'
    then raise exception 'date_context_changed'; end if;
  if not (preview->>'can_commit')::boolean then raise exception 'invalid_request: explicit date warning confirmation required' using errcode='22023'; end if;
  result:=public.end_tenancy(p_account_id,p_tenancy_id,p_payload->>'kind',(p_payload->>'effective_date')::date,
    coalesce(p_payload->>'initiated_by','unknown'),coalesce(p_payload->>'reason_code','other'),nullif(p_payload->>'reason_note',''),
    (p_payload->>'source_notice_id')::uuid,(p_payload->>'source_interaction_id')::uuid);
  perform public._save_date_warning_confirmations(p_account_id,p_tenancy_id,preview->'findings',coalesce(p_payload->'warning_acknowledgements','[]'),preview,
    p_idempotency_key,p_request_fingerprint,'{}',(result->'ending'->>'id')::uuid);
  update public.idempotency_keys set status_code=200,body=result,completed_at=clock_timestamp() where account_id=p_account_id and key=p_idempotency_key;
  return result;
end $$;

do $$ declare body text;old text;
begin
  body:=pg_get_functiondef('public.end_tenancy(uuid,uuid,text,date,text,text,text,uuid,uuid)'::regprocedure);
  old:=E'    if p_effective_date > (statement_timestamp() at time zone ''UTC'')::date then\n      raise exception ''invalid: ending effective_date cannot be in the future'';\n    end if;';
  assert position(old in body)>0,'ending future guard source mismatch';execute replace(body,old,'');
end $$;

grant create on schema public to tenancy_date_writer;
alter function public.record_payment(uuid,jsonb,text,text) owner to tenancy_date_writer;
alter function public.record_tenancy_ending(uuid,uuid,jsonb,text,text) owner to tenancy_date_writer;
alter function public.commit_billing_setup(uuid,uuid,jsonb,text,text) security definer;
alter function public.commit_billing_setup(uuid,uuid,jsonb,text,text) owner to tenancy_date_writer;
revoke create on schema public from tenancy_date_writer;
grant select,insert,update on public.payments,public.payment_allocations,public.charges,public.rent_schedules,
  public.tenancy_adoptions,public.rent_schedule_period_overrides,public.tenancy_onboarding_progress,public.tenancy_endings to tenancy_date_writer;
grant select on public.inspections,public.interactions to tenancy_date_writer;
grant execute on function public._tenancy_date_actor() to service_role;
grant execute on function public.create_payment_with_allocations(uuid,uuid,bigint,text,timestamptz,text,text,uuid,text,jsonb),
  public.end_tenancy(uuid,uuid,text,date,text,text,text,uuid,uuid),public.get_tenancy_onboarding_progress(uuid,uuid),
  public._schedule_billing_intent(public.rent_schedules) to tenancy_date_writer;
revoke all on function public.preview_payment(uuid,jsonb),public.preview_tenancy_ending(uuid,uuid,jsonb),
  public.record_payment(uuid,jsonb,text,text),public.record_tenancy_ending(uuid,uuid,jsonb,text,text) from public,anon;
grant execute on function public.preview_payment(uuid,jsonb),public.preview_tenancy_ending(uuid,uuid,jsonb),
  public.record_payment(uuid,jsonb,text,text),public.record_tenancy_ending(uuid,uuid,jsonb,text,text) to authenticated,tenancy_date_writer;
