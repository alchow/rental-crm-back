-- ----------------------------------------------------------------------------
-- Agent multi-tenant scaffolding + proposal-lifecycle vocabulary
-- (ADR-0009, Phase 1).
--
-- THREE additive deltas (no behavior change for existing callers; the
-- agent-token endpoints that CONSUME these tables land in ADR-0009 Phases 2-3):
--
--   (A) agent_principals: the root agent principal(s) -- one machine-owned
--       identity per deployment that authenticates to core's token-exchange
--       endpoint. Created here so agent_grants can FK to it; the root-auth
--       credential column is added in Phase 3 once the mechanism is fixed.
--       SECURITY: deny-all to authenticated/anon -- this table is owned
--       exclusively by the admin/ service-role path (ADR-0006 quarantine).
--
--   (B) agent_grants: per-account consent registry mapping (root principal,
--       account) -> the per-account service-account user (the role='agent'
--       member of that account) + permitted scopes. Landlord-facing
--       grant/revoke endpoints (Phase 2) WRITE these via the admin/ path
--       (provisioning the sub-user + membership is privileged); members may
--       only READ their own account's grants. This is the per-account,
--       revocable-independently-of-the-root authority ADR-0009 introduces.
--
--   (C) Proposal-lifecycle journal vocabulary: four new agent_event
--       entry_types (the agent journals proposal lifecycle as agent_events,
--       never as landlord-approval notes -- ADR-0009 contract item 2), plus
--       references_interaction_id so a step_executed event can anchor to a
--       journal entry / prior interaction (not only a maintenance/work-order
--       ref). Adding columns is chain-compatible by snapshot hashing (ADR-0008).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) agent_principals
-- ============================================================================

create table public.agent_principals (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique
                constraint agent_principals_name_len check (length(name) between 1 and 100),
  description text
                constraint agent_principals_description_len
                check (description is null or length(description) <= 500),
  created_at  timestamptz not null default now(),
  disabled_at timestamptz
);

comment on table public.agent_principals is
  'Root agent principal(s) for the token-exchange flow (ADR-0009). Admin/service-role owned; deny-all to authenticated. Root-auth credential column lands in Phase 3.';

-- Deny-all: RLS on with NO authenticated policy, plus an explicit REVOKE of
-- the schema-wide default privileges. Only the service-role (admin/) path
-- touches this table; it never appears on the user-scoped data path.
alter table public.agent_principals enable row level security;
revoke all on public.agent_principals from anon, authenticated;

-- ============================================================================
-- (B) agent_grants
-- ============================================================================

create table public.agent_grants (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references public.accounts(id) on delete cascade,
  agent_principal_id uuid not null references public.agent_principals(id) on delete cascade,
  -- The per-account service-account user: the role='agent' member of
  -- account_id whose Supabase session the mint path issues (ADR-0009 Option A).
  agent_user_id      uuid not null references auth.users(id) on delete cascade,
  scopes             text[] not null default '{}',
  -- The landlord (owner/manager) who enabled the agent -- the grant's sponsor,
  -- for audit. Nullable so a system/admin-initiated grant is representable.
  granted_by         uuid references public.users(id),
  granted_at         timestamptz not null default now(),
  revoked_at         timestamptz,
  revoked_by         uuid references public.users(id)
);

comment on table public.agent_grants is
  'Per-account agent consent (ADR-0009). At most one active grant per (account, principal); revoke is independent of the root credential. Mutated only via the admin/ provisioning path; members may read their own account grants.';

-- At most one ACTIVE grant per (account, principal). Revoked rows are kept
-- for audit, so the uniqueness is partial.
create unique index agent_grants_active_uq
  on public.agent_grants (account_id, agent_principal_id)
  where revoked_at is null;

-- RLS-form-B membership lookups + mint lookup by sub-user.
create index agent_grants_account_idx    on public.agent_grants (account_id);
create index agent_grants_agent_user_idx on public.agent_grants (agent_user_id);

alter table public.agent_grants enable row level security;

-- SELECT: any non-deleted member of the account may see its agent grants
-- (transparency -- the agent's presence is already visible in the journal).
-- Initplan IN-subquery form (ADR-0003): the membership set is evaluated once
-- per statement, not once per candidate row.
create policy agent_grants_select on public.agent_grants
  for select to authenticated
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

-- No INSERT/UPDATE/DELETE policy for authenticated. Grant creation and
-- revocation are privileged flows (they also provision/retire the sub-user
-- and its role='agent' membership) and run through the admin/ service-role
-- path -- the same quarantine the intake-token mint uses. service_role
-- bypasses RLS; authenticated cannot fabricate or alter a grant row.

-- ============================================================================
-- (C) Proposal-lifecycle vocabulary + step_executed interaction anchor
-- ============================================================================

-- Four new agent_event entry_types (ADR-0009 contract item 2). All are
-- agent-authored agent_events requiring approval_ref (the proposal/task
-- correlation id, enforced by the app-layer firewall); none require landlord
-- approval. proposal_superseded records a landlord edit to a proposal.
alter table public.interactions drop constraint interactions_entry_type_check;
alter table public.interactions add constraint interactions_entry_type_check
  check (entry_type in (
    'proposal_created', 'proposal_approved', 'proposal_rejected', 'step_executed',
    'proposal_failed', 'proposal_blocked', 'resume_target_dead', 'proposal_superseded'
  ));

-- references_interaction_id: lets an entry reference a prior journal entry /
-- interaction in the same account (e.g. a step_executed agent_event anchoring
-- to the communication it acted on), in addition to the existing
-- maintenance_request_id / work_order_id / vendor_id / tenancy_id / area_id
-- refs. Same composite-FK, same-account, NO-ON-DELETE pattern as corrects_id:
-- MATCH SIMPLE leaves the FK unenforced when the column is null (optional ref),
-- and the absence of an ON DELETE action keeps the immutable journal untouched
-- -- a referenced anchor cannot be hard-deleted out from under its referrer
-- (interactions are soft-deleted, so this never fires in practice). We
-- deliberately do NOT use ON DELETE SET NULL, which would silently rewrite a
-- journal row and emit a spurious audit 'updated' event.
alter table public.interactions
  add column references_interaction_id uuid;
alter table public.interactions
  add constraint interactions_references_interaction_fk
  foreign key (account_id, references_interaction_id)
  references public.interactions (account_id, id);
create index interactions_references_interaction_idx
  on public.interactions (references_interaction_id)
  where references_interaction_id is not null;

-- Rebuild interactions_with_chain so `i.*` picks up the new column (Postgres
-- froze the column list at view-creation time). Definition is otherwise
-- VERBATIM from 20260616000003 (messaging: delivery_status / delivered_at).
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
