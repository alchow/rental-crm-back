import { OpenAPIHono } from '@hono/zod-openapi';
import meRoutes from './routes/me';
import authRoutes from './routes/auth';
import { propertiesApp } from './routes/properties';
import { vendorsApp } from './routes/vendors';
import { tenantsApp } from './routes/tenants';
import { areasApp } from './routes/areas';
import { unitDetailsApp } from './routes/unit-details';
import { tenanciesApp } from './routes/tenancies';
import { tenancyMembersApp } from './routes/tenancy-members';
import { leasesApp } from './routes/leases';
import { assetsApp } from './routes/assets';
import { ApiError } from './routes/_lib/error';

// The Hono app, configured but NOT listening. index.ts mounts it on a
// node-server port; tests call app.fetch(request) directly without binding
// to a port.
//
// Route hierarchy:
//   /healthz                                            (no auth)
//   /v1/auth/{signup,login,refresh,logout}              (no auth)
//   /v1/me                                              (requireAuth)
//   /v1/accounts/{accountId}/properties/...             (requireAuth + requireAccountMembership)
//   /v1/accounts/{accountId}/vendors/...                (same)
//   /v1/accounts/{accountId}/tenants/...                (same)
//   /openapi.json                                       (no auth)
//
// The account-membership middleware queries account_members through the
// USER-scoped supabase client; RLS is the backstop. The middleware never
// uses the admin client (the only place that could is api/src/admin/, and
// even there only via a wrapping helper -- the ESLint rule enforces this).
export function buildApp(): OpenAPIHono {
  const app = new OpenAPIHono({
    // Centralised validation-failure handler: zod-validation errors become
    // our 400 envelope shape, not zod-openapi's default response. Clients
    // get a stable code regardless of which schema failed.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'invalid_request',
              message: 'request validation failed',
              details: result.error.flatten(),
            },
          },
          400,
        );
      }
    },
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Unauthenticated leg
  app.route('/v1', authRoutes);

  // Authenticated, account-agnostic
  app.route('/v1', meRoutes);

  // Authenticated + account-scoped. Order is informational; all mount at /v1
  // and the resolver runs per-app via its `.use('/accounts/:accountId/*', …)`.
  app.route('/v1', propertiesApp);
  app.route('/v1', vendorsApp);
  app.route('/v1', tenantsApp);
  app.route('/v1', areasApp);
  app.route('/v1', unitDetailsApp);
  app.route('/v1', tenanciesApp);
  app.route('/v1', tenancyMembersApp);
  app.route('/v1', leasesApp);
  app.route('/v1', assetsApp);

  // Emitted OpenAPI document. The /openapi.json route also serves clients
  // that want to fetch the spec at runtime.
  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'rental-crm-back',
      version: '0.1.0',
      description:
        'Landlord CRM backend -- record-keeping-first. All clients bind only to this contract.',
    },
    servers: [
      { url: '/', description: 'same-origin' },
    ],
  });

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Not found' } }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      // Expected, route-thrown errors. Handlers throw these in lieu of
      // returning typed error responses (which fight zod-openapi's response
      // inference) so this is the single place error envelopes are formatted.
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        err.status,
      );
    }
    console.error('[api] unhandled error', err);
    return c.json(
      { error: { code: 'internal_error', message: 'Internal server error' } },
      500,
    );
  });

  return app;
}
