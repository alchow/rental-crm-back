import { describe, expect, it } from 'vitest';
import { usesLargeBodyLimit } from '../src/app';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const INTERACTION = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';

describe('large body route allowlist', () => {
  it.each([
    `/v1/intake/token-abc`,
    `/v1/accounts/${ACCOUNT}/imports`,
    `/v1/accounts/${ACCOUNT}/attachments`,
    `/v1/accounts/${ACCOUNT}/documents`,
    `/v1/accounts/${ACCOUNT}/interactions/${INTERACTION}/attachments`,
    `/v1/inspection-capture/token-abc/items/${ITEM}/photos`,
  ])('uses the large-body guard for %s', (path) => {
    expect(usesLargeBodyLimit(path)).toBe(true);
  });

  it.each([
    `/v1/accounts/${ACCOUNT}/properties`,
    `/v1/accounts/${ACCOUNT}/interactions`,
    `/v1/accounts/${ACCOUNT}/interactions/${INTERACTION}`,
    `/v1/accounts/${ACCOUNT}/attachments/${INTERACTION}`,
  ])('keeps the default 1 MiB guard for %s', (path) => {
    expect(usesLargeBodyLimit(path)).toBe(false);
  });
});
