begin;

alter table public.accounts add column person_match_enabled boolean not null default false;

create function public._validate_new_setup_contacts(p_account_id uuid, p_people jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  conflict record;
begin
  if not exists (select 1 from public.accounts where id = p_account_id and person_match_enabled) then
    return;
  end if;
  with new_contacts as (
    select person.ordinality - 1 as person_index, contact.field, contact.value
    from jsonb_array_elements(p_people) with ordinality as person(data, ordinality)
    cross join lateral (
      select 'email' as field, lower(btrim(email)) as value
        from jsonb_array_elements_text(coalesce(person.data->'emails', '[]')) as email
      union all
      select 'phone', phone
        from jsonb_array_elements_text(coalesce(person.data->'phones', '[]')) as phone
    ) contact
    where person.data->>'tenant_id' is null and contact.value <> ''
  )
  select person_index, field, tenant_id into conflict
    from (
      select c.person_index, c.field, t.id as tenant_id
      from new_contacts c
      join public.tenants t on t.account_id = p_account_id and t.deleted_at is null
       and ((c.field = 'email' and c.value in (select lower(btrim(email)) from unnest(t.emails) as email))
         or (c.field = 'phone' and c.value = any(t.phones)))
      union all
      select later.person_index, later.field, null::uuid
      from new_contacts later
      where exists (
        select 1 from new_contacts earlier
          where earlier.field = later.field and earlier.value = later.value
            and earlier.person_index < later.person_index
      )
    ) conflicts
    order by person_index, field, tenant_id nulls last
    limit 1;
  if found then
    raise exception 'setup_person_contact_conflict' using errcode = 'PT409',
      detail = jsonb_strip_nulls(jsonb_build_object('personIndex', conflict.person_index, 'field', conflict.field,
        'tenantId', conflict.tenant_id))::text;
  end if;
end;
$$;

revoke all on function public._validate_new_setup_contacts(uuid, jsonb) from public, anon;
grant execute on function public._validate_new_setup_contacts(uuid, jsonb) to authenticated;

do $migration$
declare
  body text;
  anchor text := '  for person in select value from jsonb_array_elements(p_setup->''people'') loop';
begin
  body := pg_get_functiondef('public.preview_tenancy_setup_session(uuid,uuid,jsonb)'::regprocedure);
  assert position(anchor in body) > 0, 'setup people validation changed';
  execute replace(body, anchor, E'  perform public._validate_new_setup_contacts(p_account_id,p_setup->''people'');\n' || anchor);
end;
$migration$;

-- Discard serializes with commit on the session row. Expiration releases staged uploads for cleanup.
grant create on schema public to tenancy_setup_writer;
create function public.discard_tenancy_setup_session(p_account_id uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  session public.tenancy_setup_sessions;
begin
  if auth.uid() is null or not exists (
    select 1 from public.account_members m where m.account_id = p_account_id
      and m.user_id = auth.uid() and m.deleted_at is null and m.role in ('owner', 'manager')
  ) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into session from public.tenancy_setup_sessions
    where account_id = p_account_id and id = p_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if session.completed_at is not null then
    raise exception 'conflict: setup already completed';
  end if;
  if session.expires_at > clock_timestamp() then
    update public.tenancy_setup_sessions set payload = '{}', revision = revision + 1,
      updated_at = clock_timestamp(), expires_at = clock_timestamp()
    where account_id = p_account_id and id = p_id;
  end if;
end;
$$;

alter function public.discard_tenancy_setup_session(uuid, uuid) owner to tenancy_setup_writer;
revoke create on schema public from tenancy_setup_writer;
revoke all on function public.discard_tenancy_setup_session(uuid, uuid) from public, anon;
grant execute on function public.discard_tenancy_setup_session(uuid, uuid) to authenticated;

-- Setup's transaction locks the claim until it writes the successful receipt.
-- Keep the existing lease for ordinary account requests.
do $migration$
declare
  body text := pg_get_functiondef('public.claim_idempotency_key(uuid,text,text)'::regprocedure);
begin
  body := replace(body, 'p_fingerprint text)', 'p_fingerprint text, p_setup_commit boolean)');
  assert position('p_setup_commit boolean' in body) > 0, 'idempotency claim signature changed';
  body := replace(body, '90s+ after', 'after the request lease');
  body := replace(body, 'and created_at < now() - interval ''90 seconds'';',
    'and (not p_setup_commit or request_fingerprint = p_fingerprint)
     and created_at < now() - case when p_setup_commit then interval ''30 seconds'' else interval ''90 seconds'' end;');
  assert position('interval ''30 seconds''' in body) > 0, 'idempotency claim expiry changed';
  execute body;
end;
$migration$;
revoke all on function public.claim_idempotency_key(uuid,text,text,boolean) from public, anon;
grant execute on function public.claim_idempotency_key(uuid,text,text,boolean) to authenticated;
create or replace function public.claim_idempotency_key(p_account_id uuid, p_key text, p_fingerprint text)
returns table(claimed boolean, fingerprint_matches boolean, in_flight boolean, status_code integer, body jsonb)
language sql set search_path = public as $$
  select * from public.claim_idempotency_key(p_account_id,p_key,p_fingerprint,false)
$$;
grant execute on function public.claim_idempotency_key(uuid,text,text,boolean) to tenancy_setup_writer, service_role;

notify pgrst, 'reload schema';
commit;
