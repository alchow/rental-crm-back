// Accepted phone spellings normalize to E.164 without guessing a country code.
// Exercise HTTP validation and the direct PostgREST trigger boundary.

import {
  configureIntegrationEnv,
  createApiClient,
  type ApiResponse as ApiResp,
  createCheckHarness,
  randomToken as rnd,
  assertStatus,
  assert,
} from './helpers/integration';

const status = configureIntegrationEnv('8807');

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { buildApp } = await import('../src/app');
const app = buildApp();

// --- helpers (same idiom as tenant-email-uniqueness.test.ts) ----------------

const api = createApiClient(app);

async function pgrest(
  method: string,
  table: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${status.API_URL}/rest/v1/${table}`, {
    method,
    headers: {
      apikey: status.ANON_KEY,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const { check, failures } = createCheckHarness();

function errCode(r: ApiResp): string {
  return (r.body as { error?: { code?: string } })?.error?.code ?? '';
}
function errFieldErrors(r: ApiResp): Record<string, string[]> {
  return ((
    (r.body as { error?: { details?: { fieldErrors?: Record<string, string[]> } } })?.error
      ?.details ?? {}
  ).fieldErrors ?? {}) as Record<string, string[]>;
}
function tenantPhones(r: ApiResp): string[] {
  return ((r.body as { phones?: string[] })?.phones ?? []) as string[];
}
function tenantId(r: ApiResp): string {
  return (r.body as { id: string }).id;
}

interface Account {
  accountId: string;
  token: string;
}

async function signup(label: string): Promise<Account> {
  const ownerEmail = `tpe-${label}-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email: ownerEmail, password, account_name: `TPE ${label}` },
  });
  if (su.status !== 200)
    throw new Error(`signup ${label}: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };
  return { accountId: b.account.id, token: b.session.access_token };
}

async function createTenant(a: Account, body: unknown): Promise<ApiResp> {
  return api('POST', `/v1/accounts/${a.accountId}/tenants`, { token: a.token, body });
}

async function patchTenant(a: Account, id: string, body: unknown): Promise<ApiResp> {
  return api('PATCH', `/v1/accounts/${a.accountId}/tenants/${id}`, { token: a.token, body });
}

// --- suite -------------------------------------------------------------------

const acct = await signup('main');

await check('create normalizes accepted spellings to E.164', async () => {
  const r = await createTenant(acct, {
    full_name: `N ${rnd()}`,
    phones: ['1-617-555-0100', '+1 (505) 555-0101'],
  });
  assertStatus(r, 201, 'create');
  const phones = tenantPhones(r);
  assert(
    phones.length === 2 && phones[0] === '+16175550100' && phones[1] === '+15055550101',
    `stored ${JSON.stringify(phones)}`,
  );
});

await check('two spellings of one number dedupe silently, first-seen order', async () => {
  const r = await createTenant(acct, {
    full_name: `D ${rnd()}`,
    phones: ['+16175550102', '1 (617) 555-0102'],
  });
  assertStatus(r, 201, 'create');
  const phones = tenantPhones(r);
  assert(phones.length === 1 && phones[0] === '+16175550102', `stored ${JSON.stringify(phones)}`);
});

await check('unresolvable phone 422s as invalid_phone naming it (create)', async () => {
  const r = await createTenant(acct, { full_name: `B ${rnd()}`, phones: ['not-a-phone'] });
  assertStatus(r, 422, 'create');
  assert(errCode(r) === 'invalid_phone', `code=${errCode(r)}`);
  const fe = errFieldErrors(r).phones ?? [];
  assert(
    fe.some((m) => m.includes('not-a-phone')),
    `fieldErrors=${JSON.stringify(fe)}`,
  );
});

await check('bare 10-digit input is refused — no server-side country guess', async () => {
  const r = await createTenant(acct, { full_name: `B10 ${rnd()}`, phones: ['617-555-0103'] });
  assertStatus(r, 422, 'create');
  assert(errCode(r) === 'invalid_phone', `code=${errCode(r)}`);
});

await check('PATCH normalizes and rejects the same way', async () => {
  const c = await createTenant(acct, { full_name: `P ${rnd()}` });
  assertStatus(c, 201, 'create');
  const id = tenantId(c);
  const ok = await patchTenant(acct, id, { phones: ['1 (415) 555-0104'] });
  assertStatus(ok, 200, 'patch ok');
  assert(tenantPhones(ok)[0] === '+14155550104', `stored ${JSON.stringify(tenantPhones(ok))}`);
  const bad = await patchTenant(acct, id, { phones: ['nope'] });
  assertStatus(bad, 422, 'patch bad');
  assert(errCode(bad) === 'invalid_phone', `code=${errCode(bad)}`);
});

await check('omitted and empty phones pass through untouched', async () => {
  const none = await createTenant(acct, { full_name: `E ${rnd()}` });
  assertStatus(none, 201, 'create none');
  assert(tenantPhones(none).length === 0, 'expected empty');
  const empty = await patchTenant(acct, tenantId(none), { phones: [] });
  assertStatus(empty, 200, 'patch empty');
  assert(tenantPhones(empty).length === 0, 'expected still empty');
});

await check('DB trigger stops a member writing raw phones via PostgREST', async () => {
  const direct = await pgrest('POST', 'tenants', acct.token, {
    account_id: acct.accountId,
    full_name: `Raw ${rnd()}`,
    phones: ['617-555-0199'],
  });
  // PostgREST surfaces the trigger's check_violation as a 4xx, never a 2xx.
  assert(direct.status >= 400, `expected trigger rejection, got ${direct.status}`);
  const msg = JSON.stringify(direct.body);
  assert(msg.includes('E.164'), `unexpected error body: ${msg}`);
});

// --- summary -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.info('\nAll tenant-phone-e164 checks passed');
