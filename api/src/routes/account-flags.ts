import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, dbError, errorResponses } from './_lib/error';

// ---------------------------------------------------------------------------
// Per-account control flags (MT-3 ask 2).
//
// GET   /accounts/{accountId}/account-flags   read flags (ANY member, incl. the
//                                             agent principal -- this is the
//                                             agent's authoritative legal_hold
//                                             read for its retention purge).
// PATCH /accounts/{accountId}/account-flags   update flags (owner/manager only).
//
// The response is an OBJECT, not a bare boolean, so new flags (retention_days,
// purge_enabled, ...) can land without a new endpoint or a breaking change --
// clients bind to the field. The authoritative row lives in core
// (account_settings) precisely so legal_hold survives an agent-DB wipe; the
// agent never writes it.
// ---------------------------------------------------------------------------

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});

const AccountFlags = z
  .object({
    legal_hold: z.boolean().openapi({
      description:
        'Litigation hold. When true, retention purges (e.g. the agent transcript ' +
        'purge) must delete NOTHING for this account. Authoritative in core so it ' +
        'survives an agent-side database wipe.',
    }),
  })
  .openapi('AccountFlags');

const UpdateAccountFlagsBody = z
  .object({
    legal_hold: z.boolean().optional(),
  })
  .openapi('UpdateAccountFlagsBody');

// Selected columns mirror the AccountFlags shape; one constant so GET and PATCH
// never drift.
const FLAG_COLS = 'legal_hold';

const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/account-flags',
  tags: ['account-flags'],
  summary: 'Read per-account control flags (any member, including the agent principal)',
  request: { params: AccountParam },
  responses: {
    200: { description: 'flags', content: { 'application/json': { schema: AccountFlags } } },
    ...errorResponses,
  },
});

const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/account-flags',
  tags: ['account-flags'],
  summary: 'Update per-account control flags (owner/manager only)',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: UpdateAccountFlagsBody } }, required: true },
  },
  responses: {
    200: { description: 'updated flags', content: { 'application/json': { schema: AccountFlags } } },
    ...errorResponses,
  },
});

export const accountFlagsApp = newApiApp();

accountFlagsApp.openapi(get, async (c) => {
  const { accountId } = c.req.valid('param');
  const sb = getSb(c);
  // The 1:1 row is auto-provisioned per account (DB trigger), so a member
  // always finds it. Treat an absent row as the fail-safe default (no hold):
  // the agent's purge already fails closed, and absence here can only mean the
  // RLS membership gate didn't match -- which the middleware already enforced.
  const { data, error } = await sb
    .from('account_settings')
    .select(FLAG_COLS)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  const legalHold = (data?.legal_hold as boolean | undefined) ?? false;
  return c.json({ legal_hold: legalHold }, 200);
});

accountFlagsApp.openapi(patch, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only an owner or manager may change account flags');
  }
  const sb = getSb(c);

  // updated_at is set explicitly on every write (project convention: no
  // generic updated_at trigger). Only provided flags are touched.
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.legal_hold !== undefined) update.legal_hold = body.legal_hold;

  const { data, error } = await sb
    .from('account_settings')
    .update(update)
    .eq('account_id', accountId)
    .select(FLAG_COLS)
    .maybeSingle();
  // RLS denies a non-owner/manager UPDATE as 42501 -> 403 (defensive: the role
  // check above already returns 403; this covers a just-changed role inside the
  // membership-cache window). Idempotency middleware claims the key first.
  if (error) throw dbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'account settings not found');
  return c.json({ legal_hold: data.legal_hold as boolean }, 200);
});
