import type { OpenAPIHono } from '@hono/zod-openapi';
import { newApiApp } from './routes/_lib/app';
import meRoutes from './routes/me';
import profileRoutes from './routes/profile';
import authRoutes from './routes/auth';
import { accountsApp } from './routes/accounts';
import { propertiesApp } from './routes/properties';
import { vendorsApp } from './routes/vendors';
import { tenantsApp } from './routes/tenants';
import { areasApp } from './routes/areas';
import { unitDetailsApp } from './routes/unit-details';
import { areaInspectionLayoutsApp } from './routes/area-inspection-layouts';
import { tenanciesApp } from './routes/tenancies';
import { tenancyMembersApp } from './routes/tenancy-members';
import { leasesApp } from './routes/leases';
import { noticesApp } from './routes/notices';
import { incidentsApp } from './routes/incidents';
import { assetsApp } from './routes/assets';
import { rentSchedulesApp } from './routes/rent-schedules';
import { chargesApp } from './routes/charges';
import { paymentsApp } from './routes/payments';
import { ledgerApp } from './routes/ledger';
import { adoptionApp } from './routes/adoption';
import { rentRollupApp } from './routes/rent-rollup';
import { rentAdjustmentsApp } from './routes/rent-adjustments/router';
import { eventsApp } from './routes/events';
import { intakeTokensApp } from './routes/intake-tokens';
import { agentGrantsApp } from './routes/agent-grants';
import { maintenanceRequestsApp } from './routes/maintenance-requests';
import { interactionsApp } from './routes/interactions';
import { commsApp } from './routes/comms';
import { ownerPhoneApp } from './routes/owner-phone';
import { settingsApp } from './routes/settings';
import { intakeApp } from './admin/intake';
import { agentTokensApp } from './admin/agent-tokens';
import { attachmentsApp } from './routes/attachments';
import { documentAccessApp, documentsApp } from './routes/documents';
import { inspectionCaptureApp } from './routes/inspection-capture';
import { unsubscribeApp } from './routes/unsubscribe';
import { evidenceExportsApp } from './routes/evidence-exports';
import { importsApp } from './routes/imports';
import { searchApp } from './routes/search';
import {
  inspectionTemplatesApp,
  inspectionsApp,
  inspectionItemsApp,
} from './routes/inspections';
import { ApiError, classifyTransient } from './routes/_lib/error';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import type { Context } from 'hono';
import { corsMiddleware } from './middleware/cors';
import { requestLog } from './middleware/request-log';
import { getLogger } from './log';
import { requireAuth } from './middleware/auth';
import { requireAccountMembership } from './middleware/account-context';
import { resolvePrincipal } from './middleware/principal';
import { requireIdempotency } from './middleware/idempotency';
import { requestTimeout } from './middleware/timeout';
import { requireImmediateParent } from './middleware/immediate-parent';
import { assertImageStackAtBoot, heicSupported } from './admin/heic-probe';
import { recoverOrphanedEvidenceExports } from './admin/export-pdf';
import { importCapability, recoverOrphanedImportSessions } from './admin/import-health';
import { jobStatus } from './admin/scheduler';
import {
  OPENAPI_DOC_CONFIG,
  injectIdempotencyContract,
  injectSchemaHygiene,
  injectServiceUnavailable,
} from './openapi/idempotency-contract';

const LARGE_BODY_PATH_RE =
  /^\/v1\/(?:intake\/[^/]+|accounts\/[^/]+\/(?:imports|attachments|documents|interactions\/[^/]+\/attachments)|inspection-capture\/[^/]+\/items\/[^/]+\/photos)\/?$/;

export function usesLargeBodyLimit(path: string): boolean {
  return LARGE_BODY_PATH_RE.test(path);
}

// Tests use app.fetch; index.ts owns the listener.
// SECURITY: Account routes share one JWT stack; token routes derive their own scope.
export function buildApp(): OpenAPIHono {
  // Sub-apps need their own validation hook; Hono does not inherit it across mounts.
  const app = newApiApp();

  // Probe HEIC asynchronously; failure degrades /healthz without blocking other workloads.
  void assertImageStackAtBoot();

  // The in-process queue cannot resume after restart; mark orphaned jobs failed for retry.
  void recoverOrphanedEvidenceExports();
  void recoverOrphanedImportSessions();

  // Log even CORS and body-limit rejections.
  app.use('*', requestId());
  app.use('*', requestLog());

  // CORS must handle preflight before authentication.
  app.use('*', corsMiddleware());

  // Return a typed 503 before the edge timeout; streamed client transfer time is excluded.
  app.use('*', requestTimeout(25_000));

  // Bound buffering before body parsing, including public routes. Uploads need
  // headroom above their file limits; ordinary JSON requests get 1 MiB.
  const payloadTooLarge = (c: Context) =>
    c.json(
      { error: { code: 'payload_too_large', message: 'request body exceeds the allowed size' } },
      413,
    );
  const defaultBodyLimit = bodyLimit({ maxSize: 1 * 1024 * 1024, onError: payloadTooLarge });
  const uploadBodyLimit = bodyLimit({ maxSize: 25 * 1024 * 1024, onError: payloadTooLarge });
  app.use('*', (c, next) =>
    (usesLargeBodyLimit(c.req.path) ? uploadBodyLimit : defaultBodyLimit)(c, next),
  );

  // Keep liveness free of dependency checks; /healthz reports capabilities.
  app.get('/livez', (c) => c.text('ok'));

  app.get('/healthz', async (c) => {
    const heic = heicSupported();
    return c.json({
      status: 'ok',
      // null means the probe is pending; later renditions update this signal.
      capabilities: {
        heic_decode: heic,
        // Report missing import configuration and cached database reachability.
        import: await importCapability(),
      },
      // null = not run, ok: null = running, {} = scheduler disabled.
      jobs: jobStatus(),
    });
  });

  // Unauthenticated leg
  app.route('/v1', authRoutes);

  // Authenticated, account-agnostic
  app.route('/v1', meRoutes);
  app.route('/v1', profileRoutes);

  // Mount once: auth -> membership -> principal -> immediate parent -> idempotency.
  // Per-resource middleware mounts would claim the same idempotency key repeatedly.

  app.use(
    '/v1/accounts/:accountId/*',
    requireAuth(),
    requireAccountMembership(),
    resolvePrincipal(),
  );

  // Resolve additional path parents before handlers or idempotency claims.
  app.use(
    '/v1/accounts/:accountId/tenancies/:tenancyId/*',
    requireImmediateParent({ table: 'tenancies', paramName: 'tenancyId' }),
  );
  app.use(
    '/v1/accounts/:accountId/areas/:areaId/*',
    requireImmediateParent({ table: 'areas', paramName: 'areaId' }),
  );

  // Rejected account or parent scope must not claim a key.
  app.use('/v1/accounts/:accountId/*', requireIdempotency());

  // Account routes inherit the single middleware stack above.
  app.route('/v1', accountsApp);
  app.route('/v1', propertiesApp);
  app.route('/v1', vendorsApp);
  app.route('/v1', tenantsApp);
  app.route('/v1', areasApp);
  app.route('/v1', unitDetailsApp);
  app.route('/v1', areaInspectionLayoutsApp);
  app.route('/v1', tenanciesApp);
  app.route('/v1', tenancyMembersApp);
  app.route('/v1', leasesApp);
  app.route('/v1', noticesApp);
  app.route('/v1', incidentsApp);
  app.route('/v1', assetsApp);
  app.route('/v1', rentSchedulesApp);
  app.route('/v1', chargesApp);
  app.route('/v1', paymentsApp);
  app.route('/v1', ledgerApp);
  app.route('/v1', adoptionApp);
  app.route('/v1', rentRollupApp);
  app.route('/v1', rentAdjustmentsApp);
  app.route('/v1', eventsApp);
  app.route('/v1', searchApp);
  app.route('/v1', intakeTokensApp);
  app.route('/v1', agentGrantsApp);
  app.route('/v1', maintenanceRequestsApp);
  app.route('/v1', interactionsApp);
  // Core records communications state; external transport drives provider calls.
  app.route('/v1', commsApp);
  app.route('/v1', ownerPhoneApp);
  app.route('/v1', settingsApp);
  app.route('/v1', attachmentsApp);
  app.route('/v1', documentsApp);
  app.route('/v1', inspectionTemplatesApp);
  app.route('/v1', inspectionsApp);
  app.route('/v1', inspectionItemsApp);
  app.route('/v1', evidenceExportsApp);
  app.route('/v1', importsApp);

  // SECURITY: Public handlers derive scope from verified tokens and enforce rate limits.
  app.route('/v1', intakeApp);
  app.route('/v1', documentAccessApp);
  app.route('/v1', inspectionCaptureApp);
  // Unsubscribe authenticates with an HMAC token; privileged work stays in admin/.
  app.route('/v1', unsubscribeApp);

  // Agent exchange uses X-Agent-Secret and per-account session minting (ADR-0009).
  app.route('/v1', agentTokensApp);

  // Use the emitter's injectors so the live spec and generated SDK share one contract.
  let openApiDocument: ReturnType<typeof app.getOpenAPI31Document> | undefined;
  app.get('/openapi.json', (c) => {
    if (!openApiDocument) {
      openApiDocument = injectSchemaHygiene(
        injectServiceUnavailable(
          injectIdempotencyContract(app.getOpenAPI31Document(OPENAPI_DOC_CONFIG)),
        ),
      );
    }
    return c.json(openApiDocument);
  });

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Not found' } }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      // Format route errors centrally; clients may retry a 503 after five seconds.
      if (err.status === 503) c.header('Retry-After', '5');
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        err.status,
      );
    }
    // Classify known dependency failures as retryable; other exceptions remain 500s.
    const transient = classifyTransient(err);
    if (transient) {
      c.header('Retry-After', '5');
      return c.json(
        { error: { code: transient.code, message: transient.message } },
        transient.status,
      );
    }
    getLogger().error(
      { err, requestId: c.get('requestId'), method: c.req.method, path: c.req.path },
      'unhandled error',
    );
    return c.json(
      { error: { code: 'internal_error', message: 'Internal server error' } },
      500,
    );
  });

  return app;
}
