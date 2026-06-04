import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadEnv } from './env';

const env = loadEnv();

const app = new Hono();

app.get('/healthz', (c) => c.json({ status: 'ok' }));

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

app.onError((err, c) => {
  console.error('[api] unhandled error', err);
  return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.info(`[api] listening on http://localhost:${info.port}`);
});
