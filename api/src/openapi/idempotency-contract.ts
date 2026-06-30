// The OpenAPI document config + the app-level Idempotency-Key contract
// injection, shared by BOTH the build-time emitter (openapi/emit.ts, which
// writes openapi/openapi.json) AND the runtime `/openapi.json` handler
// (api/src/app.ts). Keeping them in one module is the whole point: the
// committed spec the SDK is generated from and the spec the server serves at
// runtime are produced by the same code, so they cannot drift from each other
// -- or from the middleware.
//
// `Idempotency-Key` is enforced at the app level by requireIdempotency()
// (api/src/middleware/idempotency.ts), mounted once on
// /v1/accounts/:accountId/*. Because the OpenAPI document is generated from the
// per-route createRoute definitions, that app-level middleware is invisible to
// it -- which is why a route-derived spec doesn't declare the header. Rather
// than repeat the declaration in every route file (and have to remember it on
// every new one), we inject it here, keyed off the SAME rule the middleware
// uses: every mutating method under an account-scoped path.

import type { OpenAPIHono } from '@hono/zod-openapi';

// Single source for the document metadata. Both callers pass this to
// app.getOpenAPI31Document so title/version/servers never disagree.
export const OPENAPI_DOC_CONFIG: Parameters<OpenAPIHono['getOpenAPI31Document']>[0] = {
  openapi: '3.1.0',
  info: {
    title: 'rental-crm-back',
    version: '0.1.0',
    description:
      'Landlord CRM backend -- record-keeping-first. All clients bind only to this contract.',
  },
  servers: [{ url: '/', description: 'same-origin' }],
};

interface OperationObject {
  parameters?: Array<Record<string, unknown>>;
  responses?: Record<string, ResponseObject>;
}
interface ResponseObject {
  description?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, unknown>;
}

const MUTATING = new Set(['post', 'patch', 'put', 'delete']);
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);
const ACCOUNT_SCOPED = /^\/v1\/accounts\/\{accountId\}\//;
const ERROR_REF = { $ref: '#/components/schemas/ErrorEnvelope' };

const idempotencyKeyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'Required on every mutating request. Scoped to (account_id, key); retained ' +
    '30 days. Replaying a key with a byte-identical body returns the original ' +
    'response with the `Idempotency-Replay: true` header; replaying with a ' +
    'different body returns 409 `idempotency_conflict`; a still-in-flight ' +
    'original returns 409 `idempotency_in_flight` (retry shortly). 8-200 chars ' +
    'of [A-Za-z0-9_-]. Omitting it yields 400.',
  schema: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9_-]{8,200}$' },
};

const replayHeader = {
  description:
    "Present and 'true' when this response was replayed from the idempotency " +
    'cache (the original request was not re-executed). Absent on first execution.',
  schema: { type: 'string', enum: ['true'] },
};

const retryAfterHeader = {
  description: 'Seconds to wait before retrying. Present on 503 service_unavailable responses.',
  schema: { type: 'integer', minimum: 0 },
};

// Mutates `doc` in place (and returns it) to declare, for every mutating
// account-scoped operation:
//   - the required `Idempotency-Key` request header,
//   - a 409 response (ErrorEnvelope): idempotency_conflict / _in_flight, plus
//     the domain 409s (invalid_correction_target, ...),
//   - an `Idempotency-Replay` response header on each 2xx (set to 'true' when
//     the response was served from the idempotency cache).
// Idempotent: re-running it on an already-injected doc is a no-op.
export function injectIdempotencyContract<T extends { paths?: unknown }>(doc: T): T {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, OperationObject>>;
  for (const [path, item] of Object.entries(paths)) {
    if (!ACCOUNT_SCOPED.test(path)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!MUTATING.has(method)) continue;

      op.parameters ??= [];
      const hasHeader = op.parameters.some(
        (p) => p['in'] === 'header' && p['name'] === 'Idempotency-Key',
      );
      if (!hasHeader) op.parameters.push(idempotencyKeyParam);

      op.responses ??= {};
      op.responses['409'] ??= {
        description:
          'idempotency_conflict (same key, different body) or idempotency_in_flight ' +
          '(original still running), or a domain conflict for this resource',
        content: { 'application/json': { schema: ERROR_REF } },
      };

      for (const [status, resp] of Object.entries(op.responses)) {
        if (!/^2\d\d$/.test(status)) continue;
        resp.headers ??= {};
        resp.headers['Idempotency-Replay'] ??= replayHeader;
      }
    }
  }
  return doc;
}

// Mutates `doc` in place to declare a 503 `service_unavailable` response on
// EVERY operation. A 503 is produced by the app OUTSIDE any single route's
// definition -- the global request-time-budget timeout and the transient-
// dependency classifier (cold starts, DB/upstream blips) -- so, like the
// idempotency contract, it is injected centrally rather than repeated per route.
// Carries a Retry-After header; the body is the standard ErrorEnvelope.
// Idempotent: re-running it on an already-injected doc is a no-op.
export function injectServiceUnavailable<T extends { paths?: unknown }>(doc: T): T {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, OperationObject>>;
  for (const item of Object.values(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      op.responses ??= {};
      op.responses['503'] ??= {
        description:
          'service_unavailable: a dependency was temporarily unavailable (incl. a cold ' +
          'start) or the request exceeded the server time budget. Retryable -- back off ' +
          'and retry honouring Retry-After. Idempotent GETs are always safe to retry; for ' +
          'mutations reuse the same Idempotency-Key.',
        headers: { 'Retry-After': retryAfterHeader },
        content: { 'application/json': { schema: ERROR_REF } },
      };
    }
  }
  return doc;
}
