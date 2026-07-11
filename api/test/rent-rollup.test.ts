// ----------------------------------------------------------------------------
// Rent-rollup checks (Field Log ask #4).
//
// GET /accounts/{id}/rent-rollup returns one row per current tenancy with
// rent / deposit / unapplied-credit balances, computed by the SECURITY
// INVOKER SQL function rent_rollup() (migration 20260715000001).
//
// THE LOAD-BEARING CHECK IS PARITY: the rollup duplicates the per-tenancy
// ledger's aggregation rules in SQL, so for every tenancy the rollup row
// must equal GET /ledger's totals. Any future change to either side that
// breaks the parity fails here — that is the drift guard both code paths
// point at. The fixture deliberately exercises the tricky rules: partial
// allocations, a voided payment (its allocation must release), a voided
// charge (its payment must surface as unapplied credit), a zero-money
// tenancy (zero row, null currency), and an ended tenancy (excluded by
// default, included via ?status=).
//
// Also probed: RLS floor via a direct RPC call with user A's JWT against
// account B's id (SECURITY INVOKER → zero rows), and the 400 on a bogus
// status value.
//
// Requires the local Supabase stack (`supabase start` in db/).
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

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
process.env.PORT = '8805';
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

async function signup(label: string): Promise<{ token: string; acct: string }> {
  const r = await api('POST', '/v1/auth/signup', {
    body: {
      email: `rollup-${label}-${rnd()}@example.test`,
      password: `correct-horse-battery-${rnd()}`,
      account_name: `Rollup ${label}`,
    },
  });
  if (r.status !== 200) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  const b = r.body as { account: { id: string }; session: { access_token: string } };
  return { token: b.session.access_token, acct: b.account.id };
}

// --- fixture ------------------------------------------------------------------

const A = await signup('A');
const B = await signup('B');
const { token, acct } = A;

const post = async <T>(p: string, body: unknown): Promise<T> => {
  const r = await api('POST', `/v1/accounts/${acct}${p}`, { token, body });
  if (r.status !== 201) throw new Error(`POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
};
const voidRow = async (kind: 'charges' | 'payments', id: string): Promise<void> => {
  const r = await api('POST', `/v1/accounts/${acct}/${kind}/${id}/void`, {
    token, body: { void_reason: 'rollup fixture void' },
  });
  if (r.status !== 200) throw new Error(`void ${kind}/${id} failed: ${r.status}`);
};

const property = await post<{ id: string }>('/properties', { name: 'Rollup prop' });
const mkTenancy = async (name: string, status_: string, start: string) => {
  const area = await post<{ id: string }>('/areas', { property_id: property.id, kind: 'unit', name });
  return post<{ id: string }>('/tenancies', { area_id: area.id, start_date: start, status: status_ });
};

// T1: the kitchen-sink tenancy — every aggregation rule in play.
const t1 = await mkTenancy('Unit R1', 'active', '2026-01-01');
const t1Rent = await post<{ id: string }>('/charges', {
  tenancy_id: t1.id, type: 'rent', amount_cents: 100000, currency: 'USD', due_date: '2026-02-01',
});
await post('/charges', {
  tenancy_id: t1.id, type: 'utility', amount_cents: 12000, currency: 'USD', due_date: '2026-03-01',
});
const t1Dep = await post<{ id: string }>('/charges', {
  tenancy_id: t1.id, type: 'deposit', amount_cents: 30000, currency: 'USD', due_date: '2026-02-01',
});
await post('/payments', {
  tenancy_id: t1.id, amount_cents: 50000, currency: 'USD',
  received_at: '2026-02-02T00:00:00.000Z', method: 'check',
  allocations: [{ charge_id: t1Rent.id, amount_cents: 50000 }],
});
await post('/payments', {
  tenancy_id: t1.id, amount_cents: 30000, currency: 'USD',
  received_at: '2026-02-02T00:00:00.000Z', method: 'ach',
  allocations: [{ charge_id: t1Dep.id, amount_cents: 30000 }],
});
// Unallocated payment: pure unapplied credit.
await post('/payments', {
  tenancy_id: t1.id, amount_cents: 5000, currency: 'USD',
  received_at: '2026-02-03T00:00:00.000Z', method: 'cash',
});
// Voided PAYMENT with a rent allocation: its allocation must release.
const p4 = await post<{ payment: { id: string } }>('/payments', {
  tenancy_id: t1.id, amount_cents: 7000, currency: 'USD',
  received_at: '2026-02-04T00:00:00.000Z', method: 'cash',
  allocations: [{ charge_id: t1Rent.id, amount_cents: 7000 }],
});
await voidRow('payments', p4.payment.id);
// Voided CHARGE with a live payment: the payment becomes unapplied credit.
const cExtra = await post<{ id: string }>('/charges', {
  tenancy_id: t1.id, type: 'other', amount_cents: 4000, currency: 'USD', due_date: '2026-02-15',
});
await post('/payments', {
  tenancy_id: t1.id, amount_cents: 4000, currency: 'USD',
  received_at: '2026-02-16T00:00:00.000Z', method: 'cash',
  allocations: [{ charge_id: cExtra.id, amount_cents: 4000 }],
});
await voidRow('charges', cExtra.id);

// T2: zero money — must still get a (zero) row.
const t2 = await mkTenancy('Unit R2', 'active', '2026-01-01');

// T4: only a VOIDED charge — balances are zero but the ledger still reports
// the voided charge's currency (it reads currency before the void filter);
// the rollup must match. This is the currency edge from the PR review.
const t4 = await mkTenancy('Unit R4', 'active', '2026-01-01');
const t4Charge = await post<{ id: string }>('/charges', {
  tenancy_id: t4.id, type: 'rent', amount_cents: 8000, currency: 'USD', due_date: '2026-02-01',
});
await voidRow('charges', t4Charge.id);

// T3: ended, with money — excluded by default, included via ?status=ended.
const t3 = await mkTenancy('Unit R3', 'ended', '2025-01-01');
await post('/charges', {
  tenancy_id: t3.id, type: 'rent', amount_cents: 50000, currency: 'USD', due_date: '2025-02-01',
});

interface RollupRow {
  tenancy_id: string;
  status: string;
  currency: string | null;
  rent_balance_cents: number;
  deposit_balance_cents: number;
  unapplied_credit_cents: number;
}
interface LedgerView {
  currency: string | null;
  totals: {
    rent_balance_cents: number;
    deposit_balance_cents: number;
    unapplied_credit_cents: number;
  };
}

const getRollup = async (qs = ''): Promise<RollupRow[]> => {
  const r = await api('GET', `/v1/accounts/${acct}/rent-rollup${qs}`, { token });
  if (r.status !== 200) throw new Error(`rollup GET failed: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { data: RollupRow[] }).data;
};
const getLedger = async (tenancyId: string): Promise<LedgerView> => {
  const r = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancyId}/ledger`, { token });
  if (r.status !== 200) throw new Error(`ledger GET failed: ${r.status}`);
  return r.body as LedgerView;
};

// --- tests --------------------------------------------------------------------

console.info('rent-rollup checks');

await check('(1) exact numbers on the kitchen-sink tenancy', async () => {
  const rows = await getRollup();
  const r1 = rows.find((r) => r.tenancy_id === t1.id);
  if (!r1) throw new Error('t1 missing from rollup');
  // Live: rent 100000 + utility 12000 (voided `other` excluded) minus the
  // one live rent allocation of 50000 (the voided payment's 7000 released).
  assertEq(r1.rent_balance_cents, 62000, 'rent_balance');
  assertEq(r1.deposit_balance_cents, 0, 'deposit_balance');
  // received live 50000+30000+5000+4000 = 89000; active allocs 80000;
  // unapplied = 5000 (never allocated) + 4000 (charge voided) = 9000.
  assertEq(r1.unapplied_credit_cents, 9000, 'unapplied_credit');
  assertEq(r1.currency, 'USD', 'currency');
  assertEq(r1.status, 'active', 'status');
});

await check('(2) zero-money tenancy gets a zero row with null currency', async () => {
  const rows = await getRollup();
  const r2 = rows.find((r) => r.tenancy_id === t2.id);
  if (!r2) throw new Error('t2 missing from rollup');
  assertEq(r2.rent_balance_cents, 0, 'rent_balance');
  assertEq(r2.deposit_balance_cents, 0, 'deposit_balance');
  assertEq(r2.unapplied_credit_cents, 0, 'unapplied_credit');
  assertEq(r2.currency, null, 'currency');
});

await check('(3) PARITY: rollup equals GET /ledger for every returned tenancy', async () => {
  const rows = await getRollup();
  for (const row of rows) {
    const ledger = await getLedger(row.tenancy_id);
    assertEq(row.rent_balance_cents, ledger.totals.rent_balance_cents, `t=${row.tenancy_id} rent parity`);
    assertEq(row.deposit_balance_cents, ledger.totals.deposit_balance_cents, `t=${row.tenancy_id} deposit parity`);
    assertEq(row.unapplied_credit_cents, ledger.totals.unapplied_credit_cents, `t=${row.tenancy_id} credit parity`);
    assertEq(row.currency, ledger.currency, `t=${row.tenancy_id} currency parity`);
  }
  if (rows.length < 3) throw new Error(`parity walked only ${rows.length} tenancies`);
});

await check('(3b) currency edge: tenancy whose only charge is voided still reports it', async () => {
  const rows = await getRollup();
  const r4 = rows.find((r) => r.tenancy_id === t4.id);
  if (!r4) throw new Error('t4 missing from rollup');
  assertEq(r4.currency, 'USD', 'currency from voided charge');
  assertEq(r4.rent_balance_cents, 0, 'balances zero');
});

await check('(4) default excludes ended; ?status=ended includes it (with parity)', async () => {
  const rows = await getRollup();
  if (rows.some((r) => r.tenancy_id === t3.id)) throw new Error('ended tenancy in default set');
  const ended = await getRollup('?status=ended');
  const r3 = ended.find((r) => r.tenancy_id === t3.id);
  if (!r3) throw new Error('t3 missing from ?status=ended');
  assertEq(r3.rent_balance_cents, 50000, 'ended rent_balance');
  const ledger = await getLedger(t3.id);
  assertEq(r3.rent_balance_cents, ledger.totals.rent_balance_cents, 'ended parity');
});

await check('(5) bogus status value -> 400 with fieldErrors.status', async () => {
  const r = await api('GET', `/v1/accounts/${acct}/rent-rollup?status=bogus`, { token });
  assertEq(r.status, 400, 'status');
  const err = (r.body as { error: { code: string; details?: { fieldErrors?: Record<string, unknown> } } }).error;
  assertEq(err.code, 'invalid_request', 'code');
  if (!err.details?.fieldErrors?.status) throw new Error('fieldErrors.status missing');
});

await check('(6) RLS floor: direct RPC with A\'s JWT against B\'s account id -> zero rows', async () => {
  // Bypass the API entirely: call PostgREST's RPC endpoint as user A but
  // pass account B's id. SECURITY INVOKER means RLS hides B's rows — the
  // explicit p_account_id predicate is not the fence.
  const sb = createClient(status.API_URL, status.ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await sb.rpc('rent_rollup', { p_account_id: B.acct });
  if (error) throw new Error(`rpc failed: ${error.message}`);
  assertEq((data as unknown[]).length, 0, 'cross-account rpc row count');
  // Sanity that the probe isn't vacuous: same client, own account id → rows.
  const own = await sb.rpc('rent_rollup', { p_account_id: acct });
  if (own.error) throw new Error(`own rpc failed: ${own.error.message}`);
  if ((own.data as unknown[]).length < 2) throw new Error('own-account rpc returned too few rows');
});

await check('(7) grants: a bare-anon RPC call (no user JWT) is refused', async () => {
  const anon = createClient(status.API_URL, status.ANON_KEY);
  const { error } = await anon.rpc('rent_rollup', { p_account_id: acct });
  if (!error) throw new Error('anon call succeeded; execute grant is too broad');
  if (!/permission denied|not.*exist/i.test(error.message)) {
    throw new Error(`unexpected anon error shape: ${error.message}`);
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} rent-rollup failure(s):`);
  for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.info('\nOK: rent-rollup checks all green');
