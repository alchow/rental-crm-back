// Unit spec for the transient-failure classifier + dbError mapping (Theme 5).
// Pure functions -- no env, no DB.

import { describe, expect, it } from 'vitest';
import { ApiError, classifyTransient, dbError } from '../src/routes/_lib/error';

describe('classifyTransient', () => {
  it('maps Postgres connection SQLSTATEs to a retryable 503', () => {
    for (const code of ['08000', '08003', '08006', '08001', '08004', '57P03', '53300', '53400']) {
      const e = classifyTransient({ code });
      expect(e, code).toBeInstanceOf(ApiError);
      expect(e?.status, code).toBe(503);
      expect(e?.code, code).toBe('service_unavailable');
    }
  });

  it('maps Node/undici socket + DNS error codes (direct and via .cause)', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']) {
      expect(classifyTransient({ code })?.status, code).toBe(503);
    }
    // undici nests the real socket code under .cause
    const wrapped = Object.assign(new Error('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    expect(classifyTransient(wrapped)?.status).toBe(503);
  });

  it('returns null for non-transient / unknown errors', () => {
    expect(classifyTransient({ code: '42501' })).toBeNull();
    expect(classifyTransient({ code: '23505' })).toBeNull();
    expect(classifyTransient({ code: 'XX000' })).toBeNull();
    expect(classifyTransient(new Error('plain'))).toBeNull();
    expect(classifyTransient(null)).toBeNull();
    expect(classifyTransient(undefined)).toBeNull();
  });
});

describe('dbError', () => {
  it('upgrades a transient code to 503 service_unavailable (before the 42501 check)', () => {
    const e = dbError({ code: '57P03', message: 'the database system is starting up' });
    expect(e.status).toBe(503);
    expect(e.code).toBe('service_unavailable');
  });

  it('maps Postgres 42501 to 403 forbidden', () => {
    const e = dbError({ code: '42501', message: 'permission denied for table x' });
    expect(e.status).toBe(403);
    expect(e.code).toBe('forbidden');
  });

  it('falls back to 500 database_error for unrecognised codes', () => {
    const e = dbError({ code: '23514', message: 'check constraint' });
    expect(e.status).toBe(500);
    expect(e.code).toBe('database_error');
  });
});
