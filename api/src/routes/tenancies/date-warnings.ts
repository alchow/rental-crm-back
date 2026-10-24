import { z } from '@hono/zod-openapi';
import { CalendarDate } from '../../schemas/calendar-date';

export const WarningAcknowledgement = z
  .object({
    relationship_fingerprint: z.string().min(1).max(256),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .openapi('WarningAcknowledgement');

export const WarningAcknowledgements = z.array(WarningAcknowledgement).max(250).optional();

export const DateWarningFinding = z
  .object({
    rule_id: z.string(),
    version: z.literal(1),
    severity: z.literal('review'),
    fields: z.array(z.string()),
    values: z.record(z.unknown()),
    message: z.string(),
    relationship_fingerprint: z.string(),
    reason_required: z.boolean(),
    explained: z.boolean(),
    confirmation_required: z.boolean(),
    confirmed: z.boolean(),
    subject: z.object({
      type: z.enum(['tenancy', 'ending', 'payment']),
      id: z.string().uuid().optional(),
      draft_key: z.string().optional(),
    }),
  })
  .openapi('DateWarningFinding');

export const DateWarningPreview = z
  .object({
    as_of_date: CalendarDate,
    clock_basis: z.literal('UTC'),
    context_fingerprint: z.string(),
    findings: z.array(DateWarningFinding),
    can_commit: z.boolean(),
  })
  .openapi('DateWarningPreview');
