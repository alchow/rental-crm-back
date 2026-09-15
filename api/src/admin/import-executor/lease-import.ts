import type { PoolClient } from 'pg';
import { CreateLeaseBody } from '../../schemas/importable';
import type { BlockerCode, FieldMapping } from '../import-catalog';
import { coerceCurrency, coerceMoney, firstIssue, todayIso } from './coercions';
import { mapImportedDate } from './date-mapping';
import type { RawImportRow } from './types';

export async function importLease(input: {
  client: PoolClient;
  accountId: string;
  row: RawImportRow;
  tenancyId: string;
  tenancyStart: string;
  tenancyEnd: string | null;
  tenancyWasCreated: boolean;
  fields: FieldMapping[];
  cache: Set<string>;
  getValue: (field: string) => string | null;
  block: (field: string | null, code: BlockerCode, message: string) => void;
  recordDate: (field: string, raw: string | null, iso: string | null) => void;
  recordDefault: (value: string) => void;
  reused: () => void;
  created: (id: string) => Promise<void>;
}): Promise<void> {
  const rentCents = coerceMoney(input.getValue('rent_amount'));
  if (rentCents === null) return;
  const termStartRaw = input.getValue('term_start');
  const start = mapImportedDate(
    termStartRaw,
    input.tenancyWasCreated ? input.tenancyStart : undefined,
  );
  if (start.kind === 'invalid')
    return input.block(
      'term_start',
      'unparseable_value',
      `unparseable lease term start "${start.raw}"`,
    );
  if (start.kind === 'missing') return;
  input.recordDate('lease.term_start', termStartRaw, start.value);
  if (start.kind === 'defaulted') input.recordDefault(start.value);

  const termEndRaw = input.getValue('term_end');
  const end = mapImportedDate(
    termEndRaw,
    input.tenancyWasCreated && input.tenancyEnd ? input.tenancyEnd : undefined,
  );
  if (end.kind === 'invalid')
    return input.block('term_end', 'unparseable_value', `unparseable lease term end "${end.raw}"`);
  const termEnd = end.kind === 'explicit' || end.kind === 'defaulted' ? end.value : null;
  input.recordDate('lease.term_end', termEndRaw, termEnd);
  const currency = coerceCurrency(input.getValue('rent_currency')) ?? 'USD';
  const depositCents = coerceMoney(input.getValue('deposit_amount')) ?? 0;
  const valid = CreateLeaseBody.safeParse({
    tenancy_id: input.tenancyId,
    term_start: start.value,
    term_end: termEnd,
    rent_amount_cents: rentCents,
    rent_currency: currency,
    deposit_amount_cents: depositCents,
    deposit_currency: depositCents > 0 ? currency : undefined,
    status: termEnd && termEnd < todayIso() ? 'expired' : 'active',
  });
  if (!valid.success) return input.block(null, 'invalid_value', firstIssue(valid.error));
  const key = `${input.tenancyId}::${start.value}::${rentCents}`;
  if (input.cache.has(key)) return input.reused();
  const existing = await input.client.query(
    `select id from leases where account_id = $1 and tenancy_id = $2 and term_start = $3
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
    input.cache.add(key);
    return input.reused();
  }
  const inserted = await input.client.query(
    `insert into leases
       (account_id, tenancy_id, term_start, term_end, rent_amount_cents, rent_currency,
        deposit_amount_cents, deposit_currency, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
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
    ],
  );
  const id = inserted.rows[0].id as string;
  input.cache.add(key);
  await input.created(id);
}
