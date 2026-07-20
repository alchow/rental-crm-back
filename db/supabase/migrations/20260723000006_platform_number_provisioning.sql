-- ============================================================================
-- Platform-number provisioning — agent-writable registration (plan §1)
-- ============================================================================
-- The problem this fixes, as a data flow:
--
--   a landlord signs up and needs their own texting number
--     -> OLD: ops buys a number in the Telnyx portal, hand-inserts a
--        platform_numbers row (service role, since 20260701000002 deliberately
--        gave members SELECT and nothing else), hand-edits the agent's
--        COMMS_PLATFORM_NUMBERS env map, and redeploys the agent. Four manual
--        steps per account, two of which are a redeploy.
--     -> NEW: the agent orders the number from Telnyx and registers it here
--        itself, through ONE self-defending RPC. The env map goes away; the
--        agent discovers numbers by reading this table per account.
--
-- Why an RPC and not a member write policy:
--   platform_numbers is force-RLS with SELECT-only for members, and that was a
--   deliberate call ("writes are ops-only ... No member write policy on
--   purpose", 20260701000002:85-89). Opening INSERT to members would let any
--   owner/manager claim an arbitrary number for their account -- including one
--   the platform pays for on someone else's behalf. Instead the write stays
--   shut to members and opens ONLY to the agent principal, asserted inside a
--   SECURITY DEFINER body. Same shape as set_owner_phone_verified: the agent is
--   the only role that may write a fact the landlord must not be able to forge.
--
-- Idempotency is structural, not conventional. The agent registers from a
-- durable workflow step that can replay after a crash, so a second identical
-- call must be a no-op rather than an error -- hence ON CONFLICT DO UPDATE on
-- (account_id, number). It re-activates a previously released number too: if we
-- re-provisioned it, it is ours again.
--
-- What is deliberately NOT idempotent: the same number under a DIFFERENT
-- account. That hits the global platform_numbers_number_key and raises 23505,
-- which the route surfaces as 409. A phone number is a globally unique physical
-- resource; silently reassigning one across tenants would cross-wire two
-- landlords' conversations. Loud failure is the only correct outcome.
--
-- No 'pending' status is introduced. Telnyx 10DLC campaign assignment is
-- asynchronous (minutes to days), so a freshly ordered number is NOT sendable
-- on arrival. That in-flight state lives in the AGENT's database as process
-- state; a row appears here only once the number can actually carry traffic.
-- This keeps the 409 gate in POST /comms/threads honest -- "no active platform
-- number" continues to mean "genuinely cannot send", not "ordered, ask again
-- later".
-- ============================================================================

create or replace function public.record_platform_number(
  p_account_id   uuid,
  p_number       text,
  p_provider     text,
  p_capabilities text[]
) returns public.platform_numbers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.platform_numbers%rowtype;
  v_caps text[];
begin
  -- Agent-principal self-defense (mirrors set_owner_phone_verified and the
  -- comms-ledger RPCs). This is what makes an `authenticated` EXECUTE grant
  -- safe on a DEFINER function -- see db/test/check_definer_grants.sql.
  if auth.uid() is null or not exists (
    select 1
      from public.account_members m
     where m.account_id = p_account_id
       and m.user_id    = (select auth.uid())
       and m.role       = 'agent'
       and m.deleted_at is null
  ) then
    raise exception 'caller is not the agent principal for this account'
      using errcode = '42501';
  end if;

  v_caps := coalesce(nullif(p_capabilities, '{}'::text[]), array['sms']::text[]);

  -- An empty capabilities array would make the number invisible to
  -- POST /comms/threads (which filters with `capabilities @> [channel]`), so
  -- the account would hold a number it could never send from -- a silent
  -- black hole. Coalesced to {sms} above rather than rejected: the caller's
  -- intent when registering a number is unambiguous.
  insert into public.platform_numbers (account_id, number, provider, capabilities, status)
  values (p_account_id, p_number, p_provider, v_caps, 'active')
  on conflict (account_id, number) do update
     set provider     = excluded.provider,
         capabilities = excluded.capabilities,
         status       = 'active',
         updated_at   = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- Default ACLs on Supabase grant EXECUTE to anon/authenticated/service_role on
-- every new public function, and `revoke ... from public` is a no-op against
-- them -- so revoke from the roles by name. anon must never reach this (the
-- agent authenticates); authenticated is required because the agent principal
-- IS an authenticated user, and the body self-defends on its role.
revoke execute on function public.record_platform_number(uuid, text, text, text[]) from public;
revoke execute on function public.record_platform_number(uuid, text, text, text[]) from anon;
grant  execute on function public.record_platform_number(uuid, text, text, text[]) to authenticated, service_role;
