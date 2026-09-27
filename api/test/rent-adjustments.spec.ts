import { describe, expect, it } from 'vitest';
import { isIdempotencyExempt } from '../src/middleware/idempotency';
import { injectIdempotencyContract } from '../src/openapi/idempotency-contract';
import { RentAdjustmentInput } from '../src/routes/rent-adjustments/schemas';
import { mapAdjustmentError } from '../src/routes/rent-adjustments/router';

const terms = {
  term_start: '2026-09-01',
  term_end: null,
  rent_amount_cents: 180_000,
  rent_currency: 'USD',
  deposit_amount_cents: 300_000,
  deposit_currency: 'USD',
};

describe('rent adjustment contract', () => {
  it('accepts a lease-only rent correction with no schedule scope', () => {
    expect(
      RentAdjustmentInput.parse({
        kind: 'correct_rent',
        lease_id: crypto.randomUUID(),
        terms,
        reason: 'Rent entered incorrectly',
        scope: { schedules: [] },
      }),
    ).toMatchObject({ kind: 'correct_rent', scope: { schedules: [] } });
  });

  it('rejects duplicate and backwards schedule slices', () => {
    const scheduleId = crypto.randomUUID();
    const base = {
      kind: 'correct_rent',
      lease_id: crypto.randomUUID(),
      terms,
      reason: 'Rent entered incorrectly',
    } as const;
    expect(
      RentAdjustmentInput.safeParse({
        ...base,
        scope: { schedules: [{ schedule_id: scheduleId }, { schedule_id: scheduleId }] },
      }).success,
    ).toBe(false);
    expect(
      RentAdjustmentInput.safeParse({
        ...base,
        scope: {
          schedules: [
            { schedule_id: scheduleId, start_date: '2026-10-01', end_date: '2026-09-30' },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('requires a deposit currency only for a positive deposit', () => {
    expect(
      RentAdjustmentInput.safeParse({
        kind: 'edit_details',
        lease_id: crypto.randomUUID(),
        terms: { ...terms, deposit_currency: null },
        reason: 'Wrong deposit',
      }).success,
    ).toBe(false);
    expect(
      RentAdjustmentInput.safeParse({
        kind: 'edit_details',
        lease_id: crypto.randomUUID(),
        terms: { ...terms, deposit_amount_cents: 0, deposit_currency: null },
        reason: 'Wrong deposit',
      }).success,
    ).toBe(true);
  });

  it('rejects impossible calendar dates and backwards lease terms', () => {
    const input = {
      kind: 'edit_details',
      lease_id: crypto.randomUUID(),
      terms,
      reason: 'Wrong dates',
    } as const;
    expect(
      RentAdjustmentInput.safeParse({
        ...input,
        terms: { ...terms, term_start: '2026-02-30' },
      }).success,
    ).toBe(false);
    expect(
      RentAdjustmentInput.safeParse({
        ...input,
        terms: { ...terms, term_start: '2026-10-01', term_end: '2026-09-30' },
      }).success,
    ).toBe(false);
  });

  it('exempts only the read-only preview POST from mutation idempotency', () => {
    const path = '/v1/accounts/a/tenancies/t/rent-adjustments/preview';
    expect(isIdempotencyExempt('POST', path)).toBe(true);
    expect(isIdempotencyExempt('GET', path)).toBe(false);
    expect(isIdempotencyExempt('POST', path.replace('/preview', ''))).toBe(false);

    const preview = { responses: { 200: { description: 'ok' } } };
    const commit = { responses: { 200: { description: 'ok' } } };
    const document = {
      paths: {
        '/v1/accounts/{accountId}/tenancies/{tenancyId}/rent-adjustments/preview': {
          post: preview,
        },
        '/v1/accounts/{accountId}/tenancies/{tenancyId}/rent-adjustments': { post: commit },
      },
    };
    injectIdempotencyContract(document);
    expect('parameters' in preview).toBe(false);
    expect(commit).toHaveProperty('parameters.0.name', 'Idempotency-Key');
  });

  it.each([
    ['source_amount_mismatch', 409, 'adjustment_scope_required'],
    ['no_change', 400, 'invalid_request'],
    ['lease_voided', 409, 'lease_voided'],
    ['notice_not_served', 409, 'notice_not_served'],
    ['tenancy_ended', 409, 'tenancy_ended'],
    ['instrument_not_current', 409, 'instrument_not_current'],
    ['schedule_conflict', 409, 'schedule_conflict'],
  ] as const)('maps the bare %s blocker to HTTP %s %s', (message, status, code) => {
    expect(mapAdjustmentError({ message })).toMatchObject({ status, code });
  });
});
