-- ----------------------------------------------------------------------------
-- Tenant document vault hardening (follow-up to 20260626000001_documents.sql).
--
-- Stacked as a NEW migration because 20260626000001 is already merged/applied;
-- editing an applied migration in place would never re-run. This adds:
--   1. a once-per-(token, document) 'viewed' dedupe index (bounds the audit
--      write-amplification on the public magic-link list endpoint), and
--   2. create_tenancy_document(): atomic documents + document_versions (+ the
--      backing attachment for uploads) creation, replacing the prior
--      non-transactional insert sequence that could orphan a document.
-- ----------------------------------------------------------------------------

-- The feature shipped without the dedupe, so production may already hold
-- multiple 'viewed' rows for the same (token, document). Collapse them before
-- adding the unique index (else the CREATE would fail): soft-delete all but the
-- earliest per (token, document). Soft-delete (not hard) keeps the evidentiary
-- stance and matches the index's `deleted_at is null` predicate.
with ranked as (
  select id,
         row_number() over (
           partition by token_id, document_id
           order by occurred_at, id
         ) as rn
    from public.document_access_events
   where event_type = 'viewed'
     and deleted_at is null
)
update public.document_access_events e
   set deleted_at = now(),
       updated_at = now()
  from ranked
 where e.id = ranked.id
   and ranked.rn > 1;

-- One 'viewed' row per (token, document): a magic link records that it first
-- opened a document once, rather than emitting a fresh viewed event (and a
-- per-account audit-chain row) on every page refresh. 'downloaded' stays
-- per-event (sparse + more probative) and 'acknowledged' is likewise once.
create unique index document_access_events_one_view_per_token_document
  on public.document_access_events (token_id, document_id)
  where event_type = 'viewed' and deleted_at is null;

-- ----------------------------------------------------------------------------
-- Atomic document creation.
--
-- A document and its first version (and, for uploads, the backing attachment
-- row) must land together or not at all: a half-written document (row present,
-- version missing) lists fine but 404s on download. This RPC does all the
-- inserts in one transaction.
--
-- SECURITY INVOKER (not DEFINER): the three target tables all carry a
-- `_member_all` RLS policy, so a landlord can insert them under their own JWT.
-- Running as the invoker keeps RLS in force (membership + tenancy scoping are
-- enforced by the SELECT and the WITH CHECK clauses) and lets auth.uid() drive
-- the audit-chain actor, exactly as the prior direct inserts did. Only the
-- storage-OBJECT write needs service-role; the caller does that separately
-- before calling this RPC, and an orphan blob on failure is harmless (a future
-- storage-GC cron prunes objects with no live attachments row).
-- ----------------------------------------------------------------------------
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

  return jsonb_build_object('document', to_jsonb(v_doc), 'version', to_jsonb(v_ver));
end;
$$;

grant execute on function public.create_tenancy_document(
  uuid, uuid, text, text, boolean, text, text, text, bigint, text, text, text
) to authenticated;
