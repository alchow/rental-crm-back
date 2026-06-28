-- ----------------------------------------------------------------------------
-- Phase 27 (5/6): tenant capture tokens.
--
-- The document_access tokens are READ + acknowledge only. Tenant-filled
-- move-in capture needs a WRITE-scoped magic link bound to ONE inspection.
-- Same hashed-secret design as document_access_tokens (the raw secret is never
-- stored; only its sha256). Token consumption (tenant edits/submit/sign) runs
-- through the API service-role path after hashing + verifying the row; the
-- write scope comes ONLY from the verified token, never from tenant-supplied
-- account/inspection ids.
-- ----------------------------------------------------------------------------

create table public.inspection_capture_tokens (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null,
  inspection_id  uuid not null,
  tenant_id      uuid,
  secret_hash    bytea not null check (octet_length(secret_hash) = 32),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  last_used_at   timestamptz,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  foreign key (account_id, inspection_id) references public.inspections(account_id, id) on delete cascade,
  foreign key (account_id, tenant_id)     references public.tenants(account_id, id)     on delete set null,
  unique (account_id, id),
  unique (secret_hash)
);
create index inspection_capture_tokens_account_id_idx    on public.inspection_capture_tokens (account_id);
create index inspection_capture_tokens_inspection_id_idx on public.inspection_capture_tokens (inspection_id);
create index inspection_capture_tokens_expires_at_idx    on public.inspection_capture_tokens (expires_at);

-- RLS: ADR-0003 form B. Members mint/list/revoke under their JWT; the public
-- tenant write path uses the service-role client after verifying the secret.
alter table public.inspection_capture_tokens enable row level security;
alter table public.inspection_capture_tokens force  row level security;
create policy inspection_capture_tokens_member_all on public.inspection_capture_tokens
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null));

create trigger inspection_capture_tokens_audit
  after insert or update or delete on public.inspection_capture_tokens
  for each row execute function public._emit_event();
