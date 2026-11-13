import type { Context } from 'hono';
import { getSb } from '../../supabase/request-client';
import { ApiError } from '../_lib/error';

type Json = Record<string, unknown>;
export interface RentChangeRequest {
  rent_change: {
    basis: { kind: 'landlord_statement'; note?: string };
    effective_month: string;
    amount_cents: number;
  };
  warning_acknowledgements?: unknown[];
  expected_context?: string;
}

export const isRentChange = (body: unknown): body is RentChangeRequest =>
  typeof body === 'object' && body !== null && 'rent_change' in body;

/**
 * DATA FLOW: landlord-statement rent change -> schedule in force at the effective
 * month -> a complete successor intent with every other term carried over. The
 * database still plans, warns and commits it as an ordinary billing transition.
 */
export async function expandRentChange(
  c: Context,
  accountId: string,
  tenancyId: string,
  body: RentChangeRequest,
): Promise<Json> {
  const { rent_change: change } = body;
  const monthStart = `${change.effective_month}-01`;
  const { data, error } = await getSb(c)
    .from('rent_schedules')
    .select(
      'start_date, end_date, due_day, regular_anchor, period_policy_version, billing_due_rule, short_month_policy, currency, grace_days, late_fee_cents, terms_snapshot',
    )
    .eq('account_id', accountId)
    .eq('tenancy_id', tenancyId)
    .eq('kind', 'rent')
    .is('deleted_at', null)
    .lte('start_date', monthStart)
    .or(`end_date.is.null,end_date.gte.${monthStart}`)
    .order('start_date', { ascending: false })
    .limit(1);
  if (error) throw new ApiError(500, 'database_error', error.message);
  const schedule = data?.[0];
  if (!schedule)
    throw new ApiError(400, 'invalid_request', 'No rent schedule is in force for that month.');
  const anchorDay =
    schedule.period_policy_version === 1
      ? schedule.due_day
      : Number(String(schedule.regular_anchor).slice(8, 10));
  const start = `${change.effective_month}-${String(anchorDay).padStart(2, '0')}`;
  const snapshot = (schedule.terms_snapshot ?? {}) as Json;
  const lateFee =
    (snapshot.late_fee_policy as Json | undefined) ??
    ((snapshot.billing as Json | undefined)?.late_fee_policy as Json | undefined) ??
    (schedule.late_fee_cents
      ? { kind: 'fixed', amount_cents: schedule.late_fee_cents, currency: schedule.currency }
      : { kind: 'unknown' });
  const rent: Json = {
    decision: 'configure',
    coverage_start: start,
    coverage_end: schedule.end_date,
    regular_anchor: start,
    due_day: schedule.due_day,
    ...(schedule.billing_due_rule
      ? {
          billing_due_rule: schedule.billing_due_rule,
          short_month_policy: schedule.short_month_policy ?? 'last_day',
        }
      : {}),
    amount_cents: change.amount_cents,
    currency: schedule.currency,
    grace_days: schedule.grace_days,
    late_fee_policy: lateFee,
    manual_basis: change.basis.note ?? 'Rent change stated by the landlord',
    history_mode: 'itemized',
    period_overrides: [],
    charge_keys: [],
    follows_lease: false,
    basis: change.basis,
  };
  return {
    rent,
    deposit: { decision: 'keep' },
    payments: [],
    credit_allocations: [],
    explanations: [],
    warning_acknowledgements: body.warning_acknowledgements ?? [],
    ...(body.expected_context ? { expected_context: body.expected_context } : {}),
  };
}
