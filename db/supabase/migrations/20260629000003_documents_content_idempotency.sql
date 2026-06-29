-- ----------------------------------------------------------------------------
-- Documents: content-addressed idempotency (architecture plan item #2b).
--
-- Each create_tenancy_document() call minted a fresh document + version (+ the
-- backing attachment with a fresh version-id entity), so re-uploading identical
-- bytes -- the common duplicate-on-retry case the front-end hit -- produced a
-- new document every time. (The attachment-level dedup in
-- 20260629000001 can't catch this: each version-id is unique.)
--
-- Two parts:
--   (1) a per-document unique index on (account_id, document_id, content_hash):
--       always-safe today (one version per document) and future-proofs
--       versioning -- the same bytes can't appear twice as versions of ONE doc;
--   (2) create_tenancy_document() gains a content-addressed dedup: if an
--       identical, LIVE document already exists for the same
--       (account_id, tenancy_id, document_type), it returns that document
--       instead of creating a duplicate, and reports `deduped` in its result.
--
-- The dedup is scoped to document_type ON PURPOSE: the same PDF filed as a
-- `lease` and later as a `disclosure` are distinct intended records -- merging
-- them (dropping the disclosure) is worse than a duplicate. Only identical bytes
-- within the same (tenancy, type) collapse; DIFFERENT bytes always create a new
-- document (no implicit versioning -- replace-vs-version is a UX decision).
--
-- The dedup is best-effort against a concurrent double-submit: no single
-- constraint spans tenancy_id + document_type (on documents) and content_hash
-- (on document_versions), so two truly simultaneous identical creates can still
-- both land. That race is rare and self-heals (a later upload dedupes against
-- the earliest); the sequential duplicate-on-retry it fixes is the real failure
-- mode. Same 12-arg signature -> replaces in place; grant re-affirmed.
-- ----------------------------------------------------------------------------

create unique index if not exists document_versions_content_per_document_idx
  on public.document_versions (account_id, document_id, content_hash)
  where deleted_at is null;

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
  v_tenancy        uuid;
  v_version_id     uuid := gen_random_uuid();
  v_attachment_id  uuid;
  v_doc            public.documents;
  v_ver            public.document_versions;
  v_existing_id    uuid;
begin
  -- RLS on this SELECT enforces "caller is a member of p_account_id"; the
  -- deleted_at filter rejects soft-deleted tenancies the FK alone would allow.
  select id into v_tenancy
    from public.tenancies
    where account_id = p_account_id
      and id = p_tenancy_id
      and deleted_at is null;
  if v_tenancy is null then
    raise exception 'tenancy_not_found' using errcode = 'P0002';
  end if;

  -- Content idempotency (scoped to document_type). Returns the earliest live
  -- match so retries are deterministic.
  select d.id into v_existing_id
    from public.documents d
    join public.document_versions v
      on v.account_id = d.account_id and v.document_id = d.id
   where d.account_id    = p_account_id
     and d.tenancy_id    = p_tenancy_id
     and d.document_type = p_document_type
     and d.deleted_at    is null
     and v.deleted_at    is null
     and v.content_hash  = p_content_hash
   order by d.created_at asc
   limit 1;
  if v_existing_id is not null then
    select * into v_doc
      from public.documents
      where account_id = p_account_id and id = v_existing_id;
    select * into v_ver
      from public.document_versions
      where account_id = p_account_id and document_id = v_existing_id and deleted_at is null
      order by version_no desc
      limit 1;
    return jsonb_build_object(
      'document', to_jsonb(v_doc), 'version', to_jsonb(v_ver), 'deduped', true
    );
  end if;

  if p_source = 'landlord_upload' then
    insert into public.attachments
      (account_id, entity_type, entity_id, storage_path, content_hash,
       mime_type, size_bytes, uploaded_by)
    values
      (p_account_id, 'document_versions', v_version_id, p_attachment_path,
       p_content_hash, p_mime_type, p_size_bytes, (select auth.uid()))
    returning id into v_attachment_id;
  end if;

  insert into public.documents
    (account_id, tenancy_id, document_type, title, requires_ack,
     published_at, created_by)
  values
    (p_account_id, p_tenancy_id, p_document_type, p_title,
     coalesce(p_requires_ack, false), now(), (select auth.uid()))
  returning * into v_doc;

  insert into public.document_versions
    (id, account_id, document_id, version_no, source, attachment_id,
     static_template_id, static_asset_path, content_hash, mime_type,
     size_bytes, created_by)
  values
    (v_version_id, p_account_id, v_doc.id, 1, p_source, v_attachment_id,
     p_static_template_id, p_static_asset_path, p_content_hash, p_mime_type,
     p_size_bytes, (select auth.uid()))
  returning * into v_ver;

  return jsonb_build_object(
    'document', to_jsonb(v_doc), 'version', to_jsonb(v_ver), 'deduped', false
  );
end;
$$;

grant execute on function public.create_tenancy_document(
  uuid, uuid, text, text, boolean, text, text, text, bigint, text, text, text
) to authenticated;
