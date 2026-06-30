-- ----------------------------------------------------------------------------
-- Attachments: content-addressed idempotency (architecture plan item #2a).
--
-- Storage bytes are already deduped (content-addressed path + upsert), but the
-- attachment ROW was inserted on every upload, so re-submitting identical bytes
-- for the same entity created duplicate rows (one blob, N rows). This makes the
-- row insert idempotent on (account_id, entity_type, entity_id, content_hash):
-- re-uploading the same bytes to the same entity returns the existing row.
--
-- Two parts:
--   (1) collapse pre-existing live duplicates so the unique index can build;
--   (2) create the partial unique index that enforces it going forward.
--
-- HEIC original vs its JPEG derivative have DIFFERENT content_hash, so they live
-- in different partitions and are never merged into each other; a duplicate HEIC
-- upload collapses both the duplicate original and the duplicate derivative
-- within their own partitions.
--
-- Plain (non-CONCURRENT) index: small table, migration runs in a transaction.
-- On a grown prod table, run CREATE UNIQUE INDEX CONCURRENTLY outside a txn and
-- size the collapse first with:
--   select account_id, entity_type, entity_id, content_hash, count(*)
--     from public.attachments where deleted_at is null
--    group by 1,2,3,4 having count(*) > 1;
-- ----------------------------------------------------------------------------

-- (1) Collapse: keep the earliest live row per content-identity, soft-delete the
-- rest. row_number over the same tuple the unique index will enforce.
with ranked as (
  select id,
         row_number() over (
           partition by account_id, entity_type, entity_id, content_hash
           order by received_at, created_at, id
         ) as rn
    from public.attachments
   where deleted_at is null
)
update public.attachments a
   set deleted_at = now(),
       updated_at = now()
  from ranked r
 where a.id = r.id
   and r.rn > 1;

-- (2) Enforce going forward.
create unique index if not exists attachments_content_idem_idx
  on public.attachments (account_id, entity_type, entity_id, content_hash)
  where deleted_at is null;
