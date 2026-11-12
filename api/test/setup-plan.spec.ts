import { describe, expect, it } from 'vitest';
import {
  billingDifferences,
  deriveBillingFromLease,
  expandDepositAnswer,
  fieldErrorsFromDb,
  fieldErrorsFromFindings,
  fieldErrorsFromIssues,
  prorate,
  prorationSuggestions,
  rentFor,
  rentStepOverrides,
  validateRentSteps,
  validateSetupShape,
} from '../src/lib/setup-plan';

const lease = (overrides: Record<string, unknown> = {}) => ({
  term_start: '2026-12-01',
  term_end: '2027-11-30' as string | null,
  rent_amount_cents: 185000,
  rent_currency: 'USD',
  rent_due_rule: { kind: 'day_of_month', day: 1 },
  grace_days: 5,
  late_fee_policy: { kind: 'fixed', amount_cents: 7500, currency: 'USD' },
  deposit_amount_cents: 0,
  deposit_currency: 'USD',
  ...overrides,
});
const rentIntent = (overrides: Record<string, unknown> = {}) => ({
  decision: 'configure',
  coverage_start: '2026-12-01',
  regular_anchor: '2026-12-01',
  due_day: 1,
  amount_cents: 0,
  currency: 'USD',
  history_mode: 'itemized',
  ...overrides,
});

describe('prorate (WP-07)', () => {
  it('matches the plan examples', () => {
    expect(prorate(240000, '2026-10-15', '2026-10-31')).toEqual({
      cents: 131613,
      days: 17,
      base: 31,
    });
    expect(prorate(240000, '2027-10-01', '2027-10-14')).toEqual({
      cents: 108387,
      days: 14,
      base: 31,
    });
  });
  it('uses 29 days for February in a leap year', () => {
    expect(prorate(290000, '2028-02-15', '2028-02-29')).toEqual({
      cents: 150000,
      days: 15,
      base: 29,
    });
  });
  it('charges a full month in full', () => {
    expect(prorate(185000, '2026-11-01', '2026-11-30').cents).toBe(185000);
    expect(prorate(185000, '2026-11-01', '2026-11-30', 'thirty_day_month').cents).toBe(185000);
  });
  it('uses a 30-day month when asked', () => {
    expect(prorate(240000, '2026-10-15', '2026-10-31', 'thirty_day_month')).toEqual({
      cents: 136000,
      days: 17,
      base: 30,
    });
    expect(prorate(300000, '2026-02-01', '2026-02-10', 'thirty_day_month').cents).toBe(100000);
  });
  it('suggests an amount for each partial period the preview flags', () => {
    const review = {
      findings: [{ rule_id: 'partial_period:2026-10' }],
      history_periods: [
        {
          cycle_key: '2026-10',
          period_start: '2026-10-15',
          period_end: '2026-10-31',
          due_date: '2026-10-15',
        },
        {
          cycle_key: '2026-11',
          period_start: '2026-11-01',
          period_end: '2026-11-30',
          due_date: '2026-11-01',
        },
      ],
    };
    expect(prorationSuggestions(review, 240000, 'actual_days')).toEqual([
      {
        cycle_key: '2026-10',
        period_start: '2026-10-15',
        period_end: '2026-10-31',
        days: 17,
        base: 31,
        amount_cents: 131613,
        method: 'actual_days',
      },
    ]);
  });
});

describe('rentFor (WP-10)', () => {
  const steps = [
    { effective_month: '2019-03', amount_cents: 140000 },
    { effective_month: '2024-03', amount_cents: 147500 },
  ];
  it('returns nothing before the first step', () => expect(rentFor(steps, '2019-02')).toBeNull());
  it('uses each step from its month', () => {
    expect(rentFor(steps, '2019-03')).toBe(140000);
    expect(rentFor(steps, '2024-02')).toBe(140000);
    expect(rentFor(steps, '2024-03')).toBe(147500);
    expect(rentFor(steps, '2026-11')).toBe(147500);
  });
  it('turns past steps into explicit amounts for full cycles before the current rent', () => {
    const agreement = lease({
      term_start: '2019-03-01',
      rent_amount_cents: 140000,
      term_end: null,
    });
    const periods = [
      {
        cycle_key: '2024-02',
        period_start: '2024-02-01',
        period_end: '2024-02-29',
        due_date: '2024-02-01',
      },
      {
        cycle_key: '2024-03',
        period_start: '2024-03-01',
        period_end: '2024-03-31',
        due_date: '2024-03-01',
      },
    ];
    expect(rentStepOverrides(agreement, [steps[1]!], 147500, periods, [])).toEqual([
      { ...periods[0], amount_cents: 140000, reason: 'Rent in force from 2019-03' },
    ]);
  });
  it('rejects steps outside the past lease months', () => {
    const agreement = lease({ term_start: '2019-03-01' });
    expect(
      validateRentSteps(
        agreement,
        [
          { effective_month: '2019-03', amount_cents: 1 },
          { effective_month: '2030-01', amount_cents: 1 },
        ],
        '2026-11',
      ).map((e) => e.code),
    ).toEqual(['rent_step.before_lease', 'rent_step.future']);
  });
});

describe('deriveBillingFromLease (WP-04)', () => {
  it('derives every billing term from a lease starting on the 1st', () => {
    const { rent, errors } = deriveBillingFromLease(lease(), rentIntent({ follows_lease: true }));
    expect(errors).toEqual([]);
    expect(rent).toMatchObject({
      amount_cents: 185000,
      currency: 'USD',
      due_day: 1,
      billing_due_rule: { kind: 'day_of_month', day: 1 },
      grace_days: 5,
      late_fee_policy: { kind: 'fixed', amount_cents: 7500, currency: 'USD' },
      coverage_end: '2027-11-30',
      coverage_start: '2026-12-01',
    });
  });
  it('keeps the requested coverage start for a mid-month lease', () => {
    const { rent } = deriveBillingFromLease(
      lease({ term_start: '2026-10-15', rent_due_rule: { kind: 'day_of_month', day: 15 } }),
      rentIntent({
        coverage_start: '2026-10-15',
        regular_anchor: '2026-10-15',
        follows_lease: true,
      }),
    );
    expect(rent).toMatchObject({
      coverage_start: '2026-10-15',
      due_day: 15,
      coverage_end: '2027-11-30',
    });
  });
  it('bills open-ended for a month-to-month lease and uses the step in force', () => {
    const { rent } = deriveBillingFromLease(
      lease({ term_start: '2019-03-01', term_end: null, rent_amount_cents: 140000 }),
      rentIntent({ follows_lease: true }),
      [{ effective_month: '2024-03', amount_cents: 147500 }],
      '2026-11',
    );
    expect(rent).toMatchObject({ coverage_end: null, amount_cents: 147500 });
  });
  it('requires a due day once tracking is on (WP-06)', () => {
    const { errors } = deriveBillingFromLease(
      lease({ rent_due_rule: { kind: 'unknown' } }),
      rentIntent({ follows_lease: true }),
    );
    expect(errors).toEqual([
      { code: 'rent.due_day_missing', step: 'lease', field: 'agreement.rent_due_rule' },
    ]);
  });
  it('lists each billing term that differs only when billing does not follow the lease', () => {
    const differs = rentIntent({
      follows_lease: false,
      amount_cents: 190000,
      grace_days: 5,
      coverage_end: '2027-11-30',
      late_fee_policy: { kind: 'fixed', amount_cents: 7500, currency: 'USD' },
    });
    expect(billingDifferences(lease(), differs)).toEqual([
      { field: 'amount_cents', lease: 185000, billing: 190000 },
    ]);
    expect(billingDifferences(lease(), { ...differs, follows_lease: true })).toEqual([]);
  });
});

describe('expandDepositAnswer (WP-05)', () => {
  const setup = () => ({
    agreement: lease(),
    billing: { rent: rentIntent(), deposit: { decision: 'defer' }, payments: [] },
    receipt_purposes: {},
  });
  it('blank means an unknown deposit and nothing recorded', () => {
    const { setup: out } = expandDepositAnswer(setup(), { amount_cents: null }, '2026-11-11');
    expect(out.agreement).toMatchObject({ deposit_knowledge: 'unknown', deposit_amount_cents: 0 });
    expect((out.billing as { deposit: unknown }).deposit).toEqual({ decision: 'defer' });
  });
  it('0 means no deposit', () => {
    const { setup: out } = expandDepositAnswer(setup(), { amount_cents: 0 }, '2026-11-11');
    expect(out.agreement).toMatchObject({ deposit_knowledge: 'none', deposit_amount_cents: 0 });
  });
  it('not yet records a charge due at a future lease start', () => {
    const { setup: out } = expandDepositAnswer(
      setup(),
      { amount_cents: 185000, paid: 'not_yet' },
      '2026-11-11',
    );
    expect((out.billing as { deposit: unknown }).deposit).toEqual({
      decision: 'record',
      draft_key: 'deposit',
      amount_cents: 185000,
      currency: 'USD',
      due_date: '2026-12-01',
    });
    expect((out.billing as { payments: unknown[] }).payments).toEqual([]);
  });
  it('is due today when the lease already started', () => {
    const started = { ...setup(), agreement: lease({ term_start: '2026-10-15' }) };
    const { setup: out } = expandDepositAnswer(started, { amount_cents: 100000 }, '2026-11-11');
    expect((out.billing as { deposit: { due_date: string } }).deposit.due_date).toBe('2026-11-11');
  });
  it('yes records the full payment applied to the deposit, dated today by default', () => {
    const { setup: out, errors } = expandDepositAnswer(
      setup(),
      { amount_cents: 185000, paid: 'yes', payment: { method: 'check' } },
      '2026-11-11',
    );
    expect(errors).toEqual([]);
    expect((out.billing as { payments: unknown[] }).payments).toEqual([
      {
        draft_key: 'deposit_payment',
        amount_cents: 185000,
        currency: 'USD',
        received_at: '2026-11-11',
        method: 'check',
        entry_source: 'entered_at_setup',
        allocations: [{ charge_key: 'deposit', amount_cents: 185000 }],
      },
    ]);
    expect(out.receipt_purposes).toEqual({ deposit_payment: 'deposit' });
  });
  it('part of it needs a smaller amount and a method', () => {
    expect(
      expandDepositAnswer(
        setup(),
        { amount_cents: 185000, paid: 'part', payment: { method: 'cash', amount_cents: 185000 } },
        '2026-11-11',
      ).errors.map((e) => e.code),
    ).toEqual(['deposit.payment_amount_invalid']);
    const { setup: out } = expandDepositAnswer(
      setup(),
      {
        amount_cents: 185000,
        paid: 'part',
        payment: { method: 'cash', amount_cents: 50000, received_at: '2026-11-01' },
      },
      '2026-11-11',
    );
    expect(
      (out.billing as { payments: Array<{ amount_cents: number; received_at: string }> })
        .payments[0],
    ).toMatchObject({ amount_cents: 50000, received_at: '2026-11-01' });
  });
});

describe('setup field errors (WP-01)', () => {
  it('maps the plan codes', () => {
    expect(
      fieldErrorsFromDb({
        code: 'PT409',
        message: 'setup_person_contact_conflict',
        details: '{"personIndex":1,"field":"email","tenantId":"t1"}',
      }),
    ).toEqual([
      {
        code: 'person.duplicate_email',
        step: 'who',
        field: 'people[1].emails',
        meta: { personId: 't1' },
      },
    ]);
    expect(
      fieldErrorsFromDb({
        code: 'PT409',
        message: 'setup_person_contact_conflict',
        details: '{"personIndex":0,"field":"phone","tenantId":"t2"}',
      })![0]!.code,
    ).toBe('person.duplicate_phone');
    expect(
      validateSetupShape({
        agreement: lease({
          term_start: '2027-01-01',
          term_end: '2026-12-01',
          rent_currency: 'DOL',
        }),
        tenancy: { start_date: '2027-01-01', end_date: null },
        billing: { rent: { decision: 'defer' } },
      }).map((e) => e.code),
    ).toEqual(['lease.end_before_start', 'currency.unsupported']);
    expect(
      fieldErrorsFromIssues([
        {
          path: ['setup', 'agreement', 'rent_amount_cents'],
          code: 'invalid_type',
          received: 'string',
        },
        { path: ['agreement', 'rent_amount_cents'], code: 'invalid_type', received: 'undefined' },
      ]).map((e) => [e.code, e.field]),
    ).toEqual([
      ['rent.not_a_number', 'agreement.rent_amount_cents'],
      ['rent.missing', 'agreement.rent_amount_cents'],
    ]);
  });
  it('gives every known database validation a stable code and unknown ones a generic code', () => {
    expect(
      fieldErrorsFromDb({ message: 'invalid: check move-in and planned ending dates' }),
    ).toEqual([{ code: 'lease.end_before_start', step: 'lease', field: 'tenancy.end_date' }]);
    expect(
      fieldErrorsFromDb({
        message: "invalid: say whether the amount owed includes this month's rent",
      })![0]!.code,
    ).toBe('opening.current_rent_unanswered');
    expect(fieldErrorsFromDb({ message: 'invalid: something new' })![0]).toMatchObject({
      code: 'setup.invalid',
      step: 'confirm',
    });
    expect(fieldErrorsFromDb({ message: 'conflict: setup already completed' })).toBeNull();
  });
  it('turns blocking findings into fixable fields', () => {
    expect(
      fieldErrorsFromFindings([
        { rule_id: 'partial_period:2026-10', severity: 'error' },
        {
          rule_id: 'billing_terms_differ',
          severity: 'review',
          confirmation_required: true,
          confirmed: false,
        },
        { rule_id: 'billing_terms_differ', severity: 'review' },
      ]),
    ).toEqual([
      {
        code: 'partial.amount_missing',
        step: 'catchup',
        field: 'billing.rent.period_overrides',
        meta: { cycle_key: '2026-10' },
      },
      {
        code: 'confirm.warning_unconfirmed',
        step: 'confirm',
        field: 'warning_acknowledgements',
        meta: { rule_id: 'billing_terms_differ' },
      },
    ]);
  });
});
