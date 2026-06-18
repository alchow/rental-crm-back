-- ----------------------------------------------------------------------------
-- account_settings: per-account control flags (MT-3 ask 2 -- authoritative
-- legal_hold for the agent's retention purge).
--
-- The agent purges old chat transcripts on a retention schedule but must honor
-- a litigation `legal_hold`. That hold has to be AUTHORITATIVE IN CORE and
-- survive an agent-DB wipe -- by design the agent does NOT store it (a wiped
-- agent DB would silently lose the hold and start deleting evidence). So the
-- flag lives here, 1:1 with the account, and the agent READS it every purge
-- cycle via GET /v1/accounts/{accountId}/account-flags.
--
-- Why a dedicated table and not a column on accounts: a legal-hold toggle is
-- evidence-grade, so it gets its own audited row (hash-chained via _emit_event)
-- without widening the hot accounts row, and leaves room for future retention
-- controls (retention_days, purge_enabled, ...) as plain new columns. Clients
-- bind to the FIELD (legal_hold), never the row shape.
--
-- Authz:
--   SELECT  any non-deleted member, INCLUDING role='agent' (the agent's read).
--   UPDATE  owner/manager only. Agent + viewer are read-only.
--   INSERT/DELETE  no policy -- rows are auto-provisioned by the trigger below
--                  (and removed only by the account's ON DELETE CASCADE).
-- ----------------------------------------------------------------------------

create table public.account_settings (
  id          uuid primary key default gen_random_uuid(),
  -- UNIQUE makes the 1:1 with accounts a DB invariant and gives the agent's
  -- per-account read a covering index for free.
  account_id  uuid not null unique references public.accounts(id) on delete cascade,
  -- Litigation hold. When true, retention purges must delete NOTHING for this
  -- account. Defaults false: a fresh account has no hold.
  legal_hold  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS: enable but deliberately do NOT `force` -- the table owner must bypass
-- so the SECURITY DEFINER provisioning trigger (and the migration backfill)
-- can INSERT despite there being no INSERT policy. Same precedent as the
-- events table (20260604000002 §1). The `authenticated` role is NOT the owner,
-- so the user-facing path is still fully policy-gated; service_role keeps its
-- BYPASSRLS for admin paths.
alter table public.account_settings enable row level security;

create policy account_settings_member_select on public.account_settings
  for select
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

create policy account_settings_manager_update on public.account_settings
  for update
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null
       and m.role in ('owner', 'manager')))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null
       and m.role in ('owner', 'manager')));

-- AUDIT: a legal_hold toggle is evidence-grade -- attach the hash-chain so
-- every change is tamper-evident, exactly like the domain tables.
create trigger account_settings_audit
  after insert or update or delete on public.account_settings
  for each row execute function public._emit_event();

-- ----------------------------------------------------------------------------
-- Auto-provision the 1:1 row on account creation, PATH-INDEPENDENT: it fires
-- for the signup RPC today and any future admin creation path, so the read
-- endpoint always finds a row (and the legal_hold-off state has an audit
-- baseline). SECURITY DEFINER so the INSERT bypasses account_settings RLS
-- (there is no INSERT policy); ON CONFLICT keeps it idempotent against the
-- backfill and any race.
-- ----------------------------------------------------------------------------
create or replace function public._create_account_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.account_settings (account_id)
  values (NEW.id)
  on conflict (account_id) do nothing;
  return null;
end;
$$;

create trigger accounts_create_settings
  after insert on public.accounts
  for each row execute function public._create_account_settings();

-- Backfill the 1:1 row for every existing account (runs as the migration role,
-- which bypasses RLS). Each insert chains an audit event for that account.
insert into public.account_settings (account_id)
select a.id from public.accounts a
on conflict (account_id) do nothing;
