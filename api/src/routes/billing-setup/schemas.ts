import { z } from '@hono/zod-openapi';
import { CalendarDate } from '../../schemas/calendar-date';
import { ClockBasis } from '../../schemas/time-zone';
import { LateFeePolicy, RentDueRule } from '../../schemas/lease-terms';
import { OnboardingProgress } from '../tenancies/onboarding';
import { WarningAcknowledgements } from '../tenancies/date-warnings';
const DraftKey = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const Currency = z.string().length(3);
const CycleKey = z.string().regex(/^\d{4}-\d{2}$/);
export const PeriodOverride = z
  .object({
    amount_source: z.enum(['suggested', 'landlord']).optional().openapi({
      description:
        'Set by the server: suggested when the amount equals the proration suggestion, landlord otherwise.',
    }),
    cycle_key: CycleKey,
    period_start: CalendarDate,
    period_end: CalendarDate,
    due_date: CalendarDate,
    amount_cents: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
const ConfigureRent = z
  .object({
    decision: z.literal('configure'),
    source_lease_id: z.string().uuid().optional(),
    source_notice_id: z.string().uuid().optional(),
    coverage_start: CalendarDate,
    coverage_end: CalendarDate.nullable().optional(),
    regular_anchor: CalendarDate,
    due_day: z.number().int().min(1).max(31),
    billing_due_rule: RentDueRule.optional(),
    short_month_policy: z.enum(['last_day', 'manual']).optional(),
    amount_cents: z.number().int().nonnegative(),
    currency: Currency,
    grace_days: z.number().int().min(0).max(2147483647).nullable().optional(),
    late_fee_policy: LateFeePolicy.optional(),
    manual_basis: z.string().trim().min(1).max(2000).optional(),
    period_overrides: z.array(PeriodOverride).max(120).default([]),
    history_mode: z.enum(['itemized', 'opening_balance']).default('itemized'),
    opening_balance: z
      .object({
        amount_cents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
        basis: z.string().trim().min(1).max(200).optional().openapi({
          description:
            'What the amount is for. Required unless the amount owed from before itemized months is 0.',
        }),
        includes_current_rent: z.boolean().optional(),
        itemize_from: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional()
          .openapi({
            description:
              'With history_mode itemized: the first itemized month. The amount is owed from before that month and is dated the day before it.',
          }),
        earlier_receipts: z
          .array(
            z
              .object({
                payment_key: DraftKey,
                choice: z.enum(['add_to_owed', 'keep_owed']),
              })
              .strict(),
          )
          .max(200)
          .refine((answers) => new Set(answers.map((a) => a.payment_key)).size === answers.length, {
            message: 'answer each earlier receipt once',
          })
          .optional()
          .openapi({
            description:
              'One answer per receipt dated before itemize_from (or with an unknown date). add_to_owed: the typed amount was already net of the receipt, so the opening entry is amount + receipt. keep_owed: the opening entry is the typed amount. Either way the receipt is applied to it.',
          }),
      })
      .strict()
      .optional(),
    charge_keys: z
      .array(z.object({ cycle_key: CycleKey, draft_key: DraftKey }).strict())
      .max(120)
      .default([]),
    follows_lease: z.boolean().optional().openapi({
      description:
        'True: setup derives amount, currency, due rule, grace, late fee and coverage end from the agreement. False: billing differs on purpose. Omitted: billing is used as sent.',
    }),
  })
  .strict();
const RentIntent = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('defer') }).strict(),
  z.object({ decision: z.literal('keep') }).strict(),
  ConfigureRent,
]);
const DepositIntent = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('defer') }).strict(),
  z.object({ decision: z.literal('keep') }).strict(),
  z
    .object({
      decision: z.literal('record'),
      draft_key: DraftKey,
      amount_cents: z.number().int().positive(),
      currency: Currency,
      due_date: CalendarDate,
      description: z.string().max(2000).optional(),
    })
    .strict(),
]);
const Allocation = z
  .object({
    charge_key: DraftKey.optional(),
    charge_id: z.string().uuid().optional(),
    amount_cents: z.number().int().positive(),
  })
  .strict()
  .refine((a) => Boolean(a.charge_key) !== Boolean(a.charge_id), {
    message: 'exactly one charge reference required',
  });
const Payment = z
  .object({
    draft_key: DraftKey,
    amount_cents: z.number().int().positive(),
    currency: Currency,
    received_at: z
      .union([CalendarDate, z.string().datetime({ offset: true })])
      .nullable()
      .openapi({
        description:
          'Actual receipt date or timestamp. A calendar date is stored at noon UTC to preserve the entered day.',
      }),
    method: z.enum(['cash', 'check', 'ach', 'card', 'zelle_venmo', 'money_order', 'other']),
    receipt_date_unknown: z.boolean().optional(),
    entry_source: z.enum(['manual', 'entered_at_setup', 'import']).optional(),
    payer_tenant_id: z.string().uuid().optional().openapi({
      description: 'Who paid. Setup fills it in for a one-person tenancy; omit when unsure.',
    }),
    purpose: z.enum(['rent', 'deposit']).optional().openapi({
      description:
        'What the receipt pays; omitted means rent. Only a rent receipt dated before opening_balance.itemize_from is an earlier receipt. Tenancy setup sets it from receipt_purposes.',
    }),
    reference: z.string().max(500).optional(),
    notes: z.string().max(2000).optional(),
    allocations: z.array(Allocation).max(120).default([]),
  })
  .strict();
export const BillingSetupIntent = z
  .object({
    warning_acknowledgements: WarningAcknowledgements,
    rent: RentIntent,
    deposit: DepositIntent,
    payments: z.array(Payment).max(200).default([]),
    credit_allocations: z
      .array(
        z
          .object({
            payment_id: z.string().uuid(),
            charge_key: DraftKey.optional(),
            charge_id: z.string().uuid().optional(),
            amount_cents: z.number().int().positive(),
          })
          .strict()
          .refine((a) => Boolean(a.charge_key) !== Boolean(a.charge_id), {
            message: 'exactly one charge reference required',
          }),
      )
      .max(200)
      .default([]),
    explanations: z
      .array(
        z
          .object({
            rule_id: z.string().min(1).max(100),
            reason: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict()
  .openapi('BillingSetupIntent');
export const BillingSetupCommit = BillingSetupIntent.extend({
  expected_context: z.string().min(1).max(256),
}).openapi('BillingSetupCommit');
// A future-month rent change resting on the landlord's own statement (ADR-0012
// amendment). The other billing terms carry over from the schedule in force.
export const LandlordRentChange = z
  .object({
    rent_change: z
      .object({
        basis: z
          .object({
            kind: z.literal('landlord_statement'),
            note: z.string().trim().min(1).max(2000).optional(),
          })
          .strict(),
        effective_month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .openapi({
            description:
              "First month at the new rent; must be after the current month in the account's time zone.",
          }),
        amount_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    warning_acknowledgements: WarningAcknowledgements,
  })
  .strict()
  .openapi('LandlordRentChange');
export const BillingTransitionIntent = z
  .union([BillingSetupIntent, LandlordRentChange])
  .openapi('BillingTransitionIntent');
export const BillingTransitionCommit = z
  .union([
    BillingSetupCommit,
    LandlordRentChange.extend({ expected_context: z.string().min(1).max(256) }),
  ])
  .openapi('BillingTransitionCommit');
export const ChargeCandidate = z.object({
  draft_key: z.string(),
  cycle_key: z.string().optional(),
  type: z.enum(['rent', 'deposit']),
  period_start: CalendarDate.nullable(),
  period_end: CalendarDate.nullable(),
  due_date: CalendarDate,
  amount_cents: z.number().int().nonnegative(),
  currency: Currency,
  reason: z.string().nullable().optional(),
  is_elapsed: z.boolean().optional(),
});
export const BillingSetupPreview = z
  .object({
    version: z.literal(1),
    as_of_date: CalendarDate,
    clock_basis: ClockBasis,
    context_fingerprint: z.string(),
    mode: z.enum([
      'initial',
      'initial_rent_existing_money',
      'existing_rent',
      'deposit_only',
      'deferred',
    ]),
    auto_charge_enabled: z.boolean(),
    charge_candidates: z.array(ChargeCandidate),
    history_periods: z.array(ChargeCandidate),
    findings: z.array(
      z.object({
        rule_id: z.string(),
        severity: z.enum(['review', 'error', 'info']).openapi({
          description:
            'info is explanatory only: it needs no acknowledgement or reason and never blocks.',
        }),
        message: z.string(),
        reason_required: z.boolean(),
        version: z.number().int().optional(),
        fields: z.array(z.string()).optional(),
        values: z.record(z.unknown()).optional(),
        relationship_fingerprint: z.string().optional(),
        explained: z.boolean().optional(),
        confirmation_required: z.boolean().optional(),
        confirmed: z.boolean().optional(),
        subject: z
          .object({
            type: z.enum(['tenancy', 'ending', 'payment']),
            id: z.string().uuid().optional(),
            draft_key: z.string().optional(),
          })
          .optional(),
      }),
    ),
    existing: z.object({
      schedules: z.array(
        z.object({
          id: z.string().uuid(),
          start_date: CalendarDate,
          end_date: CalendarDate.nullable(),
          amount_cents: z.number().int(),
          currency: Currency,
          deleted_at: z.string().nullable(),
          period_policy_version: z.number().int(),
          source_lease_id: z.string().uuid().nullable(),
          terms_snapshot: z.record(z.unknown()),
        }),
      ),
      charges: z.array(
        z.object({
          id: z.string().uuid(),
          type: z.string(),
          amount_cents: z.number().int(),
          currency: Currency,
          due_date: CalendarDate,
          period_start: CalendarDate.nullable(),
          period_end: CalendarDate.nullable(),
          source_schedule_id: z.string().uuid().nullable(),
          cycle_key: z.string().nullable(),
          balance_cents: z.number().int(),
          voided_at: z.string().nullable(),
          deleted_at: z.string().nullable(),
          terms_snapshot: z.record(z.unknown()).nullable(),
        }),
      ),
      payments: z.array(
        z.object({
          id: z.string().uuid(),
          amount_cents: z.number().int(),
          currency: Currency,
          received_at: z.string().nullable(),
          receipt_date_unknown: z.boolean(),
          method: z.string().nullable(),
          reference: z.string().nullable(),
          available_cents: z.number().int(),
          voided_at: z.string().nullable(),
          deleted_at: z.string().nullable(),
        }),
      ),
    }),
    terms_snapshot: z.record(z.unknown()).nullable(),
    can_commit: z.boolean(),
    next_scheduled_action: z.record(z.unknown()).nullable(),
    transition: z
      .object({
        ended_schedule_ids: z.array(z.string().uuid()),
        voided_charge_ids: z.array(z.string().uuid()),
      })
      .nullable(),
    opening_result: z
      .object({
        typed_cents: z.number().int(),
        opening_charge_cents: z.number().int(),
        opening_credit_cents: z.number().int(),
        answered_receipts_cents: z.number().int(),
        applied_cents: z.number().int(),
        still_owed_cents: z.number().int(),
        paid_ahead_cents: z.number().int(),
        unanswered_count: z.number().int(),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          'With opening_balance.itemize_from: the combined result of the amount owed from before and the answered earlier receipts, exactly as commit records it. Unanswered receipts are left out and counted.',
      }),
  })
  .openapi('BillingSetupPreview');
export const BillingSetupResult = z
  .object({
    schedule_id: z.string().uuid().nullable(),
    charge_ids: z.record(z.string().uuid()),
    payment_ids: z.record(z.string().uuid()),
    allocation_ids: z.array(z.string().uuid()),
    adoption_id: z.string().uuid().nullable(),
    progress: OnboardingProgress,
    ended_schedule_ids: z.array(z.string().uuid()),
    voided_charge_ids: z.array(z.string().uuid()),
    rent_schedule: z
      .object({
        id: z.string().uuid(),
        amount_cents: z.number().int(),
        currency: Currency,
        start_date: CalendarDate,
        end_date: CalendarDate.nullable(),
        due_day: z.number().int(),
        source_lease_id: z.string().uuid().nullable(),
        source_notice_id: z.string().uuid().nullable(),
        period_policy_version: z.number().int(),
        regular_anchor: CalendarDate.nullable(),
        terms_snapshot: z.record(z.unknown()),
      })
      .nullable(),
  })
  .openapi('BillingSetupResult');
