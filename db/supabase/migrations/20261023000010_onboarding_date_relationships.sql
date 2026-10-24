-- Date reasons attach to exact relationship values; actual endings retain original evidence.
alter table public.tenancy_date_records
  drop constraint tenancy_date_records_kind_check,
  add constraint tenancy_date_records_kind_check check (kind in ('correction','explanation','ending_correction')),
  add column corrects_ending_id uuid,
  add column corrects_record_id uuid,
  add column relationship_snapshots jsonb not null default '[]' check (jsonb_typeof(relationship_snapshots)='array'),
  add constraint tenancy_date_records_account_id_id_key unique(account_id,id),
  add constraint date_record_ending_account_fk foreign key(account_id,corrects_ending_id)
    references public.tenancy_endings(account_id,id),
  add constraint date_record_predecessor_account_fk foreign key(account_id,corrects_record_id)
    references public.tenancy_date_records(account_id,id),
  add constraint date_record_ending_kind check ((kind='ending_correction')=(corrects_ending_id is not null));
grant update(end_date) on public.tenancies to tenancy_date_writer;
-- A row lock requires UPDATE privilege; the command cannot change contractual fields.
grant update(updated_at) on public.leases to tenancy_date_writer;

create or replace function public._tenancy_date_facts(p_t public.tenancies) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('account_id',p_t.account_id,'tenancy_id',p_t.id,
    'start_date',p_t.start_date,'start_date_basis',p_t.start_date_basis,
    'actual_move_in_date',p_t.actual_move_in_date,'status',public.effective_tenancy_status(p_t.status,p_t.start_date),
    'end_date',p_t.end_date,'date_revision',p_t.date_revision)
$$;

create function public._date_relationship_finding(p_rule text,p_fields text[],p_values jsonb,p_message text)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object('rule_id',p_rule,'version',1,'severity','review','fields',p_fields,
    'values',p_values,'message',p_message,'reason_required',true,'explained',false,
    'relationship_fingerprint',encode(sha256(convert_to(jsonb_build_object(
      'rule_id',p_rule,'version',1,'values',p_values)::text,'UTF8')),'hex'))
$$;
revoke all on function public._date_relationship_finding(text,text[],jsonb,text) from public,anon;
grant execute on function public._date_relationship_finding(text,text[],jsonb,text) to authenticated,service_role,tenancy_date_writer;

create function public._tenancy_date_findings(p_facts jsonb,p_lease jsonb,p_schedule jsonb,p_deposits jsonb default '[]')
returns jsonb language plpgsql immutable set search_path = public as $$
declare result jsonb := '[]'; scope jsonb; vals jsonb; d jsonb;
  renewal boolean := coalesce(p_lease->>'agreement_kind','original') in ('renewal','amendment');
begin
  p_lease:=nullif(p_lease,'null'::jsonb);p_schedule:=nullif(p_schedule,'null'::jsonb);
  scope := jsonb_build_object('account_id',p_facts->'account_id','tenancy_id',p_facts->'tenancy_id');
  if p_lease is not null then
    vals := scope||jsonb_build_object('lease_id',p_lease->'id');
    if not renewal and p_lease->>'term_start' is distinct from p_facts->>'start_date' then
      result := result||jsonb_build_array(public._date_relationship_finding('possession_lease_start',
        array['tenancy.start_date','lease.term_start'],vals||jsonb_build_object(
          'tenancy.start_date',p_facts->'start_date','lease.term_start',p_lease->'term_start'),
        'Lease start and agreed possession start differ. Confirm the agreement basis for these dates.'));
    end if;
    if p_lease->>'term_end' is not null and p_facts->>'end_date' is not null
      and p_lease->>'term_end' <> p_facts->>'end_date' then
      result := result||jsonb_build_array(public._date_relationship_finding('possession_lease_end',
        array['tenancy.end_date','lease.term_end'],vals||jsonb_build_object(
          'tenancy.end_date',p_facts->'end_date','lease.term_end',p_lease->'term_end'),
        'Lease end and possession end differ. Confirm which agreement allows the difference.'));
    end if;
  end if;
  if p_schedule is not null then
    if p_schedule->>'start_date' <> p_facts->>'start_date' and
      (not renewal or (p_schedule->>'start_date')::date < (p_facts->>'start_date')::date) then
      result := result||jsonb_build_array(public._date_relationship_finding('billing_possession_start',
        array['tenancy.start_date','schedule.start_date'],scope||jsonb_build_object(
          'tenancy.start_date',p_facts->'start_date','schedule.start_date',p_schedule->'start_date'),
        'Rent coverage starts on a different date from possession. Confirm the billing instruction.'));
    end if;
    if p_facts->>'end_date' is not null and (p_schedule->>'end_date' is null or
      (p_schedule->>'end_date')::date > (p_facts->>'end_date')::date) then
      result := result||jsonb_build_array(public._date_relationship_finding('billing_possession_end',
        array['tenancy.end_date','schedule.end_date'],scope||jsonb_build_object(
          'tenancy.end_date',p_facts->'end_date','schedule.end_date',p_schedule->'end_date'),
        'Rent coverage extends beyond possession end. Confirm the billing basis; recurrence still stops on a recorded ending.'));
    end if;
    if p_lease is not null then
      vals := scope||jsonb_build_object('lease_id',p_lease->'id');
      if p_schedule->>'start_date' <> p_lease->>'term_start' then
        result := result||jsonb_build_array(public._date_relationship_finding('billing_lease_start',
          array['lease.term_start','schedule.start_date'],vals||jsonb_build_object(
            'lease.term_start',p_lease->'term_start','schedule.start_date',p_schedule->'start_date'),
          'Rent coverage start and the selected agreement start differ. Confirm the billing basis.'));
      end if;
      if p_lease->>'term_end' is not null and (p_schedule->>'end_date' is null
        or p_schedule->>'end_date' <> p_lease->>'term_end') then
        result := result||jsonb_build_array(public._date_relationship_finding('billing_lease_end',
          array['lease.term_end','schedule.end_date'],vals||jsonb_build_object(
            'lease.term_end',p_lease->'term_end','schedule.end_date',p_schedule->'end_date'),
          'Rent coverage end and the selected agreement end differ. Confirm the billing basis.'));
      end if;
    end if;
  end if;
  for d in select value from jsonb_array_elements(coalesce(p_deposits,'[]')) loop
    if p_facts->>'end_date' is not null and (d->>'due_date')::date > (p_facts->>'end_date')::date then
      result := result||jsonb_build_array(public._date_relationship_finding('deposit_due_after_possession_end',
        array['tenancy.end_date','deposit.due_date'],scope||jsonb_build_object(
          'tenancy.end_date',p_facts->'end_date','deposit.due_date',d->'due_date'),
        'The deposit obligation is due after possession ends. Confirm its recorded agreement basis.'));
    end if;
  end loop;
  return result;
end $$;
revoke all on function public._tenancy_date_findings(jsonb,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public._tenancy_date_findings(jsonb,jsonb,jsonb,jsonb) to authenticated,service_role,tenancy_date_writer;

create function public._applicable_date_findings(p_account_id uuid,p_tenancy_id uuid,p_findings jsonb)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(f||jsonb_build_object('explained',exists(
    select 1 from public.tenancy_date_records r where r.account_id=p_account_id and r.tenancy_id=p_tenancy_id
      and (r.context_snapshot->>'relationship_fingerprint'=f->>'relationship_fingerprint'
        or exists(select 1 from jsonb_array_elements(r.relationship_snapshots) snap
          where snap->>'relationship_fingerprint'=f->>'relationship_fingerprint')
        -- COMPAT: Only records predating scoped snapshots infer reasons from their complete context.
        or (r.kind='explanation' and r.context_snapshot->>'version'='1'
          and not (r.context_snapshot ? 'relationship_scope_version')
          and r.relationship_snapshots='[]'::jsonb and exists(
          select 1 from jsonb_array_elements(public._tenancy_date_findings(
            r.after_facts||jsonb_build_object('account_id',r.account_id,'tenancy_id',r.tenancy_id),
            r.context_snapshot->'lease',r.context_snapshot->'schedule',coalesce(r.context_snapshot->'deposits','[]'))) old_f
            where old_f->>'relationship_fingerprint'=f->>'relationship_fingerprint')))))), '[]')
  from jsonb_array_elements(p_findings) f
$$;
revoke all on function public._applicable_date_findings(uuid,uuid,jsonb) from public,anon;
grant execute on function public._applicable_date_findings(uuid,uuid,jsonb) to authenticated,service_role,tenancy_date_writer;

create function public.get_tenancy_ending_context(p_account_id uuid,p_tenancy_id uuid) returns jsonb
language plpgsql stable set search_path = public as $$
declare e public.tenancy_endings; r public.tenancy_date_records;
begin
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode='P0002'; end if;
  select * into e from public.tenancy_endings where account_id=p_account_id and tenancy_id=p_tenancy_id;
  if not found then return null; end if;
  select * into r from public.tenancy_date_records where account_id=p_account_id and tenancy_id=p_tenancy_id
    and corrects_ending_id=e.id and kind='ending_correction'
    order by (after_facts->>'date_revision')::bigint desc,created_at desc,id desc limit 1;
  return to_jsonb(e)||jsonb_build_object('effective_date',coalesce(r.after_facts->>'end_date',e.effective_date::text),
    'original_effective_date',e.effective_date,'correction_record_id',r.id);
end $$;
revoke all on function public.get_tenancy_ending_context(uuid,uuid) from public,anon;
grant execute on function public.get_tenancy_ending_context(uuid,uuid) to authenticated,tenancy_date_writer;

create or replace function public.get_tenancy_date_context(p_account_id uuid,p_tenancy_id uuid,
  p_lease_id uuid default null,p_rent_schedule_id uuid default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare t public.tenancies;l jsonb;s jsonb;e jsonb;deps jsonb;v jsonb;h text;findings jsonb;
  info text[]:='{}';explanation jsonb;today date:=(now() at time zone 'UTC')::date;
begin
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode='P0002'; end if;
  select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if p_lease_id is not null then
    select jsonb_build_object('id',id,'term_start',term_start,'term_end',term_end,'status',status,
      'voided_at',voided_at,'updated_at',updated_at,'agreement_kind',agreement_kind,'predecessor_lease_id',predecessor_lease_id)
      into l from public.leases where account_id=p_account_id and tenancy_id=t.id and id=p_lease_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
  end if;
  if p_rent_schedule_id is not null then
    select jsonb_build_object('id',id,'start_date',start_date,'end_date',end_date,'due_day',due_day,
      'updated_at',updated_at,'source_lease_id',source_lease_id) into s from public.rent_schedules
      where account_id=p_account_id and tenancy_id=t.id and id=p_rent_schedule_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
  end if;
  e:=public.get_tenancy_ending_context(p_account_id,p_tenancy_id);
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'due_date',due_date,'amount_cents',amount_cents,
    'currency',currency,'updated_at',updated_at) order by due_date,id),'[]') into deps from public.charges
    where account_id=p_account_id and tenancy_id=t.id and type='deposit' and deleted_at is null and voided_at is null;
  v:=jsonb_build_object('version',1,'facts',public._tenancy_date_facts(t),'lease',l,'schedule',s,'ending',e,'deposits',deps);
  h:=encode(sha256(convert_to(jsonb_build_object('account_id',p_account_id,'tenancy_id',p_tenancy_id,'context',v)::text,'UTF8')),'hex');
  findings:=public._applicable_date_findings(p_account_id,t.id,public._tenancy_date_findings(v->'facts',l,s,deps));
  if t.start_date_basis='legacy_unverified' then info:=array_append(info,'legacy_date_unverified'); end if;
  if jsonb_array_length(findings)>0 then info:=array_append(info,'date_values_differ'); end if;
  if s is not null and (s->>'start_date')::date<t.start_date then info:=array_append(info,'billing_precedes_possession'); end if;
  if t.status='ended' and t.end_date is null and e is null then info:=array_append(info,'legacy_ending_incomplete'); end if;
  select to_jsonb(r)-array['request_key','request_fingerprint','response_body'] into explanation
    from public.tenancy_date_records r where r.account_id=p_account_id and r.tenancy_id=t.id
      and (r.context_fingerprint=h or exists(select 1 from jsonb_array_elements(findings) f
        where (f->>'explained')::boolean and (r.context_snapshot->>'relationship_fingerprint'=f->>'relationship_fingerprint'
          or exists(select 1 from jsonb_array_elements(r.relationship_snapshots) snap
            where snap->>'relationship_fingerprint'=f->>'relationship_fingerprint'))))
      order by r.created_at desc,r.id desc limit 1;
  return v||jsonb_build_object('context_fingerprint',h,'information',info,'findings',findings,
    'applicable_explanation',explanation,'can_correct_start',coalesce(e->>'kind','')<>'cancelled_before_move_in',
    'as_of_date',today,'clock_basis','UTC','effective_status',public.effective_tenancy_status(t.status,t.start_date,today));
end $$;

create or replace function public._guard_tenancy_date_write() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP='INSERT' then
    if NEW.date_revision<>0 then raise exception 'date_revision_managed' using errcode='22023'; end if;
    if NEW.actual_move_in_date>(now() at time zone 'UTC')::date then
      raise exception 'actual_move_in_in_future' using errcode='22023'; end if;
  elsif current_user<>'tenancy_date_writer' and (
    (NEW.start_date,NEW.start_date_basis,NEW.actual_move_in_date,NEW.date_revision)
      is distinct from (OLD.start_date,OLD.start_date_basis,OLD.actual_move_in_date,OLD.date_revision)
    or (NEW.end_date is distinct from OLD.end_date and not (OLD.status<>'ended' and NEW.status='ended'
      and exists(select 1 from public.tenancy_endings e where e.account_id=NEW.account_id and e.tenancy_id=NEW.id
        and NEW.end_date=case when e.kind='ended' then e.effective_date else OLD.start_date end)))) then
    raise exception 'date_correction_required' using errcode='42501';
  end if;
  return NEW;
end $$;

create or replace function public._guard_recorded_tenancy_ending() returns trigger
language plpgsql set search_path = public as $$
declare e jsonb;expected_end date;
begin
  select jsonb_build_object('kind',te.kind,'effective_date',coalesce(
    (select r.after_facts->>'end_date' from public.tenancy_date_records r
      where r.account_id=te.account_id and r.tenancy_id=te.tenancy_id and r.corrects_ending_id=te.id
        and r.kind='ending_correction' order by (r.after_facts->>'date_revision')::bigint desc limit 1),te.effective_date::text))
    into e from public.tenancy_endings te where te.account_id=NEW.account_id and te.tenancy_id=NEW.id;
  if e is null then return NEW; end if;
  expected_end:=case when e->>'kind'='cancelled_before_move_in' then OLD.start_date else (e->>'effective_date')::date end;
  if NEW.status<>'ended' or NEW.end_date is distinct from expected_end or
    (NEW.start_date is distinct from OLD.start_date and not (current_user='tenancy_date_writer'
      and e->>'kind'='ended' and NEW.start_date<=expected_end)) then
    raise exception 'conflict: recorded ending is fixed; use a linked ending correction' using errcode='23514';
  end if;
  return NEW;
end $$;

create function public._preview_tenancy_date_change(p_account_id uuid,p_tenancy_id uuid,p_payload jsonb,p_ending boolean)
returns jsonb language plpgsql stable set search_path = public as $$
declare ctx jsonb;old_f jsonb;new_f jsonb;changes jsonb;info text[];blockers text[]:='{}';
  new_start date;new_end date;actual date;new_status text;today date:=(now() at time zone 'UTC')::date;
  n_charges bigint;n_payments bigint;n_review bigint;n_fallback bigint;findings jsonb;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'invalid_request' using errcode='22023'; end if;
  changes:=coalesce(p_payload->'changes','{}');
  if jsonb_typeof(changes) is distinct from 'object' or changes-array['start_date','start_date_basis','actual_move_in_date','end_date']<>'{}'::jsonb then
    raise exception 'invalid_request' using errcode='22023'; end if;
  ctx:=public.get_tenancy_date_context(p_account_id,p_tenancy_id,(p_payload->>'lease_id')::uuid,(p_payload->>'rent_schedule_id')::uuid);
  old_f:=ctx->'facts';new_f:=old_f||changes;
  new_start:=public._tenancy_calendar_date(new_f->>'start_date');
  if new_f->>'end_date' is not null then new_end:=public._tenancy_calendar_date(new_f->>'end_date'); end if;
  if new_f->>'start_date_basis' is null or new_f->>'start_date_basis' not in ('legacy_unverified','possession_entitlement') then
    raise exception 'invalid_request' using errcode='22023'; end if;
  if new_f->>'actual_move_in_date' is not null then actual:=public._tenancy_calendar_date(new_f->>'actual_move_in_date');
    if actual>today then blockers:=array_append(blockers,'actual_move_in_in_future'); end if; end if;
  new_status:=public.effective_tenancy_status(old_f->>'status',new_start,today);
  if new_start>new_end then blockers:=array_append(blockers,'invalid_date_order'); end if;
  if ctx->'ending'->>'kind'='cancelled_before_move_in' and
    (new_start<>(old_f->>'start_date')::date or actual is not null or changes?'end_date') then
    blockers:=array_append(blockers,'date_fixed_by_cancellation'); end if;
  if p_ending then
    if ctx->'ending'->>'kind' is distinct from 'ended' or changes-array['end_date']<>'{}'::jsonb
      or not changes?'end_date' or new_end is null then raise exception 'invalid_request' using errcode='22023'; end if;
    if new_end>today then blockers:=array_append(blockers,'date_status_conflict'); end if;
    new_status:='ended';
  elsif changes?'end_date' and (ctx->'ending' is not null and ctx->'ending'<>'null'::jsonb or old_f->>'status'='ended') then
    blockers:=array_append(blockers,'ending_correction_required');
  end if;
  if old_f->>'status' in ('holdover','ended') and new_start>today then blockers:=array_append(blockers,'date_status_conflict'); end if;
  if new_f=old_f then blockers:=array_append(blockers,'no_date_change'); end if;
  new_f:=new_f||jsonb_build_object('status',new_status,'date_revision',(old_f->>'date_revision')::bigint+case when new_f<>old_f then 1 else 0 end);
  select count(*),count(*) filter(where (
    coalesce(period_start,due_date)<greatest(new_start,(old_f->>'start_date')::date)
      and coalesce(period_end,period_start,due_date)>=least(new_start,(old_f->>'start_date')::date)
      and new_start<>(old_f->>'start_date')::date) or (new_end is distinct from (old_f->>'end_date')::date
      and coalesce(period_end,period_start,due_date)>=least(coalesce(new_end,'infinity'::date),coalesce((old_f->>'end_date')::date,'infinity'::date)))),
    count(*) filter(where period_start is null and (new_start<>(old_f->>'start_date')::date or new_end is distinct from (old_f->>'end_date')::date))
    into n_charges,n_review,n_fallback from public.charges where account_id=p_account_id and tenancy_id=p_tenancy_id and deleted_at is null and voided_at is null;
  select count(*) into n_payments from public.payments where account_id=p_account_id and tenancy_id=p_tenancy_id and deleted_at is null and voided_at is null;
  select coalesce(array_agg(value),'{}') into info from jsonb_array_elements_text(ctx->'information');
  if n_review>0 then info:=array_append(info,'charges_in_changed_interval'); end if;
  findings:=public._applicable_date_findings(p_account_id,p_tenancy_id,public._tenancy_date_findings(new_f,ctx->'lease',ctx->'schedule',ctx->'deposits'));
  return jsonb_build_object('current',old_f,'proposed',new_f,'context_fingerprint',ctx->>'context_fingerprint',
    'blockers',blockers,'information',info,'findings',findings,'as_of_date',today,'clock_basis','UTC','effective_status',new_status,
    'financial_review',jsonb_build_object('live_charges',n_charges,'live_payments',n_payments,
      'charges_in_changed_interval',n_review,'due_date_fallback_count',n_fallback,'sampled_at',now()));
end $$;
revoke all on function public._preview_tenancy_date_change(uuid,uuid,jsonb,boolean) from public,anon;
grant execute on function public._preview_tenancy_date_change(uuid,uuid,jsonb,boolean) to authenticated,tenancy_date_writer;
create or replace function public.preview_tenancy_date_correction(p_account_id uuid,p_tenancy_id uuid,p_payload jsonb)
returns jsonb language sql stable set search_path = public as $$
  select public._preview_tenancy_date_change(p_account_id,p_tenancy_id,p_payload,false)
$$;
create function public.preview_tenancy_ending_correction(p_account_id uuid,p_tenancy_id uuid,p_payload jsonb)
returns jsonb language sql stable set search_path = public as $$
  select public._preview_tenancy_date_change(p_account_id,p_tenancy_id,p_payload,true)
$$;
revoke all on function public.preview_tenancy_ending_correction(uuid,uuid,jsonb) from public,anon;
grant execute on function public.preview_tenancy_ending_correction(uuid,uuid,jsonb) to authenticated,tenancy_date_writer;

create or replace function public._write_tenancy_date_record(p_account_id uuid,p_tenancy_id uuid,
  p_idempotency_key text,p_request_fingerprint text,p_payload jsonb,p_kind text) returns jsonb
language plpgsql set search_path = public as $$
declare t public.tenancies;v_area uuid;ctx jsonb;preview jsonb;facts jsonb;relationships jsonb;
  history public.tenancy_date_records;idem public.idempotency_keys;result jsonb;
  source_doc public.documents;source_snapshot jsonb;source_files jsonb;
  v_id uuid:=gen_random_uuid();v_time timestamptz:=clock_timestamp();public_record jsonb;
  ending_id uuid;prior_id uuid;requested_rule text;
begin
  if current_user<>'tenancy_date_writer' or public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode='P0002'; end if;
  select * into idem from public.idempotency_keys where account_id=p_account_id and key=p_idempotency_key for update;
  if not found or idem.request_fingerprint is distinct from p_request_fingerprint then raise exception 'idempotency_fingerprint_mismatch'; end if;
  select * into history from public.tenancy_date_records where account_id=p_account_id and request_key=p_idempotency_key;
  if found then
    if history.request_fingerprint is distinct from p_request_fingerprint or history.created_by<>public._tenancy_date_actor()
      or history.tenancy_id<>p_tenancy_id or history.kind<>p_kind then raise exception 'idempotency_fingerprint_mismatch'; end if;
    result:=history.response_body;
  else
    if idem.completed_at is not null or idem.status_code is not null then raise exception 'idempotency_key_not_in_flight'; end if;
    if jsonb_typeof(p_payload) is distinct from 'object' or p_kind not in ('correction','explanation','ending_correction')
      or p_payload-array['changes','expected_date_revision','expected_context_fingerprint','expected_resulting_status',
        'lease_id','rent_schedule_id','reason_code','reason_note','source_document_id','explained_rule_ids']<>'{}'::jsonb
      or length(btrim(coalesce(p_payload->>'reason_note',''))) not between 1 and 2000
      or coalesce(p_payload->>'reason_code','') not in ('data_entry_error','possession_delayed','concession','renewal','early_access','other') then
      raise exception 'invalid_request' using errcode='22023'; end if;
    select area_id into v_area from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
    perform pg_advisory_xact_lock(hashtextextended('tenancy_identity:'||p_account_id::text||':'||v_area::text,0));
    perform pg_advisory_xact_lock(hashtextextended('rent_change:'||p_tenancy_id::text,0));
    select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and area_id=v_area and deleted_at is null for update;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
    if p_payload->>'lease_id' is not null then
      perform 1 from public.leases where account_id=p_account_id and tenancy_id=p_tenancy_id
        and id=(p_payload->>'lease_id')::uuid and deleted_at is null for share;
      if not found then raise exception 'not_found' using errcode='P0002'; end if;
    end if;
    ctx:=public.get_tenancy_date_context(p_account_id,p_tenancy_id,(p_payload->>'lease_id')::uuid,(p_payload->>'rent_schedule_id')::uuid);
    if p_payload->>'expected_context_fingerprint' is distinct from ctx->>'context_fingerprint' then raise exception 'date_context_changed'; end if;
    facts:=ctx->'facts';
    if p_kind in ('correction','ending_correction') then
      if (p_payload->>'expected_date_revision')::bigint is distinct from t.date_revision then raise exception 'date_context_changed'; end if;
      preview:=public._preview_tenancy_date_change(p_account_id,p_tenancy_id,p_payload,p_kind='ending_correction');
      if jsonb_array_length(preview->'blockers')>0 then raise exception '%',preview->'blockers'->>0 using errcode='22023'; end if;
      facts:=preview->'proposed';
      if p_payload->>'expected_resulting_status' is distinct from facts->>'status' then raise exception 'date_context_changed'; end if;
    elsif p_payload?'changes' then raise exception 'invalid_request' using errcode='22023'; end if;
    relationships:=public._tenancy_date_findings(facts,ctx->'lease',ctx->'schedule',ctx->'deposits');
    if p_kind in ('correction','ending_correction') and not p_payload?'explained_rule_ids' then
      select coalesce(jsonb_agg(f),'[]') into relationships from jsonb_array_elements(relationships) f
        where exists(select 1 from jsonb_object_keys(p_payload->'changes') changed
          where f->'fields' ? ('tenancy.'||changed));
    end if;
    if p_payload?'explained_rule_ids' then
      if jsonb_typeof(p_payload->'explained_rule_ids') is distinct from 'array' or jsonb_array_length(p_payload->'explained_rule_ids')>30 then
        raise exception 'invalid_request' using errcode='22023'; end if;
      for requested_rule in select value from jsonb_array_elements_text(p_payload->'explained_rule_ids') loop
        if not exists(select 1 from jsonb_array_elements(relationships) f where f->>'rule_id'=requested_rule) then
          raise exception 'invalid_request: explanation must name a current finding' using errcode='22023'; end if;
      end loop;
      select coalesce(jsonb_agg(f),'[]') into relationships from jsonb_array_elements(relationships) f
        where p_payload->'explained_rule_ids' ? (f->>'rule_id');
    end if;
    if p_payload->>'source_document_id' is not null then
      select * into source_doc from public.documents where account_id=p_account_id and tenancy_id=p_tenancy_id
        and id=(p_payload->>'source_document_id')::uuid and deleted_at is null;
      if not found then raise exception 'not_found' using errcode='P0002'; end if;
      select coalesce(jsonb_agg(jsonb_build_object('id',id,'content_hash',content_hash,'version_no',version_no,
        'attachment_id',attachment_id,'created_at',created_at) order by version_no),'[]') into source_files
        from public.document_versions where account_id=p_account_id and document_id=source_doc.id and deleted_at is null;
      source_snapshot:=jsonb_build_object('id',source_doc.id,'title',source_doc.title,'versions',source_files,
        'reference_kind',case when jsonb_array_length(source_files)>0 then 'content_hashes' else 'unversioned_reference' end);
    end if;
    if p_kind='ending_correction' then
      ending_id:=(ctx->'ending'->>'id')::uuid;prior_id:=(ctx->'ending'->>'correction_record_id')::uuid;
    end if;
    if p_kind in ('correction','ending_correction') then
      t.start_date:=(facts->>'start_date')::date;t.end_date:=(facts->>'end_date')::date;
      t.start_date_basis:=facts->>'start_date_basis';t.actual_move_in_date:=(facts->>'actual_move_in_date')::date;
      t.date_revision:=(facts->>'date_revision')::bigint;t.status:=facts->>'status';t.updated_at:=v_time;
    end if;
    public_record:=jsonb_build_object('id',v_id,'account_id',p_account_id,'tenancy_id',p_tenancy_id,'kind',p_kind,
      'before_facts',ctx->'facts','after_facts',facts,'context_snapshot',
        (ctx-array['applicable_explanation','information','findings','can_correct_start'])
          ||jsonb_build_object('relationship_scope_version',1),
      'context_fingerprint',ctx->>'context_fingerprint','reason_code',p_payload->>'reason_code','reason_note',btrim(p_payload->>'reason_note'),
      'source_document_id',source_doc.id,'source_document_snapshot',source_snapshot,'created_by',public._tenancy_date_actor(),'created_at',v_time,
      'corrects_ending_id',ending_id,'corrects_record_id',prior_id,'relationship_snapshots',relationships);
    result:=jsonb_build_object('tenancy',to_jsonb(t),'record',public_record);
    -- INVARIANT: The ending guard reads linked evidence before accepting its new current projection.
    insert into public.tenancy_date_records(id,account_id,tenancy_id,kind,before_facts,after_facts,context_snapshot,
      context_fingerprint,reason_code,reason_note,source_document_id,source_document_snapshot,created_by,created_at,
      request_key,request_fingerprint,response_body,corrects_ending_id,corrects_record_id,relationship_snapshots)
    values(v_id,p_account_id,p_tenancy_id,p_kind,ctx->'facts',facts,public_record->'context_snapshot',ctx->>'context_fingerprint',
      p_payload->>'reason_code',btrim(p_payload->>'reason_note'),source_doc.id,source_snapshot,public._tenancy_date_actor(),v_time,
      p_idempotency_key,p_request_fingerprint,result,ending_id,prior_id,relationships);
    if p_kind in ('correction','ending_correction') then
      update public.tenancies set start_date=t.start_date,end_date=t.end_date,start_date_basis=t.start_date_basis,
        actual_move_in_date=t.actual_move_in_date,date_revision=t.date_revision,status=t.status,updated_at=t.updated_at
        where account_id=p_account_id and id=p_tenancy_id;
    end if;
  end if;
  update public.idempotency_keys set status_code=200,body=result,completed_at=now()
    where account_id=p_account_id and key=p_idempotency_key and request_fingerprint=p_request_fingerprint;
  if not found then raise exception 'idempotency_completion_lost'; end if;
  return result;
end $$;

create function public.correct_tenancy_ending(p_account_id uuid,p_tenancy_id uuid,p_idempotency_key text,
  p_request_fingerprint text,p_payload jsonb) returns jsonb
language sql security definer set search_path = public as $$
  select public._write_tenancy_date_record(p_account_id,p_tenancy_id,p_idempotency_key,p_request_fingerprint,p_payload,'ending_correction')
$$;
grant create on schema public to tenancy_date_writer;
alter function public.correct_tenancy_ending(uuid,uuid,text,text,jsonb) owner to tenancy_date_writer;
revoke create on schema public from tenancy_date_writer;
revoke all on function public.correct_tenancy_ending(uuid,uuid,text,text,jsonb) from public,anon;
grant execute on function public.correct_tenancy_ending(uuid,uuid,text,text,jsonb) to authenticated;
