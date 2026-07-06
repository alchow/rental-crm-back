-- ----------------------------------------------------------------------------
-- Inbound email attachment ingestion (persona plan, phase 7).
--
-- Until now an inbound email's attachments survived only as provider URLs
-- inside inbound_raw.payload — a tier that is retention-pruned at 90 days and
-- has no reader. This phase gives captured mail a DURABLE, journal-tier blob
-- home:
--
--   bucket 'comm-attachments'   private, NO authenticated storage policies —
--                               reads and writes are API-mediated via the
--                               service tier only (the comm-evidence posture,
--                               20260703000004), so a client can neither
--                               list, overwrite nor delete blobs.
--   attachments.filename        the sender-supplied display name ("lease.pdf")
--                               — the existing polymorphic attachments table
--                               (entity_type='interactions') carries the rest
--                               (content_hash, mime, size). Nullable: existing
--                               rows (documents, inspection photos) never had
--                               one.
--
-- No new table: attachments already has member SELECT RLS (20260605000009),
-- per-entity content idempotency (20260629000001), and pagination indexes.
-- ----------------------------------------------------------------------------

alter table public.attachments
  add column filename text
    constraint attachments_filename_len
    check (filename is null or length(filename) between 1 and 255);

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute
      $sql$ insert into storage.buckets (id, name, public)
            values ('comm-attachments', 'comm-attachments', false)
            on conflict (id) do nothing $sql$;
  end if;
end $$;
