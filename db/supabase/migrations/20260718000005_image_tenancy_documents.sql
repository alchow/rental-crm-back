-- Image document ingestion keeps two attachment rows:
--
--   original phone image (immutable hash + received_at)
--        -> derived PDF (derived_from = original id)
--        -> document_version.attachment_id
--
-- The version/download stays PDF-compatible while the bytes the landlord
-- actually supplied remain independently hash-verifiable evidence.

create or replace function public.create_tenancy_document_from_image(
  p_account_id          uuid,
  p_tenancy_id          uuid,
  p_document_type       text,
  p_title               text,
  p_requires_ack        boolean,
  p_original_hash       text,
  p_original_mime_type  text,
  p_original_size_bytes bigint,
  p_original_path       text,
  p_pdf_hash            text,
  p_pdf_size_bytes      bigint,
  p_pdf_path            text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenancy       uuid;
  v_version_id    uuid := gen_random_uuid();
  v_original_id   uuid;
  v_pdf_id        uuid;
  v_doc           public.documents;
  v_ver           public.document_versions;
  v_existing_id   uuid;
begin
  select id into v_tenancy
    from public.tenancies
   where account_id = p_account_id
     and id = p_tenancy_id
     and deleted_at is null;
  if v_tenancy is null then
    raise exception 'tenancy_not_found' using errcode = 'P0002';
  end if;

  if p_original_mime_type not in (
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'
  ) then
    raise exception 'invalid image mime type' using errcode = '22023';
  end if;

  -- Eliminate concurrent duplicate image filings for the same tenancy/type.
  perform pg_advisory_xact_lock(hashtextextended(
    'document-image:' || p_account_id::text || ':' || p_tenancy_id::text || ':' ||
    p_document_type || ':' || p_original_hash,
    0
  ));

  -- Dedupe by the ORIGINAL bytes, not the generated PDF rendition. A renderer
  -- upgrade may legitimately change the PDF hash without changing what the
  -- landlord uploaded.
  select d.id into v_existing_id
    from public.documents d
    join public.document_versions v
      on v.account_id = d.account_id and v.document_id = d.id
    join public.attachments pdf
      on pdf.account_id = v.account_id and pdf.id = v.attachment_id
    join public.attachments original
      on original.account_id = pdf.account_id and original.id = pdf.derived_from
   where d.account_id = p_account_id
     and d.tenancy_id = p_tenancy_id
     and d.document_type = p_document_type
     and d.deleted_at is null
     and v.deleted_at is null
     and pdf.deleted_at is null
     and original.deleted_at is null
     and original.content_hash = p_original_hash
   order by d.created_at asc
   limit 1;

  if v_existing_id is not null then
    select * into v_doc
      from public.documents
     where account_id = p_account_id and id = v_existing_id;
    select * into v_ver
      from public.document_versions
     where account_id = p_account_id
       and document_id = v_existing_id
       and deleted_at is null
     order by version_no desc
     limit 1;
    return jsonb_build_object(
      'document', to_jsonb(v_doc),
      'version', to_jsonb(v_ver),
      'deduped', true
    );
  end if;

  insert into public.attachments (
    account_id, entity_type, entity_id, storage_path, content_hash,
    mime_type, size_bytes, uploaded_by
  ) values (
    p_account_id, 'document_versions', v_version_id, p_original_path,
    p_original_hash, p_original_mime_type, p_original_size_bytes, auth.uid()
  )
  returning id into v_original_id;

  insert into public.attachments (
    account_id, entity_type, entity_id, storage_path, content_hash,
    mime_type, size_bytes, uploaded_by, derived_from
  ) values (
    p_account_id, 'document_versions', v_version_id, p_pdf_path,
    p_pdf_hash, 'application/pdf', p_pdf_size_bytes, auth.uid(), v_original_id
  )
  returning id into v_pdf_id;

  insert into public.documents (
    account_id, tenancy_id, document_type, title, requires_ack,
    published_at, created_by
  ) values (
    p_account_id, p_tenancy_id, p_document_type, p_title,
    coalesce(p_requires_ack, false), now(), auth.uid()
  )
  returning * into v_doc;

  insert into public.document_versions (
    id, account_id, document_id, version_no, source, attachment_id,
    content_hash, mime_type, size_bytes, created_by
  ) values (
    v_version_id, p_account_id, v_doc.id, 1, 'landlord_upload', v_pdf_id,
    p_pdf_hash, 'application/pdf', p_pdf_size_bytes, auth.uid()
  )
  returning * into v_ver;

  return jsonb_build_object(
    'document', to_jsonb(v_doc),
    'version', to_jsonb(v_ver),
    'deduped', false
  );
end;
$$;

revoke all on function public.create_tenancy_document_from_image(
  uuid, uuid, text, text, boolean, text, text, bigint, text, text, bigint, text
) from public, anon;
grant execute on function public.create_tenancy_document_from_image(
  uuid, uuid, text, text, boolean, text, text, bigint, text, text, bigint, text
) to authenticated;

notify pgrst, 'reload schema';
