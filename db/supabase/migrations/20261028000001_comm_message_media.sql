-- Provider media outcomes survive raw-capture retention; only Core owns file identity.
alter table public.attachments add column storage_bucket text default 'attachments'
  check (storage_bucket in ('attachments', 'comm-attachments'));

-- Inventory is authoritative: never guess through a collision or missing object.
do $inventory$
begin
  if to_regclass('storage.objects') is not null then
    execute $query$
update public.attachments a set storage_bucket = case
  when exists (select 1 from storage.objects o where o.bucket_id='comm-attachments' and o.name=a.storage_path)
   and not exists (select 1 from storage.objects o where o.bucket_id='attachments' and o.name=a.storage_path)
  then 'comm-attachments'
  when exists (select 1 from storage.objects o where o.bucket_id='attachments' and o.name=a.storage_path)
   and not exists (select 1 from storage.objects o where o.bucket_id='comm-attachments' and o.name=a.storage_path)
  then 'attachments' else null end;
    $query$;
  else
    update public.attachments set storage_bucket=null;
  end if;
end $inventory$;

create unique index if not exists interactions_account_id_id_key on public.interactions(account_id,id);
create unique index if not exists attachments_account_id_id_key on public.attachments(account_id,id);
create table public.comm_message_media (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  provider_msg_id text not null,
  interaction_id uuid,
  provider_media_index integer not null check (provider_media_index >= 0),
  declared_content_type text,
  declared_size_bytes bigint check (declared_size_bytes >= 0),
  state text not null default 'pending' check (state in ('pending','retrying','saved','failed','rejected')),
  attachment_id uuid,
  failure_code text check (failure_code in ('invalid_descriptor','too_many_files','file_too_large','unsupported_content','blocked_url','source_unavailable','authentication_failed','download_failed','upload_failed','processing_failed','message_withdrawn')),
  attempt_generation integer not null default 0 check (attempt_generation >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id,provider_msg_id,provider_media_index),
  foreign key(account_id,interaction_id) references public.interactions(account_id,id),
  foreign key(account_id,attachment_id) references public.attachments(account_id,id),
  check ((state='saved') = (attachment_id is not null)),
  check ((state in ('pending','saved')) = (failure_code is null))
);
create index comm_message_media_interaction_idx on public.comm_message_media(account_id,interaction_id,provider_media_index);
alter table public.comm_message_media enable row level security;
alter table public.comm_message_media force row level security;
create policy comm_message_media_member_read on public.comm_message_media for select to authenticated
  using (exists(select 1 from public.account_members m where m.account_id=comm_message_media.account_id and m.user_id=auth.uid() and m.deleted_at is null));
revoke all on public.comm_message_media from public,anon,authenticated;
grant select on public.comm_message_media to authenticated;
grant all on public.comm_message_media to service_role;
create trigger comm_message_media_audit after insert or update or delete on public.comm_message_media
  for each row execute function public._emit_event();

create function public._capture_comm_media() returns trigger language plpgsql security definer set search_path=public as $$
declare item jsonb; ordinal integer; idx integer; reason text; accepted integer:=0;
begin
  if new.matched_account_id is null or new.provider<>'telnyx' or new.payload->>'channel'<>'sms' then return new; end if;
  for item, ordinal in select value, ordinality::integer from jsonb_array_elements(
    case when jsonb_typeof(new.payload->'media')='array' then new.payload->'media' else '[]'::jsonb end
  ) with ordinality loop
    idx := coalesce((item->>'provider_media_index')::integer,ordinal-1);
    reason := item->>'rejection_code';
    if reason is null and coalesce((item->>'size_bytes')::bigint,0)>10485760 then reason:='file_too_large'; end if;
    if reason is null then
      if accepted>=10 then reason:='too_many_files'; else accepted:=accepted+1; end if;
    end if;
    insert into public.comm_message_media(account_id,provider_msg_id,interaction_id,provider_media_index,
      declared_content_type,declared_size_bytes,state,failure_code)
    values(new.matched_account_id,new.provider_msg_id,new.matched_interaction_id,idx,
      item->>'content_type',(item->>'size_bytes')::bigint,
      case when reason is null then 'pending' else 'rejected' end,reason)
    on conflict(account_id,provider_msg_id,provider_media_index) do update
      set interaction_id=excluded.interaction_id
      where comm_message_media.interaction_id is null and excluded.interaction_id is not null;
  end loop;
  return new;
end $$;
revoke all on function public._capture_comm_media() from public,anon,authenticated;
grant execute on function public._capture_comm_media() to service_role;
create trigger inbound_raw_media after insert or update of matched_interaction_id on public.inbound_raw
  for each row execute function public._capture_comm_media();

create function public.store_comm_attachment(p_account_id uuid,p_interaction_id uuid,p_filename text,
  p_content_type text,p_storage_path text,p_content_hash text,p_size_bytes bigint,p_media_slot_id uuid default null)
returns public.attachments language plpgsql security definer set search_path=public as $$
declare parent public.interactions%rowtype; slot public.comm_message_media%rowtype; result public.attachments%rowtype;
begin
  -- One parent lock serializes deduplication, the count cap, and slot commits.
  select * into parent from public.interactions where account_id=p_account_id and id=p_interaction_id for update;
  if not found then raise exception 'message not found' using errcode='P0002'; end if;
  if parent.deleted_at is not null or exists(with recursive chain as (select id,correction_kind from public.interactions where id=parent.id union all select i.id,i.correction_kind from public.interactions i join chain c on i.corrects_id=c.id) select 1 from chain where correction_kind='retract') then
    raise exception 'message withdrawn' using errcode='P0003';
  end if;
  if parent.actor not in ('system:comm-inbound','system:comm-persona','system:comm-persona-cc') or parent.attestation<>'provider_verified' then
    raise exception 'provider verified message required' using errcode='23514';
  end if;
  if p_size_bytes<1 or p_size_bytes>10485760 then raise exception 'attachment size limit' using errcode='23514'; end if;
  if p_media_slot_id is not null then
    select * into slot from public.comm_message_media where account_id=p_account_id and interaction_id=p_interaction_id and id=p_media_slot_id for update;
    if not found then raise exception 'media slot not found' using errcode='P0002'; end if;
    if slot.state='saved' then
      select * into result from public.attachments where account_id=p_account_id and id=slot.attachment_id and deleted_at is null;
      if not found then raise exception 'attachment removed' using errcode='P0003'; end if;
      if result.content_hash<>p_content_hash then raise exception 'slot content conflict' using errcode='P0003'; end if;
      return result;
    end if;
    if slot.state='rejected' then raise exception 'media slot rejected' using errcode='P0003'; end if;
  end if;
  if exists(select 1 from public.attachments where account_id=p_account_id and entity_type='interactions' and entity_id=p_interaction_id and content_hash=p_content_hash and deleted_at is not null) then
    raise exception 'attachment removed' using errcode='P0003';
  end if;
  select * into result from public.attachments where account_id=p_account_id and entity_type='interactions' and entity_id=p_interaction_id and content_hash=p_content_hash and deleted_at is null;
  if not found then
    if (select count(*) from public.attachments where account_id=p_account_id and entity_type='interactions' and entity_id=p_interaction_id and deleted_at is null)>=10 then
      raise exception 'a message carries at most 10 stored attachments' using errcode='23514';
    end if;
    insert into public.attachments(account_id,entity_type,entity_id,storage_bucket,storage_path,content_hash,mime_type,size_bytes,filename)
      values(p_account_id,'interactions',p_interaction_id,'comm-attachments',p_storage_path,p_content_hash,p_content_type,p_size_bytes,p_filename)
      returning * into result;
  end if;
  if p_media_slot_id is not null then
    update public.comm_message_media set state='saved',attachment_id=result.id,failure_code=null,updated_at=now() where id=slot.id;
  end if;
  return result;
end $$;
revoke all on function public.store_comm_attachment(uuid,uuid,text,text,text,text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.store_comm_attachment(uuid,uuid,text,text,text,text,bigint,uuid) to service_role;

create function public.report_comm_media_outcome(p_account_id uuid,p_interaction_id uuid,p_slot_id uuid,p_state text,p_failure_code text,p_attempt_generation integer default 0)
returns public.comm_message_media language plpgsql security definer set search_path=public as $$
declare slot public.comm_message_media%rowtype;
begin
  perform 1 from public.interactions where account_id=p_account_id and id=p_interaction_id for update;
  if not found then raise exception 'message not found' using errcode='P0002'; end if;
  select * into slot from public.comm_message_media where account_id=p_account_id and interaction_id=p_interaction_id and id=p_slot_id for update;
  if not found then raise exception 'media slot not found' using errcode='P0002'; end if;
  if slot.state in ('saved','rejected') or p_attempt_generation<slot.attempt_generation then return slot; end if;
  if slot.state='failed' and p_attempt_generation<=slot.attempt_generation then return slot; end if;
  if p_state not in ('retrying','failed','rejected') then raise exception 'invalid outcome' using errcode='23514'; end if;
  update public.comm_message_media set state=p_state,failure_code=p_failure_code,attempt_generation=p_attempt_generation,updated_at=now()
    where id=slot.id returning * into slot;
  return slot;
end $$;
revoke all on function public.report_comm_media_outcome(uuid,uuid,uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.report_comm_media_outcome(uuid,uuid,uuid,text,text,integer) to service_role;

create function public._guard_attachment_locator() returns trigger language plpgsql set search_path=public as $$
begin
  if tg_op='UPDATE' and ((new.storage_path,new.content_hash) is distinct from (old.storage_path,old.content_hash)
    or (new.storage_bucket is distinct from old.storage_bucket and not (old.storage_bucket is null and new.storage_bucket is not null and current_user in ('postgres','service_role')))) then
    raise exception 'attachment storage identity is immutable' using errcode='23514';
  end if;
  if tg_op='INSERT' and new.storage_bucket='comm-attachments' and current_user not in ('postgres','service_role') then
    raise exception 'communication storage is server controlled' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public._guard_attachment_locator() from public,anon,authenticated;
grant execute on function public._guard_attachment_locator() to service_role;
create trigger attachments_locator_guard before insert or update on public.attachments
  for each row execute function public._guard_attachment_locator();

create function public._guard_comm_media() returns trigger language plpgsql set search_path=public as $$
begin
  if (new.account_id,new.provider_msg_id,new.provider_media_index) is distinct from (old.account_id,old.provider_msg_id,old.provider_media_index)
    or (old.interaction_id is not null and new.interaction_id is distinct from old.interaction_id) then
    raise exception 'media identity is immutable' using errcode='23514';
  end if;
  if old.state in ('saved','rejected') and (new.state,new.attachment_id,new.failure_code) is distinct from (old.state,old.attachment_id,old.failure_code) then
    raise exception 'terminal media outcome is immutable' using errcode='23514';
  end if;
  if new.attempt_generation<old.attempt_generation or (old.state='failed' and new.state not in ('failed','saved') and new.attempt_generation<=old.attempt_generation) then
    raise exception 'media retry requires a new generation' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public._guard_comm_media() from public,anon,authenticated;
grant execute on function public._guard_comm_media() to service_role;
create trigger comm_message_media_guard before update on public.comm_message_media
  for each row execute function public._guard_comm_media();

-- Storage backfill exceptions are actionable inventory, never guessed bucket writes.
do $$ declare unresolved integer; begin
  select count(*) into unresolved from public.attachments where storage_bucket is null;
  if unresolved>0 then raise warning '% attachment storage locations require inventory/hash review',unresolved; end if;
end $$;

-- The record UI navigates to correction heads; file provenance remains on the root.
create function public.interaction_media_root(p_account_id uuid,p_interaction_id uuid)
returns uuid language sql stable security invoker set search_path=public as $$
  with recursive parents as (
    select id,corrects_id,deleted_at from public.interactions where account_id=p_account_id and id=p_interaction_id
    union all
    select i.id,i.corrects_id,i.deleted_at from public.interactions i join parents p on i.id=p.corrects_id
      where i.account_id=p_account_id
  ) select id from parents where corrects_id is null and deleted_at is null;
$$;
revoke all on function public.interaction_media_root(uuid,uuid) from public,anon;
grant execute on function public.interaction_media_root(uuid,uuid) to authenticated,service_role;
