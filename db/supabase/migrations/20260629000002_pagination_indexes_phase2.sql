-- ----------------------------------------------------------------------------
-- Pagination indexes, phase 2 (architecture plan item #4 follow-through).
--
-- The list endpoints below were converted from a bare unbounded fetch to the
-- shared keyset paginator (cursor.ts). Each now keysets on (<col>, id) within
-- an account (and sometimes a tenancy), so it wants the same partial composite
-- index treatment as 20260613000001 -- turning every page into a pure index
-- range scan rather than a scan + sort.
--
-- Column choices mirror the API exactly:
--   * documents, tenancy_tenants  -> created_at  (deleted_at predicate)
--   * attachments                 -> created_at, usually filtered by entity
--   * agent_grants                -> granted_at  (no soft-delete column)
--   * evidence_exports            -> generated_at (deleted_at predicate)
--   * intake_tokens               -> created_at within a tenancy (no soft-delete)
--
-- Plain CREATE INDEX IF NOT EXISTS (not CONCURRENTLY): these tables are small
-- and supabase migrations run inside a transaction. On a grown prod table use
-- CONCURRENTLY outside a transaction instead (see 20260613000001 note).
-- ----------------------------------------------------------------------------

create index if not exists documents_account_created_idx
  on public.documents (account_id, created_at, id) where deleted_at is null;

-- Attachments are usually listed filtered by (entity_type, entity_id); the
-- composite serves that path, and the account-wide composite serves the
-- unfiltered list. Both keyset on created_at, id.
create index if not exists attachments_account_entity_created_idx
  on public.attachments (account_id, entity_type, entity_id, created_at, id)
  where deleted_at is null;
create index if not exists attachments_account_created_idx
  on public.attachments (account_id, created_at, id) where deleted_at is null;

create index if not exists tenancy_tenants_account_tenancy_created_idx
  on public.tenancy_tenants (account_id, tenancy_id, created_at, id) where deleted_at is null;

create index if not exists evidence_exports_account_generated_idx
  on public.evidence_exports (account_id, generated_at, id) where deleted_at is null;

-- agent_grants and intake_tokens have no deleted_at column (they track lifecycle
-- via revoked_at and are listed including revoked rows) -- non-partial indexes.
create index if not exists agent_grants_account_granted_idx
  on public.agent_grants (account_id, granted_at, id);

create index if not exists intake_tokens_account_tenancy_created_idx
  on public.intake_tokens (account_id, tenancy_id, created_at, id);
