import { describe, expect, it, vi } from 'vitest';
import { buildApp, usesLargeBodyLimit } from '../src/app';
import { setFakeEnv } from './helpers/env';
import type * as ExportPdf from '../src/admin/export-pdf';
import type * as ImportHealth from '../src/admin/import-health';

// Keep the production middleware stack; isolate only startup work that uses external services.
vi.mock('../src/admin/heic-probe', () => ({
  assertImageStackAtBoot: vi.fn(),
  heicSupported: () => false,
}));
vi.mock('../src/admin/export-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof ExportPdf>()),
  recoverOrphanedEvidenceExports: vi.fn(),
}));
vi.mock('../src/admin/import-health', async (importOriginal) => ({
  ...(await importOriginal<typeof ImportHealth>()),
  recoverOrphanedImportSessions: vi.fn(),
}));

setFakeEnv();

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

describe('request body limits', () => {
  const app = buildApp();
  const MiB = 1024 * 1024;

  it.each([
    ['/v1/auth/signup', 1 * MiB, 400, 'invalid_request'],
    ['/v1/auth/signup', 1 * MiB + 1, 413, 'payload_too_large'],
    [`/v1/accounts/${ACCOUNT}/properties`, 1 * MiB + 1, 413, 'payload_too_large'],
    [`/v1/accounts/${ACCOUNT}/documents`, 25 * MiB, 401, 'unauthenticated'],
    [`/v1/accounts/${ACCOUNT}/documents`, 25 * MiB + 1, 413, 'payload_too_large'],
  ] as const)('%s with %i bytes returns %i', async (path, bytes, status, code) => {
    // Valid JSON with an invalid schema reaches validation only when within the byte limit.
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '"' + 'x'.repeat(bytes - 2) + '"',
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });
});
