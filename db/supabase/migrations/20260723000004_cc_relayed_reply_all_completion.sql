-- ============================================================================
-- cc_relayed — the system completes the landlord's reply-all
-- ============================================================================
-- PRODUCT DECISION (user, on record). When a landlord's reply arrives at the
-- persona and the counterparty (tenant/vendor) was NOT physically on the
-- email, journaling alone makes the reply a black hole: the landlord believes
-- they answered, the tenant never hears back. The transport must DELIVER the
-- reply to the counterparty. Duplication is accepted — a repeat beats a black
-- hole — so the To/Cc check below is a DISCRIMINATOR between "they already
-- received it directly" and "nobody delivered it", not a safety-critical
-- suppressor.
--
-- Trust basis: the sender is a DMARC-verified landlord replying within their
-- own thread (parent probe or their own live claim). That is strictly
-- stronger than the retired token door, which relayed on token possession
-- alone.
--
-- The split, applied in BOTH cc arms (parent-path Cc reply AND the no-parent
-- landlord arm), after the journal decision and only where today's outcome
-- would be 'cc_journaled':
--
--   resolved counterparty address (canonical, _comm_canonical_email_address)
--     compared against the inbound p_to_addresses/p_cc_addresses
--   -> counterparty ABSENT  -> disposition 'cc_relayed' (additive value):
--        the transport delivers the journaled reply to the counterparty;
--   -> counterparty PRESENT -> 'cc_journaled' exactly as today (they already
--        received the mail directly; gmail dot/+tag aliases count as present
--        via the canonical compare).
--
-- Everything else about the cc arm is byte-identical: the same journal insert
-- (landlord-authored outbound into the counterparty's thread), the same cast,
-- the same dedupe/replay/freeze semantics. In the no-parent landlord arm the
-- counterparty is by construction resolved FROM the inbound To/Cc, so the
-- split there always lands on 'cc_journaled' — the discriminator still runs
-- (one code path, no special case).
--
-- DMARC-fail landlord senders keep today's behavior (triage 'auth_failed'):
-- 'cc_relayed' is only reachable via the DMARC-pass cc path.
--
-- A null counterparty address (a parent whose to_address is NULL while the
-- party still resolved from the frozen snapshot) names no deliverable
-- recipient: the split is SKIPPED and the capture stays 'cc_journaled' —
-- never a relay toward a null address.
--
-- routing_decision records the choice — reason 'cc_counterparty_not_addressed'
-- on 'cc_relayed'; version stays 2 (the split is additive inside the v2
-- classifier).
--
-- DEPLOY ORDER — INVERTED from the usual core-first rule: the AGENT ships
-- FIRST (with a bundled spec enum that accepts 'cc_relayed'); this core
-- migration + merge follow. The agent AJV-validates every capture response
-- against its bundled spec enum and an unknown disposition value THROWS —
-- the webhook 500s, SNS redelivers, and the frozen replay returns
-- 'cc_relayed' again: a poison loop, NOT a graceful journal-only fallback.
-- The reverse direction is safe: an agent that already accepts the value
-- but predates the relay logic simply journals during the transition
-- window.
-- ============================================================================

-- ============================================================================
-- (A) inbound_raw — the additive disposition
-- ============================================================================

alter table public.inbound_raw
  drop constraint inbound_raw_disposition_check;
alter table public.inbound_raw
  add constraint inbound_raw_disposition_check
  check (disposition in (
    'matched', 'orphan', 'opted_out', 'sender_mismatch',
    'duplicate', 'cc_journaled', 'cc_relayed', 'triaged', 'journaled_unverified'
  ));

-- ============================================================================
-- (B) capture_persona_inbound — the reply-all completion split
-- ============================================================================
-- Re-created verbatim from the head (20260723000003 §D) with the marked
-- changes only:
--   * new local v_cp_on_mail: with v_cc_arm set AND a non-null resolved
--     counterparty address, EXISTS over the inbound To/Cc against that
--     address, both sides through _comm_canonical_email_address (a null
--     address skips the split — default true — so the capture stays
--     'cc_journaled': never a relay toward a null recipient);
--   * the shared-tail disposition case splits the cc arm on that flag
--     ('cc_journaled' when present, 'cc_relayed' when absent);
--   * the frozen decision's reason is 'cc_counterparty_not_addressed' on
--     'cc_relayed'.
-- All other paths are byte-identical.

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
  v_cp_on_mail   boolean := true;  -- 20260723000004: counterparty on the inbound To/Cc
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
    if v_parent_match = 'multiple' then
      -- A Message-ID collision is contradictory evidence regardless of
      -- authentication: conflict, EXACTLY like the pass path, before any
      -- candidate resolution — the fail path must never be more permissive
      -- than the pass path.
      v_reason := 'identity_conflict';
    else
      if v_parent_match = 'unique' then
        select * into v_parent
          from public.comm_outbox o
         where o.id = v_parent_id
           and o.account_id = p_account_id;
        -- Does the unauthenticated From at least name a PHYSICAL recipient
        -- of the parent? (Gmail-canonical compare, same as the pass path.)
        -- Gates whether parent context may scope the conversation below.
        select count(*) into v_pr_matched
          from public._comm_resolve_parent_sender(p_account_id, v_parent_id, p_from_address);
      end if;

      -- The SAME no-parent candidate resolution the pass path uses (account
      -- scope), plus a unique parent's tier-1 thread-participant match: a
      -- parent-named recipient is a candidate even when the address carries
      -- no live claim (e.g. a rebound address whose learned claim was
      -- superseded).
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
        -- thread_participant tier (the stronger evidence, matching the
        -- ladder).
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
          -- Parent context honored exactly as the matched path — its
          -- tenancy, else its thread's — but only when the sender IS a
          -- parent recipient: an unrelated claimed sender citing someone
          -- else's parent must not be pulled into that conversation's scope.
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
        -- Nobody recognizes the address; a valid parent reference still
        -- makes the triage reason honest.
        v_reason := case when v_parent_match <> 'none'
          then 'auth_failed' else 'unknown_sender' end;
      end if;
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
        -- The landlord replied from a parent Cc leg: journal into the
        -- parent's PRIMARY recipient's conversation. Whether the transport
        -- also DELIVERS the reply is decided by the shared-tail split
        -- (20260723000004): counterparty on the inbound To/Cc ->
        -- 'cc_journaled'; absent -> 'cc_relayed'.
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

  -- The reply-all completion split (20260723000004, header): with the journal
  -- decision already made, is the resolved counterparty PHYSICALLY on this
  -- email? Canonical compare on both sides, so gmail dot/+tag aliases count
  -- as present. Only the cc arms consult the flag; in the no-parent arm the
  -- counterparty comes FROM the inbound To/Cc, so it is always present there.
  -- A null counterparty address (parent to_address null; party resolved from
  -- the frozen snapshot alone) names no deliverable recipient: skip the
  -- split — the default TRUE keeps 'cc_journaled', never a relay toward a
  -- null address.
  if v_cc_arm and v_cp_address is not null then
    select exists (
      select 1
        from unnest(coalesce(p_to_addresses, '{}'::text[])
                    || coalesce(p_cc_addresses, '{}'::text[])) a(addr)
       where public._comm_canonical_email_address(a.addr)
             = public._comm_canonical_email_address(v_cp_address)
    ) into v_cp_on_mail;
  end if;

  v_disposition := case
    when v_unverified then 'journaled_unverified'
    when v_cc_arm and v_cp_on_mail then 'cc_journaled'
    when v_cc_arm then 'cc_relayed'
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
      when v_disposition = 'cc_relayed' then 'cc_counterparty_not_addressed'
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

notify pgrst, 'reload schema';
