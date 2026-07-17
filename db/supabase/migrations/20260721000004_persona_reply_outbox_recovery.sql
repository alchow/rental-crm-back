-- ---------------------------------------------------------------------------
-- Recover a landlord's persona reply from the outbound Message-ID.
--
-- Mobile Reply All can legally render only the message's Reply-To (the account
-- persona), omitting the original tenant from the new MIME To/Cc headers. The
-- old persona classifier then had no counterparty address to resolve and
-- triaged the mail even though Core had sent the parent message:
--
--   bare outbox (To tenant, Cc landlord) -> SMTP2GO -> phone reply
--   -> In-Reply-To parent id, To persona only -> triage
--
-- This wrapper recovers the frozen outbox context before invoking the existing
-- classifier. It is deliberately triple-gated: DMARC pass, an account-scoped
-- completed outbox Message-ID match, and a frozen Cc snapshot that identifies
-- the sender as a landlord_user. Gmail dots and +tags are mailbox aliases, so
-- that one provider is compared canonically; no other domain gets alias rules.
-- ---------------------------------------------------------------------------

alter table public.comm_unmatched_inbound
  drop constraint comm_unmatched_inbound_reason_check;
alter table public.comm_unmatched_inbound
  add constraint comm_unmatched_inbound_reason_check
  check (reason in ('unknown_sender', 'auth_failed', 'identity_conflict'));

create function public._comm_canonical_email_address(p_address text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select case
    when length(p_address) - length(replace(p_address, '@', '')) = 1
      and split_part(lower(btrim(p_address)), '@', 2) in ('gmail.com', 'googlemail.com')
      then replace(
             split_part(split_part(lower(btrim(p_address)), '@', 1), '+', 1),
             '.',
             ''
           ) || '@gmail.com'
    else lower(btrim(p_address))
  end
$$;

revoke execute on function public._comm_canonical_email_address(text) from public;
revoke execute on function public._comm_canonical_email_address(text) from anon;
revoke execute on function public._comm_canonical_email_address(text) from authenticated;

alter function public.capture_persona_inbound(
  uuid, text, text, text, text, text, text[], text[], text, text, jsonb,
  text, text, text[], text, text, text, timestamptz, text
) rename to _capture_persona_inbound_before_reply_recovery;

revoke execute on function public._capture_persona_inbound_before_reply_recovery(
  uuid, text, text, text, text, text, text[], text[], text, text, jsonb,
  text, text, text[], text, text, text, timestamptz, text
) from public;
revoke execute on function public._capture_persona_inbound_before_reply_recovery(
  uuid, text, text, text, text, text, text[], text[], text, text, jsonb,
  text, text, text[], text, text, text, timestamptz, text
) from anon;
revoke execute on function public._capture_persona_inbound_before_reply_recovery(
  uuid, text, text, text, text, text, text[], text[], text, text, jsonb,
  text, text, text[], text, text, text, timestamptz, text
) from authenticated;
revoke execute on function public._capture_persona_inbound_before_reply_recovery(
  uuid, text, text, text, text, text, text[], text[], text, text, jsonb,
  text, text, text[], text, text, text, timestamptz, text
) from service_role;

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
  v_raw public.inbound_raw%rowtype;
  v_landlord_id uuid;
  v_original_to text;
  v_bound_party_type text;
  v_bound_party_id uuid;
  v_identity_conflict boolean := false;
  v_effective_dmarc text := p_dmarc;
  v_to_addresses text[] := coalesce(p_to_addresses, '{}'::text[]);
begin
  -- Match the wrapped function's authorization before reading replay state or
  -- mutating an alias. The transaction lock closes the concurrent replay gap:
  -- after the first caller records inbound_raw, later callers return its frozen
  -- result without reconsidering changed sender/auth/reference inputs.
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

  perform pg_advisory_xact_lock(
    hashtextextended('capture_persona_inbound:' || p_provider_msg_id, 0)
  );

  unmatched_id := null;
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

  if p_dmarc = 'pass' then
    select o.to_address, nullif(cc.entry->>'party_id', '')::uuid
      into v_original_to, v_landlord_id
      from public.comm_outbox o
      cross join lateral jsonb_array_elements(
        coalesce(o.recipient_snapshot, '[]'::jsonb)
      ) cc(entry)
     where o.account_id = p_account_id
       and o.channel = 'email'
       and o.status in ('sent', 'delivered')
       and o.to_address is not null
       and o.rfc822_message_id is not null
       and (
         public._comm_normalize_msgid(o.rfc822_message_id)
           = public._comm_normalize_msgid(p_in_reply_to)
         or exists (
           select 1
             from unnest(coalesce(p_references, '{}'::text[])) ref(message_id)
            where public._comm_normalize_msgid(o.rfc822_message_id)
                    = public._comm_normalize_msgid(ref.message_id)
         )
       )
       and coalesce(cc.entry->>'role', 'recipient') = 'cc'
       and cc.entry->>'party_type' = 'landlord_user'
       and nullif(cc.entry->>'party_id', '') is not null
       and public._comm_canonical_email_address(cc.entry->>'address')
             = public._comm_canonical_email_address(p_from_address)
     order by o.created_at desc
     limit 1;

    if v_landlord_id is not null and v_original_to is not null then
      -- Learn the exact alias only after the authenticated, snapshotted parent
      -- proves which landlord received it. First-writer-wins remains intact.
      insert into public.channel_identities
        (account_id, party_type, party_id, channel, address)
      values
        (p_account_id, 'landlord_user', v_landlord_id, 'email', p_from_address)
      on conflict (account_id, channel, address) do nothing;

      select ci.party_type, ci.party_id
        into v_bound_party_type, v_bound_party_id
        from public.channel_identities ci
       where ci.account_id = p_account_id
         and ci.channel = 'email'
         and ci.address = p_from_address;

      if v_bound_party_type = 'landlord_user' and v_bound_party_id = v_landlord_id then
        if not (v_original_to = any(v_to_addresses)) then
          v_to_addresses := array_append(v_to_addresses, v_original_to);
        end if;
      else
        -- First-writer-wins conflict: never use the parent to augment a sender
        -- already bound to someone else. Force the legacy classifier's safe
        -- unauthenticated triage path instead of risking wrong-party journaling.
        v_identity_conflict := true;
        v_effective_dmarc := 'none';
      end if;
    end if;
  end if;

  select captured.disposition,
         captured.interaction_id,
         captured.thread_id,
         captured.participant_id,
         captured.unmatched_id
    into disposition, interaction_id, thread_id, participant_id, unmatched_id
    from public._capture_persona_inbound_before_reply_recovery(
        p_account_id,
        p_provider,
        p_provider_msg_id,
        p_persona_address,
        p_from_address,
        p_from_display_name,
        v_to_addresses,
        p_cc_addresses,
        p_subject,
        p_body,
        p_media,
        p_rfc822_message_id,
        p_in_reply_to,
        p_references,
        p_spf,
        p_dkim,
        v_effective_dmarc,
        p_received_at,
        p_reply_domain
      ) captured;

  if v_identity_conflict then
    if disposition is distinct from 'triaged' or unmatched_id is null then
      raise exception 'identity conflict did not take the safe triage path';
    end if;

    -- Classification used `none` only as a fail-closed control signal. Restore
    -- the provider's real verdict in both evidence stores and state the actual
    -- reason for human review.
    update public.inbound_raw
       set payload = jsonb_set(
         payload,
         '{auth_results,dmarc}',
         to_jsonb(p_dmarc),
         true
       )
     where provider_msg_id = p_provider_msg_id
       and matched_account_id = p_account_id;

    update public.comm_unmatched_inbound
       set dmarc = p_dmarc,
           reason = 'identity_conflict',
           updated_at = now()
     where id = unmatched_id
       and account_id = p_account_id;
  end if;

  return next;
end;
$$;

revoke execute on function public.capture_persona_inbound(
  uuid, text, text, text, text, text, text[], text[], text, text, jsonb,
  text, text, text[], text, text, text, timestamptz, text
) from public;
revoke execute on function public.capture_persona_inbound(
  uuid, text, text, text, text, text, text[], text[], text, text, jsonb,
  text, text, text[], text, text, text, timestamptz, text
) from anon;
grant execute on function public.capture_persona_inbound(
  uuid, text, text, text, text, text, text[], text[], text, text, jsonb,
  text, text, text[], text, text, text, timestamptz, text
) to authenticated, service_role;

notify pgrst, 'reload schema';
