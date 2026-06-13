import { randomBytes } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { newApiApp } from '../routes/_lib/app';
import { ApiError, errorResponses } from '../routes/_lib/error';
import { getAdminClient } from './supabase-admin';
import { hashSecret, ensurePrincipalByName, mintSessionForUser } from './agent-shared';

// ============================================================================
// Agent token exchange (ADR-0009 Phase 3).
// ============================================================================
//
// The root agent principal authenticates here with a bearer SECRET (hashed in
// agent_principals.secret_hash) and exchanges it for a short-lived Supabase
// session scoped to ONE account it has been granted. Two endpoints, both
// root-authed via the `X-Agent-Secret` header and mounted OUTSIDE the v1
// user-JWT stack (there is no user JWT here):
//
//   GET  /v1/agent/accounts   discovery: the accounts this principal may serve
//   POST /v1/agent/tokens     mint a per-account session { account_id }
//
// The session is minted WITHOUT a password via the GoTrue admin magic-link ->
// verifyOtp flow (validated to return a real access+refresh session that
// resolves to the sub-user's identity). All of this is service-role work, so
// it lives in src/admin/ behind the quarantine, exactly like the intake mint.
//
// Why a hashed bearer secret and not an asymmetric client assertion: the agent
// is a first-party service talking only to core over TLS; a high-entropy
// secret stored hash-only matches the intake-token precedent. Client-assertion
// is the upgrade path if the agent ever becomes third-party (ADR-0009).

// ----- root-secret provisioning ----------------------------------------------

// hashSecret and ensurePrincipalByName are shared with agent-grants.ts and now
// live in agent-shared.ts (imported above).

/**
 * Provision (or rotate) the bearer secret for a root principal. Ensures the
 * principal row exists, stores ONLY the sha256 hash, and returns the plaintext
 * secret EXACTLY ONCE. Used by the provisioning script and tests.
 */
export async function provisionRootSecret(
  name = 'default',
): Promise<{ id: string; name: string; secret: string }> {
  const admin = getAdminClient();
  const principal = await ensurePrincipalByName(admin, name);

  const secret = randomBytes(32).toString('base64url');
  const { error } = await admin
    .from('agent_principals')
    .update({ secret_hash: hashSecret(secret), secret_set_at: new Date().toISOString() })
    .eq('id', principal.id);
  if (error) throw new ApiError(500, 'database_error', error.message);

  return { id: principal.id, name: principal.name, secret };
}

interface RootPrincipal {
  id: string;
  name: string;
}

/** Read + verify the X-Agent-Secret header. Throws 401 when missing/invalid. */
async function requireRootPrincipal(c: Context): Promise<RootPrincipal> {
  const presented = c.req.header('x-agent-secret');
  if (!presented) {
    throw new ApiError(401, 'unauthenticated', 'missing X-Agent-Secret header');
  }
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('agent_principals')
    .select('id, name, disabled_at')
    .eq('secret_hash', hashSecret(presented))
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data || data.disabled_at) {
    throw new ApiError(401, 'unauthenticated', 'invalid agent secret');
  }
  return { id: data.id as string, name: data.name as string };
}

// ----- mint ------------------------------------------------------------------

interface MintedSession {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  account_id: string;
  scopes: string[];
}

async function mintAccountSession(
  principalId: string,
  accountId: string,
): Promise<MintedSession> {
  const admin = getAdminClient();

  // The principal must hold an ACTIVE grant for this account. A revoked or
  // absent grant is a clean 403 -- the agent re-checks /v1/agent/accounts (the
  // authoritative list) and drops the account from its fan-out.
  const { data: grant, error: gErr } = await admin
    .from('agent_grants')
    .select('agent_user_id, scopes')
    .eq('account_id', accountId)
    .eq('agent_principal_id', principalId)
    .is('revoked_at', null)
    .maybeSingle();
  if (gErr) throw new ApiError(500, 'database_error', gErr.message);
  if (!grant) {
    throw new ApiError(403, 'forbidden', 'the agent is not enabled for this account');
  }

  // Resolve the sub-user's email (needed for the magic-link mint).
  const agentUserId = grant.agent_user_id as string;
  const { data: userResp, error: uErr } = await admin.auth.admin.getUserById(agentUserId);
  if (uErr || !userResp?.user?.email) {
    throw new ApiError(500, 'database_error', `agent identity unavailable: ${uErr?.message ?? 'no email'}`);
  }

  const session = await mintSessionForUser(admin, userResp.user.email);

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: 'bearer',
    expires_in: session.expires_in ?? 3600,
    account_id: accountId,
    scopes: (grant.scopes as string[] | null) ?? [],
  };
}

async function listGrantedAccounts(
  principalId: string,
): Promise<Array<{ account_id: string; scopes: string[]; granted_at: string }>> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('agent_grants')
    .select('account_id, scopes, granted_at')
    .eq('agent_principal_id', principalId)
    .is('revoked_at', null)
    .order('granted_at', { ascending: false });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return (data ?? []) as Array<{ account_id: string; scopes: string[]; granted_at: string }>;
}

// ----- routes ----------------------------------------------------------------

const GrantedAccount = z
  .object({
    account_id: z.string().uuid(),
    scopes: z.array(z.string()),
    granted_at: z.string(),
  })
  .openapi('AgentGrantedAccount');

const AccountsResponse = z
  .object({ data: z.array(GrantedAccount) })
  .openapi('AgentAccountsResponse');

const TokenRequest = z
  .object({ account_id: z.string().uuid() })
  .openapi('AgentTokenRequest');

const TokenResponse = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.literal('bearer'),
    expires_in: z.number().int(),
    account_id: z.string().uuid(),
    scopes: z.array(z.string()),
  })
  .openapi('AgentTokenResponse');

const accountsRoute = createRoute({
  method: 'get',
  path: '/agent/accounts',
  tags: ['agent'],
  summary: 'List the accounts this agent principal may serve (X-Agent-Secret auth)',
  description:
    'Discovery for the agent fan-out. Authenticated by the root bearer secret in the `X-Agent-Secret` header; returns the principal\'s ACTIVE grants. This is the authoritative source of which accounts the agent serves.',
  responses: {
    200: { description: 'granted accounts', content: { 'application/json': { schema: AccountsResponse } } },
    ...errorResponses,
  },
});

const tokensRoute = createRoute({
  method: 'post',
  path: '/agent/tokens',
  tags: ['agent'],
  summary: 'Exchange the agent root secret for a per-account session (X-Agent-Secret auth)',
  description:
    'Authenticated by the root bearer secret in the `X-Agent-Secret` header. Mints a short-lived Supabase session scoped to the requested account (the agent must hold an active grant for it). Refresh the returned token via POST /v1/auth/refresh; re-mint only on a new account or refresh failure.',
  request: {
    body: { content: { 'application/json': { schema: TokenRequest } }, required: true },
  },
  responses: {
    200: { description: 'minted session', content: { 'application/json': { schema: TokenResponse } } },
    ...errorResponses,
  },
});

export const agentTokensApp = newApiApp();

agentTokensApp.openapi(accountsRoute, async (c) => {
  const principal = await requireRootPrincipal(c);
  const data = await listGrantedAccounts(principal.id);
  return c.json({ data }, 200);
});

agentTokensApp.openapi(tokensRoute, async (c) => {
  const principal = await requireRootPrincipal(c);
  const { account_id } = c.req.valid('json');
  const session = await mintAccountSession(principal.id, account_id);
  return c.json(session, 200);
});
