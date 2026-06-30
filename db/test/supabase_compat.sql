-- ----------------------------------------------------------------------------
-- Supabase compat primer for ephemeral test Postgres.
--
-- In real Supabase these schemas, roles, and functions are managed for you.
-- In CI we run against a stock postgres:16 service container, so we have to
-- create the minimum needed by our migrations and by RLS:
--
--   1. the `auth` schema and a minimal `auth.users` table our FKs target
--   2. the `authenticated` and `anon` roles (the test client SETs ROLE to
--      `authenticated`; this is the same role PostgREST sets in production
--      when verifying a non-service-role JWT)
--   3. `auth.uid()` reading `request.jwt.claims->>sub`, same shape as
--      Supabase's built-in implementation
--
-- Anything beyond these stays out of scope — we are NOT trying to emulate
-- GoTrue, PostgREST, or Supabase Storage. This is just enough Postgres for
-- our migrations + RLS to load and our test client to act as a real user.
-- ----------------------------------------------------------------------------

create schema if not exists auth;

-- Roles. Defensive about prior state — CREATE ROLE has no IF NOT EXISTS.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- Minimal auth.users. Only the columns our schema needs to FK against; we
-- don't model GoTrue's full table.
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- auth.uid(): read the JWT sub claim out of the request settings. Mirrors
-- Supabase's implementation closely enough that our policies behave the
-- same way under PostgREST.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

-- Grants so the authenticated role can speak to public.
grant usage on schema public to anon, authenticated;
grant usage on schema auth   to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;

-- Replicate Supabase's default function-execute ACL.
--
-- On real Supabase, pg_default_acl entries (owned by postgres/supabase_admin)
-- EXPLICITLY grant EXECUTE on every newly-created public function to anon,
-- authenticated, and service_role -- which is why `revoke execute ... from public`
-- is a no-op in prod (it only touches the PUBLIC pseudo-role, not the per-role
-- grants that Supabase's default ACL already laid down).
--
-- Without this line, the CI test DB does NOT replicate that behaviour: functions
-- land with no execute grant for those roles, so the SECURITY DEFINER grant guard
-- (db/test/check_definer_grants.sql) would vacuously pass even if migration 009
-- never ran, making the guard meaningless. Adding the same default ACL here ensures
-- that CI and prod are in the same state before migrations apply, and that any
-- DEFINER function whose revoke was accidentally omitted is caught red.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- Existing tables are out of band (none yet at this point), but be explicit.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
