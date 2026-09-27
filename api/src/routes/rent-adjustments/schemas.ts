import { z } from '@hono/zod-openapi';
import { CurrencyCode } from '../../schemas/importable';

const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
    {
      message: 'invalid calendar date',
    },
  );
const Reason = z.string().trim().min(1).max(500);

export const LeaseTerms = z
  .object({
    term_start: DateString,
    term_end: DateString.nullable(),
    rent_amount_cents: z.number().int().nonnegative(),
    rent_currency: CurrencyCode,
    deposit_amount_cents: z.number().int().nonnegative(),
    deposit_currency: CurrencyCode.nullable(),
  })
  .strict()
  .refine((value) => value.term_end === null || value.term_end >= value.term_start, {
    message: 'term_end must be on or after term_start',
    path: ['term_end'],
  })
  .refine((value) => value.deposit_amount_cents === 0 || value.deposit_currency !== null, {
    message: 'deposit_currency is required when deposit_amount_cents is positive',
    path: ['deposit_currency'],
  })
  .openapi('RentAdjustmentLeaseTerms');

const ScheduleScope = z
  .object({
    schedule_id: z.string().uuid(),
    start_date: DateString.optional(),
    end_date: DateString.optional(),
  })
  .strict()
  .refine(({ start_date, end_date }) => !start_date || !end_date || end_date >= start_date, {
    message: 'end_date must be on or after start_date',
    path: ['end_date'],
  });

const CorrectionScope = z
  .object({
    schedules: z.array(ScheduleScope),
    charges: z
      .array(
        z
          .object({
            charge_id: z.string().uuid(),
            amount_cents: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine(({ schedules, charges }, ctx) => {
    for (const [path, ids] of [
      ['schedules', schedules.map(({ schedule_id }) => schedule_id)],
      ['charges', (charges ?? []).map(({ charge_id }) => charge_id)],
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate ${path} id`,
          path: [path],
        });
      }
    }
  });

const ExistingLeaseSource = z
  .object({ kind: z.literal('existing_lease'), lease_id: z.string().uuid() })
  .strict();
const ExistingNoticeSource = z
  .object({ kind: z.literal('existing_notice'), notice_id: z.string().uuid() })
  .strict();
const NewLeaseSource = z
  .object({
    kind: z.literal('new_lease'),
    terms: LeaseTerms,
    document: z.record(z.unknown()).optional(),
  })
  .strict();
const NewNoticeSource = z
  .object({
    kind: z.literal('new_notice'),
    notice_label: z.string().trim().min(1).max(100),
    served_at: z.string().datetime(),
    served_method: z.string().trim().min(1).max(100).optional(),
    body: z.string().max(10_000).optional(),
    document: z.record(z.unknown()).optional(),
  })
  .strict();

export const RentAdjustmentInput = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('edit_details'),
        lease_id: z.string().uuid(),
        terms: LeaseTerms,
        reason: Reason,
      })
      .strict(),
    z
      .object({
        kind: z.literal('correct_rent'),
        lease_id: z.string().uuid(),
        terms: LeaseTerms,
        reason: Reason,
        scope: CorrectionScope,
      })
      .strict(),
    z
      .object({
        kind: z.literal('change_rent'),
        amount_cents: z.number().int().nonnegative(),
        currency: CurrencyCode,
        effective_date: DateString,
        due_day: z.number().int().min(1).max(28).optional(),
        source: z.discriminatedUnion('kind', [
          ExistingLeaseSource,
          ExistingNoticeSource,
          NewLeaseSource,
          NewNoticeSource,
        ]),
        details_correction: z
          .object({ lease_id: z.string().uuid(), terms: LeaseTerms, reason: Reason })
          .strict()
          .optional(),
        reason: Reason.optional(),
      })
      .strict(),
  ])
  .openapi('RentAdjustmentInput');

const LeaseEffect = z.object({ id: z.string().uuid(), before: LeaseTerms, after: LeaseTerms });
const ScheduleEffect = z.object({
  id: z.string().uuid(),
  start_date: DateString,
  end_date: DateString.nullable(),
  due_day: z.number().int().min(1).max(28),
  selected: z.boolean(),
  before_amount_cents: z.number().int().nonnegative(),
  after_amount_cents: z.number().int().nonnegative(),
});
const BillEffect = z.object({
  id: z.string().uuid(),
  due_date: DateString,
  after_due_date: DateString.nullable().optional(),
  period_start: DateString,
  after_period_start: DateString.nullable().optional(),
  before_amount_cents: z.number().int().nonnegative(),
  after_amount_cents: z.number().int().nonnegative(),
  applied_cents: z.number().int().nonnegative(),
  carried_cents: z.number().int().nonnegative(),
  credit_cents: z.number().int().nonnegative(),
  balance_before_cents: z.number().int(),
  balance_after_cents: z.number().int(),
  action: z.enum(['replace', 'void']),
});
const ApplicationEffect = z.object({
  id: z.string().uuid(),
  payment_id: z.string().uuid(),
  charge_id: z.string().uuid(),
  before_amount_cents: z.number().int().nonnegative(),
  after_amount_cents: z.number().int().nonnegative(),
});
const Totals = z.object({
  currency: CurrencyCode,
  billed_before_cents: z.number().int(),
  billed_after_cents: z.number().int(),
  applied_before_cents: z.number().int(),
  applied_after_cents: z.number().int(),
  credit_released_cents: z.number().int().nonnegative(),
  balance_before_cents: z.number().int(),
  balance_after_cents: z.number().int(),
});

export const RentAdjustmentPreview = z
  .object({
    kind: z.enum(['edit_details', 'correct_rent', 'change_rent']),
    currency: CurrencyCode,
    input: RentAdjustmentInput,
    lease: LeaseEffect.nullable(),
    schedules: z.array(ScheduleEffect),
    bills: z.array(BillEffect),
    applications: z.array(ApplicationEffect),
    first_bill: z
      .object({
        due_date: DateString,
        period_start: DateString,
        amount_cents: z.number().int().nonnegative(),
      })
      .nullable(),
    totals: z.array(Totals),
    blockers: z.array(
      z.object({ code: z.string(), message: z.string(), field: z.string().optional() }),
    ),
    information: z.array(z.string()),
    preview_token: z.string().min(1),
  })
  .openapi('RentAdjustmentPreview');

export const CommitRentAdjustmentBody = z
  .object({ input: RentAdjustmentInput, preview_token: z.string().min(1) })
  .strict()
  .openapi('CommitRentAdjustmentBody');

export const RentAdjustmentReceipt = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['edit_details', 'correct_rent', 'change_rent']),
    created_at: z.string(),
    preview: RentAdjustmentPreview,
    replacement_lease_id: z.string().uuid().nullable(),
    source_lease_id: z.string().uuid().nullable(),
    source_notice_id: z.string().uuid().nullable(),
    schedule_ids: z.array(z.string().uuid()),
    charge_ids: z.array(z.string().uuid()),
  })
  .openapi('RentAdjustmentReceipt');

export const RentAdjustmentRecovery = z
  .object({ receipt: RentAdjustmentReceipt.nullable() })
  .openapi('RentAdjustmentRecovery');

export const RentAdjustmentList = z
  .object({ items: z.array(RentAdjustmentReceipt), next_cursor: z.string().nullable() })
  .openapi('RentAdjustmentList');

export const RentAdjustmentListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const AccountTenancyParams = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
  tenancyId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'tenancyId', in: 'path' } }),
});

export const AdjustmentParams = AccountTenancyParams.extend({
  adjustmentId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'adjustmentId', in: 'path' } }),
});

export const RequestKeyParams = AccountTenancyParams.extend({
  requestKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,200}$/)
    .openapi({ param: { name: 'requestKey', in: 'path' } }),
});
