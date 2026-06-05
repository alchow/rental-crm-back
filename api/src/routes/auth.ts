import { Hono } from 'hono';
import { z } from 'zod';
import { getAnonClient } from '../supabase/anon-client';
import { getUserClient } from '../supabase/user-client';
import { loadEnv } from '../env';

// /v1/auth/* fronts Supabase Auth. Clients only see this contract; the
// underlying supabase-js calls and the atomic account-creation RPC are
// invisible to them.

const auth = new Hono();

const SignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  account_name: z.string().min(1).max(200),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(1),
});

const LogoutSchema = z.object({
  // global: invalidate all sessions for the user
  // local:  invalidate only this access token's session
  // others: invalidate every session except the current one
  scope: z.enum(['global', 'local', 'others']).default('global'),
});

function badRequest(message: string, details?: unknown): Response {
  return new Response(
    JSON.stringify({ error: { code: 'invalid_request', message, details } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

auth.post('/auth/signup', async (c) => {
  const body = SignupSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) {
    return badRequest('invalid signup body', body.error.flatten());
  }

  const anon = getAnonClient();
  const { data, error } = await anon.auth.signUp({
    email: body.data.email,
    password: body.data.password,
  });
  if (error) {
    return c.json(
      { error: { code: 'signup_failed', message: error.message } },
      400,
    );
  }
  if (!data.user || !data.session) {
    // Email confirmation required by the project's Auth settings.
    return c.json(
      {
        pending_verification: true,
        message: 'user created but pending email verification; account is not created until verification completes',
      },
      202,
    );
  }

  // The user has a session now. Call the RPC via THEIR client so auth.uid()
  // inside the function returns the new user_id and the audit triggers
  // attribute the inserts correctly. One Postgres transaction, no orphan
  // account possible.
  const userClient = getUserClient(data.session.access_token);
  const { data: rpcData, error: rpcError } = await userClient.rpc(
    'create_account_for_new_user',
    {
      p_account_name: body.data.account_name,
      p_display_name: body.data.email,
    },
  );
  if (rpcError) {
    return c.json(
      {
        error: {
          code: 'account_init_failed',
          message: rpcError.message,
        },
      },
      500,
    );
  }
  // RPC returns a setof; supabase-js gives us an array.
  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  if (!row?.account_id) {
    return c.json(
      {
        error: {
          code: 'account_init_failed',
          message: 'RPC returned no account row',
        },
      },
      500,
    );
  }

  return c.json({
    user: { id: data.user.id, email: data.user.email },
    account: { id: row.account_id, role: row.role },
    session: data.session,
  });
});

auth.post('/auth/login', async (c) => {
  const body = LoginSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) {
    return badRequest('invalid login body', body.error.flatten());
  }
  const anon = getAnonClient();
  const { data, error } = await anon.auth.signInWithPassword(body.data);
  if (error) {
    return c.json(
      { error: { code: 'invalid_credentials', message: error.message } },
      401,
    );
  }
  return c.json({
    user: data.user ? { id: data.user.id, email: data.user.email } : null,
    session: data.session,
  });
});

auth.post('/auth/refresh', async (c) => {
  const body = RefreshSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) {
    return badRequest('invalid refresh body', body.error.flatten());
  }
  const anon = getAnonClient();
  const { data, error } = await anon.auth.refreshSession({
    refresh_token: body.data.refresh_token,
  });
  if (error) {
    return c.json(
      { error: { code: 'refresh_failed', message: error.message } },
      401,
    );
  }
  return c.json({ session: data.session });
});

auth.post('/auth/logout', async (c) => {
  // Real revocation. supabase-js's signOut() requires a persisted session
  // (it manages cookies), which is wrong for a stateless API. Call the
  // GoTrue REST endpoint directly with the caller's Bearer token; that
  // invalidates the refresh token according to the requested scope.
  //
  // Why this matters: an access token has a 1-hour expiry by default. A
  // logout that only drops the access token leaves the long-lived refresh
  // token active and usable from anywhere it was previously stored. For
  // shared devices and removed-employee scenarios that's a real gap.
  const env = loadEnv();
  const body = LogoutSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) {
    return badRequest('invalid logout body', body.error.flatten());
  }
  const header = c.req.header('authorization') ?? '';
  if (!/^bearer\s+/i.test(header)) {
    // No token -> nothing to revoke. Idempotent acknowledgement.
    return c.body(null, 204);
  }
  const token = header.replace(/^bearer\s+/i, '').trim();

  const url = `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/logout?scope=${body.data.scope}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_ANON_KEY,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    return c.json(
      { error: { code: 'logout_failed', message } },
      502,
    );
  }
  if (res.status === 204) return c.body(null, 204);
  if (res.status === 401) {
    return c.json(
      { error: { code: 'unauthenticated', message: 'token invalid or already revoked' } },
      401,
    );
  }
  const detail = await res.text().catch(() => '');
  return c.json(
    { error: { code: 'logout_failed', message: detail || `GoTrue returned ${res.status}` } },
    502,
  );
});

export default auth;
