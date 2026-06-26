import { randomBytes } from 'node:crypto';
import { ApiError } from '../routes/_lib/error';
import { getAdminClient } from './supabase-admin';
import { getLogger } from '../log';
import { GRANT_COLS, ensurePrincipalByName, mintSessionForUser } from './agent-shared';

// ============================================================================
// Agent grant provisioning (ADR-0009 Phase 2).
// ============================================================================
//
// Enabling/revoking the agent for an account is a PRIVILEGED flow: it creates
// (or reuses) the per-account agent service-account user, manages its
// role='agent' membership, and writes the agent_grants registry row. All of
// that bypasses RLS, so it lives here in src/admin/ behind the service-role
// quarantine -- the route handler only verifies the caller is an owner/manager
// of the account (from the cached account_members role on c.get('account'),
// NOT a live RLS query) before delegating here, exactly like the intake-token
// mint pattern. The DB-level guard on agent_grants is the absence of any
// authenticated INSERT/UPDATE policy (writes are service-role only).
//
// Identity reuse: the agent's journal actor must be STABLE per account across
// revoke/re-enable cycles, so we reuse the existing role='agent' member of the
// account (even a soft-deleted one) instead of minting a fresh auth user each
// time. A new auth user is created only on the first-ever enable for an
// account. The credential-less identity is fine: the Phase 3 mint path issues
// sessions via a GoTrue magic link, never a password.

export interface AgentGrant {
  id: string;
  account_id: string;
  agent_principal_id: string;
  agent_user_id: string;
  // scopes: DEFERRED enforcement (ADR-0009). Stored, returned, and threaded
  // into the minted session, but NO code reads it yet -- every operation is
  // permitted regardless of scope values, and the column has no value
  // constraint. Add per-op gating here (and in the firewall) when it lands.
  scopes: string[];
  granted_by: string | null;
  granted_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

// The single default root principal (one agent product per deployment for now;
// per-product principals are an ADR-0009 revisit trigger). Ensured idempotently
// so no separate seed migration is needed.
async function ensureDefaultPrincipalId(
  admin: ReturnType<typeof getAdminClient>,
): Promise<string> {
  return (await ensurePrincipalByName(admin, 'default')).id;
}

// Reuse the account's existing agent identity if one was ever provisioned
// (active or soft-deleted membership). Returns null when the account has never
// had an agent -- the caller then creates one.
async function findExistingAgentUserId(
  admin: ReturnType<typeof getAdminClient>,
  accountId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('account_members')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('role', 'agent')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  return data ? (data.user_id as string) : null;
}

/**
 * Enable the agent for an account: ensure the per-account service-account user
 * + its role='agent' membership exist and active, then write the grant.
 *
 * @param accountId  the account to enable (membership already verified by the route)
 * @param grantedBy  the owner/manager user id enabling the agent (audit sponsor)
 */
export async function enableAgentForAccount(
  accountId: string,
  grantedBy: string,
): Promise<AgentGrant> {
  const admin = getAdminClient();
  const principalId = await ensureDefaultPrincipalId(admin);

  // Already enabled? The partial-unique index backs this up, but a clean 409
  // beats surfacing a raw constraint violation.
  const { data: active, error: activeErr } = await admin
    .from('agent_grants')
    .select('id')
    .eq('account_id', accountId)
    .eq('agent_principal_id', principalId)
    .is('revoked_at', null)
    .maybeSingle();
  if (activeErr) throw new ApiError(500, 'database_error', activeErr.message);
  if (active) {
    throw new ApiError(409, 'conflict', 'the agent is already enabled for this account');
  }

  // Resolve the agent identity: reuse the account's existing agent user, else
  // create one with a deterministic, per-account email.
  let agentUserId = await findExistingAgentUserId(admin, accountId);
  if (!agentUserId) {
    const email = `agent+${accountId}@agents.internal`;
    const password = randomBytes(24).toString('base64url');
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      // Narrow orphan window: the auth user exists from a prior failed attempt
      // but no membership was written. Re-check membership in case a concurrent
      // request just provisioned it; otherwise this needs manual cleanup.
      agentUserId = await findExistingAgentUserId(admin, accountId);
      if (!agentUserId) {
        throw new ApiError(
          500,
          'database_error',
          `failed to provision agent identity: ${createErr?.message ?? 'unknown error'}`,
        );
      }
    } else {
      agentUserId = created.user.id;
    }
  }

  // Ensure the membership is present and ACTIVE (un-delete a prior revoke).
  const { error: memErr } = await admin
    .from('account_members')
    .upsert(
      {
        account_id: accountId,
        user_id: agentUserId,
        role: 'agent',
        deleted_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,user_id' },
    );
  if (memErr) throw new ApiError(500, 'database_error', memErr.message);

  const { data: grant, error: grantErr } = await admin
    .from('agent_grants')
    .insert({
      account_id: accountId,
      agent_principal_id: principalId,
      agent_user_id: agentUserId,
      granted_by: grantedBy,
    })
    .select(GRANT_COLS)
    .single();
  if (grantErr) {
    // Lost a race to a concurrent enable.
    if (grantErr.code === '23505') {
      throw new ApiError(409, 'conflict', 'the agent is already enabled for this account');
    }
    throw new ApiError(500, 'database_error', grantErr.message);
  }
  return grant as AgentGrant;
}

/**
 * Revoke an active grant: mark it revoked. The agent's role='agent' membership
 * is soft-deleted as a DERIVED side effect by the agent_grants trigger
 * (trg_sync_agent_membership_from_grant, migration 20260625000001) in the SAME
 * statement -- so the RLS kill and the revocation are atomic and can never
 * diverge (the bug behind the 2026-06-25 incident, where the membership was
 * dead but the grant stayed active, leaving the agent in a permanent 404 loop).
 * The agent identity is preserved (soft-delete, not removed) so a later
 * re-enable reuses the same journal actor.
 *
 * Best-effort session kill: after marking the grant revoked, we mint a
 * throwaway session for the agent sub-user and call signOut('global') to
 * revoke ALL of its GoTrue refresh tokens. This is belt-and-suspenders on top
 * of the membership kill (ADR-0009 SHOULD). The membership removal (RLS kill,
 * now trigger-driven) is the hard floor -- a sign-out failure must never abort
 * the revoke response.
 */
export async function revokeAgentGrant(
  accountId: string,
  grantId: string,
  revokedBy: string,
): Promise<{ id: string; revoked_at: string }> {
  const admin = getAdminClient();

  const { data: grant, error: findErr } = await admin
    .from('agent_grants')
    .select('id, agent_user_id')
    .eq('account_id', accountId)
    .eq('id', grantId)
    .is('revoked_at', null)
    .maybeSingle();
  if (findErr) throw new ApiError(500, 'database_error', findErr.message);
  if (!grant) throw new ApiError(404, 'not_found', 'agent grant not found or already revoked');

  const agentUserId = grant.agent_user_id as string;
  const nowIso = new Date().toISOString();

  // Single source of truth: write ONLY the grant. The agent_grants trigger
  // derives the membership soft-delete atomically (see the doc comment above),
  // so there is no longer a two-write ordering that can half-apply.
  const { data: revoked, error: revErr } = await admin
    .from('agent_grants')
    .update({ revoked_at: nowIso, revoked_by: revokedBy })
    .eq('id', grantId)
    .is('revoked_at', null)
    .select('id, revoked_at')
    .maybeSingle();
  if (revErr) throw new ApiError(500, 'database_error', revErr.message);
  if (!revoked) throw new ApiError(404, 'not_found', 'agent grant not found or already revoked');

  // Best-effort: revoke all of the agent sub-user's GoTrue refresh tokens so
  // previously-minted sessions cannot be exchanged for new access tokens after
  // revoke. This is belt-and-suspenders on top of the membership soft-delete
  // (the RLS hard floor): even without this, the agent's next DB write will
  // be denied because the role='agent' membership is gone. We SHOULD also kill
  // the refresh tokens per ADR-0009 to close the window between the revoke and
  // the next natural token expiry.
  //
  // Why a global sign-out on this sub-user is correctly scoped: the agent
  // sub-user is provisioned as a per-account identity (one auth user per
  // account×agent pairing, email = agent+<accountId>@agents.internal). A
  // global sign-out of THIS sub-user therefore only affects sessions for THIS
  // account's agent -- it cannot affect the agent's sessions for other
  // accounts, which are separate auth users.
  await signOutAgentUser(admin, agentUserId);

  return { id: revoked.id as string, revoked_at: revoked.revoked_at as string };
}

/**
 * Best-effort: mint a throwaway session for the agent sub-user, then call
 * admin.auth.admin.signOut(jwt, 'global') to revoke ALL of that sub-user's
 * GoTrue refresh tokens. Logs a warning on failure but never throws -- the
 * membership kill (RLS) is the hard security floor.
 */
async function signOutAgentUser(
  admin: ReturnType<typeof getAdminClient>,
  agentUserId: string,
): Promise<void> {
  try {
    const { data: userResp, error: uErr } = await admin.auth.admin.getUserById(agentUserId);
    if (uErr || !userResp?.user?.email) {
      getLogger().warn(
        { agentUserId, err: uErr },
        'agent revoke: could not resolve agent email for sign-out; ' +
          'refresh token survives until expiry but RLS still enforces denial',
      );
      return;
    }
    const session = await mintSessionForUser(admin, userResp.user.email);
    await admin.auth.admin.signOut(session.access_token, 'global');
  } catch (err) {
    // Never surface sign-out failures to the caller. The membership kill
    // already prevents the agent from reading or writing account data via RLS.
    getLogger().warn(
      { agentUserId, err },
      'agent revoke: best-effort sign-out failed; ' +
        'refresh token survives until expiry but RLS still enforces denial',
    );
  }
}
