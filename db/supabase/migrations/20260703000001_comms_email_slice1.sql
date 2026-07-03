-- ----------------------------------------------------------------------------
-- Comms ledger — email channel, slice 1 (send-only). Work item E1-A, core side.
--
-- The email channel reuses the whole outbox→complete pipeline; this slice adds
-- only what email needs that sms didn't:
--
--   comm_outbox.subject     email subject line, frozen at intent time like
--                           every other intent field. Email-only (CHECK) — an
--                           sms row never carries one. On completion the
--                           journal records the FULL content honestly:
--                           body := 'Subject: <subject>' || E'\n\n' || body
--                           (shape documented in coordination/STATUS.md so the
--                           transport renders templates to match).
--   system:<flow> provenance
--                           core-originated transactional sends (first user:
--                           the inspection-capture renewal email) enter the
--                           pipeline as outbox intents CREATED BY CORE's
--                           server tier. That is a third honest provenance
--                           class: no human approved the specific message and
--                           no standing grant covers it — a fixed server flow
--                           produced it. approval_ref='system:<flow>' pairs
--                           with author_type='system' (both or neither), and
--                           the capacity trigger restricts the pair to the
--                           service tier (auth.uid() IS NULL): no JWT-bearing
--                           principal — member or agent — can mint one over
--                           PostgREST or the API.
--   record_opt_out service tier
--                           the CAN-SPAM unsubscribe endpoint is public
--                           (magic-link pattern) and writes through core's
--                           admin client, which presents no JWT. The guard
--                           gains an explicit service-tier allowance:
--                           auth.uid() IS NULL can only be a direct/service
--                           connection here because anon and PUBLIC have no
--                           EXECUTE on the function and every `authenticated`
--                           JWT carries a sub claim.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) comm_outbox.subject — email-only, frozen at intent time
-- ============================================================================

alter table public.comm_outbox
  add column subject text
    check (length(subject) between 1 and 998);

alter table public.comm_outbox
  add constraint comm_outbox_subject_email_only
  check (subject is null or channel = 'email');

-- ============================================================================
-- (B) author_type gains 'system'; provenance CHECK gains the system: arm
-- ============================================================================
-- Both original CHECKs were inline (conventional, not guaranteed names) —
-- locate by definition, same pattern as 20260701000004.

do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.comm_outbox'::regclass
    and contype  = 'c'
    and pg_get_constraintdef(oid) ilike '%author_type%landlord%';
  if c is not null then
    execute format('alter table public.comm_outbox drop constraint %I', c);
  end if;
end $$;

alter table public.comm_outbox
  add constraint comm_outbox_author_type_check
  check (author_type in ('landlord', 'agent', 'system'));

alter table public.comm_outbox
  drop constraint comm_outbox_provenance_check;
alter table public.comm_outbox
  add constraint comm_outbox_provenance_check
  check (
    approved_by is not null
    or approval_ref like 'grant:%'
    or (approval_ref like 'thread:%' and relay_of_interaction_id is not null)
    or (approval_ref like 'system:%' and approved_by is null)
  );

-- system provenance and system authorship are one thing: both or neither.
alter table public.comm_outbox
  add constraint comm_outbox_system_pairing
  check ((approval_ref like 'system:%') = (author_type = 'system'));

-- ============================================================================
-- (C) Capacity/birth guard: system: is service-tier-only; subject frozen
-- ============================================================================
-- Full rebuild of the 20260702000001 version, adding the system-tier rule.
-- (The guard-update trigger below freezes subject post-insert.)

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

-- Guard-update rebuild: subject joins the frozen intent fields (what was
-- promised in the subject line must survive exactly as dialed).
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

-- ============================================================================
-- (D) complete_send: the journal records the FULL email content
-- ============================================================================
-- Body identical to 20260702000001 except the journal body for email rows
-- with a subject: 'Subject: <subject>' + blank line + body. One documented
-- shape (STATUS.md) so the transport's template rendering and the journal
-- stay honest about the same content. interactions.body is unconstrained, so
-- the concatenation cannot overflow a CHECK.

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
  v_outbox       public.comm_outbox%rowtype;
  v_interaction  public.interactions%rowtype;
  v_party_type   text;
  v_party_id     uuid;
  v_party_label  text;
  v_author_type  text;
  v_journal_body text;
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

  -- The journal records the full content the recipient saw: for an email
  -- with a subject, subject line + blank line + body (documented shape).
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
    v_journal_body,
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
-- (E) record_opt_out: explicit service-tier allowance
-- ============================================================================
-- Same contract as 20260702000001; only the guard changes. auth.uid() IS NULL
-- can only be core's service tier or a direct DB connection: PUBLIC and anon
-- have no EXECUTE here, and every `authenticated` JWT carries a sub claim.
-- The public unsubscribe endpoint (CAN-SPAM / RFC 8058) registers through
-- this path with p_account_id null — the register is global, and the
-- membership check is meaningless for a service-tier caller.

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
  if auth.uid() is not null and not exists (
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
