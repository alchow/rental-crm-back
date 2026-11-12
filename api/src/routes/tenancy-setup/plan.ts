import type { Context } from 'hono';
import { getSb } from '../../supabase/request-client';
import { asJson } from '../../supabase/db-types';
import { ApiError } from '../_lib/error';
import { mapDateRpcError } from '../tenancies/rpc';
import {
  billingDifferences,
  deriveBillingFromLease,
  expandDepositAnswer,
  fieldErrorsFromDb,
  fieldErrorsFromFindings,
  prorationSuggestions,
  rentStepOverrides,
  validateRentSteps,
  validateSetupShape,
  type DepositAnswer,
  type FieldError,
  type ProrationMethod,
  type RentStep,
} from '../../lib/setup-plan';

type Json = Record<string, unknown>;

export interface PlannedSetup {
  setup: Json;
  review: Json | null;
  errors: FieldError[];
  /** Status and envelope code a confirm/preview failure carries. */
  failure: { status: 400 | 409; code: string; message: string; details: Json } | null;
}

async function accountClock(c: Context, accountId: string) {
  const { data, error } = await getSb(c)
    .from('accounts')
    .select('time_zone, proration_method')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  const zone = (data?.time_zone as string | undefined) ?? 'UTC';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return {
    today,
    method: ((data?.proration_method as string | undefined) ?? 'actual_days') as ProrationMethod,
  };
}

async function withExistingNames(c: Context, accountId: string, errors: FieldError[]) {
  const ids = errors.map((e) => e.meta?.personId).filter((id): id is string => Boolean(id));
  if (!ids.length) return errors;
  const { data } = await getSb(c)
    .from('tenants')
    .select('id, full_name')
    .eq('account_id', accountId)
    .in('id', ids);
  const names = new Map((data ?? []).map((t) => [t.id as string, t.full_name as string]));
  return errors.map((e) =>
    e.meta?.personId && names.has(e.meta.personId)
      ? { ...e, meta: { ...e.meta, existingName: names.get(e.meta.personId)! } }
      : e,
  );
}

/** The database's failure as a field-error envelope, or the existing mapping when it is not one. */
export async function setupFailure(
  c: Context,
  accountId: string,
  error: { code?: string; message?: string; details?: string },
): Promise<NonNullable<PlannedSetup['failure']>> {
  const mapped = fieldErrorsFromDb(error);
  if (!mapped) mapDateRpcError(error);
  const errors = await withExistingNames(c, accountId, mapped!);
  if (error.code === 'PT409') {
    const details = (error.details ? JSON.parse(error.details) : {}) as Json;
    return {
      status: 409,
      code: 'setup_person_contact_conflict',
      message: 'Review duplicate contact details in setup.',
      details: { ...details, errors },
    };
  }
  return {
    status: 400,
    code: 'invalid_request',
    message: error.message ?? 'invalid setup',
    details: { errors },
  };
}

const failureOf = (errors: FieldError[]): PlannedSetup['failure'] => ({
  status: 400,
  code: 'invalid_request',
  message: 'Fix the listed setup fields.',
  details: { errors },
});

/**
 * DATA FLOW: request -> derived billing / deposit / rent steps -> shape checks ->
 * database preview (the same one confirm runs) -> blocking findings as field errors.
 * Validate, preview and confirm all call this, so a draft that validates cannot
 * fail confirm on a field error.
 */
export async function planSetup(
  c: Context,
  accountId: string,
  id: string,
  input: Json,
): Promise<PlannedSetup> {
  const { today, method } = await accountClock(c, accountId);
  const {
    deposit_answer: depositAnswer,
    rent_steps: rawSteps,
    ...rest
  } = input as Json & {
    deposit_answer?: DepositAnswer;
    rent_steps?: RentStep[];
  };
  let setup: Json = rest;
  const steps = rawSteps ?? [];
  const errors: FieldError[] = validateSetupShape(setup);
  const agreement = setup.agreement as Parameters<typeof deriveBillingFromLease>[0];
  if (depositAnswer) {
    const expanded = expandDepositAnswer(setup, depositAnswer, today);
    setup = expanded.setup;
    errors.push(...expanded.errors);
  }
  errors.push(...validateRentSteps(agreement, steps, today.slice(0, 7)));
  const billing = setup.billing as Json;
  let rent = billing.rent as Json;
  if (rent.decision === 'configure' && rent.follows_lease === true) {
    const derived = deriveBillingFromLease(agreement, rent, steps, today.slice(0, 7));
    rent = derived.rent;
    errors.push(...derived.errors);
  } else if (rent.decision === 'configure' && steps.length) {
    errors.push({ code: 'rent_step.needs_lease_billing', step: 'lease', field: 'rent_steps' });
  }
  setup = { ...setup, billing: { ...billing, rent } };
  if (errors.length) return { setup, review: null, errors, failure: failureOf(errors) };

  const preview = async (payload: Json) =>
    getSb(c).rpc('preview_tenancy_setup_session', {
      p_account_id: accountId,
      p_id: id,
      p_setup: asJson(payload),
    });
  let result = await preview(setup);
  if (result.error) {
    const failure = await setupFailure(c, accountId, result.error);
    return { setup, review: null, errors: (failure.details.errors as FieldError[]) ?? [], failure };
  }
  let review = result.data as Json;
  if (steps.length && rent.decision === 'configure') {
    const overrides = rentStepOverrides(
      agreement,
      steps,
      rent.amount_cents as number,
      (review.history_periods as Parameters<typeof rentStepOverrides>[3]) ?? [],
      (rent.period_overrides as Json[]) ?? [],
    );
    if (overrides.length) {
      rent = {
        ...rent,
        period_overrides: [...((rent.period_overrides as Json[]) ?? []), ...overrides],
      };
      setup = { ...setup, billing: { ...(setup.billing as Json), rent } };
      result = await preview(setup);
      if (result.error) {
        const failure = await setupFailure(c, accountId, result.error);
        return {
          setup,
          review: null,
          errors: (failure.details.errors as FieldError[]) ?? [],
          failure,
        };
      }
      review = result.data as Json;
    }
  }
  const blocking =
    review.can_confirm === true ? [] : fieldErrorsFromFindings((review.findings as Json[]) ?? []);
  review = {
    ...review,
    field_errors: blocking,
    billing_differences: billingDifferences(agreement, rent),
    proration_suggestions:
      rent.decision === 'configure'
        ? prorationSuggestions(review, rent.amount_cents as number, method)
        : [],
    proration_method: method,
  };
  return { setup, review, errors: blocking, failure: blocking.length ? failureOf(blocking) : null };
}
