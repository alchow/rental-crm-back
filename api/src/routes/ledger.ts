import { ledgerRowsAt } from '../lib/ledger-history';
import { emptyCurrencyTotals, ledgerCurrencyTotals, selectLedgerCurrency } from '../lib/ledger-currencies';
import { readAllById } from '../lib/postgrest-pages';
import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';

// Derived tenancy ledger; balances are never stored. Reads recompute charges,
// payments, and allocations in integer minor units. Voided facts and their
// allocations do not affect totals. Deposit charges/payments remain in a
// separate subledger and never affect rent balance.

const LedgerCharge = z.object({
  kind: z.literal('charge'),
  id: z.string().uuid(),
  // occurred_at stays as the backwards-compatible sort/display alias for
  // due_date. The explicit fields below carry the financial meaning.
  occurred_at: z.string(),
  due_date: z.string(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  source_schedule_id: z.string().uuid().nullable(),
  cycle_key: z.string().nullable().optional(),
  terms_snapshot: z.record(z.unknown()).nullable().optional(),
  // The bill this entry derives from — the rent charge a late_fee was asserted
  // against (migration 20260801000007). Optional as well as nullable: the row
  // fetch is select('*'), so against a database that predates the migration the
  // field is simply absent rather than a fabricated null, and no read 500s.
  parent_charge_id: z.string().uuid().nullable().optional(),
  source: z.enum(['manual', 'rent_schedule']),
  // When the charge row was RECORDED — the payment entry always had this
  // pair. A backfilled charge (created_at far after due_date, e.g. tenancy
  // adoption) is thereby distinguishable from one billed as it fell due.
  // Never render it as the due date.
  created_at: z.string(),
  type: z.string(),
  amount_cents: z.number().int(),
  currency: z.string().optional(),
  voided_at: z.string().nullable(),
  void_reason: z.string().nullable(),
  description: z.string().nullable(),
  derived_balance_cents: z.number().int(),
  is_deposit: z.boolean(),
});
const LedgerPayment = z.object({
  kind: z.literal('payment'),
  id: z.string().uuid(),
  // occurred_at is received_at: WHEN THE MONEY ARRIVED, the fact the landlord
  // asserts. created_at is when the row was written. They differ whenever rent
  // is recorded after the fact ("the cheque came Friday, I logged it Monday"),
  // and a statement that shows one as the other misstates either the payment
  // history or the record's provenance. Both columns are NOT NULL and predate
  // this response, so both are always present.
  occurred_at: z.string().nullable().openapi({ description: 'Actual receipt date; null means explicitly unknown, never the entry date.' }),
  receipt_date_unknown: z.boolean().optional(),
  entry_source: z.string().optional(),
  created_at: z.string().openapi({
    description:
      'When this payment was RECORDED, which is later than occurred_at whenever rent ' +
      'is logged after the fact. Never render it as the payment date.',
  }),
  amount_cents: z.number().int(),
  currency: z.string().optional(),
  method: z.string(),
  reference: z.string().nullable(),
  voided_at: z.string().nullable(),
  void_reason: z.string().nullable(),
  allocations: z.array(
    z.object({
      id: z.string().uuid(),
      charge_id: z.string().uuid(),
      amount_cents: z.number().int(),
      note: z.string().nullable(),
      voided_at: z.string().nullable(),
      void_reason: z.string().nullable(),
      created_at: z.string().openapi({
        description:
          'When this money was APPLIED to that charge — which can be well after the ' +
          'payment itself (a credit re-applied once a replacement charge exists).',
      }),
    }),
  ),
});
const LedgerEntry = z.union([LedgerCharge, LedgerPayment]);

// The tenancy's adoption record (ADR-0013), when one exists. A recorded fact,
// not a ledger row: opening_balance_cents is NOT included in any totals field
// — clients that display it add it themselves, and it can never take a late
// fee or appear in payment-dated income exports because it is neither a
// charge nor a payment.
const LedgerAdoption = z
  .object({
    adoption_date: z.string().openapi({
      description:
        'The day tracking began — everything before it is landlord testimony, and the ' +
        "statement's tracking-since divider sits here.",
    }),
    opening_balance_cents: z.number().int().openapi({
      description: 'Signed: > 0 the tenant owed at adoption, < 0 the tenant held a credit.',
    }),
    currency: z.string(),
    balance_basis: z.string().nullable(),
    needs_review: z.boolean(),
    created_at: z.string(),
  })
  .openapi('LedgerAdoption');

// Per-charge-type slice of the totals. `allocated_cents` is the sum of
// ACTIVE allocations against charges of that type (payment and charge both
// non-voided) -- the same attribution rule the deposit split has always
// used, generalized to all 8 types. Keys are fixed and always present
// (zeros included) because the charge-type vocabulary is a closed DB CHECK
// constraint; keep this list aligned with ChargeType in charges.ts.
const TypeTotals = z.object({
  charges_cents: z.number().int(),
  allocated_cents: z.number().int(),
  balance_cents: z.number().int(),
});
const LedgerTotalsByType = z
  .object({
    rent: TypeTotals,
    late_fee: TypeTotals,
    deposit: TypeTotals,
    utility: TypeTotals,
    parking: TypeTotals,
    repair_chargeback: TypeTotals,
    nsf_fee: TypeTotals,
    other: TypeTotals,
  })
  .openapi('LedgerTotalsByType');

const LEGACY_NON_DEPOSIT_NOTE =
  'LEGACY: aggregates ALL non-deposit charge types (utility, late_fee, ... included), ' +
  'not just type=rent. Use totals.by_type for an honest per-type split.';

const LedgerTotals = z.object({
      rent_charges_cents: z.number().int().openapi({ description: LEGACY_NON_DEPOSIT_NOTE }),
      rent_payments_cents: z.number().int().openapi({ description: LEGACY_NON_DEPOSIT_NOTE }),
      rent_balance_cents: z.number().int().openapi({ description: LEGACY_NON_DEPOSIT_NOTE }),
      deposit_charges_cents: z.number().int(),
      deposit_payments_cents: z.number().int(),
      deposit_balance_cents: z.number().int(),
      // The total a tenant has paid into this tenancy that has NOT yet been
      // applied to a charge. Equals
      //     sum(non-voided payments.amount_cents) - sum(active allocations)
      // where an "active allocation" is one whose payment AND charge are
      // both non-voided. A payment that was allocated to a charge which
      // was later voided will show up here -- it's real money still owed
      // back to the tenant. This is the credit number a litigant could
      // point to and say "you have my money".
      total_received_cents: z.number().int(),
      total_allocated_cents: z.number().int(),
      unapplied_credit_cents: z.number().int(),
      by_type: LedgerTotalsByType,
    }).openapi('LedgerTotals');
const LedgerResponse = z
  .object({
    tenancy_id: z.string().uuid(),
    currency: z.string().nullable(),
    adoption: LedgerAdoption.nullable(),
    entries: z.array(LedgerEntry),
    totals: LedgerTotals,
    available_currencies: z.array(z.string()).optional(),
    totals_by_currency: z.record(LedgerTotals).optional(),
  })
  .openapi('LedgerResponse');

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

const LedgerQuery = z.object({
  currency: z.string().length(3).optional().openapi({ description: 'Select one currency. All available currencies retain independent server totals.' }),
  // Point-in-time view as of END of that date.
  //   Charges included when due_date <= as_of.
  //   Payments included when received_at (date part) <= as_of.
  //   A void is respected only when voided_at (date part) <= as_of — a
  //   charge/payment voided AFTER as_of counts as live at as_of.
  //   Allocations count when both sides qualify.
  // Omit for the current view.
  as_of: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const get = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/tenancies/{tenancyId}/ledger',
  tags: ['ledger'],
  summary: 'Per-tenancy ledger: charges + payments + allocations + derived balances',
  description:
    'Derived financial view. Balances are recomputed from charges + payments + ' +
    'allocations on every call — never stored. Optional ?as_of=YYYY-MM-DD gives a ' +
    'point-in-time view as of end of that date: charges by due_date, payments by ' +
    'received_at date, voids respected only when voided_at date <= as_of.',
  request: { params: TenancyParam, query: LedgerQuery },
  responses: {
    200: { description: 'ledger', content: { 'application/json': { schema: LedgerResponse } } },
    ...errorResponses,
  },
});

export const ledgerApp = newApiApp();

interface ChargeRow {
  id: string;
  account_id: string;
  tenancy_id: string;
  type: string;
  amount_cents: number;
  currency: string;
  due_date: string;
  period_start: string | null;
  period_end: string | null;
  source_schedule_id: string | null;
  cycle_key?: string | null;
  terms_snapshot?: Record<string, unknown> | null;
  // Absent (not null) when read from a database that predates migration
  // 20260801000007; select('*') tolerates that, an explicit column list
  // would not.
  parent_charge_id?: string | null;
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
  received_at: string | null;
  receipt_date_unknown?: boolean;
  entry_source?: string;
  method: string;
  reference: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
}
interface AllocationRow {
  id: string;
  account_id: string;
  payment_id: string;
  charge_id: string;
  amount_cents: number;
  created_at: string;
  note?: string | null;
  voided_at?: string | null;
  void_reason?: string | null;
}

ledgerApp.openapi(get, async (c) => {
  const { accountId, tenancyId } = c.req.valid('param');
  const { as_of, currency: requestedCurrency } = c.req.valid('query');
  const sb = getSb(c);

  const [charges, payments, adoptions, rentSchedules] = await Promise.all([
    readAllById(() => sb
      .from('charges')
      .select('*')
      .eq('account_id', accountId)
      .eq('tenancy_id', tenancyId)
      .is('deleted_at', null),'ledger charges').then((data) => ({ data,error:null })),
    readAllById(() => sb
      .from('payments')
      .select('*')
      .eq('account_id', accountId)
      .eq('tenancy_id', tenancyId)
      .is('deleted_at', null),'ledger payments').then((data) => ({ data,error:null })),
    sb
      .from('tenancy_adoptions')
      .select('*')
      .eq('account_id', accountId)
      .eq('tenancy_id', tenancyId)
      .is('deleted_at', null)
      .limit(1),
    sb.from('rent_schedules').select('currency,start_date').eq('account_id',accountId).eq('tenancy_id',tenancyId)
      .eq('kind','rent').is('deleted_at',null).lte('start_date',as_of ?? new Date().toISOString().slice(0,10))
      .or(`end_date.is.null,end_date.gte.${as_of ?? new Date().toISOString().slice(0,10)}`)
      .order('start_date',{ascending:false}).order('id',{ascending:false}).limit(1),
  ]);

  if (rentSchedules.error) throw new ApiError(500, 'database_error', rentSchedules.error.message);
  // COMPAT: tolerate a database that predates migration 20260810000001 —
  // prod deploys code on merge while a human applies migrations later, and a
  // pre-existing read endpoint must not 500 for every tenancy in that window
  // (same posture as the parent_charge_id tolerance above). PGRST205 = table
  // missing from the schema cache.
  const adoptionTableMissing =
    adoptions.error !== null &&
    (adoptions.error.code === 'PGRST205' ||
      /could not find the table/i.test(adoptions.error.message ?? ''));
  if (adoptions.error && !adoptionTableMissing) {
    throw new ApiError(500, 'database_error', adoptions.error.message);
  }

  let chargeRows = (charges.data ?? []) as ChargeRow[];
  let paymentRows = (payments.data ?? []) as PaymentRow[];

  chargeRows = ledgerRowsAt(chargeRows, (row) => row.due_date, as_of);
  paymentRows = ledgerRowsAt(paymentRows, (row) => row.received_at, as_of);
  const chargeById = new Map(chargeRows.map((cr) => [cr.id, cr]));

  // Allocations are fetched for THIS tenancy's charges only (chunked .in()
  // keeps the request URL bounded) -- never account-wide. The paymentIds
  // filter preserves the original semantics: an allocation counts only when
  // BOTH its payment and its charge live in this tenancy.
  const chargeIds = [...chargeById.keys()];
  const allRows: AllocationRow[] = [];
  for (let i = 0; i < chargeIds.length; i += 200) {
    const data = await readAllById(() => sb
      .from('payment_allocations')
      .select('*')
      .eq('account_id', accountId)
      .in('charge_id', chargeIds.slice(i, i + 200))
      .is('deleted_at', null),'ledger allocations');
    allRows.push(...(data as AllocationRow[]));
  }
  const paymentIds = new Set(paymentRows.map((p) => p.id));
  const tenancyAllocations = ledgerRowsAt(allRows, (row) => row.created_at, as_of).filter((row) =>
    paymentIds.has(row.payment_id),
  );

  // Index voided rows so we can exclude their allocations from the balance.
  const voidedPayments = new Set(paymentRows.filter((p) => p.voided_at !== null).map((p) => p.id));
  const voidedCharges = new Set(chargeRows.filter((c) => c.voided_at !== null).map((c) => c.id));

  // Per-charge derived balance.
  // Only unreversed allocations with live payment and charge affect balances.
  const allocByCharge = new Map<string, number>();
  for (const a of tenancyAllocations) {
    if (a.voided_at) continue;
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

  // Adoption record: at most one live row (partial unique index). Honored by
  // as_of with the same financial-date rule as charges: an adoption dated
  // after as_of did not exist at that point in time.
  interface AdoptionRow {
    adoption_date: string;
    opening_balance_cents: number;
    currency: string;
    balance_basis: string | null;
    needs_review: boolean;
    created_at: string;
  }
  const adoptionRow = ((adoptions.data ?? []) as AdoptionRow[])[0] ?? null;
  const adoption =
    adoptionRow === null || (as_of !== undefined && adoptionRow.adoption_date > as_of)
      ? null
      : {
          adoption_date: adoptionRow.adoption_date,
          opening_balance_cents: adoptionRow.opening_balance_cents,
          currency: adoptionRow.currency,
          balance_basis: adoptionRow.balance_basis,
          needs_review: adoptionRow.needs_review,
          created_at: adoptionRow.created_at,
        };

  const currencyTotals = ledgerCurrencyTotals(chargeRows,paymentRows,tenancyAllocations);
  if (adoption && !currencyTotals[adoption.currency]) currencyTotals[adoption.currency] = emptyCurrencyTotals();
  const availableCurrencies = Object.keys(currencyTotals).sort();
  const currency = selectLedgerCurrency(availableCurrencies,requestedCurrency,rentSchedules.data?.[0]?.currency);
  const totals = (currency && currencyTotals[currency]) || emptyCurrencyTotals();

  const entries: z.infer<typeof LedgerEntry>[] = [];
  for (const cr of chargeRows) {
    if (cr.currency !== currency) continue;
    const allocated = allocByCharge.get(cr.id) ?? 0;
    entries.push({
      kind: 'charge',
      id: cr.id,
      occurred_at: cr.due_date,
      due_date: cr.due_date,
      period_start: cr.period_start,
      period_end: cr.period_end,
      source_schedule_id: cr.source_schedule_id,
      cycle_key: cr.cycle_key,
      terms_snapshot: cr.terms_snapshot,
      parent_charge_id: cr.parent_charge_id,
      source: cr.source_schedule_id === null ? 'manual' : 'rent_schedule',
      created_at: cr.created_at,
      type: cr.type,
      amount_cents: cr.amount_cents,
      currency: cr.currency,
      voided_at: cr.voided_at,
      void_reason: cr.void_reason,
      description: cr.description,
      derived_balance_cents: cr.voided_at ? 0 : cr.amount_cents - allocated,
      is_deposit: cr.type === 'deposit',
    });
  }
  for (const pr of paymentRows) {
    if (pr.currency !== currency) continue;
    entries.push({
      kind: 'payment',
      id: pr.id,
      occurred_at: pr.received_at,
      receipt_date_unknown: pr.receipt_date_unknown ?? false,
      entry_source: pr.entry_source ?? 'manual',
      created_at: pr.created_at,
      amount_cents: pr.amount_cents,
      currency: pr.currency,
      method: pr.method,
      reference: pr.reference,
      voided_at: pr.voided_at,
      void_reason: pr.void_reason,
      allocations: (allocByPayment.get(pr.id) ?? []).map((a) => ({
        id: a.id,
        charge_id: a.charge_id,
        amount_cents: a.amount_cents,
        created_at: a.created_at,
        note: a.note ?? null,
        voided_at: a.voided_at ?? null,
        void_reason: a.void_reason ?? null,
      })),
    });
  }
  entries.sort((a, b) => (a.occurred_at ?? '9999').localeCompare(b.occurred_at ?? '9999') || a.created_at.localeCompare(b.created_at));

  return c.json(
    {
      tenancy_id: tenancyId,
      currency,
      adoption: adoption?.currency === currency ? adoption : null,
      entries,
      totals,
      available_currencies: availableCurrencies,
      totals_by_currency: currencyTotals,
    } satisfies z.infer<typeof LedgerResponse>,
    200,
  );
});
