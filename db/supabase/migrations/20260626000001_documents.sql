-- ----------------------------------------------------------------------------
-- Tenant document vault + short-lived document magic links.
--
-- Documents are tenancy-scoped records with immutable versions. Uploaded
-- versions point at content-hashed attachments; bundled disclosure versions
-- point at a static asset id/path and carry the same hash metadata. Tenant
-- access is via short-lived hashed secrets, independent of intake links.
-- ----------------------------------------------------------------------------

create table public.documents (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null,
  tenancy_id     uuid not null,
  document_type  text not null check (document_type in (
                   'lease', 'move_in', 'move_out', 'lead_paint',
                   'disclosure', 'other'
                 )),
  title          text not null check (length(title) between 1 and 200),
  requires_ack   boolean not null default false,
  published_at   timestamptz,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  foreign key (account_id, tenancy_id) references public.tenancies(account_id, id) on delete cascade,
  unique (account_id, id)
);
create index documents_account_id_idx on public.documents (account_id);
create index documents_tenancy_id_idx on public.documents (tenancy_id);
create index documents_type_idx       on public.documents (document_type);

create table public.document_versions (
  id                 uuid primary key default gen_random_uuid(),
  account_id          uuid not null,
  document_id         uuid not null,
  version_no          int not null check (version_no > 0),
  source              text not null check (source in ('landlord_upload', 'bundled_static')),
  attachment_id        uuid,
  static_template_id   text check (static_template_id is null or length(static_template_id) between 1 and 100),
  static_asset_path    text check (static_asset_path is null or length(static_asset_path) between 1 and 500),
  content_hash         text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  mime_type            text not null default 'application/pdf',
  size_bytes           bigint not null check (size_bytes >= 0),
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  foreign key (account_id, document_id) references public.documents(account_id, id) on delete cascade,
  foreign key (account_id, attachment_id) references public.attachments(account_id, id) on delete restrict,
  unique (account_id, id),
  unique (document_id, version_no),
  check (
    (source = 'landlord_upload'
      and attachment_id is not null
      and static_template_id is null
      and static_asset_path is null)
    or
    (source = 'bundled_static'
      and attachment_id is null
      and static_template_id is not null
      and static_asset_path is not null)
  )
);
create index document_versions_account_id_idx  on public.document_versions (account_id);
create index document_versions_document_id_idx on public.document_versions (document_id);

create table public.document_access_tokens (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  tenancy_id    uuid not null,
  tenant_id     uuid,
  secret_hash   bytea not null check (octet_length(secret_hash) = 32),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (account_id, tenancy_id) references public.tenancies(account_id, id) on delete cascade,
  foreign key (account_id, tenant_id)  references public.tenants(account_id, id) on delete set null,
  unique (account_id, id),
  unique (secret_hash)
);
create index document_access_tokens_account_id_idx on public.document_access_tokens (account_id);
create index document_access_tokens_tenancy_id_idx on public.document_access_tokens (tenancy_id);
create index document_access_tokens_expires_at_idx on public.document_access_tokens (expires_at);

create table public.document_access_events (
  id                   uuid primary key default gen_random_uuid(),
  account_id            uuid not null,
  tenancy_id            uuid not null,
  document_id           uuid not null,
  document_version_id   uuid,
  token_id              uuid not null,
  tenant_id             uuid,
  event_type            text not null check (event_type in ('viewed', 'downloaded', 'acknowledged')),
  ip                    text,
  user_agent            text,
  occurred_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  foreign key (account_id, tenancy_id)          references public.tenancies(account_id, id) on delete cascade,
  foreign key (account_id, document_id)         references public.documents(account_id, id) on delete cascade,
  foreign key (account_id, document_version_id) references public.document_versions(account_id, id) on delete set null,
  foreign key (account_id, token_id)            references public.document_access_tokens(account_id, id) on delete cascade,
  foreign key (account_id, tenant_id)           references public.tenants(account_id, id) on delete set null,
  unique (account_id, id)
);
create index document_access_events_account_id_idx  on public.document_access_events (account_id);
create index document_access_events_document_id_idx on public.document_access_events (document_id);
create index document_access_events_token_id_idx    on public.document_access_events (token_id);
create unique index document_access_events_one_ack_per_token_document
  on public.document_access_events (token_id, document_id)
  where event_type = 'acknowledged' and deleted_at is null;

-- RLS. Landlord document metadata is member-readable/writable; token and event
-- rows are member-readable for audit/support, while public token consumption
-- writes through the API service-role path after hashing/verification.
alter table public.documents enable row level security;
alter table public.documents force  row level security;
create policy documents_member_all on public.documents
  for all using (public.is_account_member(account_id))
  with check (public.is_account_member(account_id));

alter table public.document_versions enable row level security;
alter table public.document_versions force  row level security;
create policy document_versions_member_all on public.document_versions
  for all using (public.is_account_member(account_id))
  with check (public.is_account_member(account_id));

alter table public.document_access_tokens enable row level security;
alter table public.document_access_tokens force  row level security;
create policy document_access_tokens_member_all on public.document_access_tokens
  for all using (public.is_account_member(account_id))
  with check (public.is_account_member(account_id));

alter table public.document_access_events enable row level security;
alter table public.document_access_events force  row level security;
create policy document_access_events_member_select on public.document_access_events
  for select using (public.is_account_member(account_id));

-- Audit all document rows. Access events are intentionally audited too; tenant
-- view/download/ack records are part of the evidentiary surface.
create trigger documents_audit
  after insert or update or delete on public.documents
  for each row execute function public._emit_event();
create trigger document_versions_audit
  after insert or update or delete on public.document_versions
  for each row execute function public._emit_event();
create trigger document_access_tokens_audit
  after insert or update or delete on public.document_access_tokens
  for each row execute function public._emit_event();
create trigger document_access_events_audit
  after insert or update or delete on public.document_access_events
  for each row execute function public._emit_event();
