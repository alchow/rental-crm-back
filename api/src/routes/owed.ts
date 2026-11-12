import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, conflictResponse, errorResponses } from './_lib/error';
import { requireManager } from './_lib/guards';
import { CalendarDate } from '../schemas/calendar-date';

// One owed summary for every surface (statement, door, lists, rent roll, ending dialog),
// late-fee suggestions computed on read, and the duplicate-property check.

const AccountParam = z.object({ accountId: z.string().uuid() });
const ChargeParam = z.object({ accountId: z.string().uuid(), id: z.string().uuid() });
const TenancyQuery = z.object({ tenancy_id: z.string().uuid().optional() });

const OwedSummary = z
  .object({
    tenancy_id: z.string().uuid(),
    currency: z.string(),
    as_of: CalendarDate.openapi({ description: "Today in the account's time zone." }),
    total_cents: z.number().int().openapi({
      description: 'Every unpaid non-deposit charge due today or earlier.',
    }),
    by_type: z.array(z.object({ type: z.string(), cents: z.number().int() })),
    overdue_cents: z.number().int().openapi({
      description:
        'Part of total past its due date plus grace; a starting balance is never overdue.',
    }),
    oldest_due_on: CalendarDate.nullable(),
    deposit_owed_cents: z.number().int(),
    unapplied_credit_cents: z.number().int(),
    next_charge: z
      .object({
        cents: z.number().int(),
        due_on: CalendarDate,
        source: z.enum(['charge', 'schedule']),
      })
      .nullable()
      .openapi({
        description:
          'The next amount coming due: an unpaid future charge or an unbilled schedule period.',
      }),
    rent_tracked: z
      .boolean()
      .openapi({ description: 'False when no rent schedule covers today or later.' }),
  })
  .openapi('OwedSummary');

const owedSummaries = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/owed-summaries',
  tags: ['ledger'],
  summary: 'What each tenancy owes now, by type, with overdue and the next charge',
  request: { params: AccountParam, query: TenancyQuery },
  responses: {
    200: {
      description: 'One row per tenancy and currency',
      content: { 'application/json': { schema: z.object({ data: z.array(OwedSummary) }) } },
    },
    ...errorResponses,
  },
});

const LateFeeSuggestion = z
  .object({
    charge_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    due_date: CalendarDate,
    grace_days: z.number().int(),
    eligible_on: CalendarDate,
    rent_amount_cents: z.number().int(),
    unpaid_cents: z.number().int(),
    currency: z.string(),
    fee: z.object({
      kind: z.enum(['fixed', 'percent', 'other']),
      amount_cents: z.number().int().nullable(),
      percent: z.number().optional(),
      text: z.string().nullable().optional(),
    }),
  })
  .openapi('LateFeeSuggestion');

const lateFeeSuggestions = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/late-fee-suggestions',
  tags: ['charges'],
  summary:
    'Unpaid rent charges past their grace period whose late fee has not been added or skipped',
  description:
    'Add the fee with POST /charges (type late_fee, parent_charge_id = charge_id); skip it with POST /charges/{id}/late-fee-decision. A starting balance never appears.',
  request: { params: AccountParam, query: TenancyQuery },
  responses: {
    200: {
      description: 'Suggestions, oldest due first',
      content: { 'application/json': { schema: z.object({ data: z.array(LateFeeSuggestion) }) } },
    },
    ...errorResponses,
  },
});

const LateFeeDecision = z
  .object({ charge_id: z.string().uuid(), decision: z.literal('skipped'), decided_at: z.string() })
  .openapi('LateFeeDecision');
const decideLateFee = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/charges/{id}/late-fee-decision',
  tags: ['charges'],
  summary: 'Skip the suggested late fee for one rent charge',
  request: {
    params: ChargeParam,
    body: {
      required: true,
      content: {
        'application/json': { schema: z.object({ decision: z.literal('skipped') }).strict() },
      },
    },
  },
  responses: {
    200: {
      description: 'Decision recorded',
      content: { 'application/json': { schema: LateFeeDecision } },
    },
    ...errorResponses,
    ...conflictResponse,
  },
});

const PropertyMatch = z
  .object({
    property_id: z.string().uuid(),
    name: z.string(),
    address: z.record(z.unknown()).nullable(),
    door_count: z.number().int(),
    matched_on: z.enum(['provider_id', 'address']),
  })
  .openapi('PropertyMatch');
const duplicateProperties = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/properties/duplicates',
  tags: ['properties'],
  summary: 'Existing properties with the same picked place or the same normalized address',
  request: {
    params: AccountParam,
    query: z.object({
      provider_id: z.string().max(300).optional(),
      address: z.string().max(300).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Matches, oldest first; empty when nothing matches',
      content: { 'application/json': { schema: z.object({ data: z.array(PropertyMatch) }) } },
    },
    ...errorResponses,
  },
});

export const owedApp = newApiApp();

owedApp.openapi(owedSummaries, async (c) => {
  const { accountId } = c.req.valid('param');
  const { tenancy_id } = c.req.valid('query');
  const { data, error } = await getSb(c).rpc('owed_summaries', {
    p_account_id: accountId,
    ...(tenancy_id ? { p_tenancy_id: tenancy_id } : {}),
  });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json({ data: (data ?? []) as unknown as z.infer<typeof OwedSummary>[] }, 200);
});

owedApp.openapi(lateFeeSuggestions, async (c) => {
  const { accountId } = c.req.valid('param');
  const { tenancy_id } = c.req.valid('query');
  const { data, error } = await getSb(c).rpc('late_fee_suggestions', {
    p_account_id: accountId,
    ...(tenancy_id ? { p_tenancy_id: tenancy_id } : {}),
  });
  if (error) throw new ApiError(500, 'database_error', error.message);
  const rows = ((data ?? []) as unknown as z.infer<typeof LateFeeSuggestion>[]).sort((a, b) =>
    a.due_date.localeCompare(b.due_date),
  );
  return c.json({ data: rows }, 200);
});

owedApp.openapi(decideLateFee, async (c) => {
  requireManager(c);
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const charge = await sb
    .from('charges')
    .select('id, type')
    .eq('account_id', accountId)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (charge.error) throw new ApiError(500, 'database_error', charge.error.message);
  if (!charge.data) throw new ApiError(404, 'not_found', 'charge not found');
  if (charge.data.type !== 'rent')
    throw new ApiError(400, 'invalid_request', 'Late fees are suggested only for rent charges.');
  const inserted = await sb
    .from('late_fee_decisions')
    .insert({ account_id: accountId, charge_id: id, decision: 'skipped' })
    .select('charge_id, decision, decided_at')
    .maybeSingle();
  if (inserted.error && inserted.error.code !== '23505')
    throw new ApiError(500, 'database_error', inserted.error.message);
  const row =
    inserted.data ??
    (
      await sb
        .from('late_fee_decisions')
        .select('charge_id, decision, decided_at')
        .eq('account_id', accountId)
        .eq('charge_id', id)
        .single()
    ).data;
  return c.json(row as z.infer<typeof LateFeeDecision>, 200);
});

owedApp.openapi(duplicateProperties, async (c) => {
  const { accountId } = c.req.valid('param');
  const { provider_id, address } = c.req.valid('query');
  const { data, error } = await getSb(c).rpc('find_duplicate_properties', {
    p_account_id: accountId,
    p_provider_id: provider_id ?? '',
    p_address: address ?? '',
  });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return c.json({ data: (data ?? []) as unknown as z.infer<typeof PropertyMatch>[] }, 200);
});
