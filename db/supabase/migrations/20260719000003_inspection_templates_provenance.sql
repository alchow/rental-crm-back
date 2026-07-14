-- ----------------------------------------------------------------------------
-- Provenance for catalog-cloned templates + a canonical content hash.
--
-- catalog_id: server-set only (from the from-catalog route); never
--   client-writable. Records which bundled starter form a template was cloned
--   from, so per-unit layout deltas can be traced back to their origin.
--
-- schema_hash: md5 over schema::text, which is canonical (jsonb renders with
--   sorted keys and no incidental whitespace) -- so the hash is input-
--   formatting-independent. GENERATED ALWAYS STORED so it can never drift from
--   schema; clients use it as the drift marker for per-unit layout deltas
--   (base_template_version).
-- ----------------------------------------------------------------------------

alter table public.inspection_templates
  add column catalog_id text
    check (catalog_id is null or length(catalog_id) between 1 and 100),
  add column schema_hash text generated always as (md5(schema::text)) stored;

-- Backfill: cloned schemas already embed the catalog id as schema->>'form_code'
-- (a write-only field today; nothing else consumes it). Enumerate the bundled
-- ids explicitly so a stray form_code can never mint a bogus provenance.
update public.inspection_templates
   set catalog_id = schema->>'form_code'
 where catalog_id is null
   and schema->>'form_code' in ('residential-generic-v1');
