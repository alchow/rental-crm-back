-- ============================================================================
-- Persona email routing v2, PR 1 — parent-first classification (plan §6.4/§6.5)
-- ============================================================================
-- The incident this fixes, as a data flow:
--
--   bare outbox (To tenant, Cc landlord, tenancy A) --sent--> tenant replies
--     -> In-Reply-To names the parent outbox row
--     -> OLD: an unverified account-wide channel_identities row
--        ("tenant address -> landlord_user") preempted the parent's tenancy,
--        so the reply triaged as unknown_sender/identity_conflict
--     -> NEW: the parent row's own tenancy resolves the sender to the tenant;
--        the learned claim is outranked (and recorded in the decision trace)
--
-- capture_persona_inbound becomes ONE canonical coordinator:
--
--   authorize agent principal
--     -> advisory lock on provider message id (unchanged key)
--     -> frozen replay return
--     -> raw-first evidence insert
--     -> parent probe (In-Reply-To, then References newest->oldest)
--     -> authenticated?  no -> triage (auth_failed when anything recognizes
--                              the claim: a valid parent or a known identity)
--     -> parent unique   -> compare sender against the parent's PHYSICAL
--                           recipients; resolve each through named tiers:
--                             thread participant
--                             > parent tenancy member / account owner-manager
--                             > authoritatively-sourced frozen snapshot
--                             > legacy snapshot / learned identity
--     -> parent multiple -> identity_conflict (Message-ID collision is a
--                           conflict, never "pick the newest")
--     -> no parent       -> scoped sender candidates; a dual-role address with
--                           no context triages as identity_conflict (honest),
--                           not unknown_sender
--     -> exactly one party + one conversation -> journal; else triage
--     -> stamp routing_decision (version 2) on the raw row
--
-- It no longer calls _capture_persona_inbound_before_reply_recovery; that
-- function stays in place, unused, until a later cleanup PR drops it.
--
-- Also in this migration:
--   * new triage reason 'parent_sender_mismatch' (an authenticated sender who
--     was never a recipient of the parent they reply to);
--   * _comm_outbox_snapshot_recipients precedence flip for bare sends
--     (thread participant > tenancy/account context > learned identity >
--     unknown) with a resolution_source stamped on every 1:1/cc entry;
--   * comm_outbox Message-ID integrity: a partial unique expression index on
--     (account_id, _comm_normalize_msgid(rfc822_message_id)) for email rows,
--     created only when the existing data is collision-free;
--   * _persona_find_or_create_thread learns parent context: an explicit
--     parent thread is reused only while active with the party still
--     participating, a parent tenancy constrains find AND create, and the
--     "party's most recent tenancy" inference never runs when the parent
--     names a conversation.
--
-- Production drift check (§9.1.6): after deploy, compare
--   select md5(pg_get_functiondef(
--     'public.capture_persona_inbound(uuid,text,text,text,text,text,text[],text[],text,text,jsonb,text,text,text[],text,text,text,timestamptz,text)'::regprocedure));
-- against the same digest computed on a freshly-migrated local database, and
-- confirm new captures carry payload->'routing_decision'->>'version' = '2'
-- (also exposed via comm_persona_routing_version()).
-- ============================================================================

-- ============================================================================
-- (A) Triage vocabulary: + parent_sender_mismatch
-- ============================================================================

alter table public.comm_unmatched_inbound
  drop constraint comm_unmatched_inbound_reason_check;
alter table public.comm_unmatched_inbound
  add constraint comm_unmatched_inbound_reason_check
  check (reason in (
    'unknown_sender', 'auth_failed', 'identity_conflict', 'parent_sender_mismatch'
  ));

-- ============================================================================
-- (B) Parent Message-ID integrity (§9.1.4)
-- ============================================================================
-- The parent probe matches on the NORMALIZED outbound Message-ID; give it an
-- index either way. When the existing rows are collision-free the index is
-- UNIQUE, making "multiple parents" structurally impossible going forward; if
-- historical collisions exist we keep them (evidence), index non-uniquely, and
-- the classifier treats a multi-parent match as identity_conflict.

do $$
declare
  v_dupes int;
begin
  select count(*) into v_dupes
    from (
      select o.account_id, public._comm_normalize_msgid(o.rfc822_message_id) as msgid
        from public.comm_outbox o
       where o.channel = 'email'
         and o.rfc822_message_id is not null
         and public._comm_normalize_msgid(o.rfc822_message_id) is not null
       group by 1, 2
      having count(*) > 1
    ) d;
  if v_dupes > 0 then
    raise notice
      'comm_outbox has % duplicated (account_id, normalized Message-ID) email pairs; '
      'write a repair report before attempting uniqueness.',
      v_dupes;
  end if;
end $$;

-- NON-unique on purpose (review finding): complete_send stamps
-- rfc822_message_id with no unique_violation handler, so a UNIQUE index here
-- would turn a duplicate Message-ID from a provider retry/reconcile echo into
-- a 500 on the send-completion hot path. Uniqueness is not load-bearing for
-- routing — the classifier treats a multi-parent match as identity_conflict —
-- so enforcement waits for the cleanup PR, which adds graceful
-- unique_violation handling to complete_send first.
create index comm_outbox_email_msgid_idx
  on public.comm_outbox (account_id, public._comm_normalize_msgid(rfc822_message_id))
  where channel = 'email' and rfc822_message_id is not null;

-- ============================================================================
-- (C) Helpers — named tiers, explicit branches, no numeric scoring
-- ============================================================================
-- All four are SECURITY INVOKER on purpose (the _comm_resolve_context_party
-- pattern): in the only intended call path they run inside the DEFINER
-- coordinator and inherit its rights; called any other way they are bounded by
-- the caller's own RLS. EXECUTE is still revoked from the client roles so no
-- probing surface exists at all.

-- (C1) The parent probe: same account, email, sent|delivered, non-null
-- normalized Message-ID. In-Reply-To first; References newest->oldest only
-- when In-Reply-To found nothing. More than one row for one Message-ID is a
-- collision -> 'multiple' (conflict), never "pick the newest".
create function public._comm_find_parent_outbox(
  p_account_id  uuid,
  p_in_reply_to text,
  p_references  text[],
  out o_match     text,   -- none | unique | multiple
  out o_parent_id uuid
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_irt  text := public._comm_normalize_msgid(p_in_reply_to);
  v_norm text;
  v_ids  uuid[];
  i      int;
begin
  o_match := 'none';

  if v_irt is not null then
    select coalesce(array_agg(o.id), '{}') into v_ids
      from public.comm_outbox o
     where o.account_id = p_account_id
       and o.channel = 'email'
       and o.status in ('sent', 'delivered')
       and o.rfc822_message_id is not null
       and public._comm_normalize_msgid(o.rfc822_message_id) = v_irt;
    if array_length(v_ids, 1) = 1 then
      o_match := 'unique'; o_parent_id := v_ids[1]; return;
    elsif array_length(v_ids, 1) > 1 then
      o_match := 'multiple'; return;
    end if;
  end if;

  -- RFC 5322 lists References oldest-first; probe newest->oldest.
  if p_references is not null then
    for i in reverse coalesce(array_length(p_references, 1), 0)..1 loop
      v_norm := public._comm_normalize_msgid(p_references[i]);
      continue when v_norm is null or v_norm is not distinct from v_irt;
      select coalesce(array_agg(o.id), '{}') into v_ids
        from public.comm_outbox o
       where o.account_id = p_account_id
         and o.channel = 'email'
         and o.status in ('sent', 'delivered')
         and o.rfc822_message_id is not null
         and public._comm_normalize_msgid(o.rfc822_message_id) = v_norm;
      if array_length(v_ids, 1) = 1 then
        o_match := 'unique'; o_parent_id := v_ids[1]; return;
      elsif array_length(v_ids, 1) > 1 then
        o_match := 'multiple'; return;
      end if;
    end loop;
  end if;
end;
$$;

revoke execute on function public._comm_find_parent_outbox(uuid, text, text[])
  from public, anon, authenticated;

-- (C2) One parent recipient address -> intended party, by named tier. The
-- physical parent row + live tenancy/account membership is the authority; the
-- frozen snapshot is consulted only below it (an authoritatively-sourced
-- frozen entry beats a learned one, and both beat nothing). A legacy snapshot
-- (no resolution_source — stamped before this migration) can be the mislabeled
-- inference that caused the incident, so it ranks with the learned tiers.
create function public._comm_resolve_parent_recipient(
  p_account_id uuid,
  p_thread_id  uuid,
  p_tenancy_id uuid,
  p_snapshot   jsonb,
  p_address    text,
  out o_party_type text,
  out o_party_id   uuid,
  out o_tier       text
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_pt  text;
  v_pid uuid;
  v_src text;
begin
  -- Tier: explicit thread participant on a thread-bound parent.
  if p_thread_id is not null then
    select p.party_type, p.party_id into o_party_type, o_party_id
      from public.thread_channel_bindings b
      join public.comm_thread_participants p on p.id = b.participant_id
     where b.account_id = p_account_id
       and b.thread_id  = p_thread_id
       and b.channel    = 'email'
       and b.participant_address = p_address
       and b.active
     limit 1;
    if o_party_type is not null then
      o_tier := 'thread_participant';
      return;
    end if;
  end if;

  -- Tier: authoritative context, RECOMPUTED from the physical parent row
  -- (its tenancy members, then the account's owner/manager users).
  select h.o_party_type, h.o_party_id into o_party_type, o_party_id
    from public._comm_resolve_context_party(
           p_account_id, p_tenancy_id, 'email', p_address) h;
  if o_party_type is not null then
    o_tier := case when o_party_type = 'tenant'
                then 'tenancy_member' else 'account_member' end;
    return;
  end if;

  -- The frozen snapshot entry for this address, if any.
  select e.entry->>'party_type',
         nullif(e.entry->>'party_id', '')::uuid,
         e.entry->>'resolution_source'
    into v_pt, v_pid, v_src
    from jsonb_array_elements(coalesce(p_snapshot, '[]'::jsonb)) e(entry)
   where e.entry->>'address' = p_address
     and e.entry->>'party_type' <> 'unknown'
     and nullif(e.entry->>'party_id', '') is not null
   limit 1;

  -- Tier: an authoritatively-sourced frozen snapshot (context that existed at
  -- intent time even if the membership changed since).
  if v_pt is not null
     and v_src in ('thread_participant', 'tenancy_member', 'account_member') then
    o_party_type := v_pt; o_party_id := v_pid; o_tier := 'snapshot_frozen';
    return;
  end if;

  -- Tier: legacy/learned snapshot — frozen belief, not authority.
  if v_pt is not null then
    o_party_type := v_pt; o_party_id := v_pid; o_tier := 'snapshot_learned';
    return;
  end if;

  -- Tier: the account address book (learned identity).
  select ci.party_type, ci.party_id into o_party_type, o_party_id
    from public.channel_identities ci
   where ci.account_id = p_account_id
     and ci.channel = 'email'
     and ci.address = p_address;
  if o_party_type is not null then
    o_tier := 'learned_identity';
  end if;
end;
$$;

revoke execute on function public._comm_resolve_parent_recipient(uuid, uuid, uuid, jsonb, text)
  from public, anon, authenticated;

-- (C3) Which of the parent's physical recipients is the sender? Exact
-- lowercase equality by default; Gmail/Googlemail dot/plus canonicalization
-- only through _comm_canonical_email_address — and the coordinator only calls
-- this AFTER sender authentication passed.
create function public._comm_resolve_parent_sender(
  p_account_id   uuid,
  p_parent_id    uuid,
  p_from_address text
)
returns table (
  recipient_role text,   -- 'to' | 'cc'
  address        text,
  party_type     text,
  party_id       uuid,
  tier           text
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_parent public.comm_outbox%rowtype;
  v_canon  text := public._comm_canonical_email_address(p_from_address);
  r        record;
begin
  select * into v_parent
    from public.comm_outbox o
   where o.id = p_parent_id
     and o.account_id = p_account_id;
  if not found then
    return;
  end if;

  for r in
    select 'to'::text as rcpt_role, v_parent.to_address as addr
     where v_parent.to_address is not null
    union all
    select 'cc', cc.addr
      from unnest(coalesce(v_parent.cc_addresses, '{}'::text[])) cc(addr)
  loop
    if public._comm_canonical_email_address(r.addr) = v_canon then
      recipient_role := r.rcpt_role;
      address        := r.addr;
      select h.o_party_type, h.o_party_id, h.o_tier
        into party_type, party_id, tier
        from public._comm_resolve_parent_recipient(
               p_account_id, v_parent.thread_id, v_parent.tenancy_id,
               v_parent.recipient_snapshot, r.addr) h;
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function public._comm_resolve_parent_sender(uuid, uuid, text)
  from public, anon, authenticated;

-- (C4) No-parent fallback inputs: every non-superseded claim on the
-- authenticated sender's exact address — the learned address book AND the
-- authoritative tenant contact book. Two claims for two different parties is
-- an honest identity_conflict, not "whichever row was inserted first".
-- (tenants.emails is account-unique since 20260721000002, so the contact-book
-- arm yields at most one tenant.)
create function public._comm_resolve_persona_candidates(
  p_account_id   uuid,
  p_from_address text
)
returns table (party_type text, party_id uuid, source text)
language sql
stable
set search_path = public
as $$
  select distinct on (x.party_type, x.party_id) x.party_type, x.party_id, x.source
    from (
      select ci.party_type, ci.party_id, 'learned_identity'::text as source, 1 as pref
        from public.channel_identities ci
       where ci.account_id = p_account_id
         and ci.channel = 'email'
         and ci.address = p_from_address
      union all
      select 'tenant', t.id, 'tenant_record', 2
        from public.tenants t
       where t.account_id = p_account_id
         and t.deleted_at is null
         and exists (
           select 1 from unnest(t.emails) e(addr)
            where lower(btrim(e.addr)) = p_from_address
         )
    ) x
   order by x.party_type, x.party_id, x.pref
$$;

revoke execute on function public._comm_resolve_persona_candidates(uuid, text)
  from public, anon, authenticated;

-- (C5) The parent-route decision. Explicit branches:
--   * sender matches no parent recipient           -> parent_sender_mismatch
--   * matches resolve to >1 distinct party         -> identity_conflict
--   * matches resolve to no party at all           -> unknown
--   * one party via an AUTHORITATIVE tier          -> matched / cc_journaled,
--     with any contradictory exact-address claim RECORDED (o_conflict_*) but
--     not obeyed — the incident fix;
--   * one party via a LEARNED tier while the exact sender address is claimed
--     by a DIFFERENT party                          -> identity_conflict
--     (two learned beliefs, no authority to rank them: fail closed).
create function public._comm_choose_persona_route(
  p_account_id   uuid,
  p_parent_id    uuid,
  p_from_address text,
  out o_outcome             text, -- matched | cc_journaled | parent_sender_mismatch | identity_conflict | unknown
  out o_party_type          text,
  out o_party_id            uuid,
  out o_party_source        text,
  out o_candidate_count     int,
  out o_conflict_party_type text,
  out o_conflict_party_id   uuid
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_matched int;
  v_ci_type text;
  v_ci_id   uuid;
begin
  o_candidate_count := 0;

  select count(*) into v_matched
    from public._comm_resolve_parent_sender(p_account_id, p_parent_id, p_from_address);
  if v_matched = 0 then
    o_outcome := 'parent_sender_mismatch';
    return;
  end if;

  select count(distinct (s.party_type, s.party_id)) into o_candidate_count
    from public._comm_resolve_parent_sender(p_account_id, p_parent_id, p_from_address) s
   where s.party_id is not null;
  if o_candidate_count = 0 then
    o_outcome := 'unknown';
    return;
  end if;
  if o_candidate_count > 1 then
    o_outcome := 'identity_conflict';
    return;
  end if;

  -- One party; when several tiers matched it, report the strongest.
  select s.party_type, s.party_id, s.tier
    into o_party_type, o_party_id, o_party_source
    from public._comm_resolve_parent_sender(p_account_id, p_parent_id, p_from_address) s
   where s.party_id is not null
   order by array_position(
     array['thread_participant', 'tenancy_member', 'account_member',
           'snapshot_frozen', 'snapshot_learned', 'learned_identity'],
     s.tier)
   limit 1;

  -- The sender's own exact-address claim, if any.
  select ci.party_type, ci.party_id into v_ci_type, v_ci_id
    from public.channel_identities ci
   where ci.account_id = p_account_id
     and ci.channel = 'email'
     and ci.address = p_from_address;
  if v_ci_type is not null
     and (v_ci_type, v_ci_id) is distinct from (o_party_type, o_party_id) then
    o_conflict_party_type := v_ci_type;
    o_conflict_party_id   := v_ci_id;
    if o_party_source not in
       ('thread_participant', 'tenancy_member', 'account_member', 'snapshot_frozen') then
      o_outcome := 'identity_conflict';
      return;
    end if;
    -- Authoritative context outranks the learned claim: proceed; the
    -- contradiction rides the routing decision for a later, audited repair.
  end if;

  o_outcome := case when o_party_type = 'landlord_user'
                 then 'cc_journaled' else 'matched' end;
end;
$$;

revoke execute on function public._comm_choose_persona_route(uuid, uuid, text)
  from public, anon, authenticated;

-- ============================================================================
-- (D) _persona_find_or_create_thread — parent context constrains it (§9.1.5)
-- ============================================================================
-- Signature extended IN PLACE (drop + recreate; two overloads would make every
-- 8-argument call ambiguous). Existing callers keep working through the two
-- new defaults. New behavior, only when parent context is passed:
--   * an explicit parent thread is reused only while ACTIVE with the party
--     still participating — a closed thread or a departed participant is
--     refused, never silently reopened;
--   * a parent tenancy constrains both the find and the create;
--   * a tenant whose parent named a conversation but left no usable tenancy
--     gets NO thread (the caller triages) — the "party's most recent tenancy"
--     inference never runs against explicit parent context.

drop function public._persona_find_or_create_thread(
  uuid, text, uuid, text, text, text, uuid, text
);

create function public._persona_find_or_create_thread(
  p_account_id        uuid,
  p_cp_type           text,
  p_cp_id             uuid,
  p_cp_address        text,
  p_subject           text,
  p_reply_domain      text,
  p_landlord_user_id  uuid default null,
  p_landlord_address  text default null,
  p_parent_thread_id  uuid default null,
  p_parent_tenancy_id uuid default null
)
returns table (thread_id uuid, cp_participant_id uuid, tenancy_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_thread_id  uuid;
  v_part_id    uuid;
  v_tenancy_id uuid;
  v_ll_id      uuid;
  v_ll_email   text;
  v_ll_part_id uuid;
begin
  -- (a) Parent-named thread: reuse only while active with the party aboard.
  if p_parent_thread_id is not null then
    select t.id, t.tenancy_id into v_thread_id, v_tenancy_id
      from public.comm_threads t
     where t.account_id = p_account_id
       and t.id = p_parent_thread_id
       and t.status = 'active';
    if v_thread_id is not null then
      select p.id into v_part_id
        from public.comm_thread_participants p
       where p.account_id = p_account_id
         and p.thread_id = p_parent_thread_id
         and p.party_type = p_cp_type
         and p.party_id = p_cp_id
         and p.left_at is null
       order by p.created_at
       limit 1;
      if v_part_id is not null then
        thread_id := v_thread_id; cp_participant_id := v_part_id; tenancy_id := v_tenancy_id;
        return next;
        return;
      end if;
    end if;
    v_thread_id := null; v_tenancy_id := null;
    -- Closed thread / departed participant: fall through, but only into the
    -- parent's own tenancy (below) — never an unrelated conversation.
  end if;

  -- A tenant with parent context but no usable tenancy is unroutable here:
  -- the caller triages instead of guessing.
  if p_cp_type = 'tenant'
     and p_parent_thread_id is not null
     and p_parent_tenancy_id is null then
    return;
  end if;

  select b.thread_id, b.participant_id into v_thread_id, v_part_id
    from public.thread_channel_bindings b
    join public.comm_threads t
      on t.account_id = b.account_id and t.id = b.thread_id
    join public.comm_thread_participants p
      on p.id = b.participant_id
   where b.account_id = p_account_id
     and b.channel = 'email'
     and b.active
     and b.participant_address = p_cp_address
     and t.status = 'active'
     and t.mode = 'bridged'
     and p.party_type = p_cp_type
     and p.party_id = p_cp_id
     and p.left_at is null
     and (p_parent_tenancy_id is null or t.tenancy_id = p_parent_tenancy_id)
   order by t.updated_at desc
   limit 1;

  if v_thread_id is not null then
    select t.tenancy_id into v_tenancy_id
      from public.comm_threads t
     where t.account_id = p_account_id and t.id = v_thread_id;
    thread_id := v_thread_id; cp_participant_id := v_part_id; tenancy_id := v_tenancy_id;
    return next;
    return;
  end if;

  if p_reply_domain is null or length(p_reply_domain) < 3 then
    raise exception 'p_reply_domain is required to create a thread'
      using errcode = '22023';
  end if;

  if p_cp_type = 'tenant' then
    if p_parent_tenancy_id is not null then
      -- The parent's tenancy IS the conversation scope. No inference.
      v_tenancy_id := p_parent_tenancy_id;
    else
      select tn.id into v_tenancy_id
        from public.tenancy_tenants tt
        join public.tenancies tn
          on tn.account_id = tt.account_id and tn.id = tt.tenancy_id
       where tt.account_id = p_account_id
         and tt.tenant_id = p_cp_id
         and tt.deleted_at is null
         and tn.deleted_at is null
         and tn.status in ('active', 'holdover')
       order by (tn.status = 'active') desc, tn.start_date desc
       limit 1;
    end if;
  end if;

  insert into public.comm_threads (account_id, kind, mode, channel, subject, tenancy_id)
  values (
    p_account_id,
    case when p_cp_type = 'vendor' then 'vendor' else 'bridged_tenant' end,
    'bridged',
    'email',
    nullif(left(coalesce(p_subject, ''), 998), ''),
    v_tenancy_id
  )
  returning id into v_thread_id;

  insert into public.comm_thread_participants (account_id, thread_id, party_type, party_id)
  values (p_account_id, v_thread_id, p_cp_type, p_cp_id)
  returning id into v_part_id;

  insert into public.thread_channel_bindings
    (account_id, thread_id, participant_id, participant_address, reply_address)
  values (
    p_account_id, v_thread_id, v_part_id, p_cp_address,
    't-' || encode(extensions.gen_random_bytes(16), 'hex') || '@' || lower(p_reply_domain)
  );

  -- Landlord participant: the initiating landlord when known, else the owner.
  v_ll_id := p_landlord_user_id;
  if v_ll_id is null then
    select m.user_id into v_ll_id
      from public.account_members m
     where m.account_id = p_account_id
       and m.role = 'owner'
       and m.deleted_at is null
     order by m.created_at
     limit 1;
  end if;

  if v_ll_id is not null then
    insert into public.comm_thread_participants (account_id, thread_id, party_type, party_id)
    values (p_account_id, v_thread_id, 'landlord_user', v_ll_id)
    returning id into v_ll_part_id;

    v_ll_email := p_landlord_address;
    if v_ll_email is null then
      select ci.address into v_ll_email
        from public.channel_identities ci
       where ci.account_id = p_account_id
         and ci.channel = 'email'
         and ci.party_type = 'landlord_user'
         and ci.party_id = v_ll_id
       limit 1;
    end if;

    if v_ll_email is not null then
      insert into public.thread_channel_bindings
        (account_id, thread_id, participant_id, participant_address, reply_address)
      values (
        p_account_id, v_thread_id, v_ll_part_id, v_ll_email,
        't-' || encode(extensions.gen_random_bytes(16), 'hex') || '@' || lower(p_reply_domain)
      );
    end if;
  end if;

  thread_id := v_thread_id; cp_participant_id := v_part_id; tenancy_id := v_tenancy_id;
  return next;
end;
$$;

-- Granted to NOBODY: reachable only from inside the owner-executed comms RPCs
-- (the function owner bypasses EXECUTE checks), never via PostgREST.
revoke execute on function public._persona_find_or_create_thread(uuid, text, uuid, text, text, text, uuid, text, uuid, uuid) from public;
revoke execute on function public._persona_find_or_create_thread(uuid, text, uuid, text, text, text, uuid, text, uuid, uuid) from anon;
revoke execute on function public._persona_find_or_create_thread(uuid, text, uuid, text, text, text, uuid, text, uuid, uuid) from authenticated;

-- ============================================================================
-- (E) capture_persona_inbound — the canonical coordinator
-- ============================================================================
-- Same signature and grants as the live wrapper (create or replace). Preserved
-- from the previous chain: agent-role authorization, the advisory lock and its
-- key, raw-first capture with frozen replay, same-thread rfc822 duplicate ->
-- 'duplicate', opt-out handling, the journal/cast contract, and the response
-- shape. New: parent-first routing, honest triage reasons, and a frozen
-- routing_decision (version 2) on every fresh capture.

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
  v_ll_id        uuid;
  v_cp_type      text;
  v_cp_id        uuid;
  v_cp_address   text;
  v_thread_id    uuid;
  v_part_id      uuid;
  v_tenancy_id   uuid;
  v_dup_id       uuid;
  v_disposition  text;
  v_decision     jsonb;
  v_addr         text;
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
    -- 'auth_failed' when ANYTHING recognizes the claimed identity — a valid
    -- parent reference or a known identity claim; 'unknown_sender' otherwise.
    v_reason := case
      when v_parent_match <> 'none' or exists (
        select 1 from public._comm_resolve_persona_candidates(p_account_id, p_from_address)
      ) then 'auth_failed'
      else 'unknown_sender'
    end;

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
        select h.o_party_type, h.o_party_id into v_cp_type, v_cp_id
          from public._comm_resolve_parent_recipient(
                 p_account_id, v_parent.thread_id, v_parent.tenancy_id,
                 v_parent.recipient_snapshot, v_parent.to_address) h;
        v_cp_address := v_parent.to_address;
        if v_cp_id is null or v_cp_type not in ('tenant', 'vendor') then
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
    -- No parent (§6.5): scoped candidates for the authenticated sender.
    -- -------------------------------------------------------------------
    select count(distinct (c.party_type, c.party_id)) into v_cand_count
      from public._comm_resolve_persona_candidates(p_account_id, p_from_address) c;

    if v_cand_count = 0 then
      v_reason := 'unknown_sender';
    elsif v_cand_count > 1 then
      -- Dual-role address with nothing to select a role: honest conflict.
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
            select ci.party_type, ci.party_id into v_cp_type, v_cp_id
              from public.channel_identities ci
             where ci.account_id = p_account_id
               and ci.channel = 'email'
               and ci.party_type in ('tenant', 'vendor')
               and ci.address = r.addr;
            if v_cp_id is null then
              select t.id into v_cp_id
                from public.tenants t
               where t.account_id = p_account_id
                 and t.deleted_at is null
                 and exists (
                   select 1 from unnest(t.emails) e
                    where lower(btrim(e)) = r.addr
                 )
               order by t.created_at
               limit 1;
              if v_cp_id is not null then
                v_cp_type := 'tenant';
                insert into public.channel_identities (account_id, party_type, party_id, channel, address)
                values (p_account_id, 'tenant', v_cp_id, 'email', r.addr)
                on conflict (account_id, channel, address) do nothing;
              end if;
            end if;
            if v_cp_id is not null then
              v_cp_address := r.addr;
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

  -- Same-thread duplicate (the two-door delivery), both arms.
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
    when v_cc_arm then 'cc_journaled'
    when exists (
      select 1 from public.comm_opt_outs oo
       where oo.channel = 'email' and oo.address = p_from_address
    ) then 'opted_out'
    else 'matched'
  end;

  -- Additive learning: the authenticated sender's exact address, bound to the
  -- party the route selected. First-writer-wins is intact — a conflicting
  -- claim is never overwritten here (repair is a human, audited step; the
  -- contradiction is recorded in the routing decision).
  insert into public.channel_identities (account_id, party_type, party_id, channel, address)
  values (
    p_account_id,
    case when v_cc_arm then 'landlord_user' else v_cp_type end,
    case when v_cc_arm then v_ll_id else v_cp_id end,
    'email',
    p_from_address
  )
  on conflict (account_id, channel, address) do nothing;

  -- Journal + cast (unchanged contract). The CC arm inverts direction and
  -- authorship; the party slot is the counterparty in BOTH arms.
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
    'provider_verified',
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
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, 'sender', v_cp_type, v_cp_id, p_from_address,
       left(coalesce(public._party_display_name(p_account_id, v_cp_type, v_cp_id),
                     p_from_display_name), 200),
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
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    select p_account_id, v_interaction.id, 'cc',
           coalesce(ci.party_type, 'unknown'),
           ci.party_id,
           v_addr,
           left(public._party_display_name(p_account_id, ci.party_type, ci.party_id), 200),
           'comms'
      from (values (1)) one
      left join public.channel_identities ci
        on ci.account_id = p_account_id
       and ci.channel = 'email'
       and ci.address = v_addr;
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
    'reason', case when v_parent_match = 'unique'
                then 'parent_unique_match' else 'sender_unique_claim' end,
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
-- (F) Snapshot precedence flip + resolution_source (§9.1.3)
-- ============================================================================
-- Bare-send (and thread-cc) resolution order becomes:
--   explicit thread participant
--     -> authoritative tenancy/account context (the intent's own facts)
--     -> learned identity (channel_identities)
--     -> unknown
-- Every 1:1/cc entry is stamped with resolution_source so later readers
-- (parent routing above, humans, repair reports) can tell authority from
-- belief. Group-MMS arm untouched. Caller-supplied snapshots stay discarded.

create or replace function public._comm_outbox_snapshot_recipients()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type   text;
  v_id     uuid;
  v_label  text;
  v_source text;
  r_cc     record;
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
    v_type := null; v_id := null; v_label := null; v_source := null;
    if new.participant_id is not null then
      select p.party_type, p.party_id
        into v_type, v_id
        from public.comm_thread_participants p
       where p.id = new.participant_id;
      if v_type is not null then
        v_source := 'thread_participant';
      end if;
    end if;
    -- Authoritative context BEFORE the address book: the intent's own tenancy
    -- and the account's users outrank an unverified learned claim.
    if v_type is null then
      select h.o_party_type, h.o_party_id
        into v_type, v_id
        from public._comm_resolve_context_party(
               new.account_id, new.tenancy_id, new.channel, new.to_address) h;
      if v_type is not null then
        v_source := case when v_type = 'tenant'
                      then 'tenancy_member' else 'account_member' end;
      end if;
    end if;
    if v_type is null then
      select ci.party_type, ci.party_id, ci.label
        into v_type, v_id, v_label
        from public.channel_identities ci
       where ci.account_id = new.account_id
         and ci.channel   = new.channel
         and ci.address   = new.to_address;
      if v_type is not null then
        v_source := 'learned_identity';
      end if;
    end if;
    new.recipient_snapshot := jsonb_build_array(jsonb_build_object(
      'address',    new.to_address,
      'party_type', coalesce(v_type, 'unknown'),
      'party_id',   v_id,
      'label',      coalesce(public._party_display_name(new.account_id, v_type, v_id), v_label),
      'resolution_source', coalesce(v_source, 'unknown')));
  end if;

  -- CC arm: identity-freeze each (already opt-out-scrubbed) CC address after
  -- the primary entries, through the same reordered tiers.
  if new.cc_addresses is not null then
    for r_cc in
      select ca.addr, ca.ord
        from unnest(new.cc_addresses) with ordinality ca(addr, ord)
       order by ca.ord
    loop
      v_type := null; v_id := null; v_label := null; v_source := null;
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
        if v_type is not null then
          v_source := 'thread_participant';
        end if;
      end if;
      if v_type is null then
        select h.o_party_type, h.o_party_id
          into v_type, v_id
          from public._comm_resolve_context_party(
                 new.account_id, new.tenancy_id, new.channel, r_cc.addr) h;
        if v_type is not null then
          v_source := case when v_type = 'tenant'
                        then 'tenancy_member' else 'account_member' end;
        end if;
      end if;
      if v_type is null then
        select ci.party_type, ci.party_id, ci.label
          into v_type, v_id, v_label
          from public.channel_identities ci
         where ci.account_id = new.account_id
           and ci.channel    = new.channel
           and ci.address    = r_cc.addr;
        if v_type is not null then
          v_source := 'learned_identity';
        end if;
      end if;
      new.recipient_snapshot := coalesce(new.recipient_snapshot, '[]'::jsonb)
        || jsonb_build_array(jsonb_build_object(
             'role',       'cc',
             'address',    r_cc.addr,
             'party_type', coalesce(v_type, 'unknown'),
             'party_id',   v_id,
             'label',      coalesce(public._party_display_name(new.account_id, v_type, v_id), v_label),
             'resolution_source', coalesce(v_source, 'unknown')));
    end loop;
  end if;
  return new;
end;
$$;

-- ============================================================================
-- (G) Classifier version smoke (§9.1.6)
-- ============================================================================
-- A cheap, queryable "which routing generation is live?" answer for deploy
-- verification — alongside routing_decision.version on every fresh capture
-- and the pg_get_functiondef digest documented in the header.

create function public.comm_persona_routing_version()
returns int
language sql
stable
set search_path = public
as $$ select 2 $$;

revoke execute on function public.comm_persona_routing_version() from public, anon;
grant execute on function public.comm_persona_routing_version() to authenticated, service_role;

notify pgrst, 'reload schema';
