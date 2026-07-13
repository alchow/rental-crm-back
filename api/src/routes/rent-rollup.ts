import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { TenancyStatus } from '../schemas/importable';

// GET /v1/accounts/{accountId}/rent-rollup
//
// One row per tenancy in the requested statuses (default active+holdover).
// Ended tenancies with a remaining money signal are available by explicitly
// including `ended`, preserving the original default contract. Replaces the
// client-side one-GET-/ledger-per-tenancy fan-out (Field Log ask #4).
//
// The heavy lifting is the SECURITY INVOKER SQL function rent_rollup()
// (migration 20260715000001), which mirrors the per-tenancy ledger's
// aggregation rules EXACTLY — see the semantics contract in the migration
// header and the parity test in api/test/rent-rollup.test.ts (rollup must
// equal GET /ledger for every tenancy). Balances stay derived-on-read.
//
// No pagination: the response is bounded by the account's current-tenancy
// count (a DIY-landlord portfolio — tens to low hundreds of rows). Revisit
// with a cursor if an account ever approaches ~1k current tenancies.

const RentRollupRow = z
  .object({
    tenancy_id: z.string().uuid(),
    status: TenancyStatus,
    currency: z.string().nullable().openapi({
      description: 'Read off the money rows; null when the tenancy has no charges or payments.',
    }),
    rent_balance_cents: z
      .number()
      .int()
      .openapi({
        description:
          "All NON-DEPOSIT charge types minus their active allocations — matches the ledger's " +
          'legacy totals.rent_balance_cents (see totals.by_type there for a per-type split).',
      }),
    deposit_balance_cents: z.number().int(),
    unapplied_credit_cents: z.number().int(),
    non_deposit_overdue_cents: z.number().int().openapi({
      description: 'Current open non-deposit balance on charges due before as_of.',
    }),
    non_deposit_due_today_cents: z.number().int().openapi({
      description: 'Current open non-deposit balance on charges due on as_of.',
    }),
    non_deposit_upcoming_cents: z.number().int().openapi({
      description: 'Current open non-deposit balance on billed charges due after as_of.',
    }),
    deposit_owed_cents: z.number().int().openapi({
      description: 'Current open balance on live deposit charges.',
    }),
    deposit_held_cents: z.number().int().openapi({
      description: 'Active payment allocations held against live deposit charges.',
    }),
  })
  .openapi('RentRollupRow');

const RentRollupResponse = z
  .object({
    as_of: z.string().openapi({
      description: 'UTC date used to classify overdue, due-today, and upcoming balances.',
    }),
    data: z.array(RentRollupRow),
  })
  .openapi('RentRollupResponse');

const AccountParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
});

const RollupQuery = z.object({
  status: z
    .string()
    .optional()
    .openapi({
      description:
        'Status or comma-separated statuses to include. Allowed values: upcoming, active, ' +
        "ended, holdover. Defaults to 'active,holdover'; ended zero-money rows are omitted " +
        'whenever ended is requested.',
      example: 'active,holdover,ended',
    }),
  as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .openapi({
      description:
        'Classification date for current open balances. Defaults to the current UTC date; ' +
        'this is not a historical ledger snapshot.',
    }),
});

const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/rent-rollup',
  tags: ['ledger'],
  summary: 'Account-wide per-tenancy balances (rent / deposit / unapplied credit)',
  description:
    'One row per tenancy in the requested statuses (default active,holdover). Include ended ' +
    'to add past tenancies with money still owed, unapplied credit, or a held deposit. Derived on ' +
    'read — recomputed from charges + payments + allocations with exactly the per-tenancy ' +
    "ledger's rules; rent_balance_cents matches the ledger's legacy all-non-deposit " +
    'semantics. Precise current open-balance buckets are classified against ?as_of ' +
    '(default current UTC date). Not paginated: bounded by the account’s tenancy count.',
  request: { params: AccountParam, query: RollupQuery },
  responses: {
    200: {
      description: 'rollup',
      content: { 'application/json': { schema: RentRollupResponse } },
    },
    ...errorResponses,
  },
});

export const rentRollupApp = newApiApp();

rentRollupApp.openapi(get, async (c) => {
  const { accountId } = c.req.valid('param');
  const { status, as_of } = c.req.valid('query');
  const asOf = as_of ?? new Date().toISOString().slice(0, 10);

  // Comma-separated status list, validated against the tenancy vocabulary.
  // (Same parse shape as search.ts's kinds param; PR 6's shared csv-enum
  // helper should absorb this when it lands.)
  let statuses: string[] | undefined;
  if (status !== undefined) {
    const values = [
      ...new Set(
        status
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ];
    const bad = values.filter((v) => !(TenancyStatus.options as readonly string[]).includes(v));
    if (bad.length > 0 || values.length === 0) {
      throw new ApiError(
        400,
        'invalid_request',
        `unknown status value(s): ${bad.join(', ') || '(empty)'}`,
        { fieldErrors: { status: bad.length > 0 ? bad : ['empty'] } },
      );
    }
    statuses = values;
  }

  const sb = getSb(c);
  const { data, error } = await sb.rpc('rent_rollup', {
    p_account_id: accountId,
    p_statuses: statuses ?? ['active', 'holdover'],
    p_as_of: asOf,
  });
  if (error) throw new ApiError(500, 'database_error', error.message);

  return c.json({ as_of: asOf, data: (data ?? []) as z.infer<typeof RentRollupRow>[] }, 200);
});
