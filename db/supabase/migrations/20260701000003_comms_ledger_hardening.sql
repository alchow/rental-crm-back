-- ----------------------------------------------------------------------------
-- Comms ledger hardening (post-ACK adversarial review of 20260701000002).
--
-- All fixes are DB-internal and CONTRACT-NEUTRAL: no endpoint, request, or
-- response shape changes, so the broadcast OpenAPI sha is unaffected. Each
-- closes a cross-account or evidence-honesty hole reachable ONLY by a member
-- writing through PostgREST directly (the API layer already gates these; RLS +
-- triggers + function grants are the real boundary).
--
-- F1 (HIGH) — agent author-type laundering. comm_outbox has a `for all`
--   member RLS policy and no agent-capacity guard at INSERT, so an agent-role
--   member could directly insert an outbox row with author_type='landlord'
--   (+ a grant: approval_ref to satisfy the provenance CHECK), then call
--   complete_send — which is SECURITY DEFINER, trusts outbox.author_type, and
--   sets the comm.verified_write GUC that exempts _enforce_agent_capacity —
--   minting a HUMAN-attributed kind='communication' journal row the agent
--   fabricated. The dropped predecessor's complete_sms_send was SECURITY
--   INVOKER, so that same journal insert fired the capacity trigger AS the
--   agent and was rejected; the DEFINER+GUC generalization removed the shadow.
--   Fix: a BEFORE INSERT capacity trigger on comm_outbox (the operational-tier
--   twin of _enforce_agent_capacity) forcing agent-role inserters to
--   author_type='agent'. author_type is already immutable post-insert
--   (_comm_outbox_guard_update), so pinning it at birth locks it. Also pins
--   birth status to 'queued' (the outbox-first invariant) for every inserter.
--
-- F2 (MEDIUM) — capture_inbound dedupe not account-pinned. The replay lookup
--   and the unique-violation re-read keyed on provider_msg_id ALONE (globally
--   UNIQUE, no account column), so an agent of A could read account B's cached
--   match ids/disposition, or pre-claim a provider_msg_id and suppress B's
--   real capture. Fix: stamp matched_account_id at first insert and pin both
--   reads to it; a provider_msg_id already held by another account raises
--   rather than returning foreign data or a poisoned dedupe.
--
-- F3/F4 (MEDIUM) — opt-out register metadata leak. comm_opt_outs is global
--   (keyed by address, no account) and its keyword/source_ref (a provider msg
--   id from whoever first reported the opt-out) leaked cross-account through
--   list_account_opt_outs (whose channel_identities intersection is member-
--   forgeable) and record_opt_out (which echoed the pre-existing foreign row).
--   The per-address boolean is inherent (a send attempt reveals it via the
--   opt-out INSERT trigger), so THAT is accepted; but the recording metadata
--   must never cross accounts. Fix: neither RPC returns keyword/source_ref for
--   a row it did not create in the same call — record_opt_out returns the
--   fresh row's metadata only when it actually inserted; list_account_opt_outs
--   never returns metadata (a landlord needs "which of my contacts opted out
--   and when", not another account's message refs).
--
-- F5 (MEDIUM) — cross-account routing DoS. thread_channel_bindings.platform_
--   number FK referenced platform_numbers(number) (global), not the binding's
--   account, and FK validation bypasses RLS — so a member of A could bind B's
--   platform number and, via the global (platform_number, participant_address)
--   WHERE active unique index, occupy B's inbound routing slot. Fix: pin the
--   FK to (account_id, platform_number).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- F1 + F6 — comm_outbox birth capacity/status guard
-- ============================================================================
create or replace function public._enforce_comm_outbox_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Every intent is born 'queued' (outbox-first invariant). Applies to all
  -- inserters; the API never sets status on create, so this only bites a
  -- direct-PostgREST writer trying to birth a row mid-lifecycle.
  if new.status is distinct from 'queued' then
    raise exception 'a comm_outbox intent must be created with status=queued'
      using errcode = 'check_violation';
  end if;

  -- Admin/service path (no JWT): unconstrained.
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

create trigger comm_outbox_enforce_capacity
  before insert on public.comm_outbox
  for each row execute function public._enforce_comm_outbox_capacity();

-- ============================================================================
-- F5 — pin thread_channel_bindings.platform_number to the binding's account
-- ============================================================================
-- platform_numbers.number is already globally UNIQUE, so this composite is
-- trivially satisfiable and provides the referenced key for the composite FK.
alter table public.platform_numbers
  add constraint platform_numbers_account_number_uniq unique (account_id, number);

alter table public.thread_channel_bindings
  drop constraint thread_channel_bindings_platform_number_fkey;
alter table public.thread_channel_bindings
  add constraint thread_channel_bindings_platform_number_fkey
  foreign key (account_id, platform_number)
  references public.platform_numbers (account_id, number)
  on delete restrict;

-- ============================================================================
-- F2 — capture_inbound: account-pinned dedupe/replay
-- ============================================================================
create or replace function public.capture_inbound(
  p_account_id      uuid,
  p_provider        text,
  p_provider_msg_id text,
  p_to_number       text,
  p_from_address    text,
  p_channel         text,
  p_body            text,
  p_media           jsonb,
  p_received_at     timestamptz
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

  -- Resolve the active binding for (platform number, counterparty address),
  -- pinned to the calling account (a number reassigned across accounts must
  -- never leak another account's thread).
  select b.thread_id as b_thread_id, b.participant_id as b_participant_id
    into v_binding
    from public.thread_channel_bindings b
   where b.platform_number = p_to_number
     and b.participant_address = p_from_address
     and b.active
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

revoke execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz) from public;
revoke execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz) from anon;
grant  execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz) to authenticated, service_role;

-- ============================================================================
-- F4 — record_opt_out: never echo another account's recording metadata
-- ============================================================================
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

  -- Park queued-but-unsent intents to this address (compliance is global).
  update public.comm_outbox
     set status        = 'undeliverable',
         error_code    = 'opted_out',
         error_message = 'destination opted out before dispatch',
         updated_at    = now()
   where status = 'queued'
     and channel = p_channel
     and to_address = p_address;

  return v_row;
end;
$$;

revoke execute on function public.record_opt_out(uuid, text, text, text, text) from public;
revoke execute on function public.record_opt_out(uuid, text, text, text, text) from anon;
grant  execute on function public.record_opt_out(uuid, text, text, text, text) to authenticated, service_role;

-- ============================================================================
-- F3 — list_account_opt_outs: existence + timestamp only, no recording metadata
-- ============================================================================
create or replace function public.list_account_opt_outs(
  p_account_id uuid,
  p_channel    text default null
)
returns setof public.comm_opt_outs
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = p_account_id
       and m.deleted_at is null
  ) then
    raise exception 'not authorized to list opt-outs for this account'
      using errcode = '42501';
  end if;

  -- The channel_identities intersection scopes WHICH addresses are visible;
  -- keyword/source_ref are nulled because the register is global and carries
  -- no account provenance, so a stored keyword/source_ref may belong to a
  -- different account. A landlord needs which-of-my-contacts-opted-out-and-
  -- when, not another account's message refs.
  return query
    select oo.channel, oo.address, oo.opted_out_at, null::text, null::text
      from public.comm_opt_outs oo
     where (p_channel is null or oo.channel = p_channel)
       and exists (
         select 1 from public.channel_identities ci
          where ci.account_id = p_account_id
            and ci.channel = oo.channel
            and ci.address = oo.address
       )
     order by oo.opted_out_at desc;
end;
$$;

revoke execute on function public.list_account_opt_outs(uuid, text) from public;
revoke execute on function public.list_account_opt_outs(uuid, text) from anon;
grant  execute on function public.list_account_opt_outs(uuid, text) to authenticated, service_role;
