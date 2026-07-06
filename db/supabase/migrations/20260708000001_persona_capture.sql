-- ----------------------------------------------------------------------------
-- Persona inbound capture — known senders (persona plan, phase 3).
--
-- The persona address (riley@<subdomain>.<parent>, phase 1) is the account's
-- cold-inbound front door: mail arrives with NO reply token, so routing must
-- resolve the SENDER instead of the recipient. This RPC is the persona
-- counterpart of capture_inbound, sharing the same raw tier (one
-- provider_msg_id idempotency space), the same journal/cast tail, and the
-- same self-defense — but classifying by sender identity:
--
--   known tenant/vendor (channel_identities exact hit, else tenants.emails)
--     AND DMARC pass  → find their active email thread by bound address, or
--                       CREATE one atomically (participants + minted token
--                       bindings), then journal → disposition 'matched'
--                       (the transport relays it like any thread inbound).
--   anything else     → raw-tier only → disposition 'triaged' (phase 6 adds
--                       the visible triage store; until then the response +
--                       raw row are the record).
--
-- DMARC gates attribution: without provider-verified alignment, a forged
-- From could inject a 'provider_verified' row into a real tenant's thread —
-- the persona analog of the token path's sender_mismatch. A claimed-known
-- sender that fails DMARC is triaged, never journaled as that person.
-- (The landlord CC arm lands in phase 4; a landlord-addressed capture falls
-- through to 'triaged' until then.)
--
-- Token minting in SQL: the cold arm creates threads inside the RPC (atomic —
-- no half-created skeleton, unlike the API-layer createThread which is a
-- manager-only path with a multi-statement cleanup window). Minting needs
-- pgcrypto's gen_random_bytes, which lives in schema `extensions` on real
-- Supabase (20260605000004) — hence `search_path = public, extensions`.
-- ----------------------------------------------------------------------------

-- The sender/counterparty address lookup: cold-arm thread resume ("which
-- active email thread already binds this address?") and the phase-4 CC match.
-- Addresses are stored trim+lowercased at write, so plain columns suffice.
create index thread_channel_bindings_email_participant_idx
  on public.thread_channel_bindings (account_id, participant_address)
  where channel = 'email' and active;

create function public.capture_persona_inbound(
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
  v_thread_id   uuid;
  v_tenancy_id  uuid;
  v_part_id     uuid;
  v_owner_id    uuid;
  v_ll_email    text;
  v_ll_part_id  uuid;
  v_dup_id      uuid;
  v_disposition text;
  v_addr        text;
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
  -- Sender classification. (Phase 4 inserts the landlord CC arm HERE, ahead
  -- of the counterparty arm — recognizing the account's own user must come
  -- first for direction/attribution to be right.)
  -- ---------------------------------------------------------------------
  select ci.party_type, ci.party_id into v_cp_type, v_cp_id
    from public.channel_identities ci
   where ci.account_id = p_account_id
     and ci.channel = 'email'
     and ci.party_type in ('tenant', 'vendor')
     and ci.address = p_from_address;

  if v_cp_id is null then
    -- Contact-book fallback: tenants.emails (stored free-form; compare
    -- normalized). On a hit, learn the address into channel_identities so
    -- the next capture takes the indexed exact path.
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

  -- Unknown sender, or a known sender the provider could not authenticate:
  -- raw-tier + 'triaged'. Never attribute unauthenticated mail.
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

  -- ---------------------------------------------------------------------
  -- Known-sender arm: find the counterparty's active email thread, else
  -- create one atomically.
  -- ---------------------------------------------------------------------
  select b.thread_id, b.participant_id into v_thread_id, v_part_id
    from public.thread_channel_bindings b
    join public.comm_threads t
      on t.account_id = b.account_id and t.id = b.thread_id
    join public.comm_thread_participants p
      on p.id = b.participant_id
   where b.account_id = p_account_id
     and b.channel = 'email'
     and b.active
     and b.participant_address = p_from_address
     and t.status = 'active'
     and t.mode = 'bridged'
     and p.party_type = v_cp_type
     and p.party_id = v_cp_id
     and p.left_at is null
   order by t.updated_at desc
   limit 1;

  if v_thread_id is not null then
    select t.tenancy_id into v_tenancy_id
      from public.comm_threads t
     where t.account_id = p_account_id and t.id = v_thread_id;
  else
    -- CREATE. Minting needs a receiving domain; the endpoint derives it from
    -- the account's branding, which a persona account has by construction.
    if p_reply_domain is null or length(p_reply_domain) < 3 then
      raise exception 'p_reply_domain is required to create a thread'
        using errcode = '22023';
    end if;

    -- Context: the tenant's most recent live tenancy (vendors have none).
    if v_cp_type = 'tenant' then
      select tn.id into v_tenancy_id
        from public.tenancy_tenants tt
        join public.tenancies tn
          on tn.account_id = tt.account_id and tn.id = tt.tenancy_id
       where tt.account_id = p_account_id
         and tt.tenant_id = v_cp_id
         and tt.deleted_at is null
         and tn.deleted_at is null
         and tn.status in ('active', 'holdover')
       order by (tn.status = 'active') desc, tn.start_date desc
       limit 1;
    end if;

    insert into public.comm_threads (account_id, kind, mode, channel, subject, tenancy_id)
    values (
      p_account_id,
      case when v_cp_type = 'vendor' then 'vendor' else 'bridged_tenant' end,
      'bridged',
      'email',
      nullif(left(coalesce(p_subject, ''), 998), ''),
      v_tenancy_id
    )
    returning id into v_thread_id;

    insert into public.comm_thread_participants (account_id, thread_id, party_type, party_id)
    values (p_account_id, v_thread_id, v_cp_type, v_cp_id)
    returning id into v_part_id;

    -- The counterparty's minted token: their FUTURE replies ride the token
    -- path (capture_inbound, sender-verified), not the shared persona.
    insert into public.thread_channel_bindings
      (account_id, thread_id, participant_id, participant_address, reply_address)
    values (
      p_account_id, v_thread_id, v_part_id, p_from_address,
      't-' || encode(extensions.gen_random_bytes(16), 'hex') || '@' || lower(p_reply_domain)
    );

    -- Landlord participant: the account owner. Bound (own token) only when
    -- an email identity is on file — without one the landlord still reads
    -- and replies in-app (createThreadMessage targets counterparty bindings
    -- only), they just have no native-inbox leg yet.
    select m.user_id into v_owner_id
      from public.account_members m
     where m.account_id = p_account_id
       and m.role = 'owner'
       and m.deleted_at is null
     order by m.created_at
     limit 1;

    if v_owner_id is not null then
      insert into public.comm_thread_participants (account_id, thread_id, party_type, party_id)
      values (p_account_id, v_thread_id, 'landlord_user', v_owner_id)
      returning id into v_ll_part_id;

      select ci.address into v_ll_email
        from public.channel_identities ci
       where ci.account_id = p_account_id
         and ci.channel = 'email'
         and ci.party_type = 'landlord_user'
         and ci.party_id = v_owner_id
       limit 1;

      if v_ll_email is not null then
        insert into public.thread_channel_bindings
          (account_id, thread_id, participant_id, participant_address, reply_address)
        values (
          p_account_id, v_thread_id, v_ll_part_id, v_ll_email,
          't-' || encode(extensions.gen_random_bytes(16), 'hex') || '@' || lower(p_reply_domain)
        );
      end if;
    end if;
  end if;

  -- Same-thread duplicate (the two-door delivery): this email's own
  -- Message-ID already journaled here — typically the token door landed
  -- first. Cache the ORIGINAL ids; write nothing else.
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
    when exists (
      select 1 from public.comm_opt_outs oo
       where oo.channel = 'email' and oo.address = p_from_address
    ) then 'opted_out'
    else 'matched'
  end;

  -- Journal + cast (the capture_inbound verified tail).
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
    'system:comm-persona',
    case when v_cp_type = 'vendor' then 'vendor' else 'tenant' end,
    null,
    null,
    null,
    p_provider_msg_id,
    'communication',
    public._comm_journal_channel('email'),
    'inbound',
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

  -- Cast: verified sender, the persona as the receiving platform leg, and
  -- the other visible recipients (resolved through the account's address
  -- book where possible; honest 'unknown' otherwise).
  insert into public.interaction_participants
    (account_id, interaction_id, role, party_type, party_id, address, label, source)
  values
    (p_account_id, v_interaction.id, 'sender', v_cp_type, v_cp_id, p_from_address,
     left(coalesce(public._party_display_name(p_account_id, v_cp_type, v_cp_id),
                   p_from_display_name), 200),
     'comms');

  insert into public.interaction_participants
    (account_id, interaction_id, role, party_type, party_id, address, label, source)
  values
    (p_account_id, v_interaction.id, 'recipient', 'platform', null,
     p_persona_address, null, 'comms');

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
