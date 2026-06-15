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
// The doc config + the Idempotency-Key injection live in api/src so the runtime
// `/openapi.json` handler (app.ts) and this emitter produce the SAME document.
const { OPENAPI_DOC_CONFIG, injectIdempotencyContract } = await import(
  '../api/src/openapi/idempotency-contract'
);

const app = buildApp();
const doc = injectIdempotencyContract(app.getOpenAPI31Document(OPENAPI_DOC_CONFIG));

const outPath = resolve(import.meta.dirname, 'openapi.json');
writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');

console.info(`wrote ${outPath}`);
