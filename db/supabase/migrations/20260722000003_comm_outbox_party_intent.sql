-- ============================================================================
-- Persona email routing v2, PR 3 — explicit caller party intent (plan §9.3)
-- ============================================================================
-- The gap this closes, as a data flow:
--
--   the PWA sends the inspection-link welcome mail. It ALREADY knows the
--   party: primaryMember.tenant_id (To) and landlordUserId (Cc). Today it
--   ships only addresses, so core RE-DERIVES the party from the address
--   (tenancy member / owner-manager email match). When that derivation is
--   ambiguous or an address changes, the send is mislabeled.
--     -> NEW: the caller may state the party it already knows —
--        to_party {party_type, party_id} for the primary recipient and
--        cc_parties [{address, party_type, party_id}] for the visible Cc.
--        Core does NOT trust the JSON: the snapshot trigger INDEPENDENTLY
--        re-verifies each hint (account-pinned party existence + tenancy
--        membership + the address resolving to that party at an authoritative
--        claim tier) before freezing it as resolution_source='caller_intent'.
--        An unverifiable hint RAISEs — the API should have caught it, and a
--        silent mislabel is strictly worse than a failed insert.
--
-- What ships here:
--   * comm_outbox gains nullable to_party_type (tenant|vendor), to_party_id,
--     and cc_parties jsonb (null or an array of {address, party_type,
--     party_id}); all three join the immutable intent set (_comm_outbox_guard
--     _update) — what the caller stated must survive later identity edits.
--   * _comm_party_intent_verdict: the ONE verification predicate (party in
--     account, tenant in the supplied tenancy, address resolving to the party
--     at human_link / authoritative_record / verified_claim, uniquely). Shared
--     by the DB backstop (the snapshot trigger) and the API pre-check RPC so
--     both judge a hint by the same rule. SECURITY INVOKER (the
--     _comm_resolve_context_party pattern): it runs inside SECURITY DEFINER
--     callers and inherits their rights; EXECUTE is revoked from client roles.
--   * check_outbox_party_intent: a narrow SECURITY DEFINER RPC the handler
--     calls to turn each hint into a verdict ('ok' | 'wrong_account' |
--     'not_in_tenancy' | 'address_unverified' | 'invalid') so the API can
--     answer with a specific, stable 422 BEFORE the insert. Self-defends on
--     live membership so it is never a cross-account address→party oracle.
--   * _comm_outbox_snapshot_recipients: the identity backstop. When a bare
--     email send carries a verified caller hint the trigger freezes that party
--     as resolution_source='caller_intent' (a new top tier, above the
--     recomputed tenancy/account context); an unverified hint RAISEs; no hint
--     leaves the PR 2 tier behavior untouched.
--   * _comm_resolve_parent_recipient: 'caller_intent' joins the frozen-
--     authoritative snapshot source set, so a persona reply that resolves off
--     the parent's frozen snapshot trusts a caller-stated party exactly like a
--     tenancy/account/human claim.
--
-- Backward compatible: the columns and request fields are optional; an
-- address-only send behaves exactly as before.
-- ============================================================================

-- ============================================================================
-- (A) Schema: the caller-intent columns
-- ============================================================================

alter table public.comm_outbox
  add column to_party_type text,
  add column to_party_id   uuid,
  add column cc_parties     jsonb;

alter table public.comm_outbox
  add constraint comm_outbox_to_party_type_check
  check (to_party_type is null or to_party_type in ('tenant', 'vendor'));

-- A to_party hint is whole or absent: type and id travel together.
alter table public.comm_outbox
  add constraint comm_outbox_to_party_pair_check
  check ((to_party_type is null) = (to_party_id is null));

-- cc_parties: null or a JSON array. The per-object shape ({address,
-- party_type, party_id}) is validated in the snapshot trigger, not with an
-- unwieldy CHECK.
alter table public.comm_outbox
  add constraint comm_outbox_cc_parties_is_array_check
  check (cc_parties is null or jsonb_typeof(cc_parties) = 'array');

-- ============================================================================
-- (B) _comm_party_intent_verdict — the one hint-verification predicate
-- ============================================================================
-- Returns exactly one of:
--   ok                 the hint is valid: the party is in the account (a
--                      landlord_user is an owner/manager member), a tenant is
--                      in the supplied tenancy, and the address resolves to
--                      THIS party — uniquely — at an authoritative tier.
--   wrong_account      the party id does not name a live party of this account.
--   not_in_tenancy     a tenant party is not a member of the supplied tenancy.
--   address_unverified the address does not resolve to the party at an
--                      authoritative tier (human_link / authoritative_record /
--                      verified_claim), or it resolves ambiguously to more
--                      than one party at that tier (claim_conflict — §8 fail
--                      closed).
--   invalid            a malformed hint (null field / unknown party_type).
--
-- SECURITY INVOKER on purpose: reached only from SECURITY DEFINER code (the
-- snapshot trigger and check_outbox_party_intent), where it inherits the
-- definer's rights so the resolver's auth.users read works; called any other
-- way it is bounded by the caller's own RLS. EXECUTE revoked from client roles.
create function public._comm_party_intent_verdict(
  p_account_id uuid,
  p_tenancy_id uuid,
  p_party_type text,
  p_party_id   uuid,
  p_address    text
)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_n    int;
  v_hit  boolean;
  v_tier text;
begin
  if p_party_type is null or p_party_id is null or p_address is null then
    return 'invalid';
  end if;
  if p_party_type not in ('tenant', 'vendor', 'landlord_user') then
    return 'invalid';
  end if;

  -- (1) The party is a live party of THIS account (a landlord_user must be an
  -- owner/manager member — the CC cast vocabulary the arm copies).
  if p_party_type = 'tenant' then
    if not exists (
      select 1 from public.tenants t
       where t.account_id = p_account_id and t.id = p_party_id and t.deleted_at is null
    ) then
      return 'wrong_account';
    end if;
  elsif p_party_type = 'vendor' then
    if not exists (
      select 1 from public.vendors v
       where v.account_id = p_account_id and v.id = p_party_id and v.deleted_at is null
    ) then
      return 'wrong_account';
    end if;
  else
    if not exists (
      select 1 from public.account_members m
       where m.account_id = p_account_id and m.user_id = p_party_id
         and m.role in ('owner', 'manager') and m.deleted_at is null
    ) then
      return 'wrong_account';
    end if;
  end if;

  -- (2) A tenant party must belong to the supplied tenancy.
  if p_party_type = 'tenant' and p_tenancy_id is not null and not exists (
    select 1 from public.tenancy_tenants tt
     where tt.account_id = p_account_id
       and tt.tenancy_id = p_tenancy_id
       and tt.tenant_id  = p_party_id
       and tt.deleted_at is null
  ) then
    return 'not_in_tenancy';
  end if;

  -- (3) The address resolves to THIS party, uniquely, at an authoritative tier.
  -- The resolver returns every distinct party at its single winning tier; the
  -- hint is honored only when that tier is authoritative, the hinted party is
  -- in the winner set, and there is exactly one winner (a tie is claim_conflict
  -- — the address is ambiguous and fails closed).
  select count(distinct (r.party_type, r.party_id)),
         bool_or(r.party_type = p_party_type and r.party_id = p_party_id),
         min(r.tier)
    into v_n, v_hit, v_tier
    from public._comm_resolve_identity_claims(
           p_account_id, 'email', p_address, p_tenancy_id, null) r;

  if coalesce(v_n, 0) <> 1
     or not coalesce(v_hit, false)
     or v_tier not in ('human_link', 'authoritative_record', 'verified_claim') then
    return 'address_unverified';
  end if;

  return 'ok';
end;
$$;

revoke execute on function public._comm_party_intent_verdict(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;

-- ============================================================================
-- (C) check_outbox_party_intent — the API pre-check RPC
-- ============================================================================
-- One verdict row per hint (slot 'to' | 'cc', the hint address, and the
-- verdict). The handler maps verdicts to stable, field-scoped 422s BEFORE the
-- insert; the snapshot trigger is the independent backstop that RAISEs on a
-- forged hint that somehow reaches it. SECURITY DEFINER so the invoker
-- predicate/resolver can read auth.users; self-defends on live membership so a
-- member of one account can never probe another's address→party mappings.
create function public.check_outbox_party_intent(
  p_account_id    uuid,
  p_tenancy_id    uuid,
  p_to_party_type text,
  p_to_party_id   uuid,
  p_to_address    text,
  p_cc_parties    jsonb
)
returns table (slot text, hint_address text, verdict text)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  cc record;
begin
  -- Same roles as the send path (outbox POST): a viewer may not use this as a
  -- within-account address→party confirm-oracle (it can resolve owner/manager
  -- emails via the resolver, which reads auth.users under definer rights).
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = p_account_id
       and m.role in ('owner', 'manager', 'agent')
       and m.deleted_at is null
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_to_party_type is not null or p_to_party_id is not null then
    slot := 'to';
    hint_address := p_to_address;
    verdict := public._comm_party_intent_verdict(
      p_account_id, p_tenancy_id, p_to_party_type, p_to_party_id, p_to_address);
    return next;
  end if;

  if p_cc_parties is not null then
    for cc in
      select e->>'address'                    as address,
             e->>'party_type'                  as party_type,
             nullif(e->>'party_id', '')::uuid  as party_id
        from jsonb_array_elements(p_cc_parties) e
    loop
      slot := 'cc';
      hint_address := cc.address;
      verdict := public._comm_party_intent_verdict(
        p_account_id, p_tenancy_id, cc.party_type, cc.party_id, cc.address);
      return next;
    end loop;
  end if;
end;
$$;

revoke execute on function public.check_outbox_party_intent(uuid, uuid, text, uuid, text, jsonb)
  from public, anon;
grant  execute on function public.check_outbox_party_intent(uuid, uuid, text, uuid, text, jsonb)
  to authenticated, service_role;

-- ============================================================================
-- (D) _comm_resolve_parent_recipient — caller_intent joins the frozen set
-- ============================================================================
-- Verbatim from PR 2 (20260722000002 §D) with ONE change: a snapshot entry
-- frozen with resolution_source='caller_intent' is authoritative — a persona
-- reply that resolves off the parent's frozen snapshot trusts a caller-stated
-- party exactly like a tenancy_member / account_member / human_link /
-- authoritative_record entry.
create or replace function public._comm_resolve_parent_recipient(
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
  v_pt      text;
  v_pid     uuid;
  v_src     text;
  v_claim_n int;
  v_claim_t text;
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

  -- The live claims verdict for this address in the parent's scope, computed
  -- once and consulted on both sides of the snapshot.
  select count(distinct (r.party_type, r.party_id)), min(r.tier)
    into v_claim_n, v_claim_t
    from public._comm_resolve_identity_claims(
           p_account_id, 'email', p_address, p_tenancy_id, p_thread_id) r;

  -- Tier: a human/authoritative/verified claim outranks the frozen snapshot.
  if v_claim_n > 0
     and v_claim_t in ('human_link', 'authoritative_record', 'verified_claim') then
    if v_claim_n > 1 then
      o_tier := 'claim_conflict';
      return;
    end if;
    select r.party_type, r.party_id into o_party_type, o_party_id
      from public._comm_resolve_identity_claims(
             p_account_id, 'email', p_address, p_tenancy_id, p_thread_id) r
     limit 1;
    o_tier := 'verified_identity';
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

  -- Tier: an authoritatively-sourced frozen snapshot (context, a human/
  -- authoritative claim, or an explicit caller-stated party that existed at
  -- intent time, even if it changed since).
  if v_pt is not null
     and v_src in ('thread_participant', 'tenancy_member', 'account_member',
                   'human_link', 'authoritative_record', 'caller_intent') then
    o_party_type := v_pt; o_party_id := v_pid; o_tier := 'snapshot_frozen';
    return;
  end if;

  -- Tier: legacy/learned snapshot — frozen belief, not authority.
  if v_pt is not null then
    o_party_type := v_pt; o_party_id := v_pid; o_tier := 'snapshot_learned';
    return;
  end if;

  -- Tier: live learned/legacy claims (the address book).
  if v_claim_n > 1 then
    o_tier := 'claim_conflict';
    return;
  end if;
  if v_claim_n = 1 then
    select r.party_type, r.party_id into o_party_type, o_party_id
      from public._comm_resolve_identity_claims(
             p_account_id, 'email', p_address, p_tenancy_id, p_thread_id) r
     limit 1;
    o_tier := 'learned_identity';
  end if;
end;
$$;

revoke execute on function public._comm_resolve_parent_recipient(uuid, uuid, uuid, jsonb, text)
  from public, anon, authenticated;

-- ============================================================================
-- (E) _comm_outbox_snapshot_recipients — caller_intent backstop
-- ============================================================================
-- Verbatim from PR 2 (20260722000002 §I) with the caller-intent tier added to
-- BOTH the primary and cc arms. When a caller hint is present the trigger
-- independently verifies it (never trusting the row) and freezes the party as
-- resolution_source='caller_intent', ABOVE the recomputed tenancy/account
-- context; an unverifiable hint RAISEs (check_violation) — the API pre-check
-- should have caught it. No hint -> the PR 2 tier ladder is unchanged.
-- INERT BY DESIGN: a cc_parties entry whose address is absent from
-- cc_addresses (or any hint on a group/thread insert, where this tier is
-- skipped) is stored but never verified and never frozen — nothing reads
-- cc_parties at routing time (parent resolution reads recipient_snapshot
-- only), so a forged orphan entry can persist only dead data.
create or replace function public._comm_outbox_snapshot_recipients()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type      text;
  v_id        uuid;
  v_label     text;
  v_source    text;
  v_n         int;
  v_hint_type text;
  v_hint_id   uuid;
  r_cc        record;
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

    -- Tier (PR 3): an explicit caller party hint. Independently VERIFIED here
    -- (never trusting the row) and frozen as 'caller_intent'; an unverifiable
    -- hint RAISEs — a silent mislabel is strictly worse than a failed insert.
    if new.to_party_type is not null or new.to_party_id is not null then
      if public._comm_party_intent_verdict(
           new.account_id, new.tenancy_id,
           new.to_party_type, new.to_party_id, new.to_address) <> 'ok' then
        raise exception 'comm_outbox to_party hint failed verification'
          using errcode = 'check_violation';
      end if;
      v_type := new.to_party_type; v_id := new.to_party_id; v_source := 'caller_intent';
    end if;

    if v_type is null and new.participant_id is not null then
      select p.party_type, p.party_id
        into v_type, v_id
        from public.comm_thread_participants p
       where p.id = new.participant_id;
      if v_type is not null then
        v_source := 'thread_participant';
      end if;
    end if;
    -- Authoritative context BEFORE the address book: the intent's own tenancy
    -- and the account's users outrank any claim.
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
      select count(distinct (x.party_type, x.party_id)) into v_n
        from public._comm_resolve_identity_claims(
               new.account_id, new.channel, new.to_address,
               new.tenancy_id, new.thread_id) x;
      if v_n = 1 then
        select x.party_type, x.party_id, x.tier
          into v_type, v_id, v_source
          from public._comm_resolve_identity_claims(
                 new.account_id, new.channel, new.to_address,
                 new.tenancy_id, new.thread_id) x
         limit 1;
        -- Best-effort label off the winning party's live claims.
        select ci.label into v_label
          from public.channel_identities ci
         where ci.account_id = new.account_id
           and ci.channel = new.channel
           and ci.address = lower(btrim(new.to_address))
           and ci.party_type = v_type
           and ci.party_id = v_id
           and ci.superseded_at is null
           and ci.label is not null
         order by (ci.source = 'human_link') desc, ci.created_at desc, ci.id
         limit 1;
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

      -- Tier (PR 3): a caller cc_parties hint naming THIS address. Verified,
      -- then frozen as 'caller_intent'; an unverifiable hint RAISEs.
      if new.cc_parties is not null then
        select e->>'party_type', nullif(e->>'party_id', '')::uuid
          into v_hint_type, v_hint_id
          from jsonb_array_elements(new.cc_parties) e
         where lower(btrim(e->>'address')) = lower(btrim(r_cc.addr))
         limit 1;
        if v_hint_type is not null or v_hint_id is not null then
          if public._comm_party_intent_verdict(
               new.account_id, new.tenancy_id, v_hint_type, v_hint_id, r_cc.addr) <> 'ok' then
            raise exception 'comm_outbox cc_parties hint failed verification'
              using errcode = 'check_violation';
          end if;
          v_type := v_hint_type; v_id := v_hint_id; v_source := 'caller_intent';
        end if;
      end if;

      if v_type is null and new.thread_id is not null then
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
        select count(distinct (x.party_type, x.party_id)) into v_n
          from public._comm_resolve_identity_claims(
                 new.account_id, new.channel, r_cc.addr,
                 new.tenancy_id, new.thread_id) x;
        if v_n = 1 then
          select x.party_type, x.party_id, x.tier
            into v_type, v_id, v_source
            from public._comm_resolve_identity_claims(
                   new.account_id, new.channel, r_cc.addr,
                   new.tenancy_id, new.thread_id) x
           limit 1;
          select ci.label into v_label
            from public.channel_identities ci
           where ci.account_id = new.account_id
             and ci.channel = new.channel
             and ci.address = lower(btrim(r_cc.addr))
             and ci.party_type = v_type
             and ci.party_id = v_id
             and ci.superseded_at is null
             and ci.label is not null
           order by (ci.source = 'human_link') desc, ci.created_at desc, ci.id
           limit 1;
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
-- (F) _comm_outbox_guard_update — the caller-intent columns are immutable
-- ============================================================================
-- Verbatim from 20260719000006 with to_party_type / to_party_id / cc_parties
-- added to the immutable intent set: what the caller stated must survive later
-- binding/identity edits exactly like to_address and cc_addresses.
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
     or new.cc_addresses is distinct from old.cc_addresses
     or new.to_party_type is distinct from old.to_party_type
     or new.to_party_id  is distinct from old.to_party_id
     or new.cc_parties   is distinct from old.cc_parties
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

notify pgrst, 'reload schema';
