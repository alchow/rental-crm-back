begin;

create table public.tenancy_setup_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  area_id uuid not null,
  tenancy_id uuid,
  payload jsonb not null default '{}' check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=200000),
  revision bigint not null default 0,
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '90 days',
  unique(account_id,id),
  foreign key(account_id,area_id) references public.areas(account_id,id),
  foreign key(account_id,tenancy_id) references public.tenancies(account_id,id)
);
create index tenancy_setup_sessions_unit on public.tenancy_setup_sessions(account_id,area_id,updated_at desc);
alter table public.tenancy_setup_sessions enable row level security;
alter table public.tenancy_setup_sessions force row level security;
create policy tenancy_setup_sessions_read on public.tenancy_setup_sessions for select to authenticated using(public.is_account_member(account_id));
create policy tenancy_setup_sessions_write on public.tenancy_setup_sessions for all to authenticated
  using(exists(select 1 from public.account_members m where m.account_id=tenancy_setup_sessions.account_id and m.user_id=auth.uid() and m.deleted_at is null and m.role in ('owner','manager')))
  with check(exists(select 1 from public.account_members m where m.account_id=tenancy_setup_sessions.account_id and m.user_id=auth.uid() and m.deleted_at is null and m.role in ('owner','manager')));
grant select,insert,update,delete on public.tenancy_setup_sessions to authenticated;
grant all on public.tenancy_setup_sessions to service_role;

create function public.save_tenancy_setup_session(p_account_id uuid,p_id uuid,p_area_id uuid,p_tenancy_id uuid,p_revision bigint,p_payload jsonb) returns jsonb
language plpgsql set search_path=public as $$
declare d public.tenancy_setup_sessions;
begin
  if not exists(select 1 from public.areas where id=p_area_id and account_id=p_account_id and kind='unit' and deleted_at is null) then raise exception 'not_found' using errcode='P0002';end if;
  if p_tenancy_id is not null and not exists(select 1 from public.tenancies where id=p_tenancy_id and account_id=p_account_id and area_id=p_area_id and deleted_at is null) then raise exception 'not_found' using errcode='P0002';end if;
  insert into public.tenancy_setup_sessions(id,account_id,area_id,tenancy_id,payload)
    values(p_id,p_account_id,p_area_id,p_tenancy_id,p_payload) on conflict(id) do nothing;
  select * into d from public.tenancy_setup_sessions where account_id=p_account_id and id=p_id for update;
  if not found then raise exception 'not_found' using errcode='P0002';end if;
  if d.area_id<>p_area_id or d.tenancy_id is distinct from p_tenancy_id or d.revision<>p_revision or d.completed_at is not null then raise exception 'conflict: setup draft changed';end if;
  update public.tenancy_setup_sessions set payload=p_payload,revision=revision+1,updated_at=clock_timestamp(),expires_at=clock_timestamp()+interval '90 days'
    where id=d.id returning * into d;
  return to_jsonb(d);
end $$;
revoke all on function public.save_tenancy_setup_session(uuid,uuid,uuid,uuid,bigint,jsonb) from public,anon;
grant execute on function public.save_tenancy_setup_session(uuid,uuid,uuid,uuid,bigint,jsonb) to authenticated;

-- A staged upload stays private and usable while its owning setup is resumable.
alter table public.document_upload_receipts add column setup_session_id uuid;
alter table public.document_upload_receipts add foreign key(account_id,setup_session_id) references public.tenancy_setup_sessions(account_id,id);
grant update(setup_session_id) on public.document_upload_receipts to authenticated;
create policy document_upload_receipts_setup_bind on public.document_upload_receipts for update to authenticated
  using(uploaded_by=auth.uid() and public.is_account_member(account_id))
  with check(uploaded_by=auth.uid() and exists(select 1 from public.tenancy_setup_sessions d where d.account_id=document_upload_receipts.account_id and d.id=setup_session_id and d.completed_at is null));

do $migration$
declare body text;f text;
begin
  foreach f in array array['public.create_tenancy_document_from_upload(uuid,uuid,text,text,boolean,uuid)',
    'public.create_tenancy_document_from_image(uuid,uuid,text,text,boolean,uuid,uuid)'] loop
    select pg_get_functiondef(f::regprocedure) into body;
    execute replace(body,'r.created_at > now() - interval ''24 hours''',
      '(r.created_at > now() - interval ''24 hours'' or exists(select 1 from public.tenancy_setup_sessions s where s.account_id=r.account_id and s.id=r.setup_session_id and s.completed_at is null and s.expires_at>now()))');
  end loop;
  select prosrc into body from pg_proc where oid='public.preview_billing_setup(uuid,uuid,jsonb)'::regprocedure;
  body:=replace(body,E'  select * into t from public.tenancies where account_id = p_account_id and id = p_tenancy_id and deleted_at is null;\n  if not found then raise exception ''not_found'' using errcode=''P0002''; end if;',
    E'  if p_tenancy is null then\n    select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null;\n    if not found then raise exception ''not_found'' using errcode=''P0002'';end if;\n  else\n    t:=jsonb_populate_record(null::public.tenancies,p_tenancy);\n    if t.account_id is distinct from p_account_id or t.id is distinct from p_tenancy_id or not exists(select 1 from public.areas where account_id=p_account_id and id=t.area_id and deleted_at is null) then raise exception ''not_found'' using errcode=''P0002'';end if;\n  end if;');
  body:=replace(body,E'      select * into l from public.leases where account_id = p_account_id and tenancy_id = t.id\n        and id = (r->>''source_lease_id'')::uuid and deleted_at is null and voided_at is null;\n      if not found then raise exception ''invalid: selected lease is outside this tenancy''; end if;',
    E'      if p_lease is null then\n        select * into l from public.leases where account_id=p_account_id and tenancy_id=t.id and id=(r->>''source_lease_id'')::uuid and deleted_at is null and voided_at is null;\n        if not found then raise exception ''invalid: selected lease is outside this tenancy'';end if;\n      else\n        l:=jsonb_populate_record(null::public.leases,p_lease);\n        if l.account_id is distinct from p_account_id or l.tenancy_id is distinct from t.id or l.id is distinct from (r->>''source_lease_id'')::uuid then raise exception ''invalid: selected lease is outside this tenancy'';end if;\n      end if;');
  execute format('create function public.preview_billing_setup_facts(p_account_id uuid,p_tenancy_id uuid,p_intent jsonb,p_tenancy jsonb,p_lease jsonb) returns jsonb language plpgsql set search_path=public as %L',body);
end $migration$;
revoke all on function public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb) to authenticated,service_role,tenancy_date_writer;
create or replace function public.preview_billing_setup(p_account_id uuid,p_tenancy_id uuid,p_intent jsonb) returns jsonb
language sql set search_path=public as $$ select public.preview_billing_setup_facts(p_account_id,p_tenancy_id,p_intent,null,null) $$;

notify pgrst,'reload schema';
commit;
