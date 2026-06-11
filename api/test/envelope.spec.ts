// Validation-envelope spec (vitest port of envelope.test.ts -- the Phase 0
// regression guard). Every sub-app must answer a zod validation failure with
// the project envelope { error: { code: 'invalid_request' } }, not
// zod-openapi's default shape. Sub-apps are driven directly: a validation
// failure responds before any handler -- and therefore before any
// auth/membership/DB access -- runs. No Supabase stack needed.

import { describe, expect, it } from 'vitest';
import { setFakeEnv } from './helpers/env';

setFakeEnv();

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

interface Case {
  name: string;
  load: () => Promise<{ request: (path: string, init: RequestInit) => Response | Promise<Response> }>;
  path: string;
  method: string;
  body: unknown;
}

const cases: Case[] = [
  {
    name: 'properties: empty create body',
    load: async () => (await import('../src/routes/properties')).propertiesApp,
    path: `/accounts/${ACCOUNT}/properties`,
    method: 'POST',
    body: {},
  },
  {
    name: 'tenants: empty create body',
    load: async () => (await import('../src/routes/tenants')).tenantsApp,
    path: `/accounts/${ACCOUNT}/tenants`,
    method: 'POST',
    body: {},
  },
  {
    name: 'payments: negative amount',
    load: async () => (await import('../src/routes/payments')).paymentsApp,
    path: `/accounts/${ACCOUNT}/payments`,
    method: 'POST',
    body: { amount_cents: -1 },
  },
  {
    name: 'interactions: correction_kind without corrects_id',
    load: async () => (await import('../src/routes/interactions')).interactionsApp,
    path: `/accounts/${ACCOUNT}/interactions`,
    method: 'POST',
    body: { correction_kind: 'amend' },
  },
  {
    name: 'imports: empty rows patch',
    load: async () => (await import('../src/routes/imports')).importsApp,
    path: `/accounts/${ACCOUNT}/imports/${ACCOUNT}/rows`,
    method: 'PATCH',
    body: { updates: [] },
  },
  {
    name: 'auth: signup with invalid email shape',
    load: async () => (await import('../src/routes/auth')).default,
    path: '/auth/signup',
    method: 'POST',
    body: { email: 'not-an-email', password: 'x' },
  },
];

describe('validation envelope is uniform across sub-apps', () => {
  for (const tc of cases) {
    it(tc.name, async () => {
      const app = await tc.load();
      const res = await app.request(tc.path, {
        method: tc.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tc.body),
      });
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as { error?: { code?: string; message?: unknown } };
      expect(parsed.error?.code).toBe('invalid_request');
      expect(typeof parsed.error?.message).toBe('string');
    });
  }
});
