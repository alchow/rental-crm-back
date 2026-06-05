import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { getUserClient } from '../supabase/user-client';

// GET /v1/me -- "who am I?" and "which accounts am I in?"
// The membership query goes through PostgREST under the caller's JWT, so
// RLS returns only the caller's own (non-deleted) memberships.
const me = new Hono();

me.get('/me', requireAuth(), async (c) => {
  const auth = c.get('auth');
  const sb = getUserClient(auth.accessToken);

  const { data, error } = await sb
    .from('account_members')
    .select('account_id, role')
    .is('deleted_at', null);

  if (error) {
    return c.json(
      { error: { code: 'database_error', message: error.message } },
      500,
    );
  }

  return c.json({
    user_id: auth.userId,
    email: auth.claims.email ?? null,
    accounts: data ?? [],
  });
});

export default me;
