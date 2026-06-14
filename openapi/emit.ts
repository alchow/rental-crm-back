// Walk the Hono OpenAPIHono app, ask it for its OpenAPI 3.1 document, and
// write it to openapi.json. Run via `pnpm --filter ./openapi emit`.
//
// The OpenAPI document is the single source of truth for the client
// contract: the SDK is generated from this file, and the CI 'check' job
// fails on drift between the regenerated SDK and the committed one.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Env that the app's modules require at import time. None of these need
// to be real for emission -- we never hit the network.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.PORT = process.env.PORT ?? '8787';
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? 'placeholder-min-20chars-for-emit';
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'placeholder-min-20chars-for-emit';

const { buildApp } = await import('../api/src/app');

const app = buildApp();
const doc = app.getOpenAPI31Document({
  openapi: '3.1.0',
  info: {
    title: 'rental-crm-back',
    version: '0.1.0',
    description:
      'Landlord CRM backend -- record-keeping-first. All clients bind only to this contract.',
  },
  servers: [{ url: '/', description: 'same-origin' }],
});

// ---------------------------------------------------------------------------
// Idempotency contract injection.
//
// `Idempotency-Key` is enforced at the app level by requireIdempotency()
// (api/src/middleware/idempotency.ts), mounted once on
// /v1/accounts/:accountId/*. Because the OpenAPI document is generated from
// the per-route createRoute definitions, that app-level middleware is
// invisible to it -- which is why the published spec didn't declare the
// header. Rather than repeat the declaration in every route file (and have to
// remember it on every new one), we inject it HERE, keyed off the SAME rule
// the middleware uses: every mutating method under an account-scoped path.
// One source of truth that cannot drift from the runtime.
//
// For each such operation we declare:
//   - the required `Idempotency-Key` request header,
//   - a 409 response (ErrorEnvelope) -- idempotency_conflict / _in_flight, plus
//     the domain 409s (send_state_unknown, invalid_correction_target, ...),
//   - an `Idempotency-Replay` response header on each 2xx (set to 'true' when
//     the response was served from the idempotency cache).
// ---------------------------------------------------------------------------
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

const outPath = resolve(import.meta.dirname, 'openapi.json');
writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');

console.info(`wrote ${outPath}`);
