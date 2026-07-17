-- ============================================================================
-- Bare-send party resolution + journal area derivation.
-- ============================================================================
-- Found via the first real bare-intent send (the inspection-link welcome
-- email: to = a tenancy's tenant, cc = the account owner, tenancy_id supplied).
-- The journal row came out unlinked on every axis the caller had already
-- pinned down: headline party_type='unspecified'/party_id=null, cast rows
-- party_type='unknown'/party_id=null (raw addresses only), area_id=null so the
-- view-derived property_id was null too — even though the row's own tenancy_id
-- resolved to the very tenant whose email was dialed, and to the unit/property.
--
-- Cause, by construction: a bare (thread-less) send has no thread binding, so
-- the snapshot trigger's only tier was the channel_identities address book —
-- which only learns addresses from inbound capture/rebind. Our own outbound
-- context (the intent's tenancy, the account's users) was never consulted.
--
-- Two additive changes:
--
--   1. _comm_resolve_context_party — two new snapshot tiers, fired ONLY when
--      the existing tiers (thread binding, channel_identities) miss, so no
--      previously-resolved snapshot changes shape:
--        a. tenancy members: when the intent carries tenancy_id, an email
--           address matching a member tenant's tenants.emails resolves to
--           ('tenant', tenant_id). Deterministic on the rare duplicate email:
--           primary-role member first, then tenant id.
--        b. account users: an email address matching an owner/manager member's
--           auth.users email resolves to ('landlord_user', user_id) — the CC
--           arm's expected shape ('agent'/'viewer' members deliberately not:
--           the cast vocabulary reserves landlord_user for the humans the
--           landlord CC arm copies).
--      Resolution stays at INTENT time (the snapshot freeze), preserving the
--      evidentiary model: identity edits between approval and completion can
--      never rewrite who the send is recorded as reaching.
--
--   2. complete_send derives the journal row's area_id from the intent's
--      tenancy (tenancies.area_id is a NOT NULL unit FK — one tenancy, one
--      unit) instead of hard-inserting null. property_id is view-computed
--      from area_id (20260718000003), so the send now files under its place
--      with no view change. Filing scope, not an evidentiary claim — so it is
--      derived at journal time, not frozen into the snapshot.
--
-- Supersedes two stale comments in 20260719000006 (the code below is the new
-- truth; the old prose was already wrong about its own body):
--   * its header (lines ~20-25) claims Cc is "deliberately NOT snapshotted
--     into recipient_snapshot / the journal cast in this slice" — that
--     migration's own sections (5)/(6) DO snapshot Cc as role='cc' and copy
--     it into the cast;
--   * its section (5) says CC entries are "resolved through the same tiers
--     (thread binding, then the address book)" — for a bare send that meant
--     the address book alone, which is exactly the gap fixed here.

-- (1) The context tiers. SECURITY INVOKER on purpose: the snapshot trigger
-- that calls this is SECURITY DEFINER, so in the only intended call path this
-- runs with the definer's rights (auth.users readable); called any other way
-- it is bounded by the caller's own RLS/grants and auth.users is simply not
-- readable — no probing oracle for address→party mappings.
create or replace function public._comm_resolve_context_party(
  p_account_id uuid,
  p_tenancy_id uuid,
  p_channel    text,
  p_address    text,
  out o_party_type text,
  out o_party_id   uuid
)
language plpgsql
stable
set search_path = public
as $$
begin
  -- Email-only: these tiers key on stored email addresses. SMS context
  -- resolution (tenants.phones) is a deliberate non-goal of this slice.
  if p_channel <> 'email' or p_address is null then
    return;
  end if;

  -- Tier: the intent's tenancy members. Scoped to the named tenancy (not the
  -- whole account) so one address shared across tenancies can't cross-link.
  if p_tenancy_id is not null then
    select 'tenant', t.id
      into o_party_type, o_party_id
      from public.tenancy_tenants tt
      join public.tenancies ty
        on ty.account_id = tt.account_id
       and ty.id         = tt.tenancy_id
      join public.tenants t
        on t.account_id = tt.account_id
       and t.id         = tt.tenant_id
     where tt.account_id = p_account_id
       and tt.tenancy_id = p_tenancy_id
       and tt.deleted_at is null
       and ty.deleted_at is null
       and t.deleted_at  is null
       and exists (
         select 1 from unnest(t.emails) e(addr)
          where lower(btrim(e.addr)) = lower(btrim(p_address)))
     order by (tt.role = 'primary') desc, t.id
     limit 1;
    if o_party_type is not null then
      return;
    end if;
  end if;

  -- Tier: the account's landlord users (owner/manager; never 'agent').
  select 'landlord_user', m.user_id
    into o_party_type, o_party_id
    from public.account_members m
    join auth.users u on u.id = m.user_id
   where m.account_id = p_account_id
     and m.deleted_at is null
     and m.role in ('owner', 'manager')
     and lower(btrim(u.email)) = lower(btrim(p_address))
   order by (m.role = 'owner') desc, m.user_id
   limit 1;
end;
$$;

-- Defense-in-depth: this helper exists solely for the SECURITY DEFINER
-- snapshot trigger. A direct call already fails safe (tier 1 is bounded by the
-- caller's own RLS; tier 2 dies on auth.users, which only postgres may read),
-- but there is no reason to leave the default PUBLIC execute surface at all.
-- The trigger runs as the function owner, which retains execute regardless.
revoke execute on function public._comm_resolve_context_party(uuid, uuid, text, text)
  from public, anon, authenticated;

-- (2) Snapshot rebuild (head was 20260719000006; same signature, so
-- create-or-replace — grants persist). One addition per arm: when the
-- existing tiers miss (v_type still null), consult the context tiers before
-- freezing 'unknown'. Thread binding and channel_identities stay first — an
-- explicitly learned/corrected binding always wins. Group-MMS arm untouched.
create or replace function public._comm_outbox_snapshot_recipients()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type  text;
  v_id    uuid;
  v_label text;
  r_cc    record;
begin
  -- Always stamped here — a writer-supplied snapshot is discarded (a forged
  -- snapshot would put words in the cast's mouth).
  if new.group_addresses is not null then
    select jsonb_agg(
             jsonb_build_object(
               'address',    ga.addr,
               'party_type', coalesce(p.party_type, 'unknown'),
               'party_id',   p.party_id,
               'label',      public._party_display_name(new.account_id, p.party_type, p.party_id))
             order by ga.ord)
      into new.recipient_snapshot
      from unnest(new.group_addresses) with ordinality ga(addr, ord)
      left join public.thread_channel_bindings b
        on b.account_id = new.account_id
       and b.thread_id = new.thread_id
       and b.participant_address = ga.addr
       and b.active
      left join public.comm_thread_participants p
        on p.id = b.participant_id;
  else
    if new.participant_id is not null then
      select p.party_type, p.party_id
        into v_type, v_id
        from public.comm_thread_participants p
       where p.id = new.participant_id;
    end if;
    if v_type is null then
      select ci.party_type, ci.party_id, ci.label
        into v_type, v_id, v_label
        from public.channel_identities ci
       where ci.account_id = new.account_id
         and ci.channel   = new.channel
         and ci.address   = new.to_address;
    end if;
    if v_type is null then
      select h.o_party_type, h.o_party_id
        into v_type, v_id
        from public._comm_resolve_context_party(
               new.account_id, new.tenancy_id, new.channel, new.to_address) h;
    end if;
    new.recipient_snapshot := jsonb_build_array(jsonb_build_object(
      'address',    new.to_address,
      'party_type', coalesce(v_type, 'unknown'),
      'party_id',   v_id,
      'label',      coalesce(public._party_display_name(new.account_id, v_type, v_id), v_label)));
  end if;

  -- CC arm: identity-freeze each (already opt-out-scrubbed) CC address after
  -- the primary entries. Resolution mirrors the primary tiers: the thread's
  -- active binding for that address, else the account address book, else the
  -- intent's context (tenancy members / account users).
  if new.cc_addresses is not null then
    for r_cc in
      select ca.addr, ca.ord
        from unnest(new.cc_addresses) with ordinality ca(addr, ord)
       order by ca.ord
    loop
      v_type := null; v_id := null; v_label := null;
      if new.thread_id is not null then
        select p.party_type, p.party_id
          into v_type, v_id
          from public.thread_channel_bindings b
          join public.comm_thread_participants p on p.id = b.participant_id
         where b.account_id = new.account_id
           and b.thread_id  = new.thread_id
           and b.participant_address = r_cc.addr
           and b.active
         limit 1;
      end if;
      if v_type is null then
        select ci.party_type, ci.party_id, ci.label
          into v_type, v_id, v_label
          from public.channel_identities ci
         where ci.account_id = new.account_id
           and ci.channel    = new.channel
           and ci.address    = r_cc.addr;
      end if;
      if v_type is null then
        select h.o_party_type, h.o_party_id
          into v_type, v_id
          from public._comm_resolve_context_party(
                 new.account_id, new.tenancy_id, new.channel, r_cc.addr) h;
      end if;
      new.recipient_snapshot := coalesce(new.recipient_snapshot, '[]'::jsonb)
        || jsonb_build_array(jsonb_build_object(
             'role',       'cc',
             'address',    r_cc.addr,
             'party_type', coalesce(v_type, 'unknown'),
             'party_id',   v_id,
             'label',      coalesce(public._party_display_name(new.account_id, v_type, v_id), v_label)));
    end loop;
  end if;
  return new;
end;
$$;

-- (3) complete_send rebuild (head was 20260719000006; same signature, so
-- create-or-replace — grants persist). One change: the journal row's area_id
-- is derived from the intent's tenancy instead of hard-null (declared
-- v_area_id, filled just before the insert). Everything else verbatim.
create or replace function public.complete_send(
  p_outbox_id         uuid,
  p_provider          text,
  p_provider_sid      text,
  p_rfc822_message_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox         public.comm_outbox%rowtype;
  v_interaction    public.interactions%rowtype;
  v_party_type     text;
  v_party_id       uuid;
  v_party_label    text;
  v_author_type    text;
  v_cast_type      text;
  v_sender_address text;
  v_area_id        uuid;
  v_cast           jsonb := '[]'::jsonb;
  v_names          text[] := '{}';
  v_name           text;
  v_journal_body   text;
  v_msgid          text := public._comm_normalize_msgid(p_rfc822_message_id);
  r                record;
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
       set status            = 'sent',
           provider          = p_provider,
           provider_sid      = p_provider_sid,
           rfc822_message_id = v_msgid,
           interaction_id    = v_outbox.relay_of_interaction_id,
           updated_at        = now()
     where id = p_outbox_id;
    return v_outbox.relay_of_interaction_id;
  end if;

  -- Party attribution + cast assembly. The identities were snapshotted at
  -- INTENT time (recipient_snapshot, stamped by trigger, frozen) — the cast
  -- copies that snapshot so identity edits between approval and completion
  -- can never rewrite who the send is recorded as reaching. The resolution
  -- fallbacks below exist only for legacy queued rows that predate the
  -- snapshot column (none in prod: comms are dormant).
  if v_outbox.group_addresses is not null then
    v_party_type := 'unspecified';
    v_party_id   := null;
    if v_outbox.recipient_snapshot is not null then
      for r in
        select e->>'address'                    as addr,
               e->>'party_type'                 as p_party_type,
               nullif(e->>'party_id', '')::uuid as p_party_id,
               e->>'label'                      as p_label
          from jsonb_array_elements(v_outbox.recipient_snapshot) e
      loop
        v_names := v_names || coalesce(r.p_label, r.addr);
        v_cast := v_cast || jsonb_build_array(jsonb_build_object(
          'role', 'recipient',
          'party_type', r.p_party_type,
          'party_id', r.p_party_id,
          'address', r.addr,
          'label', r.p_label));
      end loop;
    else
      for r in
        select ga.addr,
               ga.ord,
               p.party_type as p_party_type,
               p.party_id   as p_party_id
          from unnest(v_outbox.group_addresses) with ordinality ga(addr, ord)
          left join public.thread_channel_bindings b
            on b.account_id = v_outbox.account_id
           and b.thread_id = v_outbox.thread_id
           and b.participant_address = ga.addr
           and b.active
          left join public.comm_thread_participants p
            on p.id = b.participant_id
         order by ga.ord
      loop
        v_name := public._party_display_name(v_outbox.account_id, r.p_party_type, r.p_party_id);
        v_names := v_names || coalesce(v_name, r.addr);
        v_cast := v_cast || jsonb_build_array(jsonb_build_object(
          'role', 'recipient',
          'party_type', coalesce(r.p_party_type, 'unknown'),
          'party_id', r.p_party_id,
          'address', r.addr,
          'label', v_name));
      end loop;
    end if;
    v_party_label := left(array_to_string(v_names, ', '), 200);
  else
    if v_outbox.recipient_snapshot is not null then
      -- Attribution: the PRIMARY entry — the first without role='cc'. A copied
      -- party must never become who the journal row is "with".
      select t.e->>'party_type',
             nullif(t.e->>'party_id', '')::uuid,
             t.e->>'label'
        into v_cast_type, v_party_id, v_name
        from jsonb_array_elements(v_outbox.recipient_snapshot) with ordinality t(e, ord)
       where coalesce(t.e->>'role', 'recipient') <> 'cc'
       order by t.ord
       limit 1;
      v_party_type := case v_cast_type
        when 'tenant' then 'tenant'
        when 'vendor' then 'vendor'
        when 'unknown' then 'unspecified'
        else 'other'
      end;
      if v_party_type = 'unspecified' then
        v_party_id    := null;
        v_party_label := v_outbox.to_address;
      end if;
      -- Cast: EVERY snapshot entry, in order — primary as 'recipient', copied
      -- parties as 'cc'. Entry addresses come from the snapshot itself (the
      -- primary entry's address IS to_address, stamped at intent).
      select coalesce(jsonb_agg(jsonb_build_object(
               'role',       coalesce(t.e->>'role', 'recipient'),
               'party_type', t.e->>'party_type',
               'party_id',   nullif(t.e->>'party_id', '')::uuid,
               'address',    coalesce(t.e->>'address', v_outbox.to_address),
               'label',      t.e->>'label') order by t.ord), '[]'::jsonb)
        into v_cast
        from jsonb_array_elements(v_outbox.recipient_snapshot) with ordinality t(e, ord);
    else
      if v_outbox.participant_id is not null then
        select case p.party_type
                 when 'tenant' then 'tenant'
                 when 'vendor' then 'vendor'
                 else 'other'
               end,
               p.party_id,
               p.party_type
          into v_party_type, v_party_id, v_cast_type
          from public.comm_thread_participants p
         where p.id = v_outbox.participant_id;
        if v_party_type is not null then
          v_name := public._party_display_name(v_outbox.account_id, v_cast_type, v_party_id);
          v_cast := jsonb_build_array(jsonb_build_object(
            'role', 'recipient',
            'party_type', v_cast_type,
            'party_id', v_party_id,
            'address', v_outbox.to_address,
            'label', v_name));
        end if;
      end if;
      if v_party_type is null then
        select case ci.party_type
                 when 'tenant' then 'tenant'
                 when 'vendor' then 'vendor'
                 else 'other'
               end,
               ci.party_id,
               ci.party_type,
               coalesce(public._party_display_name(v_outbox.account_id, ci.party_type, ci.party_id), ci.label)
          into v_party_type, v_party_id, v_cast_type, v_name
          from public.channel_identities ci
         where ci.account_id = v_outbox.account_id
           and ci.channel   = v_outbox.channel
           and ci.address   = v_outbox.to_address;
        if v_party_type is not null then
          v_cast := jsonb_build_array(jsonb_build_object(
            'role', 'recipient',
            'party_type', v_cast_type,
            'party_id', v_party_id,
            'address', v_outbox.to_address,
            'label', v_name));
        end if;
      end if;
      if v_party_type is null then
        v_party_type  := 'unspecified';
        v_party_id    := null;
        v_party_label := v_outbox.to_address;
        v_cast := jsonb_build_array(jsonb_build_object(
          'role', 'recipient',
          'party_type', 'unknown',
          'party_id', null,
          'address', v_outbox.to_address,
          'label', null));
      end if;
    end if;
  end if;

  -- The platform leg that dialed: the thread's platform number (sms), or the
  -- recipient's minted reply token (email — the From that recipient sees).
  if v_outbox.channel = 'email' and v_outbox.participant_id is not null then
    select b.reply_address into v_sender_address
      from public.thread_channel_bindings b
     where b.account_id = v_outbox.account_id
       and b.thread_id = v_outbox.thread_id
       and b.participant_id = v_outbox.participant_id
       and b.active;
  elsif v_outbox.thread_id is not null then
    select b.platform_number into v_sender_address
      from public.thread_channel_bindings b
     where b.account_id = v_outbox.account_id
       and b.thread_id = v_outbox.thread_id
       and b.platform_number is not null
     limit 1;
  end if;

  -- Filing scope: the intent's tenancy names the unit (tenancies.area_id is a
  -- NOT NULL unit FK), so the journal row files under its place and the
  -- view-derived property_id (20260718000003) lights up. Derived here — not
  -- frozen in the snapshot — because it is context, not an evidentiary claim
  -- about who was reached.
  if v_outbox.tenancy_id is not null then
    select t.area_id
      into v_area_id
      from public.tenancies t
     where t.account_id = v_outbox.account_id
       and t.id         = v_outbox.tenancy_id
       and t.deleted_at is null;
  end if;

  v_author_type := v_outbox.author_type;

  -- Journal body (20260703000001, regression caught by CI): an email send
  -- with a subject journals 'Subject: <subject>' + blank line + body — the
  -- documented shape the transport's rendering and the journal share. The
  -- superseded audience rework of this migration was rebuilt from the
  -- group-MMS body and silently dropped this; restored here.
  v_journal_body := case
    when v_outbox.channel = 'email' and v_outbox.subject is not null
      then 'Subject: ' || v_outbox.subject || e'\n\n' || v_outbox.body
    else v_outbox.body
  end;

  -- The capacity trigger would (rightly) reject e.g. the agent transport
  -- writing author_type='landlord'; this is the verified completion path,
  -- so exempt this transaction AFTER the checks above.
  perform set_config('comm.verified_write', 'on', true);

  insert into public.interactions (
    account_id, actor, author_type, approved_by, approval_ref,
    entry_type, external_ref, kind, channel, direction,
    party_type, party_id, party_label, body, occurred_at,
    corrects_id, correction_kind, thread_id, attestation,
    tenancy_id, maintenance_request_id, area_id, work_order_id, vendor_id,
    rfc822_message_id
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
    v_journal_body,
    now(),
    null,
    null,
    v_outbox.thread_id,
    -- Verified path: provider confirmed the send (sid above); GUC set.
    'provider_verified',
    -- carry the outbox's context onto the journal so the send shows up in
    -- the tenancy / maintenance-request activity feed.
    v_outbox.tenancy_id,
    v_outbox.maintenance_request_id,
    v_area_id,
    null,
    case when v_party_type = 'vendor' then v_party_id else null end,
    v_msgid
  )
  returning * into v_interaction;

  -- The cast: the platform leg that dialed + each dialed human, frozen from
  -- the intent. (No cast rows for relay legs: they never reach this point.)
  insert into public.interaction_participants
    (account_id, interaction_id, role, party_type, party_id, address, label, source)
  values
    (v_outbox.account_id, v_interaction.id, 'sender', 'platform', null,
     v_sender_address,
     case when v_sender_address is null then 'platform' else null end,
     'comms');

  insert into public.interaction_participants
    (account_id, interaction_id, role, party_type, party_id, address, label, source)
  select v_outbox.account_id, v_interaction.id,
         c.role, c.party_type, c.party_id, c.address, left(c.label, 200), 'comms'
    from jsonb_to_recordset(v_cast)
      as c(role text, party_type text, party_id uuid, address text, label text);

  update public.comm_outbox
     set status            = 'sent',
         provider          = p_provider,
         provider_sid      = p_provider_sid,
         rfc822_message_id = v_msgid,
         interaction_id    = v_interaction.id,
         updated_at        = now()
   where id = p_outbox_id;

  return v_interaction.id;
end;
$$;

notify pgrst, 'reload schema';
