-- ----------------------------------------------------------------------------
-- Phase 27 (4/6): let an inspection report become a tenant-facing document.
--
-- On completion of a move-in/move-out inspection we point a document_versions
-- row at the EXISTING content-hashed inspection_report attachment, so the whole
-- existing tenant flow (magic links, viewed/downloaded/acknowledged, audit,
-- rate-limit) becomes the tenant's review + acknowledgment surface for free.
--
--   (A) document_versions.source gains 'inspection_report', behaving like an
--       upload (points at an attachment, not a bundled static asset).
--   (B) documents.inspection_id bonds the document to its inspection, with a
--       one-live-document-per-inspection guard so the report can't fan out.
-- ----------------------------------------------------------------------------

-- (A) Replace the two inline CHECKs that reference 'landlord_upload' (the
-- source-value check and the source/attachment coherence check). Drop them by
-- DEFINITION match -- inline CHECKs have auto-generated names we shouldn't
-- hard-code -- then re-add named, widened versions.
do $$
declare
  r record;
begin
  for r in
    select con.conname
      from pg_constraint con
      join pg_class c     on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'document_versions'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%landlord_upload%'
  loop
    execute format('alter table public.document_versions drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.document_versions
  add constraint document_versions_source_check
    check (source in ('landlord_upload', 'bundled_static', 'inspection_report'));

alter table public.document_versions
  add constraint document_versions_source_attachment_check
    check (
      (source in ('landlord_upload', 'inspection_report')
        and attachment_id is not null
        and static_template_id is null
        and static_asset_path is null)
      or
      (source = 'bundled_static'
        and attachment_id is null
        and static_template_id is not null
        and static_asset_path is not null)
    );

-- (B) Bond a document to the inspection it was rendered from. on delete
-- restrict (not set null): account_id is NOT NULL so a composite-FK set-null
-- would fail, and inspections are soft-deleted (never hard-deleted) anyway.
alter table public.documents
  add column inspection_id uuid,
  add constraint documents_inspection_fk
    foreign key (account_id, inspection_id)
    references public.inspections(account_id, id) on delete restrict;

create index documents_inspection_id_idx
  on public.documents (inspection_id) where inspection_id is not null;

-- One live document per inspection -- the drift guard for idempotent emission.
create unique index documents_one_per_inspection
  on public.documents (account_id, inspection_id)
  where inspection_id is not null and deleted_at is null;
