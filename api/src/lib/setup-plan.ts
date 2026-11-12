// Pure tenancy-setup planning: billing derived from the lease, the one-answer
// deposit, rent steps, proration and field-level validation. No I/O here; the
// setup route applies these to the request before the database preview runs.

export type SetupStep = 'who' | 'lease' | 'catchup' | 'confirm';
export interface FieldError {
  code: string;
  step: SetupStep;
  field: string;
  meta?: Record<string, string>;
}
export type ProrationMethod = 'actual_days' | 'thirty_day_month';

type Json = Record<string, unknown>;
type DueRule = { kind: string; day?: number; text?: string };
type LateFee = { kind: string; [key: string]: unknown };

const DAY_MS = 86_400_000;
const toDay = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
export const daysInMonth = (date: string): number => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.getUTCDate();
};

/** Inclusive days `from..to` of a monthly amount, in integer cents. */
export function prorate(
  monthlyCents: number,
  from: string,
  to: string,
  method: ProrationMethod = 'actual_days',
): { cents: number; days: number; base: number } {
  const days = toDay(to) - toDay(from) + 1;
  const base = method === 'actual_days' ? daysInMonth(from) : 30;
  return { cents: Math.round((monthlyCents * Math.min(days, base)) / base), days, base };
}

export interface RentStep {
  effective_month: string; // YYYY-MM
  amount_cents: number;
}
/** The rent in force for a month (YYYY-MM): the latest step starting on or before it. */
export function rentFor(steps: readonly RentStep[], month: string): number | null {
  let amount: number | null = null;
  for (const step of [...steps].sort((a, b) =>
    a.effective_month.localeCompare(b.effective_month),
  )) {
    if (step.effective_month <= month) amount = step.amount_cents;
  }
  return amount;
}

interface Agreement {
  term_start: string;
  term_end: string | null;
  rent_amount_cents: number;
  rent_currency: string;
  rent_due_rule?: DueRule;
  grace_days?: number | null;
  late_fee_policy?: LateFee;
  deposit_amount_cents: number;
  deposit_currency: string;
  deposit_knowledge?: string;
}

/** Billing derived from the lease while follows_lease is true. */
export function deriveBillingFromLease(
  agreement: Agreement,
  rent: Json,
  steps: readonly RentStep[] = [],
  month?: string,
): { rent: Json; errors: FieldError[] } {
  const rule = agreement.rent_due_rule ?? { kind: 'unknown' };
  if (rule.kind !== 'day_of_month' && rule.kind !== 'last_day') {
    return {
      rent,
      errors: [{ code: 'rent.due_day_missing', step: 'lease', field: 'agreement.rent_due_rule' }],
    };
  }
  const schedule = [
    {
      effective_month: agreement.term_start.slice(0, 7),
      amount_cents: agreement.rent_amount_cents,
    },
    ...steps,
  ];
  const current = (month && rentFor(schedule, month)) || agreement.rent_amount_cents;
  return {
    rent: {
      ...rent,
      amount_cents: current,
      currency: agreement.rent_currency,
      billing_due_rule: rule,
      due_day: rule.kind === 'last_day' ? 31 : rule.day,
      grace_days: agreement.grace_days ?? null,
      late_fee_policy: agreement.late_fee_policy ?? { kind: 'unknown' },
      coverage_end: agreement.term_end,
      follows_lease: true,
    },
    errors: [],
  };
}

export interface BillingDifference {
  field:
    | 'amount_cents'
    | 'currency'
    | 'due_rule'
    | 'grace_days'
    | 'late_fee_policy'
    | 'coverage_end';
  lease: unknown;
  billing: unknown;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Each billing term that differs from the lease; empty while billing follows the lease. */
export function billingDifferences(agreement: Agreement, rent: Json): BillingDifference[] {
  if (rent.decision !== 'configure' || rent.follows_lease !== false) return [];
  const billingRule = (rent.billing_due_rule as DueRule | undefined) ?? {
    kind: 'day_of_month',
    day: rent.due_day as number,
  };
  const pairs: BillingDifference[] = [
    { field: 'amount_cents', lease: agreement.rent_amount_cents, billing: rent.amount_cents },
    { field: 'currency', lease: agreement.rent_currency, billing: rent.currency },
    {
      field: 'due_rule',
      lease: agreement.rent_due_rule ?? { kind: 'unknown' },
      billing: billingRule,
    },
    { field: 'grace_days', lease: agreement.grace_days ?? null, billing: rent.grace_days ?? null },
    {
      field: 'late_fee_policy',
      lease: agreement.late_fee_policy ?? { kind: 'unknown' },
      billing: rent.late_fee_policy ?? { kind: 'unknown' },
    },
    { field: 'coverage_end', lease: agreement.term_end, billing: rent.coverage_end ?? null },
  ];
  return pairs.filter((pair) => !same(pair.lease, pair.billing));
}

export interface DepositAnswer {
  amount_cents: number | null;
  paid?: 'not_yet' | 'yes' | 'part';
  payment?: {
    amount_cents?: number;
    method: string;
    received_at?: string;
    reference?: string;
  };
}
export const DEPOSIT_CHARGE_KEY = 'deposit';
export const DEPOSIT_PAYMENT_KEY = 'deposit_payment';
/**
 * One deposit amount plus one answer becomes the lease term, the deposit charge
 * (due at lease start, or today when the lease already started) and any payment.
 */
export function expandDepositAnswer(
  setup: Json,
  answer: DepositAnswer,
  today: string,
): { setup: Json; errors: FieldError[] } {
  const agreement = setup.agreement as Agreement & Json;
  const billing = setup.billing as Json;
  const currency = agreement.rent_currency;
  const errors: FieldError[] = [];
  const payments = ((billing.payments as Json[]) ?? []).filter(
    (p) => p.draft_key !== DEPOSIT_PAYMENT_KEY,
  );
  const purposes = { ...((setup.receipt_purposes as Json) ?? {}) };
  delete purposes[DEPOSIT_PAYMENT_KEY];
  const base = (knowledge: string, cents: number, deposit: Json): Json => ({
    ...setup,
    agreement: {
      ...agreement,
      deposit_amount_cents: cents,
      deposit_currency: currency,
      deposit_knowledge: knowledge,
    },
    billing: { ...billing, deposit, payments },
    receipt_purposes: purposes,
  });
  if (answer.amount_cents === null)
    return { setup: base('unknown', 0, { decision: 'defer' }), errors };
  if (answer.amount_cents < 0)
    return {
      setup,
      errors: [{ code: 'amount.positive', step: 'lease', field: 'deposit_answer.amount_cents' }],
    };
  if (answer.amount_cents === 0) return { setup: base('none', 0, { decision: 'defer' }), errors };
  const due = agreement.term_start > today ? agreement.term_start : today;
  const next = base('amount', answer.amount_cents, {
    decision: 'record',
    draft_key: DEPOSIT_CHARGE_KEY,
    amount_cents: answer.amount_cents,
    currency,
    due_date: due,
  });
  const paid = answer.paid ?? 'not_yet';
  if (paid === 'not_yet') return { setup: next, errors };
  const payment = answer.payment;
  const cents = paid === 'yes' ? answer.amount_cents : payment?.amount_cents;
  if (!payment?.method)
    errors.push({
      code: 'deposit.payment_method_missing',
      step: 'lease',
      field: 'deposit_answer.payment.method',
    });
  if (!cents || cents <= 0 || (paid === 'part' && cents >= answer.amount_cents))
    errors.push({
      code: 'deposit.payment_amount_invalid',
      step: 'lease',
      field: 'deposit_answer.payment.amount_cents',
    });
  if (errors.length) return { setup, errors };
  const nextBilling = next.billing as Json;
  nextBilling.payments = [
    ...payments,
    {
      draft_key: DEPOSIT_PAYMENT_KEY,
      amount_cents: cents,
      currency,
      received_at: payment!.received_at ?? today,
      method: payment!.method,
      entry_source: 'entered_at_setup',
      ...(payment!.reference ? { reference: payment!.reference } : {}),
      allocations: [{ charge_key: DEPOSIT_CHARGE_KEY, amount_cents: cents }],
    },
  ];
  (next.receipt_purposes as Json)[DEPOSIT_PAYMENT_KEY] = 'deposit';
  return { setup: next, errors };
}

interface HistoryPeriod {
  cycle_key?: string;
  period_start: string | null;
  period_end: string | null;
  due_date: string;
}
/** Past rent steps become explicit period amounts on the cycles they cover. */
export function rentStepOverrides(
  agreement: Agreement,
  steps: readonly RentStep[],
  scheduleAmount: number,
  periods: readonly HistoryPeriod[],
  existing: readonly Json[],
): Json[] {
  const schedule = [
    {
      effective_month: agreement.term_start.slice(0, 7),
      amount_cents: agreement.rent_amount_cents,
    },
    ...steps,
  ];
  const taken = new Set(existing.map((o) => o.cycle_key));
  const added: Json[] = [];
  for (const period of periods) {
    if (!period.cycle_key || !period.period_start || !period.period_end) continue;
    if (taken.has(period.cycle_key)) continue;
    const amount = rentFor(schedule, period.period_start.slice(0, 7));
    if (amount === null || amount === scheduleAmount) continue;
    const full =
      toDay(period.period_end) - toDay(period.period_start) + 1 >= daysInMonth(period.period_start);
    if (!full) continue; // a partial period is confirmed explicitly, at the step's rate
    added.push({
      cycle_key: period.cycle_key,
      period_start: period.period_start,
      period_end: period.period_end,
      due_date: period.due_date,
      amount_cents: amount,
      reason: `Rent in force from ${rentStepFrom(schedule, period.period_start.slice(0, 7))}`,
    });
  }
  return added;
}
function rentStepFrom(schedule: readonly RentStep[], month: string): string {
  let from = schedule[0]!.effective_month;
  for (const step of [...schedule].sort((a, b) =>
    a.effective_month.localeCompare(b.effective_month),
  )) {
    if (step.effective_month <= month) from = step.effective_month;
  }
  return from;
}

export function validateRentSteps(
  agreement: Agreement,
  steps: readonly RentStep[],
  month: string,
): FieldError[] {
  const errors: FieldError[] = [];
  const start = agreement.term_start.slice(0, 7);
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    const field = `rent_steps[${index}].effective_month`;
    if (step.effective_month <= start)
      errors.push({ code: 'rent_step.before_lease', step: 'lease', field });
    else if (step.effective_month > month)
      errors.push({ code: 'rent_step.future', step: 'lease', field });
    else if (seen.has(step.effective_month))
      errors.push({ code: 'rent_step.duplicate', step: 'lease', field });
    seen.add(step.effective_month);
  });
  return errors;
}

/** Partial-period amount suggestions for each cycle the preview asks to confirm. */
export function prorationSuggestions(
  review: { findings?: Json[]; history_periods?: HistoryPeriod[] },
  monthlyCents: number | ((month: string) => number),
  method: ProrationMethod,
): Array<{
  cycle_key: string;
  period_start: string;
  period_end: string;
  days: number;
  base: number;
  amount_cents: number;
  method: ProrationMethod;
}> {
  const cycles = new Set(
    (review.findings ?? [])
      .map((f) => String(f.rule_id ?? ''))
      .filter((id) => /^(final_)?partial_period:/.test(id))
      .map((id) => id.slice(id.indexOf(':') + 1)),
  );
  return (review.history_periods ?? [])
    .filter((p) => p.cycle_key && cycles.has(p.cycle_key) && p.period_start && p.period_end)
    .map((p) => {
      const monthly =
        typeof monthlyCents === 'function'
          ? monthlyCents(p.period_start!.slice(0, 7))
          : monthlyCents;
      const r = prorate(monthly, p.period_start!, p.period_end!, method);
      return {
        cycle_key: p.cycle_key!,
        period_start: p.period_start!,
        period_end: p.period_end!,
        days: r.days,
        base: r.base,
        amount_cents: r.cents,
        method,
      };
    });
}

/** Whether a period amount is the server's suggestion or the landlord's own. */
export function overrideAmountSource(
  override: { period_start: string; period_end: string; amount_cents: number },
  monthlyCents: number,
  method: ProrationMethod,
): 'suggested' | 'landlord' {
  const days = toDay(override.period_end) - toDay(override.period_start) + 1;
  const partial = days < daysInMonth(override.period_start);
  const suggested = partial
    ? prorate(monthlyCents, override.period_start, override.period_end, method).cents
    : monthlyCents;
  return override.amount_cents === suggested ? 'suggested' : 'landlord';
}

const ISO_CURRENCIES = new Set<string>(Intl.supportedValuesOf('currency'));
/** Checks that need no database, reported all at once. */
export function validateSetupShape(setup: Json): FieldError[] {
  const errors: FieldError[] = [];
  const agreement = setup.agreement as Agreement;
  const tenancy = setup.tenancy as { start_date: string; end_date: string | null };
  const rent = (setup.billing as Json).rent as Json;
  if (agreement.term_end && agreement.term_end < agreement.term_start)
    errors.push({
      code: 'lease.end_before_start',
      step: 'lease',
      field: 'agreement.term_end',
      meta: { start: agreement.term_start },
    });
  if (tenancy.end_date && tenancy.end_date < tenancy.start_date)
    errors.push({
      code: 'lease.end_before_start',
      step: 'lease',
      field: 'tenancy.end_date',
      meta: { start: tenancy.start_date },
    });
  for (const [field, code] of [
    ['agreement.rent_currency', agreement.rent_currency],
    ['agreement.deposit_currency', agreement.deposit_currency],
    ...(rent.decision === 'configure' ? [['billing.rent.currency', rent.currency as string]] : []),
  ] as Array<[string, string]>) {
    if (!ISO_CURRENCIES.has(code))
      errors.push({ code: 'currency.unsupported', step: 'lease', field, meta: { value: code } });
  }
  return errors;
}

/** Zod issues on a setup body as field errors (letters in rent, a bad currency, a missing name). */
export function fieldErrorsFromIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; code: string; received?: unknown }>,
): FieldError[] {
  return issues.map((issue) => {
    const path = issue.path
      .join('.')
      .replace(/\.(\d+)(?=\.|$)/g, '[$1]')
      .replace(/^setup\./, '');
    const leaf = String(issue.path[issue.path.length - 1] ?? '');
    const step: SetupStep = path.startsWith('people')
      ? 'who'
      : path.includes('payments')
        ? 'catchup'
        : 'lease';
    if (/amount_cents$/.test(leaf)) {
      const missing =
        issue.code === 'invalid_type' &&
        (issue.received === 'undefined' || issue.received === 'null');
      const rent = /rent_amount_cents$|rent\.amount_cents$/.test(path);
      if (rent) return { code: missing ? 'rent.missing' : 'rent.not_a_number', step, field: path };
      return {
        code: issue.code === 'too_small' ? 'amount.positive' : 'amount.not_a_number',
        step,
        field: path,
      };
    }
    if (/currency$/.test(leaf)) return { code: 'currency.unsupported', step, field: path };
    if (leaf === 'earlier_receipts')
      return { code: 'opening.receipt_answer_invalid', step: 'catchup', field: path };
    if (leaf === 'full_name') return { code: 'person.name_missing', step, field: path };
    if (leaf === 'emails' || /emails\[\d+\]$/.test(path))
      return { code: 'person.email_invalid', step, field: path };
    if (leaf === 'phones' || /phones\[\d+\]$/.test(path))
      return { code: 'person.phone_invalid', step, field: path };
    if (/(term_start|term_end|start_date|end_date)$/.test(leaf))
      return { code: 'date.invalid', step, field: path };
    return { code: `field.${issue.code}`, step, field: path };
  });
}

// Every validation the setup preview/commit can raise, keyed by its stable message.
const DB_ERRORS: Array<[RegExp, Omit<FieldError, 'meta'>]> = [
  [/add at least one person/, { code: 'people.missing', step: 'who', field: 'people' }],
  [/enter each person/, { code: 'person.name_missing', step: 'who', field: 'people' }],
  [/same person was added twice/, { code: 'person.duplicate_entry', step: 'who', field: 'people' }],
  [
    /check move-in and planned ending dates/,
    { code: 'lease.end_before_start', step: 'lease', field: 'tenancy.end_date' },
  ],
  [
    /check the agreed rent and lease terms/,
    { code: 'lease.terms_invalid', step: 'lease', field: 'agreement' },
  ],
  [
    /say what changed/,
    { code: 'lease.change_reason_missing', step: 'lease', field: 'change_reason' },
  ],
  [
    /select a confirmed agreement|select an agreement action|select the predecessor agreement|use correction or renewal/,
    { code: 'lease.agreement_action_invalid', step: 'lease', field: 'agreement.change_kind' },
  ],
  [
    /selected lease is outside this tenancy/,
    { code: 'lease.not_in_tenancy', step: 'lease', field: 'agreement.id' },
  ],
  [
    /confirm the agreement before using it/,
    { code: 'lease.draft', step: 'lease', field: 'agreement' },
  ],
  [
    /confirm a calculable monthly due rule/,
    { code: 'rent.due_day_missing', step: 'lease', field: 'billing.rent.due_day' },
  ],
  [
    /unsupported short-month policy/,
    {
      code: 'rent.short_month_policy_invalid',
      step: 'lease',
      field: 'billing.rent.short_month_policy',
    },
  ],
  [
    /incomplete or unsupported recurring instruction/,
    { code: 'rent.invalid', step: 'lease', field: 'billing.rent' },
  ],
  [
    /invalid coverage interval or regular anchor/,
    { code: 'rent.coverage_invalid', step: 'lease', field: 'billing.rent.coverage_start' },
  ],
  [
    /manual billing requires a recorded basis/,
    { code: 'rent.basis_missing', step: 'lease', field: 'billing.rent.manual_basis' },
  ],
  [
    /notice must be served/,
    { code: 'rent.notice_invalid', step: 'lease', field: 'billing.rent.source_notice_id' },
  ],
  [
    /deposit obligation requires/,
    { code: 'deposit.invalid', step: 'lease', field: 'billing.deposit' },
  ],
  [
    /opening balance needs a virgin timeline/,
    { code: 'opening.not_allowed', step: 'catchup', field: 'billing.rent.opening_balance' },
  ],
  [
    /opening balance and itemized history are exclusive/,
    { code: 'opening.with_itemized', step: 'catchup', field: 'billing.rent.opening_balance' },
  ],
  [
    /say whether the amount owed includes this month/,
    {
      code: 'opening.current_rent_unanswered',
      step: 'catchup',
      field: 'billing.rent.opening_balance.includes_current_rent',
    },
  ],
  [
    /only an amount owed says whether/,
    {
      code: 'opening.current_rent_not_applicable',
      step: 'catchup',
      field: 'billing.rent.opening_balance.includes_current_rent',
    },
  ],
  [
    /choose billing coverage that includes this month/,
    {
      code: 'opening.current_rent_outside_coverage',
      step: 'catchup',
      field: 'billing.rent.coverage_start',
    },
  ],
  [
    /amount owed from before itemized months needs/,
    {
      code: 'opening.itemized_not_allowed',
      step: 'catchup',
      field: 'billing.rent.opening_balance',
    },
  ],
  [
    /start itemizing from a past or current month|start itemizing after the first billed month/,
    {
      code: 'opening.itemize_from_invalid',
      step: 'catchup',
      field: 'billing.rent.opening_balance.itemize_from',
    },
  ],
  [
    /each earlier-receipt answer names one receipt/,
    {
      code: 'opening.receipt_answer_invalid',
      step: 'catchup',
      field: 'billing.rent.opening_balance.earlier_receipts',
    },
  ],
  [
    /payment before the itemized months/,
    { code: 'payment.before_itemized', step: 'catchup', field: 'billing.payments' },
  ],
  [
    /selected month is covered by the amount owed from before/,
    { code: 'catchup.cycle_before_itemized', step: 'catchup', field: 'billing.rent.charge_keys' },
  ],
  [
    /at most 120 historical billing cycles/,
    { code: 'catchup.too_many_cycles', step: 'catchup', field: 'billing.rent.coverage_start' },
  ],
  [
    /duplicate selected cycle|selected cycle outside schedule coverage|invalid or duplicate charge draft key/,
    { code: 'catchup.cycle_invalid', step: 'catchup', field: 'billing.rent.charge_keys' },
  ],
  [
    /selected partial cycle needs a confirmed override/,
    { code: 'partial.amount_missing', step: 'catchup', field: 'billing.rent.period_overrides' },
  ],
  [
    /duplicate override cycle|override outside coverage/,
    { code: 'catchup.override_invalid', step: 'catchup', field: 'billing.rent.period_overrides' },
  ],
  [
    /invalid receipt|receipt\/allocation arrays/,
    { code: 'payment.invalid', step: 'catchup', field: 'billing.payments' },
  ],
  [
    /allocations exceed receipt/,
    { code: 'payment.over_allocated', step: 'catchup', field: 'billing.payments' },
  ],
  [
    /allocations exceed charge balance/,
    { code: 'payment.over_charge', step: 'catchup', field: 'billing.payments' },
  ],
  [
    /allocations exceed existing credit|existing credit outside tenancy/,
    { code: 'payment.credit_invalid', step: 'catchup', field: 'billing.credit_allocations' },
  ],
  [
    /allocation requires one charge reference|allocation target missing or currency mismatch|charge reference did not create an obligation/,
    { code: 'payment.allocation_invalid', step: 'catchup', field: 'billing.payments' },
  ],
  [
    /initial billing setup is required|requires a complete successor|successor needs a confirmed agreement|successor cannot re-found/,
    { code: 'rent.transition_invalid', step: 'lease', field: 'billing.rent' },
  ],
  [/invalid billing setup intent/, { code: 'billing.invalid', step: 'lease', field: 'billing' }],
  [
    /review all elapsed\/partial periods/,
    { code: 'catchup.period_unreviewed', step: 'catchup', field: 'billing.rent.charge_keys' },
  ],
  [
    /confirm the reviewed setup and listed differences/,
    { code: 'confirm.not_accepted', step: 'confirm', field: 'accept_warnings' },
  ],
];

/** A setup preview/commit validation failure as field errors, or null when it is not one. */
export function fieldErrorsFromDb(error: {
  code?: string;
  message?: string;
  details?: string;
}): FieldError[] | null {
  const message = (error.message ?? '').trim();
  if (error.code === 'PT409' && message.startsWith('setup_person_contact_conflict')) {
    const d = (error.details ? JSON.parse(error.details) : {}) as {
      personIndex?: number;
      field?: string;
      tenantId?: string;
    };
    const kind = d.field === 'phone' ? 'phone' : 'email';
    return [
      {
        code: d.tenantId ? `person.duplicate_${kind}` : `person.duplicate_${kind}_in_setup`,
        step: 'who',
        field: `people[${d.personIndex ?? 0}].${kind}s`,
        meta: d.tenantId ? { personId: d.tenantId } : {},
      },
    ];
  }
  if (!message.startsWith('invalid:')) return null;
  const match = DB_ERRORS.find(([pattern]) => pattern.test(message));
  return [
    match
      ? { ...match[1] }
      : { code: 'setup.invalid', step: 'confirm', field: '', meta: { message } },
  ];
}

/** Blocking preview findings as field errors. */
export function fieldErrorsFromFindings(findings: readonly Json[]): FieldError[] {
  return findings
    .filter(
      (f) => f.severity === 'error' || (f.confirmation_required === true && f.confirmed !== true),
    )
    .map((f): FieldError => {
      const id = String(f.rule_id ?? '');
      const cycle = id.includes(':') ? id.slice(id.indexOf(':') + 1) : '';
      if (f.severity !== 'error')
        return {
          code: 'confirm.warning_unconfirmed',
          step: 'confirm',
          field: 'warning_acknowledgements',
          meta: { rule_id: id },
        };
      if (/^(final_)?partial_period:/.test(id))
        return {
          code: 'partial.amount_missing',
          step: 'catchup',
          field: 'billing.rent.period_overrides',
          meta: { cycle_key: cycle },
        };
      if (id.startsWith('opening_receipt_unanswered:')) {
        const values = (f.values ?? {}) as Json;
        return {
          code: 'opening.receipt_unanswered',
          step: 'catchup',
          field: 'billing.rent.opening_balance.earlier_receipts',
          meta: Object.fromEntries(
            Object.entries(values)
              .filter(([, v]) => v !== null && v !== undefined)
              .map(([k, v]) => [k, String(v)]),
          ),
        };
      }
      if (id.startsWith('history_review:'))
        return {
          code: 'catchup.period_unreviewed',
          step: 'catchup',
          field: 'billing.rent.charge_keys',
          meta: { cycle_key: cycle },
        };
      if (id.startsWith('reason_required:'))
        return {
          code: 'confirm.reason_missing',
          step: 'confirm',
          field: 'billing.explanations',
          meta: { rule_id: cycle },
        };
      return { code: `finding.${id}`, step: 'confirm', field: '', meta: { rule_id: id } };
    });
}
