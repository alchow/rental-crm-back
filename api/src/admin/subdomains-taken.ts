// Server-only branded-subdomain existence oracle (migration 20260721000001).
// SECURITY: The service-role-only DEFINER RPC prevents arbitrary cross-account
// label enumeration. The HTTP route separately limits this wrapper to managers,
// who could already learn "taken" from the branding write conflict.

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
