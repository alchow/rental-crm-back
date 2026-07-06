-- ----------------------------------------------------------------------------
-- RFC822 email headers + duplicate detection (persona plan, phase 2).
--
-- Core stored NO email headers: inbound dedupe was provider_msg_id only, which
-- identifies a RECEIPT, not the email. One email delivered to two platform
-- mailboxes (a reply token AND — from phase 3 — the persona address) arrives
-- as two receipts with two provider ids and would journal twice. The email's
-- own identity is its Message-ID header, stamped once by the sender's client.
--
-- This migration:
--   (A) stores the inbound Message-ID on inbound_raw + interactions, and the
--       SENT Message-ID on comm_outbox (reported by the transport at
--       completion) — the raw tier is retention-pruned, the journal is the
--       durable copy, and the outbox copy lets relay legs thread natively
--       (In-Reply-To/References) in recipients' mail clients;
--   (B) widens the inbound_raw disposition vocabulary: 'duplicate' (this
--       phase) plus 'cc_journaled' and 'triaged' (pre-added for phases 3-4 so
--       the constraint is churned once);
--   (C) adds a soft, account+thread-scoped dedupe to capture_inbound: a
--       matched email whose normalized Message-ID already journaled into the
--       SAME thread returns disposition 'duplicate' with the ORIGINAL ids and
--       writes nothing new. Soft on purpose: Message-IDs are client-generated
--       and forgeable, so they are never a unique constraint, and a forged
--       duplicate can only suppress the forger's own message. Cross-thread
--       repeats (legitimate cross-posts) still journal.
--   (D) capture_inbound also accepts subject / in_reply_to / references /
--       auth verdicts (spf/dkim/dmarc), all riding into inbound_raw.payload —
--       subject is NOT folded into the journal body (journal shape unchanged;
--       phase 3+ decides rendering), headers feed the phase-8 gap detector,
--       verdicts feed the phase-3/4 attribution gates.
--
-- Signature-change mechanics follow the repo precedent (20260702000001:598):
-- DROP the old signature and CREATE the new one whose added params all carry
-- defaults — an already-deployed API calling with the old named-param set
-- still resolves (PostgREST fills the defaults). NO delegating wrapper: a
-- second overload accepting the same named-arg subset would make PostgREST's
-- function resolution ambiguous (HTTP 300), which is worse than the thing it
-- would guard against.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) columns
-- ============================================================================

alter table public.inbound_raw
  add column rfc822_message_id text
    check (rfc822_message_id is null or length(rfc822_message_id) between 3 and 998);

alter table public.interactions
  add column rfc822_message_id text
    constraint interactions_rfc822_message_id_len
    check (rfc822_message_id is null or length(rfc822_message_id) between 3 and 998);

-- The dedupe probe: "has this Message-ID already journaled in this account?"
create index interactions_rfc822_message_id_idx
  on public.interactions (account_id, rfc822_message_id)
  where rfc822_message_id is not null;

-- The SENT Message-ID, reported by the transport on completion. Lets a later
-- relay leg cite the platform-sent message it continues.
alter table public.comm_outbox
  add column rfc822_message_id text
    check (rfc822_message_id is null or length(rfc822_message_id) between 3 and 998);

-- ============================================================================
-- (B) inbound_raw: admit the new dispositions (discover-by-definition — the
--     constraint has been dropped/re-added before; never hardcode its name)
-- ============================================================================

do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.inbound_raw'::regclass
    and contype  = 'c'
    and pg_get_constraintdef(oid) ilike '%disposition%matched%';
  if c is not null then
    execute format('alter table public.inbound_raw drop constraint %I', c);
  end if;
end $$;

alter table public.inbound_raw
  add constraint inbound_raw_disposition_check
  check (disposition in (
    'matched', 'orphan', 'opted_out', 'sender_mismatch',
    'duplicate', 'cc_journaled', 'triaged'
  ));

-- ============================================================================
-- (C) Message-ID normalization — one canonical form everywhere
-- ============================================================================
-- RFC 5322 Message-IDs conventionally arrive wrapped in angle brackets and
-- with arbitrary case. Dedupe is string equality, so every writer (capture,
-- complete) canonicalizes identically: trim, strip ONE layer of <>, lowercase.
-- (Case-sensitivity purists note: lowercasing is technically lossy, but it is
-- applied uniformly on both sides of every comparison, which is all equality
-- needs.)
--
-- Degrade-to-null rule: the destination columns CHECK length(NORMALIZED)
-- between 3 and 998, while the API validates min(3) on the RAW value (brackets
-- included) — so a well-formed-looking '<a>' passes the API but normalizes to a
-- 1-char 'a' the CHECK would reject, aborting the whole capture. Dedupe is
-- BEST-EFFORT and a bad Message-ID must NEVER fail the evidentiary capture
-- path, so any normalized result whose length falls outside 3..998 (the empty
-- string included) collapses to null: the message still journals, it simply
-- does not participate in dedupe.

create or replace function public._comm_normalize_msgid(p_raw text)
returns text
language sql
immutable
set search_path = public
as $$
  with n as (
    select lower(regexp_replace(btrim(coalesce(p_raw, '')), '^<(.*)>$', '\1')) as v
  )
  select case when length(v) between 3 and 998 then v else null end from n;
$$;

revoke execute on function public._comm_normalize_msgid(text) from public;
revoke execute on function public._comm_normalize_msgid(text) from anon;
grant  execute on function public._comm_normalize_msgid(text) to authenticated, service_role;

-- ============================================================================
-- (D) capture_inbound: headers + verdicts + same-thread duplicate detection
-- ============================================================================
-- Body identical to 20260703000003 except: the five new defaulted params, the
-- payload/rfc822 stamping on the raw insert, the duplicate check once a
-- binding matched, and rfc822_message_id on the journal insert.

drop function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[]);

create function public.capture_inbound(
  p_account_id        uuid,
  p_provider          text,
  p_provider_msg_id   text,
  p_to_number         text,
  p_from_address      text,
  p_channel           text,
  p_body              text,
  p_media             jsonb,
  p_received_at       timestamptz,
  p_cc                text[] default null,
  p_subject           text default null,
  p_rfc822_message_id text default null,
  p_in_reply_to       text default null,
  p_references        text[] default null,
  p_auth_results      jsonb default null
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
  -- Self-enforcing (defense in depth): the header fields are email-only. Only
  -- normalize/keep the Message-ID on an email capture so a direct PostgREST
  -- caller cannot smuggle one onto an sms/group message past the API tier.
  v_msgid        text := case when p_channel = 'email'
                              then public._comm_normalize_msgid(p_rfc822_message_id)
                              else null end;
  v_dup_id       uuid;
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

revoke execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[], text, text, text, text[], jsonb) from public;
revoke execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[], text, text, text, text[], jsonb) from anon;
grant  execute on function public.capture_inbound(uuid, text, text, text, text, text, text, jsonb, timestamptz, text[], text, text, text, text[], jsonb) to authenticated, service_role;

-- ============================================================================
-- (E) complete_send: stamp the sent Message-ID on the outbox + journal
-- ============================================================================
-- Body identical to 20260703000003 except: the new defaulted param, the
-- rfc822 stamping on both completion UPDATEs, and the journal insert column.

drop function public.complete_send(uuid, text, text);

create function public.complete_send(
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
    null,
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

revoke execute on function public.complete_send(uuid, text, text, text) from public;
revoke execute on function public.complete_send(uuid, text, text, text) from anon;
grant  execute on function public.complete_send(uuid, text, text, text) to authenticated, service_role;

-- PostgREST caches function signatures; reload so the new params are callable
-- immediately (matters on prod, where the next deploy may lag the migration).
notify pgrst, 'reload schema';
