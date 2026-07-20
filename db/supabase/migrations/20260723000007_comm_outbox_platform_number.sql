-- ============================================================================
-- Freeze the dialing number on the send intent (evidence integrity)
-- ============================================================================
-- The problem this fixes, as a data flow:
--
--   landlord queues a group text -> agent dials -> complete_send journals it
--     -> OLD: the outbox row said nothing about WHICH number to dial from, so
--        the agent used a single service-wide TELNYX_FROM_NUMBER while
--        complete_send journalled the number it re-derived from the thread
--        binding. With one number per service those happened to agree. Once
--        each account has its own number they can diverge -- and the divergence
--        is silent, because the journal is written from the binding and never
--        compared to the wire.
--     -> NEW: the number is resolved ONCE, at intent time, and frozen on the
--        row. The transport dials exactly that; complete_send records exactly
--        that. Dial and evidence cannot disagree, because they read the same
--        field.
--
-- Why freeze rather than re-derive: a re-derived value answers "which number
-- would we pick now", not "which number went out". Between intent and
-- completion a binding can be rebound, or an account can come to hold more
-- than one active number (thread create picks with `limit 1` and no ordering,
-- so the pick is not even stable). Evidence that disagrees with the wire is
-- worse than no evidence: it is a record that looks authoritative and is
-- wrong.
--
-- The column is nullable and the binding read survives as a fallback, so rows
-- queued before this migration still journal a sender. Email is untouched --
-- its From is the recipient's minted reply token, not a platform number.
--
-- The composite FK to platform_numbers(account_id, number) is what stops a
-- send intent naming a number the account does not own; ON DELETE RESTRICT
-- matches thread_channel_bindings. Numbers are retired by flipping status to
-- 'released', never deleted, so the restriction does not bind in practice.
-- ============================================================================

alter table public.comm_outbox
  add column if not exists platform_number text;

alter table public.comm_outbox
  drop constraint if exists comm_outbox_platform_number_fkey;
alter table public.comm_outbox
  add constraint comm_outbox_platform_number_fkey
  foreign key (account_id, platform_number)
  references public.platform_numbers (account_id, number)
  on delete restrict;

-- complete_send: prefer the frozen number over a fresh binding read.
-- Body is otherwise byte-identical to 20260723000005's; the only change is the
-- new `elsif v_outbox.platform_number is not null` arm in the sender-address
-- resolution, plus its comment.
CREATE OR REPLACE FUNCTION "public"."complete_send"("p_outbox_id" "uuid", "p_provider" "text", "p_provider_sid" "text", "p_rfc822_message_id" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
  v_dup_outbox_id  uuid;
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

  -- Graceful duplicate-Message-ID handling (PR 6, the one addition): a
  -- DIFFERENT email row of the same account already holding this normalized
  -- Message-ID means a provider retry/reconcile echo re-reported an id that
  -- is already evidence elsewhere. Never fail the completion: stamp NULL on
  -- this row (it simply opts out of parent-probe dedupe) and say so loudly.
  -- This is what lets §C below make the msgid index UNIQUE.
  if v_msgid is not null and v_outbox.channel = 'email' then
    select o.id into v_dup_outbox_id
      from public.comm_outbox o
     where o.account_id = v_outbox.account_id
       and o.channel = 'email'
       and o.id <> v_outbox.id
       and o.rfc822_message_id is not null
       and public._comm_normalize_msgid(o.rfc822_message_id) = v_msgid
     limit 1;
    if v_dup_outbox_id is not null then
      raise warning
        'duplicate rfc822_message_id — evidence kept on the first row (first=%, completing=%)',
        v_dup_outbox_id, v_outbox.id;
      v_msgid := null;
    end if;
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
        -- Claims-aware fallback (PR 2 review fix): consult LIVE, scope-
        -- applicable claims through the one resolver. Exactly one party wins;
        -- a multi-claim conflict or a superseded-only address degrades to the
        -- 'unspecified' sentinel below instead of casting an arbitrary row.
        if (select count(*)
              from public._comm_resolve_identity_claims(
                     v_outbox.account_id, v_outbox.channel, v_outbox.to_address,
                     v_outbox.tenancy_id, v_outbox.thread_id)) = 1 then
          select case r.party_type
                   when 'tenant' then 'tenant'
                   when 'vendor' then 'vendor'
                   else 'other'
                 end,
                 r.party_id,
                 r.party_type,
                 public._party_display_name(v_outbox.account_id, r.party_type, r.party_id)
            into v_party_type, v_party_id, v_cast_type, v_name
            from public._comm_resolve_identity_claims(
                   v_outbox.account_id, v_outbox.channel, v_outbox.to_address,
                   v_outbox.tenancy_id, v_outbox.thread_id) r;
        end if;
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
  --
  -- For sms the FROZEN value on the row wins. It is the number the transport
  -- was told to dial from, so recording it makes the journal name what the
  -- carrier actually saw. Re-deriving from the binding at completion time
  -- could name a different number than the one dialed (a rebind between intent
  -- and completion, or an account that has come to hold more than one active
  -- number), and evidence that disagrees with the wire is worse than none.
  -- The binding read stays as the fallback for rows created before
  -- comm_outbox.platform_number existed.
  --
  -- The frozen arm excludes email in the FUNCTION, not just at the call site:
  -- today no writer sets platform_number on an email row, but a bare email row
  -- (participant_id null) that somehow carried one would otherwise journal a
  -- phone number as the mail's From. The invariant belongs to the evidence
  -- writer, not to the callers' good behavior.
  if v_outbox.channel = 'email' and v_outbox.participant_id is not null then
    select b.reply_address into v_sender_address
      from public.thread_channel_bindings b
     where b.account_id = v_outbox.account_id
       and b.thread_id = v_outbox.thread_id
       and b.participant_id = v_outbox.participant_id
       and b.active;
  elsif v_outbox.channel <> 'email' and v_outbox.platform_number is not null then
    v_sender_address := v_outbox.platform_number;
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
