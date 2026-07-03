-- ----------------------------------------------------------------------------
-- Comms ledger — email inbound + email threads (work item E2-A, core side).
--
-- Email needs no shared-number disambiguation: every (thread, participant)
-- gets a UNIQUE tokenized reply address (`t-<token>@<receiving-domain>`,
-- minted by the API at thread creation; the receiving domain is global env
-- config). Both the tenant AND the landlord reply natively from their own
-- inboxes; inbound routing is by the token — never by content, never by the
-- sender address. The sender address is a VERIFICATION input, not a routing
-- key (see sender_mismatch below).
--
--   comm_threads.channel    'sms' (default) | 'email' | 'voice' — stored at
--                           creation, frozen. The thread's legs (landlord
--                           in-app messages, relay legs) dial on it. Group
--                           mode stays sms-only (CHECK; group email is a
--                           future slice).
--   comm_threads.subject    optional subject SEED for email threads (CHECK
--                           email-only, frozen). "Re: " continuation and the
--                           actual header rendering are the transport's
--                           concern; the seed is what it continues from.
--   thread_channel_bindings.channel / .reply_address
--                           channel is stamped from the thread (same trigger
--                           as thread_mode — never trusted from the writer).
--                           Shape: sms bindings carry platform_number (as
--                           today, now nullable at the column level); email
--                           bindings carry reply_address instead — the full
--                           minted token address, frozen, partial-UNIQUE among
--                           active rows (THE email routing key). Email rows
--                           have platform_number NULL, so the sms routing
--                           invariant (platform_number, participant_address)
--                           WHERE active AND thread_mode='bridged' never sees
--                           them (unique indexes treat NULLs as distinct) —
--                           one person can hold sms threads and any number of
--                           email threads simultaneously.
--   capture_inbound (email) p_channel='email': p_to_number carries the
--                           tokenized reply address (handler lowercases both
--                           addresses). Token resolves (thread, participant)
--                           directly, account-pinned. No token match ->
--                           orphan, exactly like sms. cc has NO email
--                           semantics in v1 and is ignored for routing.
--   disposition 'sender_mismatch'
--                           the token resolved, but the sender address is not
--                           the bound participant's. The contact HAPPENED at
--                           that thread's unique address, so it is journaled
--                           into the thread — but attributed honestly:
--                           party_type='unspecified', party_label = the
--                           actual sender address (identity unresolved);
--                           author_type stays the bound slot's capacity (the
--                           message entered that participant's channel).
--                           The transport decides relay policy on this
--                           disposition (it must NOT auto-relay as if
--                           verified). Mismatch is reported regardless of
--                           opt-out state.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) comm_threads: channel + subject seed
-- ============================================================================

alter table public.comm_threads
  add column channel text not null default 'sms'
    check (channel in ('sms', 'email', 'voice')),
  add column subject text
    check (length(subject) between 1 and 998);

alter table public.comm_threads
  add constraint comm_threads_subject_email_only
  check (subject is null or channel = 'email'),
  add constraint comm_threads_group_sms_only
  check (mode <> 'group' or channel = 'sms');

-- channel and the subject seed join mode/group_routing_key as frozen identity.
create or replace function public._comm_threads_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.mode is distinct from old.mode
     or new.group_routing_key is distinct from old.group_routing_key
     or new.channel is distinct from old.channel
     or new.subject is distinct from old.subject then
    raise exception 'comm_threads.mode, group_routing_key, channel and subject are immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ============================================================================
-- (B) thread_channel_bindings: channel + tokenized reply address
-- ============================================================================

alter table public.thread_channel_bindings
  alter column platform_number drop not null,
  add column channel text not null default 'sms'
    check (channel in ('sms', 'email')),
  add column reply_address text
    check (length(reply_address) between 5 and 320);

-- Exactly one routing shape per binding: sms rides a platform number, email
-- rides its minted reply token.
alter table public.thread_channel_bindings
  add constraint thread_channel_bindings_sms_shape
  check ((channel = 'sms') = (platform_number is not null)),
  add constraint thread_channel_bindings_email_shape
  check ((channel = 'email') = (reply_address is not null));

-- THE email routing key: an active reply token resolves to exactly one
-- (thread, participant). Tokens are 128-bit random, minted server-side.
create unique index thread_channel_bindings_reply_uniq
  on public.thread_channel_bindings (reply_address)
  where active;

-- Stamp trigger extended: channel joins thread_mode as thread-derived,
-- never trusted from the writer, frozen on update. (reply_address itself is
-- API-minted; the shape CHECKs above pin it to email rows, and freezing it
-- keeps a handed-out token honest.)
create or replace function public._thread_binding_stamp_mode()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode    text;
  v_channel text;
begin
  if tg_op = 'UPDATE' then
    if new.thread_mode is distinct from old.thread_mode
       or new.channel is distinct from old.channel
       or new.reply_address is distinct from old.reply_address then
      raise exception 'thread_channel_bindings.thread_mode, channel and reply_address are immutable'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select t.mode, t.channel into v_mode, v_channel
    from public.comm_threads t
   where t.id = new.thread_id and t.account_id = new.account_id;
  new.thread_mode := coalesce(v_mode, 'bridged');
  new.channel     := coalesce(v_channel, 'sms');
  return new;
end;
$$;

-- ============================================================================
-- (C) inbound_raw: admit the new disposition
-- ============================================================================

do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.inbound_raw'::regclass
    and contype  = 'c'
    and pg_get_constraintdef(oid) ilike '%disposition%matched%';
  if c is not null then
    execute format('alter table public.inbound_raw drop constraint %I', c);
  end if;
end $$;

alter table public.inbound_raw
  add constraint inbound_raw_disposition_check
  check (disposition in ('matched', 'orphan', 'opted_out', 'sender_mismatch'));

-- ============================================================================
-- (D) capture_inbound: email token routing + sender verification
-- ============================================================================
-- Same 10-arg signature as 20260702000001; resolution now has three arms:
--   email        -> active reply-token binding (account-pinned); the sender
--                   address is then VERIFIED against the bound participant.
--   sms + cc     -> group participant-set match (unchanged).
--   sms (no cc)  -> 1:1 bridged binding (unchanged).
-- The journal tail is shared; a sender mismatch swaps the party attribution
-- to 'unspecified' + the actual sender as the label and reports the new
-- disposition. Raw capture always happens first (idempotent, account-pinned).

create or replace function public.capture_inbound(
  p_account_id      uuid,
  p_provider        text,
  p_provider_msg_id text,
  p_to_number       text,
  p_from_address    text,
  p_channel         text,
  p_body            text,
  p_media           jsonb,
  p_received_at     timestamptz,
  p_cc              text[] default null
)
returns table (
  disposition    text,
  interaction_id uuid,
  thread_id      uuid,
  participant_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw          public.inbound_raw%rowtype;
  v_binding      record;
  v_participant  public.comm_thread_participants%rowtype;
  v_interaction  public.interactions%rowtype;
  v_disposition  text;
  v_party_type   text;
  v_party_id     uuid;
  v_party_label  text;
  v_author_type  text;
  v_group_thread uuid;
  v_matched      boolean := false;
  v_mismatch     boolean := false;
begin
  -- Self-defense: transport (agent-role member of this account) only.
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = p_account_id
       and m.role = 'agent'
       and m.deleted_at is null
  ) then
    raise exception 'not authorized to capture inbound messages for this account'
      using errcode = '42501';
  end if;

  -- Idempotent replay: answered from the cached match result, PINNED to the
  -- calling account so one account can never read another's cached ids.
  select * into v_raw
    from public.inbound_raw
   where provider_msg_id = p_provider_msg_id
     and matched_account_id = p_account_id;
  if found then
    disposition    := v_raw.disposition;
    interaction_id := v_raw.matched_interaction_id;
    thread_id      := v_raw.matched_thread_id;
    participant_id := v_raw.matched_participant_id;
    return next;
    return;
  end if;

  -- Capture first. matched_account_id is stamped at birth so the replay/dedupe
  -- is account-scoped from the outset. provider_msg_id is globally UNIQUE, so
  -- a collision means the message was already captured — by this account (a
  -- race → return the committed result) or another (a misroute/probe →
  -- refuse, never leak).
  begin
    insert into public.inbound_raw (
      provider, provider_msg_id, payload, received_at, matched_account_id
    )
    values (
      p_provider,
      p_provider_msg_id,
      jsonb_build_object(
        'to_number', p_to_number, 'from_address', p_from_address,
        'channel', p_channel, 'body', p_body, 'media', coalesce(p_media, '[]'::jsonb),
        'cc', coalesce(to_jsonb(p_cc), '[]'::jsonb),
        'account_id', p_account_id
      ),
      p_received_at,
      p_account_id
    )
    returning * into v_raw;
  exception when unique_violation then
    select * into v_raw
      from public.inbound_raw
     where provider_msg_id = p_provider_msg_id;
    if v_raw.matched_account_id is distinct from p_account_id then
      raise exception 'provider_msg_id already captured for another account'
        using errcode = 'P0003';
    end if;
    disposition    := v_raw.disposition;
    interaction_id := v_raw.matched_interaction_id;
    thread_id      := v_raw.matched_thread_id;
    participant_id := v_raw.matched_participant_id;
    return next;
    return;
  end;

  if p_channel = 'email' then
    -- Email: the to-address IS the minted reply token (handler lowercases).
    -- cc has no email semantics in v1 and is ignored for routing.
    select b.thread_id as b_thread_id, b.participant_id as b_participant_id,
           b.participant_address as b_participant_address
      into v_binding
      from public.thread_channel_bindings b
     where b.reply_address = p_to_number
       and b.channel = 'email'
       and b.active
       and b.account_id = p_account_id;
    v_matched := found;
    -- The token is the routing key; the sender address is a verification.
    -- Bound participant addresses are stored trim+lowercased at creation.
    if v_matched and lower(btrim(p_from_address)) is distinct from v_binding.b_participant_address then
      v_mismatch := true;
    end if;
  elsif p_cc is not null and array_length(p_cc, 1) > 0 then
    -- Group message: resolve by participant-set match, pinned to the calling
    -- account (a foreign account's identical set can never leak a thread).
    select t.id into v_group_thread
      from public.comm_threads t
     where t.account_id = p_account_id
       and t.mode = 'group'
       and t.status = 'active'
       and t.group_routing_key = public._comm_group_routing_key(
             p_to_number, array_append(p_cc, p_from_address));

    if v_group_thread is not null then
      select b.thread_id as b_thread_id, b.participant_id as b_participant_id
        into v_binding
        from public.thread_channel_bindings b
       where b.account_id = p_account_id
         and b.thread_id = v_group_thread
         and b.participant_address = p_from_address
         and b.active;
      v_matched := found;
    end if;
  else
    -- 1:1 sms: the active BRIDGED binding for (platform number, counterparty
    -- address), pinned to the calling account.
    select b.thread_id as b_thread_id, b.participant_id as b_participant_id
      into v_binding
      from public.thread_channel_bindings b
     where b.platform_number = p_to_number
       and b.participant_address = p_from_address
       and b.active
       and b.thread_mode = 'bridged'
       and b.account_id = p_account_id;
    v_matched := found;
  end if;

  if not v_matched then
    update public.inbound_raw
       set disposition = 'orphan'
     where id = v_raw.id;
    disposition    := 'orphan';
    interaction_id := null;
    thread_id      := null;
    participant_id := null;
    return next;
    return;
  end if;

  select * into v_participant
    from public.comm_thread_participants p
   where p.id = v_binding.b_participant_id;

  -- Capacity attribution follows the CHANNEL SLOT the message arrived on
  -- (the participant's minted token / bound address); identity attribution
  -- (the party fields) is downgraded to 'unspecified' + the actual sender
  -- when the sender address does not verify.
  v_author_type := case v_participant.party_type
    when 'tenant' then 'tenant'
    when 'vendor' then 'vendor'
    when 'landlord_user' then 'landlord'
    else 'system'
  end;
  if v_mismatch then
    v_party_type  := 'unspecified';
    v_party_id    := null;
    v_party_label := p_from_address;
  else
    v_party_type := case v_participant.party_type
      when 'tenant' then 'tenant'
      when 'vendor' then 'vendor'
      else 'other'
    end;
    v_party_id    := v_participant.party_id;
    v_party_label := case when v_party_type = 'other' then v_participant.party_type else null end;
  end if;

  v_disposition := case
    when v_mismatch then 'sender_mismatch'
    when exists (
      select 1 from public.comm_opt_outs oo
       where oo.channel = p_channel and oo.address = p_from_address
    ) then 'opted_out'
    else 'matched'
  end;

  -- Journal the contact (it happened, verified or not, opted-out or not).
  -- Mechanical writer attribution follows the intake pattern: audit.actor is
  -- only consulted when auth.uid() is null, so the chain records the true
  -- transport caller; the row's actor states the capture path.
  perform set_config('comm.verified_write', 'on', true);

  insert into public.interactions (
    account_id, actor, author_type, approved_by, approval_ref,
    entry_type, external_ref, kind, channel, direction,
    party_type, party_id, party_label, body, occurred_at,
    corrects_id, correction_kind, thread_id,
    tenancy_id, maintenance_request_id, area_id, work_order_id, vendor_id
  ) values (
    p_account_id,
    'system:comm-inbound',
    v_author_type,
    null,
    null,
    null,
    p_provider_msg_id,
    'communication',
    public._comm_journal_channel(p_channel),
    'inbound',
    v_party_type,
    v_party_id,
    v_party_label,
    p_body,
    p_received_at,
    null,
    null,
    v_binding.b_thread_id,
    null, null, null, null,
    case when v_party_type = 'vendor' then v_party_id else null end
  )
  returning * into v_interaction;

  update public.inbound_raw
     set disposition            = v_disposition,
         matched_account_id     = p_account_id,
         matched_thread_id      = v_binding.b_thread_id,
         matched_participant_id = v_binding.b_participant_id,
         matched_interaction_id = v_interaction.id
   where id = v_raw.id;

  disposition    := v_disposition;
  interaction_id := v_interaction.id;
  thread_id      := v_binding.b_thread_id;
  participant_id := v_binding.b_participant_id;
  return next;
end;
$$;

revoke execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[]) from public;
revoke execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[]) from anon;
grant  execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[]) to authenticated, service_role;
