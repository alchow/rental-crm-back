import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, dbError, errorResponses } from './_lib/error';

// Narrow account-settings surface for auto_charge_enabled (ADR-0011), which
// defaults true and serves primarily as opt-out. Reads are member-wide; RLS and
// a column-level grant restrict writes to owner/manager and this field only.
// Both use the caller JWT, and PATCH inherits the shared idempotency contract.

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});

const AccountSettings = z
  .object({
    auto_charge_enabled: z.boolean(),
  })
  .openapi('AccountSettings');

// auto_charge_enabled is the ONLY writable field. The RLS policy cannot
// restrict an UPDATE to a single column, so the column allow-list is enforced
// HERE: this body admits nothing else.
const PatchAccountSettingsBody = z
  .object({
    auto_charge_enabled: z.boolean(),
  })
  .openapi('PatchAccountSettingsBody');

const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/settings',
  tags: ['settings'],
  summary: 'Read this account’s settings (auto_charge_enabled)',
  request: { params: AccountParam },
  responses: {
    200: { description: 'settings', content: { 'application/json': { schema: AccountSettings } } },
    ...errorResponses,
  },
});

const patch = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/settings',
  tags: ['settings'],
  summary:
    'Update this account’s settings. Owner/manager only (RLS) — toggles ' +
    'account-wide automatic rent charging.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: PatchAccountSettingsBody } }, required: true },
  },
  responses: {
    200: { description: 'updated', content: { 'application/json': { schema: AccountSettings } } },
    ...errorResponses,
  },
});

export const settingsApp = newApiApp();

settingsApp.openapi(get, async (c) => {
  const { accountId } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('accounts')
    .select('auto_charge_enabled')
    .eq('id', accountId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'account not found');
  return c.json(
    { auto_charge_enabled: (data as { auto_charge_enabled: boolean }).auto_charge_enabled },
    200,
  );
});

settingsApp.openapi(patch, async (c) => {
  const { accountId } = c.req.valid('param');
  const { auto_charge_enabled } = c.req.valid('json');
  const sb = getSb(c);
  // Writes the ONLY writable field. Under the caller's JWT, the
  // accounts_manager_update RLS policy authorises the UPDATE only for
  // an owner/manager.
  const { data, error } = await sb
    .from('accounts')
    .update({ auto_charge_enabled })
    .eq('id', accountId)
    .is('deleted_at', null)
    .select('auto_charge_enabled')
    .maybeSingle();
  if (error) throw dbError(error);
  // A viewer passes the account-membership middleware (they ARE a member and
  // can SELECT the account) but the UPDATE's USING clause filters their row
  // out, so RETURNING is empty and PostgREST returns null with NO error. That
  // is the only way a member reaches a null here — map it to 403.
  if (!data) {
    throw new ApiError(403, 'forbidden', 'only an account owner or manager may change settings');
  }
  return c.json(
    { auto_charge_enabled: (data as { auto_charge_enabled: boolean }).auto_charge_enabled },
    200,
  );
});
