-- Document upload attestation + attachment immutability.
--
-- Storage writes happen through the service-role API, while document rows are
-- created through the caller's JWT/RLS connection. A short-lived receipt is
-- the bridge: only the service role can attest metadata for bytes it stored;
-- the caller can consume only receipts stamped to auth.uid(). This prevents a
-- direct PostgREST RPC caller from inventing hashes or pivoting storage_path to
-- another account.

create table public.document_upload_receipts (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts(id) on delete cascade,
  content_hash  text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  storage_path  text not null check (length(storage_path) between 1 and 1024),
  mime_type     text not null check (mime_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
  )),
  size_bytes    bigint not null check (size_bytes between 1 and 20971520),
  uploaded_by   uuid not null references auth.users(id) on delete cascade,
  derived_from_receipt_id uuid,
  received_at   timestamptz not null default now(),
  -- Null while Storage upload is in flight. Receipt consumers require this
  -- service-authored completion stamp, so a failed upload cannot mint rows
  -- that point at missing bytes.
  stored_at     timestamptz,
  created_at    timestamptz not null default now(),
  unique (account_id, id),
  constraint document_receipts_derivation_fk
    foreign key (account_id, derived_from_receipt_id)
    references public.document_upload_receipts(account_id, id) on delete restrict,
  check (derived_from_receipt_id is null or derived_from_receipt_id <> id),
  -- The service computes a receipt-unique staging path from the exact bytes.
  -- The receipt id prevents an orphan cleanup from racing another upload of
  -- identical content; account/hash/MIME remain independently checkable.
  check (
    storage_path = account_id::text || '/document-uploads/' || id::text || '/' ||
      content_hash || '.' ||
      case mime_type
        when 'application/pdf' then 'pdf'
        when 'image/jpeg' then 'jpg'
        when 'image/png' then 'png'
        when 'image/webp' then 'webp'
        when 'image/heic' then 'heic'
        when 'image/heif' then 'heif'
      end
  )
);

create index document_upload_receipts_created_idx
  on public.document_upload_receipts (created_at, id);

alter table public.document_upload_receipts enable row level security;
alter table public.document_upload_receipts force row level security;

create policy document_upload_receipts_owner_read
  on public.document_upload_receipts
  for select
  to authenticated
  using (
    uploaded_by = (select auth.uid())
    and public.is_account_member(account_id)
  );

revoke all on public.document_upload_receipts from public, anon, authenticated;
grant select on public.document_upload_receipts to authenticated;
grant all on public.document_upload_receipts to service_role;

-- Defense in depth if a future grant accidentally restores direct attachment
-- INSERT. The compatibility PDF function below uses a separate validated
-- internal writer, so authenticated table DML can still be revoked.
create or replace function public._guard_attachment_insert_path()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_extension text;
begin
  -- PostgREST SET ROLE is the privilege boundary here. Unlike auth.role(),
  -- current_user is also well-defined for migrations, fixtures, and direct
  -- operator SQL (where there may be no JWT claims at all).
  if current_user <> 'authenticated' then
    return NEW;
  end if;

  v_extension := case NEW.mime_type
    when 'application/pdf' then 'pdf'
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'image/heic' then 'heic'
    when 'image/heif' then 'heif'
    else null
  end;

  if v_extension is null
     or NEW.content_hash !~ '^[a-f0-9]{64}$'
     or NEW.storage_path <> NEW.account_id::text || '/' || NEW.content_hash || '.' || v_extension then
    raise exception 'attachment path must match account, content hash, and MIME type'
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

revoke all on function public._guard_attachment_insert_path() from public, anon, authenticated;

create trigger attachments_guard_insert_path
  before insert on public.attachments
  for each row execute function public._guard_attachment_insert_path();

create or replace function public._freeze_attachment_provenance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'attachments are soft-deleted; hard delete is forbidden'
      using errcode = 'check_violation';
  end if;

  if NEW.id is distinct from OLD.id
     or NEW.account_id is distinct from OLD.account_id
     or NEW.entity_type is distinct from OLD.entity_type
     or NEW.entity_id is distinct from OLD.entity_id
     or NEW.storage_path is distinct from OLD.storage_path
     or NEW.content_hash is distinct from OLD.content_hash
     or NEW.mime_type is distinct from OLD.mime_type
     or NEW.size_bytes is distinct from OLD.size_bytes
     or NEW.filename is distinct from OLD.filename
     or NEW.uploaded_by is distinct from OLD.uploaded_by
     or NEW.derived_from is distinct from OLD.derived_from
     or NEW.received_at is distinct from OLD.received_at
     or NEW.created_at is distinct from OLD.created_at then
    raise exception 'attachment evidence identity is immutable'
      using errcode = 'check_violation';
  end if;
  -- Only updated_at + deleted_at may advance together through a soft delete.
  return NEW;
end;
$$;

revoke all on function public._freeze_attachment_provenance() from public, anon, authenticated;

create trigger attachments_freeze_provenance
  before update or delete on public.attachments
  for each row execute function public._freeze_attachment_provenance();

create or replace function public._freeze_document_version_provenance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'document versions are soft-deleted; hard delete is forbidden'
      using errcode = 'check_violation';
  end if;

  if NEW.id is distinct from OLD.id
     or NEW.account_id is distinct from OLD.account_id
     or NEW.document_id is distinct from OLD.document_id
     or NEW.version_no is distinct from OLD.version_no
     or NEW.source is distinct from OLD.source
     or NEW.attachment_id is distinct from OLD.attachment_id
     or NEW.static_template_id is distinct from OLD.static_template_id
     or NEW.static_asset_path is distinct from OLD.static_asset_path
     or NEW.content_hash is distinct from OLD.content_hash
     or NEW.mime_type is distinct from OLD.mime_type
     or NEW.size_bytes is distinct from OLD.size_bytes
     or NEW.created_by is distinct from OLD.created_by
     or NEW.created_at is distinct from OLD.created_at then
    raise exception 'document version evidence identity is immutable'
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

revoke all on function public._freeze_document_version_provenance()
  from public, anon, authenticated;

create trigger document_versions_freeze_provenance
  before update or delete on public.document_versions
  for each row execute function public._freeze_document_version_provenance();

-- Non-exposed writer surface. PostgREST exposes public/graphql_public only;
-- the SECURITY INVOKER document RPCs can insert here, while a client cannot
-- address this view directly. Its trigger is the only definer boundary and it
-- derives every evidence field from a service-authored receipt.
create schema if not exists internal;
revoke all on schema internal from public, anon;
grant usage on schema internal to authenticated, service_role;

create view internal.document_attachment_writer as
  select null::uuid as id,
         null::uuid as upload_receipt_id,
         null::uuid as account_id,
         null::uuid as entity_id,
         null::uuid as derived_from
   where false;

create or replace function internal._insert_document_attachment_from_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, internal
as $$
declare
  v_receipt public.document_upload_receipts%rowtype;
  v_attachment public.attachments%rowtype;
begin
  if auth.uid() is null or not public.is_account_member(NEW.account_id) then
    raise exception 'not authorized for document upload receipt'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_receipt
    from public.document_upload_receipts r
   where r.account_id = NEW.account_id
     and r.id = NEW.upload_receipt_id
     and r.uploaded_by = auth.uid()
     and r.stored_at is not null
     and r.created_at > now() - interval '24 hours';
  if v_receipt.id is null then
    raise exception 'upload receipt not found' using errcode = 'no_data_found';
  end if;

  if NEW.derived_from is not null and not exists (
    select 1
      from public.attachments a
     where a.account_id = NEW.account_id
       and a.id = NEW.derived_from
       and a.entity_type = 'document_versions'
       and a.entity_id = NEW.entity_id
       and a.deleted_at is null
  ) then
    raise exception 'derived attachment parent not found' using errcode = 'foreign_key_violation';
  end if;

  insert into public.attachments (
    account_id, entity_type, entity_id, storage_path, content_hash,
    mime_type, size_bytes, uploaded_by, received_at, derived_from
  ) values (
    NEW.account_id, 'document_versions', NEW.entity_id, v_receipt.storage_path,
    v_receipt.content_hash, v_receipt.mime_type, v_receipt.size_bytes,
    v_receipt.uploaded_by, v_receipt.received_at, NEW.derived_from
  ) returning * into v_attachment;

  NEW.id := v_attachment.id;
  return NEW;
end;
$$;

revoke all on function internal._insert_document_attachment_from_receipt()
  from public, anon, authenticated;

create trigger document_attachment_writer_insert
  instead of insert on internal.document_attachment_writer
  for each row execute function internal._insert_document_attachment_from_receipt();

revoke all on internal.document_attachment_writer from public, anon, authenticated;
-- INSERT ... RETURNING id requires SELECT as well as INSERT. The view remains
-- outside PostgREST's exposed schemas and always returns zero rows on SELECT.
grant select, insert on internal.document_attachment_writer to authenticated, service_role;

-- Compatibility writer for the currently deployed PDF-only API. It does not
-- trust caller metadata: the object must already exist in the private Storage
-- bucket at the server's canonical account/hash path with matching MIME/size.
-- Keeping this inside the non-exposed internal schema lets us revoke direct
-- attachment writes without interrupting the schema-first deploy.
create view internal.legacy_document_attachment_writer as
  select null::uuid as id,
         null::uuid as account_id,
         null::uuid as entity_id,
         null::text as storage_path,
         null::text as content_hash,
         null::text as mime_type,
         null::bigint as size_bytes
   where false;

create or replace function internal._insert_legacy_document_attachment()
returns trigger
language plpgsql
security definer
set search_path = public, internal, storage
as $$
declare
  v_attachment public.attachments%rowtype;
begin
  if auth.uid() is null or not public.is_account_member(NEW.account_id) then
    raise exception 'not authorized for legacy document upload'
      using errcode = 'insufficient_privilege';
  end if;
  if NEW.mime_type <> 'application/pdf'
     or NEW.content_hash !~ '^[a-f0-9]{64}$'
     or NEW.size_bytes not between 1 and 20971520
     or NEW.storage_path <> NEW.account_id::text || '/' || NEW.content_hash || '.pdf' then
    raise exception 'legacy document metadata is not canonical'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1
      from storage.objects o
     where o.bucket_id = 'attachments'
       and o.name = NEW.storage_path
       and o.metadata @> jsonb_build_object(
         'mimetype', NEW.mime_type,
         'size', NEW.size_bytes
       )
  ) then
    raise exception 'stored document bytes do not match the claimed metadata'
      using errcode = 'no_data_found';
  end if;

  insert into public.attachments (
    account_id, entity_type, entity_id, storage_path, content_hash,
    mime_type, size_bytes, uploaded_by
  ) values (
    NEW.account_id, 'document_versions', NEW.entity_id, NEW.storage_path,
    NEW.content_hash, NEW.mime_type, NEW.size_bytes, auth.uid()
  ) returning * into v_attachment;

  NEW.id := v_attachment.id;
  return NEW;
end;
$$;

revoke all on function internal._insert_legacy_document_attachment()
  from public, anon, authenticated;

create trigger legacy_document_attachment_writer_insert
  instead of insert on internal.legacy_document_attachment_writer
  for each row execute function internal._insert_legacy_document_attachment();

revoke all on internal.legacy_document_attachment_writer from public, anon, authenticated;
grant select, insert on internal.legacy_document_attachment_writer to authenticated, service_role;

-- Version rows are evidence manifests. Authenticated callers cannot write the
-- table directly; this non-exposed writer checks the manifest against either
-- an immutable attachment or the one bundled template shipped by this build.
create view internal.document_version_writer as
  select v.* from public.document_versions v where false;

create or replace function internal._insert_document_version()
returns trigger
language plpgsql
security definer
set search_path = public, internal
as $$
declare
  v_document public.documents%rowtype;
  v_attachment public.attachments%rowtype;
  v_version public.document_versions%rowtype;
begin
  if auth.uid() is null or not public.is_account_member(NEW.account_id) then
    raise exception 'not authorized to create document version'
      using errcode = 'insufficient_privilege';
  end if;
  NEW.id := coalesce(NEW.id, gen_random_uuid());

  select * into v_document
    from public.documents d
   where d.account_id = NEW.account_id
     and d.id = NEW.document_id
     and d.deleted_at is null;
  if v_document.id is null then
    raise exception 'document not found' using errcode = 'no_data_found';
  end if;

  if NEW.source in ('landlord_upload', 'inspection_report') then
    if NEW.attachment_id is null
       or NEW.static_template_id is not null
       or NEW.static_asset_path is not null then
      raise exception 'attachment-backed version metadata is invalid'
        using errcode = 'check_violation';
    end if;
    select * into v_attachment
      from public.attachments a
     where a.account_id = NEW.account_id
       and a.id = NEW.attachment_id
       and a.deleted_at is null;
    if v_attachment.id is null
       or v_attachment.content_hash is distinct from NEW.content_hash
       or v_attachment.mime_type is distinct from NEW.mime_type
       or v_attachment.size_bytes is distinct from NEW.size_bytes then
      raise exception 'document version does not match its attachment'
        using errcode = 'check_violation';
    end if;
    if NEW.source = 'landlord_upload' and not (
      v_attachment.entity_type = 'document_versions'
      and v_attachment.entity_id = NEW.id
    ) then
      raise exception 'upload attachment is not bound to this version'
        using errcode = 'check_violation';
    end if;
    if NEW.source = 'inspection_report' and not (
      v_document.inspection_id is not null
      and v_attachment.entity_type = 'inspection_report'
      and v_attachment.entity_id = v_document.inspection_id
      and NEW.mime_type = 'application/pdf'
    ) then
      raise exception 'inspection report attachment is not bound to this document'
        using errcode = 'check_violation';
    end if;
  elsif NEW.source = 'bundled_static' then
    -- Complete immutable tuple for api/src/static/document-templates/
    -- epa-lead-in-your-home-2020.pdf. A path alone is never trusted.
    if NEW.attachment_id is not null
       or NEW.static_template_id is distinct from 'epa_lead_pamphlet_2020'
       or NEW.static_asset_path is distinct from 'document-templates/epa-lead-in-your-home-2020.pdf'
       or NEW.content_hash is distinct from 'ab606a293bbbb2c4a4abe95f3471bf9d325c2c7a7fd5f336aef120ffe4c6567c'
       or NEW.mime_type is distinct from 'application/pdf'
       or NEW.size_bytes is distinct from 1292178
       or v_document.document_type <> 'lead_paint' then
      raise exception 'bundled document does not match a shipped template'
        using errcode = 'check_violation';
    end if;
  else
    raise exception 'unsupported document source' using errcode = '22023';
  end if;

  insert into public.document_versions (
    id, account_id, document_id, version_no, source, attachment_id,
    static_template_id, static_asset_path, content_hash, mime_type,
    size_bytes, created_by
  ) values (
    NEW.id, NEW.account_id, NEW.document_id, NEW.version_no, NEW.source,
    NEW.attachment_id, NEW.static_template_id, NEW.static_asset_path,
    NEW.content_hash, NEW.mime_type, NEW.size_bytes, auth.uid()
  ) returning * into v_version;

  NEW := v_version;
  return NEW;
end;
$$;

revoke all on function internal._insert_document_version()
  from public, anon, authenticated;

create trigger document_version_writer_insert
  instead of insert on internal.document_version_writer
  for each row execute function internal._insert_document_version();

revoke all on internal.document_version_writer from public, anon, authenticated;
grant select, insert on internal.document_version_writer to authenticated, service_role;

-- Preserve the deployed 12-argument PDF API while routing its attachment row
-- through the validated internal writer above. Static bundled documents keep
-- their existing path. The function stays SECURITY INVOKER so tenancy,
-- document, and version writes remain under caller RLS.
create or replace function public.create_tenancy_document(
  p_account_id          uuid,
  p_tenancy_id          uuid,
  p_document_type       text,
  p_title               text,
  p_requires_ack        boolean,
  p_source              text,
  p_content_hash        text,
  p_mime_type           text,
  p_size_bytes          bigint,
  p_attachment_path     text default null,
  p_static_template_id  text default null,
  p_static_asset_path   text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_version_id     uuid := gen_random_uuid();
  v_attachment_id  uuid;
  v_doc            public.documents;
  v_ver            public.document_versions;
  v_existing_id    uuid;
begin
  if not exists (
    select 1 from public.tenancies
     where account_id = p_account_id
       and id = p_tenancy_id
       and deleted_at is null
  ) then
    raise exception 'tenancy_not_found' using errcode = 'P0002';
  end if;

  select d.id into v_existing_id
    from public.documents d
    join public.document_versions v
      on v.account_id = d.account_id and v.document_id = d.id
   where d.account_id = p_account_id
     and d.tenancy_id = p_tenancy_id
     and d.document_type = p_document_type
     and d.deleted_at is null and v.deleted_at is null
     and v.content_hash = p_content_hash
   order by d.created_at asc
   limit 1;
  if v_existing_id is not null then
    select * into v_doc from public.documents
     where account_id = p_account_id and id = v_existing_id;
    select * into v_ver from public.document_versions
     where account_id = p_account_id
       and document_id = v_existing_id
       and deleted_at is null
     order by version_no desc limit 1;
    return jsonb_build_object(
      'document', to_jsonb(v_doc), 'version', to_jsonb(v_ver), 'deduped', true
    );
  end if;

  if p_source = 'landlord_upload' then
    insert into internal.legacy_document_attachment_writer (
      account_id, entity_id, storage_path, content_hash, mime_type, size_bytes
    ) values (
      p_account_id, v_version_id, p_attachment_path,
      p_content_hash, p_mime_type, p_size_bytes
    ) returning id into v_attachment_id;
  elsif p_source = 'bundled_static' then
    if p_attachment_path is not null
       or p_document_type is distinct from 'lead_paint'
       or p_static_template_id is distinct from 'epa_lead_pamphlet_2020'
       or p_static_asset_path is distinct from 'document-templates/epa-lead-in-your-home-2020.pdf'
       or p_content_hash is distinct from 'ab606a293bbbb2c4a4abe95f3471bf9d325c2c7a7fd5f336aef120ffe4c6567c'
       or p_mime_type is distinct from 'application/pdf'
       or p_size_bytes is distinct from 1292178 then
      raise exception 'static document does not match a shipped template'
        using errcode = '22023';
    end if;
  else
    raise exception 'unsupported document source' using errcode = '22023';
  end if;

  insert into public.documents (
    account_id, tenancy_id, document_type, title, requires_ack, published_at, created_by
  ) values (
    p_account_id, p_tenancy_id, p_document_type, p_title,
    coalesce(p_requires_ack, false), now(), auth.uid()
  ) returning * into v_doc;

  insert into internal.document_version_writer (
    id, account_id, document_id, version_no, source, attachment_id,
    static_template_id, static_asset_path, content_hash, mime_type,
    size_bytes, created_by
  ) values (
    v_version_id, p_account_id, v_doc.id, 1, p_source, v_attachment_id,
    p_static_template_id, p_static_asset_path, p_content_hash, p_mime_type,
    p_size_bytes, auth.uid()
  ) returning * into v_ver;

  return jsonb_build_object(
    'document', to_jsonb(v_doc), 'version', to_jsonb(v_ver), 'deduped', false
  );
end;
$$;

revoke all on function public.create_tenancy_document(
  uuid, uuid, text, text, boolean, text, text, text, bigint, text, text, text
) from public, anon;
grant execute on function public.create_tenancy_document(
  uuid, uuid, text, text, boolean, text, text, text, bigint, text, text, text
) to authenticated;

-- All normal attachment writes now cross a server-controlled admin module,
-- a locked SECURITY DEFINER intake RPC, or one of the validated internal
-- document writers. RLS remains the read boundary.
revoke insert, update, delete on public.attachments from authenticated;
revoke insert, update, delete on public.document_versions from authenticated;

revoke all on function public.create_tenancy_document_from_image(
  uuid, uuid, text, text, boolean, text, text, bigint, text, text, bigint, text
) from public, anon, authenticated;
drop function public.create_tenancy_document_from_image(
  uuid, uuid, text, text, boolean, text, text, bigint, text, text, bigint, text
);

create or replace function public.create_tenancy_document_from_upload(
  p_account_id       uuid,
  p_tenancy_id       uuid,
  p_document_type    text,
  p_title            text,
  p_requires_ack     boolean,
  p_upload_receipt_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_receipt       public.document_upload_receipts%rowtype;
  v_version_id    uuid := gen_random_uuid();
  v_attachment_id uuid;
  v_doc           public.documents;
  v_ver           public.document_versions;
  v_existing_id   uuid;
begin
  select * into v_receipt
    from public.document_upload_receipts r
   where r.account_id = p_account_id
     and r.id = p_upload_receipt_id
     and r.uploaded_by = auth.uid()
     and r.stored_at is not null
     and r.created_at > now() - interval '24 hours';
  if v_receipt.id is null then
    raise exception 'upload_receipt_not_found' using errcode = 'P0002';
  end if;
  if v_receipt.mime_type <> 'application/pdf' then
    raise exception 'PDF upload receipt required' using errcode = '22023';
  end if;
  if v_receipt.derived_from_receipt_id is not null then
    raise exception 'standalone PDF receipt required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.tenancies
     where account_id = p_account_id and id = p_tenancy_id and deleted_at is null
  ) then
    raise exception 'tenancy_not_found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'document-upload:' || p_account_id::text || ':' || p_tenancy_id::text || ':' ||
    p_document_type || ':' || v_receipt.content_hash, 0
  ));

  select d.id into v_existing_id
    from public.documents d
    join public.document_versions v
      on v.account_id = d.account_id and v.document_id = d.id
   where d.account_id = p_account_id and d.tenancy_id = p_tenancy_id
     and d.document_type = p_document_type
     and d.deleted_at is null and v.deleted_at is null
     and v.content_hash = v_receipt.content_hash
   order by d.created_at asc limit 1;
  if v_existing_id is not null then
    select * into v_doc from public.documents
     where account_id = p_account_id and id = v_existing_id;
    select * into v_ver from public.document_versions
     where account_id = p_account_id and document_id = v_existing_id and deleted_at is null
     order by version_no desc limit 1;
    return jsonb_build_object(
      'document', to_jsonb(v_doc), 'version', to_jsonb(v_ver), 'deduped', true
    );
  end if;

  insert into internal.document_attachment_writer (
    upload_receipt_id, account_id, entity_id, derived_from
  ) values (p_upload_receipt_id, p_account_id, v_version_id, null)
  returning id into v_attachment_id;

  insert into public.documents (
    account_id, tenancy_id, document_type, title, requires_ack, published_at, created_by
  ) values (
    p_account_id, p_tenancy_id, p_document_type, p_title,
    coalesce(p_requires_ack, false), now(), auth.uid()
  ) returning * into v_doc;

  insert into internal.document_version_writer (
    id, account_id, document_id, version_no, source, attachment_id,
    content_hash, mime_type, size_bytes, created_by
  ) values (
    v_version_id, p_account_id, v_doc.id, 1, 'landlord_upload', v_attachment_id,
    v_receipt.content_hash, v_receipt.mime_type, v_receipt.size_bytes, auth.uid()
  ) returning * into v_ver;

  return jsonb_build_object(
    'document', to_jsonb(v_doc), 'version', to_jsonb(v_ver), 'deduped', false
  );
end;
$$;

revoke all on function public.create_tenancy_document_from_upload(
  uuid, uuid, text, text, boolean, uuid
) from public, anon;
grant execute on function public.create_tenancy_document_from_upload(
  uuid, uuid, text, text, boolean, uuid
) to authenticated;

create or replace function public.create_tenancy_document_from_image(
  p_account_id          uuid,
  p_tenancy_id          uuid,
  p_document_type       text,
  p_title               text,
  p_requires_ack        boolean,
  p_original_receipt_id uuid,
  p_pdf_receipt_id      uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_original      public.document_upload_receipts%rowtype;
  v_pdf           public.document_upload_receipts%rowtype;
  v_version_id    uuid := gen_random_uuid();
  v_original_id   uuid;
  v_pdf_id        uuid;
  v_doc           public.documents;
  v_ver           public.document_versions;
  v_existing_id   uuid;
begin
  select * into v_original
    from public.document_upload_receipts r
   where r.account_id = p_account_id and r.id = p_original_receipt_id
     and r.uploaded_by = auth.uid()
     and r.stored_at is not null
     and r.created_at > now() - interval '24 hours';
  select * into v_pdf
    from public.document_upload_receipts r
   where r.account_id = p_account_id and r.id = p_pdf_receipt_id
     and r.uploaded_by = auth.uid()
     and r.stored_at is not null
     and r.created_at > now() - interval '24 hours';
  if v_original.id is null or v_pdf.id is null then
    raise exception 'upload_receipt_not_found' using errcode = 'P0002';
  end if;
  if v_original.mime_type not in (
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
  ) or v_pdf.mime_type <> 'application/pdf' then
    raise exception 'image original and PDF receipts required' using errcode = '22023';
  end if;
  if v_original.id = v_pdf.id then
    raise exception 'original and PDF receipts must differ' using errcode = '22023';
  end if;
  if v_original.derived_from_receipt_id is not null
     or v_pdf.derived_from_receipt_id is distinct from v_original.id then
    raise exception 'PDF receipt is not attested as derived from this original'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.tenancies
     where account_id = p_account_id and id = p_tenancy_id and deleted_at is null
  ) then
    raise exception 'tenancy_not_found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'document-image:' || p_account_id::text || ':' || p_tenancy_id::text || ':' ||
    p_document_type || ':' || v_original.content_hash, 0
  ));

  select d.id into v_existing_id
    from public.documents d
    join public.document_versions v
      on v.account_id = d.account_id and v.document_id = d.id
    join public.attachments pdf
      on pdf.account_id = v.account_id and pdf.id = v.attachment_id
    join public.attachments original
      on original.account_id = pdf.account_id and original.id = pdf.derived_from
   where d.account_id = p_account_id and d.tenancy_id = p_tenancy_id
     and d.document_type = p_document_type
     and d.deleted_at is null and v.deleted_at is null
     and pdf.deleted_at is null and original.deleted_at is null
     and original.content_hash = v_original.content_hash
   order by d.created_at asc limit 1;
  if v_existing_id is not null then
    select * into v_doc from public.documents
     where account_id = p_account_id and id = v_existing_id;
    select * into v_ver from public.document_versions
     where account_id = p_account_id and document_id = v_existing_id and deleted_at is null
     order by version_no desc limit 1;
    return jsonb_build_object(
      'document', to_jsonb(v_doc), 'version', to_jsonb(v_ver), 'deduped', true
    );
  end if;

  insert into internal.document_attachment_writer (
    upload_receipt_id, account_id, entity_id, derived_from
  ) values (p_original_receipt_id, p_account_id, v_version_id, null)
  returning id into v_original_id;

  insert into internal.document_attachment_writer (
    upload_receipt_id, account_id, entity_id, derived_from
  ) values (p_pdf_receipt_id, p_account_id, v_version_id, v_original_id)
  returning id into v_pdf_id;

  insert into public.documents (
    account_id, tenancy_id, document_type, title, requires_ack, published_at, created_by
  ) values (
    p_account_id, p_tenancy_id, p_document_type, p_title,
    coalesce(p_requires_ack, false), now(), auth.uid()
  ) returning * into v_doc;

  insert into internal.document_version_writer (
    id, account_id, document_id, version_no, source, attachment_id,
    content_hash, mime_type, size_bytes, created_by
  ) values (
    v_version_id, p_account_id, v_doc.id, 1, 'landlord_upload', v_pdf_id,
    v_pdf.content_hash, v_pdf.mime_type, v_pdf.size_bytes, auth.uid()
  ) returning * into v_ver;

  return jsonb_build_object(
    'document', to_jsonb(v_doc), 'version', to_jsonb(v_ver), 'deduped', false
  );
end;
$$;

revoke all on function public.create_tenancy_document_from_image(
  uuid, uuid, text, text, boolean, uuid, uuid
) from public, anon;
grant execute on function public.create_tenancy_document_from_image(
  uuid, uuid, text, text, boolean, uuid, uuid
) to authenticated;

-- The existing condition-report emitter also creates document versions. Route
-- it through the same checked writer before removing direct INSERT privileges.
create or replace function public.emit_inspection_report_document(
  p_account_id    uuid,
  p_inspection_id uuid,
  p_attachment_id uuid,
  p_content_hash  text,
  p_size_bytes    bigint,
  p_title         text,
  p_requires_ack  boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kind          text;
  v_tenancy       uuid;
  v_completed     timestamptz;
  v_doc           public.documents;
  v_ver           public.document_versions;
  v_existing_doc  uuid;
  v_next_ver      int;
begin
  select kind, tenancy_id, completed_at into v_kind, v_tenancy, v_completed
    from public.inspections
   where account_id = p_account_id
     and id = p_inspection_id
     and deleted_at is null;
  if not found then
    raise exception 'inspection_not_found' using errcode = 'P0002';
  end if;
  if v_completed is null then
    raise exception 'inspection_not_completed' using errcode = 'P0002';
  end if;
  if v_kind not in ('move_in', 'move_out') then
    raise exception 'kind % does not emit a tenant document', v_kind
      using errcode = 'check_violation';
  end if;
  if v_tenancy is null then
    raise exception 'inspection has no tenancy' using errcode = 'check_violation';
  end if;

  select id into v_existing_doc
    from public.documents
   where account_id = p_account_id
     and inspection_id = p_inspection_id
     and deleted_at is null;

  if v_existing_doc is not null then
    select * into v_ver
      from public.document_versions
     where account_id = p_account_id
       and document_id = v_existing_doc
       and content_hash = p_content_hash
       and deleted_at is null
     order by version_no desc limit 1;
    if found then
      select * into v_doc from public.documents where id = v_existing_doc;
      return jsonb_build_object('document', to_jsonb(v_doc), 'version', to_jsonb(v_ver));
    end if;

    select coalesce(max(version_no), 0) + 1 into v_next_ver
      from public.document_versions
     where account_id = p_account_id and document_id = v_existing_doc;
    insert into internal.document_version_writer (
      account_id, document_id, version_no, source, attachment_id,
      content_hash, mime_type, size_bytes
    ) values (
      p_account_id, v_existing_doc, v_next_ver, 'inspection_report',
      p_attachment_id, p_content_hash, 'application/pdf', p_size_bytes
    ) returning * into v_ver;
    select * into v_doc from public.documents where id = v_existing_doc;
    return jsonb_build_object('document', to_jsonb(v_doc), 'version', to_jsonb(v_ver));
  end if;

  insert into public.documents (
    account_id, tenancy_id, document_type, title, requires_ack,
    published_at, created_by, inspection_id
  ) values (
    p_account_id, v_tenancy, v_kind, p_title, coalesce(p_requires_ack, true),
    now(), auth.uid(), p_inspection_id
  ) returning * into v_doc;

  insert into internal.document_version_writer (
    account_id, document_id, version_no, source, attachment_id,
    content_hash, mime_type, size_bytes
  ) values (
    p_account_id, v_doc.id, 1, 'inspection_report', p_attachment_id,
    p_content_hash, 'application/pdf', p_size_bytes
  ) returning * into v_ver;

  return jsonb_build_object('document', to_jsonb(v_doc), 'version', to_jsonb(v_ver));
end;
$$;

revoke all on function public.emit_inspection_report_document(
  uuid, uuid, uuid, text, bigint, text, boolean
) from public, anon;
grant execute on function public.emit_inspection_report_document(
  uuid, uuid, uuid, text, bigint, text, boolean
) to authenticated;

notify pgrst, 'reload schema';
