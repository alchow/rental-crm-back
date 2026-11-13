import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, dbError, errorResponses } from './_lib/error';
import { TimeZoneName } from '../schemas/time-zone';

// Narrow account-settings surface for auto_charge_enabled (ADR-0011), which
// defaults true and serves primarily as opt-out. Reads are member-wide; RLS and
// a column-level grant restrict writes to owner/manager and this field only.
// Both use the caller JWT, and PATCH inherits the shared idempotency contract.

const AccountParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
});

const AccountSettings = z
  .object({
    auto_charge_enabled: z.boolean(),
    person_match_enabled: z.boolean().optional(),
    opening_balance_ledger_enabled: z.boolean().optional(),
    scheduled_move_out_enabled: z.boolean().optional(),
    wizard_v2_enabled: z.boolean().optional().openapi({
      description:
        'Read-only rollout flag: show the new setup wizard. Both setup payloads are accepted either way.',
    }),
    time_zone: z.string().optional().openapi({
      description:
        'IANA time zone. "Today" everywhere (status, rent generation, overdue, date warnings) is the date here.',
      example: 'America/Los_Angeles',
    }),
    proration_method: z.enum(['actual_days', 'thirty_day_month']).optional(),
    currency: z.string().optional().openapi({ description: 'ISO 4217 code money defaults to.' }),
    multi_currency: z.boolean().optional().openapi({
      description: 'False: show no currency control or code; setup refuses other currencies.',
    }),
  })
  .openapi('AccountSettings');

// auto_charge_enabled, proration_method, currency, multi_currency and time_zone are the ONLY writable fields. The RLS policy cannot
// restrict an UPDATE to a single column, so the column allow-list is enforced
// HERE: this body admits nothing else.
const PatchAccountSettingsBody = z
  .object({
    auto_charge_enabled: z.boolean().optional(),
    proration_method: z.enum(['actual_days', 'thirty_day_month']).optional(),
    currency: z
      .string()
      .refine((code) => Intl.supportedValuesOf('currency').includes(code), 'currency.unsupported')
      .optional(),
    multi_currency: z.boolean().optional(),
    time_zone: TimeZoneName.optional().openapi({
      description:
        'IANA time zone name PostgreSQL accepts (pg_timezone_names), e.g. America/Los_Angeles.',
    }),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Send at least one setting.')
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
    'Update this account’s settings. Owner/manager only (RLS) — automatic rent ' +
    'charging, proration, currency and the time zone that decides "today".',
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
    .select('*')
    .eq('id', accountId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'account not found');
  return c.json(
    {
      auto_charge_enabled: data.auto_charge_enabled,
      person_match_enabled: data.person_match_enabled,
      opening_balance_ledger_enabled: data.opening_balance_ledger_enabled,
      scheduled_move_out_enabled: data.scheduled_move_out_enabled,
      wizard_v2_enabled: data.wizard_v2_enabled,
      time_zone: data.time_zone,
      proration_method: data.proration_method as 'actual_days' | 'thirty_day_month',
      currency: data.currency,
      multi_currency: data.multi_currency,
    },
    200,
  );
});

settingsApp.openapi(patch, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  // Writes only the allow-listed fields. Under the caller's JWT, the
  // accounts_manager_update RLS policy authorises the UPDATE only for
  // an owner/manager.
  const { data, error } = await sb
    .from('accounts')
    .update(body)
    .eq('id', accountId)
    .is('deleted_at', null)
    .select('auto_charge_enabled, proration_method, currency, multi_currency, time_zone')
    .maybeSingle();
  // accounts_validate_time_zone refuses a zone missing from pg_timezone_names.
  if (error?.code === '22023' && /time zone/i.test(error.message)) {
    throw new ApiError(400, 'invalid_request', 'Choose an IANA time zone', {
      fieldErrors: { time_zone: ['Choose an IANA time zone'] },
    });
  }
  if (error) throw dbError(error);
  // A viewer passes the account-membership middleware (they ARE a member and
  // can SELECT the account) but the UPDATE's USING clause filters their row
  // out, so RETURNING is empty and PostgREST returns null with NO error. That
  // is the only way a member reaches a null here — map it to 403.
  if (!data) {
    throw new ApiError(403, 'forbidden', 'only an account owner or manager may change settings');
  }
  return c.json(
    {
      auto_charge_enabled: data.auto_charge_enabled,
      proration_method: data.proration_method as 'actual_days' | 'thirty_day_month',
      currency: data.currency,
      multi_currency: data.multi_currency,
      time_zone: data.time_zone,
    },
    200,
  );
});
