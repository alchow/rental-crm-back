import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { asJson } from '../supabase/db-types';
import { ApiError, conflictResponse, errorResponses } from './_lib/error';
import { requireManager } from './_lib/guards';
import { AccountAndTenancyParam } from './tenancies/schemas';
import { OwedSummary } from './owed';

// Correcting a mistyped starting balance: void and re-enter (ADR-0013 amendment).

const CorrectionBody = z
  .object({
    amount_cents: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .openapi({
        description: 'The corrected typed amount: positive owed, negative a credit, 0 nothing.',
      }),
    basis: z.string().trim().min(1).max(200).optional().openapi({
      description: 'What the amount is for; required unless the amount is 0.',
    }),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .openapi('OpeningBalanceCorrectionBody');

const Entry = z.object({
  kind: z.enum(['charge', 'credit', 'none']),
  id: z.string().uuid().nullable(),
});
const Correction = z
  .object({
    correction_id: z.string().uuid().optional().openapi({ description: 'Present after commit.' }),
    adoption_id: z.string().uuid(),
    currency: z.string(),
    previous: z.object({
      typed_cents: z.number().int(),
      opening_cents: z.number().int(),
      entry: Entry,
    }),
    next: z.object({
      typed_cents: z.number().int(),
      opening_cents: z.number().int().openapi({
        description: 'typed_cents plus earlier receipts answered add_to_owed.',
      }),
      added_receipts_cents: z.number().int(),
      entry: Entry,
    }),
    allocations: z.array(
      z.object({
        allocation_id: z.string().uuid(),
        payment_id: z.string().uuid(),
        charge_id: z.string().uuid(),
        amount_cents: z.number().int(),
        moved_cents: z
          .number()
          .int()
          .openapi({ description: 'Re-applied to the new opening entry.' }),
        released_cents: z.number().int().openapi({
          description:
            'No longer applied: unapplied credit on the payment, or owed again on the charge.',
        }),
      }),
    ),
    owed_before: OwedSummary.nullable(),
    owed_after: OwedSummary.nullable(),
  })
  .openapi('OpeningBalanceCorrection');

const responses = {
  ...errorResponses,
  ...conflictResponse,
};
const preview = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/opening-balance/correction/preview',
  tags: ['ledger'],
  summary: 'Show what correcting the starting balance would change, without writing it',
  description:
    '409 opening_ledger_disabled when the starting-balance ledger is off; 409 opening_not_in_ledger for a non-zero starting balance with no live ledger entry (legacy, or voided by hand); 409 opening_entry_deleted when the live entry was deleted; 400 opening_unchanged when the amount is the same. A starting amount of 0 has no entry and can be corrected.',
  request: {
    params: AccountAndTenancyParam,
    body: { required: true, content: { 'application/json': { schema: CorrectionBody } } },
  },
  responses: {
    200: {
      description: 'Before and after',
      content: { 'application/json': { schema: Correction } },
    },
    ...responses,
  },
});
const commit = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/opening-balance/correction',
  tags: ['ledger'],
  summary: 'Void the starting balance entry and re-enter it at the corrected amount',
  request: {
    params: AccountAndTenancyParam,
    body: { required: true, content: { 'application/json': { schema: CorrectionBody } } },
  },
  responses: {
    200: {
      description: 'Correction recorded',
      content: { 'application/json': { schema: Correction } },
    },
    ...responses,
  },
});

function correctionError(error: { code?: string; message?: string }): never {
  const message = error.message ?? 'correction failed';
  if (error.code === 'P0002')
    throw new ApiError(404, 'not_found', 'No starting balance for this tenancy.');
  if (message === 'conflict: opening_ledger_disabled')
    throw new ApiError(
      409,
      'opening_ledger_disabled',
      'The starting-balance ledger is off for this account.',
    );
  if (message === 'conflict: opening_not_in_ledger')
    throw new ApiError(
      409,
      'opening_not_in_ledger',
      'This starting balance was never recorded in the ledger.',
    );
  if (message === 'conflict: opening_entry_deleted')
    throw new ApiError(
      409,
      'opening_entry_deleted',
      'The starting balance entry was deleted from the ledger; restore or void it first.',
    );
  if (message === 'invalid: opening_unchanged')
    throw new ApiError(
      400,
      'opening_unchanged',
      'The corrected amount is the same as the current one.',
    );
  if (message.startsWith('invalid:') || ['22023', '23514', '22P02'].includes(error.code ?? ''))
    throw new ApiError(400, 'invalid_request', message);
  throw new ApiError(500, 'database_error', message);
}

export const openingCorrectionApp = newApiApp();
openingCorrectionApp.openapi(preview, async (c) => {
  requireManager(c);
  const { accountId, tenancyId } = c.req.valid('param');
  const { data, error } = await getSb(c).rpc('preview_opening_balance_correction', {
    p_account_id: accountId,
    p_tenancy_id: tenancyId,
    p_payload: asJson(c.req.valid('json')),
  });
  if (error) correctionError(error);
  return c.json(data as unknown as z.infer<typeof Correction>, 200);
});
openingCorrectionApp.openapi(commit, async (c) => {
  requireManager(c);
  const { accountId, tenancyId } = c.req.valid('param');
  const claim = c.get('idempotencyClaim');
  if (!claim) throw new ApiError(500, 'database_error', 'Idempotency claim unavailable');
  const { data, error } = await getSb(c).rpc('correct_opening_balance', {
    p_account_id: accountId,
    p_tenancy_id: tenancyId,
    p_payload: asJson(c.req.valid('json')),
    p_idempotency_key: claim.key,
    p_request_fingerprint: claim.fingerprint,
  });
  if (error) correctionError(error);
  c.set('idempotencyCompletedAtomically', true);
  return c.json(data as unknown as z.infer<typeof Correction>, 200);
});
