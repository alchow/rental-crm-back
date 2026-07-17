import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getAnonClient } from '../supabase/anon-client';
import { getUserClient } from '../supabase/user-client';
import { loadEnv } from '../env';
import { ApiError, errorResponses } from './_lib/error';
import { enableAgentForAccount } from '../admin/agent-grants';
import { getLogger } from '../log';

// /v1/auth/* fronts Supabase Auth. Clients only see this contract; the
// underlying supabase-js calls and the atomic account-creation RPC are
// invisible to them.
//
// Phase 11: typed via @hono/zod-openapi so the routes appear in
// openapi.json and the generated SDK -- "swappable front-end" is only
// real if the auth surface is in the spec too.

const Session = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.string(),
    expires_in: z.number().int(),
    expires_at: z.number().int().optional(),
    user: z.unknown().nullable().optional(),
  })
  .openapi('AuthSession');

const SignupBody = z
  .object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    account_name: z.string().min(1).max(200),
  })
  .openapi('SignupRequest');

const SignupSuccess = z
  .object({
    user: z.object({ id: z.string().uuid(), email: z.string().nullable() }),
    account: z.object({ id: z.string().uuid(), role: z.string() }),
    session: Session,
  })
  .openapi('SignupResponse');


const LoginBody = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .openapi('LoginRequest');

const LoginResponse = z
  .object({
    user: z.object({ id: z.string().uuid(), email: z.string().nullable() }).nullable(),
    session: Session,
  })
  .openapi('LoginResponse');

const RefreshBody = z
  .object({ refresh_token: z.string().min(1) })
  .openapi('RefreshRequest');

const RefreshResponse = z
  .object({ session: Session })
  .openapi('RefreshResponse');

const LogoutBody = z
  .object({
    scope: z.enum(['global', 'local', 'others']).default('global'),
  })
  .openapi('LogoutRequest');

const signupRoute = createRoute({
  method: 'post',
  path: '/auth/signup',
  tags: ['auth'],
  summary: 'Create a user + account atomically',
  request: {
    body: { content: { 'application/json': { schema: SignupBody } }, required: true },
  },
  responses: {
    200: { description: 'created', content: { 'application/json': { schema: SignupSuccess } } },
    ...errorResponses,
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  tags: ['auth'],
  summary: 'Exchange credentials for a session',
  request: {
    body: { content: { 'application/json': { schema: LoginBody } }, required: true },
  },
  responses: {
    200: { description: 'authenticated', content: { 'application/json': { schema: LoginResponse } } },
    401: { description: 'invalid credentials', content: { 'application/json': { schema: errorResponses[400].content['application/json'].schema } } },
    ...errorResponses,
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/auth/refresh',
  tags: ['auth'],
  summary: 'Refresh an access token using a refresh token',
  request: {
    body: { content: { 'application/json': { schema: RefreshBody } }, required: true },
  },
  responses: {
    200: { description: 'refreshed', content: { 'application/json': { schema: RefreshResponse } } },
    401: { description: 'refresh failed', content: { 'application/json': { schema: errorResponses[400].content['application/json'].schema } } },
    503: { description: 'auth upstream unavailable — retry with the same refresh token', content: { 'application/json': { schema: errorResponses[400].content['application/json'].schema } } },
    ...errorResponses,
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  tags: ['auth'],
  summary: 'Revoke session(s) per scope',
  request: {
    body: { content: { 'application/json': { schema: LogoutBody } }, required: false },
  },
  responses: {
    204: { description: 'revoked' },
    401: { description: 'token invalid', content: { 'application/json': { schema: errorResponses[400].content['application/json'].schema } } },
    ...errorResponses,
  },
});

const auth = newApiApp();

// Auth handlers throw ApiError for the non-2xx paths (the global onError
// formats those into the typed ErrorEnvelope). The 202 pending-verification
// case is a normal 2xx-shape response and is returned directly.

auth.openapi(signupRoute, async (c) => {
  const body = c.req.valid('json');
  const anon = getAnonClient();
  const { data, error } = await anon.auth.signUp({
    email: body.email,
    password: body.password,
  });
  if (error) {
    throw new ApiError(400, 'invalid_request', error.message);
  }
  if (!data.user || !data.session) {
    throw new ApiError(400, 'invalid_request', 'email confirmation is required; disable it in Supabase Auth settings to use this endpoint');
  }

  const userClient = getUserClient(data.session.access_token);
  const { data: rpcData, error: rpcError } = await userClient.rpc(
    'create_account_for_new_user',
    { p_account_name: body.account_name, p_display_name: body.email },
  );
  if (rpcError) throw new ApiError(500, 'database_error', rpcError.message);
  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as { account_id: string; role: string } | null;
  if (!row?.account_id) {
    throw new ApiError(500, 'database_error', 'RPC returned no account row');
  }

  // Every new account gets the agent enabled by default (ADR-0009 grant flow,
  // applied automatically here instead of waiting for the owner to opt in).
  // Best-effort: the account is already committed by the RPC above and cannot
  // be rolled back, so a failure here must not fail signup -- the owner can
  // enable later via POST /v1/accounts/{id}/agent-grants. Removal stays manual
  // via POST /v1/accounts/{id}/agent-grants/{id}/revoke.
  try {
    await enableAgentForAccount(row.account_id, data.user.id);
  } catch (err) {
    getLogger().error(
      { err, accountId: row.account_id, userId: data.user.id },
      'signup: default agent enablement failed; account created without agent',
    );
  }

  return c.json({
    user: { id: data.user.id, email: data.user.email ?? null },
    account: { id: row.account_id, role: row.role },
    session: data.session as unknown as z.infer<typeof Session>,
  }, 200);
});

auth.openapi(loginRoute, async (c) => {
  const body = c.req.valid('json');
  const anon = getAnonClient();
  const { data, error } = await anon.auth.signInWithPassword(body);
  if (error) throw new ApiError(401, 'unauthenticated', error.message);
  return c.json({
    user: data.user ? { id: data.user.id, email: data.user.email ?? null } : null,
    session: data.session as unknown as z.infer<typeof Session>,
  }, 200);
});

auth.openapi(refreshRoute, async (c) => {
  // GoTrue REST directly — NEVER the shared anon client's refreshSession().
  // gotrue-js collapses every concurrent _callRefreshToken on one client
  // instance into a single in-flight promise REGARDLESS of which
  // refresh_token each caller passed (auth-js GoTrueClient: "refreshing is
  // already in progress" → returns the winner's promise). This proxy serves
  // MANY sessions: the agent transport refreshes one session per granted
  // account, and those land on the same tick because they were minted
  // together at agent boot — under the shared client every account received
  // the same winner's session, so all cross-account calls 404'd under RLS
  // (prod incident 2026-07-17). Stateless REST per request has no shared
  // client state to collapse on — same posture as the logout handler below.
  const body = c.req.valid('json');
  const env = loadEnv();
  const url = `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/token?grant_type=refresh_token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: body.refresh_token }),
  });
  const payload = (await res.json().catch(() => undefined)) as
    | (z.infer<typeof Session> & { error_description?: string; msg?: string; error_code?: string })
    | undefined;
  if (!res.ok) {
    // 4xx from GoTrue = the token is dead (used/revoked/expired) → 401, the
    // frontend logs out. 429/5xx = upstream blip → 503 so callers RETAIN the
    // refresh token and retry (the agent re-mints either way; the frontend
    // keys 401→logout / 5xx→retry). The old supabase-js path collapsed
    // everything to 401 AND carried a client-side retry we no longer have —
    // this mapping compensates.
    const transient = res.status === 429 || res.status >= 500;
    throw new ApiError(
      transient ? 503 : 401,
      transient ? 'service_unavailable' : 'unauthenticated',
      payload?.error_description ?? payload?.msg ?? 'refresh failed',
    );
  }
  // GoTrue's token endpoint returns the session fields at the top level.
  const parsed = Session.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(503, 'service_unavailable', 'auth upstream returned a malformed session');
  }
  return c.json({ session: parsed.data }, 200);
});

auth.openapi(logoutRoute, async (c) => {
  // Real revocation. We hit the GoTrue REST endpoint directly with the
  // caller's Bearer token; that invalidates the refresh token at the
  // requested scope. supabase-js's signOut() expects a persisted session
  // (it manages cookies), which is the wrong abstraction for a stateless
  // API.
  const env = loadEnv();
  const body = (c.req.valid('json') ?? { scope: 'global' as const });
  const header = c.req.header('authorization') ?? '';
  if (!/^bearer\s+/i.test(header)) {
    return c.body(null, 204);
  }
  const token = header.replace(/^bearer\s+/i, '').trim();
  const url = `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/logout?scope=${body.scope}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    throw new ApiError(502, 'internal_error', message);
  }
  if (res.status === 204) return c.body(null, 204);
  if (res.status === 401) {
    throw new ApiError(401, 'unauthenticated', 'token invalid or already revoked');
  }
  const detail = await res.text().catch(() => '');
  throw new ApiError(502, 'internal_error', detail || `GoTrue returned ${res.status}`);
});

export default auth;
