-- ----------------------------------------------------------------------------
-- Phase 3 (architecture plan, ADR-0003): RLS policy form — per-row EXISTS
-- function call -> initplan-cached membership IN-subquery.
--
-- The Phase 2 policies called public.is_account_member(account_id) per
-- candidate row. The function is STABLE and takes the row's account_id as an
-- argument, so Postgres cannot hoist it: on scans it executes once per row
-- (an index probe into account_members each time). The IN-subquery form has
-- no per-row argument, so the planner evaluates the membership set ONCE per
-- statement (hashed initplan) and each row check becomes a hash probe.
--
-- Benchmark (db/test/bench-rls.ts, 100k interactions, local stack, medians
-- of 5 under role authenticated):
--   full-scan count: form A 471ms -> form B 9ms   (-98%)
--   keyset page:     form A 2.8ms -> form B 1.3ms (-54%)
--
-- Scope: every policy whose qual references is_account_member over an
-- account_id column. accounts_member_select keeps the helper -- its argument
-- is accounts.id (the PK; point lookups only, nothing to hoist).
-- public.is_account_member() itself is KEPT: still used by accounts and by
-- any future point-lookup policy where the helper reads better.
--
-- The rewrite is dynamic over pg_policies so the import tables, attachments,
-- evidence_exports, events, alerts, watermarks, idempotency_keys and every
-- phase-2 domain table all get the same treatment without a hand-kept list
-- (a missed table would silently stay slow; a dynamic loop can't miss).
-- ----------------------------------------------------------------------------

do $$
declare
  p record;
  v_using text;
  v_check text;
  v_member_set text := $sub$(account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))$sub$;
begin
  for p in
    select pol.polname,
           c.relname,
           pol.polcmd,
           pg_get_expr(pol.polqual, pol.polrelid)      as qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check,
           (select array_agg(rolname) from pg_roles r where r.oid = any (pol.polroles)) as roles
      from pg_policy pol
      join pg_class c     on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname <> 'accounts'
       -- INSERT policies carry only with_check (polqual is null) -- match both.
       and (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ilike '%is_account_member(account_id)%'
         or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ilike '%is_account_member(account_id)%')
  loop
    execute format('drop policy %I on public.%I', p.polname, p.relname);

    -- Every matched expression IS exactly the helper call; substitute whole.
    v_using := v_member_set;
    v_check := case when p.with_check is not null then v_member_set else null end;

    if p.polcmd = '*' then
      execute format(
        'create policy %I on public.%I for all using %s with check %s',
        p.polname, p.relname, v_using, coalesce(v_check, v_using));
    elsif p.polcmd = 'r' then
      execute format(
        'create policy %I on public.%I for select using %s',
        p.polname, p.relname, v_using);
    elsif p.polcmd = 'a' then
      execute format(
        'create policy %I on public.%I for insert with check %s',
        p.polname, p.relname, coalesce(v_check, v_using));
    elsif p.polcmd = 'w' then
      execute format(
        'create policy %I on public.%I for update using %s with check %s',
        p.polname, p.relname, v_using, coalesce(v_check, v_using));
    elsif p.polcmd = 'd' then
      execute format(
        'create policy %I on public.%I for delete using %s',
        p.polname, p.relname, v_using);
    end if;

    raise notice 'rewrote policy % on %', p.polname, p.relname;
  end loop;
end $$;

-- Assertion: nothing outside accounts still calls the helper with account_id.
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
    raise exception 'ADR-0003 rewrite missed policies: %', leftover;
  end if;
end $$;
