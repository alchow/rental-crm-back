import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getUserClient } from '../supabase/user-client';
import { ApiError, errorResponses } from './_lib/error';

// GET /v1/accounts/{accountId}/tenancies/{tenancyId}/ledger
//
// Derived ledger for a tenancy. BALANCE IS NEVER STORED -- the response
// recomputes it from charges + payments + allocations every time. That's
// the rule the brief calls out: a stored balance is a lie waiting to drift
// from the source rows.
//
// Computation rules:
//   - Voided charges and voided payments are IGNORED in totals (their
//     allocations are too).
//   - DEPOSITS (charges with type = 'deposit') are tracked separately and
//     do NOT count against the rent balance. A deposit payment goes
//     specifically into the deposit subledger via the operator allocating
//     it to the deposit charge.
//   - Money is integer minor units throughout. The currency is read off the
//     rows (we don't model multi-currency arithmetic; tenancies are
//     expected to be single-currency in practice).
//
// Response shape (per response below):
//   {
//     tenancy_id, currency,
//     entries: [ {kind: 'charge'|'payment', id, occurred_at, ...row, derived: {...}} ],
//     totals: {
//       rent_charges_cents, rent_payments_cents, rent_balance_cents,
//       deposit_charges_cents, deposit_payments_cents, deposit_balance_cents,
//     },
//   }

const LedgerCharge = z.object({
  kind: z.literal('charge'),
  id: z.string().uuid(),
  occurred_at: z.string(),
  type: z.string(),
  amount_cents: z.number().int(),
  voided_at: z.string().nullable(),
  void_reason: z.string().nullable(),
  description: z.string().nullable(),
  derived_balance_cents: z.number().int(),
  is_deposit: z.boolean(),
});
const LedgerPayment = z.object({
  kind: z.literal('payment'),
  id: z.string().uuid(),
  occurred_at: z.string(),
  amount_cents: z.number().int(),
  method: z.string(),
  reference: z.string().nullable(),
  voided_at: z.string().nullable(),
  void_reason: z.string().nullable(),
  allocations: z.array(
    z.object({
      charge_id: z.string().uuid(),
      amount_cents: z.number().int(),
    }),
  ),
});
const LedgerEntry = z.union([LedgerCharge, LedgerPayment]);

const LedgerResponse = z
  .object({
    tenancy_id: z.string().uuid(),
    currency: z.string().nullable(),
    entries: z.array(LedgerEntry),
    totals: z.object({
      rent_charges_cents:     z.number().int(),
      rent_payments_cents:    z.number().int(),
      rent_balance_cents:     z.number().int(),
      deposit_charges_cents:  z.number().int(),
      deposit_payments_cents: z.number().int(),
      deposit_balance_cents:  z.number().int(),
    }),
  })
  .openapi('LedgerResponse');

const TenancyParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z.string().uuid().openapi({ param: { name: 'tenancyId', in: 'path' } }),
});

const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/ledger',
  tags: ['ledger'],
  summary: 'Per-tenancy ledger: charges + payments + allocations + derived balances',
  request: { params: TenancyParam },
  responses: {
    200: { description: 'ledger', content: { 'application/json': { schema: LedgerResponse } } },
    ...errorResponses,
  },
});

export const ledgerApp = new OpenAPIHono();

interface ChargeRow {
  id: string;
  account_id: string;
  tenancy_id: string;
  type: string;
  amount_cents: number;
  currency: string;
  due_date: string;
  description: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}
interface PaymentRow {
  id: string;
  account_id: string;
  tenancy_id: string;
  amount_cents: number;
  currency: string;
  received_at: string;
  method: string;
  reference: string | null;
  voided_at: string | null;
  void_reason: string | null;
}
interface AllocationRow {
  id: string;
  account_id: string;
  payment_id: string;
  charge_id: string;
  amount_cents: number;
}

ledgerApp.openapi(get, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const sb = getUserClient(c.get('auth').accessToken);

  const [charges, payments, allocations] = await Promise.all([
    sb.from('charges').select('*').eq('account_id', accountId).eq('tenancy_id', tenancyId).is('deleted_at', null),
    sb.from('payments').select('*').eq('account_id', accountId).eq('tenancy_id', tenancyId).is('deleted_at', null),
    sb.from('payment_allocations').select('*').eq('account_id', accountId).is('deleted_at', null),
  ]);

  if (charges.error) throw new ApiError(500, 'database_error', charges.error.message);
  if (payments.error) throw new ApiError(500, 'database_error', payments.error.message);
  if (allocations.error) throw new ApiError(500, 'database_error', allocations.error.message);

  const chargeRows = (charges.data ?? []) as ChargeRow[];
  const paymentRows = (payments.data ?? []) as PaymentRow[];
  const allRows = (allocations.data ?? []) as AllocationRow[];
  // Allocations are fetched account-wide above; narrow to ones tied to a
  // payment / charge in THIS tenancy.
  const chargeIds = new Set(chargeRows.map((c) => c.id));
  const paymentIds = new Set(paymentRows.map((p) => p.id));
  const tenancyAllocations = allRows.filter(
    (a) => chargeIds.has(a.charge_id) && paymentIds.has(a.payment_id),
  );

  // Index voided rows so we can exclude their allocations from the balance.
  const voidedPayments = new Set(
    paymentRows.filter((p) => p.voided_at !== null).map((p) => p.id),
  );
  const voidedCharges = new Set(
    chargeRows.filter((c) => c.voided_at !== null).map((c) => c.id),
  );

  // Per-charge derived balance.
  // active allocation = allocation row whose payment AND charge are both not voided.
  const allocByCharge = new Map<string, number>();
  for (const a of tenancyAllocations) {
    if (voidedPayments.has(a.payment_id)) continue;
    if (voidedCharges.has(a.charge_id)) continue;
    allocByCharge.set(a.charge_id, (allocByCharge.get(a.charge_id) ?? 0) + a.amount_cents);
  }

  // Per-payment list of allocations (for the entry shape).
  const allocByPayment = new Map<string, AllocationRow[]>();
  for (const a of tenancyAllocations) {
    const arr = allocByPayment.get(a.payment_id) ?? [];
    arr.push(a);
    allocByPayment.set(a.payment_id, arr);
  }

  let currency: string | null = null;
  if (chargeRows.length > 0) currency = chargeRows[0]!.currency;
  else if (paymentRows.length > 0) currency = paymentRows[0]!.currency;

  // Aggregates. Voided rows excluded. Deposits split out.
  let rentChargesC = 0, rentPaymentsC = 0, depositChargesC = 0, depositPaymentsC = 0;
  for (const cr of chargeRows) {
    if (cr.voided_at) continue;
    if (cr.type === 'deposit') depositChargesC += cr.amount_cents;
    else rentChargesC += cr.amount_cents;
  }
  // Payments aren't intrinsically rent-vs-deposit; the split is decided by
  // what they're allocated to.
  for (const a of tenancyAllocations) {
    if (voidedPayments.has(a.payment_id)) continue;
    if (voidedCharges.has(a.charge_id)) continue;
    const isDeposit = chargeRows.find((cr) => cr.id === a.charge_id)?.type === 'deposit';
    if (isDeposit) depositPaymentsC += a.amount_cents;
    else rentPaymentsC += a.amount_cents;
  }

  const entries: z.infer<typeof LedgerEntry>[] = [];
  for (const cr of chargeRows) {
    const allocated = allocByCharge.get(cr.id) ?? 0;
    entries.push({
      kind: 'charge',
      id: cr.id,
      occurred_at: cr.due_date,
      type: cr.type,
      amount_cents: cr.amount_cents,
      voided_at: cr.voided_at,
      void_reason: cr.void_reason,
      description: cr.description,
      derived_balance_cents: cr.voided_at ? 0 : cr.amount_cents - allocated,
      is_deposit: cr.type === 'deposit',
    });
  }
  for (const pr of paymentRows) {
    entries.push({
      kind: 'payment',
      id: pr.id,
      occurred_at: pr.received_at,
      amount_cents: pr.amount_cents,
      method: pr.method,
      reference: pr.reference,
      voided_at: pr.voided_at,
      void_reason: pr.void_reason,
      allocations: (allocByPayment.get(pr.id) ?? []).map((a) => ({
        charge_id: a.charge_id,
        amount_cents: a.amount_cents,
      })),
    });
  }
  entries.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  return c.json(
    {
      tenancy_id: tenancyId,
      currency,
      entries,
      totals: {
        rent_charges_cents:     rentChargesC,
        rent_payments_cents:    rentPaymentsC,
        rent_balance_cents:     rentChargesC - rentPaymentsC,
        deposit_charges_cents:  depositChargesC,
        deposit_payments_cents: depositPaymentsC,
        deposit_balance_cents:  depositChargesC - depositPaymentsC,
      },
    } satisfies z.infer<typeof LedgerResponse>,
    200,
  );
});
