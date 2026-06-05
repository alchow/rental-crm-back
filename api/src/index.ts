import { serve } from '@hono/node-server';
import { buildApp } from './app';
import { loadEnv } from './env';

const env = loadEnv();
const app = buildApp();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.info(`[api] listening on http://localhost:${info.port}`);
});
