-- ============================================================================
-- Landlord phone VERIFICATION (builds on Workstream 1's users.phone).
--
-- users.phone already exists (20260626000003_user_phone.sql) and is settable,
-- unverified, via PATCH /v1/profile. This adds the proof-of-control signal:
-- phone_verified_at is non-null only when the number was confirmed via the SMS
-- OTP flow owned by landlord-agent (it issues the code, sends it over Telnyx,
-- and calls back here once the landlord enters it).
--
-- The "verified" bit must NOT be settable by a raw landlord token — otherwise a
-- landlord could mark their own phone verified and skip SMS. So the write goes
-- through set_owner_phone_verified(), a SECURITY DEFINER RPC that the agent
-- principal calls. The agent authenticates to Core with its own agent-service
-- JWT (auth.uid() = the agent, not the landlord), so RLS self-update cannot
-- reach the landlord's row — the definer RPC is the only path.
-- ============================================================================

alter table public.users add column phone_verified_at timestamptz;

-- ----------------------------------------------------------------------------
-- set_owner_phone_verified — record a landlord's phone as verified.
--
-- SECURITY DEFINER so it can write public.users despite the row belonging to a
-- different user than the caller (the agent). It re-derives authorization from
-- the verified JWT rather than trusting the endpoint:
--   * the caller (auth.uid()) must be the agent principal in p_account_id
--     (account_members.role = 'agent'), and
--   * p_user_id must be a non-deleted member of p_account_id.
-- Both checks fail closed. The HTTP layer also gates on principal.type='agent';
-- this is defence in depth so the privileged write can't be misused even if a
-- future caller reaches the RPC directly.
--
-- p_phone must already be E.164 (the endpoint normalises before calling); it is
-- stored on users.phone, which carries the same E.164 CHECK as Workstream 1.
-- ----------------------------------------------------------------------------
create or replace function public.set_owner_phone_verified(
  p_account_id uuid,
  p_user_id    uuid,
  p_phone      text
)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.users%rowtype;
begin
  if not exists (
    select 1 from public.account_members m
    where m.account_id = p_account_id
      and m.user_id    = (select auth.uid())
      and m.role       = 'agent'
      and m.deleted_at is null
  ) then
    raise exception 'caller is not the agent principal for this account'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.account_members m
    where m.account_id = p_account_id
      and m.user_id    = p_user_id
      and m.deleted_at is null
  ) then
    raise exception 'target user is not a member of this account'
      using errcode = 'P0002';
  end if;

  update public.users
     set phone             = p_phone,
         phone_verified_at = now(),
         updated_at        = now()
   where id = p_user_id
     and deleted_at is null
  returning * into v_user;

  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  return v_user;
end;
$$;

grant execute on function public.set_owner_phone_verified(uuid, uuid, text) to authenticated;
