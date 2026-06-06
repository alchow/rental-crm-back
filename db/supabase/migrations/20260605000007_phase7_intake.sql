-- ----------------------------------------------------------------------------
-- Phase 7: tenant intake -- the first PUBLIC, UNAUTHENTICATED route.
--
-- The intake link a landlord sends to a tenant lets them submit a maintenance
-- request without an account. The capability lives entirely in a server-
-- minted, randomly-generated secret; the URL the tenant uses is the secret.
-- We store ONLY the sha256 of that secret, so a database read can never
-- recover a live link.
--
-- Tokens are:
--   * reusable per tenancy (a standing "report an issue" link),
--   * create-only (intake never reads data, never authenticates a user),
--   * rate-limited (per-token via this table; per-IP in the handler),
--   * revoked automatically when the tenancy ends (trigger below).
--
-- Blast radius of a leaked token is just spam, which the rate limits cover.
-- The token NEVER reveals account / property / tenancy ids to a recipient
-- -- those come from the verified row, not from the URL.
-- ----------------------------------------------------------------------------

create table public.intake_tokens (
  -- Public-facing token row id. Safe to expose (used as actor='tenant:<id>'
  -- in the audit trail and surfaced in landlord-facing list endpoints).
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  property_id   uuid not null,
  tenancy_id    uuid not null,
  -- sha256 of the secret. The secret itself is shown to the operator ONCE
  -- (at mint time) and never persisted.
  secret_hash   bytea not null check (octet_length(secret_hash) = 32),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Revocation is the only way to invalidate a token (no expiry by default).
  -- The trigger below auto-revokes when the bound tenancy ends.
  revoked_at    timestamptz,
  -- Sliding window state for rate limiting. The handler resets when
  -- (now() - use_window_start) exceeds the configured window; otherwise
  -- it increments use_count and rejects above the cap.
  last_used_at      timestamptz,
  use_count         int not null default 0,
  use_window_start  timestamptz not null default now(),
  foreign key (account_id, property_id) references public.properties(account_id, id) on delete cascade,
  foreign key (account_id, tenancy_id)  references public.tenancies(account_id, id)  on delete cascade,
  unique (account_id, id),
  -- secret_hash must be globally unique so a hash collision is structurally
  -- impossible to land twice. (256-bit collision is fantasy in practice but
  -- the constraint is free.)
  unique (secret_hash)
);

-- At most ONE non-revoked token per tenancy at a time. Re-minting requires
-- revoking the previous one first; the route enforces this explicitly so a
-- duplicate-mint attempt returns 409 instead of bumping into this index at
-- INSERT time.
create unique index intake_tokens_one_active_per_tenancy
  on public.intake_tokens (tenancy_id)
  where revoked_at is null;
create index intake_tokens_account_id_idx on public.intake_tokens (account_id);

alter table public.intake_tokens enable row level security;
alter table public.intake_tokens force  row level security;

-- Members SELECT only -- they see their own account's tokens (minus the
-- secret, since secret is hashed). INSERT / UPDATE / DELETE land via the
-- admin path (the mint and revoke helpers run with service_role).
create policy intake_tokens_member_select on public.intake_tokens
  for select using (public.is_account_member(account_id));

-- ============================================================================
-- Audit: intake_tokens are evidentiary -- mint, revoke, and rate-bump events
-- all want a chain entry. Attach the same _emit_event trigger every other
-- audited domain table uses.
-- ============================================================================
create trigger intake_tokens_audit
  after insert or update or delete on public.intake_tokens
  for each row execute function public._emit_event();

-- ============================================================================
-- Auto-revoke on tenancy end.
--
-- A tenancy moving to status='ended' OR being soft-deleted is exactly the
-- "former tenant" scenario the review called out -- a live intake link in
-- that hand is a real problem. The trigger runs in the same transaction
-- as the tenancy update, so a refresh of the tokens-list is consistent.
-- ============================================================================

create or replace function public._revoke_intake_on_tenancy_end()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' and (
        (NEW.status = 'ended' and OLD.status is distinct from 'ended')
     or (NEW.deleted_at is not null and OLD.deleted_at is null)
  ) then
    update public.intake_tokens
       set revoked_at = now(),
           updated_at = now()
     where tenancy_id = NEW.id
       and revoked_at is null;
  end if;
  return NEW;
end;
$$;

create trigger tenancies_revoke_intake_on_end
  after update on public.tenancies
  for each row execute function public._revoke_intake_on_tenancy_end();

-- ============================================================================
-- submit_intake RPC
--
-- A single atomic transaction that:
--   * sets audit.actor for THIS transaction (so the maintenance_request and
--     interaction rows the audit trigger emits carry actor='tenant:<id>');
--   * looks for an existing OPEN maintenance_request on the same area+title
--     -- if found, append the new submission as an interaction on that
--     request (dedupe), else create a fresh request;
--   * always creates an interaction row tracking the submission, with
--     server-set logged_at (Phase 3.1 trigger keeps it immutable);
--   * returns (maintenance_request_id, interaction_id, deduped).
--
-- Atomicity matters here for the same reason it mattered for payments: the
-- request and the interaction are conceptually one event from the tenant's
-- point of view, and a partial write would either lose the contact log or
-- orphan a request.
--
-- SECURITY DEFINER because the admin client is calling on the unauthenticated
-- path; auth.uid() is NULL throughout, so the audit trigger reads the
-- audit.actor GUC we set here (Phase 4 actor-integrity: when auth.uid() is
-- null, audit.actor wins; when auth.uid() is set, audit.actor is IGNORED --
-- a real user can't impersonate a tenant intake).
-- ============================================================================

create or replace function public.submit_intake(
  p_account_id   uuid,
  p_tenancy_id   uuid,
  p_area_id      uuid,
  p_title        text,
  p_description  text,
  p_severity     text,
  p_occurred_at  timestamptz,
  p_actor        text
)
returns table (
  maintenance_request_id  uuid,
  interaction_id          uuid,
  deduped                 boolean
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_existing_req   uuid;
  v_new_req        uuid;
  v_interaction_id uuid;
  v_deduped        boolean := false;
begin
  -- Anchor the actor for this transaction. audit triggers fire AFTER each
  -- INSERT below and pick this value up via current_setting('audit.actor').
  -- set_config(..., true) = transaction-local, so this can't leak across
  -- requests on a pooled connection.
  perform set_config('audit.actor', p_actor, true);

  -- Dedupe: an OPEN, non-voided request on the same area with the same title.
  select id into v_existing_req
    from public.maintenance_requests
    where account_id = p_account_id
      and area_id    = p_area_id
      and status     = 'open'
      and title      = p_title
      and deleted_at is null
    limit 1;

  if v_existing_req is not null then
    v_new_req := v_existing_req;
    v_deduped := true;
  else
    insert into public.maintenance_requests
      (account_id, area_id, title, description, severity, status, intake_token)
    values
      (p_account_id, p_area_id, p_title, p_description, p_severity, 'open', p_actor)
    returning id into v_new_req;
  end if;

  insert into public.interactions
    (account_id, actor, party_type, channel, direction, body,
     occurred_at, tenancy_id, maintenance_request_id, area_id)
  values
    (p_account_id, p_actor, 'tenant', 'in_app', 'inbound',
     p_description, p_occurred_at, p_tenancy_id, v_new_req, p_area_id)
  returning id into v_interaction_id;

  maintenance_request_id := v_new_req;
  interaction_id         := v_interaction_id;
  deduped                := v_deduped;
  return next;
end;
$$;

-- The admin client is the only caller. Service_role bypasses execute checks
-- but we deliberately do NOT grant authenticated/anon -- the only path that
-- should reach this is through the admin module's verified-token wrapper.
