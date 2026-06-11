import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getAnonClient } from '../supabase/anon-client';
import { getUserClient } from '../supabase/user-client';
import { loadEnv } from '../env';
import { ApiError, errorResponses } from './_lib/error';

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
  const body = c.req.valid('json');
  const anon = getAnonClient();
  const { data, error } = await anon.auth.refreshSession({ refresh_token: body.refresh_token });
  if (error) throw new ApiError(401, 'unauthenticated', error.message);
  return c.json({ session: data.session as unknown as z.infer<typeof Session> }, 200);
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
