import { Hono } from 'hono';
import meRoutes from './routes/me';
import authRoutes from './routes/auth';

// The Hono app, configured but NOT listening. index.ts mounts it on a
// node-server port; tests call app.fetch(request) directly without an
// HTTP listener.
export function buildApp(): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  const v1 = new Hono();
  v1.route('/', meRoutes);
  v1.route('/', authRoutes);
  app.route('/v1', v1);

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Not found' } }, 404),
  );

  app.onError((err, c) => {
    console.error('[api] unhandled error', err);
    return c.json(
      { error: { code: 'internal_error', message: 'Internal server error' } },
      500,
    );
  });

  return app;
}
