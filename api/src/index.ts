import { serve } from '@hono/node-server';
import { buildApp } from './app';
import { loadEnv } from './env';
import { getLogger } from './log';
import { closePool } from './admin/db-pool';
import { syncPremiumSubdomainLabels } from './admin/sync-premium-subdomains';

const env = loadEnv();
const log = getLogger();
const app = buildApp();

// Connection-hygiene backstops, sized ABOVE the app-level requestTimeout
// (25s, app.ts) but below Render's ~30s edge timeout. The TYPED 503 envelope
// comes from the app middleware; Node's own requestTimeout only emits a
// bodyless 408, so these are last-resort socket guards that should rarely fire.
// keepAliveTimeout sits above a typical LB idle so we don't reset pooled
// connections mid-keepalive.
const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    serverOptions: {
      requestTimeout: 30_000,
      headersTimeout: 26_000,
      keepAliveTimeout: 61_000,
    },
  },
  (info) => {
    log.info({ port: info.port }, 'api listening');
  },
);

// Reconcile the DB premium-subdomain backstop (public.reserved_subdomain_labels)
// to the config file on boot. Fire-and-forget: this must NOT block or crash the
// server — the API layer already enforces the file, so a sync failure only means
// the direct-PostgREST backstop may lag the config file until the next boot.
void syncPremiumSubdomainLabels().catch((err: unknown) => {
  log.error(
    { err },
    'premium subdomain sync failed — DB backstop may lag the config file until next boot',
  );
});

// Render (and any supervisor) sends SIGTERM on every deploy. Stop accepting
// new connections, let in-flight requests finish, drain the import pg pool,
// then exit. The deadline force-exits if a request wedges -- bounded by the
// platform's own kill timeout rather than hanging until SIGKILL.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  const deadline = setTimeout(() => {
    log.error('shutdown deadline exceeded; forcing exit');
    process.exit(1);
  }, 10_000);
  deadline.unref();
  server.close((closeErr) => {
    void closePool()
      .catch((poolErr: unknown) => log.error({ err: poolErr }, 'pg pool close failed'))
      .finally(() => {
        if (closeErr) {
          log.error({ err: closeErr }, 'server close error');
          process.exit(1);
        }
        log.info('shutdown complete');
        process.exit(0);
      });
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Last-resort visibility: a crash must leave a structured, attributable
// trace in the log stream. Exiting matches Node's default behavior for
// both cases; the point here is the log line, not the policy.
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
