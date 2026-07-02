-- ----------------------------------------------------------------------------
-- Comms ledger — native group-MMS threads (work item GM-A, core side).
--
-- A group thread is ONE provider-native MMS group: our platform number plus
-- up to 7 human member addresses (8 participants total, the provider limit on
-- US/CAN long codes). Contrast with bridged mode, where each counterparty has
-- a private 1:1 leg on the platform number and core relays between them.
--
-- Design (all additive; bridged behavior unchanged):
--   comm_threads.mode        'bridged' (default) | 'group'. Frozen at create.
--   comm_threads.group_routing_key
--                            canonical routing identity of a group thread:
--                            platform number + the sorted set of bound member
--                            addresses (see _comm_group_routing_key). Partial-
--                            unique among ACTIVE group threads — no two active
--                            group threads on one number may carry the same
--                            member set (the inbound set-match would be
--                            ambiguous). Computed by the create path, frozen.
--   thread_channel_bindings.thread_mode
--                            denormalized thread mode, stamped by trigger from
--                            the thread row (never trusted from the writer).
--                            Lets the 1:1 routing invariant exclude group
--                            bindings: the (platform_number,
--                            participant_address) WHERE active partial-unique
--                            now applies to BRIDGED bindings only, so one
--                            person can hold a 1:1 thread AND group threads on
--                            the same number. Group-set uniqueness is enforced
--                            on comm_threads.group_routing_key instead.
--   comm_outbox.group_addresses
--                            a group send is ONE outbox row (no per-recipient
--                            legs, no relay concept): to_address is NULL and
--                            group_addresses carries the full recipient set,
--                            frozen at intent time (same freezing rule as
--                            to_address). provider_sid stores the provider's
--                            group_message_id on completion.
--   capture_inbound(p_cc)    inbound group messages arrive on our number with
--                            a cc array of the other recipients; when present,
--                            resolution is by participant-SET match
--                            ({from} ∪ cc \ {our number} == a group thread's
--                            routing key) instead of the 1:1 binding lookup.
--                            No set match -> orphan. 1:1 (no cc) unchanged.
--   STOP compliance          a group MMS from our number reaches EVERY member,
--                            so an opt-out by ANY member refuses new group
--                            intents at the boundary (P0004 -> API 422) and
--                            record_opt_out parks queued group rows whose
--                            recipient set contains the address. Inbound stays
--                            captured (evidence) exactly as in bridged mode.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) Canonical group routing key.
-- ============================================================================
-- platform number + '>' + the sorted (byte order — collate "C" matches the
-- API layer's JS code-unit sort for these ASCII addresses), deduplicated
-- member addresses, '|'-separated, with our own number stripped defensively.
-- The thread create path (API, TS) and capture_inbound (below, SQL) MUST
-- compute identical keys; the group capture test locks the two together.

create or replace function public._comm_group_routing_key(
  p_number  text,
  p_members text[]
)
returns text
language sql
immutable
set search_path = public
as $$
  select p_number || '>' || coalesce((
    select string_agg(x, '|' order by x collate "C")
      from (
        select distinct m as x
          from unnest(p_members) m
         where m is not null and m <> p_number
      ) s
  ), '');
$$;

-- ============================================================================
-- (B) comm_threads.mode + group_routing_key
-- ============================================================================

alter table public.comm_threads
  add column mode text not null default 'bridged'
    check (mode in ('bridged', 'group')),
  add column group_routing_key text
    check (length(group_routing_key) between 5 and 3000);

-- A group thread always carries its routing key; a bridged thread never does.
alter table public.comm_threads
  add constraint comm_threads_group_key_shape
  check ((mode = 'group') = (group_routing_key is not null));

-- THE group-set invariant: among ACTIVE group threads, one (number, member
-- set) — the inbound set-match must resolve to exactly one thread. Closing a
-- thread frees the slot.
create unique index comm_threads_group_set_uniq
  on public.comm_threads (group_routing_key)
  where mode = 'group' and status = 'active';

-- mode and the routing key are identity, not state: frozen at create. (status
-- stays mutable — closing a thread is how a group slot is released.)
create or replace function public._comm_threads_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.mode is distinct from old.mode
     or new.group_routing_key is distinct from old.group_routing_key then
    raise exception 'comm_threads.mode and group_routing_key are immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger comm_threads_guard_update
  before update on public.comm_threads
  for each row execute function public._comm_threads_guard_update();

-- ============================================================================
-- (C) thread_channel_bindings.thread_mode + bridged-only routing invariant
-- ============================================================================

alter table public.thread_channel_bindings
  add column thread_mode text not null default 'bridged'
    check (thread_mode in ('bridged', 'group'));

-- Stamp the mode from the thread row — never trusted from the writer (a
-- forged 'group' tag would exempt a bridged binding from the routing
-- invariant). If the thread doesn't exist the composite FK fails the
-- statement; the stamp just leaves the default in place.
create or replace function public._thread_binding_stamp_mode()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
begin
  if tg_op = 'UPDATE' then
    if new.thread_mode is distinct from old.thread_mode then
      raise exception 'thread_channel_bindings.thread_mode is immutable'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select t.mode into v_mode
    from public.comm_threads t
   where t.id = new.thread_id and t.account_id = new.account_id;
  new.thread_mode := coalesce(v_mode, 'bridged');
  return new;
end;
$$;

create trigger thread_channel_bindings_stamp_mode
  before insert or update on public.thread_channel_bindings
  for each row execute function public._thread_binding_stamp_mode();

-- The 1:1 routing invariant now binds BRIDGED legs only: a group membership
-- must not occupy (or be blocked by) a person's single 1:1 slot on the
-- number. Group threads get set-level uniqueness on comm_threads instead.
drop index public.thread_channel_bindings_routing_uniq;
create unique index thread_channel_bindings_routing_uniq
  on public.thread_channel_bindings (platform_number, participant_address)
  where active and thread_mode = 'bridged';

-- ============================================================================
-- (D) comm_outbox: group sends are ONE row with a frozen recipient set
-- ============================================================================

alter table public.comm_outbox
  alter column to_address drop not null,
  add column group_addresses text[];

-- Exactly one destination shape per row: 1:1 (to_address, no set) or group
-- (set, no to_address). Group size: 2..7 human members (8 incl. our number).
alter table public.comm_outbox
  add constraint comm_outbox_group_shape
  check ((to_address is null) = (group_addresses is not null)),
  add constraint comm_outbox_group_size
  check (group_addresses is null
         or (array_length(group_addresses, 1) between 2 and 7)),
  add constraint comm_outbox_group_thread
  check (group_addresses is null or thread_id is not null);

-- Guard-update rebuild: group_addresses is a frozen intent field, exactly
-- like to_address (what set was dialed must survive later binding edits).
create or replace function public._comm_outbox_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_rank_old int;
  v_rank_new int;
begin
  if new.account_id   is distinct from old.account_id
     or new.channel      is distinct from old.channel
     or new.to_address   is distinct from old.to_address
     or new.group_addresses is distinct from old.group_addresses
     or new.body         is distinct from old.body
     or new.approval_ref is distinct from old.approval_ref
     or new.approved_by  is distinct from old.approved_by
     or new.author_type  is distinct from old.author_type
     or new.client_ref   is distinct from old.client_ref
     or new.created_at   is distinct from old.created_at then
    raise exception 'comm_outbox intent fields are immutable'
      using errcode = 'check_violation';
  end if;

  v_rank_old := case old.status
    when 'queued' then 0 when 'sending' then 1 when 'needs_reconcile' then 2
    when 'sent' then 3 when 'delivered' then 4 else 9 end;
  v_rank_new := case new.status
    when 'queued' then 0 when 'sending' then 1 when 'needs_reconcile' then 2
    when 'sent' then 3 when 'delivered' then 4 else 9 end;

  if v_rank_old = 9 and new.status is distinct from old.status then
    raise exception 'comm_outbox row is terminal (%)', old.status
      using errcode = 'P0003';
  end if;

  if v_rank_new < v_rank_old then
    raise exception 'comm_outbox status may not move backwards (% -> %)', old.status, new.status
      using errcode = 'P0003';
  end if;

  -- A journal link is written exactly once, by the completion path.
  if old.interaction_id is not null and new.interaction_id is distinct from old.interaction_id then
    raise exception 'comm_outbox.interaction_id is write-once'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Capacity/birth guard rebuild: adds the cross-table half of the group shape
-- (the CHECKs above can't see comm_threads). A group row must target a group
-- thread, address the whole group (no participant leg), and carry no relay
-- (relaying does not exist in group mode — the provider fans out natively);
-- a group thread accepts ONLY group rows (a 1:1 side-send into a group
-- thread would journal under the thread while bypassing the set semantics).
-- Runs as the inserter: members read their own account's threads under RLS
-- (the composite FK pins the thread to the row's account).
create or replace function public._enforce_comm_outbox_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
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
      if new.participant_id is not null or new.relay_of_interaction_id is not null then
        raise exception 'group sends address the whole thread: no participant leg, no relay'
          using errcode = 'check_violation';
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

-- Opt-out enforcement rebuild: a group MMS from our number reaches EVERY
-- member, so an opt-out by ANY member refuses the whole group send (the hard
-- STOP-compliance rule). Same typed error -> API 422, refused intents leave
-- no journal trace.
create or replace function public._comm_outbox_refuse_opted_out()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.comm_opt_outs
     where channel = new.channel
       and (address = new.to_address
            or (new.group_addresses is not null and address = any(new.group_addresses)))
  ) then
    raise exception 'a destination address has opted out of % messages', new.channel
      using errcode = 'P0004';
  end if;
  return new;
end;
$$;

-- ============================================================================
-- (E) record_opt_out: park queued GROUP rows containing the address too
-- ============================================================================
-- Same contract as 20260701000003; the parking UPDATE gains the group arm
-- (compliance is global, and a queued group send to ANY set containing the
-- opted-out address must not dial).

create or replace function public.record_opt_out(
  p_account_id uuid,
  p_channel    text,
  p_address    text,
  p_keyword    text,
  p_source_ref text
)
returns public.comm_opt_outs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.comm_opt_outs%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = p_account_id
       and m.role = 'agent'
       and m.deleted_at is null
  ) then
    raise exception 'not authorized to record opt-outs for this account'
      using errcode = '42501';
  end if;

  -- Insert-or-nothing: RETURNING populates v_row only when THIS call created
  -- the row, so we echo keyword/source_ref only for our own fresh recording.
  insert into public.comm_opt_outs (channel, address, keyword, source_ref)
  values (p_channel, p_address, p_keyword, p_source_ref)
  on conflict (channel, address) do nothing
  returning * into v_row;

  if not found then
    -- Pre-existing registration (this or another account): return existence
    -- + timestamp only, never the stored recording metadata.
    select oo.channel, oo.address, oo.opted_out_at, null::text, null::text
      into v_row
      from public.comm_opt_outs oo
     where oo.channel = p_channel and oo.address = p_address;
  end if;

  -- Park queued-but-unsent intents to this address (compliance is global):
  -- 1:1 rows dialing it, and group rows whose recipient set contains it.
  update public.comm_outbox
     set status        = 'undeliverable',
         error_code    = 'opted_out',
         error_message = 'destination opted out before dispatch',
         updated_at    = now()
   where status = 'queued'
     and channel = p_channel
     and (to_address = p_address
          or (to_address is null and p_address = any(group_addresses)));

  return v_row;
end;
$$;

revoke execute on function public.record_opt_out(uuid, text, text, text, text) from public;
revoke execute on function public.record_opt_out(uuid, text, text, text, text) from anon;
grant  execute on function public.record_opt_out(uuid, text, text, text, text) to authenticated, service_role;

-- ============================================================================
-- (F) complete_send: group party attribution
-- ============================================================================
-- Body identical to 20260701000004 except the party-attribution head: a group
-- send addresses the whole thread, so there is no single counterparty — the
-- journal row records party_type='unspecified' with the dialed set as the
-- label (honest evidence of exactly who was reached). The non-relay journal
-- insert (thread context copy) covers group rows unchanged; relay legs cannot
-- exist in group mode (capacity trigger).

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
    corrects_id, correction_kind, thread_id,
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
-- (G) capture_inbound: optional cc[] -> participant-set match for group MMS
-- ============================================================================
-- Signature change (new trailing p_cc text[] default null) requires a drop:
-- CREATE OR REPLACE cannot alter an argument list, and an overload would make
-- PostgREST's named-argument dispatch ambiguous. Callers that omit p_cc (the
-- deployed transport, the 1:1 path) hit the default — the migration is safe
-- to apply ahead of the code deploy.
--
-- Group resolution: when cc is present and non-empty, the member set
-- {from} ∪ cc \ {our number} is canonicalized with _comm_group_routing_key
-- and matched against the account's ACTIVE group threads on that number; the
-- sender's own active binding on the matched thread supplies the journal
-- participant. No set match (or a matched thread without an active sender
-- binding — a defensive impossibility) -> orphan, exactly like a 1:1 binding
-- miss. 1:1 messages (no cc) keep the binding resolution unchanged; both
-- modes coexist on one number.

drop function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz);

create function public.capture_inbound(
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
  v_author_type  text;
  v_group_thread uuid;
  v_matched      boolean := false;
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
  -- is account-scoped from the outset (it is re-affirmed on the disposition
  -- update below). provider_msg_id is globally UNIQUE, so a collision means
  -- the message was already captured — by this account (a race → return the
  -- committed result) or another (a misroute/probe → refuse, never leak).
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

  if p_cc is not null and array_length(p_cc, 1) > 0 then
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
  else
    -- 1:1: resolve the active BRIDGED binding for (platform number,
    -- counterparty address), pinned to the calling account.
    select b.thread_id as b_thread_id, b.participant_id as b_participant_id
      into v_binding
      from public.thread_channel_bindings b
     where b.platform_number = p_to_number
       and b.participant_address = p_from_address
       and b.active
       and b.thread_mode = 'bridged'
       and b.account_id = p_account_id;

    if not found then
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
  end if;

  select * into v_participant
    from public.comm_thread_participants p
   where p.id = v_binding.b_participant_id;

  v_party_type := case v_participant.party_type
    when 'tenant' then 'tenant'
    when 'vendor' then 'vendor'
    else 'other'
  end;
  v_author_type := case v_participant.party_type
    when 'tenant' then 'tenant'
    when 'vendor' then 'vendor'
    when 'landlord_user' then 'landlord'
    else 'system'
  end;

  v_disposition := case
    when exists (
      select 1 from public.comm_opt_outs oo
       where oo.channel = p_channel and oo.address = p_from_address
    ) then 'opted_out'
    else 'matched'
  end;

  -- Journal the contact (it happened, opted-out or not). Mechanical writer
  -- attribution follows the intake pattern: audit.actor is only consulted
  -- when auth.uid() is null, so the chain records the true transport caller;
  -- the row's actor states the capture path.
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
    v_participant.party_id,
    case when v_party_type = 'other' then v_participant.party_type else null end,
    p_body,
    p_received_at,
    null,
    null,
    v_binding.b_thread_id,
    null, null, null, null,
    case when v_party_type = 'vendor' then v_participant.party_id else null end
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
