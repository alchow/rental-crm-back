begin;

alter table public.document_upload_receipts add column prune_claimed_at timestamptz;

create function public._guard_setup_upload_binding() returns trigger
language plpgsql set search_path=public as $$
begin
  if NEW.setup_session_id is not null then
    if OLD.prune_claimed_at is not null then raise exception 'conflict: upload cleanup has started; upload the document again';end if;
    perform 1 from public.tenancy_setup_sessions where account_id=NEW.account_id and id=NEW.setup_session_id
      and completed_at is null and expires_at>clock_timestamp() for key share;
    if not found then raise exception 'not_found: active setup session' using errcode='P0002';end if;
  end if;
  return NEW;
end $$;
revoke all on function public._guard_setup_upload_binding() from public,anon,authenticated;
create trigger document_upload_receipts_setup_guard before update of setup_session_id on public.document_upload_receipts
  for each row execute function public._guard_setup_upload_binding();

create function public._guard_setup_session_identity() returns trigger
language plpgsql set search_path=public as $$
begin
  if (NEW.id,NEW.account_id,NEW.area_id,NEW.tenancy_id,NEW.created_at)
    is distinct from (OLD.id,OLD.account_id,OLD.area_id,OLD.tenancy_id,OLD.created_at) then
    raise exception 'invalid: setup identity is immutable';
  end if;
  if current_user='authenticated' and OLD.expires_at<=clock_timestamp() then
    raise exception 'conflict: setup session expired; start a new draft and upload the document again';
  end if;
  if OLD.completed_at is not null and (NEW.payload,NEW.revision,NEW.result,NEW.completed_at,NEW.expires_at)
    is distinct from (OLD.payload,OLD.revision,OLD.result,OLD.completed_at,OLD.expires_at) then
    raise exception 'conflict: completed setup facts are immutable';
  end if;
  return NEW;
end $$;
revoke all on function public._guard_setup_session_identity() from public,anon,authenticated;
create trigger tenancy_setup_sessions_identity before update on public.tenancy_setup_sessions
  for each row execute function public._guard_setup_session_identity();

create function public.claim_document_upload_orphan(p_account_id uuid,p_receipt_id uuid) returns boolean
language plpgsql set search_path=public as $$
declare r public.document_upload_receipts;
begin
  select * into r from public.document_upload_receipts where account_id=p_account_id and id=p_receipt_id for update;
  if not found or r.created_at>=clock_timestamp()-interval '48 hours' then return false;end if;
  if exists(select 1 from public.tenancy_setup_sessions s where s.account_id=r.account_id and s.id=r.setup_session_id
    and s.completed_at is null and s.expires_at>clock_timestamp()) then return false;end if;
  if exists(select 1 from public.document_upload_receipts child where child.account_id=r.account_id
    and child.derived_from_receipt_id=r.id and child.prune_claimed_at is null) then return false;end if;
  update public.document_upload_receipts set prune_claimed_at=coalesce(prune_claimed_at,clock_timestamp()) where account_id=r.account_id and id=r.id;
  return true;
end $$;
revoke all on function public.claim_document_upload_orphan(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_document_upload_orphan(uuid,uuid) to service_role;

create table public.tenancy_setup_confirmations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  setup_session_id uuid not null,
  tenancy_id uuid not null,
  lease_id uuid not null,
  setup_snapshot jsonb not null check(jsonb_typeof(setup_snapshot)='object'),
  review_snapshot jsonb not null check(jsonb_typeof(review_snapshot)='object'),
  entered_by uuid not null references auth.users(id),
  entered_at timestamptz not null default clock_timestamp(),
  unique(account_id,setup_session_id),
  foreign key(account_id,setup_session_id) references public.tenancy_setup_sessions(account_id,id),
  foreign key(account_id,tenancy_id) references public.tenancies(account_id,id),
  foreign key(account_id,lease_id) references public.leases(account_id,id)
);
alter table public.tenancy_setup_confirmations enable row level security;
alter table public.tenancy_setup_confirmations force row level security;
revoke all on public.tenancy_setup_confirmations from public,anon,authenticated,service_role;
grant select,insert on public.tenancy_setup_confirmations to authenticated,service_role;
create policy tenancy_setup_confirmations_read on public.tenancy_setup_confirmations for select to authenticated
  using(public.is_account_member(account_id));
create policy tenancy_setup_confirmations_insert on public.tenancy_setup_confirmations for insert to authenticated
  with check(entered_by=auth.uid() and exists(select 1 from public.account_members m where m.account_id=tenancy_setup_confirmations.account_id
    and m.user_id=auth.uid() and m.deleted_at is null and m.role in ('owner','manager')));
create function public._freeze_setup_confirmation() returns trigger
language plpgsql set search_path=public as $$
begin
  raise exception 'setup confirmations are immutable' using errcode='23514';
end $$;
revoke all on function public._freeze_setup_confirmation() from public,anon,authenticated;
create trigger tenancy_setup_confirmations_immutable before update or delete on public.tenancy_setup_confirmations
  for each row execute function public._freeze_setup_confirmation();
create trigger tenancy_setup_confirmations_audit after insert on public.tenancy_setup_confirmations
  for each row execute function public._emit_event();

do $migration$
declare body text;signature text;old text;replacement text;
begin
  foreach signature in array array['public.create_tenancy_document_from_upload(uuid,uuid,text,text,boolean,uuid)',
    'public.create_tenancy_document_from_image(uuid,uuid,text,text,boolean,uuid,uuid)'] loop
    body:=pg_get_functiondef(signature::regprocedure);
    old:='and r.stored_at is not null';
    assert position(old in body)>0,'document receipt completion guard changed';
    body:=replace(body,old,old||' and r.prune_claimed_at is null');
    old:='s.expires_at>now()));';
    assert position(old in body)>0,'document session freshness guard changed';
    execute replace(body,old,'s.expires_at>now())) for update;');
  end loop;

  body:=pg_get_functiondef('public.preview_tenancy_setup_session(uuid,uuid,jsonb)'::regprocedure);
  old:='if not exists(select 1 from jsonb_array_elements(cycles) x where x->>''cycle_key''=c->>''cycle_key'') then';
  replacement:=E'if not exists(select 1 from jsonb_array_elements(cycles) x where x->>''cycle_key''=c->>''cycle_key'')\n'
    ||E'        and not exists(select 1 from jsonb_array_elements(preview->''findings'') finding where finding->>''severity''=''error''\n'
    ||E'          and finding->>''rule_id'' in (''partial_period:''||(c->>''cycle_key''),''final_partial_period:''||(c->>''cycle_key''))) then';
  assert position(old in body)>0,'setup partial discovery loop changed';
  body:=replace(body,old,replacement);
  old:='  for person in select value from jsonb_array_elements(p_setup->''people'') loop';
  assert position(old in body)>0,'setup people validation changed';
  body:=replace(body,old,old||E'\n    if (person->>''on_lease'')::boolean is null then raise exception ''invalid: confirm whether each person is on the lease'';end if;');
  old:='public.effective_tenancy_status(''upcoming'',(p_setup->''tenancy''->>''start_date'')::date,today)';
  assert position(old in body)>0,'setup lifecycle projection changed';
  body:=replace(body,old,'public.effective_tenancy_status(coalesce(actual_t.status,''upcoming''),(p_setup->''tenancy''->>''start_date'')::date,today)');
  old:='''draft_revision'',d.revision,''setup'',p_setup';
  assert position(old in body)>0,'setup draft fingerprint changed';
  body:=replace(body,old,'''setup'',p_setup');
  old:='where value->>''type''=coalesce(p_setup->''receipt_purposes''->>(p->>''draft_key''),''rent'') order by';
  assert position(old in body)>0,'setup payment matching changed';
  body:=replace(body,old,'where value->>''currency''=p->>''currency'' and value->>''type''=coalesce(p_setup->''receipt_purposes''->>(p->>''draft_key''),''rent'') order by');
  old:='where value->>''voided_at'' is null and (value->>''balance_cents'')::bigint>0';
  assert position(old in body)>0,'setup existing charge targets changed';
  body:=replace(body,old,E'where value->>''voided_at'' is null and value->>''deleted_at'' is null and (value->>''balance_cents'')::bigint>0\n'
    ||E'    and not exists(select 1 from jsonb_array_elements_text(coalesce(preview->''transition''->''voided_charge_ids'',''[]'')) cancelled(charge_id) where cancelled.charge_id=(value->>''id''))');
  old:='  if d.completed_at is not null then raise exception ''conflict: setup already completed'';end if;';
  replacement:=old||E'\n  if p_setup->''document''->>''receipt_id'' is not null then\n'
    ||E'    if not exists(select 1 from public.document_upload_receipts u where u.account_id=p_account_id\n'
    ||E'      and u.id=(p_setup->''document''->>''receipt_id'')::uuid and u.setup_session_id=d.id and u.uploaded_by=auth.uid()\n'
    ||E'      and u.mime_type=''application/pdf'' and u.stored_at is not null and u.prune_claimed_at is null\n'
    ||E'      and u.derived_from_receipt_id is not distinct from (p_setup->''document''->>''original_receipt_id'')::uuid)\n'
    ||E'    or (p_setup->''document''->>''original_receipt_id'' is not null and not exists(\n'
    ||E'      select 1 from public.document_upload_receipts u where u.account_id=p_account_id\n'
    ||E'      and u.id=(p_setup->''document''->>''original_receipt_id'')::uuid and u.setup_session_id=d.id and u.uploaded_by=auth.uid()\n'
    ||E'      and u.stored_at is not null and u.prune_claimed_at is null))\n'
    ||E'    then raise exception ''not_found: setup document'' using errcode=''P0002'';end if;\n  end if;';
  assert position(old in body)>0,'setup availability guard changed';
  body:=replace(body,old,replacement);
  old:='''current_lease'',to_jsonb(old_l),''people'',people_context,';
  replacement:=old||E'\n    ''members'',(select coalesce(jsonb_agg(to_jsonb(member) order by member.id),''[]'') from public.tenancy_tenants member where member.account_id=p_account_id and member.tenancy_id=d.tenancy_id and member.deleted_at is null),';
  assert position(old in body)>0,'setup fingerprint changed';
  execute replace(body,old,replacement);

  body:=pg_get_functiondef('public.commit_tenancy_setup_session(uuid,uuid,jsonb,text,boolean,text,text)'::regprocedure);
  old:='if not p_accept_warnings then';
  assert position(old in body)>0,'setup warning consent guard changed';
  body:=replace(body,old,'if p_accept_warnings is distinct from true then');
  old:='date_review:=public.preview_tenancy_date_correction(p_account_id,t.id,date_payload);';
  assert position(old in body)>0,'setup date review changed';
  body:=replace(body,old,old||E'\n      date_payload:=date_payload||jsonb_build_object(''expected_resulting_status'',date_review->''proposed''->''status'');');
  old:=E'  for person in select value from jsonb_array_elements(p_setup->''people'') loop';
  assert position(old in body)>0,'setup people loop changed';
  body:=replace(body,old,E'  select * into t from public.tenancies where account_id=p_account_id and id=t.id;\n'||old);
  old:='  v_result:=jsonb_build_object';
  assert position(old in body)>0,'setup completion result changed';
  execute replace(body,old,E'  insert into public.tenancy_setup_confirmations(account_id,setup_session_id,tenancy_id,lease_id,setup_snapshot,review_snapshot,entered_by)\n'
    ||E'  values(p_account_id,d.id,t.id,lease_id,p_setup,review||jsonb_build_object(''committed_lease_id'',lease_id,''document_id'',doc_id),auth.uid());\n'||old);

  body:=pg_get_functiondef('public._guard_onboarding_progress()'::regprocedure);
  old:='if not found then raise exception ''source_scope_invalid'' using errcode=''22023''; end if;';
  assert position(old in body)>0,'onboarding selected source guard changed';
  execute replace(body,old,E'if not found then\n'
    ||E'      if TG_OP=''UPDATE'' and NEW.selected_lease_id is not distinct from OLD.selected_lease_id then\n'
    ||E'        NEW.selected_lease_id:=null;NEW.agreement_confirmed:=false;NEW.selected_lease_updated_at:=null;\n'
    ||E'      else raise exception ''source_scope_invalid'' using errcode=''22023'';end if;\n    end if;');
end $migration$;

notify pgrst,'reload schema';
commit;
