import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import type { DbFunctionArgs } from '../supabase/db-types';
import { ApiError, errorResponses, schemaCacheMiss, type ErrorCode } from './_lib/error';
import { CurrencyCode, GraceDays, LateFeeCents } from '../schemas/importable';

// Tenancy adoption (ADR-0013): the atomic commit behind the Field Log
// "adopt mid-tenancy" wizard. One request creates the rent schedule, the
// backfilled charges, the payments with the landlord's proposed matching,
// an optional held deposit, and the adoption record — all in one DB
// transaction via adopt_tenancy_history, so a failure can never strand
// half a ledger. The wizard keeps every draft client-side; this endpoint
// is the only persistence step.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PaymentMethod = z.enum([
  'cash',
  'check',
  'ach',
  'card',
  'zelle_venmo',
  'money_order',
  'other',
]);

const AdoptionAllocation = z.object({
  // 0-based index into `charges` — allocations name charges that do not
  // exist yet, so they cannot carry ids.
  charge_index: z.number().int().min(0),
  amount_cents: z.number().int().positive(),
});

const AdoptionCharge = z.object({
  amount_cents: z.number().int().positive(),
  due_date: z.string().regex(DATE_RE),
  period_start: z.string().regex(DATE_RE).optional(),
  period_end: z.string().regex(DATE_RE).optional(),
  description: z.string().min(1).max(500).optional(),
});

const AdoptionPayment = z.object({
  amount_cents: z.number().int().positive(),
  // The landlord's asserted receipt date. The row's created_at will be now —
  // that gap IS the backfill provenance the statement renders.
  received_at: z.string(),
  method: PaymentMethod,
  reference: z.string().min(1).max(200).optional(),
  notes: z.string().min(1).max(2000).optional(),
  allocations: z.array(AdoptionAllocation).max(24).default([]),
});

const AdoptionDeposit = z.object({
  amount_cents: z.number().int().positive(),
  received_on: z.string().regex(DATE_RE),
  method: PaymentMethod.optional().openapi({ description: "Defaults to 'other'." }),
});

const AdoptionBody = z
  .object({
    adoption_date: z.string().regex(DATE_RE).openapi({
      description:
        'The day tracking begins. Every backfilled date must be on or before it; ' +
        "it drives the statement's tracking-since divider.",
    }),
    currency: CurrencyCode,
    rent: z.object({
      amount_cents: z.number().int().min(0),
      due_day: z.number().int().min(1).max(28),
      start_date: z.string().regex(DATE_RE),
      grace_days: GraceDays.optional(),
      late_fee_cents: LateFeeCents.optional(),
    }),
    charges: z.array(AdoptionCharge).max(120).default([]),
    payments: z.array(AdoptionPayment).max(200).default([]),
    deposit: AdoptionDeposit.optional(),
    opening_balance_cents: z.number().int().default(0).openapi({
      description:
        'Signed: > 0 the tenant owed money at adoption, < 0 the tenant held a credit. ' +
        'A recorded fact, not a charge — it can never take a late fee and is never ' +
        'part of payment-dated income exports. Mutually exclusive with itemized ' +
        'charges/payments.',
    }),
    balance_basis: z.string().min(1).max(200).optional(),
    needs_review: z.boolean().default(false),
  })
  .superRefine((body, ctx) => {
    if (body.opening_balance_cents !== 0 && (body.charges.length > 0 || body.payments.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an opening balance and itemized charges/payments are mutually exclusive',
        path: ['opening_balance_cents'],
      });
    }
    // The generator dedupes on (source_schedule_id, period_start); two
    // backfilled charges sharing a period would 23505 mid-transaction.
    const seenPeriods = new Set<string>();
    body.charges.forEach((charge, i) => {
      if ((charge.period_start === undefined) !== (charge.period_end === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'period_start and period_end must be provided together',
          path: ['charges', i],
        });
      }
      if (charge.period_start !== undefined) {
        if (seenPeriods.has(charge.period_start)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate period_start ${charge.period_start}`,
            path: ['charges', i, 'period_start'],
          });
        }
        seenPeriods.add(charge.period_start);
      }
    });
    body.payments.forEach((payment, i) => {
      let total = 0;
      for (const alloc of payment.allocations) {
        if (alloc.charge_index >= body.charges.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `charge_index ${alloc.charge_index} is out of range`,
            path: ['payments', i, 'allocations'],
          });
        }
        total += alloc.amount_cents;
      }
      if (total > payment.amount_cents) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'allocations exceed their payment amount',
          path: ['payments', i, 'allocations'],
        });
      }
    });
  })
  .openapi('AdoptionBody');

const AdoptionResult = z
  .object({
    adoption_id: z.string().uuid(),
    schedule_id: z.string().uuid(),
    // Same order as the request's `charges` array, so the client can map its
    // wizard rows onto the created ledger without re-deriving the matching.
    charge_ids: z.array(z.string().uuid()),
    // Request order; when a deposit was included, its payment id is last.
    payment_ids: z.array(z.string().uuid()),
    deposit_charge_id: z.string().uuid().nullable(),
  })
  .openapi('AdoptionResult');

const TenancyParam = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'tenancyId', in: 'path' } }),
});

const adopt = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/adoption',
  tags: ['adoption'],
  summary: 'Adopt an existing tenancy: atomic historical backfill or opening balance',
  description:
    'One transaction creates the rent schedule, backfilled rent charges, payments ' +
    'with caller-proposed allocations, an optional held deposit, and the adoption ' +
    'record. Requires a virgin money timeline (no live schedule, no non-voided ' +
    'charge/payment, no prior adoption) and owner/manager membership. ' +
    'The generator never backfills; this endpoint is how a past-start tenancy gets ' +
    'its history. See ADR-0013.',
  request: {
    params: TenancyParam,
    body: { content: { 'application/json': { schema: AdoptionBody } }, required: true },
  },
  responses: {
    201: { description: 'adopted', content: { 'application/json': { schema: AdoptionResult } } },
    ...errorResponses,
  },
});

export const adoptionApp = newApiApp();

adoptionApp.openapi(adopt, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // Only forward optionals the caller supplied so the SQL DEFAULTs apply.
  const params: DbFunctionArgs<'adopt_tenancy_history'> = {
    p_account_id: accountId,
    p_tenancy_id: tenancyId,
    p_adoption_date: body.adoption_date,
    p_currency: body.currency,
    p_rent_amount_cents: body.rent.amount_cents,
    p_due_day: body.rent.due_day,
    p_schedule_start_date: body.rent.start_date,
    p_charges: body.charges,
    p_payments: body.payments,
    p_opening_balance_cents: body.opening_balance_cents,
    p_needs_review: body.needs_review,
  };
  // GraceDays/LateFeeCents are nullable in the shared schema (PATCH uses null
  // to clear); for a first schedule null and omitted both mean "not set".
  if (typeof body.rent.grace_days === 'number') params.p_grace_days = body.rent.grace_days;
  if (typeof body.rent.late_fee_cents === 'number') params.p_late_fee_cents = body.rent.late_fee_cents;
  if (body.deposit !== undefined) params.p_deposit = body.deposit;
  if (body.balance_basis !== undefined) params.p_balance_basis = body.balance_basis;

  const { data, error } = await sb.rpc('adopt_tenancy_history', params);
  if (error) {
    const pending = schemaCacheMiss(error);
    if (pending) throw pending;
    // adopt_tenancy_history RAISEs with the stable prefixes
    // (not_found:/conflict:/invalid:); the prefix is stripped for the client.
    const msg = error.message ?? '';
    if (msg.startsWith('not_found:')) {
      throw new ApiError(404, 'not_found', msg.slice('not_found:'.length).trim());
    }
    if (msg.startsWith('conflict:')) {
      const detail = msg.slice('conflict:'.length).trim();
      // Fine-grained 409 codes (branch-on-code-never-message); test:adoption
      // pins each pairing so a reworded RAISE fails loudly there.
      const code: ErrorCode = /already adopted/i.test(detail)
        ? 'already_adopted'
        : /already has a rent schedule/i.test(detail)
          ? 'schedule_exists'
          : /already has ledger activity/i.test(detail)
            ? 'tenancy_has_money'
            : /tenancy already ended/i.test(detail)
              ? 'tenancy_ended'
              : 'conflict';
      throw new ApiError(409, code, detail);
    }
    if (msg.startsWith('invalid:')) {
      throw new ApiError(400, 'invalid_request', msg.slice('invalid:'.length).trim());
    }
    if (error.code === '23514') throw new ApiError(400, 'invalid_request', msg);
    if (error.code === '23505') throw new ApiError(409, 'conflict', msg);
    // RLS veto on the tenancy_adoptions insert (writes are owner/manager at
    // the DB). It fires LAST in the transaction, so everything else the
    // adoption wrote rolls back with it.
    if (error.code === '42501') {
      throw new ApiError(403, 'forbidden', 'adoption requires owner or manager membership');
    }
    throw new ApiError(500, 'database_error', msg);
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        o_adoption_id: string;
        o_schedule_id: string;
        o_charge_ids: string[] | null;
        o_payment_ids: string[] | null;
        o_deposit_charge_id: string | null;
      }
    | null
    | undefined;
  if (!row) throw new ApiError(500, 'database_error', 'adopt_tenancy_history returned no row');

  return c.json(
    {
      adoption_id: row.o_adoption_id,
      schedule_id: row.o_schedule_id,
      charge_ids: row.o_charge_ids ?? [],
      payment_ids: row.o_payment_ids ?? [],
      deposit_charge_id: row.o_deposit_charge_id ?? null,
    } satisfies z.infer<typeof AdoptionResult>,
    201,
  );
});
