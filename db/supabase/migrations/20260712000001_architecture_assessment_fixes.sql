-- ----------------------------------------------------------------------------
-- Architecture assessment follow-up:
--   1. Keep opt-out list pagination inside the database.
--   2. Add keyset-list indexes for newer list routes.
--   3. Bring document-vault RLS policies onto the initplan-friendly member set.
-- ----------------------------------------------------------------------------

-- The previous two-argument list_account_opt_outs returned every visible row
-- and left API pagination to slice in memory. Replace it with defaulted
-- limit/offset parameters so existing named-arg callers can still omit them,
-- while the API can fetch one page plus one sentinel row.
drop function if exists public.list_account_opt_outs(uuid, text);

create function public.list_account_opt_outs(
  p_account_id uuid,
  p_channel    text default null,
  p_limit      int  default 50,
  p_offset     int  default 0
)
returns setof public.comm_opt_outs
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit  int := greatest(1, least(coalesce(p_limit, 50), 101));
  v_offset int := greatest(0, coalesce(p_offset, 0));
begin
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = p_account_id
       and m.deleted_at is null
  ) then
    raise exception 'not authorized to list opt-outs for this account'
      using errcode = '42501';
  end if;

  -- The channel_identities intersection scopes WHICH addresses are visible;
  -- keyword/source_ref are nulled because the register is global and carries
  -- no account provenance. Limit/offset are applied here so API pagination
  -- does not materialize the full visible register.
  return query
    select oo.channel, oo.address, oo.opted_out_at, null::text, null::text
      from public.comm_opt_outs oo
     where (p_channel is null or oo.channel = p_channel)
       and exists (
         select 1 from public.channel_identities ci
          where ci.account_id = p_account_id
            and ci.channel = oo.channel
            and ci.address = oo.address
       )
     order by oo.opted_out_at desc
     limit v_limit
     offset v_offset;
end;
$$;

revoke execute on function public.list_account_opt_outs(uuid, text, int, int) from public;
revoke execute on function public.list_account_opt_outs(uuid, text, int, int) from anon;
grant  execute on function public.list_account_opt_outs(uuid, text, int, int) to authenticated, service_role;

-- Ordered list support. Btree indexes can be scanned backward for DESC
-- keyset pages, so the same shapes serve ascending and descending helpers.
create index if not exists comm_threads_account_created_id_idx
  on public.comm_threads (account_id, created_at, id);
create index if not exists comm_threads_account_status_created_id_idx
  on public.comm_threads (account_id, status, created_at, id);
create index if not exists comm_threads_account_kind_created_id_idx
  on public.comm_threads (account_id, kind, created_at, id);
create index if not exists comm_threads_account_channel_created_id_idx
  on public.comm_threads (account_id, channel, created_at, id);
create index if not exists comm_threads_account_tenancy_created_id_idx
  on public.comm_threads (account_id, tenancy_id, created_at, id)
  where tenancy_id is not null;

create index if not exists comm_policies_account_created_id_idx
  on public.comm_policies (account_id, created_at, id);
create index if not exists comm_policies_account_status_created_id_idx
  on public.comm_policies (account_id, status, created_at, id);
create index if not exists comm_policies_account_kind_created_id_idx
  on public.comm_policies (account_id, policy_kind, created_at, id);

create index if not exists comm_opt_outs_opted_out_idx
  on public.comm_opt_outs (opted_out_at desc, channel, address);
create index if not exists comm_opt_outs_channel_opted_out_idx
  on public.comm_opt_outs (channel, opted_out_at desc, address);

create index if not exists notices_account_created_id_live_idx
  on public.notices (account_id, created_at, id)
  where deleted_at is null;
create index if not exists notices_account_tenancy_created_id_live_idx
  on public.notices (account_id, tenancy_id, created_at, id)
  where deleted_at is null;

create index if not exists rent_schedules_account_created_id_live_idx
  on public.rent_schedules (account_id, created_at, id)
  where deleted_at is null;
create index if not exists rent_schedules_account_tenancy_created_id_live_idx
  on public.rent_schedules (account_id, tenancy_id, created_at, id)
  where deleted_at is null;

-- Documents were added after the broad ADR-0003 policy rewrite and carried
-- the older per-row helper call form. Use the same set-membership expression
-- as the rewritten tables so Postgres can initplan the membership set once.
drop policy if exists documents_member_all on public.documents;
create policy documents_member_all on public.documents
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

drop policy if exists document_versions_member_all on public.document_versions;
create policy document_versions_member_all on public.document_versions
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

drop policy if exists document_access_tokens_member_all on public.document_access_tokens;
create policy document_access_tokens_member_all on public.document_access_tokens
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

drop policy if exists document_access_events_member_select on public.document_access_events;
create policy document_access_events_member_select on public.document_access_events
  for select
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

do $$
declare
  leftover text;
begin
  select string_agg(c.relname || '.' || pol.polname, ', ')
    into leftover
    from pg_policy pol
    join pg_class c     on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname <> 'accounts'
     and (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ilike '%is_account_member(account_id)%'
       or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ilike '%is_account_member(account_id)%');
  if leftover is not null then
    raise exception 'member policy rewrite missed policies: %', leftover;
  end if;
end $$;
