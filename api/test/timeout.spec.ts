// Unit spec for the app-level request-timeout middleware (Theme 1c). Drives a
// tiny Hono app whose onError mirrors app.ts -- no env, no DB.

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { requestTimeout } from '../src/middleware/timeout';
import { ApiError } from '../src/routes/_lib/error';

function appWith(budgetMs: number, handlerDelayMs: number): Hono {
  const app = new Hono();
  app.use('*', requestTimeout(budgetMs));
  app.get('/x', async (c) => {
    await new Promise((r) => setTimeout(r, handlerDelayMs));
    return c.json({ ok: true });
  });
  // Mirror of app.ts onError: ApiError -> envelope, Retry-After on 503.
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.status === 503) c.header('Retry-After', '5');
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    return c.json({ error: { code: 'internal_error', message: 'x' } }, 500);
  });
  return app;
}

describe('requestTimeout', () => {
  it('exceeding the budget yields a typed 503 envelope + Retry-After', async () => {
    const res = await appWith(20, 1000).request('/x');
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('service_unavailable');
  });

  it('a fast handler passes through unchanged', async () => {
    const res = await appWith(1000, 0).request('/x');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
