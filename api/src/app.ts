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
import { rentSchedulesApp } from './routes/rent-schedules';
import { chargesApp } from './routes/charges';
import { paymentsApp } from './routes/payments';
import { ledgerApp } from './routes/ledger';
import { intakeTokensApp } from './routes/intake-tokens';
import { maintenanceRequestsApp } from './routes/maintenance-requests';
import { interactionsApp } from './routes/interactions';
import { intakeApp } from './admin/intake';
import { attachmentsApp } from './routes/attachments';
import { evidenceExportsApp } from './routes/evidence-exports';
import {
  inspectionTemplatesApp,
  inspectionsApp,
  inspectionItemsApp,
} from './routes/inspections';
import { ApiError } from './routes/_lib/error';
import { requireAuth } from './middleware/auth';
import { requireAccountMembership } from './middleware/account-context';
import { requireIdempotency } from './middleware/idempotency';
import { requireImmediateParent } from './middleware/immediate-parent';
import { assertImageStackAtBoot, heicSupported } from './admin/heic-probe';

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

  // Fire-and-forget at boot: probe the sharp/libvips stack for HEIC
  // support. If libheif is missing the probe logs a loud warning to
  // stderr -- it does NOT throw, because non-HEIC workloads still work.
  // The /healthz endpoint surfaces the result so an external monitor can
  // alert on degraded evidence-rendering capability.
  void assertImageStackAtBoot();

  app.get('/healthz', (c) => {
    const heic = heicSupported();
    return c.json({
      status: 'ok',
      // null = probe still pending (first ~50ms after boot); true/false
      // once it's run. Surface in /healthz so deploy-target monitors can
      // alert when an environment regresses on libheif.
      capabilities: { heic_decode: heic },
    });
  });

  // Unauthenticated leg
  app.route('/v1', authRoutes);

  // Authenticated, account-agnostic
  app.route('/v1', meRoutes);

  // ----- Account-scoped middleware stack ---------------------------------
  // Mounted ONCE at the v1 level rather than per-resource-sub-app. With
  // per-sub-app `.use('/accounts/:accountId/*', ...)` each sub-app's
  // middleware fired for EVERY account-scoped URL, so an /areas POST would
  // run propertiesApp's and areasApp's idempotency middleware in series and
  // claim the same key twice. One mount = one execution.
  //
  // Order matters: auth -> membership -> immediate-parent (specific
  // sub-paths only) -> idempotency.

  app.use(
    '/v1/accounts/:accountId/*',
    requireAuth(),
    requireAccountMembership(),
  );

  // Sub-resources whose URL has an extra path-parent (tenancyId / areaId)
  // get an immediate-parent resolver scoped to that sub-path. The narrower
  // pattern fires only when the URL actually has the additional segment.
  app.use(
    '/v1/accounts/:accountId/tenancies/:tenancyId/*',
    requireImmediateParent({ table: 'tenancies', paramName: 'tenancyId' }),
  );
  app.use(
    '/v1/accounts/:accountId/areas/:areaId/*',
    requireImmediateParent({ table: 'areas', paramName: 'areaId' }),
  );

  // Idempotency last so a request that fails account-membership or
  // immediate-parent doesn't even claim a key.
  app.use('/v1/accounts/:accountId/*', requireIdempotency());

  // Account-scoped sub-apps. They no longer carry their own `.use(...)`
  // (the stack above handles it). They simply expose the OpenAPIHono
  // routes; mounting at '/v1' inherits the v1-level middleware.
  app.route('/v1', propertiesApp);
  app.route('/v1', vendorsApp);
  app.route('/v1', tenantsApp);
  app.route('/v1', areasApp);
  app.route('/v1', unitDetailsApp);
  app.route('/v1', tenanciesApp);
  app.route('/v1', tenancyMembersApp);
  app.route('/v1', leasesApp);
  app.route('/v1', assetsApp);
  app.route('/v1', rentSchedulesApp);
  app.route('/v1', chargesApp);
  app.route('/v1', paymentsApp);
  app.route('/v1', ledgerApp);
  app.route('/v1', intakeTokensApp);
  app.route('/v1', maintenanceRequestsApp);
  app.route('/v1', interactionsApp);
  app.route('/v1', attachmentsApp);
  app.route('/v1', inspectionTemplatesApp);
  app.route('/v1', inspectionsApp);
  app.route('/v1', inspectionItemsApp);
  app.route('/v1', evidenceExportsApp);

  // PUBLIC, UNAUTHENTICATED. Lives in src/admin/ because it uses the
  // service-role client (RLS is bypassed; the handler is the sole guard).
  // Token verification + per-token + per-IP rate limits are inside the
  // handler. Mounted OUTSIDE the v1-level auth/idempotency stack since
  // it can't pass requireAuth (there is no JWT) and account-id comes from
  // the verified token, not the URL.
  app.route('/v1', intakeApp);

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
