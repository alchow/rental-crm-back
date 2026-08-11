// ----------------------------------------------------------------------------
// Tenancy adoption (ADR-0013, migration 20260810000001).
//
// adopt_tenancy_history() is the atomic commit behind the "adopt mid-tenancy"
// wizard: one transaction creates the rent schedule, backfilled charges,
// payments with caller-proposed allocations, an optional held deposit, and the
// tenancy_adoptions row. Nothing here touches the generator's one-window,
// never-backfill rule.
//
// Covers:
//   (A) Branch-A happy path: schedule + 4 backfilled months + 3 payments +
//       held deposit commit atomically; ledger surfaces the adoption block,
//       charge created_at, per-charge balances, and unapplied credit.
//   (B) Idempotency: same key + body replays the original 201 verbatim and
//       writes nothing twice.
//   (C) Conflicts, each with its fine-grained 409 code: re-adoption
//       (already_adopted), live schedule (schedule_exists), existing money
//       (tenancy_has_money).
//   (D) Validation: branch exclusivity, out-of-range charge_index, and
//       over-allocation are 400s at the route; a due_date after adoption_date
//       is the RPC's stable `invalid:` -> 400.
//   (E) Branch-C opening balance: no ledger rows, adoption block carries the
//       signed balance, totals stay zero, currency falls back to the
//       adoption's; ?as_of before adoption_date hides the block.
//   (F) Atomicity via the RLS veto: a viewer's adoption 403s on the LAST
//       insert and every earlier write rolls back with it.
//   (G) Cross-account RLS: account B cannot adopt account A's tenancy (404).
//   (H) Generator interplay: after adoption the next run emits exactly the
//       one advance window and never re-emits backfilled periods.
//
// Mirrors rent-changes.test.ts exactly (same env bootstrap, getAdminClient,
// check()). Needs the live local Supabase stack with 20260810000001 applied.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';

interface SupabaseStatus {
  API_URL: string;
  DB_URL: string;
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
    DB_URL: get('DB_URL'),
    ANON_KEY: get('ANON_KEY'),
    SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY'),
  };
}

const status = readSupabaseStatus();
process.env.NODE_ENV = 'test';
process.env.PORT = '8794';
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
const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');

const app = buildApp();

// --- helpers ----------------------------------------------------------------

interface ApiResp {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = opts.idempotencyKey ?? `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    headers: responseHeaders,
  };
}

function rnd(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface UserFixture {
  userId: string;
  accessToken: string;
  accountId: string;
  unitAreaId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `adoption-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status}`);
  const b = su.body as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: b.session.access_token, body });
    if (r.status !== 201)
      throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(`/v1/accounts/${b.account.id}/properties`, {
    name: `${label} prop`,
  });
  const unitArea = await post<{ id: string }>(`/v1/accounts/${b.account.id}/areas`, {
    property_id: property.id,
    kind: 'unit',
    name: `${label} unit`,
  });
  return {
    userId: b.user.id,
    accessToken: b.session.access_token,
    accountId: b.account.id,
    unitAreaId: unitArea.id,
  };
}

async function createTenancy(u: UserFixture, startDate: string): Promise<string> {
  const r = await api('POST', `/v1/accounts/${u.accountId}/tenancies`, {
    token: u.accessToken,
    body: { area_id: u.unitAreaId, start_date: startDate, status: 'active' },
  });
  if (r.status !== 201) throw new Error(`tenancy create failed: ${JSON.stringify(r.body)}`);
  return (r.body as { id: string }).id;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface Failure {
  name: string;
  detail: string;
}
const failures: Failure[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.info(`  PASS  ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

// --- shared shapes -----------------------------------------------------------

interface AdoptionResult {
  adoption_id: string;
  schedule_id: string;
  charge_ids: string[];
  payment_ids: string[];
  deposit_charge_id: string | null;
}

interface LedgerCharge {
  kind: 'charge';
  id: string;
  type: string;
  due_date: string;
  created_at: string;
  source: string;
  source_schedule_id: string | null;
  amount_cents: number;
  derived_balance_cents: number;
}
interface LedgerBody {
  currency: string | null;
  adoption: {
    adoption_date: string;
    opening_balance_cents: number;
    currency: string;
    balance_basis: string | null;
    needs_review: boolean;
  } | null;
  entries: Array<{ kind: string } & Record<string, unknown>>;
  totals: {
    rent_charges_cents: number;
    deposit_charges_cents: number;
    deposit_payments_cents: number;
    total_received_cents: number;
    total_allocated_cents: number;
    unapplied_credit_cents: number;
  };
}

// The Branch-A fixture: rent 1500.00 from May, due the 1st, adopted Aug 10.
// May + June paid in full, July paid 500.00 of 1500.00, August unpaid,
// deposit 1500.00 held since the start. Plus a 100.00 overpay on the June
// payment left deliberately unapplied.
const ADOPT_DATE = '2026-08-10';
function branchABody() {
  return {
    adoption_date: ADOPT_DATE,
    currency: 'USD',
    rent: {
      amount_cents: 150000,
      due_day: 1,
      start_date: '2026-05-01',
      grace_days: 5,
      late_fee_cents: 8500,
    },
    charges: [
      { amount_cents: 150000, due_date: '2026-05-01', period_start: '2026-05-01', period_end: '2026-05-31' },
      { amount_cents: 150000, due_date: '2026-06-01', period_start: '2026-06-01', period_end: '2026-06-30' },
      { amount_cents: 150000, due_date: '2026-07-01', period_start: '2026-07-01', period_end: '2026-07-31' },
      { amount_cents: 150000, due_date: '2026-08-01', period_start: '2026-08-01', period_end: '2026-08-31' },
    ],
    payments: [
      {
        amount_cents: 150000,
        received_at: '2026-05-03T12:00:00Z',
        method: 'check',
        reference: 'Check 1042',
        allocations: [{ charge_index: 0, amount_cents: 150000 }],
      },
      {
        amount_cents: 160000,
        received_at: '2026-06-02T12:00:00Z',
        method: 'zelle_venmo',
        allocations: [{ charge_index: 1, amount_cents: 150000 }],
      },
      {
        amount_cents: 50000,
        received_at: '2026-07-20T12:00:00Z',
        method: 'cash',
        allocations: [{ charge_index: 2, amount_cents: 50000 }],
      },
    ],
    deposit: { amount_cents: 150000, received_on: '2026-05-01', method: 'check' },
  };
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  const admin = getAdminClient();
  const alice = await setupUser('a');
  const bob = await setupUser('b');

  console.info('\n(A) Branch-A atomic backfill');
  const tenancyA = await createTenancy(alice, '2026-05-01');
  let adoptedA: AdoptionResult | null = null;
  const keyA = `t-${crypto.randomUUID()}`;
  await check('A1: adoption commits and returns ids in request order', async () => {
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${tenancyA}/adoption`, {
      token: alice.accessToken,
      body: branchABody(),
      idempotencyKey: keyA,
    });
    assert(r.status === 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    adoptedA = r.body as AdoptionResult;
    assert(adoptedA.charge_ids.length === 4, `expected 4 charge ids, got ${adoptedA.charge_ids.length}`);
    // 3 rent payments + 1 deposit payment, deposit last.
    assert(adoptedA.payment_ids.length === 4, `expected 4 payment ids, got ${adoptedA.payment_ids.length}`);
    assert(adoptedA.deposit_charge_id !== null, 'expected a deposit charge id');
  });

  await check('A2: ledger surfaces adoption block, backfill provenance, and honest totals', async () => {
    const r = await api('GET', `/v1/accounts/${alice.accountId}/tenancies/${tenancyA}/ledger`, {
      token: alice.accessToken,
    });
    assert(r.status === 200, `ledger ${r.status}`);
    const body = r.body as LedgerBody;
    assert(body.adoption !== null, 'adoption block missing');
    assert(body.adoption.adoption_date === ADOPT_DATE, `adoption_date ${body.adoption.adoption_date}`);
    assert(body.adoption.opening_balance_cents === 0, 'branch A opening balance must be 0');
    assert(body.adoption.needs_review === false, 'needs_review should default false');

    const charges = body.entries.filter((e): e is LedgerCharge & Record<string, unknown> => e.kind === 'charge');
    assert(charges.length === 5, `expected 5 charges (4 rent + deposit), got ${charges.length}`);
    for (const ch of charges) {
      assert(typeof ch.created_at === 'string' && ch.created_at.length > 0, 'charge created_at missing');
      // Backfill provenance: recorded today, due in the past.
      assert(ch.created_at.slice(0, 10) >= ch.due_date, 'created_at should not precede due_date');
    }
    const rentCharges = charges.filter((ch) => ch.type === 'rent');
    assert(
      rentCharges.every((ch) => ch.source === 'rent_schedule'),
      'backfilled rent must carry the schedule (source=rent_schedule)',
    );
    // July short 1000.00, August fully open.
    const july = rentCharges.find((ch) => ch.due_date === '2026-07-01');
    const august = rentCharges.find((ch) => ch.due_date === '2026-08-01');
    assert(july !== undefined && july.derived_balance_cents === 100000, `july balance ${july?.derived_balance_cents}`);
    assert(august !== undefined && august.derived_balance_cents === 150000, `august balance ${august?.derived_balance_cents}`);
    // June's 100.00 overpay stays unapplied credit — never invented into a charge.
    assert(
      body.totals.unapplied_credit_cents === 10000,
      `unapplied credit ${body.totals.unapplied_credit_cents}, expected 10000`,
    );
    assert(body.totals.deposit_payments_cents === 150000, 'deposit not held');
  });

  await check('A3: the schedule carries the late-fee policy and past start', async () => {
    const r = await api('GET', `/v1/accounts/${alice.accountId}/rent-schedules?tenancy_id=${tenancyA}`, {
      token: alice.accessToken,
    });
    assert(r.status === 200, `schedules ${r.status}`);
    const items = (r.body as { data: Array<Record<string, unknown>> }).data;
    assert(items.length === 1, `expected 1 schedule, got ${items.length}`);
    const s = items[0]!;
    assert(s.start_date === '2026-05-01', `start_date ${s.start_date}`);
    assert(s.due_day === 1 && s.amount_cents === 150000, 'schedule terms wrong');
    assert(s.grace_days === 5 && s.late_fee_cents === 8500, 'late-fee policy not stored');
  });

  console.info('\n(B) Idempotency');
  await check('B1: same key + body replays the original 201 without re-writing', async () => {
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${tenancyA}/adoption`, {
      token: alice.accessToken,
      body: branchABody(),
      idempotencyKey: keyA,
    });
    assert(r.status === 201, `replay expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    const replay = r.body as AdoptionResult;
    assert(adoptedA !== null, 'A1 did not run');
    assert(replay.adoption_id === adoptedA.adoption_id, 'replay returned a different adoption');
    const { count } = await admin
      .from('tenancy_adoptions')
      .select('*', { count: 'exact', head: true })
      .eq('tenancy_id', tenancyA);
    assert(count === 1, `expected 1 adoption row, got ${count}`);
  });

  console.info('\n(C) Conflicts');
  await check('C1: re-adoption with a fresh key -> 409 already_adopted', async () => {
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${tenancyA}/adoption`, {
      token: alice.accessToken,
      body: branchABody(),
    });
    assert(r.status === 409, `expected 409, got ${r.status}`);
    assert((r.body as { error: { code: string } }).error.code === 'already_adopted', JSON.stringify(r.body));
  });

  await check('C2: live schedule -> 409 schedule_exists', async () => {
    const t = await createTenancy(alice, '2026-06-01');
    const rs = await api('POST', `/v1/accounts/${alice.accountId}/rent-schedules`, {
      token: alice.accessToken,
      body: { tenancy_id: t, kind: 'rent', amount_cents: 100000, currency: 'USD', due_day: 1, start_date: '2026-06-01' },
    });
    assert(rs.status === 201, `schedule create ${rs.status}: ${JSON.stringify(rs.body)}`);
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${t}/adoption`, {
      token: alice.accessToken,
      body: { ...branchABody(), charges: [], payments: [], deposit: undefined },
    });
    assert(r.status === 409, `expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert((r.body as { error: { code: string } }).error.code === 'schedule_exists', JSON.stringify(r.body));
  });

  await check('C3: existing money -> 409 tenancy_has_money', async () => {
    const t = await createTenancy(alice, '2026-06-01');
    const ch = await api('POST', `/v1/accounts/${alice.accountId}/charges`, {
      token: alice.accessToken,
      body: { tenancy_id: t, type: 'rent', amount_cents: 100000, currency: 'USD', due_date: '2026-07-01' },
    });
    assert(ch.status === 201, `charge create ${ch.status}: ${JSON.stringify(ch.body)}`);
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${t}/adoption`, {
      token: alice.accessToken,
      body: { ...branchABody(), charges: [], payments: [], deposit: undefined },
    });
    assert(r.status === 409, `expected 409, got ${r.status}`);
    assert((r.body as { error: { code: string } }).error.code === 'tenancy_has_money', JSON.stringify(r.body));
  });

  console.info('\n(D) Validation');
  const tenancyD = await createTenancy(alice, '2026-05-01');
  await check('D1: opening balance + itemized rows -> 400 (branch exclusivity)', async () => {
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${tenancyD}/adoption`, {
      token: alice.accessToken,
      body: { ...branchABody(), opening_balance_cents: 50000 },
    });
    assert(r.status === 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
  await check('D2: charge_index out of range -> 400', async () => {
    const body = branchABody();
    body.payments[0]!.allocations[0]!.charge_index = 99;
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${tenancyD}/adoption`, {
      token: alice.accessToken,
      body,
    });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });
  await check('D3: allocations exceeding their payment -> 400', async () => {
    const body = branchABody();
    body.payments[2]!.allocations = [{ charge_index: 2, amount_cents: 150000 }];
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${tenancyD}/adoption`, {
      token: alice.accessToken,
      body,
    });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });
  await check('D4: a due_date after adoption_date -> RPC invalid -> 400', async () => {
    const body = branchABody();
    body.charges[3]!.due_date = '2026-09-01';
    body.charges[3]!.period_start = '2026-09-01';
    body.charges[3]!.period_end = '2026-09-30';
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${tenancyD}/adoption`, {
      token: alice.accessToken,
      body,
    });
    assert(r.status === 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(
      (r.body as { error: { code: string } }).error.code === 'invalid_request',
      JSON.stringify(r.body),
    );
  });

  console.info('\n(E) Branch-C opening balance');
  const tenancyE = await createTenancy(alice, '2025-10-15');
  await check('E1: opening balance commits with no ledger rows', async () => {
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${tenancyE}/adoption`, {
      token: alice.accessToken,
      body: {
        adoption_date: ADOPT_DATE,
        currency: 'USD',
        rent: { amount_cents: 150000, due_day: 15, start_date: '2025-10-15' },
        opening_balance_cents: 120000,
        balance_basis: 'Rent',
        needs_review: true,
        deposit: { amount_cents: 150000, received_on: '2025-10-15' },
      },
    });
    assert(r.status === 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    const res = r.body as AdoptionResult;
    assert(res.charge_ids.length === 0, 'branch C must create no rent charges');
    assert(res.deposit_charge_id !== null, 'deposit should exist');
  });
  await check('E2: ledger separates the opening balance from row-derived totals', async () => {
    const r = await api('GET', `/v1/accounts/${alice.accountId}/tenancies/${tenancyE}/ledger`, {
      token: alice.accessToken,
    });
    const body = r.body as LedgerBody;
    assert(body.adoption !== null, 'adoption block missing');
    assert(body.adoption.opening_balance_cents === 120000, 'opening balance wrong');
    assert(body.adoption.balance_basis === 'Rent', 'balance_basis lost');
    assert(body.adoption.needs_review === true, 'needs_review lost');
    // The balance is a recorded fact, NOT a charge: rent totals stay zero.
    assert(body.totals.rent_charges_cents === 0, 'opening balance leaked into rent charges');
    assert(body.totals.deposit_payments_cents === 150000, 'deposit not held');
    assert(body.currency === 'USD', 'currency should fall back to the adoption record');
  });
  await check('E3: ?as_of before adoption_date hides the adoption block', async () => {
    const r = await api(
      'GET',
      `/v1/accounts/${alice.accountId}/tenancies/${tenancyE}/ledger?as_of=2026-04-30`,
      { token: alice.accessToken },
    );
    const body = r.body as LedgerBody;
    assert(body.adoption === null, 'adoption should be invisible before its date');
  });

  console.info('\n(F) Atomicity via the owner/manager RLS veto');
  await check('F1: a viewer adoption 403s and leaves zero rows behind', async () => {
    const viewer = await setupUser('v');
    const { error: memberErr } = await admin.from('account_members').insert({
      account_id: alice.accountId,
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert(!memberErr, `viewer membership insert failed: ${memberErr?.message}`);
    const t = await createTenancy(alice, '2026-05-01');
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${t}/adoption`, {
      token: viewer.accessToken,
      body: branchABody(),
    });
    assert(r.status === 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    // The adoption row is inserted LAST, so its veto must roll back the
    // schedule and every charge/payment written before it.
    const [sch, chg, pay] = await Promise.all([
      admin.from('rent_schedules').select('id', { count: 'exact', head: true }).eq('tenancy_id', t),
      admin.from('charges').select('id', { count: 'exact', head: true }).eq('tenancy_id', t),
      admin.from('payments').select('id', { count: 'exact', head: true }).eq('tenancy_id', t),
    ]);
    assert(sch.count === 0, `schedule survived the rollback (${sch.count})`);
    assert(chg.count === 0, `charges survived the rollback (${chg.count})`);
    assert(pay.count === 0, `payments survived the rollback (${pay.count})`);
  });

  console.info('\n(G) Cross-account RLS');
  await check('G1: account B adopting account A tenancy -> 404', async () => {
    const t = await createTenancy(alice, '2026-05-01');
    const r = await api('POST', `/v1/accounts/${alice.accountId}/tenancies/${t}/adoption`, {
      token: bob.accessToken,
      body: branchABody(),
    });
    // The membership guard fires before the handler; either layer refusing
    // without a write is correct — what must never happen is a 2xx.
    assert(r.status === 403 || r.status === 404, `expected 403/404, got ${r.status}`);
  });

  console.info('\n(H) Generator interplay');
  await check('H1: next run emits one advance window and re-emits nothing', async () => {
    // Adoption backfilled through 2026-08-01 with due_day 1; a run dated
    // 2026-08-10 (day > due_day) must emit exactly 2026-09-01.
    const before = await admin
      .from('charges')
      .select('id', { count: 'exact', head: true })
      .eq('tenancy_id', tenancyA);
    const { error } = await admin.rpc('generate_rent_charges', {
      p_account_id: alice.accountId,
      p_as_of: '2026-08-10',
    });
    assert(!error, `generator failed: ${error?.message}`);
    const after = await admin
      .from('charges')
      .select('id, period_start, source_schedule_id')
      .eq('tenancy_id', tenancyA)
      .order('period_start', { ascending: true });
    assert(!after.error, `charges read failed: ${after.error?.message}`);
    const rows = after.data ?? [];
    assert(
      rows.length === (before.count ?? 0) + 1,
      `expected exactly one new charge, had ${before.count}, now ${rows.length}`,
    );
    // The deposit charge has no period; the emitted advance window is the
    // latest period_start among schedule-sourced rows.
    const periods = rows
      .filter((r2) => r2.source_schedule_id !== null && r2.period_start !== null)
      .map((r2) => r2.period_start as string)
      .sort();
    const emitted = periods[periods.length - 1];
    assert(emitted === '2026-09-01', `advance window ${emitted}`);
    // A second run is a no-op: the (schedule, period) dedupe holds for both
    // the backfilled and the generated periods.
    await admin.rpc('generate_rent_charges', { p_account_id: alice.accountId, p_as_of: '2026-08-10' });
    const again = await admin
      .from('charges')
      .select('id', { count: 'exact', head: true })
      .eq('tenancy_id', tenancyA);
    assert(again.count === rows.length, `second run wrote ${again.count} vs ${rows.length}`);
  });

  // --- summary ---
  if (failures.length > 0) {
    console.error(`\n${failures.length} adoption failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: tenancy-adoption checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
