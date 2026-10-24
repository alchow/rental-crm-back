import { z } from '@hono/zod-openapi';

const WrittenTerm = z.string().trim().min(1).max(2000);
export const RentDueRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('day_of_month'), day: z.number().int().min(1).max(31) }).strict(),
  z.object({ kind: z.literal('last_day') }).strict(),
  z.object({ kind: z.literal('other'), text: WrittenTerm }).strict(),
]);
export const LateFeePolicy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('fixed'), amount_cents: z.number().int().positive(), currency: z.string().length(3) }).strict(),
  z.object({ kind: z.literal('other'), text: WrittenTerm }).strict(),
]);
export const TermsSource = z.object({
  kind: z.enum(['manual', 'document', 'import']),
  document_id: z.string().uuid().optional(),
  note: WrittenTerm.optional(),
}).strict();

export const LeaseTermsFields = {
  rent_due_rule: RentDueRule.optional(),
  grace_days: z.number().int().nonnegative().nullable().optional(),
  late_fee_policy: LateFeePolicy.optional(),
  deposit_knowledge: z.enum(['unknown', 'none', 'amount']).optional(),
  terms_source: TermsSource.nullable().optional(),
  agreement_kind: z.enum(['original', 'renewal', 'amendment']).optional(),
  predecessor_lease_id: z.string().uuid().nullable().optional(),
};

export const LeaseTermsOutput = {
  rent_due_rule: RentDueRule,
  grace_days: z.number().int().nonnegative().nullable(),
  late_fee_policy: LateFeePolicy,
  deposit_knowledge: z.enum(['unknown', 'none', 'amount']),
  terms_source: TermsSource.nullable(),
  terms_recorded_by: z.string().uuid().nullable(),
  terms_recorded_at: z.string().nullable(),
  agreement_kind: z.enum(['original', 'renewal', 'amendment']),
  predecessor_lease_id: z.string().uuid().nullable(),
};
