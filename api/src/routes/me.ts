import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { requireAuth } from '../middleware/auth';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';

// GET /v1/me -- "who am I?" and "which accounts am I in?"
//
// Authenticated but NOT account-scoped: there is no accountId in the path
// (a fresh login has no account context yet -- this is how the client
// discovers it), and no Idempotency-Key (it's a read).
//
// Identity is read off the verified JWT (auth.uid()/auth.userId), never
// from a body or header -- the actor-integrity rule applies here too. The
// membership query runs through PostgREST under the caller's JWT, so RLS
// (account_members_self_select / accounts_member_select) restricts the
// result to the caller's own non-deleted rows; it is not possible for this
// to return another user's membership or another account's name.
//
// Phase 12: registered as a typed OpenAPIHono route (was a plain Hono
// route) so it actually lands in openapi.json and the generated SDK --
// previously the integration guide documented it but the spec didn't carry
// it, so clients had no typed way to call the only endpoint that resolves
// "which account do I scope to" after login.

const Membership = z
  .object({
    account_id: z.string().uuid(),
    account_name: z.string(),
    role: z.string(),
  })
  .openapi('Membership');

const MeResponse = z
  .object({
    user: z.object({ id: z.string().uuid(), email: z.string().nullable() }),
    memberships: z.array(Membership),
  })
  .openapi('MeResponse');

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['me'],
  summary: 'Identify the caller and list their account memberships',
  middleware: [requireAuth()] as const,
  responses: {
    200: { description: 'caller identity and memberships', content: { 'application/json': { schema: MeResponse } } },
    401: { description: 'unauthenticated', content: { 'application/json': { schema: errorResponses[400].content['application/json'].schema } } },
    ...errorResponses,
  },
});

const me = newApiApp();

me.openapi(meRoute, async (c) => {
  const auth = c.get('auth');
  const sb = getSb(c);

  const { data, error } = await sb
    .from('account_members')
    .select('account_id, role, accounts(name)')
    .is('deleted_at', null);

  if (error) throw new ApiError(500, 'database_error', error.message);

  type Row = { account_id: string; role: string; accounts: { name: string } | { name: string }[] | null };
  const memberships = ((data ?? []) as Row[]).map((row) => {
    const account = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
    return { account_id: row.account_id, account_name: account?.name ?? '', role: row.role };
  });

  // Deterministic order so the client's auto-select (first membership) is
  // stable across calls, regardless of insertion order.
  memberships.sort((a, b) => {
    const byName = a.account_name.localeCompare(b.account_name);
    return byName !== 0 ? byName : a.account_id.localeCompare(b.account_id);
  });

  return c.json(
    {
      user: { id: auth.userId, email: auth.claims.email ?? null },
      memberships,
    },
    200,
  );
});

export default me;
