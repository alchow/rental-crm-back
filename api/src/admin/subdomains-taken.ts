// Server-only existence oracle for branded-subdomain suggestions.
//
// Wraps public._email_subdomains_taken(candidates) — the SECURITY DEFINER RPC
// (migration 20260721000001) that returns which candidate labels are already
// claimed by SOME account (across accounts; accounts is member-SELECT under
// FORCE RLS). Two reasons this call lives behind the service-role admin client
// (and thus in the admin quarantine, src/admin/):
//
//   1. CI guard: db/test/check_definer_grants.sql requires every
//      non-allowlisted public SECURITY DEFINER function to be service_role-only.
//      The RPC's grant is service_role-only, so it is only reachable through the
//      admin client — hence this wrapper.
//   2. Enumeration: a direct /rest/v1/rpc grant to authenticated would let a
//      signed-in user of ANY account probe whether an arbitrary label is claimed.
//      Keeping the call server-side (service_role-only) closes that hole.
//
// HTTP-surface gating lives at the ROUTE, not here: accounts.ts /email-branding/
// suggestions is requireManager (owner|manager) — the same principals who would
// learn "taken" from a PATCH 409 anyway.

import { getAdminClient } from './supabase-admin';

/**
 * Return the subset of `candidates` already claimed as an email_subdomain by
 * some account. Throws on a query error (the caller lets it bubble to the app's
 * onError, which renders a dbError-style 500 — acceptable: this endpoint is
 * pre-frontend). Callers should short-circuit an empty `candidates` (no need to
 * round-trip an empty set).
 */
export async function emailSubdomainsTaken(candidates: string[]): Promise<string[]> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('_email_subdomains_taken', {
    p_candidates: candidates,
  });
  if (error) throw new Error(`_email_subdomains_taken: ${error.message}`);
  return data ?? [];
}
