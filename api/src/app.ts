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
import { assetsApp } from './routes/assets';
import { rentSchedulesApp } from './routes/rent-schedules';
import { chargesApp } from './routes/charges';
import { paymentsApp } from './routes/payments';
import { ledgerApp } from './routes/ledger';
import { rentRollupApp } from './routes/rent-rollup';
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

// The Hono app, configured but NOT listening. index.ts mounts it on a
// node-server port; tests call app.fetch(request) directly without binding
// to a port.
//
// Route hierarchy:
//   /healthz                                            (no auth)
//   /v1/auth/{signup,login,refresh,logout}              (no auth)
//   /v1/me                                              (requireAuth)
//   /v1/profile                                         (requireAuth)
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
  // newApiApp wires the centralised validation-failure hook (zod errors ->
  // the 400 envelope). Every sub-app comes from the same factory because
  // defaultHook does not inherit across `.route()` mounts.
  const app = newApiApp();

  // Fire-and-forget at boot: probe the hosted Storage HEIC rendition path.
  // If it fails the probe logs a loud warning to
  // stderr -- it does NOT throw, because non-HEIC workloads still work.
  // The /healthz endpoint surfaces the result so an external monitor can
  // alert on degraded evidence-rendering capability.
  void assertImageStackAtBoot();

  // Fire-and-forget at boot: the in-process job queue does not survive a
  // restart, so evidence exports still queued/running -- and import sessions
  // still parsing -- are unfinishable. Mark them failed with a retry message.
  // Never throws (unit tests build the app with no DB configured).
  void recoverOrphanedEvidenceExports();
  void recoverOrphanedImportSessions();

  // Correlation id + one summary log line per request, before everything
  // else so even CORS-rejected and 413-rejected requests are visible.
  app.use('*', requestId());
  app.use('*', requestLog());

  // Mounted before any routes (incl. /v1/auth) so browser preflight
  // (OPTIONS) requests are answered -- and Access-Control-Allow-Origin is
  // set on actual responses -- for every endpoint, authenticated or not.
  app.use('*', corsMiddleware());

  // Bound total in-app time below Render's ~30s edge timeout so a slow request
  // becomes a typed, retryable 503 from the APP (carrying the error envelope)
  // instead of a bodyless 503 synthesised by the edge. Mounted high -- below
  // requestId/requestLog (so the 503 is logged with its `ms`) and cors, above
  // the account stack -- so it covers every leg (auth, idempotency, downloads).
  // It bounds server compute + the storage fetch, NOT client transfer time
  // (see middleware/timeout.ts), so large mobile downloads are unaffected.
  app.use('*', requestTimeout(25_000));

  // Body-size guard, mounted on EVERYTHING (including the unauthenticated
  // auth + intake legs -- those are exactly where an unbounded body is a
  // memory-DoS). parseBody()/json() buffer the whole body before any
  // application-level size check can run, so the cap must sit here in the
  // middleware stack. Large upload/capture endpoints get headroom above their
  // route-level caps (20 MiB files or 10 MiB decoded comm attachments);
  // everything else is JSON and gets 1 MiB.
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

  // Liveness probe: "the process is up", nothing more. No auth, no DB, no
  // capability probes -- deliberately cheaper than /healthz so a keep-alive
  // pinger (e.g. a scheduled curl to stop the host idling) doesn't trigger a
  // DB round-trip on every hit. Use /healthz when you need dependency health.
  app.get('/livez', (c) => c.text('ok'));

  app.get('/healthz', async (c) => {
    const heic = heicSupported();
    return c.json({
      status: 'ok',
      // null = boot probe still pending. Thereafter this tracks the latest
      // real HEVC Storage rendition, so request-time outage/recovery changes
      // the signal instead of leaving a stale boot snapshot.
      capabilities: {
        heic_decode: heic,
        // Onboarding import needs ANTHROPIC_API_KEY (LLM) + SUPABASE_DB_URL
        // (executor), and the DB must actually answer (db_reachable -- cached
        // live probe). Reported here so a monitor catches a misconfigured env
        // instead of the user hitting a 502 on first preview.
        import: await importCapability(),
      },
    });
  });

  // Unauthenticated leg
  app.route('/v1', authRoutes);

  // Authenticated, account-agnostic
  app.route('/v1', meRoutes);
  app.route('/v1', profileRoutes);

  // ----- Account-scoped middleware stack ---------------------------------
  // Mounted ONCE at the v1 level rather than per-resource-sub-app. With
  // per-sub-app `.use('/accounts/:accountId/*', ...)` each sub-app's
  // middleware fired for EVERY account-scoped URL, so an /areas POST would
  // run propertiesApp's and areasApp's idempotency middleware in series and
  // claim the same key twice. One mount = one execution.
  //
  // Order matters: auth -> membership -> principal -> immediate-parent
  // (specific sub-paths only) -> idempotency.

  app.use(
    '/v1/accounts/:accountId/*',
    requireAuth(),
    requireAccountMembership(),
    resolvePrincipal(),
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
  app.route('/v1', assetsApp);
  app.route('/v1', rentSchedulesApp);
  app.route('/v1', chargesApp);
  app.route('/v1', paymentsApp);
  app.route('/v1', ledgerApp);
  app.route('/v1', rentRollupApp);
  app.route('/v1', eventsApp);
  // Read-only, account-scoped, ranked search across all entity kinds.
  app.route('/v1', searchApp);
  app.route('/v1', intakeTokensApp);
  app.route('/v1', agentGrantsApp);
  app.route('/v1', maintenanceRequestsApp);
  app.route('/v1', interactionsApp);
  // Communications ledger (threads, outbox, opt-outs, policies). Core owns
  // the STATE only: the provider-calling transport lives in the agent repo
  // and drives these endpoints; no provider SDK or webhook exists here.
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

  // PUBLIC, UNAUTHENTICATED. Lives in src/admin/ because it uses the
  // service-role client (RLS is bypassed; the handler is the sole guard).
  // Token verification + per-token + per-IP rate limits are inside the
  // handler. Mounted OUTSIDE the v1-level auth/idempotency stack since
  // it can't pass requireAuth (there is no JWT) and account-id comes from
  // the verified token, not the URL.
  app.route('/v1', intakeApp);
  app.route('/v1', documentAccessApp);
  app.route('/v1', inspectionCaptureApp);
  // PUBLIC email unsubscribe (CAN-SPAM / RFC 8058). No JWT: the signed HMAC
  // token is the auth. Service-role work is quarantined in admin/unsubscribe.
  app.route('/v1', unsubscribeApp);

  // ROOT-AUTHED agent token exchange (ADR-0009 Phase 3). In src/admin/ because
  // it mints per-account sessions with the service-role client. Authenticated
  // by the X-Agent-Secret header (a hashed bearer secret), NOT a user JWT --
  // so, like intakeApp, it is mounted OUTSIDE the v1 account stack
  // (/v1/agent/* never matches /v1/accounts/:accountId/*).
  app.route('/v1', agentTokensApp);

  // Emitted OpenAPI document, served at runtime for clients that fetch the
  // spec live (e.g. to regenerate a typed client). Post-processed through the
  // SAME injector as the committed openapi/openapi.json (openapi/emit.ts), so
  // the live spec and the file the SDK is generated from are byte-identical --
  // in particular both declare the app-level Idempotency-Key contract that the
  // per-route definitions can't express. Computed once, lazily, on first hit.
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
      // Expected, route-thrown errors. Handlers throw these in lieu of
      // returning typed error responses (which fight zod-openapi's response
      // inference) so this is the single place error envelopes are formatted.
      // A 503 is retryable -- tell the client when to come back. (5s is a
      // conservative default; the header's presence matters more than the value.)
      if (err.status === 503) c.header('Retry-After', '5');
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        err.status,
      );
    }
    // A raw throw that reached here unwrapped (an undici socket error, a pg pool
    // failure) is usually a transient dependency blip, not a code bug. Classify
    // it as a retryable 503 so cold-start / brief-outage windows are recoverable
    // by the client rather than surfacing as a hard 500.
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
