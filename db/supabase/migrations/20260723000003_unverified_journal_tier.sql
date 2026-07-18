-- ============================================================================
-- Unverified-journal tier — non-DMARC persona mail from a KNOWN sender
-- ============================================================================
-- PRODUCT DECISION (user, on record). Legal rationale: notice law makes
-- RECEIPT the operative fact; a triage queue nobody processes is a liability;
-- receipt ≠ attribution. So a persona inbound that fails DMARC but claims to
-- come from EXACTLY ONE known tenant/vendor stops triaging and starts
-- JOURNALING:
--
--   forged-or-unauthenticated From tenant@example.test
--     -> _comm_resolve_persona_candidates (the SAME account-scope resolution
--        the no-parent pass path uses), plus a unique parent's tier-1
--        thread-participant match (a parent-named recipient is a candidate
--        even when the address carries no live claim)
--     -> exactly one tenant/vendor candidate
--     -> journal into that party's conversation (find-or-create exactly as
--        the matched path, parent context honored) with
--        attestation = 'unverified' — CLAIMED, never asserted
--     -> disposition 'journaled_unverified' (additive), routing_decision
--        reason 'unverified_single_claim'
--
-- CRITICAL INVARIANTS of the new arm:
--   (a) NO channel_identities learning — failed auth never teaches an alias;
--   (b) no stranger ack (the route acks only 'triaged');
--   (c) no relay — the transport relays only on 'matched', and nothing else
--       in core keys on the capture disposition;
--   (d) the same-thread rfc822 Message-ID dedupe still applies;
--   (e) provider_msg_id replays return the frozen original.
--
-- Everything else in the failed-DMARC branch keeps today's behavior:
--   * a single landlord_user candidate  -> triage 'auth_failed' (an
--     unverified OUTBOUND-authored journal row would put words in the
--     landlord's mouth);
--   * zero candidates                   -> 'auth_failed' when a valid parent
--     recognizes the reference, else 'unknown_sender';
--   * multiple candidates               -> 'identity_conflict'.
-- 'auth_failed' therefore becomes unreachable for tenant/vendor single-claim
-- senders; the enum value stays (historical rows).
-- DMARC-pass paths are byte-identical.
--
-- Human follow-ups on an unverified row (owner|manager, DEFINER RPCs below):
--   * retract_unverified_interaction — soft delete with a mandatory reason
--     (deleted_at/updated_at advance together per the softDeleteStamp
--     convention, plus deleted_by/deleted_reason added here). inbound_raw
--     stays untouched: the receipt evidence outlives the retraction.
--   * confirm_unverified_sender — flips attestation 'unverified'->'attested'
--     (the ONE legal transition, announced to the immutability guard via the
--     transaction-local comm.attestation_upgrade GUC) and writes a human_link
--     claim with the SAME semantics as link_unmatched_inbound (supersede
--     differing learned/legacy claims, 409 on a differing live human claim),
--     stamping confirmed_by/confirmed_at. Future mail from that address then
--     resolves normally.
--
-- interactions_with_chain is deliberately NOT re-created: deleted_at (the
-- default-read filter) is already exposed; the new bookkeeping columns stay
-- table-side so every existing read contract is byte-identical.
--
-- Routing generation stays 2 (routing_decision.version and
-- comm_persona_routing_version()): the tier is additive inside the v2
-- classifier. For byte-level deploy certainty use the pg_get_functiondef
-- digest documented in docs/persona-email-contract.md.
-- ============================================================================

-- ============================================================================
-- (A) interactions — 'unverified' attestation + retract/confirm bookkeeping
-- ============================================================================

alter table public.interactions
  drop constraint interactions_attestation_check;
alter table public.interactions
  add constraint interactions_attestation_check
  check (attestation is null
         or attestation in ('provider_verified', 'attested', 'imported', 'unverified'));

-- Soft-delete provenance (the table already carries deleted_at; the house
-- softDeleteStamp convention advances deleted_at and updated_at together —
-- the retract RPC below follows it) + confirm provenance.
alter table public.interactions
  add column deleted_by     uuid,
  add column deleted_reason text
    constraint interactions_deleted_reason_check
    check (deleted_reason is null or length(deleted_reason) between 1 and 500),
  add column confirmed_by   uuid,
  add column confirmed_at   timestamptz;

-- Provenance is never stamped on a live row / half-stamped on a confirm.
alter table public.interactions
  add constraint interactions_delete_stamp_pairing
  check (deleted_at is not null or (deleted_by is null and deleted_reason is null));
alter table public.interactions
  add constraint interactions_confirm_pairing
  check ((confirmed_by is null) = (confirmed_at is null));

-- ============================================================================
-- (B) Attestation immutability learns its ONE legal transition
-- ============================================================================
-- 20260703000003 froze attestation absolutely. confirm_unverified_sender must
-- upgrade 'unverified' -> 'attested' (a human vouched); that exact transition
-- is now permitted, but only when the transaction-local GUC announces the
-- confirm path (same mechanism the comm.verified_write forge gate trusts).
-- Everything else — including any other pair of values, and any change made
-- outside the RPC — stays refused at the source.

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
    if not (OLD.attestation = 'unverified'
            and NEW.attestation = 'attested'
            and coalesce(current_setting('comm.attestation_upgrade', true), '') = 'on') then
      raise exception 'interactions.attestation is immutable'
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

-- ============================================================================
-- (C) inbound_raw — the additive disposition
-- ============================================================================

alter table public.inbound_raw
  drop constraint inbound_raw_disposition_check;
alter table public.inbound_raw
  add constraint inbound_raw_disposition_check
  check (disposition in (
    'matched', 'orphan', 'opted_out', 'sender_mismatch',
    'duplicate', 'cc_journaled', 'triaged', 'journaled_unverified'
  ));

-- ============================================================================
-- (D) capture_persona_inbound — the unverified-journal arm
-- ============================================================================
-- Re-created verbatim from the head (20260722000002 §G) with the marked
-- changes only:
--   * the p_dmarc <> 'pass' branch runs the candidate resolution described in
--     the header and either journals (one tenant/vendor candidate) or keeps
--     today's triage;
--   * the shared tail knows the v_unverified flag: disposition
--     'journaled_unverified', attestation 'unverified', NO identity learning,
--     sender cast label = the ADDRESS (a display name would assert the very
--     identity this tier refuses to assert), decision reason
--     'unverified_single_claim'.
-- DMARC-pass paths are byte-identical.

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
  v_raw          public.inbound_raw%rowtype;
  v_interaction  public.interactions%rowtype;
  v_msgid        text := public._comm_normalize_msgid(p_rfc822_message_id);
  v_parent       public.comm_outbox%rowtype;
  v_parent_match text := 'none';
  v_parent_id    uuid;
  v_ctx_tenancy  uuid;
  v_outcome      text;
  v_party_type   text;
  v_party_id     uuid;
  v_party_source text;
  v_cand_count   int := 0;
  v_conflict_pt  text;
  v_conflict_pid uuid;
  v_reason       text;            -- non-null => triage
  v_cc_arm       boolean := false;
  v_unverified   boolean := false; -- 20260723000003: unverified-journal arm
  v_pr_matched   int := 0;
  v_ll_id        uuid;
  v_cp_type      text;
  v_cp_id        uuid;
  v_cp_tier      text;
  v_cp_address   text;
  v_thread_id    uuid;
  v_part_id      uuid;
  v_tenancy_id   uuid;
  v_dup_id       uuid;
  v_disposition  text;
  v_decision     jsonb;
  v_addr         text;
  v_cc_pt        text;
  v_cc_pid       uuid;
  v_cc_n         int;
  r              record;
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

  -- The transaction lock closes the concurrent replay gap: after the first
  -- caller records inbound_raw, later callers return its frozen result
  -- without reconsidering changed sender/auth/reference inputs. (Key
  -- unchanged from the previous chain; the account pins the replay read.)
  perform pg_advisory_xact_lock(
    hashtextextended('capture_persona_inbound:' || p_provider_msg_id, 0)
  );

  -- Idempotent replay from the shared raw tier, account-pinned. The frozen
  -- payload (routing_decision included) is never touched on replay.
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
  -- Classification. The parent probe runs for EVERY capture: it never
  -- substitutes for authentication (§6.3), but it makes the auth-fail triage
  -- reason honest and rides the routing decision.
  -- ---------------------------------------------------------------------
  select f.o_match, f.o_parent_id into v_parent_match, v_parent_id
    from public._comm_find_parent_outbox(p_account_id, p_in_reply_to, p_references) f;

  if p_dmarc is distinct from 'pass' then
    -- -------------------------------------------------------------------
    -- Unverified-journal tier (20260723000003; header). Receipt is the
    -- operative fact: mail claiming to come from EXACTLY ONE known
    -- tenant/vendor journals into that party's conversation, marked
    -- attestation='unverified' — claimed, never asserted. No learning, no
    -- ack, no relay. Everything else keeps today's triage.
    -- -------------------------------------------------------------------
    if v_parent_match = 'unique' then
      select * into v_parent
        from public.comm_outbox o
       where o.id = v_parent_id
         and o.account_id = p_account_id;
      -- Does the unauthenticated From at least name a PHYSICAL recipient of
      -- the parent? (Gmail-canonical compare, same as the pass path.) Gates
      -- whether parent context may scope the conversation below.
      select count(*) into v_pr_matched
        from public._comm_resolve_parent_sender(p_account_id, v_parent_id, p_from_address);
    end if;

    -- The SAME no-parent candidate resolution the pass path uses (account
    -- scope), plus a unique parent's tier-1 thread-participant match: a
    -- parent-named recipient is a candidate even when the address carries no
    -- live claim (e.g. a rebound address whose learned claim was superseded).
    select count(distinct (x.party_type, x.party_id)) into v_cand_count
      from (
        select c.party_type, c.party_id
          from public._comm_resolve_persona_candidates(p_account_id, p_from_address) c
        union
        select s.party_type, s.party_id
          from public._comm_resolve_parent_sender(p_account_id, v_parent_id, p_from_address) s
         where v_parent_match = 'unique'
           and s.tier = 'thread_participant'
           and s.party_id is not null
      ) x;

    if v_cand_count = 1 then
      -- The single candidate; when both arms name it, report the parent's
      -- thread_participant tier (the stronger evidence, matching the ladder).
      select x.party_type, x.party_id, x.source
        into v_party_type, v_party_id, v_party_source
        from (
          select s.party_type, s.party_id, s.tier as source, 1 as pref
            from public._comm_resolve_parent_sender(p_account_id, v_parent_id, p_from_address) s
           where v_parent_match = 'unique'
             and s.tier = 'thread_participant'
             and s.party_id is not null
          union all
          select c.party_type, c.party_id, c.source, 2
            from public._comm_resolve_persona_candidates(p_account_id, p_from_address) c
        ) x
       order by x.pref
       limit 1;
    end if;

    if v_cand_count = 1 and v_party_type in ('tenant', 'vendor') then
      v_unverified := true;
      v_cp_type    := v_party_type;
      v_cp_id      := v_party_id;
      v_cp_address := p_from_address;
      if v_parent_match = 'unique' and v_pr_matched > 0 then
        -- Parent context honored exactly as the matched path — its tenancy,
        -- else its thread's — but only when the sender IS a parent recipient:
        -- an unrelated claimed sender citing someone else's parent must not
        -- be pulled into that conversation's scope.
        v_ctx_tenancy := v_parent.tenancy_id;
        if v_ctx_tenancy is null and v_parent.thread_id is not null then
          select t.tenancy_id into v_ctx_tenancy
            from public.comm_threads t
           where t.account_id = p_account_id and t.id = v_parent.thread_id;
        end if;
        select f.thread_id, f.cp_participant_id, f.tenancy_id
          into v_thread_id, v_part_id, v_tenancy_id
          from public._persona_find_or_create_thread(
            p_account_id, v_cp_type, v_cp_id, v_cp_address,
            p_subject, p_reply_domain, null, null,
            v_parent.thread_id, v_ctx_tenancy) f;
      else
        select f.thread_id, f.cp_participant_id, f.tenancy_id
          into v_thread_id, v_part_id, v_tenancy_id
          from public._persona_find_or_create_thread(
            p_account_id, v_cp_type, v_cp_id, v_cp_address,
            p_subject, p_reply_domain, null, null) f;
      end if;
      if v_thread_id is null then
        -- Known party but no safely selectable conversation — the same
        -- honest triage the matched path uses.
        v_unverified := false;
        v_reason := 'unknown_sender';
      end if;
    elsif v_cand_count > 1 then
      -- Contradictory identity evidence stays a human problem,
      -- authenticated or not.
      v_reason := 'identity_conflict';
    elsif v_cand_count = 1 then
      -- A single landlord_user claimant keeps today's behavior: triage —
      -- never an unverified OUTBOUND-authored journal row.
      v_reason := 'auth_failed';
    else
      -- Nobody recognizes the address; a valid parent reference still makes
      -- the triage reason honest.
      v_reason := case when v_parent_match <> 'none'
        then 'auth_failed' else 'unknown_sender' end;
    end if;

  elsif v_parent_match = 'multiple' then
    -- A Message-ID collision produced multiple parents: conflict, not
    -- "pick the newest".
    v_reason := 'identity_conflict';

  elsif v_parent_match = 'unique' then
    select * into v_parent
      from public.comm_outbox o
     where o.id = v_parent_id
       and o.account_id = p_account_id;

    select c.o_outcome, c.o_party_type, c.o_party_id, c.o_party_source,
           c.o_candidate_count, c.o_conflict_party_type, c.o_conflict_party_id
      into v_outcome, v_party_type, v_party_id, v_party_source,
           v_cand_count, v_conflict_pt, v_conflict_pid
      from public._comm_choose_persona_route(p_account_id, v_parent_id, p_from_address) c;

    if v_outcome = 'parent_sender_mismatch' then
      v_reason := 'parent_sender_mismatch';
    elsif v_outcome = 'identity_conflict' then
      v_reason := 'identity_conflict';
    elsif v_outcome = 'unknown' then
      v_reason := 'unknown_sender';
    else
      -- The parent's conversation scope: its own tenancy, else its thread's.
      v_ctx_tenancy := v_parent.tenancy_id;
      if v_ctx_tenancy is null and v_parent.thread_id is not null then
        select t.tenancy_id into v_ctx_tenancy
          from public.comm_threads t
         where t.account_id = p_account_id and t.id = v_parent.thread_id;
      end if;

      if v_outcome = 'cc_journaled' then
        -- The landlord replied from a parent Cc leg: journal-only, into the
        -- parent's PRIMARY recipient's conversation.
        v_cc_arm := true;
        v_ll_id  := v_party_id;
        select h.o_party_type, h.o_party_id, h.o_tier into v_cp_type, v_cp_id, v_cp_tier
          from public._comm_resolve_parent_recipient(
                 p_account_id, v_parent.thread_id, v_parent.tenancy_id,
                 v_parent.recipient_snapshot, v_parent.to_address) h;
        v_cp_address := v_parent.to_address;
        if v_cp_tier = 'claim_conflict' then
          -- The primary recipient's claims tie between parties: fail closed.
          v_reason := 'identity_conflict';
        elsif v_cp_id is null or v_cp_type not in ('tenant', 'vendor') then
          -- The landlord replied about someone core cannot place.
          v_reason := 'unknown_sender';
        end if;
      else
        v_cp_type    := v_party_type;
        v_cp_id      := v_party_id;
        v_cp_address := p_from_address;
      end if;

      if v_reason is null then
        select f.thread_id, f.cp_participant_id, f.tenancy_id
          into v_thread_id, v_part_id, v_tenancy_id
          from public._persona_find_or_create_thread(
            p_account_id, v_cp_type, v_cp_id, v_cp_address,
            p_subject, p_reply_domain,
            case when v_cc_arm then v_ll_id else null end,
            case when v_cc_arm then p_from_address else null end,
            v_parent.thread_id, v_ctx_tenancy) f;
        if v_thread_id is null then
          -- Known party, but no conversation can be selected safely (closed
          -- parent thread without a usable tenancy). The triage queue's
          -- human-link path is the honest resolution.
          v_reason := 'unknown_sender';
        end if;
      end if;
    end if;

  else
    -- -------------------------------------------------------------------
    -- No parent (§6.5): scoped candidates for the authenticated sender —
    -- live claims + record books through the tiered resolver, so a human
    -- claim hides the learned tiers and superseded claims are invisible.
    -- -------------------------------------------------------------------
    select count(distinct (c.party_type, c.party_id)) into v_cand_count
      from public._comm_resolve_persona_candidates(p_account_id, p_from_address) c;

    if v_cand_count = 0 then
      v_reason := 'unknown_sender';
    elsif v_cand_count > 1 then
      -- Two live claims at the same winning tier and nothing to select a
      -- role: honest conflict.
      v_reason := 'identity_conflict';
    else
      select c.party_type, c.party_id, c.source
        into v_party_type, v_party_id, v_party_source
        from public._comm_resolve_persona_candidates(p_account_id, p_from_address) c
       limit 1;

      if v_party_type = 'landlord_user' then
        -- The landlord CC arm (unchanged from the previous chain): the
        -- conversation comes from a To/Cc address bound in an active email
        -- thread, else a To/Cc address resolving to a known counterparty
        -- (outbound-cold create), else triage.
        v_cc_arm := true;
        v_ll_id  := v_party_id;

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
            -- Counterparty candidates only (a landlord claim on the same
            -- address must not mask a tenant claim below it): exactly one
            -- tenant/vendor party at its winning tier, else next address.
            select count(distinct (x.party_type, x.party_id)) into v_cc_n
              from public._comm_resolve_identity_claims(
                     p_account_id, 'email', r.addr, null, null,
                     array['tenant', 'vendor']) x;
            if v_cc_n = 1 then
              select x.party_type, x.party_id into v_cp_type, v_cp_id
                from public._comm_resolve_identity_claims(
                       p_account_id, 'email', r.addr, null, null,
                       array['tenant', 'vendor']) x
               limit 1;
              v_cp_address := r.addr;
              -- Additive learning for the record-book hit; DO NOTHING against
              -- an existing same-party claim (any source) at account scope.
              insert into public.channel_identities
                (account_id, party_type, party_id, channel, address, source)
              values (p_account_id, v_cp_type, v_cp_id, 'email', r.addr, 'provider_learned')
              on conflict (account_id, channel, address, party_type, party_id, scope_type, scope_id)
              do nothing;
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
          v_reason := 'unknown_sender';
        end if;
      else
        -- Counterparty arm: one tenant/vendor claim.
        v_cp_type    := v_party_type;
        v_cp_id      := v_party_id;
        v_cp_address := p_from_address;
        select f.thread_id, f.cp_participant_id, f.tenancy_id
          into v_thread_id, v_part_id, v_tenancy_id
          from public._persona_find_or_create_thread(
            p_account_id, v_cp_type, v_cp_id, v_cp_address,
            p_subject, p_reply_domain, null, null) f;
        if v_thread_id is null then
          v_reason := 'unknown_sender';
        end if;
      end if;
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- Triage exit (single writer).
  -- ---------------------------------------------------------------------
  if v_reason is not null then
    unmatched_id := public._persona_record_unmatched(
      p_account_id, p_provider, p_provider_msg_id, p_persona_address,
      p_from_address, p_from_display_name, p_to_addresses, p_cc_addresses,
      p_subject, p_body, p_media, v_msgid, p_spf, p_dkim, p_dmarc,
      p_received_at, v_reason);
    v_decision := jsonb_build_object(
      'version', 2,
      'account_source', 'persona_subdomain',
      'auth', coalesce(p_dmarc, 'none'),
      'parent_match', v_parent_match,
      'parent_outbox_id', v_parent_id,
      'party_source', v_party_source,
      'candidate_count', v_cand_count,
      'selected_party_type', null,
      'selected_party_id', null,
      'selected_thread_id', null,
      'selected_tenancy_id', null,
      'disposition', 'triaged',
      'reason', v_reason,
      'conflict_party_type', v_conflict_pt,
      'conflict_party_id', v_conflict_pid
    );
    update public.inbound_raw
       set disposition = 'triaged',
           payload     = jsonb_set(payload, '{routing_decision}', v_decision, true)
     where id = v_raw.id;
    disposition    := 'triaged';
    interaction_id := null;
    thread_id      := null;
    participant_id := null;
    return next;
    return;
  end if;

  -- Same-thread duplicate (the two-door delivery), all arms — the unverified
  -- tier included (invariant d).
  if v_msgid is not null then
    select i.id into v_dup_id
      from public.interactions i
     where i.account_id = p_account_id
       and i.rfc822_message_id = v_msgid
       and i.thread_id = v_thread_id
     limit 1;
    if v_dup_id is not null then
      v_decision := jsonb_build_object(
        'version', 2,
        'account_source', 'persona_subdomain',
        'auth', coalesce(p_dmarc, 'none'),
        'parent_match', v_parent_match,
        'parent_outbox_id', v_parent_id,
        'party_source', v_party_source,
        'candidate_count', v_cand_count,
        'selected_party_type', case when v_cc_arm then 'landlord_user' else v_cp_type end,
        'selected_party_id',   case when v_cc_arm then v_ll_id else v_cp_id end,
        'selected_thread_id', v_thread_id,
        'selected_tenancy_id', v_tenancy_id,
        'disposition', 'duplicate',
        'reason', 'duplicate_rfc822_message_id',
        'conflict_party_type', v_conflict_pt,
        'conflict_party_id', v_conflict_pid
      );
      update public.inbound_raw
         set disposition            = 'duplicate',
             matched_thread_id      = v_thread_id,
             matched_participant_id = v_part_id,
             matched_interaction_id = v_dup_id,
             payload = jsonb_set(payload, '{routing_decision}', v_decision, true)
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
    when v_unverified then 'journaled_unverified'
    when v_cc_arm then 'cc_journaled'
    when exists (
      select 1 from public.comm_opt_outs oo
       where oo.channel = 'email' and oo.address = p_from_address
    ) then 'opted_out'
    else 'matched'
  end;

  -- Additive learning: the authenticated sender's exact address, bound to the
  -- party the route selected, as a provider_learned claim. Landlord aliases
  -- are account-wide; counterparty learning is scoped to the resolved tenancy
  -- when there is one (a shared inbox must not be captured account-wide by
  -- one tenancy's conversation). Capture NEVER supersedes: a claim for a
  -- different party simply coexists (the tiers rank them at read time); a
  -- same-party claim of any source collides on the claim key and stays as it
  -- was.
  -- CRITICAL INVARIANT (a): the unverified tier NEVER learns — a forged From
  -- must not teach the address book anything.
  if not v_unverified then
    insert into public.channel_identities
      (account_id, party_type, party_id, channel, address, source, scope_type, scope_id)
    values (
      p_account_id,
      case when v_cc_arm then 'landlord_user' else v_cp_type end,
      case when v_cc_arm then v_ll_id else v_cp_id end,
      'email',
      p_from_address,
      'provider_learned',
      case when not v_cc_arm and v_tenancy_id is not null then 'tenancy' end,
      case when not v_cc_arm and v_tenancy_id is not null then v_tenancy_id end
    )
    on conflict (account_id, channel, address, party_type, party_id, scope_type, scope_id)
    do nothing;
  end if;

  -- Journal + cast (unchanged contract). The CC arm inverts direction and
  -- authorship; the party slot is the counterparty in BOTH arms. The
  -- unverified arm journals inbound with attestation='unverified' — the
  -- claimed-not-asserted marker.
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
    case when v_unverified then 'unverified' else 'provider_verified' end,
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
    -- Unverified arm: the sender label is the ADDRESS, not the party's
    -- display name — the label must state the physical fact, not assert the
    -- identity this tier explicitly refuses to assert.
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, 'sender', v_cp_type, v_cp_id, p_from_address,
       case when v_unverified then left(p_from_address, 200)
            else left(coalesce(public._party_display_name(p_account_id, v_cp_type, v_cp_id),
                               p_from_display_name), 200) end,
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
    -- Cc cast attribution through the resolver: a single live winner names
    -- the party; anything else (no claim, or a tie) is honestly 'unknown'.
    -- The old raw left-join would duplicate cast rows under multi-claim.
    v_cc_pt := null; v_cc_pid := null;
    select count(distinct (x.party_type, x.party_id)) into v_cc_n
      from public._comm_resolve_identity_claims(
             p_account_id, 'email', v_addr, v_tenancy_id, v_thread_id) x;
    if v_cc_n = 1 then
      select x.party_type, x.party_id into v_cc_pt, v_cc_pid
        from public._comm_resolve_identity_claims(
               p_account_id, 'email', v_addr, v_tenancy_id, v_thread_id) x
       limit 1;
    end if;
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, 'cc',
       coalesce(v_cc_pt, 'unknown'),
       v_cc_pid,
       v_addr,
       case when v_unverified then left(v_addr, 200)
            else left(public._party_display_name(p_account_id, v_cc_pt, v_cc_pid), 200) end,
       'comms');
  end loop;

  v_decision := jsonb_build_object(
    'version', 2,
    'account_source', 'persona_subdomain',
    'auth', coalesce(p_dmarc, 'none'),
    'parent_match', v_parent_match,
    'parent_outbox_id', v_parent_id,
    'party_source', v_party_source,
    'candidate_count', v_cand_count,
    'selected_party_type', case when v_cc_arm then 'landlord_user' else v_cp_type end,
    'selected_party_id',   case when v_cc_arm then v_ll_id else v_cp_id end,
    'selected_thread_id', v_thread_id,
    'selected_tenancy_id', v_tenancy_id,
    'disposition', v_disposition,
    'reason', case
      when v_unverified then 'unverified_single_claim'
      when v_parent_match = 'unique' then 'parent_unique_match'
      else 'sender_unique_claim' end,
    'conflict_party_type', v_conflict_pt,
    'conflict_party_id', v_conflict_pid
  );

  update public.inbound_raw
     set disposition            = v_disposition,
         matched_thread_id      = v_thread_id,
         matched_participant_id = v_part_id,
         matched_interaction_id = v_interaction.id,
         payload = jsonb_set(payload, '{routing_decision}', v_decision, true)
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
-- (E) retract_unverified_interaction — deletable, WITH a reason
-- ============================================================================
-- owner|manager only (identity doubt and its cleanup are resolved by humans,
-- never the agent principal — the link_unmatched_inbound posture). Soft
-- delete per the house convention: deleted_at and updated_at advance
-- together (softDeleteStamp), plus who/why. Default timeline reads already
-- filter deleted_at, so the row disappears from every member surface;
-- inbound_raw stays untouched — the receipt evidence outlives the
-- retraction.

create function public.retract_unverified_interaction(
  p_account_id     uuid,
  p_interaction_id uuid,
  p_reason         text
)
returns table (id uuid, deleted_at timestamptz, deleted_reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row  public.interactions%rowtype;
begin
  select m.role into v_role
    from public.account_members m
   where m.user_id = auth.uid()
     and m.account_id = p_account_id
     and m.deleted_at is null;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- The route validates too (Zod 1..500); this is the evidence-grade backstop.
  if p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'reason must be 1..500 characters' using errcode = '22023';
  end if;

  select * into v_row
    from public.interactions i
   where i.account_id = p_account_id
     and i.id = p_interaction_id
  for update;
  if not found then
    raise exception 'interaction not found' using errcode = 'P0002';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'already retracted' using errcode = 'P0003';
  end if;
  if v_row.attestation is distinct from 'unverified' then
    raise exception 'only unverified journal entries can be retracted (attestation=%)',
      coalesce(v_row.attestation, 'null') using errcode = 'P0003';
  end if;

  update public.interactions i
     set deleted_at     = now(),
         deleted_by     = auth.uid(),
         deleted_reason = btrim(p_reason),
         updated_at     = now()
   where i.account_id = p_account_id
     and i.id = p_interaction_id
  returning i.id, i.deleted_at, i.deleted_reason
       into id, deleted_at, deleted_reason;
  return next;
end;
$$;

revoke execute on function public.retract_unverified_interaction(uuid, uuid, text) from public;
revoke execute on function public.retract_unverified_interaction(uuid, uuid, text) from anon;
grant  execute on function public.retract_unverified_interaction(uuid, uuid, text) to authenticated, service_role;

-- ============================================================================
-- (F) confirm_unverified_sender — "yes, that really was them"
-- ============================================================================
-- owner|manager only. Flips attestation 'unverified' -> 'attested' (the one
-- legal transition, §B) and writes an account-wide human_link claim for
-- (sender address -> the row's party) with the SAME semantics as
-- link_unmatched_inbound: a differing live HUMAN claim fails loudly (P0003 ->
-- 409) before anything is written; differing learned/legacy claims are
-- SUPERSEDED (stamped, never deleted); a same-party row of any source is
-- upgraded/revived. Future mail from the address then resolves normally.

create function public.confirm_unverified_sender(
  p_account_id     uuid,
  p_interaction_id uuid
)
returns table (id uuid, attestation text, party_type text, party_id uuid, address text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_row  public.interactions%rowtype;
  v_addr text;
begin
  select m.role into v_role
    from public.account_members m
   where m.user_id = auth.uid()
     and m.account_id = p_account_id
     and m.deleted_at is null;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- A retracted row is gone from every member surface: uniform not-found.
  select * into v_row
    from public.interactions i
   where i.account_id = p_account_id
     and i.id = p_interaction_id
     and i.deleted_at is null
  for update;
  if not found then
    raise exception 'interaction not found' using errcode = 'P0002';
  end if;
  if v_row.attestation is distinct from 'unverified' then
    raise exception 'only unverified journal entries can be confirmed (attestation=%)',
      coalesce(v_row.attestation, 'null') using errcode = 'P0003';
  end if;
  if v_row.party_type not in ('tenant', 'vendor') or v_row.party_id is null then
    raise exception 'the entry names no confirmable tenant/vendor party'
      using errcode = 'P0003';
  end if;

  -- The claimed sender address, from the row's own cast (capture always
  -- writes the sender leg with the physical From).
  select ip.address into v_addr
    from public.interaction_participants ip
   where ip.account_id = p_account_id
     and ip.interaction_id = p_interaction_id
     and ip.role = 'sender'
     and ip.address is not null
   order by ip.created_at
   limit 1;
  if v_addr is null then
    raise exception 'the entry records no sender address to confirm'
      using errcode = 'P0003';
  end if;
  v_addr := lower(btrim(v_addr));

  -- A different party's live HUMAN claim is a hard stop, checked before any
  -- write so the confirm fails whole (two humans who disagree are reconciled
  -- by humans, not write order).
  if exists (
    select 1 from public.channel_identities ci
     where ci.account_id = p_account_id
       and ci.channel = 'email'
       and ci.address = v_addr
       and ci.superseded_at is null
       and ci.source = 'human_link'
       and (ci.party_type, ci.party_id) is distinct from (v_row.party_type, v_row.party_id)
  ) then
    raise exception 'conflicting human claim: % is already human-linked to another party',
      v_addr using errcode = 'P0003';
  end if;

  -- The learning step, human edition (link_unmatched_inbound semantics).
  update public.channel_identities ci
     set superseded_at = now(),
         updated_at    = now()
   where ci.account_id = p_account_id
     and ci.channel = 'email'
     and ci.address = v_addr
     and ci.superseded_at is null
     and ci.source in ('provider_learned', 'legacy')
     and (ci.party_type, ci.party_id) is distinct from (v_row.party_type, v_row.party_id);

  -- ON CONSTRAINT (not a column list): the conflict-target columns would be
  -- ambiguous against this function's OUT parameters under plpgsql variable
  -- substitution.
  insert into public.channel_identities
    (account_id, party_type, party_id, channel, address, source, created_by)
  values (p_account_id, v_row.party_type, v_row.party_id, 'email', v_addr,
          'human_link', auth.uid())
  on conflict on constraint channel_identities_claim_key
  do update set source        = 'human_link',
                superseded_at = null,
                created_by    = excluded.created_by,
                updated_at    = now();

  -- The one legal attestation transition, announced to the immutability
  -- guard (§B).
  perform set_config('comm.attestation_upgrade', 'on', true);
  update public.interactions i
     set attestation  = 'attested',
         confirmed_by = auth.uid(),
         confirmed_at = now(),
         updated_at   = now()
   where i.account_id = p_account_id
     and i.id = p_interaction_id;

  id          := p_interaction_id;
  attestation := 'attested';
  party_type  := v_row.party_type;
  party_id    := v_row.party_id;
  address     := v_addr;
  return next;
end;
$$;

revoke execute on function public.confirm_unverified_sender(uuid, uuid) from public;
revoke execute on function public.confirm_unverified_sender(uuid, uuid) from anon;
grant  execute on function public.confirm_unverified_sender(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
