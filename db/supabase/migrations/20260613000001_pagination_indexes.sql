-- ----------------------------------------------------------------------------
-- Pagination indexes (architecture plan, Phase 1 item 5).
--
-- Every list endpoint keysets on (account_id, <ts>, id) filtered by
-- deleted_at IS NULL, but Phase 2 only created single-column account_id
-- indexes -- so each page was an index scan + sort. These partial composite
-- indexes turn every paginated list into a pure index range scan.
--
-- Column choices mirror the API exactly:
--   * most tables page on created_at
--   * interactions pages on occurred_at (user-stated event time)
--   * payments pages on received_at
--   * import_rows pages on (session_id, region_index, row_index) and has
--     no deleted_at column
--
-- Plain CREATE INDEX (not CONCURRENTLY): tables are small at this point and
-- supabase migrations run inside a transaction. If an index is ever added to
-- a grown production table, use CONCURRENTLY outside a transaction instead.
-- ----------------------------------------------------------------------------

create index if not exists properties_account_created_idx
  on public.properties (account_id, created_at, id) where deleted_at is null;
create index if not exists areas_account_created_idx
  on public.areas (account_id, created_at, id) where deleted_at is null;
create index if not exists tenants_account_created_idx
  on public.tenants (account_id, created_at, id) where deleted_at is null;
create index if not exists tenancies_account_created_idx
  on public.tenancies (account_id, created_at, id) where deleted_at is null;
create index if not exists leases_account_created_idx
  on public.leases (account_id, created_at, id) where deleted_at is null;
create index if not exists charges_account_created_idx
  on public.charges (account_id, created_at, id) where deleted_at is null;
create index if not exists maintenance_requests_account_created_idx
  on public.maintenance_requests (account_id, created_at, id) where deleted_at is null;
create index if not exists import_sessions_account_created_idx
  on public.import_sessions (account_id, created_at, id) where deleted_at is null;

-- API orders interactions by occurred_at, payments by received_at.
create index if not exists interactions_account_occurred_idx
  on public.interactions (account_id, occurred_at, id) where deleted_at is null;
create index if not exists payments_account_received_idx
  on public.payments (account_id, received_at, id) where deleted_at is null;

-- import_rows keysets on (region_index, row_index) within a session and has
-- no soft-delete column.
create index if not exists import_rows_session_region_row_idx
  on public.import_rows (session_id, region_index, row_index);
