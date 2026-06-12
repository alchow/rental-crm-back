-- ----------------------------------------------------------------------------
-- Agent role + idempotency TTL deltas (agent-api plan Workstream B + C).
--
--   (A) account_members.role gains 'agent': the agent service-account user
--       is a real, RLS-scoped account member (ADR-0006). Uses the defensive
--       locate-by-definition pattern because the inline constraint name is
--       only conventional -- see Phase 3.1 (20260605000001) §2 for precedent.
--   (B) idempotency_keys.expires_at default → now() + 30 days (was 24h):
--       aligns retention with the new 30-day TTL in the janitor.
--   (C) prune_idempotency_keys recreated with 30-day completed-key default
--       (was 24h / 86400s). Body is otherwise verbatim from
--       20260605000012 so the janitor caller signature is unchanged.
--   (D) is_approver_member(p_account_id, p_user_id): evidence-grade check
--       that a given user is a non-agent, non-deleted member of an account.
--       Needed because account_members SELECT RLS is self-only -- the API
--       cannot verify another user's membership through the caller's client.
--       Approval integrity ("approved_by must be a real, non-agent member")
--       is evidence-grade and must not be skippable.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) account_members.role: add 'agent'
-- ============================================================================
--
-- Locate-by-definition: the inline check was named account_members_role_check
-- by convention, but we don't hard-code that assumption.

do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.account_members'::regclass
    and contype  = 'c'
    and pg_get_constraintdef(oid) ilike '%role%owner%';
  if c is not null then
    execute format('alter table public.account_members drop constraint %I', c);
  end if;
end $$;

alter table public.account_members
  add constraint account_members_role_check
  check (role in ('owner', 'manager', 'viewer', 'agent'));

-- ============================================================================
-- (B) idempotency_keys.expires_at default: 24h → 30 days
-- ============================================================================

alter table public.idempotency_keys
  alter column expires_at set default now() + interval '30 days';

-- ============================================================================
-- (C) prune_idempotency_keys: 30-day completed-key default
-- ============================================================================
--
-- Body verbatim from 20260605000012, except p_completed_ttl_seconds default
-- changes from 86400 (1 day) to 2592000 (30 days) to match the new TTL.

create or replace function public.prune_idempotency_keys(
  p_completed_ttl_seconds int default 2592000,       -- 30 days
  p_in_flight_ttl_seconds int default 604800         -- 7 days
)
returns table (
  pruned_completed int,
  pruned_in_flight int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := 'system:cron:janitor';
  v_completed int := 0;
  v_in_flight int := 0;
begin
  perform set_config('audit.actor', v_actor, true);

  -- (i) completed past TTL: safe -- the cached response is already old;
  -- any client retry past 30 days is semantically a new request.
  delete from public.idempotency_keys
   where completed_at is not null
     and completed_at < now() - make_interval(secs => p_completed_ttl_seconds);
  get diagnostics v_completed = row_count;

  -- (ii) in-flight WAY past any plausible client retry (7d default).
  -- A handler that committed always flips completed_at; a handler that
  -- crashed pre-commit leaves completed_at null. 7+ days later, any
  -- in-flight client retry has long given up; freeing the key is safe.
  delete from public.idempotency_keys
   where completed_at is null
     and created_at < now() - make_interval(secs => p_in_flight_ttl_seconds);
  get diagnostics v_in_flight = row_count;

  pruned_completed := v_completed;
  pruned_in_flight := v_in_flight;
  return next;
end;
$$;

grant execute on function public.prune_idempotency_keys(int, int) to service_role;

-- ============================================================================
-- (D) is_approver_member(p_account_id, p_user_id)
-- ============================================================================
--
-- Returns true iff:
--   1. The CALLER is a non-deleted member of p_account_id (guards against
--      cross-account probing -- return false, not raise, when the caller is
--      not a member, so the guard is unforgeable via RLS).
--   2. A non-deleted account_members row exists for (p_account_id, p_user_id)
--      with role <> 'agent'.
--
-- This exists because account_members SELECT RLS is self-only, so the API
-- cannot verify another user's membership through the caller's client;
-- approval integrity ("approved_by must be a real, non-agent member") is
-- evidence-grade and must not be skippable.

create or replace function public.is_approver_member(
  p_account_id uuid,
  p_user_id    uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Guard: caller must themselves be a member; if not, return false so
  -- cross-account probes are indistinguishable from "not an approver".
  -- is_account_member() is security invoker and applies the caller's RLS.
  select
    public.is_account_member(p_account_id)
    and exists (
      select 1
      from public.account_members m
      where m.account_id  = p_account_id
        and m.user_id     = p_user_id
        and m.deleted_at  is null
        and m.role        <> 'agent'
    );
$$;

grant execute on function public.is_approver_member(uuid, uuid) to authenticated;
