-- ----------------------------------------------------------------------------
-- Outbound messaging schema (agent-api plan Workstream E; ADR-0007).
--
-- Two new operational tables:
--   message_outbox   mutable send intent/progress record; committed BEFORE any
--                    provider call; audited so every status transition is
--                    hash-chained (delivered-state becomes tamper-evident
--                    without ever mutating the immutable interactions journal).
--   sms_opt_outs     global carrier opt-out registry; no member RLS (cross-
--                    account phone oracle risk); checked by a SECURITY DEFINER
--                    function before the outbox row is ever written.
--
-- Two new completion RPCs:
--   complete_sms_send   ATOMICITY POINT: one call = one transaction that marks
--                       the outbox 'sent' AND appends the journal interaction.
--   fail_sms_send       marks the outbox 'failed' with provider error details;
--                       no journal entry (nothing was sent).
--
-- One new DB backstop trigger on interactions:
--   _enforce_agent_capacity   BEFORE INSERT; enforces evidence-honesty
--   invariants for the agent role that must survive an API bypass (ADR-0006,
--   ADR-0007, ADR-0008). DB shadow of api/src/routes/_lib/agent-firewall.ts.
--
-- View:
--   interactions_with_chain   recreated with left join to message_outbox to
--   expose delivery_status and delivered_at as derived read-only fields
--   (same is_head pattern — delivery state never mutates the journal).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) message_outbox
-- ============================================================================
--
-- The OPERATIONAL tier record for every outbound send attempt. Written and
-- committed before any provider call (ADR-0007 outbox-first invariant). The
-- immutable journal entry is appended only on confirmed send, in the same
-- transaction that marks this row 'sent'.
--
-- RLS: enable + force; one FOR ALL policy in the ADR-0003 IN-subquery form
-- so the membership set is evaluated once per statement (hashed initplan)
-- rather than once per candidate row.

create table public.message_outbox (
  id              uuid        primary key default gen_random_uuid(),
  account_id      uuid        not null references public.accounts(id) on delete restrict,
  channel         text        not null check (channel in ('sms')),   -- email later: same table, wider check
  tenant_id       uuid,
  vendor_id       uuid,
  -- Exactly one counterparty: either a tenant or a vendor, never both, never neither.
  check (num_nonnulls(tenant_id, vendor_id) = 1),
  foreign key (account_id, tenant_id)  references public.tenants(account_id, id)  on delete restrict,
  foreign key (account_id, vendor_id)  references public.vendors(account_id, id)  on delete restrict,
  -- Resolved E.164, frozen at send time so the audit record is immutable
  -- even if the tenant/vendor's stored phone number is later changed.
  to_phone        text        not null check (to_phone ~ '^\+[1-9][0-9]{6,14}$'),
  body            text        not null check (length(body) between 1 and 1600),
  status          text        not null default 'sending'
                              check (status in (
                                'sending', 'sent', 'delivered',
                                'failed', 'undeliverable', 'needs_reconcile'
                              )),
  -- Twilio MessageSid; null until the provider accepts. Unique so a
  -- duplicate-SID callback (Phase 5) is always a no-op.
  provider_sid    text        unique,
  error_code      text,
  error_message   text,
  -- Set when the journal interaction is appended by complete_sms_send.
  interaction_id  uuid,
  foreign key (account_id, interaction_id) references public.interactions(account_id, id),
  -- Capacity mirror for ops debugging: who authored the send and under
  -- what approval (mirrors the journal row produced by complete_sms_send).
  author_type     text        not null check (author_type in ('landlord', 'agent')),
  created_by_actor text       not null check (length(created_by_actor) between 1 and 200),
  approval_ref    text        check (length(approval_ref) between 1 and 200),
  -- Optional context refs: same on-delete-set-null pattern as interactions.
  tenancy_id              uuid,
  maintenance_request_id  uuid,
  work_order_id           uuid,
  foreign key (account_id, tenancy_id)             references public.tenancies(account_id, id)             on delete set null,
  foreign key (account_id, maintenance_request_id) references public.maintenance_requests(account_id, id) on delete set null,
  foreign key (account_id, work_order_id)          references public.work_orders(account_id, id)          on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  -- Composite unique so child tables can FK on (account_id, id) and thereby
  -- pin every child to the same account at the DB layer (house convention).
  unique (account_id, id)
);

create index message_outbox_account_id_idx on public.message_outbox (account_id);
-- One outbox row per journal entry, structurally: a duplicate link would
-- duplicate interaction rows through the interactions_with_chain view join
-- (a pagination correctness bug, not just noise). Doubles as the join index
-- for that view's read path.
create unique index message_outbox_interaction_id_uniq
  on public.message_outbox (interaction_id)
  where interaction_id is not null;
-- Partial index for the reconcile janitor's scan (Phase 5): only rows that
-- still need attention are in scope, keeping the index tight.
create index message_outbox_pending_idx
  on public.message_outbox (status)
  where status in ('sending', 'needs_reconcile');

-- RLS: enable + force; one FOR ALL policy in ADR-0003 form B.
alter table public.message_outbox enable row level security;
alter table public.message_outbox force  row level security;

create policy message_outbox_member_all on public.message_outbox
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

-- AUDIT: attach _emit_event so every status transition is hash-chained.
-- Delivery state (sent → delivered) becomes tamper-evident WITHOUT ever
-- mutating the interactions journal (ADR-0007). The chain records the true
-- auth.uid() on every write because complete_sms_send / fail_sms_send are
-- SECURITY INVOKER.
create trigger message_outbox_audit
  after insert or update or delete on public.message_outbox
  for each row execute function public._emit_event();

-- ============================================================================
-- (B) sms_opt_outs + is_phone_opted_out()
-- ============================================================================
--
-- Global per environment (one Twilio Messaging Service serves all accounts).
-- No member-readable RLS: a table visible to all members would be a cross-
-- account phone oracle (any member could enumerate opt-out phones not in their
-- own account's tenant/vendor set). Service-role writes only (Phase 5 webhook).
-- NOT audited: no account_id column, compliance state is operational.

create table public.sms_opt_outs (
  phone        text        primary key check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  opted_out_at timestamptz not null default now(),
  last_keyword text,
  source_sid   text
);

alter table public.sms_opt_outs enable row level security;
-- NO policies: with RLS enabled and no policies, every authenticated/anon
-- role is denied. Service-role (BYPASSRLS) can still write.
revoke all on public.sms_opt_outs from anon, authenticated;

-- is_phone_opted_out: the send path must refuse opted-out numbers BEFORE
-- dialing; SECURITY DEFINER because the table is deliberately member-invisible.
create or replace function public.is_phone_opted_out(p_phone text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.sms_opt_outs where phone = p_phone);
$$;

grant execute on function public.is_phone_opted_out(text) to authenticated;

-- ============================================================================
-- (C) complete_sms_send — ADR-0007 ATOMICITY POINT
-- ============================================================================
--
-- One function call = one transaction that:
--   1. Locks the outbox row for update and validates its state.
--   2. Inserts the immutable journal interaction (channel='sms', external_ref=SID).
--   3. Marks the outbox 'sent', stores the SID, and links interaction_id.
--
-- SECURITY INVOKER: RLS applies as the caller, and the audit trigger records
-- the true auth.uid() on both writes. This is load-bearing — do not change
-- to SECURITY DEFINER without also auditing both write paths for attribution.

create or replace function public.complete_sms_send(
  p_outbox_id   uuid,
  p_provider_sid text
)
returns public.interactions
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_outbox      public.message_outbox%rowtype;
  v_interaction public.interactions%rowtype;
  v_party_type  text;
  v_party_id    uuid;
begin
  -- Lock the outbox row. NOT FOUND covers both a genuinely missing row and
  -- an RLS-invisible row (the caller's RLS applies; this is load-bearing).
  select * into v_outbox
    from public.message_outbox
   where id = p_outbox_id
  for update;

  if not found then
    raise exception 'outbox row not found' using errcode = 'P0002';
  end if;

  if v_outbox.status <> 'sending' then
    raise exception 'outbox row is not in sending state (status=%)', v_outbox.status
      using errcode = 'P0003';
  end if;

  -- Determine counterparty from whichever ref is set (check constraint
  -- guarantees exactly one is non-null).
  if v_outbox.tenant_id is not null then
    v_party_type := 'tenant';
    v_party_id   := v_outbox.tenant_id;
  else
    v_party_type := 'vendor';
    v_party_id   := v_outbox.vendor_id;
  end if;

  -- Append the immutable journal entry. actor = 'user:<auth.uid()>' so the
  -- chain records the true caller, consistent with every other write.
  insert into public.interactions (
    account_id,
    actor,
    author_type,
    approved_by,
    approval_ref,
    entry_type,
    external_ref,
    kind,
    channel,
    direction,
    party_type,
    party_id,
    party_label,
    body,
    occurred_at,
    corrects_id,
    correction_kind,
    tenancy_id,
    maintenance_request_id,
    area_id,
    work_order_id,
    vendor_id
  ) values (
    v_outbox.account_id,
    'user:' || (select auth.uid()),
    v_outbox.author_type,
    null,                          -- approved_by: the approval decision lives on outbox.approval_ref; the journal records what happened, not the approval chain
    v_outbox.approval_ref,
    null,                          -- entry_type: only for kind='agent_event'
    p_provider_sid,                -- external_ref: the Twilio MessageSid
    'communication',
    'sms',
    'outbound',
    v_party_type,
    v_party_id,
    null,
    v_outbox.body,
    now(),
    null,
    null,
    v_outbox.tenancy_id,
    v_outbox.maintenance_request_id,
    null,                          -- area_id: not threaded through send path
    v_outbox.work_order_id,
    v_outbox.vendor_id
  )
  returning * into v_interaction;

  -- Mark the outbox sent and link the new journal row. Both writes are in
  -- the same transaction — the atomicity guarantee of ADR-0007 option C.
  update public.message_outbox
     set status         = 'sent',
         provider_sid   = p_provider_sid,
         interaction_id = v_interaction.id,
         updated_at     = now()
   where id = p_outbox_id;

  return v_interaction;
end;
$$;

grant execute on function public.complete_sms_send(uuid, text) to authenticated;

-- ============================================================================
-- (D) fail_sms_send
-- ============================================================================
--
-- Marks the outbox row 'failed' with provider error details. No journal entry
-- because nothing was sent (ADR-0007: a record can never claim a send that
-- did not happen). The outbox row carries the attempt; the audit trigger
-- chains this status transition.
--
-- SECURITY INVOKER: same rationale as complete_sms_send.

create or replace function public.fail_sms_send(
  p_outbox_id    uuid,
  p_error_code   text,
  p_error_message text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_outbox public.message_outbox%rowtype;
begin
  select * into v_outbox
    from public.message_outbox
   where id = p_outbox_id
  for update;

  if not found then
    raise exception 'outbox row not found' using errcode = 'P0002';
  end if;

  if v_outbox.status <> 'sending' then
    raise exception 'outbox row is not in sending state (status=%)', v_outbox.status
      using errcode = 'P0003';
  end if;

  update public.message_outbox
     set status        = 'failed',
         error_code    = p_error_code,
         error_message = p_error_message,
         updated_at    = now()
   where id = p_outbox_id;
end;
$$;

grant execute on function public.fail_sms_send(uuid, text, text) to authenticated;

-- ============================================================================
-- (E) Capacity-honesty backstop trigger on interactions
-- ============================================================================
--
-- Members hold real Supabase JWTs and can write to interactions via PostgREST
-- directly, bypassing the API firewall. App-layer checks need a DB backstop
-- for the invariants that protect EVIDENCE HONESTY.
--
-- When the inserting principal is an agent-role member of NEW.account_id:
--   - author_type must be 'agent' (else raise)
--   - corrects_id must be null (agents never supersede history)
--   - kind='communication' requires external_ref not null (a communication
--     from the agent must reference a provider message SID; fabricating an
--     unverifiable contact is structurally blocked)
--
-- When auth.uid() is null (admin/service path) or the member is not
-- agent-role: no checks (landlord/intake/import behavior unchanged).
--
-- This is the DB shadow of api/src/routes/_lib/agent-firewall.ts —
-- defense in depth for the only invariants that must survive an API bypass.
-- Residual risk (agent inventing a fake SID) is detectable via
-- outbox/provider reconciliation, accepted per ADR-0006's honesty-not-
-- authorization scope.

create or replace function public._enforce_agent_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Admin/service-role path: auth.uid() is null; skip all checks.
  if auth.uid() is null then
    return new;
  end if;

  -- Only enforce when the inserting user is an agent-role member of this account.
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

  -- Invariant 1: agent principal must stamp author_type='agent'.
  if new.author_type is distinct from 'agent' then
    raise exception 'agent principal must write author_type=agent'
      using errcode = 'check_violation';
  end if;

  -- Invariant 2: agents never supersede history.
  if new.corrects_id is not null then
    raise exception 'agent principal may not correct or retract journal entries'
      using errcode = 'check_violation';
  end if;

  -- Invariant 3: a communication from the agent must reference a provider
  -- message SID (external_ref). This structurally blocks an agent from
  -- fabricating an unverifiable contact in the evidence journal.
  if new.kind = 'communication' and new.external_ref is null then
    raise exception 'agent-authored communications require external_ref (provider SID)'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger interactions_enforce_agent_capacity
  before insert on public.interactions
  for each row execute function public._enforce_agent_capacity();

-- ============================================================================
-- (F) Recreate interactions_with_chain view
-- ============================================================================
--
-- Extended with a left join to message_outbox on interaction_id to expose
-- delivery_status and delivered_at as derived read-only fields. The journal
-- row is never mutated: delivery state advances on the outbox row (audited),
-- and the view projects it onto the interaction read-path. Pattern mirrors
-- how is_head / superseded_by_id are derived rather than stored.

drop view public.interactions_with_chain;
create view public.interactions_with_chain
  with (security_invoker = true) as
  select i.*,
         c.id as superseded_by_id,
         (c.id is null) as is_head,
         o.status      as delivery_status,
         o.delivered_at
  from public.interactions i
  left join public.interactions c on c.corrects_id = i.id
  left join public.message_outbox o on o.interaction_id = i.id;

grant select on public.interactions_with_chain to authenticated, service_role;
