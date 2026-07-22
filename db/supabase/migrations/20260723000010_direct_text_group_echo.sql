-- ----------------------------------------------------------------------------
-- Direct tenant texts route into the exact-2 group thread ('matched_direct').
--
-- A tenant texting the account's platform number DIRECTLY (a 1:1 text, no
-- group participant list) previously captured as an invisible orphan: not
-- journaled, attached to nothing, surfaced nowhere (first observed live
-- 2026-07-22, "suck it 4"). Design (landlord-proposed): route such a text
-- into the existing {tenant, landlord} group thread and have the transport
-- ECHO it there as a group MMS - the landlord then replies natively in that
-- conversation and the carrier delivers straight to the tenant.
--
-- This migration is the capture half: capture_inbound's 1:1 arm, after the
-- bridged-binding lookup misses, matches the sender's address against ACTIVE
-- group-thread bindings on the same number, guarded structurally (exact-2
-- live member set {sender, landlord_user}; sender is tenant/vendor; the
-- thread's tenancy is current - threads never close today, so a former
-- tenant's stale thread must not match; exactly one qualifying thread). On a
-- match the message journals into the group thread attributed to the sender
-- (the existing matched machinery), and the NEW disposition 'matched_direct'
-- tells the transport the carrier did not fan this out - the echo leg is the
-- transport's job (see the outbox group-relay permit, same PR). Opt-out
-- still wins the disposition, so an opted-out sender's text journals but is
-- never echoed. Everything else (ambiguous sender, multi-member group,
-- ended tenancy, strangers) stays an orphan exactly as before.
--
-- The function body below is the live definition (db/current-schema.sql)
-- with three additions: the v_direct/v_direct_count declarations, the
-- direct-match block in the 1:1 arm, and the disposition CASE arm. All other
-- branches are byte-identical.
-- ----------------------------------------------------------------------------

alter table public.inbound_raw
  drop constraint inbound_raw_disposition_check;
alter table public.inbound_raw
  add constraint inbound_raw_disposition_check check (disposition = any (array[
    'matched', 'matched_direct', 'orphan', 'opted_out', 'sender_mismatch',
    'duplicate', 'cc_journaled', 'cc_relayed', 'triaged', 'journaled_unverified'
  ]));

CREATE OR REPLACE FUNCTION "public"."capture_inbound"("p_account_id" "uuid", "p_provider" "text", "p_provider_msg_id" "text", "p_to_number" "text", "p_from_address" "text", "p_channel" "text", "p_body" "text", "p_media" "jsonb", "p_received_at" timestamp with time zone, "p_cc" "text"[] DEFAULT NULL::"text"[], "p_subject" "text" DEFAULT NULL::"text", "p_rfc822_message_id" "text" DEFAULT NULL::"text", "p_in_reply_to" "text" DEFAULT NULL::"text", "p_references" "text"[] DEFAULT NULL::"text"[], "p_auth_results" "jsonb" DEFAULT NULL::"jsonb") RETURNS TABLE("disposition" "text", "interaction_id" "uuid", "thread_id" "uuid", "participant_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_raw          public.inbound_raw%rowtype;
  v_binding      record;
  v_rebound      record;
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
  -- Self-enforcing (defense in depth): the header fields are email-only. Only
  -- normalize/keep the Message-ID on an email capture so a direct PostgREST
  -- caller cannot smuggle one onto an sms/group message past the API tier.
  v_msgid        text := case when p_channel = 'email'
                              then public._comm_normalize_msgid(p_rfc822_message_id)
                              else null end;
  v_dup_id       uuid;
  v_direct       boolean := false;
  v_direct_count integer;
  r              record;
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
      provider, provider_msg_id, payload, received_at, matched_account_id,
      rfc822_message_id
    )
    values (
      p_provider,
      p_provider_msg_id,
      jsonb_build_object(
        'to_number', p_to_number, 'from_address', p_from_address,
        'channel', p_channel, 'body', p_body, 'media', coalesce(p_media, '[]'::jsonb),
        'cc', coalesce(to_jsonb(p_cc), '[]'::jsonb),
        'account_id', p_account_id,
        -- Header fields are email-only: null them on non-email channels so a
        -- direct PostgREST caller can't attach headers past the API tier.
        'subject', case when p_channel = 'email' then p_subject else null end,
        'rfc822_message_id', v_msgid,
        'in_reply_to', case when p_channel = 'email'
                            then public._comm_normalize_msgid(p_in_reply_to)
                            else null end,
        'references', case when p_channel = 'email' then coalesce(
          (select jsonb_agg(public._comm_normalize_msgid(x))
             from unnest(p_references) x
            where public._comm_normalize_msgid(x) is not null),
          '[]'::jsonb) else '[]'::jsonb end,
        'auth_results', case when p_channel = 'email'
                             then coalesce(p_auth_results, 'null'::jsonb)
                             else 'null'::jsonb end
      ),
      p_received_at,
      p_account_id,
      v_msgid
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
      -- Cross-participant re-attribution (landlord CC arm — see the section
      -- header): the sender may be ANOTHER participant of this same thread
      -- replying to a copy addressed to someone else's token. Verify the
      -- sender address against the thread's other ACTIVE email bindings whose
      -- participant is still present; on a hit, the message is THAT
      -- participant's — re-attribute and proceed as matched.
      select b.thread_id as b_thread_id, b.participant_id as b_participant_id,
             b.participant_address as b_participant_address
        into v_rebound
        from public.thread_channel_bindings b
        join public.comm_thread_participants p
          on p.id = b.participant_id
         and p.left_at is null
       where b.account_id = p_account_id
         and b.thread_id = v_binding.b_thread_id
         and b.channel = 'email'
         and b.active
         and b.participant_address = lower(btrim(p_from_address))
       limit 1;
      if found then
        v_binding  := v_rebound;
        v_mismatch := false;
      end if;
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

    -- Direct text from a known group member (20260723000010): no bridged
    -- thread, but the sender's address is actively bound on a GROUP thread on
    -- this very number -> route the message INTO that thread and answer
    -- 'matched_direct' so the transport sends the echo (the carrier did NOT
    -- fan a 1:1 text out; without the echo the landlord never sees it).
    -- Guards, all structural:
    --   * the thread's LIVE member set is exactly {sender, one landlord_user}
    --     - a private text from one roommate must never surface in a
    --     multi-tenant group;
    --   * the sender is a tenant/vendor (the landlord texting their own
    --     platform number is not this flow);
    --   * the thread's tenancy is CURRENT (upcoming/active/holdover — a
    --     signed pre-move-in tenant is exactly who receives the move-in
    --     link): comm threads are
    --     never closed today, so without this a FORMER tenant's text would
    --     route into their stale thread;
    --   * exactly ONE qualifying thread, else refuse (ambiguity never
    --     guesses; the message stays an orphan).
    if not v_matched then
      select count(distinct t.id) into v_direct_count
        from public.thread_channel_bindings b
        join public.comm_threads t
          on t.id = b.thread_id
        join public.comm_thread_participants sp
          on sp.id = b.participant_id
        join public.tenancies ten
          on ten.id = t.tenancy_id
         and ten.account_id = t.account_id
       where b.account_id = p_account_id
         and b.platform_number = p_to_number
         and b.participant_address = p_from_address
         and b.active
         and b.thread_mode = 'group'
         and t.status = 'active'
         and sp.party_type in ('tenant', 'vendor')
         and sp.left_at is null
         and ten.deleted_at is null
         and ten.status in ('upcoming', 'active', 'holdover')
         and (select count(*) from public.comm_thread_participants pp
               where pp.thread_id = t.id and pp.left_at is null) = 2
         and exists (select 1 from public.comm_thread_participants pl
                      where pl.thread_id = t.id
                        and pl.party_type = 'landlord_user'
                        and pl.left_at is null);
      if v_direct_count = 1 then
        select b.thread_id as b_thread_id, b.participant_id as b_participant_id
          into v_binding
          from public.thread_channel_bindings b
          join public.comm_threads t
            on t.id = b.thread_id
          join public.comm_thread_participants sp
            on sp.id = b.participant_id
          join public.tenancies ten
            on ten.id = t.tenancy_id
           and ten.account_id = t.account_id
         where b.account_id = p_account_id
           and b.platform_number = p_to_number
           and b.participant_address = p_from_address
           and b.active
           and b.thread_mode = 'group'
           and t.status = 'active'
           and sp.party_type in ('tenant', 'vendor')
           and sp.left_at is null
           and ten.deleted_at is null
           and ten.status in ('upcoming', 'active', 'holdover')
           and (select count(*) from public.comm_thread_participants pp
                 where pp.thread_id = t.id and pp.left_at is null) = 2
           and exists (select 1 from public.comm_thread_participants pl
                        where pl.thread_id = t.id
                          and pl.party_type = 'landlord_user'
                          and pl.left_at is null);
        if found then
          v_matched := true;
          v_direct  := true;
        end if;
      end if;
    end if;
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

  -- Same-thread duplicate: this email (by its own Message-ID, not the
  -- provider receipt id) already journaled into the thread this binding
  -- routes to — the "two-door" delivery (token + persona/CC copies of one
  -- send). Cache the ORIGINAL ids on the raw row so replays answer
  -- identically; write nothing else.
  --
  -- Gated on a VERIFIED sender (not v_mismatch): a mismatched sender must
  -- ALWAYS journal as sender_mismatch, even when citing an already-journaled
  -- Message-ID — otherwise an attacker replying from a wrong address with a
  -- known thread Message-ID gets 'duplicate' and the durable sender_mismatch
  -- row the unresolved-sender queue depends on is never written. Evidence
  -- beats dedupe.
  if v_msgid is not null and not v_mismatch then
    select i.id into v_dup_id
      from public.interactions i
     where i.account_id = p_account_id
       and i.rfc822_message_id = v_msgid
       and i.thread_id = v_binding.b_thread_id
     limit 1;
    if v_dup_id is not null then
      update public.inbound_raw
         set disposition            = 'duplicate',
             matched_account_id     = p_account_id,
             matched_thread_id      = v_binding.b_thread_id,
             matched_participant_id = v_binding.b_participant_id,
             matched_interaction_id = v_dup_id
       where id = v_raw.id;
      disposition    := 'duplicate';
      interaction_id := v_dup_id;
      thread_id      := v_binding.b_thread_id;
      participant_id := v_binding.b_participant_id;
      return next;
      return;
    end if;
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
    -- Headline label for legacy-vocab 'other' rows (landlord_user/agent
    -- participants): the person's display name, not their role string.
    v_party_label := case
      when v_party_type = 'other' then
        coalesce(
          public._party_display_name(p_account_id, v_participant.party_type, v_participant.party_id),
          v_participant.party_type)
      else null
    end;
  end if;

  v_disposition := case
    when v_mismatch then 'sender_mismatch'
    when exists (
      select 1 from public.comm_opt_outs oo
       where oo.channel = p_channel and oo.address = p_from_address
    ) then 'opted_out'
    when v_direct then 'matched_direct'
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
    corrects_id, correction_kind, thread_id, attestation,
    tenancy_id, maintenance_request_id, area_id, work_order_id, vendor_id,
    rfc822_message_id
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
    -- This IS the verified path: the provider confirmed this delivery and
    -- the raw body is archived (EV-B). The GUC above satisfies the gate.
    'provider_verified',
    null, null, null, null,
    case when v_party_type = 'vendor' then v_party_id else null end,
    v_msgid
  )
  returning * into v_interaction;

  -- The cast: who was on THIS delivery, frozen. Wire fact (address), our
  -- resolution (party_id) and the name snapshot (label) live side by side.
  if v_mismatch then
    -- Identity doubt stated honestly: the address is fact, the person is not.
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, 'sender', 'unknown', null,
       p_from_address, null, 'comms');
  else
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, 'sender', v_participant.party_type,
       v_participant.party_id, p_from_address,
       left(public._party_display_name(p_account_id, v_participant.party_type, v_participant.party_id), 200),
       'comms');
  end if;

  -- The receiving platform address (our number / the minted reply token).
  insert into public.interaction_participants
    (account_id, interaction_id, role, party_type, party_id, address, label, source)
  values
    (p_account_id, v_interaction.id, 'recipient', 'platform', null,
     p_to_number, null, 'comms');

  -- Group MMS co-recipients, resolved through this thread's bindings.
  if p_channel <> 'email' and p_cc is not null then
    for r in
      select distinct cc.addr,
             p.party_type as p_party_type,
             p.party_id   as p_party_id
        from unnest(p_cc) cc(addr)
        left join public.thread_channel_bindings b
          on b.account_id = p_account_id
         and b.thread_id = v_binding.b_thread_id
         and b.participant_address = cc.addr
         and b.active
        left join public.comm_thread_participants p
          on p.id = b.participant_id
       where cc.addr is not null
         and length(cc.addr) between 3 and 320
         and cc.addr <> p_to_number
    loop
      insert into public.interaction_participants
        (account_id, interaction_id, role, party_type, party_id, address, label, source)
      values
        (p_account_id, v_interaction.id, 'cc',
         coalesce(r.p_party_type, 'unknown'),
         r.p_party_id,
         r.addr,
         left(public._party_display_name(p_account_id, r.p_party_type, r.p_party_id), 200),
         'comms');
    end loop;
  end if;

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


-- ----------------------------------------------------------------------------
-- Outbox trigger backstop: narrow the group-relay ban to permit the echo
-- shape (same guard as the API tier — exact-2 member set + counterparty
-- attribution) so a direct-PostgREST writer cannot bypass the API's rule,
-- and the API cannot drift looser than the DB.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."_enforce_comm_outbox_capacity"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_thread_mode text;
begin
  -- Every intent is born 'queued' (outbox-first invariant). Applies to all
  -- inserters; the API never sets status on create, so this only bites a
  -- direct-PostgREST writer trying to birth a row mid-lifecycle.
  if new.status is distinct from 'queued' then
    raise exception 'a comm_outbox intent must be created with status=queued'
      using errcode = 'check_violation';
  end if;

  -- system:<flow> provenance is reserved for core's server tier. Any caller
  -- holding a JWT (auth.uid() set) is a member or agent reaching PostgREST /
  -- the API — never the core server, which writes with the service key.
  -- The comm_outbox_system_pairing CHECK already ties the ref to
  -- author_type='system'; this closes the WHO.
  if (new.approval_ref like 'system:%' or new.author_type = 'system')
     and auth.uid() is not null then
    raise exception 'system provenance is reserved for core-originated sends'
      using errcode = 'check_violation';
  end if;

  -- Group/1:1 shape vs the thread's mode (all inserters). A missing thread is
  -- left to the composite FK to reject.
  if new.thread_id is not null then
    select t.mode into v_thread_mode
      from public.comm_threads t
     where t.id = new.thread_id;
    if v_thread_mode = 'group' then
      if new.group_addresses is null then
        raise exception 'a send into a group thread must be a group send (group_addresses, no to_address)'
          using errcode = 'check_violation';
      end if;
      if new.participant_id is not null then
        raise exception 'group sends address the whole thread: no participant leg'
          using errcode = 'check_violation';
      end if;
      if new.relay_of_interaction_id is not null then
        -- Echo relay (20260723000010, matched_direct): the ONE permitted
        -- group relay shape. Mirrors the API-tier guard structurally so a
        -- direct-PostgREST writer cannot widen it: the thread's LIVE member
        -- set is exactly {one landlord_user, one tenant/vendor} and the
        -- relayed interaction is attributed to that sole counterparty — a
        -- private text must never be broadcast past its own sender.
        if not exists (
          select 1
            from public.comm_thread_participants cp
            join public.interactions i
              on i.account_id = new.account_id
             and i.id = new.relay_of_interaction_id
             and i.thread_id = new.thread_id
             and i.party_type = cp.party_type
             and i.party_id = cp.party_id
           where cp.thread_id = new.thread_id
             and cp.left_at is null
             and cp.party_type in ('tenant', 'vendor')
             and (select count(*) from public.comm_thread_participants pp
                   where pp.thread_id = new.thread_id and pp.left_at is null) = 2
             and exists (select 1 from public.comm_thread_participants pl
                          where pl.thread_id = new.thread_id
                            and pl.party_type = 'landlord_user'
                            and pl.left_at is null)
        ) then
          raise exception 'a group relay is only permitted into a two-member thread (sender + landlord), referencing the counterparty''s interaction'
            using errcode = 'check_violation';
        end if;
      end if;
    elsif new.group_addresses is not null then
      raise exception 'group_addresses requires a group-mode thread'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Admin/service path (no JWT): unconstrained beyond the shape rules above.
  if auth.uid() is null then
    return new;
  end if;

  -- Only constrain agent-role members. Human members are trusted to author
  -- landlord communications (they can write the journal directly too); the
  -- agent is the principal the evidence-honesty shadow defends against.
  -- Mirrors _enforce_agent_capacity's principal test exactly.
  if not exists (
    select 1
      from public.account_members m
     where m.user_id     = auth.uid()
       and m.account_id   = new.account_id
       and m.role         = 'agent'
       and m.deleted_at   is null
  ) then
    return new;
  end if;

  -- An agent may only create AGENT-authored intents. Without this, an agent
  -- could forge a landlord-authored outbox row and launder it into the
  -- journal via complete_send (which trusts outbox.author_type and is exempt
  -- from _enforce_agent_capacity).
  if new.author_type is distinct from 'agent' then
    raise exception 'agent principal must create outbox intents with author_type=agent'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
