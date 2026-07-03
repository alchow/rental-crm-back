-- ----------------------------------------------------------------------------
-- Comms ledger — evidence hardening, part 1: audience stamping (work item EV-A).
--
-- An inbound journal row records who spoke but not who the message was
-- addressed to; the only per-delivery recipient record (inbound_raw.payload)
-- is pruned after its dedupe horizon. For group MMS the recipient set is
-- still *provable* via the frozen group_routing_key, but only by a
-- multi-table reconstruction. This migration makes every communication
-- journal row self-contained:
--
--   interactions.audience   jsonb, written ONLY by the comms completion /
--                           capture paths, frozen once written (the
--                           logged_at BEFORE-UPDATE guard gains it):
--                             inbound:  {"to": <receiving address>,
--                                        "cc": [<other recipients>]}
--                             outbound: {"to": [<dialed address(es)>]}
--                           The value is the transport's claim, copied at
--                           capture time onto the never-pruned journal — the
--                           carrier-verifiable original is part 2 (EV-B,
--                           inbound_provenance).
--
-- capture_inbound and complete_send are re-created with the stamp; both
-- bodies are otherwise byte-identical to 20260703000002 / 20260702000001.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) interactions.audience — additive, frozen once written
-- ============================================================================

alter table public.interactions
  add column audience jsonb
    check (audience is null or jsonb_typeof(audience) = 'object');

-- The logged_at immutability guard (20260604000002) gains audience: the
-- addressed set of a recorded communication is identity, not state. Any
-- change — including a later backfill of a null — is refused at the source
-- (the audit spine would catch it after the fact; litigable values are
-- refused up front, same rationale as logged_at).
create or replace function public._reject_logged_at_change()
returns trigger
language plpgsql
as $$
begin
  if NEW.logged_at is distinct from OLD.logged_at then
    raise exception 'interactions.logged_at is immutable (attempted % -> %)',
      OLD.logged_at, NEW.logged_at
      using errcode = 'check_violation';
  end if;
  if NEW.audience is distinct from OLD.audience then
    raise exception 'interactions.audience is immutable'
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

-- ============================================================================
-- (B) capture_inbound: stamp the delivery's addressed set on the journal row
-- ============================================================================
-- Body identical to 20260703000002 except the interactions insert gains
-- `audience` = the (to, cc) of THIS delivery as reported by the transport.

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
    corrects_id, correction_kind, thread_id, audience,
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
    -- The addressed set of THIS delivery, self-contained on the row: the
    -- address it arrived on plus the other recipients the provider reported.
    jsonb_build_object(
      'to', p_to_number,
      'cc', coalesce(to_jsonb(p_cc), '[]'::jsonb)
    ),
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

-- ============================================================================
-- (C) complete_send: stamp the dialed set on the outbound journal row
-- ============================================================================
-- Body identical to 20260702000001 except the interactions insert gains
-- `audience` = the frozen recipient set the intent dialed (group: the whole
-- set; 1:1: a one-element array — uniform shape for readers).

create or replace function public.complete_send(
  p_outbox_id    uuid,
  p_provider     text,
  p_provider_sid text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox      public.comm_outbox%rowtype;
  v_interaction public.interactions%rowtype;
  v_party_type  text;
  v_party_id    uuid;
  v_party_label text;
  v_author_type text;
begin
  select * into v_outbox
    from public.comm_outbox
   where id = p_outbox_id
  for update;

  if not found then
    raise exception 'outbox row not found' using errcode = 'P0002';
  end if;

  -- Self-defense (DEFINER bypasses RLS): live membership in the row's account.
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = v_outbox.account_id
       and m.deleted_at is null
  ) then
    raise exception 'outbox row not found' using errcode = 'P0002';
  end if;

  -- Idempotent replay: same sid, already completed -> return the journal id
  -- (the linked interaction, which for a relay leg IS the original).
  if v_outbox.status in ('sent', 'delivered') and v_outbox.provider_sid = p_provider_sid then
    return v_outbox.interaction_id;
  end if;

  if v_outbox.status not in ('queued', 'sending', 'needs_reconcile') then
    raise exception 'outbox row is not completable (status=%)', v_outbox.status
      using errcode = 'P0003';
  end if;

  -- Relay leg: link to the original interaction, do NOT mint a copy.
  if v_outbox.relay_of_interaction_id is not null then
    update public.comm_outbox
       set status         = 'sent',
           provider       = p_provider,
           provider_sid   = p_provider_sid,
           interaction_id = v_outbox.relay_of_interaction_id,
           updated_at     = now()
     where id = p_outbox_id;
    return v_outbox.relay_of_interaction_id;
  end if;

  -- Party attribution. A group send has no single counterparty: record the
  -- 'unspecified' sentinel with the frozen recipient set as the label. 1:1
  -- rows keep the existing best-source-first chain: the bound thread
  -- participant, else the account's channel identity for the dialed address,
  -- else 'unspecified' with the address as the label.
  if v_outbox.group_addresses is not null then
    v_party_type  := 'unspecified';
    v_party_id    := null;
    v_party_label := array_to_string(v_outbox.group_addresses, ', ');
  else
    if v_outbox.participant_id is not null then
      select case p.party_type
               when 'tenant' then 'tenant'
               when 'vendor' then 'vendor'
               else 'other'
             end,
             p.party_id
        into v_party_type, v_party_id
        from public.comm_thread_participants p
       where p.id = v_outbox.participant_id;
    end if;
    if v_party_type is null then
      select case ci.party_type
               when 'tenant' then 'tenant'
               when 'vendor' then 'vendor'
               else 'other'
             end,
             ci.party_id
        into v_party_type, v_party_id
        from public.channel_identities ci
       where ci.account_id = v_outbox.account_id
         and ci.channel   = v_outbox.channel
         and ci.address   = v_outbox.to_address;
    end if;
    if v_party_type is null then
      v_party_type  := 'unspecified';
      v_party_id    := null;
      v_party_label := v_outbox.to_address;
    end if;
  end if;

  v_author_type := v_outbox.author_type;

  -- The capacity trigger would (rightly) reject e.g. the agent transport
  -- writing author_type='landlord'; this is the verified completion path,
  -- so exempt this transaction AFTER the checks above.
  perform set_config('comm.verified_write', 'on', true);

  insert into public.interactions (
    account_id, actor, author_type, approved_by, approval_ref,
    entry_type, external_ref, kind, channel, direction,
    party_type, party_id, party_label, body, occurred_at,
    corrects_id, correction_kind, thread_id, audience,
    tenancy_id, maintenance_request_id, area_id, work_order_id, vendor_id
  ) values (
    v_outbox.account_id,
    'user:' || auth.uid(),
    v_author_type,
    v_outbox.approved_by,
    v_outbox.approval_ref,
    null,
    p_provider_sid,
    'communication',
    public._comm_journal_channel(v_outbox.channel),
    'outbound',
    v_party_type,
    v_party_id,
    v_party_label,
    v_outbox.body,
    now(),
    null,
    null,
    v_outbox.thread_id,
    -- The dialed set, frozen at intent time, now self-contained on the row.
    jsonb_build_object(
      'to', case
        when v_outbox.group_addresses is not null then to_jsonb(v_outbox.group_addresses)
        else jsonb_build_array(v_outbox.to_address)
      end
    ),
    -- carry the outbox's context onto the journal so the send shows up in
    -- the tenancy / maintenance-request activity feed.
    v_outbox.tenancy_id,
    v_outbox.maintenance_request_id,
    null,
    null,
    case when v_party_type = 'vendor' then v_party_id else null end
  )
  returning * into v_interaction;

  update public.comm_outbox
     set status         = 'sent',
         provider       = p_provider,
         provider_sid   = p_provider_sid,
         interaction_id = v_interaction.id,
         updated_at     = now()
   where id = p_outbox_id;

  return v_interaction.id;
end;
$$;

revoke execute on function public.complete_send(uuid, text, text) from public;
revoke execute on function public.complete_send(uuid, text, text) from anon;
grant  execute on function public.complete_send(uuid, text, text) to authenticated, service_role;

-- ============================================================================
-- (D) interactions_with_chain: re-create so the view picks up the new column
-- ============================================================================
-- The view's `i.*` was expanded at creation (20260701000004) and does not see
-- columns added later; definition otherwise verbatim.

drop view public.interactions_with_chain;
create view public.interactions_with_chain
  with (security_invoker = true) as
  select i.*,
         c.id as superseded_by_id,
         (c.id is null) as is_head,
         o.id          as outbox_id,
         o.status      as delivery_status,
         o.delivered_at
  from public.interactions i
  left join public.interactions c on c.corrects_id = i.id
  left join public.comm_outbox o
         on o.interaction_id = i.id
        and o.relay_of_interaction_id is null;

grant select on public.interactions_with_chain to authenticated, service_role;
