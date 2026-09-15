-- SQL-standard bodies bind auth.uid at creation, without requiring the narrow
-- writer role to resolve names inside Supabase's separately owned auth schema.
create function public._tenancy_date_actor() returns uuid
language sql stable
begin atomic
  select auth.uid();
end;
revoke all on function public._tenancy_date_actor() from public,anon,authenticated,service_role;
grant execute on function public._tenancy_date_actor() to authenticated,tenancy_date_writer;

create or replace function public.is_account_member(p_account_id uuid) returns boolean
language sql stable set search_path = public
begin atomic
  select exists (select 1 from public.account_members m where m.account_id=p_account_id
    and m.user_id=(select auth.uid()) and m.deleted_at is null);
end;

create or replace function public.get_tenancy_date_context(p_account_id uuid, p_tenancy_id uuid,
  p_lease_id uuid default null, p_rent_schedule_id uuid default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  t public.tenancies; l jsonb; s jsonb; e jsonb; v jsonb; h text;
  info text[] := '{}'; explanation jsonb;
begin
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then
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

create or replace function public._write_tenancy_date_record(p_account_id uuid, p_tenancy_id uuid,
  p_idempotency_key text, p_request_fingerprint text, p_payload jsonb, p_kind text) returns jsonb
language plpgsql set search_path = public as $$
declare
  t public.tenancies; v_area uuid; ctx jsonb; preview jsonb; facts jsonb;
  history public.tenancy_date_records; idem public.idempotency_keys; result jsonb;
  source_doc public.documents; source_snapshot jsonb; source_files jsonb;
  v_id uuid := gen_random_uuid(); v_time timestamptz := clock_timestamp(); public_record jsonb;
begin
  if current_user <> 'tenancy_date_writer' or public._tenancy_date_actor() is null
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
    if history.request_fingerprint is distinct from p_request_fingerprint or history.created_by <> public._tenancy_date_actor() then
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
      'created_by',public._tenancy_date_actor(),'created_at',v_time);
    result := jsonb_build_object('tenancy',to_jsonb(t),'record',public_record);
    insert into public.tenancy_date_records(id,account_id,tenancy_id,kind,before_facts,after_facts,
      context_snapshot,context_fingerprint,reason_code,reason_note,source_document_id,source_document_snapshot,
      created_by,created_at,request_key,request_fingerprint,response_body)
    values(v_id,p_account_id,p_tenancy_id,p_kind,ctx->'facts',facts,public_record->'context_snapshot',
      ctx->>'context_fingerprint',p_payload->>'reason_code',btrim(p_payload->>'reason_note'),source_doc.id,
      source_snapshot,public._tenancy_date_actor(),v_time,p_idempotency_key,p_request_fingerprint,result);
  end if;
  update public.idempotency_keys set status_code=200,body=result,completed_at=now()
    where account_id=p_account_id and key=p_idempotency_key and request_fingerprint=p_request_fingerprint;
  if not found then raise exception 'idempotency_completion_lost'; end if;
  return result;
end $$;

