import { z } from '@hono/zod-openapi';
import { CalendarDate } from '../../schemas/calendar-date';
import { LeaseTermsFields, LateFeePolicy } from '../../schemas/lease-terms';
import { BillingSetupIntent, BillingSetupPreview } from '../billing-setup/schemas';

export const FieldErrorSchema = z
  .object({
    code: z.string(),
    step: z.enum(['who', 'lease', 'catchup', 'confirm']),
    field: z.string(),
    meta: z.record(z.string()).optional(),
  })
  .openapi('SetupFieldError');
export const SetupParam = z.object({ accountId: z.string().uuid(), id: z.string().uuid() });
export const SetupAccount = z.object({ accountId: z.string().uuid() });
export const SetupPerson = z
  .object({
    key: z.string().uuid(),
    tenant_id: z.string().uuid().optional(),
    full_name: z.string().trim().min(1).max(200),
    phones: z
      .array(z.string().regex(/^\+[1-9]\d{6,14}$/))
      .max(5)
      .default([]),
    emails: z.array(z.string().email()).max(5).default([]),
  })
  .strict();
export const SetupAgreement = z
  .object({
    ...LeaseTermsFields,
    id: z.string().uuid(),
    existing_id: z.string().uuid().optional(),
    change_kind: z.enum(['new', 'reuse', 'correction', 'renewal', 'billing_only']),
    term_start: CalendarDate,
    term_end: CalendarDate.nullable(),
    rent_amount_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    rent_currency: z.string().regex(/^[A-Z]{3}$/),
    deposit_amount_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deposit_currency: z.string().regex(/^[A-Z]{3}$/),
    document: z.record(z.unknown()).optional(),
  })
  .strict();
export const SetupDocument = z.object({
  receipt_id: z.string().uuid(),
  original_receipt_id: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
});
const MonthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const SetupDepositAnswer = z
  .object({
    amount_cents: z.number().int().max(Number.MAX_SAFE_INTEGER).nullable(),
    paid: z.enum(['not_yet', 'yes', 'part']).optional(),
    payment: z
      .object({
        amount_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        method: z.enum(['cash', 'check', 'ach', 'card', 'zelle_venmo', 'money_order', 'other']),
        received_at: CalendarDate.optional(),
        reference: z.string().max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .openapi('TenancySetupDepositAnswer', {
    description:
      'One deposit amount and one answer. null amount = unknown, 0 = no deposit. The server writes the lease term, the deposit charge (due at lease start, or today once the lease has started) and any payment, replacing agreement.deposit_*, billing.deposit and the deposit payment.',
  });
export const SetupRentStep = z
  .object({
    effective_month: MonthKey,
    amount_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .openapi('TenancySetupRentStep');
export const SetupInput = z
  .object({
    deposit_answer: SetupDepositAnswer.optional(),
    rent_steps: z.array(SetupRentStep).max(60).optional().openapi({
      description:
        'Past rent changes after the lease start ("from [month] rent became [amount]"). Requires billing.rent.follows_lease = true.',
    }),
    people: z.array(SetupPerson).min(1).max(50),
    tenancy: z.object({ start_date: CalendarDate, end_date: CalendarDate.nullable() }).strict(),
    agreement: SetupAgreement,
    billing: BillingSetupIntent,
    receipt_purposes: z.record(z.enum(['rent', 'deposit'])).default({}),
    document: SetupDocument.optional(),
    transition: z.boolean().default(false),
    save_defaults: z.boolean().default(false),
    change_reason: z.string().trim().max(500).optional(),
    move_in_note: z.string().trim().max(2000).optional(),
    warning_notes: z.record(z.string().trim().max(2000)).default({}),
  })
  .strict()
  .openapi('TenancySetupInput');
export const Session = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    area_id: z.string().uuid(),
    tenancy_id: z.string().uuid().nullable(),
    payload: z.record(z.unknown()),
    revision: z.number().int(),
    result: z.record(z.unknown()).nullable(),
    completed_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    expires_at: z.string(),
  })
  .openapi('TenancySetupSession');
export const SaveSession = z
  .object({
    area_id: z.string().uuid(),
    tenancy_id: z.string().uuid().nullable().default(null),
    expected_revision: z.number().int().nonnegative(),
    payload: z.record(z.unknown()),
  })
  .strict();
export const SetupReview = BillingSetupPreview.extend({
  setup_context: z.string(),
  draft_revision: z.number().int(),
  can_confirm: z.boolean(),
  date_change: z.record(z.unknown()).nullable().optional(),
  setup_relationship_findings: z.array(z.record(z.unknown())).optional(),
  proposed_tenancy: z
    .object({
      id: z.string().uuid(),
      start_date: CalendarDate,
      end_date: CalendarDate.nullable(),
      status: z.string(),
    })
    .passthrough(),
  proposed_agreement: z
    .object({
      id: z.string().uuid(),
      term_start: CalendarDate,
      term_end: CalendarDate.nullable(),
      rent_amount_cents: z.number().int(),
      rent_currency: z.string(),
    })
    .passthrough(),
  billing_intent: BillingSetupIntent.extend({ operation: z.enum(['initial', 'transition']) }),
  field_errors: z.array(FieldErrorSchema).optional(),
  billing_differences: z
    .array(
      z.object({
        field: z.enum([
          'amount_cents',
          'currency',
          'due_rule',
          'grace_days',
          'late_fee_policy',
          'coverage_end',
        ]),
        lease: z.unknown(),
        billing: z.unknown(),
      }),
    )
    .optional(),
  proration_suggestions: z
    .array(
      z.object({
        cycle_key: z.string(),
        period_start: CalendarDate,
        period_end: CalendarDate,
        days: z.number().int(),
        base: z.number().int(),
        amount_cents: z.number().int(),
        method: z.enum(['actual_days', 'thirty_day_month']),
      }),
    )
    .optional(),
  proration_method: z.enum(['actual_days', 'thirty_day_month']).optional(),
}).openapi('TenancySetupReview');
export const SetupValidation = z
  .object({ ok: z.boolean(), errors: z.array(FieldErrorSchema) })
  .openapi('TenancySetupValidation');
const PersonMatchTenancy = z.object({
  tenancy_id: z.string().uuid(),
  status: z.string(),
  start_date: CalendarDate,
  move_out_on: CalendarDate.nullable(),
  door_name: z.string().nullable(),
  property_name: z.string().nullable(),
});
const PersonMatch = z.object({
  person_id: z.string().uuid(),
  full_name: z.string(),
  matched_on: z.array(z.enum(['email', 'phone', 'name'])),
  tenancies: z.array(PersonMatchTenancy),
});
export const PeopleMatchQuery = z.object({
  accountId: z.string().uuid(),
});
export const PeopleMatchParams = z.object({
  email: z.string().max(320).optional(),
  phone: z.string().max(32).optional(),
  name: z.string().max(200).optional(),
});
export const PeopleMatch = z
  .object({ enabled: z.boolean(), exact: z.array(PersonMatch), possible: z.array(PersonMatch) })
  .openapi('PeopleMatch');
export const SetupResult = z
  .object({
    session_id: z.string().uuid(),
    tenancy_id: z.string().uuid(),
    lease_id: z.string().uuid(),
    status: z.string(),
    billing: z.record(z.unknown()),
  })
  .openapi('TenancySetupResult');
export const RentDefaults = z.object({
  grace_days: z.number().int().nonnegative().max(2147483647).nullable(),
  late_fee_policy: LateFeePolicy,
});
