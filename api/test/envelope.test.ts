// ----------------------------------------------------------------------------
// Validation-envelope regression test (Phase 0 of the architecture plan).
//
// Every OpenAPIHono sub-app must answer a zod validation failure with the
// project envelope { error: { code: 'invalid_request', ... } }, not
// zod-openapi's default shape. Hooks do NOT inherit across .route() mounts,
// so this regressed silently on every sub-app built with a bare
// `new OpenAPIHono()` before the newApiApp() factory existed.
//
// The test drives sub-apps DIRECTLY (no root middleware stack), because a
// validation failure responds before any handler -- and therefore before any
// auth/membership/DB access -- runs. No Supabase stack needed.
// ----------------------------------------------------------------------------

// --- env setup BEFORE importing anything that reads env -----------------------
process.env.NODE_ENV = 'test';
process.env.PORT = '8787';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key-padded-to-min-length';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

export {};

interface Case {
  name: string;
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> };
  path: string;
  method: string;
  body: unknown;
}

const { propertiesApp } = await import('../src/routes/properties');
const { tenantsApp } = await import('../src/routes/tenants');
const { paymentsApp } = await import('../src/routes/payments');
const { interactionsApp } = await import('../src/routes/interactions');
const { importsApp } = await import('../src/routes/imports');
const authRoutes = (await import('../src/routes/auth')).default;

const cases: Case[] = [
  {
    name: 'properties: empty create body',
    app: propertiesApp,
    path: `/accounts/${ACCOUNT}/properties`,
    method: 'POST',
    body: {},
  },
  {
    name: 'tenants: empty create body',
    app: tenantsApp,
    path: `/accounts/${ACCOUNT}/tenants`,
    method: 'POST',
    body: {},
  },
  {
    name: 'payments: negative amount',
    app: paymentsApp,
    path: `/accounts/${ACCOUNT}/payments`,
    method: 'POST',
    body: { amount_cents: -1 },
  },
  {
    name: 'interactions: correction_kind without corrects_id',
    app: interactionsApp,
    path: `/accounts/${ACCOUNT}/interactions`,
    method: 'POST',
    body: { correction_kind: 'amend' },
  },
  {
    name: 'imports: empty rows patch',
    app: importsApp,
    path: `/accounts/${ACCOUNT}/imports/${ACCOUNT}/rows`,
    method: 'PATCH',
    body: { updates: [] },
  },
  {
    name: 'auth: signup with invalid email shape',
    app: authRoutes,
    path: '/auth/signup',
    method: 'POST',
    body: { email: 'not-an-email', password: 'x' },
  },
];

const failures: { name: string; detail: string }[] = [];

for (const tc of cases) {
  const res = await tc.app.request(tc.path, {
    method: tc.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tc.body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    failures.push({ name: tc.name, detail: `non-JSON ${res.status} response: ${text.slice(0, 200)}` });
    continue;
  }
  const err = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
  if (res.status !== 400) {
    failures.push({ name: tc.name, detail: `expected 400, got ${res.status}: ${text.slice(0, 200)}` });
  } else if (!err || err.code !== 'invalid_request' || typeof err.message !== 'string') {
    failures.push({
      name: tc.name,
      detail: `expected envelope {error:{code:'invalid_request'}}, got: ${text.slice(0, 200)}`,
    });
  } else {
    console.info(`ok: ${tc.name}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} envelope failure(s):`);
  for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.info('\nOK: validation envelope uniform across sub-apps');
