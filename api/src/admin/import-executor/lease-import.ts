import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { CreateLeaseBody } from '../../schemas/importable';
import type { BlockerCode, FieldMapping } from '../import-catalog';
import { coerceCurrency, firstIssue, todayIso } from './coercions';
import { mapImportedDate } from './date-mapping';
import { exactImportedMoney, mapImportedLeaseTerms } from './lease-terms';
import type { RawImportRow } from './types';

export async function importLease(input: {
  client: PoolClient;
  accountId: string;
  row: RawImportRow;
  tenancyId: string;
  fields: FieldMapping[];
  getValue: (field: string) => string | null;
  block: (field: string | null, code: BlockerCode, message: string) => void;
  recordDate: (field: string, raw: string | null, iso: string | null) => void;
  reused: () => void;
  created: (id: string) => Promise<void>;
}): Promise<void> {
  const rentRaw = input.getValue('rent_amount');
  if (rentRaw === null) return;
  const rentCents = exactImportedMoney(rentRaw);
  if (rentCents === null)
    return input.block('rent_amount', 'unparseable_value', 'unparseable contractual rent amount');
  const termStartRaw = input.getValue('term_start');
  const start = mapImportedDate(termStartRaw);
  if (start.kind === 'invalid')
    return input.block(
      'term_start',
      'unparseable_value',
      `unparseable lease term start "${start.raw}"`,
    );
  if (start.kind === 'missing')
    return input.block(
      'term_start',
      'missing_required_field',
      'an imported lease requires its explicit term start; possession start is separate',
    );
  input.recordDate('lease.term_start', termStartRaw, start.value);

  const termEndRaw = input.getValue('term_end');
  const end = mapImportedDate(termEndRaw);
  if (end.kind === 'invalid')
    return input.block('term_end', 'unparseable_value', `unparseable lease term end "${end.raw}"`);
  const termEnd = end.kind === 'explicit' || end.kind === 'defaulted' ? end.value : null;
  if (termEnd && termEnd < start.value)
    return input.block('term_end', 'date_order', 'lease term end precedes its start');
  input.recordDate('lease.term_end', termEndRaw, termEnd);
  const currency = coerceCurrency(input.getValue('rent_currency'));
  if (!currency)
    return input.block(
      'rent_currency',
      'missing_required_field',
      'an imported agreement requires its explicit rent currency',
    );
  const terms = mapImportedLeaseTerms(input.getValue);
  if (terms.kind === 'invalid') return input.block(terms.field, 'invalid_value', terms.message);
  const valid = CreateLeaseBody.safeParse({
    tenancy_id: input.tenancyId,
    term_start: start.value,
    term_end: termEnd,
    rent_amount_cents: rentCents,
    rent_currency: currency,
    ...terms.terms,
    status: termEnd && termEnd < todayIso() ? 'expired' : 'active',
  });
  if (!valid.success) return input.block(null, 'invalid_value', firstIssue(valid.error));
  const existing = await input.client.query(
    `select id,term_end::text,rent_currency,deposit_amount_cents,deposit_currency,
       rent_due_rule,grace_days,late_fee_policy,deposit_knowledge from leases
       where account_id = $1 and tenancy_id = $2 and term_start = $3
       and rent_amount_cents = $4 and deleted_at is null order by id limit 2`,
    [input.accountId, input.tenancyId, start.value, rentCents],
  );
  if ((existing.rowCount ?? 0) > 1)
    return input.block(
      'term_start',
      'ambiguous_match',
      'multiple lease terms match this explicit date and rent',
    );
  if (existing.rowCount === 1) {
    const row = existing.rows[0];
    if (
      row.rent_currency !== currency ||
      (termEndRaw !== null && row.term_end !== termEnd) ||
      (terms.terms.deposit_knowledge !== 'unknown' &&
        (Number(row.deposit_amount_cents) !== terms.terms.deposit_amount_cents ||
          row.deposit_currency !== (terms.terms.deposit_currency ?? null))) ||
      (terms.terms.rent_due_rule.kind !== 'unknown' &&
        !isDeepStrictEqual(row.rent_due_rule, terms.terms.rent_due_rule)) ||
      (terms.terms.grace_days !== null && row.grace_days !== terms.terms.grace_days) ||
      (terms.terms.late_fee_policy.kind !== 'unknown' &&
        !isDeepStrictEqual(row.late_fee_policy, terms.terms.late_fee_policy))
    )
      return input.block(
        'term_start',
        'invalid_value',
        'matching lease has different explicit contractual terms; use reasoned lease correction',
      );
    return input.reused();
  }
  const inserted = await input.client.query(
    `insert into leases
       (account_id, tenancy_id, term_start, term_end, rent_amount_cents, rent_currency,
        deposit_amount_cents, deposit_currency, status, rent_due_rule, grace_days,
        late_fee_policy, deposit_knowledge, terms_source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [
      input.accountId,
      valid.data.tenancy_id,
      valid.data.term_start,
      valid.data.term_end ?? null,
      valid.data.rent_amount_cents,
      valid.data.rent_currency,
      valid.data.deposit_amount_cents ?? 0,
      valid.data.deposit_currency ?? null,
      valid.data.status,
      JSON.stringify(valid.data.rent_due_rule),
      valid.data.grace_days,
      JSON.stringify(valid.data.late_fee_policy),
      valid.data.deposit_knowledge,
      JSON.stringify(valid.data.terms_source),
    ],
  );
  const id = inserted.rows[0].id as string;
  await input.created(id);
}
