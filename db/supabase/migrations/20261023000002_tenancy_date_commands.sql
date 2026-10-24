-- Possession facts and reasoned corrections are independent of rent eras.
-- Expand stage: deploy compatible callers before the following enforcement migration.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'tenancy_date_writer') then
    create role tenancy_date_writer nologin noinherit;
  end if;
end $$;
-- The migration owner can transfer function ownership; API roles never inherit this role.
grant tenancy_date_writer to postgres;
grant create on schema public to tenancy_date_writer;
grant usage on schema public to tenancy_date_writer;

alter table public.tenancies
  add column start_date_basis text not null default 'legacy_unverified'
    check (start_date_basis in ('legacy_unverified', 'possession_entitlement')),
  add column actual_move_in_date date,
  add column date_revision bigint not null default 0 check (date_revision >= 0);

create table public.tenancy_date_records (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  tenancy_id uuid not null,
  kind text not null check (kind in ('correction', 'explanation')),
  before_facts jsonb not null,
  after_facts jsonb not null,
  context_snapshot jsonb not null,
  context_fingerprint text not null,
  reason_code text not null check (reason_code in
    ('data_entry_error', 'possession_delayed', 'concession', 'renewal', 'early_access', 'other')),
  reason_note text not null check (length(btrim(reason_note)) between 1 and 2000),
  source_document_id uuid,
  source_document_snapshot jsonb,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  request_key text not null,
  request_fingerprint text not null,
  response_body jsonb not null,
  foreign key (account_id, tenancy_id) references public.tenancies(account_id, id),
  foreign key (account_id, source_document_id) references public.documents(account_id, id),
  unique (account_id, request_key)
);
alter table public.tenancy_date_records enable row level security;
alter table public.tenancy_date_records force row level security;
revoke all on public.tenancy_date_records from public, anon, authenticated, service_role;
grant select on public.tenancy_date_records to authenticated, service_role, tenancy_date_writer;
grant insert on public.tenancy_date_records to tenancy_date_writer;
create policy tenancy_date_records_read on public.tenancy_date_records for select
  using (public.is_account_member(account_id));
create policy tenancy_date_records_insert on public.tenancy_date_records for insert
  to tenancy_date_writer with check (public.is_account_member(account_id));
create index tenancy_date_records_history_idx on public.tenancy_date_records
  (account_id, tenancy_id, created_at, id);
create index tenancy_date_records_old_start_idx on public.tenancy_date_records
  (account_id, (before_facts->>'start_date'), tenancy_id) where kind = 'correction';

create function public._guard_tenancy_date_record() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP <> 'INSERT' or current_user <> 'tenancy_date_writer' then
    raise exception 'date_history_immutable' using errcode = '42501';
  end if;
  return NEW;
end $$;
create trigger tenancy_date_records_immutable before insert or update or delete
  on public.tenancy_date_records for each row execute function public._guard_tenancy_date_record();
create trigger tenancy_date_records_audit after insert on public.tenancy_date_records
  for each row execute function public._emit_event();

grant select on public.tenancies, public.tenancy_endings, public.leases,
  public.rent_schedules, public.charges, public.payments, public.documents,
  public.document_versions, public.account_members, public.idempotency_keys to tenancy_date_writer;
grant update (start_date, start_date_basis, actual_move_in_date, date_revision,
  status, updated_at) on public.tenancies to tenancy_date_writer;
grant update (status_code, body, completed_at) on public.idempotency_keys to tenancy_date_writer;
grant execute on function auth.uid() to tenancy_date_writer;
grant execute on function public.is_account_member(uuid) to tenancy_date_writer;

create function public._tenancy_date_facts(p_t public.tenancies) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object('start_date', p_t.start_date,
    'start_date_basis', p_t.start_date_basis, 'actual_move_in_date', p_t.actual_move_in_date,
    'status', p_t.status, 'end_date', p_t.end_date, 'date_revision', p_t.date_revision)
$$;

create function public._tenancy_calendar_date(p_value text) returns date
language plpgsql immutable set search_path = public as $$
declare v date;
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'invalid_calendar_date' using errcode = '22023';
  end if;
  begin v := p_value::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'invalid_calendar_date' using errcode = '22023';
  end;
  if not isfinite(v) or to_char(v, 'YYYY-MM-DD') <> p_value then
    raise exception 'invalid_calendar_date' using errcode = '22023';
  end if;
  return v;
end $$;

create function public.get_tenancy_date_context(p_account_id uuid, p_tenancy_id uuid,
  p_lease_id uuid default null, p_rent_schedule_id uuid default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  t public.tenancies; l jsonb; s jsonb; e jsonb; v jsonb; h text;
  info text[] := '{}'; explanation jsonb;
begin
  if auth.uid() is null or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into t from public.tenancies where account_id = p_account_id
    and id = p_tenancy_id and deleted_at is null;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if p_lease_id is not null then
    select jsonb_build_object('id', id, 'term_start', term_start, 'term_end', term_end,
      'status', status, 'voided_at', voided_at, 'updated_at', updated_at) into l
      from public.leases where account_id = p_account_id and tenancy_id = t.id
        and id = p_lease_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  if p_rent_schedule_id is not null then
    select jsonb_build_object('id', id, 'start_date', start_date, 'end_date', end_date,
      'due_day', due_day, 'updated_at', updated_at) into s
      from public.rent_schedules where account_id = p_account_id and tenancy_id = t.id
        and id = p_rent_schedule_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  end if;
  select jsonb_build_object('id', id, 'kind', kind, 'effective_date', effective_date)
    into e from public.tenancy_endings where account_id = p_account_id and tenancy_id = t.id;
  v := jsonb_build_object('version', 1, 'facts', public._tenancy_date_facts(t),
    'lease', l, 'schedule', s, 'ending', e);
  h := encode(sha256(convert_to(v::text, 'UTF8')), 'hex');
  if t.start_date_basis = 'legacy_unverified' then info := array_append(info, 'legacy_date_unverified'); end if;
  if (l is not null and (l->>'term_start')::date <> t.start_date)
    or (s is not null and (s->>'start_date')::date <> t.start_date) then
    info := array_append(info, 'date_values_differ');
  end if;
  if s is not null and (s->>'start_date')::date < t.start_date then
    info := array_append(info, 'billing_precedes_possession');
  end if;
  if t.status = 'ended' and t.end_date is null and e is null then
    info := array_append(info, 'legacy_ending_incomplete');
  end if;
  select to_jsonb(r) - array['request_key','request_fingerprint','response_body']
    into explanation from public.tenancy_date_records r
    where account_id = p_account_id and tenancy_id = t.id and kind = 'explanation'
      and context_fingerprint = h order by created_at desc, id desc limit 1;
  return v || jsonb_build_object('context_fingerprint', h, 'information', info,
    'applicable_explanation', explanation,
    'can_correct_start', coalesce(e->>'kind', '') <> 'cancelled_before_move_in');
end $$;

create function public.preview_tenancy_date_correction(p_account_id uuid,
  p_tenancy_id uuid, p_payload jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  ctx jsonb; old_f jsonb; new_f jsonb; changes jsonb; info text[];
  blockers text[] := '{}'; new_start date; actual date; new_status text;
  today date := (now() at time zone 'UTC')::date;
  n_charges bigint; n_payments bigint; n_review bigint; n_fallback bigint;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  changes := coalesce(p_payload->'changes', '{}'::jsonb);
  if jsonb_typeof(changes) is distinct from 'object'
    or changes - array['start_date','start_date_basis','actual_move_in_date'] <> '{}'::jsonb then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  ctx := public.get_tenancy_date_context(p_account_id, p_tenancy_id,
    (p_payload->>'lease_id')::uuid, (p_payload->>'rent_schedule_id')::uuid);
  old_f := ctx->'facts'; new_f := old_f || changes;
  new_start := public._tenancy_calendar_date(new_f->>'start_date');
  if new_f->>'start_date_basis' is null or new_f->>'start_date_basis' not in
    ('legacy_unverified','possession_entitlement') then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if new_f->>'actual_move_in_date' is not null then
    actual := public._tenancy_calendar_date(new_f->>'actual_move_in_date');
    if actual > today then blockers := array_append(blockers, 'actual_move_in_in_future'); end if;
  end if;
  new_status := old_f->>'status';
  if new_start > (old_f->>'end_date')::date then
    blockers := array_append(blockers, 'invalid_date_order');
  end if;
  if ctx->'ending'->>'kind' = 'cancelled_before_move_in' and
    (new_start <> (old_f->>'start_date')::date or actual is not null) then
    blockers := array_append(blockers, 'date_fixed_by_cancellation');
  end if;
  if new_start <> (old_f->>'start_date')::date then
    if new_status in ('holdover','ended') and new_start > today then
      blockers := array_append(blockers, 'date_status_conflict');
    elsif new_status in ('active','upcoming') then
      new_status := case when new_start > today then 'upcoming' else 'active' end;
    end if;
  end if;
  if new_f = old_f then blockers := array_append(blockers, 'no_date_change'); end if;
  new_f := new_f || jsonb_build_object('status', new_status,
    'date_revision', (old_f->>'date_revision')::bigint + case when new_f <> old_f then 1 else 0 end);
  select count(*), count(*) filter (where
      coalesce(period_start,due_date) < greatest(new_start,(old_f->>'start_date')::date)
      and coalesce(period_end,period_start,due_date) >= least(new_start,(old_f->>'start_date')::date)
      and new_start <> (old_f->>'start_date')::date),
    count(*) filter (where period_start is null and due_date >= least(new_start,(old_f->>'start_date')::date)
      and due_date < greatest(new_start,(old_f->>'start_date')::date))
    into n_charges,n_review,n_fallback from public.charges
    where account_id = p_account_id and tenancy_id = p_tenancy_id and deleted_at is null and voided_at is null;
  select count(*) into n_payments from public.payments where account_id = p_account_id
    and tenancy_id = p_tenancy_id and deleted_at is null and voided_at is null;
  select coalesce(array_agg(value), '{}'::text[]) into info from jsonb_array_elements_text(ctx->'information');
  if n_review > 0 then info := array_append(info,'charges_in_changed_interval'); end if;
  return jsonb_build_object('current',old_f,'proposed',new_f,
    'context_fingerprint',ctx->>'context_fingerprint','blockers',blockers,'information',info,
    'financial_review',jsonb_build_object('live_charges',n_charges,'live_payments',n_payments,
      'charges_in_changed_interval',n_review,'due_date_fallback_count',n_fallback,'sampled_at',now()));
end $$;

create function public._write_tenancy_date_record(p_account_id uuid, p_tenancy_id uuid,
  p_idempotency_key text, p_request_fingerprint text, p_payload jsonb, p_kind text) returns jsonb
language plpgsql set search_path = public as $$
declare
  t public.tenancies; v_area uuid; ctx jsonb; preview jsonb; facts jsonb;
  history public.tenancy_date_records; idem public.idempotency_keys; result jsonb;
  source_doc public.documents; source_snapshot jsonb; source_files jsonb;
  v_id uuid := gen_random_uuid(); v_time timestamptz := clock_timestamp(); public_record jsonb;
begin
  if current_user <> 'tenancy_date_writer' or auth.uid() is null
    or not public.is_account_member(p_account_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into idem from public.idempotency_keys
    where account_id=p_account_id and key=p_idempotency_key for update;
  if not found or idem.request_fingerprint is distinct from p_request_fingerprint then
    raise exception 'idempotency_fingerprint_mismatch';
  end if;
  select * into history from public.tenancy_date_records
    where account_id=p_account_id and request_key=p_idempotency_key;
  if found then
    if history.request_fingerprint is distinct from p_request_fingerprint or history.created_by <> auth.uid() then
      raise exception 'idempotency_fingerprint_mismatch';
    end if;
    result := history.response_body;
  else
    if idem.completed_at is not null or idem.status_code is not null then
      raise exception 'idempotency_key_not_in_flight';
    end if;
    if jsonb_typeof(p_payload) is distinct from 'object' or p_kind not in ('correction','explanation')
      or p_payload - array['changes','expected_date_revision','expected_context_fingerprint',
        'expected_resulting_status','lease_id','rent_schedule_id','reason_code','reason_note','source_document_id'] <> '{}'::jsonb
      or length(btrim(coalesce(p_payload->>'reason_note',''))) not between 1 and 2000
      or coalesce(p_payload->>'reason_code','') not in
        ('data_entry_error','possession_delayed','concession','renewal','early_access','other') then
      raise exception 'invalid_request' using errcode = '22023';
    end if;
    select area_id into v_area from public.tenancies where account_id=p_account_id
      and id=p_tenancy_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
    -- Import resolution takes this same identity lock before looking up date aliases.
    perform pg_advisory_xact_lock(hashtextextended('tenancy_identity:'||p_account_id::text||':'||v_area::text,0));
    select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id
      and area_id=v_area and deleted_at is null for update;
    if not found then raise exception 'not_found' using errcode='P0002'; end if;
    ctx := public.get_tenancy_date_context(p_account_id,p_tenancy_id,
      (p_payload->>'lease_id')::uuid,(p_payload->>'rent_schedule_id')::uuid);
    if p_payload->>'expected_context_fingerprint' is distinct from ctx->>'context_fingerprint' then
      raise exception 'date_context_changed';
    end if;
    facts := ctx->'facts';
    if p_kind = 'correction' then
      if (p_payload->>'expected_date_revision')::bigint is distinct from t.date_revision then
        raise exception 'date_context_changed';
      end if;
      preview := public.preview_tenancy_date_correction(p_account_id,p_tenancy_id,p_payload);
      if jsonb_array_length(preview->'blockers') > 0 then
        raise exception '%',preview->'blockers'->>0 using errcode='22023';
      end if;
      facts := preview->'proposed';
      if p_payload->>'expected_resulting_status' is distinct from facts->>'status' then
        raise exception 'date_context_changed';
      end if;
    elsif p_payload ? 'changes' then
      raise exception 'invalid_request' using errcode='22023';
    end if;
    if p_payload->>'source_document_id' is not null then
      select * into source_doc from public.documents where account_id=p_account_id
        and tenancy_id=p_tenancy_id and id=(p_payload->>'source_document_id')::uuid and deleted_at is null;
      if not found then raise exception 'not_found' using errcode='P0002'; end if;
      select coalesce(jsonb_agg(jsonb_build_object('id',id,'content_hash',content_hash,
        'version_no',version_no,'attachment_id',attachment_id,'created_at',created_at)
        order by version_no),'[]'::jsonb)
        into source_files from public.document_versions where account_id=p_account_id
          and document_id=source_doc.id and deleted_at is null;
      source_snapshot := jsonb_build_object('id',source_doc.id,'title',source_doc.title,
        'versions',source_files,'reference_kind',case when jsonb_array_length(source_files)>0
          then 'content_hashes' else 'unversioned_reference' end);
    end if;
    if p_kind='correction' then
      update public.tenancies set start_date=(facts->>'start_date')::date,
        start_date_basis=facts->>'start_date_basis', actual_move_in_date=(facts->>'actual_move_in_date')::date,
        date_revision=(facts->>'date_revision')::bigint,status=facts->>'status',updated_at=v_time
        where account_id=p_account_id and id=p_tenancy_id returning * into t;
    end if;
    public_record := jsonb_build_object('id',v_id,'account_id',p_account_id,'tenancy_id',p_tenancy_id,
      'kind',p_kind,'before_facts',ctx->'facts','after_facts',facts,
      'context_snapshot',ctx - array['applicable_explanation','information','can_correct_start'],
      'context_fingerprint',ctx->>'context_fingerprint',
      'reason_code',p_payload->>'reason_code','reason_note',btrim(p_payload->>'reason_note'),
      'source_document_id',source_doc.id,'source_document_snapshot',source_snapshot,
      'created_by',auth.uid(),'created_at',v_time);
    result := jsonb_build_object('tenancy',to_jsonb(t),'record',public_record);
    insert into public.tenancy_date_records(id,account_id,tenancy_id,kind,before_facts,after_facts,
      context_snapshot,context_fingerprint,reason_code,reason_note,source_document_id,source_document_snapshot,
      created_by,created_at,request_key,request_fingerprint,response_body)
    values(v_id,p_account_id,p_tenancy_id,p_kind,ctx->'facts',facts,public_record->'context_snapshot',
      ctx->>'context_fingerprint',p_payload->>'reason_code',btrim(p_payload->>'reason_note'),source_doc.id,
      source_snapshot,auth.uid(),v_time,p_idempotency_key,p_request_fingerprint,result);
  end if;
  update public.idempotency_keys set status_code=200,body=result,completed_at=now()
    where account_id=p_account_id and key=p_idempotency_key and request_fingerprint=p_request_fingerprint;
  if not found then raise exception 'idempotency_completion_lost'; end if;
  return result;
end $$;

create function public.correct_tenancy_dates(p_account_id uuid, p_tenancy_id uuid,
  p_idempotency_key text,p_request_fingerprint text,p_payload jsonb) returns jsonb
language sql security definer set search_path = public as $$
  select public._write_tenancy_date_record(p_account_id,p_tenancy_id,p_idempotency_key,
    p_request_fingerprint,p_payload,'correction')
$$;
create function public.record_tenancy_date_explanation(p_account_id uuid,p_tenancy_id uuid,
  p_idempotency_key text,p_request_fingerprint text,p_payload jsonb) returns jsonb
language sql security definer set search_path = public as $$
  select public._write_tenancy_date_record(p_account_id,p_tenancy_id,p_idempotency_key,
    p_request_fingerprint,p_payload,'explanation')
$$;
alter function public.correct_tenancy_dates(uuid,uuid,text,text,jsonb) owner to tenancy_date_writer;
alter function public.record_tenancy_date_explanation(uuid,uuid,text,text,jsonb) owner to tenancy_date_writer;
revoke create on schema public from tenancy_date_writer;
revoke all on function public.correct_tenancy_dates(uuid,uuid,text,text,jsonb),
  public.record_tenancy_date_explanation(uuid,uuid,text,text,jsonb),
  public._write_tenancy_date_record(uuid,uuid,text,text,jsonb,text),
  public.get_tenancy_date_context(uuid,uuid,uuid,uuid),
  public.preview_tenancy_date_correction(uuid,uuid,jsonb),
  public._tenancy_date_facts(public.tenancies),public._tenancy_calendar_date(text),
  public._guard_tenancy_date_record() from public,anon,authenticated,service_role;
grant execute on function public.correct_tenancy_dates(uuid,uuid,text,text,jsonb),
  public.record_tenancy_date_explanation(uuid,uuid,text,text,jsonb)
  to authenticated;
grant execute on function public._write_tenancy_date_record(uuid,uuid,text,text,jsonb,text)
  to tenancy_date_writer;
grant execute on function public.get_tenancy_date_context(uuid,uuid,uuid,uuid),
  public.preview_tenancy_date_correction(uuid,uuid,jsonb),
  public._tenancy_date_facts(public.tenancies),public._tenancy_calendar_date(text)
  to authenticated,tenancy_date_writer;
