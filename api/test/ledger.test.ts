// ----------------------------------------------------------------------------
// Ledger + pagination regression tests (architecture plan, Phase 0/1).
//
// (A) Ledger isolation across tenancies in ONE account: the allocations
//     fetch was account-wide before Phase 0; this asserts tenancy A's
//     totals and entries are unaffected by tenancy B's charges/payments/
//     allocations, and that the numbers are exactly right.
// (B) Voided-charge allocation: the payment shows as unapplied credit.
// (C) keysetPage at the HTTP level: a garbage cursor is 400
//     invalid_request (it used to silently restart at page 1); a valid
//     pagination walk returns every row exactly once in stable order.
//
// Requires the local Supabase stack (`supabase start` in db/), same as the
// other integration suites.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';

interface SupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function readSupabaseStatus(): SupabaseStatus {
  const out = execSync('supabase status --output env --workdir db', {
    cwd: process.cwd().endsWith('/api') ? '..' : '.',
    encoding: 'utf8',
  });
  const lines = out.split('\n');
  const get = (k: string) => {
    const line = lines.find((l) => l.startsWith(k + '='));
    if (!line) throw new Error(`supabase status missing: ${k}`);
    return line.slice(k.length + 1).replace(/^"|"$/g, '');
  };
  return {
    API_URL: get('API_URL'),
    ANON_KEY: get('ANON_KEY'),
    SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY'),
  };
}

const status = readSupabaseStatus();
process.env.NODE_ENV = 'test';
process.env.PORT = '8791';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { buildApp } = await import('../src/app');

const app = buildApp();

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase()) && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface Failure { name: string; detail: string }
const failures: Failure[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.info(`  PASS  ${name}`); }
  catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}
function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

// --- fixture: one account, two tenancies -------------------------------------

const email = `ledger-${rnd()}@example.test`;
const su = await api('POST', '/v1/auth/signup', {
  body: { email, password: `correct-horse-battery-${rnd()}`, account_name: 'Ledger Acct' },
});
if (su.status !== 200) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.body)}`);
const sub = su.body as { account: { id: string }; session: { access_token: string } };
const token = sub.session.access_token;
const acct = sub.account.id;

const post = async <T>(p: string, body: unknown): Promise<T> => {
  const r = await api('POST', `/v1/accounts/${acct}${p}`, { token, body });
  if (r.status !== 201) throw new Error(`POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
};

const property = await post<{ id: string }>('/properties', { name: 'Ledger prop' });
const areaA = await post<{ id: string }>('/areas', { property_id: property.id, kind: 'unit', name: 'Unit A' });
const areaB = await post<{ id: string }>('/areas', { property_id: property.id, kind: 'unit', name: 'Unit B' });
const tenancyA = await post<{ id: string }>('/tenancies', { area_id: areaA.id, start_date: '2026-01-01', status: 'active' });
const tenancyB = await post<{ id: string }>('/tenancies', { area_id: areaB.id, start_date: '2026-01-01', status: 'active' });

// Tenancy A: 1000 rent charge, 800 payment fully allocated to it.
const chargeA = await post<{ id: string }>('/charges', {
  tenancy_id: tenancyA.id, type: 'rent', amount_cents: 1000, currency: 'USD', due_date: '2026-02-01',
});
await post('/payments', {
  tenancy_id: tenancyA.id, amount_cents: 800, currency: 'USD',
  received_at: '2026-02-02T00:00:00.000Z', method: 'check',
  allocations: [{ charge_id: chargeA.id, amount_cents: 800 }],
});

// Tenancy B: 500 charge, 500 payment fully allocated. Must NOT bleed into A.
const chargeB = await post<{ id: string }>('/charges', {
  tenancy_id: tenancyB.id, type: 'rent', amount_cents: 500, currency: 'USD', due_date: '2026-02-01',
});
await post('/payments', {
  tenancy_id: tenancyB.id, amount_cents: 500, currency: 'USD',
  received_at: '2026-02-03T00:00:00.000Z', method: 'cash',
  allocations: [{ charge_id: chargeB.id, amount_cents: 500 }],
});

interface TypeTotals { charges_cents: number; allocated_cents: number; balance_cents: number }
interface LedgerTotals {
  rent_charges_cents: number;
  rent_payments_cents: number;
  rent_balance_cents: number;
  deposit_charges_cents: number;
  deposit_payments_cents: number;
  deposit_balance_cents: number;
  total_received_cents: number;
  total_allocated_cents: number;
  unapplied_credit_cents: number;
  by_type: Record<string, TypeTotals>;
}
interface LedgerBody { entries: { kind: string; id: string }[]; totals: LedgerTotals }

function assertTypeTotals(actual: TypeTotals, expected: TypeTotals, label: string): void {
  assertEq(actual.charges_cents, expected.charges_cents, `${label}.charges_cents`);
  assertEq(actual.allocated_cents, expected.allocated_cents, `${label}.allocated_cents`);
  assertEq(actual.balance_cents, expected.balance_cents, `${label}.balance_cents`);
}

await check('(A) tenancy A ledger unaffected by tenancy B', async () => {
  const r = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancyA.id}/ledger`, { token });
  assertEq(r.status, 200, 'status');
  const body = r.body as LedgerBody;
  assertEq(body.entries.length, 2, 'entry count (1 charge + 1 payment)');
  assertEq(body.totals.rent_charges_cents, 1000, 'rent_charges_cents');
  assertEq(body.totals.rent_payments_cents, 800, 'rent_payments_cents');
  assertEq(body.totals.rent_balance_cents, 200, 'rent_balance_cents');
  assertEq(body.totals.total_received_cents, 800, 'total_received_cents');
  assertEq(body.totals.total_allocated_cents, 800, 'total_allocated_cents');
  assertEq(body.totals.unapplied_credit_cents, 0, 'unapplied_credit_cents');
});

await check('(B) voided charge frees the payment into unapplied credit', async () => {
  const v = await api('POST', `/v1/accounts/${acct}/charges/${chargeA.id}/void`, {
    token, body: { void_reason: 'entered in error' },
  });
  assertEq(v.status, 200, 'void status');
  const r = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancyA.id}/ledger`, { token });
  const body = r.body as LedgerBody;
  assertEq(body.totals.rent_charges_cents, 0, 'rent_charges_cents after void');
  assertEq(body.totals.total_received_cents, 800, 'total_received_cents after void');
  assertEq(body.totals.total_allocated_cents, 0, 'total_allocated_cents after void');
  assertEq(body.totals.unapplied_credit_cents, 800, 'unapplied_credit_cents after void');
  // Void exclusion must hold in by_type too — the voided rent charge and its
  // (now-released) allocation count nowhere. Pinned here because the identity
  // checks in (D) can't catch a leak that hits legacy and by_type equally.
  assertTypeTotals(
    body.totals.by_type.rent!,
    { charges_cents: 0, allocated_cents: 0, balance_cents: 0 },
    'by_type.rent after void',
  );
});

// --- by_type: the honest per-charge-type split (PR 2) ------------------------
// Tenancy B grows a $120 utility charge (half-paid) and a fully-paid $300
// deposit; its original $5 rent charge stays fully paid.

await check('(D) by_type splits utility/deposit/rent honestly', async () => {
  const utilCharge = await post<{ id: string }>('/charges', {
    tenancy_id: tenancyB.id, type: 'utility', amount_cents: 12000, currency: 'USD', due_date: '2026-03-01',
  });
  await post('/payments', {
    tenancy_id: tenancyB.id, amount_cents: 5000, currency: 'USD',
    received_at: '2026-03-02T00:00:00.000Z', method: 'ach',
    allocations: [{ charge_id: utilCharge.id, amount_cents: 5000 }],
  });
  const depCharge = await post<{ id: string }>('/charges', {
    tenancy_id: tenancyB.id, type: 'deposit', amount_cents: 30000, currency: 'USD', due_date: '2026-02-01',
  });
  await post('/payments', {
    tenancy_id: tenancyB.id, amount_cents: 30000, currency: 'USD',
    received_at: '2026-02-02T00:00:00.000Z', method: 'check',
    allocations: [{ charge_id: depCharge.id, amount_cents: 30000 }],
  });

  const r = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancyB.id}/ledger`, { token });
  assertEq(r.status, 200, 'status');
  const t = (r.body as LedgerBody).totals;

  assertTypeTotals(t.by_type.rent!,    { charges_cents: 500,   allocated_cents: 500,  balance_cents: 0 },    'by_type.rent');
  assertTypeTotals(t.by_type.utility!, { charges_cents: 12000, allocated_cents: 5000, balance_cents: 7000 }, 'by_type.utility');
  assertTypeTotals(t.by_type.deposit!, { charges_cents: 30000, allocated_cents: 30000, balance_cents: 0 },   'by_type.deposit');
  assertTypeTotals(t.by_type.late_fee!, { charges_cents: 0, allocated_cents: 0, balance_cents: 0 }, 'by_type.late_fee (zero row present)');

  // Identities: by_type.deposit ≡ legacy deposit buckets; Σ non-deposit ≡ legacy rent_*.
  assertEq(t.by_type.deposit!.charges_cents, t.deposit_charges_cents, 'deposit identity (charges)');
  assertEq(t.by_type.deposit!.allocated_cents, t.deposit_payments_cents, 'deposit identity (payments)');
  assertEq(t.by_type.deposit!.balance_cents, t.deposit_balance_cents, 'deposit identity (balance)');
  const nonDeposit = Object.entries(t.by_type).filter(([k]) => k !== 'deposit').map(([, v]) => v);
  assertEq(nonDeposit.reduce((s, v) => s + v.charges_cents, 0), t.rent_charges_cents, 'Σ non-deposit charges ≡ rent_charges_cents');
  assertEq(nonDeposit.reduce((s, v) => s + v.allocated_cents, 0), t.rent_payments_cents, 'Σ non-deposit allocated ≡ rent_payments_cents');
  assertEq(nonDeposit.reduce((s, v) => s + v.balance_cents, 0), t.rent_balance_cents, 'Σ non-deposit balance ≡ rent_balance_cents');
});

await check('(E) by_type composes with as_of (utility not yet due is excluded)', async () => {
  const r = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancyB.id}/ledger?as_of=2026-02-15`, { token });
  assertEq(r.status, 200, 'status');
  const t = (r.body as LedgerBody).totals;
  // At Feb 15: rent (due Feb 1) + deposit (due Feb 1, paid Feb 2) are in;
  // the utility charge (due Mar 1) and its payment (Mar 2) are not.
  assertTypeTotals(t.by_type.rent!,    { charges_cents: 500,   allocated_cents: 500,   balance_cents: 0 }, 'as_of by_type.rent');
  assertTypeTotals(t.by_type.deposit!, { charges_cents: 30000, allocated_cents: 30000, balance_cents: 0 }, 'as_of by_type.deposit');
  assertTypeTotals(t.by_type.utility!, { charges_cents: 0,     allocated_cents: 0,     balance_cents: 0 }, 'as_of by_type.utility');
});

await check('(C1) garbage cursor is a 400 invalid_request', async () => {
  const r = await api('GET', `/v1/accounts/${acct}/properties?cursor=garbage`, { token });
  assertEq(r.status, 400, 'status');
  const code = (r.body as { error?: { code?: string } }).error?.code;
  assertEq(code, 'invalid_request', 'error code');
});

await check('(C2) pagination walk returns every row exactly once', async () => {
  await post('/properties', { name: 'Pag 1' });
  await post('/properties', { name: 'Pag 2' });
  await post('/properties', { name: 'Pag 3' });
  const seen = new Set<string>();
  let cursor: string | null = null;
  let guard = 0;
  do {
    const qs: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
    const r = await api('GET', `/v1/accounts/${acct}/properties${qs}`, { token });
    assertEq(r.status, 200, 'page status');
    const page = r.body as { data: { id: string }[]; next_cursor: string | null };
    for (const row of page.data) {
      if (seen.has(row.id)) throw new Error(`row ${row.id} returned twice`);
      seen.add(row.id);
    }
    cursor = page.next_cursor;
    guard += 1;
  } while (cursor && guard < 10);
  assertEq(seen.size, 4, 'total rows across pages (1 fixture + 3 pag)');
});

// --- summary -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n${failures.length} ledger/pagination failure(s):`);
  for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.info('\nOK: ledger + pagination checks all green');
