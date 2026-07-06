-- ----------------------------------------------------------------------------
-- Unknown-sender triage (persona plan, phase 6).
--
-- Until now a 'triaged' persona capture was raw-tier only — invisible to every
-- human surface, and the raw tier is PRUNED at 90 days. This adds the visible,
-- durable triage store plus the human resolution paths:
--
--   comm_unmatched_inbound      one row per triaged capture, carrying its OWN
--                               copy of the message (subject/body/addresses/
--                               verdicts) so it outlives the raw prune.
--                               Member-readable; writes only via DEFINER RPCs.
--   link_unmatched_inbound      owner|manager: "this was tenant X" — reuses
--                               the persona find-or-create helper, journals
--                               the STORED original into the thread
--                               (provider_verified when the stored DMARC
--                               passed, else attested — the honest tier for a
--                               late human reclassification), learns the
--                               address into channel_identities so future
--                               mail auto-resolves, marks the row linked.
--   dismiss_unmatched_inbound   owner|manager: not relevant; no side effects.
--
-- capture_persona_inbound is redefined (same signature) so its triage exits
-- insert the row (reason 'auth_failed' when a KNOWN identity failed DMARC,
-- 'unknown_sender' otherwise) and return unmatched_id — including on
-- idempotent replays.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) comm_unmatched_inbound
-- ============================================================================

create table public.comm_unmatched_inbound (
  id                uuid        primary key default gen_random_uuid(),
  account_id        uuid        not null references public.accounts(id) on delete restrict,
  provider          text        not null check (length(provider) between 1 and 100),
  provider_msg_id   text        not null check (length(provider_msg_id) between 1 and 200),
  rfc822_message_id text        check (rfc822_message_id is null or length(rfc822_message_id) between 3 and 998),
  persona_address   text        not null check (length(persona_address) between 5 and 320),
  from_address      text        not null check (length(from_address) between 3 and 320),
  from_display_name text        check (from_display_name is null or length(from_display_name) <= 200),
  to_addresses      text[]      not null default '{}',
  cc_addresses      text[]      not null default '{}',
  subject           text        check (subject is null or length(subject) <= 998),
  body              text        check (body is null or length(body) <= 20000),
  media             jsonb       not null default '[]'::jsonb,
  spf               text,
  dkim              text,
  dmarc             text,
  -- Why it landed here: an address nobody recognizes, or a RECOGNIZED
  -- identity (tenant/vendor/landlord) whose mail failed DMARC — the second
  -- is the suspicious one and never attributable without a human.
  reason            text        not null default 'unknown_sender'
                                check (reason in ('unknown_sender', 'auth_failed')),
  received_at       timestamptz not null,
  status            text        not null default 'pending'
                                check (status in ('pending', 'linked', 'dismissed')),
  resolved_by       uuid,
  resolved_at       timestamptz,
  linked_thread_id      uuid,
  linked_interaction_id uuid,
  linked_party_type text        check (linked_party_type is null or linked_party_type in ('tenant', 'vendor')),
  linked_party_id   uuid,
  auto_acked_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (account_id, id),
  -- Idempotent triage: one row per receipt.
  unique (account_id, provider_msg_id),
  -- Resolution provenance is all-or-nothing.
  check ((status = 'pending') = (resolved_by is null and resolved_at is null)),
  check ((status = 'linked') = (linked_interaction_id is not null)),
  foreign key (account_id, linked_thread_id)
    references public.comm_threads(account_id, id) on delete set null,
  foreign key (account_id, linked_interaction_id)
    references public.interactions(account_id, id) on delete set null
);

-- The queue read: pending, newest first.
create index comm_unmatched_inbound_pending_idx
  on public.comm_unmatched_inbound (account_id, received_at desc)
  where status = 'pending';

alter table public.comm_unmatched_inbound enable row level security;
alter table public.comm_unmatched_inbound force  row level security;

-- Members read; nobody (client-side) writes — all writes ride the DEFINER
-- RPCs below (same posture as interaction_participants).
create policy comm_unmatched_inbound_member_read on public.comm_unmatched_inbound
  for select
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

revoke insert, update, delete, truncate
  on public.comm_unmatched_inbound
  from public, anon, authenticated;

create trigger comm_unmatched_inbound_audit
  after insert or update or delete on public.comm_unmatched_inbound
  for each row execute function public._emit_event();

-- ============================================================================
-- (B) _persona_record_unmatched — the triage writer (internal)
-- ============================================================================
-- Called from the capture RPC's triage exits. Idempotent on
-- (account_id, provider_msg_id): a re-run returns the existing row id.

create function public._persona_record_unmatched(
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
  p_spf               text,
  p_dkim              text,
  p_dmarc             text,
  p_received_at       timestamptz,
  p_reason            text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.comm_unmatched_inbound (
    account_id, provider, provider_msg_id, rfc822_message_id,
    persona_address, from_address, from_display_name,
    to_addresses, cc_addresses, subject, body, media,
    spf, dkim, dmarc, reason, received_at
  ) values (
    p_account_id, p_provider, p_provider_msg_id, p_rfc822_message_id,
    p_persona_address, p_from_address, p_from_display_name,
    coalesce(p_to_addresses, '{}'), coalesce(p_cc_addresses, '{}'),
    nullif(left(coalesce(p_subject, ''), 998), ''),
    left(p_body, 20000),
    coalesce(p_media, '[]'::jsonb),
    p_spf, p_dkim, p_dmarc, p_reason, p_received_at
  )
  on conflict (account_id, provider_msg_id) do nothing
  returning id into v_id;

  if v_id is null then
    select u.id into v_id
      from public.comm_unmatched_inbound u
     where u.account_id = p_account_id
       and u.provider_msg_id = p_provider_msg_id;
  end if;
  return v_id;
end;
$$;

revoke execute on function public._persona_record_unmatched(uuid, text, text, text, text, text, text[], text[], text, text, jsonb, text, text, text, text, timestamptz, text) from public;
revoke execute on function public._persona_record_unmatched(uuid, text, text, text, text, text, text[], text[], text, text, jsonb, text, text, text, text, timestamptz, text) from anon;
revoke execute on function public._persona_record_unmatched(uuid, text, text, text, text, text, text[], text[], text, text, jsonb, text, text, text, text, timestamptz, text) from authenticated;

-- ============================================================================
-- (C) capture_persona_inbound — triage exits now record + return unmatched_id
-- ============================================================================
-- Same signature (create or replace). Diff vs 20260708000002: the three
-- triage exits call _persona_record_unmatched (reason auth_failed when a
-- recognized identity failed DMARC), and the idempotent-replay path
-- re-resolves unmatched_id for cached 'triaged' rows.

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
  v_reason      text;
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

  -- Idempotent replay from the shared raw tier, account-pinned. Triaged
  -- replays re-resolve the triage row id (not cached on inbound_raw).
  select * into v_raw
    from public.inbound_raw
   where provider_msg_id = p_provider_msg_id
     and matched_account_id = p_account_id;
  if found then
    disposition    := v_raw.disposition;
    interaction_id := v_raw.matched_interaction_id;
    thread_id      := v_raw.matched_thread_id;
    participant_id := v_raw.matched_participant_id;
    if v_raw.disposition = 'triaged' then
      select u.id into unmatched_id
        from public.comm_unmatched_inbound u
       where u.account_id = p_account_id
         and u.provider_msg_id = p_provider_msg_id;
    end if;
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
    if v_raw.disposition = 'triaged' then
      select u.id into unmatched_id
        from public.comm_unmatched_inbound u
       where u.account_id = p_account_id
         and u.provider_msg_id = p_provider_msg_id;
    end if;
    return next;
    return;
  end;

  -- ---------------------------------------------------------------------
  -- Classification. Landlord arm FIRST (direction/attribution depends on
  -- recognizing the account's own user before the counterparty check).
  -- ---------------------------------------------------------------------
  select ci.party_id into v_ll_id
    from public.channel_identities ci
   where ci.account_id = p_account_id
     and ci.channel = 'email'
     and ci.party_type = 'landlord_user'
     and ci.address = p_from_address;

  if v_ll_id is not null and p_dmarc = 'pass' then
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
      unmatched_id := public._persona_record_unmatched(
        p_account_id, p_provider, p_provider_msg_id, p_persona_address,
        p_from_address, p_from_display_name, p_to_addresses, p_cc_addresses,
        p_subject, p_body, p_media, v_msgid, p_spf, p_dkim, p_dmarc,
        p_received_at, 'unknown_sender');
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
    -- Counterparty arm — including a recognized landlord address that failed
    -- DMARC (never landlord-attribute unauthenticated mail).
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
      -- 'auth_failed' when we DO recognize the claimed identity (tenant,
      -- vendor, or landlord) but the provider could not authenticate it.
      v_reason := case
        when (v_cp_id is not null or v_ll_id is not null) and p_dmarc is distinct from 'pass'
          then 'auth_failed'
        else 'unknown_sender'
      end;
      unmatched_id := public._persona_record_unmatched(
        p_account_id, p_provider, p_provider_msg_id, p_persona_address,
        p_from_address, p_from_display_name, p_to_addresses, p_cc_addresses,
        p_subject, p_body, p_media, v_msgid, p_spf, p_dkim, p_dmarc,
        p_received_at, v_reason);
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

  -- Journal + cast (unchanged from 20260708000002).
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

-- ============================================================================
-- (D) link / dismiss — the human resolution paths (owner|manager)
-- ============================================================================

create function public.link_unmatched_inbound(
  p_account_id   uuid,
  p_unmatched_id uuid,
  p_party_type   text,
  p_party_id     uuid,
  p_reply_domain text
)
returns table (thread_id uuid, interaction_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row         public.comm_unmatched_inbound%rowtype;
  v_role        text;
  v_thread_id   uuid;
  v_part_id     uuid;
  v_tenancy_id  uuid;
  v_interaction public.interactions%rowtype;
  v_dup_id      uuid;
  v_addr        text;
begin
  -- Self-defense: owner|manager member (the agent principal may not resolve
  -- identity doubt — same posture as classify corrections).
  select m.role into v_role
    from public.account_members m
   where m.user_id = auth.uid()
     and m.account_id = p_account_id
     and m.deleted_at is null;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_party_type not in ('tenant', 'vendor') then
    raise exception 'party_type must be tenant or vendor' using errcode = '22023';
  end if;
  if p_party_type = 'tenant' and not exists (
    select 1 from public.tenants t
     where t.account_id = p_account_id and t.id = p_party_id and t.deleted_at is null
  ) then
    raise exception 'tenant not found' using errcode = 'P0002';
  end if;
  if p_party_type = 'vendor' and not exists (
    select 1 from public.vendors v
     where v.account_id = p_account_id and v.id = p_party_id and v.deleted_at is null
  ) then
    raise exception 'vendor not found' using errcode = 'P0002';
  end if;

  select * into v_row
    from public.comm_unmatched_inbound u
   where u.account_id = p_account_id
     and u.id = p_unmatched_id
  for update;
  if not found then
    raise exception 'unmatched row not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'already resolved (%)', v_row.status using errcode = 'P0003';
  end if;

  select f.thread_id, f.cp_participant_id, f.tenancy_id
    into v_thread_id, v_part_id, v_tenancy_id
    from public._persona_find_or_create_thread(
      p_account_id, p_party_type, p_party_id, v_row.from_address,
      v_row.subject, p_reply_domain, null, null) f;

  -- The message may already be journaled (e.g. linked after a rebind let a
  -- later copy through) — link to the existing row rather than duplicating.
  if v_row.rfc822_message_id is not null then
    select i.id into v_dup_id
      from public.interactions i
     where i.account_id = p_account_id
       and i.rfc822_message_id = v_row.rfc822_message_id
       and i.thread_id = v_thread_id
     limit 1;
  end if;

  if v_dup_id is not null then
    select * into v_interaction from public.interactions where id = v_dup_id;
  else
    -- provider_verified only when the STORED verdicts authenticate the mail;
    -- a human vouching for an unauthenticated message is 'attested'.
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
      'user:' || auth.uid(),
      case when p_party_type = 'vendor' then 'vendor' else 'tenant' end,
      null, null, null,
      v_row.provider_msg_id,
      'communication',
      public._comm_journal_channel('email'),
      'inbound',
      p_party_type,
      p_party_id,
      null,
      v_row.body,
      v_row.received_at,
      null, null,
      v_thread_id,
      case when v_row.dmarc = 'pass' then 'provider_verified' else 'attested' end,
      v_tenancy_id,
      null, null, null,
      case when p_party_type = 'vendor' then p_party_id else null end,
      v_row.rfc822_message_id
    )
    returning * into v_interaction;

    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, 'sender', p_party_type, p_party_id, v_row.from_address,
       left(coalesce(public._party_display_name(p_account_id, p_party_type, p_party_id),
                     v_row.from_display_name), 200),
       'comms'),
      (p_account_id, v_interaction.id, 'recipient', 'platform', null,
       v_row.persona_address, null, 'comms');

    for v_addr in
      select distinct x.addr
        from (
          select unnest(v_row.to_addresses) as addr
          union all
          select unnest(v_row.cc_addresses)
        ) x
       where x.addr is not null
         and length(x.addr) between 3 and 320
         and x.addr <> v_row.persona_address
         and x.addr <> v_row.from_address
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
  end if;

  -- The learning step: future mail from this address auto-resolves.
  insert into public.channel_identities (account_id, party_type, party_id, channel, address)
  values (p_account_id, p_party_type, p_party_id, 'email', v_row.from_address)
  on conflict (account_id, channel, address) do nothing;

  update public.comm_unmatched_inbound
     set status                = 'linked',
         resolved_by           = auth.uid(),
         resolved_at           = now(),
         linked_thread_id      = v_thread_id,
         linked_interaction_id = v_interaction.id,
         linked_party_type     = p_party_type,
         linked_party_id       = p_party_id,
         updated_at            = now()
   where account_id = p_account_id
     and id = p_unmatched_id;

  thread_id      := v_thread_id;
  interaction_id := v_interaction.id;
  return next;
end;
$$;

revoke execute on function public.link_unmatched_inbound(uuid, uuid, text, uuid, text) from public;
revoke execute on function public.link_unmatched_inbound(uuid, uuid, text, uuid, text) from anon;
grant  execute on function public.link_unmatched_inbound(uuid, uuid, text, uuid, text) to authenticated, service_role;

create function public.dismiss_unmatched_inbound(
  p_account_id   uuid,
  p_unmatched_id uuid
)
returns public.comm_unmatched_inbound
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row  public.comm_unmatched_inbound%rowtype;
begin
  select m.role into v_role
    from public.account_members m
   where m.user_id = auth.uid()
     and m.account_id = p_account_id
     and m.deleted_at is null;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_row
    from public.comm_unmatched_inbound u
   where u.account_id = p_account_id
     and u.id = p_unmatched_id
  for update;
  if not found then
    raise exception 'unmatched row not found' using errcode = 'P0002';
  end if;
  -- Replay-friendly: dismissing a dismissed row returns it unchanged.
  if v_row.status = 'dismissed' then
    return v_row;
  end if;
  if v_row.status <> 'pending' then
    raise exception 'already resolved (%)', v_row.status using errcode = 'P0003';
  end if;

  update public.comm_unmatched_inbound
     set status      = 'dismissed',
         resolved_by = auth.uid(),
         resolved_at = now(),
         updated_at  = now()
   where account_id = p_account_id
     and id = p_unmatched_id
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.dismiss_unmatched_inbound(uuid, uuid) from public;
revoke execute on function public.dismiss_unmatched_inbound(uuid, uuid) from anon;
grant  execute on function public.dismiss_unmatched_inbound(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
