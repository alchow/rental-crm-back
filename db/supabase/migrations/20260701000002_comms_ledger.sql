-- ----------------------------------------------------------------------------
-- Communications ledger (comms build M1) — the generalized resurrection of the
-- messaging subsystem dropped in 20260627000001, per ADR-0007 and the comms
-- build plan (Option D: core owns comms STATE; the provider-calling transport
-- lives in the agent repo and drives this ledger over the /comms API).
--
-- Tables
--   comm_outbox              mutable send intent/progress; committed BEFORE any
--                            provider call; audited (delivery transitions are
--                            hash-chained). Multi-channel (sms|email|voice).
--   comm_opt_outs            global compliance register keyed by (channel,
--                            address), NOT account — member-invisible (RLS with
--                            no policies) to avoid a cross-account address
--                            oracle. Enforced by a BEFORE INSERT trigger on
--                            comm_outbox, not by handler round-trips.
--   inbound_raw              service-tier capture of every inbound message,
--                            written before any matching/journal work;
--                            idempotent by provider_msg_id UNIQUE. Caches the
--                            match result so replays return the same answer.
--   comm_threads             bridged tenant / vendor conversation containers.
--   comm_thread_participants who is in a thread (tenant|landlord_user|vendor|
--                            agent).
--   channel_identities       per-account address book: which address belongs
--                            to which party on which channel.
--   platform_numbers         provider numbers owned by the platform, assigned
--                            per account.
--   thread_channel_bindings  (platform_number, participant_address) -> thread
--                            routing; partial-unique on active rows — a
--                            counterparty has at most ONE active thread per
--                            platform number, which makes inbound routing
--                            deterministic.
--   comm_policies            standing grants (rent_reminder | thread_autonomy
--                            | voice_autonomy); creating one IS the approval.
--
-- interactions
--   + thread_id (composite-FK to comm_threads) — journal rows can belong to a
--     thread; interactions_with_chain is rebuilt to expose it plus derived
--     delivery state (outbox join), same is_head pattern as before.
--   + _enforce_agent_capacity resurrected (dropped with the old pipeline) and
--     extended with the provenance vocabulary: an agent-authored communication
--     must carry external_ref (verifiable message id) AND approval_ref AND
--     (approved_by OR a 'grant:'-prefixed approval_ref). The comms RPCs below
--     are exempted via a transaction-local GUC they set AFTER their own
--     self-defense checks (their inserts carry author_type from the OUTBOX
--     row — e.g. the agent transport completing a landlord-authored send).
--
-- RPCs (grants at the bottom; see db/test/check_definer_grants.sql allowlist)
--   complete_send      DEFINER  the ADR-0007 atomicity point: outbox -> sent
--                               + journal append in ONE transaction.
--   capture_inbound    DEFINER  raw capture + binding resolution + journal.
--   record_opt_out     DEFINER  global register upsert + queued-row parking.
--   list_account_opt_outs DEFINER  landlord read, filtered to addresses the
--                               account already knows (its channel identities).
--   is_address_opted_out DEFINER service-role-only helper (ops/tests; the
--                               enforcement path is the outbox trigger).
--   fail_send          INVOKER  definitive failure / needs_reconcile parking.
--   update_delivery    INVOKER  monotonic delivery-state advancement.
--   reconcile_scan     INVOKER  stale 'sending' rows past a TTL (read-only).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) platform_numbers
-- ============================================================================
-- Provider numbers the platform owns, assigned to an account. Managed by ops
-- (service role); members read them to create thread bindings.
-- id is the PK (the audit trigger derives entity_id from NEW.id); the number
-- itself is globally unique and is what bindings reference.

create table public.platform_numbers (
  id           uuid        primary key default gen_random_uuid(),
  account_id   uuid        not null references public.accounts(id) on delete restrict,
  number       text        not null unique check (number ~ '^\+[1-9][0-9]{6,14}$'),
  provider     text        not null check (length(provider) between 1 and 100),
  capabilities text[]      not null default '{sms}',
  status       text        not null default 'active' check (status in ('active', 'released')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (account_id, id)
);

create index platform_numbers_account_id_idx on public.platform_numbers (account_id);

alter table public.platform_numbers enable row level security;
alter table public.platform_numbers force  row level security;

-- Members READ their account's numbers (to create bindings); writes are
-- ops-only (service role bypasses RLS). No member write policy on purpose.
create policy platform_numbers_member_select on public.platform_numbers
  for select
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

create trigger platform_numbers_audit
  after insert or update or delete on public.platform_numbers
  for each row execute function public._emit_event();

-- ============================================================================
-- (B) channel_identities
-- ============================================================================
-- Per-account address book: which address reaches which party on which
-- channel. Used to resolve outbox destinations and to attribute journal
-- parties on confirmed sends. party_id is polymorphic (tenant/vendor/user id
-- depending on party_type), same convention as interactions.party_id.

create table public.channel_identities (
  id          uuid        primary key default gen_random_uuid(),
  account_id  uuid        not null references public.accounts(id) on delete restrict,
  party_type  text        not null check (party_type in ('tenant', 'landlord_user', 'vendor')),
  party_id    uuid        not null,
  channel     text        not null check (channel in ('sms', 'email', 'voice')),
  address     text        not null check (length(address) between 3 and 320),
  verified_at timestamptz,
  label       text        check (length(label) between 1 and 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (account_id, channel, address),
  unique (account_id, id)
);

alter table public.channel_identities enable row level security;
alter table public.channel_identities force  row level security;

create policy channel_identities_member_all on public.channel_identities
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

create trigger channel_identities_audit
  after insert or update or delete on public.channel_identities
  for each row execute function public._emit_event();

-- ============================================================================
-- (C) comm_threads
-- ============================================================================

create table public.comm_threads (
  id                      uuid        primary key default gen_random_uuid(),
  account_id              uuid        not null references public.accounts(id) on delete restrict,
  kind                    text        not null check (kind in ('bridged_tenant', 'vendor')),
  status                  text        not null default 'active' check (status in ('active', 'closed')),
  tenancy_id              uuid,
  maintenance_request_id  uuid,
  foreign key (account_id, tenancy_id)             references public.tenancies(account_id, id)            on delete set null,
  foreign key (account_id, maintenance_request_id) references public.maintenance_requests(account_id, id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (account_id, id)
);

create index comm_threads_account_id_idx on public.comm_threads (account_id);

alter table public.comm_threads enable row level security;
alter table public.comm_threads force  row level security;

create policy comm_threads_member_all on public.comm_threads
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

create trigger comm_threads_audit
  after insert or update or delete on public.comm_threads
  for each row execute function public._emit_event();

-- ============================================================================
-- (D) comm_thread_participants
-- ============================================================================
-- account_id is denormalized onto every child (house convention): composite
-- FKs pin children to the parent's account at the DB layer, the audit trigger
-- needs it, and the isolation suite asserts on it.

create table public.comm_thread_participants (
  id          uuid        primary key default gen_random_uuid(),
  account_id  uuid        not null references public.accounts(id) on delete restrict,
  thread_id   uuid        not null,
  foreign key (account_id, thread_id) references public.comm_threads(account_id, id) on delete restrict,
  party_type  text        not null check (party_type in ('tenant', 'landlord_user', 'vendor', 'agent')),
  party_id    uuid,
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (account_id, id)
);

create index comm_thread_participants_thread_idx on public.comm_thread_participants (thread_id);

alter table public.comm_thread_participants enable row level security;
alter table public.comm_thread_participants force  row level security;

create policy comm_thread_participants_member_all on public.comm_thread_participants
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

create trigger comm_thread_participants_audit
  after insert or update or delete on public.comm_thread_participants
  for each row execute function public._emit_event();

-- ============================================================================
-- (E) thread_channel_bindings
-- ============================================================================
-- The inbound routing table: an inbound message on platform_number FROM
-- participant_address belongs to exactly one active thread. The partial
-- unique index IS the routing invariant.

create table public.thread_channel_bindings (
  id                   uuid        primary key default gen_random_uuid(),
  account_id           uuid        not null references public.accounts(id) on delete restrict,
  thread_id            uuid        not null,
  participant_id       uuid        not null,
  foreign key (account_id, thread_id)      references public.comm_threads(account_id, id)             on delete restrict,
  foreign key (account_id, participant_id) references public.comm_thread_participants(account_id, id) on delete restrict,
  platform_number      text        not null references public.platform_numbers(number) on delete restrict,
  participant_address  text        not null check (length(participant_address) between 3 and 320),
  active               boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (account_id, id)
);

-- THE routing key: one active thread per (platform number, counterparty).
create unique index thread_channel_bindings_routing_uniq
  on public.thread_channel_bindings (platform_number, participant_address)
  where active;

create index thread_channel_bindings_thread_idx on public.thread_channel_bindings (thread_id);

alter table public.thread_channel_bindings enable row level security;
alter table public.thread_channel_bindings force  row level security;

create policy thread_channel_bindings_member_all on public.thread_channel_bindings
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

create trigger thread_channel_bindings_audit
  after insert or update or delete on public.thread_channel_bindings
  for each row execute function public._emit_event();

-- ============================================================================
-- (F) comm_policies — standing grants
-- ============================================================================

create table public.comm_policies (
  id           uuid        primary key default gen_random_uuid(),
  account_id   uuid        not null references public.accounts(id) on delete restrict,
  policy_kind  text        not null check (policy_kind in ('rent_reminder', 'thread_autonomy', 'voice_autonomy')),
  channel      text        not null check (channel in ('sms', 'email', 'voice')),
  template_id  text        check (length(template_id) between 1 and 200),
  params       jsonb       not null default '{}'::jsonb,
  quiet_hours  jsonb,
  status       text        not null default 'active' check (status in ('active', 'revoked')),
  approved_by  uuid        not null,
  approved_at  timestamptz not null default now(),
  revoked_by   uuid,
  revoked_at   timestamptz,
  -- A revoked policy carries its revocation provenance; an active one must not.
  check ((status = 'revoked') = (revoked_by is not null and revoked_at is not null)),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (account_id, id)
);

create index comm_policies_account_id_idx on public.comm_policies (account_id);

alter table public.comm_policies enable row level security;
alter table public.comm_policies force  row level security;

create policy comm_policies_member_all on public.comm_policies
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

create trigger comm_policies_audit
  after insert or update or delete on public.comm_policies
  for each row execute function public._emit_event();

-- ============================================================================
-- (G) comm_opt_outs + is_address_opted_out()
-- ============================================================================
-- Global per environment. NO member RLS policy: a member-readable register
-- would be a cross-account address oracle. RLS enabled with no policies =
-- authenticated/anon denied; service_role (BYPASSRLS) and SECURITY DEFINER
-- paths are the only access. NOT audited (no account_id; compliance state is
-- operational, dedup/integrity comes from the PK).

create table public.comm_opt_outs (
  channel      text        not null check (channel in ('sms', 'email', 'voice')),
  address      text        not null check (length(address) between 3 and 320),
  opted_out_at timestamptz not null default now(),
  keyword      text        check (length(keyword) between 1 and 50),
  source_ref   text        check (length(source_ref) between 1 and 200),
  primary key (channel, address)
);

alter table public.comm_opt_outs enable row level security;
alter table public.comm_opt_outs force  row level security;
revoke all on public.comm_opt_outs from anon, authenticated;

-- Service-role helper for ops/tests. The hot-path enforcement is the outbox
-- trigger below (trigger functions are exempt from the DEFINER-grant guard
-- and cannot be called via PostgREST), so this does NOT need — and must not
-- have — an authenticated grant: it would be the oracle we just avoided.
create or replace function public.is_address_opted_out(p_channel text, p_address text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.comm_opt_outs
     where channel = p_channel and address = p_address
  );
$$;

revoke execute on function public.is_address_opted_out(text, text) from public;
revoke execute on function public.is_address_opted_out(text, text) from anon;
revoke execute on function public.is_address_opted_out(text, text) from authenticated;
grant execute on function public.is_address_opted_out(text, text) to service_role;

-- ============================================================================
-- (H) inbound_raw
-- ============================================================================
-- Service-tier capture of every inbound message, written BEFORE any matching
-- or journal work (a crash mid-capture means the transport retries the whole
-- call; the provider_msg_id UNIQUE makes the replay a read). The match result
-- is cached on the row so an idempotent replay returns the original answer.
-- Member-invisible (rows may not belong to any account) and NOT audited
-- (no account_id — integrity comes from the UNIQUE constraint).

create table public.inbound_raw (
  id                       uuid        primary key default gen_random_uuid(),
  provider                 text        not null check (length(provider) between 1 and 100),
  provider_msg_id          text        not null unique,
  payload                  jsonb       not null,
  received_at              timestamptz not null default now(),
  -- Cached match result for idempotent replay.
  disposition              text        check (disposition in ('matched', 'orphan', 'opted_out')),
  matched_account_id       uuid        references public.accounts(id),
  matched_thread_id        uuid,
  matched_participant_id   uuid,
  matched_interaction_id   uuid
);

alter table public.inbound_raw enable row level security;
alter table public.inbound_raw force  row level security;
revoke all on public.inbound_raw from anon, authenticated;

-- Ops scan: unrouted traffic that may need a new thread/binding.
create index inbound_raw_orphan_idx
  on public.inbound_raw (disposition)
  where disposition <> 'matched';

-- ============================================================================
-- (I) comm_outbox
-- ============================================================================
-- The operational record for every outbound send attempt, any channel.
-- Written and committed before any provider call (ADR-0007). The immutable
-- journal entry is appended only on confirmed send, in the same transaction
-- that marks this row 'sent' (complete_send below).

create table public.comm_outbox (
  id                       uuid        primary key default gen_random_uuid(),
  account_id               uuid        not null references public.accounts(id) on delete restrict,
  channel                  text        not null check (channel in ('sms', 'email', 'voice')),
  -- Resolved destination, frozen at intent time (identity edits later never
  -- rewrite what was dialed). E.164 for sms/voice; address format for email
  -- is validated at the API layer.
  to_address               text        not null check (length(to_address) between 3 and 320),
  thread_id                uuid,
  participant_id           uuid,
  foreign key (account_id, thread_id)      references public.comm_threads(account_id, id),
  foreign key (account_id, participant_id) references public.comm_thread_participants(account_id, id),
  body                     text        not null check (length(body) between 1 and 20000),
  -- Channel-specific cap: an SMS body is bounded by carrier segmentation.
  check (channel <> 'sms' or length(body) <= 1600),
  template_id              text        check (length(template_id) between 1 and 200),
  not_before               timestamptz,
  relay_of_interaction_id  uuid,
  foreign key (account_id, relay_of_interaction_id) references public.interactions(account_id, id),
  status                   text        not null default 'queued'
                           check (status in (
                             'queued', 'sending', 'sent', 'delivered',
                             'failed', 'undeliverable', 'needs_reconcile'
                           )),
  error_code               text,
  error_message            text,
  provider                 text        check (length(provider) between 1 and 100),
  -- Provider message id; null until the provider accepts. Unique so a
  -- duplicate callback or a replayed completion is always a no-op.
  provider_sid             text        unique,
  -- Server-generated opaque ref the transport hands to the provider so
  -- callbacks can always re-associate with this row.
  client_ref               text        not null unique default gen_random_uuid()::text,
  approval_ref             text        not null check (length(approval_ref) between 1 and 200),
  approved_by              uuid,
  -- DB backstop of the provenance invariant: a send is either human-approved
  -- (approved_by set — proposal:/self: refs) or grant-authorized.
  check (approved_by is not null or approval_ref like 'grant:%'),
  author_type              text        not null check (author_type in ('landlord', 'agent')),
  -- Set when the journal interaction is appended by complete_send.
  interaction_id           uuid,
  foreign key (account_id, interaction_id) references public.interactions(account_id, id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  delivered_at             timestamptz,
  unique (account_id, id)
);

create index comm_outbox_account_id_idx on public.comm_outbox (account_id);
-- One outbox row per journal entry, structurally: a duplicate link would
-- duplicate rows through the interactions_with_chain join (pagination
-- correctness, not just noise). Doubles as the view's join index.
create unique index comm_outbox_interaction_id_uniq
  on public.comm_outbox (interaction_id)
  where interaction_id is not null;
-- Dispatch/reconcile scans touch only rows that still need attention.
create index comm_outbox_pending_idx
  on public.comm_outbox (account_id, status, not_before)
  where status in ('queued', 'sending', 'needs_reconcile');
-- Relay fan-out lookup (per-leg delivery state for a journal row).
create index comm_outbox_relay_idx
  on public.comm_outbox (relay_of_interaction_id)
  where relay_of_interaction_id is not null;

alter table public.comm_outbox enable row level security;
alter table public.comm_outbox force  row level security;

create policy comm_outbox_member_all on public.comm_outbox
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

-- AUDIT: every status transition is hash-chained; delivery state becomes
-- tamper-evident WITHOUT ever mutating the interactions journal (ADR-0007).
create trigger comm_outbox_audit
  after insert or update or delete on public.comm_outbox
  for each row execute function public._emit_event();

-- ----------------------------------------------------------------------------
-- Opt-out enforcement at the intent boundary. Refusing a send leaves no
-- journal trace (nothing happened) — the insert simply fails with a typed
-- error the API maps to 422. Runs as a SECURITY DEFINER trigger because the
-- register is member-invisible; trigger functions are not PostgREST-callable
-- and are exempt from the DEFINER-grant guard.
-- ----------------------------------------------------------------------------
create or replace function public._comm_outbox_refuse_opted_out()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.comm_opt_outs
     where channel = new.channel and address = new.to_address
  ) then
    raise exception 'destination address has opted out of % messages', new.channel
      using errcode = 'P0004';
  end if;
  return new;
end;
$$;

create trigger comm_outbox_refuse_opted_out
  before insert on public.comm_outbox
  for each row execute function public._comm_outbox_refuse_opted_out();

-- ----------------------------------------------------------------------------
-- State-machine guard: outbox transitions are monotonic (invariant 6) and the
-- immutable intent fields can never be rewritten, even by a member writing
-- through PostgREST directly. Ranks: queued(0) -> sending(1) ->
-- needs_reconcile(2) -> sent(3) -> delivered(4); failed/undeliverable(9)
-- terminal. needs_reconcile sits below 'sent' so the documented manual
-- resolution (complete or fail) is a forward move.
-- ----------------------------------------------------------------------------
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

create trigger comm_outbox_guard_update
  before update on public.comm_outbox
  for each row execute function public._comm_outbox_guard_update();

-- ============================================================================
-- (J) interactions.thread_id + capacity trigger + chain view rebuild
-- ============================================================================

alter table public.interactions
  add column thread_id uuid,
  add constraint interactions_thread_fk
    foreign key (account_id, thread_id) references public.comm_threads(account_id, id);

-- Thread detail read path: journal rows for a thread, newest first.
create index interactions_thread_idx
  on public.interactions (account_id, thread_id, occurred_at desc)
  where thread_id is not null;

-- ----------------------------------------------------------------------------
-- Capacity-honesty backstop (resurrected from 20260616000003 §E, extended
-- with the provenance vocabulary). Members hold real JWTs and can write to
-- interactions via PostgREST directly, bypassing the API firewall; the
-- invariants that protect EVIDENCE HONESTY get a DB shadow.
--
-- When the inserting principal is an agent-role member of NEW.account_id:
--   - author_type must be 'agent'
--   - corrects_id must be null (agents never supersede history)
--   - kind='communication' requires external_ref (verifiable message id)
--     AND approval_ref AND (approved_by OR approval_ref LIKE 'grant:%')
--
-- Exempt paths:
--   - auth.uid() null (service/admin) — unchanged from the original.
--   - comm.verified_write GUC — set transaction-locally by complete_send /
--     capture_inbound AFTER their own self-defense checks. Those paths write
--     author_type from the OUTBOX/participant (e.g. the agent transport
--     completing a landlord-authored send writes author_type='landlord';
--     an inbound tenant message writes author_type='tenant'), which is
--     exactly the honest attribution the naive rule would forbid. The GUC
--     cannot be set through PostgREST by a caller: only these RPCs set it,
--     inside their own transaction.
-- ----------------------------------------------------------------------------
create or replace function public._enforce_agent_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if coalesce(current_setting('comm.verified_write', true), '') = 'on' then
    return new;
  end if;

  if not exists (
    select 1
      from public.account_members m
     where m.user_id     = auth.uid()
       and m.account_id  = new.account_id
       and m.role        = 'agent'
       and m.deleted_at  is null
  ) then
    return new;
  end if;

  if new.author_type is distinct from 'agent' then
    raise exception 'agent principal must write author_type=agent'
      using errcode = 'check_violation';
  end if;

  if new.corrects_id is not null then
    raise exception 'agent principal may not correct or retract journal entries'
      using errcode = 'check_violation';
  end if;

  if new.kind = 'communication' then
    if new.external_ref is null then
      raise exception 'agent-authored communications require external_ref (verifiable message id)'
        using errcode = 'check_violation';
    end if;
    if new.approval_ref is null
       or (new.approved_by is null and new.approval_ref not like 'grant:%') then
      raise exception 'agent-authored communications require approval provenance (approved_by or a grant: approval_ref)'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger interactions_enforce_agent_capacity
  before insert on public.interactions
  for each row execute function public._enforce_agent_capacity();

-- ----------------------------------------------------------------------------
-- Rebuild the chain view: pick up the new interactions.thread_id column
-- (i.* is expanded at creation time) and re-expose derived delivery state
-- via the outbox join — the shape 20260627000001 removed, generalized.
-- ----------------------------------------------------------------------------
drop view public.interactions_with_chain;
create view public.interactions_with_chain
  with (security_invoker = true) as
  select i.*,
         c.id as superseded_by_id,
         (c.id is null) as is_head,
         o.id          as outbox_id,
         o.status      as delivery_status,
         o.delivered_at
  from public.interactions i
  left join public.interactions c on c.corrects_id = i.id
  left join public.comm_outbox o on o.interaction_id = i.id;

grant select on public.interactions_with_chain to authenticated, service_role;

-- ============================================================================
-- (K) Journal-channel mapping helper
-- ============================================================================
-- interactions.channel vocabulary predates comms ('voice' is not a journal
-- channel; a voice contact is 'phone'). Single mapping point for both RPCs.

create or replace function public._comm_journal_channel(p_channel text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_channel when 'voice' then 'phone' else p_channel end;
$$;

-- ============================================================================
-- (L) complete_send — ADR-0007 ATOMICITY POINT
-- ============================================================================
-- One call = one transaction that locks the outbox row, appends the immutable
-- journal entry (external_ref = provider sid, provenance from the outbox
-- row), marks the row sent, and links the journal id.
--
-- SECURITY DEFINER with explicit self-defense (the transport completes
-- landlord-authored sends, so caller-RLS + the capacity trigger would reject
-- the honest attribution): the caller must be a live member of the outbox
-- row's account. auth.uid() survives DEFINER, so the audit chain still
-- records the true caller on both writes.
--
-- Idempotent: a replay with the same provider_sid on an already-sent row
-- returns the existing interaction id without writing anything.

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
  v_outbox      public.comm_outbox%rowtype;
  v_interaction public.interactions%rowtype;
  v_party_type  text;
  v_party_id    uuid;
  v_party_label text;
  v_author_type text;
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

  -- Idempotent replay: same sid, already completed -> return the journal id.
  if v_outbox.status in ('sent', 'delivered') and v_outbox.provider_sid = p_provider_sid then
    return v_outbox.interaction_id;
  end if;

  if v_outbox.status not in ('queued', 'sending', 'needs_reconcile') then
    raise exception 'outbox row is not completable (status=%)', v_outbox.status
      using errcode = 'P0003';
  end if;

  -- Party attribution, best source first: the bound thread participant,
  -- else the account's channel identity for the dialed address, else the
  -- 'unspecified' sentinel with the address as the label.
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

  v_author_type := v_outbox.author_type;

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
    v_outbox.body,
    now(),
    null,
    null,
    v_outbox.thread_id,
    null, null, null, null,
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
-- (M) fail_send — definitive rejection or needs_reconcile parking
-- ============================================================================
-- SECURITY INVOKER: RLS applies as the caller (member-only reach), the audit
-- chain records the true auth.uid(), and no journal write happens (nothing
-- was sent — ADR-0007: a record never claims a send that didn't happen).

create or replace function public.fail_send(
  p_outbox_id  uuid,
  p_error_code text,
  p_detail     text default null,
  p_reconcile  boolean default false
)
returns public.comm_outbox
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_outbox public.comm_outbox%rowtype;
  v_target text := case when p_reconcile then 'needs_reconcile' else 'failed' end;
begin
  select * into v_outbox
    from public.comm_outbox
   where id = p_outbox_id
  for update;

  if not found then
    raise exception 'outbox row not found' using errcode = 'P0002';
  end if;

  -- Idempotent replay: already in the requested terminal/parked state.
  if v_outbox.status = v_target then
    return v_outbox;
  end if;

  if v_outbox.status not in ('queued', 'sending')
     and not (v_outbox.status = 'needs_reconcile' and not p_reconcile) then
    raise exception 'outbox row is not failable (status=%)', v_outbox.status
      using errcode = 'P0003';
  end if;

  update public.comm_outbox
     set status        = v_target,
         error_code    = p_error_code,
         error_message = p_detail,
         updated_at    = now()
   where id = p_outbox_id
  returning * into v_outbox;

  return v_outbox;
end;
$$;

revoke execute on function public.fail_send(uuid, text, text, boolean) from public;
revoke execute on function public.fail_send(uuid, text, text, boolean) from anon;
grant  execute on function public.fail_send(uuid, text, text, boolean) to authenticated, service_role;

-- ============================================================================
-- (N) update_delivery — monotonic delivery-state advancement
-- ============================================================================
-- SECURITY INVOKER (same rationale as fail_send). Stale, duplicate, or
-- out-of-order callbacks return the row unchanged — providers retry and
-- reorder; the ledger only ever moves forward. 'sending' is accepted so the
-- transport can claim a queued row before dialing (the ADR-0007 crash-window
-- marker).

create or replace function public.update_delivery(
  p_outbox_id   uuid,
  p_status      text,
  p_provider_ts timestamptz,
  p_error_code  text default null
)
returns public.comm_outbox
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_outbox   public.comm_outbox%rowtype;
  v_cur_rank int;
  v_new_rank int;
begin
  select * into v_outbox
    from public.comm_outbox
   where id = p_outbox_id
  for update;

  if not found then
    raise exception 'outbox row not found' using errcode = 'P0002';
  end if;

  v_cur_rank := case v_outbox.status
    when 'queued' then 0 when 'sending' then 1 when 'needs_reconcile' then 2
    when 'sent' then 3 when 'delivered' then 4 else 9 end;
  v_new_rank := case p_status
    when 'sending' then 1 when 'sent' then 3 when 'delivered' then 4
    when 'failed' then 9 when 'undeliverable' then 9 else -1 end;

  -- Unknown status input, already-terminal row, or a non-forward move:
  -- return unchanged (callbacks are at-least-once and unordered).
  if v_new_rank = -1 or v_cur_rank = 9 or v_new_rank <= v_cur_rank then
    return v_outbox;
  end if;

  -- A row can only be marked sent/delivered through complete_send first
  -- (the journal append is what 'sent' MEANS); a callback for a row that
  -- was never completed must park for reconciliation instead of minting
  -- delivery state with no journal entry.
  if v_new_rank >= 3 and v_outbox.provider_sid is null then
    return v_outbox;
  end if;

  update public.comm_outbox
     set status        = p_status,
         error_code    = case when p_status in ('failed', 'undeliverable') then p_error_code else error_code end,
         error_message = case when p_status in ('failed', 'undeliverable') then coalesce(error_message, 'provider delivery failure') else error_message end,
         delivered_at  = case when p_status = 'delivered' then p_provider_ts else delivered_at end,
         updated_at    = now()
   where id = p_outbox_id
  returning * into v_outbox;

  return v_outbox;
end;
$$;

revoke execute on function public.update_delivery(uuid, text, timestamptz, text) from public;
revoke execute on function public.update_delivery(uuid, text, timestamptz, text) from anon;
grant  execute on function public.update_delivery(uuid, text, timestamptz, text) to authenticated, service_role;

-- ============================================================================
-- (O) reconcile_scan — stale 'sending' rows past a TTL
-- ============================================================================
-- Read-only; never auto-retries, never marks failed (the transport checks the
-- provider and resolves each row via complete_send or fail_send). SECURITY
-- INVOKER: member RLS scopes the scan.

create or replace function public.reconcile_scan(
  p_account_id  uuid,
  p_ttl_seconds int default 3600
)
returns setof public.comm_outbox
language sql
stable
security invoker
set search_path = public
as $$
  select * from public.comm_outbox
   where account_id = p_account_id
     and status = 'sending'
     and updated_at < now() - make_interval(secs => p_ttl_seconds)
   order by updated_at asc;
$$;

revoke execute on function public.reconcile_scan(uuid, int) from public;
revoke execute on function public.reconcile_scan(uuid, int) from anon;
grant  execute on function public.reconcile_scan(uuid, int) to authenticated, service_role;

-- ============================================================================
-- (P) capture_inbound — raw capture, binding resolution, journal append
-- ============================================================================
-- SECURITY DEFINER: writes the member-invisible raw tier and reads the
-- opt-out register. Self-defense: the caller must be an agent-role member of
-- p_account_id (the transport is the only intended caller) — checked BEFORE
-- any write. Idempotent on provider_msg_id: a replay returns the cached
-- result without writing.
--
-- Capture-first ordering: the raw row is written before matching, so any
-- later failure leaves evidence and the transport's retry is answered from
-- the dedupe. Opt-out state affects the DISPOSITION (the transport must not
-- relay), but a matched message is still journaled — the contact happened.

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

  -- Idempotent replay: answered from the cached match result.
  select * into v_raw from public.inbound_raw where provider_msg_id = p_provider_msg_id;
  if found then
    disposition    := v_raw.disposition;
    interaction_id := v_raw.matched_interaction_id;
    thread_id      := v_raw.matched_thread_id;
    participant_id := v_raw.matched_participant_id;
    return next;
    return;
  end if;

  -- Capture first. A unique-violation race with a concurrent replay is
  -- resolved by re-reading the winner's cached result.
  begin
    insert into public.inbound_raw (provider, provider_msg_id, payload, received_at)
    values (
      p_provider,
      p_provider_msg_id,
      jsonb_build_object(
        'to_number', p_to_number, 'from_address', p_from_address,
        'channel', p_channel, 'body', p_body, 'media', coalesce(p_media, '[]'::jsonb),
        'account_id', p_account_id
      ),
      p_received_at
    )
    returning * into v_raw;
  exception when unique_violation then
    select * into v_raw from public.inbound_raw where provider_msg_id = p_provider_msg_id;
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
       set disposition = 'orphan', matched_account_id = p_account_id
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
-- (Q) record_opt_out — global register upsert + queued-row parking
-- ============================================================================
-- SECURITY DEFINER (the register is member-invisible). Self-defense: the
-- caller must be an agent-role member of p_account_id — the transport is the
-- only writer (it terminates the provider webhooks that carry STOP keywords).
-- First opt-out wins (the original keyword/source are the evidence); replays
-- return the existing row. Queued-but-unsent intents to the address are
-- parked 'undeliverable' EVERYWHERE — compliance is global, and dialing a
-- known-opted-out number from any account is the thing this register exists
-- to prevent. ('sending' rows are mid-flight; the provider refuses those.)

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

  insert into public.comm_opt_outs (channel, address, keyword, source_ref)
  values (p_channel, p_address, p_keyword, p_source_ref)
  on conflict (channel, address) do nothing;

  select * into v_row
    from public.comm_opt_outs
   where channel = p_channel and address = p_address;

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
-- (R) list_account_opt_outs — landlord read, account-scoped by intersection
-- ============================================================================
-- SECURITY DEFINER over the member-invisible register, but self-defending:
-- membership in p_account_id is required, and the result is INTERSECTED with
-- the account's own channel_identities — a member can only ever learn the
-- opt-out state of addresses their account already stores, never probe
-- arbitrary addresses.

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

  return query
    select oo.*
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
