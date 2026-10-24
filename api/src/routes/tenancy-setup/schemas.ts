import { z } from '@hono/zod-openapi';
import { CalendarDate } from '../../schemas/calendar-date';
import { LeaseTermsFields, LateFeePolicy } from '../../schemas/lease-terms';
import { BillingSetupIntent, BillingSetupPreview } from '../billing-setup/schemas';

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
export const SetupInput = z
  .object({
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
}).openapi('TenancySetupReview');
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
