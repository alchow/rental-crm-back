-- ============================================================================
-- Persona email routing v2, PR 2 — conflict-aware identity claims (plan §9.2)
-- ============================================================================
-- The problem this fixes, as a data flow:
--
--   address X honestly belongs to two parties (tenant + landlord), OR a bad
--   learned row claims it for the wrong party
--     -> OLD: unique (account_id, channel, address) let exactly ONE row exist,
--        so whoever wrote first owned the address forever; a human linking a
--        triaged message as the tenant hit ON CONFLICT DO NOTHING and the link
--        silently NEVER took effect (the incident's learning bug)
--     -> NEW: one row per CLAIM — (account, channel, address, party, scope) —
--        with a named source and a supersession stamp. Resolution walks named
--        tiers (human_link > authoritative record > verified claim >
--        provider_learned > legacy) over LIVE, scope-applicable claims only.
--        A human link supersedes learned/legacy claims for other parties (it
--        actually takes effect); provider capture only ever ADDS claims.
--
-- Schema decisions (asked to be explicit):
--   * Account-wide scope is stored as scope_type NULL / scope_id NULL — the
--     ONLY representation ('account' is deliberately NOT a stored value; the
--     CHECK forbids it so two spellings of the same scope cannot coexist).
--     UNIQUE ... NULLS NOT DISTINCT makes the null scope pair collide like a
--     value, so duplicate account-wide claims are still impossible.
--   * A claim is "verified" when verified_at is not null OR its source is one
--     of thread_rebind / parent_recipient / authoritative_import: a human
--     bound the address to a concrete conversation leg, the address was a
--     physical recipient of a delivered parent send, or it was imported from
--     an authoritative system. verified_at itself remains an explicit
--     confirmation timestamp; the backfill never invents one.
--   * Supersession is a stamp (superseded_at), never a delete — a superseded
--     claim stays queryable as evidence. Only link_unmatched_inbound (a human)
--     supersedes, and only learned/legacy claims for a DIFFERENT party.
--     A live human_link claim for a different party makes the link fail loudly
--     (errcode P0003 -> 409 'conflicting human claim…'); two humans who
--     disagree are resolved by humans, not by write order. Differing VERIFIED
--     claims are left live: the human tier simply outranks them at read time.
--   * capture_persona_inbound learns with source='provider_learned'. Scope by
--     party kind: LANDLORD aliases are account-wide (landlords are
--     account-level actors; their learned phone alias must keep unlocking the
--     CC arm on future cold mail), while COUNTERPARTY learning is scoped to
--     the tenancy the route resolved (when there is one). A shared inbox
--     serving two tenancies must not let whichever tenant replied first own
--     the address account-wide — cold mail with no context stays triaged
--     (use case I), while replies in either tenancy's conversations resolve.
--
-- Dropping unique (account_id, channel, address) breaks every function body
-- that says `on conflict (account_id, channel, address) do nothing`. The LIVE
-- ones are re-created here in the same transaction:
--   * capture_persona_inbound (20260722000001: counterparty-scan insert +
--     tail learning insert);
--   * link_unmatched_inbound (20260709000001:780-782).
-- DORMANT bodies also reference the old key but are UNCALLED and left as-is
-- for a later cleanup PR to drop: _capture_persona_inbound_before_reply_recovery
-- (20260721000004:184-188) and the superseded pre-PR1 capture bodies
-- (20260708000001, 20260708000002, 20260709000001 old arms). They would throw
-- "no unique or exclusion constraint matching the ON CONFLICT specification"
-- if ever invoked — loud, and intentionally so.
--
-- Functions re-created here and why:
--   * _comm_resolve_identity_claims  NEW: the one claims resolver (named
--     tiers, highest applicable tier only, supersession- and scope-aware).
--   * _comm_resolve_persona_candidates  delegates to the resolver so the
--     no-parent flow honors supersession + human precedence.
--   * _comm_resolve_parent_recipient  claims arms rebuilt: a human/
--     authoritative/verified claim winner now outranks the frozen snapshot
--     ('verified_identity', between account_member and snapshot_frozen); the
--     learned arm consults only live claims; a multi-party tie at the winning
--     tier surfaces as 'claim_conflict' instead of an arbitrary limit 1.
--   * _comm_choose_persona_route  conflict recording is supersession-aware and
--     deterministic under multi-claim; 'verified_identity' joins the
--     authoritative set; 'claim_conflict' legs fail closed.
--   * capture_persona_inbound  both identity inserts target the new unique
--     key (source='provider_learned', account scope, created_by null, DO
--     NOTHING — capture never supersedes); counterparty scan + cc cast use
--     the resolver instead of raw single-row reads.
--   * link_unmatched_inbound  the human-link write: source='human_link',
--     created_by auth.uid(); supersedes differing learned/legacy claims;
--     errors on a differing live human claim; upgrades an existing same-party
--     row (including reviving a superseded one) via DO UPDATE.
--   * _persona_find_or_create_thread  landlord address lookup now ignores
--     superseded claims and picks deterministically (human_link, then
--     verified, then newest). Dropped/recreated (10-arg signature unchanged).
--   * _comm_outbox_snapshot_recipients  tier ORDER unchanged (participant ->
--     context -> identity -> unknown); the identity tier now consults the
--     resolver: live claims only, deterministic winner, and the winning tier
--     name is stamped as resolution_source ('human_link' /
--     'authoritative_record' / 'verified_claim' / 'provider_learned' /
--     'legacy'). A multi-party tie freezes 'unknown' rather than guessing.
--
-- NOT re-created (reads that stay correct): complete_send's legacy cast
-- fallback (only used for pre-snapshot rows) and list_account_opt_outs'
-- visibility intersection — both are EXISTS/first-row reads whose semantics a
-- later cleanup PR can tighten; neither uses the dropped ON CONFLICT key.
-- ============================================================================

-- ============================================================================
-- (A) Schema: claims, sources, scopes, supersession
-- ============================================================================

alter table public.channel_identities
  add column source        text not null default 'legacy',
  add column scope_type    text,
  add column scope_id      uuid,
  add column superseded_at timestamptz,
  add column created_by    uuid;

-- The default exists only to backfill: every pre-existing row is an
-- account-wide 'legacy' claim (scope null/null, verification untouched).
-- Future writers must say what they are.
alter table public.channel_identities
  alter column source drop default;

alter table public.channel_identities
  add constraint channel_identities_source_check
  check (source in (
    'human_link', 'thread_rebind', 'parent_recipient',
    'provider_learned', 'authoritative_import', 'legacy'
  ));

-- One representation of account scope: null/null. 'account' as a stored
-- scope_type is forbidden on purpose (see header).
alter table public.channel_identities
  add constraint channel_identities_scope_check
  check (
    (scope_type is null and scope_id is null)
    or (scope_type in ('tenancy', 'thread') and scope_id is not null)
  );

-- The claim key: one row per (address, party, scope). NULLS NOT DISTINCT so
-- the account-wide (null, null) scope collides like a value. (account_id, id)
-- stays as-is.
alter table public.channel_identities
  drop constraint channel_identities_account_id_channel_address_key;

alter table public.channel_identities
  add constraint channel_identities_claim_key
  unique nulls not distinct (account_id, channel, address, party_type, party_id, scope_type, scope_id);

-- The hot lookup path (address -> claims) lost its unique index; give it a
-- plain one.
create index channel_identities_address_idx
  on public.channel_identities (account_id, channel, address);

-- Address normalization at the door: writers are not trusted to lowercase.
create function public._channel_identities_normalize()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.address := lower(btrim(new.address));
  return new;
end;
$$;

create trigger channel_identities_normalize
  before insert or update on public.channel_identities
  for each row execute function public._channel_identities_normalize();

-- ============================================================================
-- (B) The one claims resolver
-- ============================================================================
-- Named tiers over LIVE (superseded_at is null), scope-applicable claims plus
-- the live authoritative record books:
--
--   human_link            a human said so (source = human_link)
--   authoritative_record  tenants.emails match / owner-manager member email
--                         match (email only, like _comm_resolve_context_party)
--   verified_claim        verified_at set, or source in thread_rebind /
--                         parent_recipient / authoritative_import
--   provider_learned      capture-time learning
--   legacy                pre-claims rows (unknown provenance)
--
-- Scope applicability: account-wide (scope null) always applies; a tenancy
-- scope applies only when p_tenancy_id matches; a thread scope only when
-- p_thread_id matches. Returns ALL distinct parties at the HIGHEST non-empty
-- tier — one row means "use it", several mean "conflict"; the caller decides.
-- p_party_types optionally restricts the candidate set BEFORE the winning
-- tier is chosen (the landlord-CC counterparty scan only ever wants
-- tenant/vendor claims; a landlord claim on the same address must not mask a
-- lower-tier tenant claim there).
--
-- SECURITY INVOKER on purpose (the _comm_resolve_context_party pattern): in
-- the intended call paths it runs inside SECURITY DEFINER functions/triggers
-- and inherits their rights (auth.users readable); called any other way it is
-- bounded by the caller's own RLS and auth.users is simply unreadable.
-- EXECUTE is still revoked from the client roles.
create function public._comm_resolve_identity_claims(
  p_account_id  uuid,
  p_channel     text,
  p_address     text,
  p_tenancy_id  uuid default null,
  p_thread_id   uuid default null,
  p_party_types text[] default null
)
returns table (party_type text, party_id uuid, tier text)
language sql
stable
set search_path = public
as $$
  with cand as (
    select ci.party_type, ci.party_id,
           case
             when ci.source = 'human_link' then 'human_link'
             when ci.verified_at is not null
               or ci.source in ('thread_rebind', 'parent_recipient', 'authoritative_import')
               then 'verified_claim'
             when ci.source = 'provider_learned' then 'provider_learned'
             else 'legacy'
           end as tier
      from public.channel_identities ci
     where ci.account_id = p_account_id
       and ci.channel = p_channel
       and ci.address = lower(btrim(p_address))
       and ci.superseded_at is null
       and (
         ci.scope_type is null
         or (ci.scope_type = 'tenancy' and ci.scope_id = p_tenancy_id)
         or (ci.scope_type = 'thread'  and ci.scope_id = p_thread_id)
       )
    union all
    -- The authoritative record books (email addresses only; tenants.emails is
    -- account-unique since 20260721000002 so the tenant arm yields <= 1 row).
    select 'tenant', t.id, 'authoritative_record'
      from public.tenants t
     where p_channel = 'email'
       and t.account_id = p_account_id
       and t.deleted_at is null
       and exists (
         select 1 from unnest(t.emails) e(addr)
          where lower(btrim(e.addr)) = lower(btrim(p_address))
       )
    union all
    select 'landlord_user', m.user_id, 'authoritative_record'
      from public.account_members m
      join auth.users u on u.id = m.user_id
     where p_channel = 'email'
       and m.account_id = p_account_id
       and m.deleted_at is null
       and m.role in ('owner', 'manager')
       and lower(btrim(u.email)) = lower(btrim(p_address))
  ),
  ranked as (
    select c.party_type, c.party_id, c.tier,
           array_position(
             array['human_link', 'authoritative_record', 'verified_claim',
                   'provider_learned', 'legacy'],
             c.tier) as rank
      from cand c
     where p_party_types is null or c.party_type = any (p_party_types)
  )
  select distinct r.party_type, r.party_id, r.tier
    from ranked r
   where r.rank = (select min(r2.rank) from ranked r2)
$$;

revoke execute on function public._comm_resolve_identity_claims(uuid, text, text, uuid, uuid, text[])
  from public, anon, authenticated;

-- ============================================================================
-- (C) No-parent candidates delegate to the resolver
-- ============================================================================
-- Same signature/callers as PR 1. The 'source' column now carries the
-- resolver's tier name. Supersession and human precedence come for free: a
-- superseded claim no longer makes a sender "recognized", and a human claim
-- hides the learned tiers instead of colliding with them.

create or replace function public._comm_resolve_persona_candidates(
  p_account_id   uuid,
  p_from_address text
)
returns table (party_type text, party_id uuid, source text)
language sql
stable
set search_path = public
as $$
  select r.party_type, r.party_id, r.tier
    from public._comm_resolve_identity_claims(p_account_id, 'email', p_from_address) r
$$;

revoke execute on function public._comm_resolve_persona_candidates(uuid, text)
  from public, anon, authenticated;

-- ============================================================================
-- (D) Parent recipient ladder: claims arms rebuilt
-- ============================================================================
-- Order (top wins):
--   thread_participant
--     > tenancy_member / account_member    (live context, recomputed)
--     > verified_identity                  (resolver winner at human_link /
--                                           authoritative_record /
--                                           verified_claim — a human or
--                                           verified claim outranks the frozen
--                                           belief)
--     > snapshot_frozen                    (authoritatively-sourced frozen
--                                           entry; now also entries frozen
--                                           from human/authoritative claims)
--     > snapshot_learned                   (other frozen entries)
--     > learned_identity                   (resolver winner at
--                                           provider_learned / legacy)
-- A multi-party tie at the resolver's winning tier returns o_tier =
-- 'claim_conflict' with no party: the caller fails closed instead of this
-- function picking a row arbitrarily (§8).

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

  -- Tier: an authoritatively-sourced frozen snapshot (context or a human/
  -- authoritative claim that existed at intent time, even if it changed
  -- since).
  if v_pt is not null
     and v_src in ('thread_participant', 'tenancy_member', 'account_member',
                   'human_link', 'authoritative_record') then
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
-- (E) Parent-route decision: deterministic under multi-claim
-- ============================================================================
-- Changes from PR 1:
--   * 'verified_identity' slots between 'account_member' and 'snapshot_frozen'
--     in both the strongest-tier pick and the authoritative set;
--   * a 'claim_conflict' leg fails closed as identity_conflict;
--   * the sender's own exact-address contradiction is found over LIVE,
--     scope-applicable claims with a deterministic order (tier rank, newest
--     first) instead of an arbitrary single-row read.

create or replace function public._comm_choose_persona_route(
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
  v_matched    int;
  v_conflicted int;
  v_thread_id  uuid;
  v_tenancy_id uuid;
  v_ci_type    text;
  v_ci_id      uuid;
begin
  o_candidate_count := 0;

  select count(*) into v_matched
    from public._comm_resolve_parent_sender(p_account_id, p_parent_id, p_from_address);
  if v_matched = 0 then
    o_outcome := 'parent_sender_mismatch';
    return;
  end if;

  -- A leg whose claims tied at the winning tier is undecidable: fail closed.
  select count(*) into v_conflicted
    from public._comm_resolve_parent_sender(p_account_id, p_parent_id, p_from_address) s
   where s.tier = 'claim_conflict';
  if v_conflicted > 0 then
    o_outcome := 'identity_conflict';
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
           'verified_identity', 'snapshot_frozen', 'snapshot_learned',
           'learned_identity'],
     s.tier)
   limit 1;

  -- The sender's own exact-address claim, if a LIVE one names someone else.
  -- Scope-applicable within the parent's conversation; deterministic order.
  select o.thread_id, o.tenancy_id into v_thread_id, v_tenancy_id
    from public.comm_outbox o
   where o.id = p_parent_id and o.account_id = p_account_id;

  select ci.party_type, ci.party_id into v_ci_type, v_ci_id
    from public.channel_identities ci
   where ci.account_id = p_account_id
     and ci.channel = 'email'
     and ci.address = lower(btrim(p_from_address))
     and ci.superseded_at is null
     and (
       ci.scope_type is null
       or (ci.scope_type = 'tenancy' and ci.scope_id = v_tenancy_id)
       or (ci.scope_type = 'thread'  and ci.scope_id = v_thread_id)
     )
     and (ci.party_type, ci.party_id) is distinct from (o_party_type, o_party_id)
   order by case
              when ci.source = 'human_link' then 0
              when ci.verified_at is not null
                or ci.source in ('thread_rebind', 'parent_recipient', 'authoritative_import')
                then 1
              when ci.source = 'provider_learned' then 2
              else 3
            end,
            ci.created_at desc, ci.id
   limit 1;

  if v_ci_type is not null then
    o_conflict_party_type := v_ci_type;
    o_conflict_party_id   := v_ci_id;
    if o_party_source not in
       ('thread_participant', 'tenancy_member', 'account_member',
        'verified_identity', 'snapshot_frozen') then
      o_outcome := 'identity_conflict';
      return;
    end if;
    -- Authoritative context outranks the contradicting claim: proceed; the
    -- contradiction rides the routing decision for a later, audited repair.
  end if;

  o_outcome := case when o_party_type = 'landlord_user'
                 then 'cc_journaled' else 'matched' end;
end;
$$;

revoke execute on function public._comm_choose_persona_route(uuid, uuid, text)
  from public, anon, authenticated;

-- ============================================================================
-- (F) _persona_find_or_create_thread — superseded-aware landlord address pick
-- ============================================================================
-- Only the landlord channel_identities lookup changes: live claims only,
-- deterministic preference (human_link, then verified, then newest) instead
-- of an arbitrary limit 1. Signature unchanged (drop + recreate, 10 args).

drop function public._persona_find_or_create_thread(
  uuid, text, uuid, text, text, text, uuid, text, uuid, uuid
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
      -- Live claims only; prefer human_link, then verified, then newest.
      select ci.address into v_ll_email
        from public.channel_identities ci
       where ci.account_id = p_account_id
         and ci.channel = 'email'
         and ci.party_type = 'landlord_user'
         and ci.party_id = v_ll_id
         and ci.superseded_at is null
       order by (ci.source = 'human_link') desc,
                (ci.verified_at is not null
                  or ci.source in ('thread_rebind', 'parent_recipient', 'authoritative_import')) desc,
                ci.created_at desc, ci.id
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
-- (G) capture_persona_inbound — claims-aware coordinator
-- ============================================================================
-- Same signature, grants, lock, replay, journal and response contract as PR 1.
-- Changed: both identity inserts target the new claim key
-- (source='provider_learned', account scope, created_by null, DO NOTHING —
-- capture NEVER supersedes anything); the landlord-CC counterparty scan and
-- the cc cast resolve through _comm_resolve_identity_claims; a
-- 'claim_conflict' primary recipient triages as identity_conflict.

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
    -- 'auth_failed' when ANYTHING recognizes the claimed identity — a valid
    -- parent reference or a LIVE identity claim; 'unknown_sender' otherwise.
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
  -- party the route selected, as a provider_learned claim. Landlord aliases
  -- are account-wide; counterparty learning is scoped to the resolved tenancy
  -- when there is one (a shared inbox must not be captured account-wide by
  -- one tenancy's conversation). Capture NEVER supersedes: a claim for a
  -- different party simply coexists (the tiers rank them at read time); a
  -- same-party claim of any source collides on the claim key and stays as it
  -- was.
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
       left(public._party_display_name(p_account_id, v_cc_pt, v_cc_pid), 200),
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
-- (H) link_unmatched_inbound — the human link that actually takes effect
-- ============================================================================
-- The incident's learning bug: linking a dual-role address as the tenant hit
-- ON CONFLICT (account, channel, address) DO NOTHING against the bad landlord
-- row and silently never learned anything. Now:
--   * a live human_link claim for a DIFFERENT party -> error 'conflicting
--     human claim' (P0003 -> 409); two humans are reconciled by humans;
--   * live learned/legacy claims for a DIFFERENT party are SUPERSEDED
--     (stamped, never deleted — still queryable evidence);
--   * differing VERIFIED claims stay live; the human tier outranks them;
--   * the human claim upserts: a same-party row (any source, even superseded)
--     is upgraded/revived to a live human_link claim, so the link is always
--     in effect afterwards.

create or replace function public.link_unmatched_inbound(
  p_account_id   uuid,
  p_unmatched_id uuid,
  p_party_type   text,
  p_party_id     uuid,
  p_reply_domain text
)
returns table (thread_id uuid, interaction_id uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row         public.comm_unmatched_inbound%rowtype;
  v_role        text;
  v_thread_id   uuid;
  v_part_id     uuid;
  v_tenancy_id  uuid;
  v_interaction public.interactions%rowtype;
  v_dup_id      uuid;
  v_addr        text;
  v_cc_pt       text;
  v_cc_pid      uuid;
  v_cc_n        int;
begin
  -- Self-defense: owner|manager member (the agent principal may not resolve
  -- identity doubt — same posture as classify corrections).
  select m.role into v_role
    from public.account_members m
   where m.user_id = auth.uid()
     and m.account_id = p_account_id
     and m.deleted_at is null;
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_party_type not in ('tenant', 'vendor') then
    raise exception 'party_type must be tenant or vendor' using errcode = '22023';
  end if;
  if p_party_type = 'tenant' and not exists (
    select 1 from public.tenants t
     where t.account_id = p_account_id and t.id = p_party_id and t.deleted_at is null
  ) then
    raise exception 'tenant not found' using errcode = 'P0002';
  end if;
  if p_party_type = 'vendor' and not exists (
    select 1 from public.vendors v
     where v.account_id = p_account_id and v.id = p_party_id and v.deleted_at is null
  ) then
    raise exception 'vendor not found' using errcode = 'P0002';
  end if;

  select * into v_row
    from public.comm_unmatched_inbound u
   where u.account_id = p_account_id
     and u.id = p_unmatched_id
  for update;
  if not found then
    raise exception 'unmatched row not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'already resolved (%)', v_row.status using errcode = 'P0003';
  end if;

  -- A different party's live HUMAN claim is a hard stop, checked before any
  -- journal write so the link fails whole.
  if exists (
    select 1 from public.channel_identities ci
     where ci.account_id = p_account_id
       and ci.channel = 'email'
       and ci.address = lower(btrim(v_row.from_address))
       and ci.superseded_at is null
       and ci.source = 'human_link'
       and (ci.party_type, ci.party_id) is distinct from (p_party_type, p_party_id)
  ) then
    raise exception 'conflicting human claim: % is already human-linked to another party',
      v_row.from_address using errcode = 'P0003';
  end if;

  select f.thread_id, f.cp_participant_id, f.tenancy_id
    into v_thread_id, v_part_id, v_tenancy_id
    from public._persona_find_or_create_thread(
      p_account_id, p_party_type, p_party_id, v_row.from_address,
      v_row.subject, p_reply_domain, null, null) f;

  -- The message may already be journaled (e.g. linked after a rebind let a
  -- later copy through) — link to the existing row rather than duplicating.
  if v_row.rfc822_message_id is not null then
    select i.id into v_dup_id
      from public.interactions i
     where i.account_id = p_account_id
       and i.rfc822_message_id = v_row.rfc822_message_id
       and i.thread_id = v_thread_id
     limit 1;
  end if;

  if v_dup_id is not null then
    select * into v_interaction from public.interactions where id = v_dup_id;
  else
    -- provider_verified only when the STORED verdicts authenticate the mail;
    -- a human vouching for an unauthenticated message is 'attested'.
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
      'user:' || auth.uid(),
      case when p_party_type = 'vendor' then 'vendor' else 'tenant' end,
      null, null, null,
      v_row.provider_msg_id,
      'communication',
      public._comm_journal_channel('email'),
      'inbound',
      p_party_type,
      p_party_id,
      null,
      v_row.body,
      v_row.received_at,
      null, null,
      v_thread_id,
      case when v_row.dmarc = 'pass' then 'provider_verified' else 'attested' end,
      v_tenancy_id,
      null, null, null,
      case when p_party_type = 'vendor' then p_party_id else null end,
      v_row.rfc822_message_id
    )
    returning * into v_interaction;

    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, 'sender', p_party_type, p_party_id, v_row.from_address,
       left(coalesce(public._party_display_name(p_account_id, p_party_type, p_party_id),
                     v_row.from_display_name), 200),
       'comms'),
      (p_account_id, v_interaction.id, 'recipient', 'platform', null,
       v_row.persona_address, null, 'comms');

    for v_addr in
      select distinct x.addr
        from (
          select unnest(v_row.to_addresses) as addr
          union all
          select unnest(v_row.cc_addresses)
        ) x
       where x.addr is not null
         and length(x.addr) between 3 and 320
         and x.addr <> v_row.persona_address
         and x.addr <> v_row.from_address
    loop
      -- Same resolver-backed cc attribution as capture (single live winner or
      -- honest 'unknown'; no duplicate cast rows under multi-claim).
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
         left(public._party_display_name(p_account_id, v_cc_pt, v_cc_pid), 200),
         'comms');
    end loop;
  end if;

  -- The learning step, human edition. Supersede (never delete) live learned/
  -- legacy claims that point at someone else…
  update public.channel_identities ci
     set superseded_at = now(),
         updated_at    = now()
   where ci.account_id = p_account_id
     and ci.channel = 'email'
     and ci.address = lower(btrim(v_row.from_address))
     and ci.superseded_at is null
     and ci.source in ('provider_learned', 'legacy')
     and (ci.party_type, ci.party_id) is distinct from (p_party_type, p_party_id);

  -- …then make the human claim live. A same-party row of any source (even a
  -- superseded one) is upgraded/revived so the link ALWAYS takes effect.
  insert into public.channel_identities
    (account_id, party_type, party_id, channel, address, source, created_by)
  values (p_account_id, p_party_type, p_party_id, 'email', v_row.from_address,
          'human_link', auth.uid())
  on conflict (account_id, channel, address, party_type, party_id, scope_type, scope_id)
  do update set source        = 'human_link',
                superseded_at = null,
                created_by    = excluded.created_by,
                updated_at    = now();

  update public.comm_unmatched_inbound
     set status                = 'linked',
         resolved_by           = auth.uid(),
         resolved_at           = now(),
         linked_thread_id      = v_thread_id,
         linked_interaction_id = v_interaction.id,
         linked_party_type     = p_party_type,
         linked_party_id       = p_party_id,
         updated_at            = now()
   where account_id = p_account_id
     and id = p_unmatched_id;

  thread_id      := v_thread_id;
  interaction_id := v_interaction.id;
  return next;
end;
$$;

revoke execute on function public.link_unmatched_inbound(uuid, uuid, text, uuid, text) from public;
revoke execute on function public.link_unmatched_inbound(uuid, uuid, text, uuid, text) from anon;
grant  execute on function public.link_unmatched_inbound(uuid, uuid, text, uuid, text) to authenticated, service_role;

-- ============================================================================
-- (I) Snapshot trigger: the identity tier consults live claims
-- ============================================================================
-- Tier ORDER unchanged from PR 1 (participant -> context -> identity ->
-- unknown). The identity tier now resolves through the claims resolver in the
-- intent's own scope (tenancy_id / thread_id): live claims only, human/
-- verified precedence, and the WINNING TIER NAME stamped as resolution_source
-- ('human_link' | 'authoritative_record' | 'verified_claim' |
-- 'provider_learned' | 'legacy'). A multi-party tie freezes 'unknown' rather
-- than guessing (§8). Group-MMS arm untouched. Caller snapshots discarded.

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
  v_n      int;
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
           and ci.address = new.to_address
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
             and ci.address = r_cc.addr
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

notify pgrst, 'reload schema';
