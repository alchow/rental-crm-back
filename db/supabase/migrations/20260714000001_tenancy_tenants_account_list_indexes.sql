-- Account-wide tenancy-members list (GET /accounts/{id}/tenancy-members):
-- keyset pagination and the tenant_id filter each want a composite prefix.
-- tenancy_tenants is a low-write table, so the write tax is negligible.
create index if not exists tenancy_tenants_account_created_idx
  on public.tenancy_tenants (account_id, created_at, id)
  where deleted_at is null;
create index if not exists tenancy_tenants_account_tenant_created_idx
  on public.tenancy_tenants (account_id, tenant_id, created_at, id)
  where deleted_at is null;
