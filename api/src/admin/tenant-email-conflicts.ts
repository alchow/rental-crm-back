// Server-only conflict oracle for per-account tenant-email uniqueness.
//
// Wraps public._tenant_email_conflicts(account, emails, exclude?) — the SECURITY
// DEFINER function (migration 20260721000002) that returns every holder already
// carrying one of the candidate addresses within the account: other live tenants
// ('tenant') AND owner/manager login emails ('account_user', read from
// auth.users). Two reasons the call lives behind the service-role admin client
// (and thus inside the admin quarantine, src/admin/):
//
//   1. CI guard: db/test/check_definer_grants.sql requires every non-allowlisted
//      public SECURITY DEFINER function to be service_role-only. The function's
//      grant is service_role-only, so it is only reachable through the admin
//      client — hence this wrapper.
//   2. Enumeration + auth.users exposure: a direct /rest/v1/rpc grant to
//      authenticated would let a signed-in user of ANY account probe which
//      addresses a landlord login uses (the oracle reads auth.users). Keeping the
//      call server-side closes that hole.
//
// HTTP-surface gating lives at the ROUTE, not here: the tenants POST/PATCH
// handlers are already account-scoped (a caller can only write tenants in an
// account they belong to), the same principals who would learn "taken" from the
// 409 anyway.

import { getAdminClient } from './supabase-admin';
import { getLogger } from '../log';

export interface TenantEmailConflict {
  email: string;
  holder_kind: 'tenant' | 'account_user';
  holder_id: string;
  holder_name: string;
}

/**
 * Return every holder that overlaps `emails` within `accountId`, normalized
 * lower(btrim). Pass `excludeTenantId` on an UPDATE so a tenant does not collide
 * with itself. Short-circuits an empty `emails` (no round trip).
 *
 * DEGRADE OPEN when the DB function does not exist yet (PGRST202): core
 * auto-deploys on main-merge while the prod migration is applied out-of-band,
 * so there is a window where this RPC is missing. Tenant creates/patches are a
 * LIVE user surface — a 500 blackout for that window is unacceptable. Skipping
 * the check matches the pre-feature state exactly (the DB trigger is equally
 * absent in that window); once the migration lands, both layers enforce. Any
 * OTHER error still throws (bubbles to onError → 500) — a real conflict is
 * data, not an error, so callers branch on the array.
 */
export async function tenantEmailConflicts(
  accountId: string,
  emails: string[],
  excludeTenantId?: string,
): Promise<TenantEmailConflict[]> {
  if (emails.length === 0) return [];
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('_tenant_email_conflicts', {
    p_account_id: accountId,
    p_emails: emails,
    p_exclude_tenant_id: excludeTenantId ?? undefined,
  });
  if (error) {
    if (error.code === 'PGRST202') {
      getLogger().warn(
        { account_id: accountId },
        '_tenant_email_conflicts missing (migration 20260721000002 not applied) — skipping the conflict check',
      );
      return [];
    }
    throw new Error(`_tenant_email_conflicts: ${error.message}`);
  }
  return (data ?? []) as TenantEmailConflict[];
}
