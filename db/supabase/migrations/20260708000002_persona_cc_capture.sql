-- ----------------------------------------------------------------------------
-- Persona CC capture — journal-only landlord mail (persona plan, phase 4).
--
-- The Gmail-bypass problem: a landlord emails a tenant directly and CCs the
-- persona. Both humans already have the mail — core must JOURNAL it into the
-- right thread and relay NOTHING. This phase inserts the landlord arm at the
-- top of capture_persona_inbound's classification (recognizing the account's
-- own user must precede the counterparty arm — direction/attribution depends
-- on it):
--
--   sender ∈ the account's landlord_user email identities AND DMARC pass
--     → match the thread by a To/CC address bound in an active email thread
--       (the phase-3 index), else — when a To/CC address resolves to a KNOWN
--       tenant/vendor — create the thread outbound-cold (the landlord opened
--       the conversation from their own inbox), else triage.
--     → journal direction='outbound', author_type='landlord', party = the
--       counterparty (journal convention: the party slot is never the
--       author), attestation='provider_verified' (the arm is DMARC-gated, so
--       the From domain cryptographically vouches the landlord sent it; the
--       tier vouches "landlord sent this", not "tenant received it").
--     → disposition 'cc_journaled' — the transport relays nothing.
--
-- A landlord sender that fails DMARC is triaged, never landlord-attributed
-- (forged-From protection). The capacity trigger admits the landlord
-- attribution because the RPC sets comm.verified_write before the insert —
-- the same exemption complete_send uses.
--
-- The thread find-or-create block (identical needs in both arms) moves into
-- _persona_find_or_create_thread: SECURITY DEFINER but granted to NOBODY —
-- callable only from inside the owner-executed RPCs, invisible to PostgREST.
-- Signature of capture_persona_inbound is UNCHANGED (create or replace; no
-- drop, no PostgREST ambiguity).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) _persona_find_or_create_thread — the shared cold-thread helper
-- ============================================================================
-- Finds the counterparty's newest active bridged email thread (by their bound
-- address), else creates one: thread + counterparty participant + minted
-- token binding, landlord participant (p_landlord_user_id, else the account
-- owner) bound only when an email address is known for them.

create function public._persona_find_or_create_thread(
  p_account_id       uuid,
  p_cp_type          text,
  p_cp_id            uuid,
  p_cp_address       text,
  p_subject          text,
  p_reply_domain     text,
  p_landlord_user_id uuid default null,
  p_landlord_address text default null
)
returns table (thread_id uuid, cp_participant_id uuid, tenancy_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_thread_id  uuid;
  v_part_id    uuid;
  v_tenancy_id uuid;
  v_ll_id      uuid;
  v_ll_email   text;
  v_ll_part_id uuid;
begin
  select b.thread_id, b.participant_id into v_thread_id, v_part_id
    from public.thread_channel_bindings b
    join public.comm_threads t
      on t.account_id = b.account_id and t.id = b.thread_id
    join public.comm_thread_participants p
      on p.id = b.participant_id
   where b.account_id = p_account_id
     and b.channel = 'email'
     and b.active
     and b.participant_address = p_cp_address
     and t.status = 'active'
     and t.mode = 'bridged'
     and p.party_type = p_cp_type
     and p.party_id = p_cp_id
     and p.left_at is null
   order by t.updated_at desc
   limit 1;

  if v_thread_id is not null then
    select t.tenancy_id into v_tenancy_id
      from public.comm_threads t
     where t.account_id = p_account_id and t.id = v_thread_id;
    thread_id := v_thread_id; cp_participant_id := v_part_id; tenancy_id := v_tenancy_id;
    return next;
    return;
  end if;

  if p_reply_domain is null or length(p_reply_domain) < 3 then
    raise exception 'p_reply_domain is required to create a thread'
      using errcode = '22023';
  end if;

  if p_cp_type = 'tenant' then
    select tn.id into v_tenancy_id
      from public.tenancy_tenants tt
      join public.tenancies tn
        on tn.account_id = tt.account_id and tn.id = tt.tenancy_id
     where tt.account_id = p_account_id
       and tt.tenant_id = p_cp_id
       and tt.deleted_at is null
       and tn.deleted_at is null
       and tn.status in ('active', 'holdover')
     order by (tn.status = 'active') desc, tn.start_date desc
     limit 1;
  end if;

  insert into public.comm_threads (account_id, kind, mode, channel, subject, tenancy_id)
  values (
    p_account_id,
    case when p_cp_type = 'vendor' then 'vendor' else 'bridged_tenant' end,
    'bridged',
    'email',
    nullif(left(coalesce(p_subject, ''), 998), ''),
    v_tenancy_id
  )
  returning id into v_thread_id;

  insert into public.comm_thread_participants (account_id, thread_id, party_type, party_id)
  values (p_account_id, v_thread_id, p_cp_type, p_cp_id)
  returning id into v_part_id;

  insert into public.thread_channel_bindings
    (account_id, thread_id, participant_id, participant_address, reply_address)
  values (
    p_account_id, v_thread_id, v_part_id, p_cp_address,
    't-' || encode(extensions.gen_random_bytes(16), 'hex') || '@' || lower(p_reply_domain)
  );

  -- Landlord participant: the initiating landlord when known, else the owner.
  v_ll_id := p_landlord_user_id;
  if v_ll_id is null then
    select m.user_id into v_ll_id
      from public.account_members m
     where m.account_id = p_account_id
       and m.role = 'owner'
       and m.deleted_at is null
     order by m.created_at
     limit 1;
  end if;

  if v_ll_id is not null then
    insert into public.comm_thread_participants (account_id, thread_id, party_type, party_id)
    values (p_account_id, v_thread_id, 'landlord_user', v_ll_id)
    returning id into v_ll_part_id;

    v_ll_email := p_landlord_address;
    if v_ll_email is null then
      select ci.address into v_ll_email
        from public.channel_identities ci
       where ci.account_id = p_account_id
         and ci.channel = 'email'
         and ci.party_type = 'landlord_user'
         and ci.party_id = v_ll_id
       limit 1;
    end if;

    if v_ll_email is not null then
      insert into public.thread_channel_bindings
        (account_id, thread_id, participant_id, participant_address, reply_address)
      values (
        p_account_id, v_thread_id, v_ll_part_id, v_ll_email,
        't-' || encode(extensions.gen_random_bytes(16), 'hex') || '@' || lower(p_reply_domain)
      );
    end if;
  end if;

  thread_id := v_thread_id; cp_participant_id := v_part_id; tenancy_id := v_tenancy_id;
  return next;
end;
$$;

-- Granted to NOBODY: reachable only from inside the owner-executed comms
-- RPCs (the function owner bypasses EXECUTE checks), never via PostgREST.
revoke execute on function public._persona_find_or_create_thread(uuid, text, uuid, text, text, text, uuid, text) from public;
revoke execute on function public._persona_find_or_create_thread(uuid, text, uuid, text, text, text, uuid, text) from anon;
revoke execute on function public._persona_find_or_create_thread(uuid, text, uuid, text, text, text, uuid, text) from authenticated;

-- ============================================================================
-- (B) capture_persona_inbound — landlord CC arm + helper-backed cold arm
-- ============================================================================
-- Same signature as 20260708000001 (create or replace). Raw-first,
-- idempotency, and the counterparty arm's journal tail are unchanged; the
-- classification gains the landlord arm at the top and the find-or-create
-- moves to the helper.

create or replace function public.capture_persona_inbound(
  p_account_id        uuid,
  p_provider          text,
  p_provider_msg_id   text,
  p_persona_address   text,
  p_from_address      text,
  p_from_display_name text,
  p_to_addresses      text[],
  p_cc_addresses      text[],
  p_subject           text,
  p_body              text,
  p_media             jsonb,
  p_rfc822_message_id text,
  p_in_reply_to       text,
  p_references        text[],
  p_spf               text,
  p_dkim              text,
  p_dmarc             text,
  p_received_at       timestamptz,
  p_reply_domain      text
)
returns table (
  disposition    text,
  interaction_id uuid,
  thread_id      uuid,
  participant_id uuid,
  unmatched_id   uuid
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_raw         public.inbound_raw%rowtype;
  v_interaction public.interactions%rowtype;
  v_msgid       text := public._comm_normalize_msgid(p_rfc822_message_id);
  v_cp_type     text;
  v_cp_id       uuid;
  v_ll_id       uuid;
  v_cc_arm      boolean := false;
  v_cp_address  text;
  v_thread_id   uuid;
  v_tenancy_id  uuid;
  v_part_id     uuid;
  v_dup_id      uuid;
  v_disposition text;
  v_addr        text;
  r             record;
begin
  unmatched_id := null;

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

  -- Idempotent replay from the shared raw tier, account-pinned.
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

  -- Raw-first capture (same shape and collision semantics as capture_inbound).
  begin
    insert into public.inbound_raw (
      provider, provider_msg_id, payload, received_at, matched_account_id,
      rfc822_message_id
    )
    values (
      p_provider,
      p_provider_msg_id,
      jsonb_build_object(
        'persona_address', p_persona_address,
        'from_address', p_from_address,
        'from_display_name', p_from_display_name,
        'to_addresses', coalesce(to_jsonb(p_to_addresses), '[]'::jsonb),
        'cc_addresses', coalesce(to_jsonb(p_cc_addresses), '[]'::jsonb),
        'channel', 'email',
        'subject', p_subject,
        'body', p_body,
        'media', coalesce(p_media, '[]'::jsonb),
        'rfc822_message_id', v_msgid,
        'in_reply_to', public._comm_normalize_msgid(p_in_reply_to),
        'references', coalesce(
          (select jsonb_agg(public._comm_normalize_msgid(x))
             from unnest(p_references) x
            where public._comm_normalize_msgid(x) is not null),
          '[]'::jsonb),
        'auth_results', jsonb_build_object('spf', p_spf, 'dkim', p_dkim, 'dmarc', p_dmarc),
        'account_id', p_account_id
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

  -- ---------------------------------------------------------------------
  -- Classification. Landlord arm FIRST: direction/attribution depends on
  -- recognizing the account's own user before the counterparty check.
  -- ---------------------------------------------------------------------
  select ci.party_id into v_ll_id
    from public.channel_identities ci
   where ci.account_id = p_account_id
     and ci.channel = 'email'
     and ci.party_type = 'landlord_user'
     and ci.address = p_from_address;

  if v_ll_id is not null and p_dmarc = 'pass' then
    -- CC arm: match the conversation by a To/CC address bound in an active
    -- email thread; else outbound-cold-create for a KNOWN counterparty.
    v_cc_arm := true;

    select b.thread_id, b.participant_id, b.participant_address,
           p.party_type, p.party_id
      into v_thread_id, v_part_id, v_cp_address, v_cp_type, v_cp_id
      from unnest(coalesce(p_to_addresses, '{}') || coalesce(p_cc_addresses, '{}')) cand(addr)
      join public.thread_channel_bindings b
        on b.account_id = p_account_id
       and b.channel = 'email'
       and b.active
       and b.participant_address = cand.addr
      join public.comm_threads t
        on t.account_id = b.account_id and t.id = b.thread_id
      join public.comm_thread_participants p
        on p.id = b.participant_id
     where cand.addr <> p_persona_address
       and cand.addr <> p_from_address
       and t.status = 'active'
       and t.mode = 'bridged'
       and p.party_type in ('tenant', 'vendor')
       and p.left_at is null
     order by t.updated_at desc
     limit 1;

    if v_thread_id is not null then
      select t.tenancy_id into v_tenancy_id
        from public.comm_threads t
       where t.account_id = p_account_id and t.id = v_thread_id;
    else
      -- No bound thread: does any To/CC address resolve to a known party?
      for r in
        select cand.addr
          from unnest(coalesce(p_to_addresses, '{}') || coalesce(p_cc_addresses, '{}')) cand(addr)
         where cand.addr <> p_persona_address
           and cand.addr <> p_from_address
      loop
        select ci.party_type, ci.party_id into v_cp_type, v_cp_id
          from public.channel_identities ci
         where ci.account_id = p_account_id
           and ci.channel = 'email'
           and ci.party_type in ('tenant', 'vendor')
           and ci.address = r.addr;
        if v_cp_id is null then
          select t.id into v_cp_id
            from public.tenants t
           where t.account_id = p_account_id
             and t.deleted_at is null
             and exists (
               select 1 from unnest(t.emails) e
                where lower(btrim(e)) = r.addr
             )
           order by t.created_at
           limit 1;
          if v_cp_id is not null then
            v_cp_type := 'tenant';
            insert into public.channel_identities (account_id, party_type, party_id, channel, address)
            values (p_account_id, 'tenant', v_cp_id, 'email', r.addr)
            on conflict (account_id, channel, address) do nothing;
          end if;
        end if;
        if v_cp_id is not null then
          v_cp_address := r.addr;
          exit;
        end if;
      end loop;

      if v_cp_id is not null then
        select f.thread_id, f.cp_participant_id, f.tenancy_id
          into v_thread_id, v_part_id, v_tenancy_id
          from public._persona_find_or_create_thread(
            p_account_id, v_cp_type, v_cp_id, v_cp_address,
            p_subject, p_reply_domain, v_ll_id, p_from_address) f;
      end if;
    end if;

    if v_thread_id is null then
      -- The landlord CC'd us about someone core does not know: triage.
      update public.inbound_raw
         set disposition = 'triaged'
       where id = v_raw.id;
      disposition    := 'triaged';
      interaction_id := null;
      thread_id      := null;
      participant_id := null;
      return next;
      return;
    end if;
  else
    -- Counterparty arm (phase 3, helper-backed) — including a landlord
    -- address that failed DMARC (it will not match tenant identities and
    -- lands in triage: never landlord-attribute unauthenticated mail).
    select ci.party_type, ci.party_id into v_cp_type, v_cp_id
      from public.channel_identities ci
     where ci.account_id = p_account_id
       and ci.channel = 'email'
       and ci.party_type in ('tenant', 'vendor')
       and ci.address = p_from_address;

    if v_cp_id is null then
      select t.id into v_cp_id
        from public.tenants t
       where t.account_id = p_account_id
         and t.deleted_at is null
         and exists (
           select 1 from unnest(t.emails) e
            where lower(btrim(e)) = p_from_address
         )
       order by t.created_at
       limit 1;
      if v_cp_id is not null then
        v_cp_type := 'tenant';
        insert into public.channel_identities (account_id, party_type, party_id, channel, address)
        values (p_account_id, 'tenant', v_cp_id, 'email', p_from_address)
        on conflict (account_id, channel, address) do nothing;
      end if;
    end if;

    if v_cp_id is null or p_dmarc is distinct from 'pass' then
      update public.inbound_raw
         set disposition = 'triaged'
       where id = v_raw.id;
      disposition    := 'triaged';
      interaction_id := null;
      thread_id      := null;
      participant_id := null;
      return next;
      return;
    end if;

    v_cp_address := p_from_address;
    select f.thread_id, f.cp_participant_id, f.tenancy_id
      into v_thread_id, v_part_id, v_tenancy_id
      from public._persona_find_or_create_thread(
        p_account_id, v_cp_type, v_cp_id, v_cp_address,
        p_subject, p_reply_domain, null, null) f;
  end if;

  -- Same-thread duplicate (the two-door delivery), both arms.
  if v_msgid is not null then
    select i.id into v_dup_id
      from public.interactions i
     where i.account_id = p_account_id
       and i.rfc822_message_id = v_msgid
       and i.thread_id = v_thread_id
     limit 1;
    if v_dup_id is not null then
      update public.inbound_raw
         set disposition            = 'duplicate',
             matched_thread_id      = v_thread_id,
             matched_participant_id = v_part_id,
             matched_interaction_id = v_dup_id
       where id = v_raw.id;
      disposition    := 'duplicate';
      interaction_id := v_dup_id;
      thread_id      := v_thread_id;
      participant_id := v_part_id;
      return next;
      return;
    end if;
  end if;

  v_disposition := case
    when v_cc_arm then 'cc_journaled'
    when exists (
      select 1 from public.comm_opt_outs oo
       where oo.channel = 'email' and oo.address = p_from_address
    ) then 'opted_out'
    else 'matched'
  end;

  -- Journal + cast (the capture_inbound verified tail). The CC arm inverts
  -- direction/authorship; the party slot is the counterparty in BOTH arms.
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
    case when v_cc_arm then 'system:comm-persona-cc' else 'system:comm-persona' end,
    case
      when v_cc_arm then 'landlord'
      when v_cp_type = 'vendor' then 'vendor'
      else 'tenant'
    end,
    null,
    null,
    null,
    p_provider_msg_id,
    'communication',
    public._comm_journal_channel('email'),
    case when v_cc_arm then 'outbound' else 'inbound' end,
    v_cp_type,
    v_cp_id,
    null,
    p_body,
    p_received_at,
    null,
    null,
    v_thread_id,
    'provider_verified',
    v_tenancy_id,
    null, null, null,
    case when v_cp_type = 'vendor' then v_cp_id else null end,
    v_msgid
  )
  returning * into v_interaction;

  -- Cast. Sender = the authenticated From (landlord on the CC arm, the
  -- counterparty otherwise); recipient = the counterparty's real address on
  -- the CC arm, the persona (platform leg) otherwise; the persona rides as a
  -- cc row on the CC arm — the wire facts, stated honestly.
  if v_cc_arm then
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, 'sender', 'landlord_user', v_ll_id, p_from_address,
       left(coalesce(public._party_display_name(p_account_id, 'landlord_user', v_ll_id),
                     p_from_display_name), 200),
       'comms'),
      (p_account_id, v_interaction.id, 'recipient', v_cp_type, v_cp_id, v_cp_address,
       left(public._party_display_name(p_account_id, v_cp_type, v_cp_id), 200),
       'comms'),
      (p_account_id, v_interaction.id, 'cc', 'platform', null, p_persona_address, null, 'comms');
  else
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, 'sender', v_cp_type, v_cp_id, p_from_address,
       left(coalesce(public._party_display_name(p_account_id, v_cp_type, v_cp_id),
                     p_from_display_name), 200),
       'comms'),
      (p_account_id, v_interaction.id, 'recipient', 'platform', null, p_persona_address, null, 'comms');
  end if;

  -- Other visible recipients (both arms), resolved through the address book
  -- where possible; honest 'unknown' otherwise.
  for v_addr in
    select distinct x.addr
      from (
        select unnest(coalesce(p_to_addresses, '{}')) as addr
        union all
        select unnest(coalesce(p_cc_addresses, '{}'))
      ) x
     where x.addr is not null
       and length(x.addr) between 3 and 320
       and x.addr <> p_persona_address
       and x.addr <> p_from_address
       and (v_cp_address is null or x.addr <> v_cp_address or not v_cc_arm)
  loop
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    select p_account_id, v_interaction.id, 'cc',
           coalesce(ci.party_type, 'unknown'),
           ci.party_id,
           v_addr,
           left(public._party_display_name(p_account_id, ci.party_type, ci.party_id), 200),
           'comms'
      from (values (1)) one
      left join public.channel_identities ci
        on ci.account_id = p_account_id
       and ci.channel = 'email'
       and ci.address = v_addr;
  end loop;

  update public.inbound_raw
     set disposition            = v_disposition,
         matched_thread_id      = v_thread_id,
         matched_participant_id = v_part_id,
         matched_interaction_id = v_interaction.id
   where id = v_raw.id;

  disposition    := v_disposition;
  interaction_id := v_interaction.id;
  thread_id      := v_thread_id;
  participant_id := v_part_id;
  return next;
end;
$$;

revoke execute on function public.capture_persona_inbound(uuid, text, text, text, text, text, text[], text[], text, text, jsonb, text, text, text[], text, text, text, timestamptz, text) from public;
revoke execute on function public.capture_persona_inbound(uuid, text, text, text, text, text, text[], text[], text, text, jsonb, text, text, text[], text, text, text, timestamptz, text) from anon;
grant  execute on function public.capture_persona_inbound(uuid, text, text, text, text, text, text[], text[], text, text, jsonb, text, text, text[], text, text, text, timestamptz, text) to authenticated, service_role;

notify pgrst, 'reload schema';
