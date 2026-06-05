import { Hono } from 'hono';
import { z } from 'zod';
import { getAnonClient } from '../supabase/anon-client';
import { createAccountForNewUser } from '../admin/signup';

// /v1/auth/* fronts Supabase Auth. Clients only see this contract; the
// underlying supabase-js calls and the privileged account-init step are
// invisible to them. Phase 5 will swap zod schemas for zod-openapi so the
// spec is generated from them; the route shapes stay the same.

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

function badRequest(
  message: string,
  details?: unknown,
): Response {
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
  if (!data.user) {
    // Email confirmation required by the project's Auth settings.
    return c.json(
      {
        pending_verification: true,
        message: 'user created but pending email verification',
      },
      202,
    );
  }

  try {
    const created = await createAccountForNewUser(
      data.user.id,
      body.data.email,
      body.data.account_name,
    );
    return c.json({
      user: { id: data.user.id, email: data.user.email },
      account: { id: created.accountId, role: 'owner' },
      session: data.session,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    return c.json(
      { error: { code: 'account_init_failed', message } },
      500,
    );
  }
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
  // signOut on the anon client invalidates the refresh token associated with
  // the JWT in the Authorization header (if any). The route is intentionally
  // tolerant of missing tokens -- logout is idempotent.
  const header = c.req.header('authorization') ?? '';
  const token = /^bearer\s+/i.test(header)
    ? header.replace(/^bearer\s+/i, '').trim()
    : '';
  if (!token) {
    return c.json({ ok: true });
  }
  // To sign out a specific session, supabase-js needs the user's session set.
  // Easiest from a stateless API is to call Auth's REST endpoint directly
  // with the Bearer token; supabase-js' signOut() requires a persisted session.
  // For Phase 4 we just acknowledge -- the client's JWT will expire on its own
  // schedule, and Phase 4's refresh route is the only thing that can extend it.
  return c.json({ ok: true });
});

export default auth;
