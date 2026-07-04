-- ----------------------------------------------------------------------------
-- Comms ledger — evidence hardening, part 1 REWORKED: the participants cast
-- + the attestation tier (work item EV-A, redesigned before first apply).
--
-- The journal's single counterparty slot (party_type/party_id/party_label)
-- cannot represent a group message, an in-person group meeting, or a
-- witnessed exchange. The interim `audience` jsonb blob (the previous body
-- of THIS migration — never applied anywhere) stored addresses with no
-- identity link and a direction-dependent shape. This rework replaces it:
--
--   interaction_participants  one row per person-per-role on a journal row,
--                             frozen at write time. Each row carries the
--                             three layers of truth separately:
--                               address  — the wire fact as the transport
--                                          reported it
--                               party_id — OUR resolution of who that was,
--                                          at capture time (typed ref, no FK
--                                          — polymorphic house pattern)
--                               label    — display-name snapshot, so later
--                                          renames never rewrite history
--                             Roles: sender / recipient / cc (wire) and
--                             attendee (in-person). The row's author fields
--                             (author_type/actor/approved_by) are NOT
--                             duplicated into the cast: the cast describes
--                             the event, the row describes the record.
--                             Member SELECT-only; writes only via the
--                             DEFINER paths below. Hard insert-only.
--
--   interactions.attestation  how the row is known: 'provider_verified'
--                             (carrier-confirmed transmission; only the
--                             verified comms paths can stamp it — GUC-gated),
--                             'attested' (a human/agent's account of an
--                             off-platform event), 'imported' (bulk import),
--                             null (legacy rows, never rewritten).
--
-- capture_inbound and complete_send are re-created from their
-- 20260703000002 / 20260702000001 bodies: they stamp attestation and write
-- the cast inside the same transaction as the journal row. A new
-- journal_with_participants RPC gives the manual capture path the same
-- row+cast atomicity. The legacy party slot stays populated (back-compat
-- headline, "filed under"); two label fixes ride along (group sends get
-- joined display NAMES, inbound landlord_user rows get the person's name
-- instead of the literal string 'landlord_user').
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) interaction_participants — the cast, insert-only evidence
-- ============================================================================
-- House conventions: denormalized account_id + composite FK pinning the child
-- to the parent's account; unique(account_id,id); _emit_event audit trigger.
-- RLS/write posture copies inbound_provenance (20260703000004): members can
-- SELECT; INSERT/UPDATE/DELETE are revoked from the client roles outright, so
-- tampering is DENIED, not merely audited. All writes happen inside the
-- SECURITY DEFINER comms/journal functions.

create table public.interaction_participants (
  id              uuid        primary key default gen_random_uuid(),
  account_id      uuid        not null references public.accounts(id) on delete restrict,
  interaction_id  uuid        not null,
  foreign key (account_id, interaction_id)
    references public.interactions(account_id, id) on delete restrict,
  -- Wire/attendance role only. No 'author' role: authorship lives on the
  -- interactions row (author_type/actor), exactly once.
  role            text        not null check (role in ('sender', 'recipient', 'cc', 'attendee')),
  -- Cast vocabulary follows the thread roster (comm_thread_participants) plus
  -- the legacy manual types, 'platform' (our own number/token as a wire leg)
  -- and 'unknown' (e.g. a sender_mismatch address we refuse to guess about).
  party_type      text        not null check (party_type in
                    ('tenant', 'landlord_user', 'vendor', 'agent',
                     'inspector', 'other', 'platform', 'unknown')),
  party_id        uuid,
  address         text        check (address is null or length(address) between 3 and 320),
  label           text        check (label is null or length(label) <= 200),
  -- How this cast row came to exist: 'comms' (stamped by the verified
  -- capture/complete paths), 'capture' (manual journal entry), 'backfill'
  -- (bulk restatement of a legacy row's party slot — see 20260703000005).
  source          text        not null check (source in ('capture', 'comms', 'backfill')),
  created_at      timestamptz not null default now(),
  unique (account_id, id),
  -- A cast row must identify someone by at least one layer.
  check (party_id is not null or label is not null or address is not null),
  -- The platform is infrastructure, never a person.
  check (party_type <> 'platform' or party_id is null)
);

-- Read path: the cast of one journal row.
create index interaction_participants_interaction_idx
  on public.interaction_participants (interaction_id);

-- The payoff query: "every interaction involving <person>".
create index interaction_participants_party_idx
  on public.interaction_participants (account_id, party_type, party_id);

alter table public.interaction_participants enable row level security;
alter table public.interaction_participants force  row level security;

-- Members read; nobody (client-side) writes.
create policy interaction_participants_member_read on public.interaction_participants
  for select
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

revoke insert, update, delete, truncate
  on public.interaction_participants
  from public, anon, authenticated;

create trigger interaction_participants_audit
  after insert or update or delete on public.interaction_participants
  for each row execute function public._emit_event();

-- Belt-and-braces immutability: the RLS/revoke posture above already denies
-- client-role writes, but a service-tier job or a future DEFINER bug could
-- still mutate cast rows and merely leave an audit trail. Evidence must be
-- DENIED mutation, not just observed mutation — so updates and deletes raise
-- unconditionally (same spirit as the logged_at / attestation freezes). A
-- deliberate operator act (ALTER TABLE ... DISABLE TRIGGER as superuser)
-- remains possible and visibly exceptional.
create or replace function public._interaction_participants_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'interaction_participants rows are immutable (insert-only evidence)'
    using errcode = 'check_violation';
end;
$$;

create trigger interaction_participants_immutable
  before update or delete on public.interaction_participants
  for each row execute function public._interaction_participants_immutable();

-- Address-only discovery: "every message involving +1555… / this email",
-- regardless of whether (or to whom) the address was resolved at the time.
create index interaction_participants_address_idx
  on public.interaction_participants (account_id, lower(address))
  where address is not null;

-- ============================================================================
-- (B) interactions.attestation — the trust tier, frozen and forge-proof
-- ============================================================================

alter table public.interactions
  add column attestation text
    constraint interactions_attestation_check
    check (attestation is null
           or attestation in ('provider_verified', 'attested', 'imported'));

-- agent_event rows are workflow exhaust, not communications or testimony:
-- the tier does not apply. Legacy rows keep null (never rewritten).
alter table public.interactions
  add constraint interactions_attestation_kind_check
  check (kind <> 'agent_event' or attestation is null);

-- The logged_at immutability guard (20260604000002) gains attestation: the
-- trust tier of a recorded entry is identity, not state. Any change —
-- including a later "upgrade" of a null — is refused at the source.
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
  if NEW.attestation is distinct from OLD.attestation then
    raise exception 'interactions.attestation is immutable'
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

-- Forge gate: 'provider_verified' asserts a carrier-confirmed transmission,
-- so only the verified comms write paths may stamp it. Those paths announce
-- themselves via the transaction-local comm.verified_write GUC (settable
-- only inside capture_inbound / complete_send — the same mechanism
-- _enforce_agent_capacity trusts). Everyone else — members, the agent
-- principal, even service-tier writers — is refused: a path that wants the
-- tier must BE a verified path.
create or replace function public._enforce_attestation_provenance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.attestation = 'provider_verified'
     and coalesce(current_setting('comm.verified_write', true), '') <> 'on' then
    raise exception 'attestation=provider_verified requires a verified comms write path'
      using errcode = 'check_violation';
  end if;
  -- Default-fill: after this migration, NULL strictly means "journaled
  -- before the column existed". Every new communication/note that doesn't
  -- state a tier gets the honest default for its shape — a human/system
  -- record of an event is testimony ('attested'), an import-channel row is
  -- 'imported'. agent_event rows stay null (the tier does not apply; the
  -- kind CHECK enforces it). The verified paths set their value explicitly
  -- before this fires.
  if new.attestation is null and new.kind <> 'agent_event' then
    new.attestation := case when new.channel = 'import' then 'imported' else 'attested' end;
  end if;
  return new;
end;
$$;

create trigger interactions_attestation_gate
  before insert on public.interactions
  for each row execute function public._enforce_attestation_provenance();

-- ============================================================================
-- (C) Display-name snapshot helper
-- ============================================================================
-- Resolves a party reference to its CURRENT display name, for freezing onto
-- a cast row at write time. Plain invoker function (RLS applies to normal
-- callers; the DEFINER comms functions call it as owner).

create or replace function public._party_display_name(
  p_account_id uuid,
  p_party_type text,
  p_party_id   uuid
)
returns text
language sql
stable
set search_path = public
as $$
  select case p_party_type
    when 'tenant' then
      (select t.full_name from public.tenants t
        where t.account_id = p_account_id and t.id = p_party_id)
    when 'vendor' then
      (select v.name from public.vendors v
        where v.account_id = p_account_id and v.id = p_party_id)
    when 'landlord_user' then
      (select u.display_name from public.users u where u.id = p_party_id)
    else null
  end;
$$;

-- ============================================================================
-- (D) capture_inbound: stamp attestation + write the cast
-- ============================================================================
-- Body identical to 20260703000002 except:
--   * the interactions insert stamps attestation='provider_verified'
--     (this IS the verified path; the GUC is already set),
--   * after the journal insert the cast is written in the same txn:
--       sender    — the resolved participant (or 'unknown' + the actual
--                   address on email sender_mismatch: identity doubt is
--                   stated, never guessed away),
--       recipient — the platform address the message arrived on (the
--                   number, or the minted email reply token),
--       cc        — group MMS only: each co-recipient the provider
--                   reported, resolved through the thread's bindings
--                   (email cc has no v1 semantics and is not cast),
--   * label fix: an inbound row from a landlord_user participant gets the
--     person's display name as party_label, not the literal string
--     'landlord_user'.

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
    -- This IS the verified path: the provider confirmed this delivery and
    -- the raw body is archived (EV-B). The GUC above satisfies the gate.
    'provider_verified',
    null, null, null, null,
    case when v_party_type = 'vendor' then v_party_id else null end
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

revoke execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[]) from public;
revoke execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[]) from anon;
grant  execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[]) to authenticated, service_role;

-- ============================================================================
-- (E0) comm_outbox.recipient_snapshot — identities frozen at INTENT time
-- ============================================================================
-- The addresses of a send were always frozen at intent (to_address /
-- group_addresses); WHO those addresses belonged to was not — a completion
-- that resolves identities through live bindings/channel_identities can
-- drift from what the human approved if an identity is edited while the row
-- sits queued (or worse, in needs_reconcile for days). So the resolution
-- itself is now snapshotted at intent creation, stamped by trigger (never
-- trusted from the writer), frozen by the guard below, and complete_send
-- COPIES it instead of re-resolving. The cast then states who we believed
-- we were dialing at the moment of approval — the evidentiary claim.

alter table public.comm_outbox
  add column recipient_snapshot jsonb
    check (recipient_snapshot is null or jsonb_typeof(recipient_snapshot) = 'array');

create or replace function public._comm_outbox_snapshot_recipients()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_type  text;
  v_id    uuid;
  v_label text;
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
    new.recipient_snapshot := jsonb_build_array(jsonb_build_object(
      'address',    new.to_address,
      'party_type', coalesce(v_type, 'unknown'),
      'party_id',   v_id,
      'label',      coalesce(public._party_display_name(new.account_id, v_type, v_id), v_label)));
  end if;
  return new;
end;
$$;

create trigger comm_outbox_snapshot_recipients
  before insert on public.comm_outbox
  for each row execute function public._comm_outbox_snapshot_recipients();

-- Guard-update rebuild (head was 20260703000001): the snapshot joins the
-- frozen intent fields — who we resolved at approval time must survive
-- later identity edits, which is its entire reason to exist.
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
     or new.subject      is distinct from old.subject
     or new.body         is distinct from old.body
     or new.approval_ref is distinct from old.approval_ref
     or new.approved_by  is distinct from old.approved_by
     or new.author_type  is distinct from old.author_type
     or new.client_ref   is distinct from old.client_ref
     or new.created_at   is distinct from old.created_at
     or new.recipient_snapshot is distinct from old.recipient_snapshot then
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

-- ============================================================================
-- (E) complete_send: stamp attestation + write the cast
-- ============================================================================
-- Body identical to 20260702000001 (+ email additions) except:
--   * attestation='provider_verified' on the journal insert,
--   * the cast is built from the FROZEN intent (to_address/group_addresses,
--     resolved through the thread's bindings) — never from transport input —
--     and written in the same txn: sender = the platform leg that dialed,
--     recipient = each dialed human,
--   * label fix: a group row's party_label becomes the joined display NAMES
--     (fallback: the address) instead of a raw-number comma string.

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
  v_outbox         public.comm_outbox%rowtype;
  v_interaction    public.interactions%rowtype;
  v_party_type     text;
  v_party_id       uuid;
  v_party_label    text;
  v_author_type    text;
  v_cast_type      text;
  v_sender_address text;
  v_cast           jsonb := '[]'::jsonb;
  v_names          text[] := '{}';
  v_name           text;
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
       set status         = 'sent',
           provider       = p_provider,
           provider_sid   = p_provider_sid,
           interaction_id = v_outbox.relay_of_interaction_id,
           updated_at     = now()
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
      select e->>'party_type',
             nullif(e->>'party_id', '')::uuid,
             e->>'label'
        into v_cast_type, v_party_id, v_name
        from jsonb_array_elements(v_outbox.recipient_snapshot) e
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
      v_cast := jsonb_build_array(jsonb_build_object(
        'role', 'recipient',
        'party_type', v_cast_type,
        'party_id', v_party_id,
        'address', v_outbox.to_address,
        'label', v_name));
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

  v_author_type := v_outbox.author_type;

  -- The capacity trigger would (rightly) reject e.g. the agent transport
  -- writing author_type='landlord'; this is the verified completion path,
  -- so exempt this transaction AFTER the checks above.
  perform set_config('comm.verified_write', 'on', true);

  insert into public.interactions (
    account_id, actor, author_type, approved_by, approval_ref,
    entry_type, external_ref, kind, channel, direction,
    party_type, party_id, party_label, body, occurred_at,
    corrects_id, correction_kind, thread_id, attestation,
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
    -- Verified path: provider confirmed the send (sid above); GUC set.
    'provider_verified',
    -- carry the outbox's context onto the journal so the send shows up in
    -- the tenancy / maintenance-request activity feed.
    v_outbox.tenancy_id,
    v_outbox.maintenance_request_id,
    null,
    null,
    case when v_party_type = 'vendor' then v_party_id else null end
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
-- (F) journal_with_participants: manual entry + cast, one transaction
-- ============================================================================
-- The manual capture path's atomic writer: without it the API would need two
-- inserts (row, then cast) with a window where a valid-but-castless entry
-- exists. Self-defending DEFINER in the house shape. Stamps what the manual
-- path IS: attestation='attested' (someone's account of an event — the gate
-- in (B) makes 'provider_verified' unreachable from here by construction),
-- actor from the caller, author_type from the caller's capacity. The
-- interactions BEFORE-INSERT triggers all still fire (the GUC is NOT set),
-- so agent principals keep every existing restriction.

create or replace function public.journal_with_participants(
  p_account_id   uuid,
  p_entry        jsonb,
  p_participants jsonb
)
returns public.interactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_author_type text;
  v_interaction public.interactions%rowtype;
  v_count       int;
  r             record;
begin
  -- Self-defense: live member of the account.
  select m.role into v_role
    from public.account_members m
   where m.user_id = auth.uid()
     and m.account_id = p_account_id
     and m.deleted_at is null;
  if auth.uid() is null or v_role is null then
    raise exception 'not authorized to journal for this account'
      using errcode = '42501';
  end if;

  -- Agent principals are refused OUTRIGHT: an agent's communications are
  -- journaled (with their cast) by the verified comms paths, and an agent
  -- note carries no cast — so an agent calling this could only be
  -- fabricating an unverifiable record of who was contacted. (The capacity
  -- trigger would also reject the insert — external_ref is required on
  -- agent communications and this path never carries one — but the intent
  -- deserves its own explicit gate, not a fortunate trigger interaction.)
  if v_role = 'agent' then
    raise exception 'agent principals may not journal manual participants'
      using errcode = '42501';
  end if;

  -- Capacity from the principal, never from the caller's body.
  v_author_type := 'landlord';

  -- Only communications carry a cast (notes structurally have no party;
  -- agent_events are workflow exhaust).
  if coalesce(p_entry->>'kind', 'communication') <> 'communication' then
    raise exception 'participants are only recordable on communication entries'
      using errcode = '22023';
  end if;

  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then
    raise exception 'participants must be a json array'
      using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_participants);
  if v_count < 1 or v_count > 20 then
    raise exception 'participants must contain between 1 and 20 entries'
      using errcode = '22023';
  end if;

  insert into public.interactions (
    account_id, actor, author_type, kind, channel, direction,
    party_type, party_id, party_label, body, occurred_at, attestation,
    tenancy_id, maintenance_request_id, area_id, work_order_id, vendor_id
  ) values (
    p_account_id,
    'user:' || auth.uid(),
    v_author_type,
    'communication',
    p_entry->>'channel',
    p_entry->>'direction',
    coalesce(p_entry->>'party_type', 'unspecified'),
    nullif(p_entry->>'party_id', '')::uuid,
    p_entry->>'party_label',
    p_entry->>'body',
    coalesce((p_entry->>'occurred_at')::timestamptz, now()),
    'attested',
    nullif(p_entry->>'tenancy_id', '')::uuid,
    nullif(p_entry->>'maintenance_request_id', '')::uuid,
    nullif(p_entry->>'area_id', '')::uuid,
    nullif(p_entry->>'work_order_id', '')::uuid,
    nullif(p_entry->>'vendor_id', '')::uuid
  )
  returning * into v_interaction;

  for r in
    select e->>'role'                       as role,
           e->>'party_type'                 as party_type,
           nullif(e->>'party_id', '')::uuid as party_id,
           e->>'address'                    as address,
           e->>'label'                      as label
      from jsonb_array_elements(p_participants) e
  loop
    if r.role is null or r.role not in ('sender', 'recipient', 'cc', 'attendee') then
      raise exception 'invalid participant role: %', coalesce(r.role, '(null)')
        using errcode = '22023';
    end if;
    -- 'platform' is reserved for the verified comms paths: a manual entry
    -- has no wire leg to claim.
    if r.party_type is null or r.party_type not in
       ('tenant', 'landlord_user', 'vendor', 'agent', 'inspector', 'other', 'unknown') then
      raise exception 'invalid participant party_type: %', coalesce(r.party_type, '(null)')
        using errcode = '22023';
    end if;
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, r.role, r.party_type, r.party_id,
       r.address, r.label, 'capture');
  end loop;

  return v_interaction;
end;
$$;

revoke execute on function public.journal_with_participants(uuid, jsonb, jsonb) from public;
revoke execute on function public.journal_with_participants(uuid, jsonb, jsonb) from anon;
grant  execute on function public.journal_with_participants(uuid, jsonb, jsonb) to authenticated, service_role;

-- ============================================================================
-- (G) interactions_with_chain: re-create so the view picks up the new column
-- ============================================================================
-- The view's `i.*` was expanded at creation (20260701000004) and does not see
-- columns added later; definition otherwise verbatim. Participants are NOT
-- aggregated here — the API embeds them via a batched loader (one query per
-- page), the same pattern comms thread participants already use.

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
