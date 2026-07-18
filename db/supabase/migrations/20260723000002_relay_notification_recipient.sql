-- ============================================================================
-- Relay demoted to notification — authoritative landlord recipient (PR 7)
-- ============================================================================
-- Product decision for the DIY-landlord persona: the visible Cc is the PRIMARY
-- conversation surface; the relay leg is a mere notification for
-- tenant-initiated mail. Two defects motivated this, as data flows:
--
--   (1) Wrong recipient (real prod incident). The relay leg's to_address came
--       from the thread binding, which is minted from channel_identities at
--       thread creation:
--
--         bad claim: channel_identities says tenant@example.test -> landlord
--           -> thread create freezes tenant@example.test as the LANDLORD leg
--           -> tenant writes in -> relay leg dials the binding
--           -> the tenant is emailed their own message back
--
--       Fix: a relay leg addressed to a landlord_user participant resolves its
--       recipient from the account's AUTHORITATIVE owner/manager email
--       (auth.users via account_members — the _comm_resolve_context_party
--       account-member tier, pinned to the participant's user id), falling
--       back to the binding only when no authoritative email exists.
--
--   (2) Double delivery. When the tenant reply-alls, the landlord already
--       received the mail physically (their address is in the inbound's cast,
--       role 'cc'); the relay leg would deliver it a second time. Fix: before
--       the relay row is created the API asks whether the source interaction's
--       cast already contains the resolved address (canonical email compare,
--       reusing _comm_canonical_email_address so gmail dot/+tag aliases still
--       match) and refuses with 409 relay_already_delivered when it does.
--
-- This RPC is the one server-side judge for both questions, so the API and
-- the DB agree on the canonicalization (no TS re-implementation to drift).
-- The API resolves the fallback (explicit to_address / thread binding /
-- address book) exactly as before and passes it in; core answers with the
-- chosen recipient and the suppression verdict. Non-landlord relay legs and
-- every non-relay send never call this function and are byte-identical.
--
-- SECURITY DEFINER so the account_members ⨝ auth.users read works from the
-- API's JWT-bearing client; self-defends on live owner/manager/agent
-- membership of the target account (the send path's roles) so it is never a
-- cross-account address oracle. Every query below is account-pinned.
-- Allowlisted in db/test/check_definer_grants.sql.

create function public.resolve_relay_landlord_recipient(
  p_account_id            uuid,
  p_user_id               uuid,
  p_source_interaction_id uuid,
  p_fallback_address      text
)
returns table (to_address text, already_delivered boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_authoritative text;
begin
  -- Self-defense (DEFINER bypasses RLS): same roles as the send path (outbox
  -- POST). A viewer may not use this as an address->party confirm-oracle.
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = p_account_id
       and m.role in ('owner', 'manager', 'agent')
       and m.deleted_at is null
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- The authoritative email: the participant's own LIVE owner/manager member
  -- row joined to auth.users — the account_member tier of
  -- _comm_resolve_context_party, pinned to one user id instead of matched by
  -- address. 'agent'/'viewer' members deliberately resolve nothing: the cast
  -- vocabulary reserves landlord_user for the humans the CC arm copies.
  select nullif(lower(btrim(u.email)), '')
    into v_authoritative
    from public.account_members m
    join auth.users u on u.id = m.user_id
   where m.account_id = p_account_id
     and m.user_id    = p_user_id
     and m.deleted_at is null
     and m.role in ('owner', 'manager')
   limit 1;

  to_address := coalesce(v_authoritative, p_fallback_address);

  if to_address is null then
    -- No authoritative email and no fallback: the API answers with its
    -- existing "no destination address" 422.
    already_delivered := false;
    return next;
    return;
  end if;

  -- CC-overlap suppression: did the landlord already physically receive the
  -- relayed mail (any cast entry — a visible Cc, or the sender itself when a
  -- bad binding would bounce the tenant's own words back)? Canonical compare
  -- so gmail dot/+tag aliases of one mailbox still count as delivered.
  select exists (
    select 1
      from public.interaction_participants ip
     where ip.account_id     = p_account_id
       and ip.interaction_id = p_source_interaction_id
       and ip.address is not null
       and public._comm_canonical_email_address(ip.address)
             = public._comm_canonical_email_address(to_address)
  ) into already_delivered;

  return next;
end;
$$;

-- Supabase default ACLs grant EXECUTE to anon/authenticated on every new
-- public function; keep authenticated (the API calls this with the caller's
-- JWT — the function self-defends) and drop the rest.
revoke execute on function public.resolve_relay_landlord_recipient(uuid, uuid, uuid, text)
  from public, anon;
grant  execute on function public.resolve_relay_landlord_recipient(uuid, uuid, uuid, text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
