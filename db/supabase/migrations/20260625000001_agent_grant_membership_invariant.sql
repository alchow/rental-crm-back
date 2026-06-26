-- ============================================================================
-- Agent grant <-> membership invariant (incident 2026-06-25).
-- ============================================================================
--
-- Symptom: an agent-minted token 404'd on every account-scoped request
-- (GET .../search, .../events, writes) while the owner got 200, for accounts
-- whose agent_grants row was still active (revoked_at null).
--
-- Root cause: request authorization keys off account_members.deleted_at (the
-- requireAccountMembership middleware + RLS is_account_member), but agent
-- discovery (GET /v1/agent/accounts) and token mint (POST /v1/agent/tokens)
-- key off agent_grants.revoked_at. The two tables were kept in lockstep ONLY
-- by app code (enable/revoke). Nothing in the DB enforced their consistency, so
-- when the agent membership was soft-deleted while the grant stayed active, the
-- agent was permanently told it served the account, kept minting valid tokens,
-- and 404'd on every account-scoped request -- with no self-recovery.
--
-- Fix: make agent_grants the SINGLE source of truth and the agent's
-- account_members row a derived projection, enforced in the DB:
--
--   (A) trigger on agent_grants -> projects the membership: an active grant
--       implies a live agent membership; a revoked grant soft-deletes it
--       (unless another active grant for the same agent_user still remains).
--
--   (B) guard trigger on account_members -> refuses to soft-delete an agent row
--       while an active grant exists. The supported removal path is to revoke
--       the grant; trigger (A) then soft-deletes the membership AFTER the grant
--       is marked revoked (same statement), so this guard sees no active grant
--       and allows it. A DIRECT/out-of-band soft-delete -- the incident vector
--       -- is refused.
--
--   (C) one-shot backfill -> reconciles existing rows in BOTH directions so the
--       invariant "agent membership live IFF an active grant exists" holds for
--       all current data. This is what restores reads for the stuck accounts.
--
-- The app revoke path is simplified in the same change to write ONLY the grant
-- and let trigger (A) derive the membership soft-delete atomically, so a
-- partially-applied revoke can no longer leave the two tables diverged.

-- ============================================================================
-- (A) agent_grants -> account_members projection
-- ============================================================================
create or replace function public.sync_agent_membership_from_grant()
returns trigger
language plpgsql
security definer            -- must maintain the projection regardless of caller
set search_path = public, pg_temp
as $$
begin
  if new.revoked_at is null then
    -- Grant active: ensure the agent membership exists and is live. The WHERE
    -- on the conflict path skips a no-op write (and its audit event) when the
    -- row is already an active agent membership.
    insert into public.account_members (account_id, user_id, role, deleted_at, updated_at)
    values (new.account_id, new.agent_user_id, 'agent', null, now())
    on conflict (account_id, user_id) do update
      set deleted_at = null,
          role       = 'agent',
          updated_at = now()
      where account_members.deleted_at is not null
         or account_members.role <> 'agent';
  else
    -- Grant revoked: soft-delete the agent membership, but ONLY if no other
    -- active grant still covers this (account, agent_user) pairing.
    update public.account_members m
       set deleted_at = now(),
           updated_at = now()
     where m.account_id = new.account_id
       and m.user_id    = new.agent_user_id
       and m.role       = 'agent'
       and m.deleted_at is null
       and not exists (
         select 1 from public.agent_grants g
          where g.account_id    = new.account_id
            and g.agent_user_id = new.agent_user_id
            and g.revoked_at is null
       );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_agent_membership_from_grant on public.agent_grants;
create trigger trg_sync_agent_membership_from_grant
  after insert or update on public.agent_grants
  for each row execute function public.sync_agent_membership_from_grant();

-- ============================================================================
-- (B) account_members guard: no out-of-band soft-delete of an agent membership
--     while an active grant exists. SECURITY DEFINER so the active-grant probe
--     always sees all grants regardless of the caller's RLS.
-- ============================================================================
create or replace function public.guard_agent_membership_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.agent_grants g
     where g.account_id    = new.account_id
       and g.agent_user_id = new.user_id
       and g.revoked_at is null
  ) then
    raise exception
      'cannot soft-delete an agent membership while an active agent_grant exists '
      '(account_id=%, user_id=%); revoke the grant instead',
      new.account_id, new.user_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_agent_membership_delete on public.account_members;
create trigger trg_guard_agent_membership_delete
  before update on public.account_members
  for each row
  when (old.deleted_at is null and new.deleted_at is not null and new.role = 'agent')
  execute function public.guard_agent_membership_delete();

-- ============================================================================
-- (C) one-shot reconcile so the invariant holds for existing data.
-- ============================================================================

-- Forward: every ACTIVE grant must have a LIVE agent membership. This restores
-- reads for accounts stuck in the incident state.
update public.account_members m
   set deleted_at = null, updated_at = now()
  from public.agent_grants g
 where g.revoked_at is null
   and m.account_id = g.account_id
   and m.user_id    = g.agent_user_id
   and m.role       = 'agent'
   and m.deleted_at is not null;

-- Forward (missing row): an active grant whose agent membership row is absent
-- entirely (e.g. hand-seeded data) gets one created.
insert into public.account_members (account_id, user_id, role, deleted_at, updated_at)
select g.account_id, g.agent_user_id, 'agent', null, now()
  from public.agent_grants g
 where g.revoked_at is null
   and not exists (
     select 1 from public.account_members m
      where m.account_id = g.account_id and m.user_id = g.agent_user_id
   )
on conflict (account_id, user_id) do nothing;

-- Reverse: a LIVE agent membership with NO active grant is the other half of
-- the invariant. Conservatively only touch agent rows the grants system owns
-- (at least one grant row exists for the pairing), so a hand-provisioned agent
-- membership that predates agent_grants is never silently removed.
update public.account_members m
   set deleted_at = now(), updated_at = now()
 where m.role = 'agent'
   and m.deleted_at is null
   and exists (
     select 1 from public.agent_grants g
      where g.account_id = m.account_id and g.agent_user_id = m.user_id
   )
   and not exists (
     select 1 from public.agent_grants g
      where g.account_id = m.account_id and g.agent_user_id = m.user_id
        and g.revoked_at is null
   );

-- Self-check: after reconcile, no active grant may lack a live agent membership.
do $$
declare n_bad int;
begin
  select count(*) into n_bad
    from public.agent_grants g
    left join public.account_members m
      on m.account_id = g.account_id
     and m.user_id    = g.agent_user_id
     and m.role       = 'agent'
   where g.revoked_at is null
     and (m.user_id is null or m.deleted_at is not null);
  if n_bad > 0 then
    raise exception
      'agent membership invariant backfill incomplete: % active grant(s) still lack a live membership',
      n_bad;
  end if;
end $$;
