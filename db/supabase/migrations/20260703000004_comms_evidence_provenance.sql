-- ----------------------------------------------------------------------------
-- Comms ledger — evidence hardening, part 2: signed-webhook provenance +
-- legal holds (work item EV-B).
--
-- The journal's inbound rows rest on the transport honestly restating what
-- the provider delivered; the carrier-signed original is verified at the
-- transport's edge and then discarded, and the parameter echo (inbound_raw)
-- is pruned after its dedupe horizon with no litigation-hold gate. This
-- migration adds:
--
--   inbound_provenance      one row per archived inbound webhook: the
--                           provider signature material + the sha256 of the
--                           verbatim body, plus the storage path of the blob
--                           (bucket 'comm-evidence', written by the API's
--                           service tier). The row is audit-attached, so the
--                           body hash lands inside the per-account event hash
--                           chain — blob and ledger vouch for each other:
--                           alter the blob and it stops matching the chained
--                           hash; alter the row and the chain breaks. Rows
--                           are write-once (purged_at is the single
--                           exception: null -> timestamp exactly once, when
--                           the retention janitor removes the BLOB — the
--                           anchor row itself is never deleted, so the
--                           provider_msg_id subpoena handle survives).
--   record_inbound_provenance(...)
--                           transport-only DEFINER write path (same
--                           self-defense as capture_inbound). Idempotent by
--                           provider_msg_id; a replay with a DIFFERENT body
--                           hash is refused (P0003) — the first archived
--                           claim wins and the conflict is loud, never a
--                           silent overwrite. The API uploads the blob only
--                           after this row exists and the hashes agree.
--   account_legal_holds     one row per account; while active, EVERY
--                           destruction path skips the account (FRCP 37(e):
--                           routine destruction stops when litigation is
--                           reasonably anticipated). Owner/manager writes
--                           only — the agent principal must not be able to
--                           release a hold and re-enable purging. Audited.
--   prune_inbound_raw       re-created with the hold gate.
--   bucket 'comm-evidence'  private; NO authenticated policies at all —
--                           blob reads and writes are API-mediated
--                           (service-role client), mirroring 'attachments'
--                           minus even the member-read policy.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) inbound_provenance
-- ============================================================================

create table public.inbound_provenance (
  id                  uuid        primary key default gen_random_uuid(),
  account_id          uuid        not null references public.accounts(id) on delete restrict,
  provider            text        not null check (length(provider) between 1 and 100),
  provider_msg_id     text        not null unique,
  -- sha256 of the verbatim webhook body bytes, lowercase hex.
  body_sha256         text        not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  -- Provider signature material as received (e.g. Telnyx: the
  -- telnyx-signature-ed25519 and telnyx-timestamp header values). Nullable:
  -- a provider without webhook signing still gets body-hash anchoring.
  signature           text        check (length(signature) between 1 and 2000),
  signature_timestamp text        check (length(signature_timestamp) between 1 and 100),
  storage_path        text        not null check (length(storage_path) between 1 and 1024),
  received_at         timestamptz not null,
  purged_at           timestamptz,
  created_at          timestamptz not null default now(),
  unique (account_id, id)
);

create index inbound_provenance_retention_idx
  on public.inbound_provenance (received_at)
  where purged_at is null;

-- Write-once: every column is provenance identity except purged_at, which
-- may transition null -> timestamp exactly once (the blob-destruction stamp;
-- the audit trigger records the update, so destruction is an audited event —
-- unlike the deliberately silent inbound_raw prune).
create or replace function public._inbound_provenance_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.account_id          is distinct from old.account_id
     or new.provider            is distinct from old.provider
     or new.provider_msg_id     is distinct from old.provider_msg_id
     or new.body_sha256         is distinct from old.body_sha256
     or new.signature           is distinct from old.signature
     or new.signature_timestamp is distinct from old.signature_timestamp
     or new.storage_path        is distinct from old.storage_path
     or new.received_at         is distinct from old.received_at
     or new.created_at          is distinct from old.created_at then
    raise exception 'inbound_provenance rows are write-once (only purged_at may be set)'
      using errcode = 'check_violation';
  end if;
  if new.purged_at is distinct from old.purged_at
     and (old.purged_at is not null or new.purged_at is null) then
    raise exception 'inbound_provenance.purged_at may only transition null -> timestamp'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger inbound_provenance_guard_update
  before update on public.inbound_provenance
  for each row execute function public._inbound_provenance_guard_update();

alter table public.inbound_provenance enable row level security;
alter table public.inbound_provenance force  row level security;

-- Members read their account's anchors (dispute/export tooling); ALL writes
-- go through the DEFINER RPC below (insert) or the API service tier
-- (purged_at stamp) — no authenticated write policy exists.
create policy inbound_provenance_member_select on public.inbound_provenance
  for select
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

revoke insert, update, delete, truncate on public.inbound_provenance
  from public, anon, authenticated;

create trigger inbound_provenance_audit
  after insert or update or delete on public.inbound_provenance
  for each row execute function public._emit_event();

-- Transport-only write path (agent-role member of the account, exactly the
-- capture_inbound self-defense). Idempotent by provider_msg_id, account-
-- pinned, first-hash-wins.
create or replace function public.record_inbound_provenance(
  p_account_id          uuid,
  p_provider            text,
  p_provider_msg_id     text,
  p_body_sha256         text,
  p_signature           text,
  p_signature_timestamp text,
  p_storage_path        text,
  p_received_at         timestamptz
)
returns public.inbound_provenance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inbound_provenance%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = p_account_id
       and m.role = 'agent'
       and m.deleted_at is null
  ) then
    raise exception 'not authorized to record inbound provenance for this account'
      using errcode = '42501';
  end if;

  insert into public.inbound_provenance (
    account_id, provider, provider_msg_id, body_sha256,
    signature, signature_timestamp, storage_path, received_at
  ) values (
    p_account_id, p_provider, p_provider_msg_id, lower(p_body_sha256),
    p_signature, p_signature_timestamp, p_storage_path, p_received_at
  )
  on conflict (provider_msg_id) do nothing
  returning * into v_row;

  if found then
    return v_row;
  end if;

  -- Replay. Answer from the committed row, pinned to the calling account —
  -- and refuse LOUDLY if the body hash disagrees: the first archived claim
  -- is the evidence; a differing retry must never silently win.
  select * into v_row
    from public.inbound_provenance
   where provider_msg_id = p_provider_msg_id;
  if v_row.account_id is distinct from p_account_id then
    raise exception 'provider_msg_id already archived for another account'
      using errcode = 'P0003';
  end if;
  if v_row.body_sha256 is distinct from lower(p_body_sha256) then
    raise exception 'provider_msg_id already archived with a different body hash'
      using errcode = 'P0003';
  end if;
  return v_row;
end;
$$;

revoke execute on function public.record_inbound_provenance(uuid, text, text, text, text, text, text, timestamptz) from public;
revoke execute on function public.record_inbound_provenance(uuid, text, text, text, text, text, text, timestamptz) from anon;
grant  execute on function public.record_inbound_provenance(uuid, text, text, text, text, text, text, timestamptz) to authenticated, service_role;

-- ============================================================================
-- (B) account_legal_holds
-- ============================================================================

create table public.account_legal_holds (
  id          uuid        primary key default gen_random_uuid(),
  account_id  uuid        not null unique references public.accounts(id) on delete restrict,
  active      boolean     not null default true,
  reason      text        check (length(reason) between 1 and 2000),
  set_by      uuid,
  set_at      timestamptz not null default now(),
  released_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (account_id, id)
);

alter table public.account_legal_holds enable row level security;
alter table public.account_legal_holds force  row level security;

-- Any member may SEE the hold state; only owner/manager humans may change
-- it. The agent principal is deliberately excluded: a transport that can
-- release a hold can re-enable destruction — the exact capacity the
-- evidence-honesty model denies it.
create policy account_legal_holds_member_select on public.account_legal_holds
  for select
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

create policy account_legal_holds_manager_write on public.account_legal_holds
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid())
       and m.role in ('owner', 'manager')
       and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid())
       and m.role in ('owner', 'manager')
       and m.deleted_at is null));

create trigger account_legal_holds_audit
  after insert or update or delete on public.account_legal_holds
  for each row execute function public._emit_event();

-- ============================================================================
-- (C) bucket 'comm-evidence' (software-WORM: service tier only)
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    -- Private evidence bucket. No-op if it already exists. Unlike
    -- 'attachments', there is NO member-read storage policy: every read and
    -- write is API-mediated via the service-role client, so authenticated
    -- can neither list, read, overwrite nor delete evidence blobs.
    execute
      $sql$ insert into storage.buckets (id, name, public)
            values ('comm-evidence', 'comm-evidence', false)
            on conflict (id) do nothing $sql$;
  end if;
end $$;

-- ============================================================================
-- (D) prune_inbound_raw: hold-gated
-- ============================================================================
-- Same contract as 20260701000005; rows whose matched account holds an
-- active legal hold are skipped (rows are account-stamped at birth, so
-- orphans are covered too; a row with no matched account belongs to no
-- account and cannot be held).

create or replace function public.prune_inbound_raw(
  p_older_than interval default interval '90 days'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pruned integer;
begin
  delete from public.inbound_raw r
   where r.received_at < now() - p_older_than
     and not exists (
       select 1 from public.account_legal_holds h
        where h.account_id = r.matched_account_id
          and h.active
     );
  get diagnostics v_pruned = row_count;
  return v_pruned;
end;
$$;

revoke execute on function public.prune_inbound_raw(interval) from public;
revoke execute on function public.prune_inbound_raw(interval) from anon;
revoke execute on function public.prune_inbound_raw(interval) from authenticated;
grant  execute on function public.prune_inbound_raw(interval) to service_role;
