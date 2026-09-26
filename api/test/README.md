# API tests

- `*.spec.ts`: Vitest tests without a live Supabase stack; run with `pnpm --filter ./api test:unit`.
- `*.test.ts`: standalone suites classified in `test-manifest.json`; run with their `test:*` script.
- `helpers/integration.ts`: shared environment setup, JSON requests, assertions, and reporting.
- `helpers/env.ts`: fake environment values for unit tests.

For a new integration suite, add its package script and manifest entry.
`pnpm check:test-manifest` checks both the scripts and the test files. Run the classified
integration suites with `pnpm --filter ./api ci:integration` after starting local
Supabase. The manual import suite calls a paid provider and requires separate opt-in.

Configure the environment before importing application modules. Keep domain
fixtures and expected results in the suite; reuse the shared plumbing:

```ts
import {
  assertStatus, configureIntegrationEnv, createApiClient, createCheckHarness,
} from './helpers/integration';

configureIntegrationEnv('8787');
const { buildApp } = await import('../src/app');
const api = createApiClient(buildApp());
const { check, failures } = createCheckHarness();

await check('requires a caller JWT', async () => {
  const response = await api('GET', '/v1/accounts/account-id/properties');
  assertStatus(response, 401, 'missing JWT');
});
if (failures.length) process.exit(1);
```

The JSON client generates a fresh idempotency key for account mutations. Supply
`idempotencyKey: 'same-intent'` for replay tests or `idempotencyKey: null` to test a
missing key. Multipart uploads use `multipart: formData`. Malformed JSON fails the
test. Use `responseType: 'bytes'` for PDFs or images, and `app.fetch` for HTML.

Example: owner JWT → create a property → capture its ID → another account's JWT
requests that property → assert the exact status and error code. A generic `>= 400`
assertion can pass on a server failure without proving account isolation.
