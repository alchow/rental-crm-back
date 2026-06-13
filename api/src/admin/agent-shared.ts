import { createHash } from 'node:crypto';
import type { Session } from '@supabase/supabase-js';

import { ApiError } from '../routes/_lib/error';
import type { getAdminClient } from './supabase-admin';
import { getAnonClient } from '../supabase/anon-client';

// ============================================================================
// Shared helpers for agent-grants.ts and agent-tokens.ts (ADR-0009).
// ============================================================================
//
// These helpers are quarantined to src/admin/ because they either accept a
// service-role admin client or call GoTrue admin APIs directly.

// ----- column list -----------------------------------------------------------

/**
 * Column list for SELECT queries against agent_grants. Centralised here so
 * both the grant-management path (agent-grants.ts) and any future paths share
 * a single source of truth for the shape.
 */
export const GRANT_COLS =
  'id, account_id, agent_principal_id, agent_user_id, scopes, granted_by, granted_at, revoked_at, revoked_by';

// ----- secret helpers --------------------------------------------------------

/**
 * SHA-256 the secret, prefixed with the Postgres bytea hex escape so the
 * column stores `\x<hex>` and comparisons are constant-time at the DB level.
 */
export function hashSecret(secret: string): string {
  return '\\x' + createHash('sha256').update(secret, 'utf8').digest('hex');
}

// ----- principal upsert ------------------------------------------------------

/**
 * Idempotent upsert of an agent_principals row by name, then select its
 * `id` and `name`. Safe to call concurrently; the `ignoreDuplicates` flag
 * means a race on the unique constraint is a no-op, not an error.
 *
 * Throws ApiError(500, 'database_error', ...) on any Supabase error.
 */
export async function ensurePrincipalByName(
  admin: ReturnType<typeof getAdminClient>,
  name: string,
): Promise<{ id: string; name: string }> {
  const { error: upErr } = await admin
    .from('agent_principals')
    .upsert({ name }, { onConflict: 'name', ignoreDuplicates: true });
  if (upErr) throw new ApiError(500, 'database_error', upErr.message);

  const { data, error } = await admin
    .from('agent_principals')
    .select('id, name')
    .eq('name', name)
    .single();
  if (error) throw new ApiError(500, 'database_error', error.message);
  return { id: data!.id as string, name: data!.name as string };
}

// ----- session mint ----------------------------------------------------------

/**
 * Mint a Supabase session for an agent sub-user via the admin magic-link →
 * verifyOtp flow (no password required). The generated link is NOT emailed;
 * we consume its `hashed_token` directly via `verifyOtp`.
 *
 * This is the shared primitive used both by mintAccountSession (agent-tokens)
 * and by the best-effort sign-out helper in revokeAgentGrant (agent-grants).
 *
 * Throws ApiError(502, 'internal_error', ...) when the link or session is
 * missing — callers that need best-effort behaviour must catch and swallow.
 */
export async function mintSessionForUser(
  admin: ReturnType<typeof getAdminClient>,
  email: string,
): Promise<Session> {
  const { data: link, error: lErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const hashedToken = link?.properties?.hashed_token;
  if (lErr || !hashedToken) {
    throw new ApiError(
      502,
      'internal_error',
      `failed to mint agent session: ${lErr?.message ?? 'no token'}`,
    );
  }
  const { data: sess, error: vErr } = await getAnonClient().auth.verifyOtp({
    type: 'email',
    token_hash: hashedToken,
  });
  if (vErr || !sess?.session) {
    throw new ApiError(
      502,
      'internal_error',
      `failed to mint agent session: ${vErr?.message ?? 'no session'}`,
    );
  }
  return sess.session;
}
