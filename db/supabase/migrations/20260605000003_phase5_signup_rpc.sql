-- ----------------------------------------------------------------------------
-- Phase 5: signup atomicity.
--
-- The Phase 4 signup route did three writes (users mirror, accounts row,
-- owner account_members row) sequentially via the admin client. Three writes
-- can fail independently; a partial failure leaves an orphan account with no
-- owner, or an auth.users row with no account_members. That's the latent bug
-- the user called out -- "real security gap if account_members never wires
-- up; that user has no path to recover their data."
--
-- This migration replaces the three writes with ONE Postgres function called
-- via supabase-js .rpc(). The function:
--
--   - runs in a single implicit transaction (postgres functions are atomic);
--   - keys off auth.uid() from the caller's JWT (the freshly-issued signup
--     session), so the Phase-4 audit triggers attribute the inserts to the
--     real new user, not to 'system';
--   - refuses if the caller already has any account_members rows
--     (prevents re-running it to spawn more accounts as side effect of a
--     bug in the route -- creating ADDITIONAL accounts for an existing user
--     belongs at a different endpoint when we add it);
--   - returns the new account_id + role so the route doesn't need a second
--     query to know what to ship back to the client.
--
-- SECURITY DEFINER is required because:
--   - account_members has no public INSERT policy (only the SELECT-self one);
--   - the new user has zero memberships at call time, so is_account_member()
--     would deny their own insert.
-- The function bypasses those policies but stays narrow: it only acts on the
-- caller's own row (auth.uid()), and the membership-precondition check
-- guarantees one-shot semantics.
-- ----------------------------------------------------------------------------

create or replace function public.create_account_for_new_user(
  p_account_name text,
  p_display_name text default null
)
returns table (
  account_id uuid,
  role       text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_account_id uuid;
begin
  if v_user_id is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if p_account_name is null or length(trim(p_account_name)) = 0 then
    raise exception 'account_name is required' using errcode = '22023';
  end if;

  -- One-shot: refuse if the caller already has any membership. A future
  -- "create another account" endpoint will live elsewhere with different
  -- semantics (e.g., does the caller have permission to create accounts).
  if exists (select 1 from public.account_members where user_id = v_user_id) then
    raise exception 'user already has account memberships'
      using errcode = 'unique_violation';
  end if;

  -- (1) profile mirror. Idempotent so a retried call after a partial failure
  -- elsewhere doesn't trip a duplicate-key error.
  insert into public.users (id, display_name)
       values (v_user_id, p_display_name)
  on conflict (id) do nothing;

  -- (2) new account
  insert into public.accounts (name)
       values (trim(p_account_name))
    returning id into v_account_id;

  -- (3) owner membership. The audit trigger on account_members fires here
  -- and records actor = 'user:<v_user_id>' (the Phase-4 actor-integrity fix
  -- means audit.actor cannot override auth.uid()).
  insert into public.account_members (account_id, user_id, role)
       values (v_account_id, v_user_id, 'owner');

  account_id := v_account_id;
  role       := 'owner';
  return next;
end;
$$;

-- Anon needs nothing here; authenticated calls it via supabase-js .rpc()
-- with their freshly-issued session JWT.
grant execute on function public.create_account_for_new_user(text, text) to authenticated;
