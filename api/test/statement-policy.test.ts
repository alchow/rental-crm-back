// ----------------------------------------------------------------------------
// Statement late-fee policy (migration 20260801000007).
//
// The Statement surface needs two facts the database could not hold: the
// landlord's own late-fee terms (grace_days, late_fee_cents on the rent era)
// and WHICH rent charge a late fee was asserted against
// (charges.parent_charge_id). Nothing here mints money -- the grace window only
// lets the client PROPOSE a fee, which a human confirms through the ordinary
// POST /charges.
//
// Covers:
//   (A) parent_charge_id: same-tenancy accepted; different tenancy -> 400;
//       another account's charge -> 404; a charge that does not exist -> 404.
//   (B) One LIVE late fee per parent: the second is 409 late_fee_exists;
//       voiding the first frees the slot and the fee can be re-asserted.
//   (C) PATCH /rent-schedules/{id}: sets policy, clears it with null, leaves an
//       omitted field alone, and REFUSES any other field (400) rather than
//       silently ignoring it. Empty body -> 400. Unknown id -> 404.
//   (D) Bounds: grace_days outside 0-30 and late_fee_cents <= 0 are rejected on
//       create, on PATCH, and on a rent change.
//   (E) Rent change carries the policy across the era fork, and an explicit
//       value on the call overrides the inherited one.
//   (F) Ledger exposes parent_charge_id on charge entries and created_at on
//       payment entries and their allocations, with created_at distinct from
//       the back-dated occurred_at.
//
// Mirrors rent-changes.test.ts exactly (same env bootstrap, api(), check()).
// Needs the live local Supabase stack with migration 20260801000007 applied.
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
process.env.PORT = '8795';
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
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
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
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
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
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
}

function rnd(): string {
  return Math.random().toString(36).slice(2, 10);
}

const codeOf = (r: ApiResp): string | undefined =>
  (r.body as { error?: { code?: string } } | null)?.error?.code;

interface UserFixture {
  accessToken: string;
  accountId: string;
  unitAreaId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `statement-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };
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
    accessToken: b.session.access_token,
    accountId: b.account.id,
    unitAreaId: unitArea.id,
  };
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

// --- tests ------------------------------------------------------------------

interface Schedule {
  id: string;
  amount_cents: number;
  due_day: number;
  start_date: string;
  end_date: string | null;
  grace_days: number | null;
  late_fee_cents: number | null;
}
interface Charge {
  id: string;
  type: string;
  parent_charge_id: string | null;
  voided_at: string | null;
}
interface LedgerChargeEntry {
  kind: 'charge';
  id: string;
  parent_charge_id: string | null;
}
interface LedgerPaymentEntry {
  kind: 'payment';
  id: string;
  occurred_at: string;
  created_at: string;
  allocations: { charge_id: string; amount_cents: number; created_at: string }[];
}
type LedgerEntry = LedgerChargeEntry | LedgerPaymentEntry;

async function main(): Promise<void> {
  console.info('Statement late-fee policy checks');
  const A = await setupUser('A');
  const B = await setupUser('B');

  const postA = async (p: string, body: unknown): Promise<ApiResp> =>
    api('POST', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken, body });
  const getA = async (p: string): Promise<ApiResp> =>
    api('GET', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken });
  const patchA = async (p: string, body: unknown): Promise<ApiResp> =>
    api('PATCH', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken, body });

  async function newTenancy(user: UserFixture = A): Promise<string> {
    const r = await api('POST', `/v1/accounts/${user.accountId}/tenancies`, {
      token: user.accessToken,
      body: { area_id: user.unitAreaId, start_date: '2026-01-01', status: 'active' },
    });
    if (r.status !== 201) throw new Error(`create tenancy: ${r.status} ${JSON.stringify(r.body)}`);
    return (r.body as { id: string }).id;
  }

  async function newRentCharge(
    tenancyId: string,
    user: UserFixture = A,
    dueDate = '2026-03-01',
  ): Promise<Charge> {
    const r = await api('POST', `/v1/accounts/${user.accountId}/charges`, {
      token: user.accessToken,
      body: {
        tenancy_id: tenancyId,
        type: 'rent',
        amount_cents: 200000,
        currency: 'USD',
        due_date: dueDate,
      },
    });
    if (r.status !== 201) throw new Error(`create charge: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as Charge;
  }

  async function newLateFee(tenancyId: string, parentId: string): Promise<ApiResp> {
    return postA('/charges', {
      tenancy_id: tenancyId,
      type: 'late_fee',
      amount_cents: 8500,
      currency: 'USD',
      due_date: '2026-03-06',
      parent_charge_id: parentId,
    });
  }

  async function newSchedule(
    tenancyId: string,
    extra: Record<string, unknown> = {},
  ): Promise<ApiResp> {
    return postA('/rent-schedules', {
      tenancy_id: tenancyId,
      kind: 'rent',
      amount_cents: 200000,
      currency: 'USD',
      due_day: 1,
      start_date: '2026-01-01',
      ...extra,
    });
  }

  // =========================================================================
  // (A) parent_charge_id scoping
  // =========================================================================
  await check('late fee names a rent charge in the same tenancy -> 201', async () => {
    const t = await newTenancy();
    const rent = await newRentCharge(t);
    const fee = await newLateFee(t, rent.id);
    if (fee.status !== 201)
      throw new Error(`expected 201, got ${fee.status} ${JSON.stringify(fee.body)}`);
    if ((fee.body as Charge).parent_charge_id !== rent.id)
      throw new Error(`parent_charge_id not echoed: ${JSON.stringify(fee.body)}`);
  });

  await check('parent in a DIFFERENT tenancy of the same account -> 400', async () => {
    const t1 = await newTenancy();
    const t2 = await newTenancy();
    const rentOnT2 = await newRentCharge(t2);
    const fee = await newLateFee(t1, rentOnT2.id);
    if (fee.status !== 400 || codeOf(fee) !== 'invalid_request')
      throw new Error(`expected 400 invalid_request, got ${fee.status} ${codeOf(fee)}`);
  });

  await check('parent belonging to ANOTHER account -> 404', async () => {
    const tA = await newTenancy();
    const tB = await newTenancy(B);
    const rentOnB = await newRentCharge(tB, B);
    const fee = await newLateFee(tA, rentOnB.id);
    if (fee.status !== 404 || codeOf(fee) !== 'not_found')
      throw new Error(`expected 404 not_found, got ${fee.status} ${codeOf(fee)}`);
  });

  await check('parent that does not exist -> 404', async () => {
    const t = await newTenancy();
    const fee = await newLateFee(t, crypto.randomUUID());
    if (fee.status !== 404 || codeOf(fee) !== 'not_found')
      throw new Error(`expected 404 not_found, got ${fee.status} ${codeOf(fee)}`);
  });

  // =========================================================================
  // (B) One LIVE late fee per parent -- the propose-confirm idempotency key
  // =========================================================================
  await check('second live late fee on the same parent -> 409 late_fee_exists', async () => {
    const t = await newTenancy();
    const rent = await newRentCharge(t);
    const first = await newLateFee(t, rent.id);
    if (first.status !== 201) throw new Error(`first fee: ${first.status}`);
    const second = await newLateFee(t, rent.id);
    if (second.status !== 409 || codeOf(second) !== 'late_fee_exists')
      throw new Error(`expected 409 late_fee_exists, got ${second.status} ${codeOf(second)}`);
  });

  await check('voiding the fee frees the slot: it can be re-asserted', async () => {
    const t = await newTenancy();
    const rent = await newRentCharge(t);
    const first = await newLateFee(t, rent.id);
    if (first.status !== 201) throw new Error(`first fee: ${first.status}`);
    const voided = await postA(`/charges/${(first.body as Charge).id}/void`, {
      void_reason: 'wrong amount',
    });
    if (voided.status !== 200)
      throw new Error(`void: ${voided.status} ${JSON.stringify(voided.body)}`);
    const again = await newLateFee(t, rent.id);
    if (again.status !== 201)
      throw new Error(`expected 201 after void, got ${again.status} ${JSON.stringify(again.body)}`);
    // And the re-asserted one is now the live occupant of the slot.
    const third = await newLateFee(t, rent.id);
    if (third.status !== 409) throw new Error(`expected 409 for a third fee, got ${third.status}`);
  });

  await check('a non-late_fee charge may share a parent freely', async () => {
    const t = await newTenancy();
    const rent = await newRentCharge(t);
    const mk = async () =>
      postA('/charges', {
        tenancy_id: t,
        type: 'nsf_fee',
        amount_cents: 2500,
        currency: 'USD',
        due_date: '2026-03-06',
        parent_charge_id: rent.id,
      });
    const one = await mk();
    const two = await mk();
    if (one.status !== 201 || two.status !== 201)
      throw new Error(`expected both 201, got ${one.status} / ${two.status}`);
  });

  // =========================================================================
  // (C) PATCH /rent-schedules/{id}: policy only
  // =========================================================================
  await check('POST /rent-schedules accepts and echoes the policy', async () => {
    const t = await newTenancy();
    const r = await newSchedule(t, { grace_days: 5, late_fee_cents: 8500 });
    if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
    const s = r.body as Schedule;
    if (s.grace_days !== 5 || s.late_fee_cents !== 8500)
      throw new Error(`policy not stored: ${JSON.stringify(s)}`);
  });

  await check('a schedule created without a policy has null, not a default', async () => {
    const t = await newTenancy();
    const r = await newSchedule(t);
    const s = r.body as Schedule;
    if (s.grace_days !== null || s.late_fee_cents !== null)
      throw new Error(`expected nulls, got ${JSON.stringify(s)}`);
  });

  await check('PATCH sets, then clears with null, leaving the other field alone', async () => {
    const t = await newTenancy();
    const created = (await newSchedule(t)).body as Schedule;

    const set = await patchA(`/rent-schedules/${created.id}`, {
      grace_days: 3,
      late_fee_cents: 5000,
    });
    if (set.status !== 200) throw new Error(`set: ${set.status} ${JSON.stringify(set.body)}`);
    const afterSet = set.body as Schedule;
    if (afterSet.grace_days !== 3 || afterSet.late_fee_cents !== 5000)
      throw new Error(`set did not apply: ${JSON.stringify(afterSet)}`);

    // Omitted field untouched; named field cleared.
    const clear = await patchA(`/rent-schedules/${created.id}`, { late_fee_cents: null });
    if (clear.status !== 200)
      throw new Error(`clear: ${clear.status} ${JSON.stringify(clear.body)}`);
    const afterClear = clear.body as Schedule;
    if (afterClear.late_fee_cents !== null)
      throw new Error(`late_fee_cents not cleared: ${JSON.stringify(afterClear)}`);
    if (afterClear.grace_days !== 3)
      throw new Error(`omitted grace_days was disturbed: ${JSON.stringify(afterClear)}`);

    // And the read-back agrees (not just the RETURNING row).
    const read = await getA(`/rent-schedules/${created.id}`);
    const persisted = read.body as Schedule;
    if (persisted.grace_days !== 3 || persisted.late_fee_cents !== null)
      throw new Error(`persisted state wrong: ${JSON.stringify(persisted)}`);
  });

  await check('PATCH refuses any other field -> 400, and changes nothing', async () => {
    const t = await newTenancy();
    const created = (await newSchedule(t, { grace_days: 5, late_fee_cents: 8500 }))
      .body as Schedule;
    for (const forbidden of [
      { amount_cents: 999999 },
      { due_day: 15 },
      { kind: 'parking' },
      { start_date: '2026-06-01' },
      { end_date: '2026-06-30' },
      { grace_days: 7, amount_cents: 999999 },
    ]) {
      const r = await patchA(`/rent-schedules/${created.id}`, forbidden);
      if (r.status !== 400 || codeOf(r) !== 'invalid_request')
        throw new Error(
          `expected 400 for ${JSON.stringify(forbidden)}, got ${r.status} ${codeOf(r)}`,
        );
    }
    const read = (await getA(`/rent-schedules/${created.id}`)).body as Schedule & {
      amount_cents: number;
      due_day: number;
    };
    if (read.amount_cents !== 200000 || read.due_day !== 1 || read.grace_days !== 5)
      throw new Error(`a refused PATCH still changed the row: ${JSON.stringify(read)}`);
  });

  await check('PATCH with an empty body -> 400', async () => {
    const t = await newTenancy();
    const created = (await newSchedule(t)).body as Schedule;
    const r = await patchA(`/rent-schedules/${created.id}`, {});
    if (r.status !== 400)
      throw new Error(`expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('PATCH of an unknown schedule -> 404', async () => {
    const r = await patchA(`/rent-schedules/${crypto.randomUUID()}`, { grace_days: 1 });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  await check('another account cannot PATCH this account’s schedule', async () => {
    const t = await newTenancy();
    const created = (await newSchedule(t)).body as Schedule;
    const r = await api('PATCH', `/v1/accounts/${A.accountId}/rent-schedules/${created.id}`, {
      token: B.accessToken,
      body: { grace_days: 9 },
    });
    if (r.status !== 404 && r.status !== 403)
      throw new Error(`expected 404/403 for a non-member, got ${r.status}`);
  });

  // =========================================================================
  // (D) Bounds
  // =========================================================================
  await check('policy bounds are enforced on create', async () => {
    const t = await newTenancy();
    for (const bad of [
      { grace_days: -1 },
      { grace_days: 31 },
      { grace_days: 2.5 },
      { late_fee_cents: 0 },
      { late_fee_cents: -100 },
    ]) {
      const r = await newSchedule(t, bad);
      if (r.status !== 400)
        throw new Error(`expected 400 for ${JSON.stringify(bad)}, got ${r.status}`);
    }
    // The edges are legal: 0 grace days means "late the next day".
    const t2 = await newTenancy();
    const ok = await newSchedule(t2, { grace_days: 0, late_fee_cents: 1 });
    if (ok.status !== 201) throw new Error(`expected 201 at the bounds, got ${ok.status}`);
    const t3 = await newTenancy();
    const ok30 = await newSchedule(t3, { grace_days: 30 });
    if (ok30.status !== 201) throw new Error(`expected 201 for grace_days=30, got ${ok30.status}`);
  });

  await check('policy bounds are enforced on PATCH', async () => {
    const t = await newTenancy();
    const created = (await newSchedule(t)).body as Schedule;
    for (const bad of [{ grace_days: 31 }, { grace_days: -1 }, { late_fee_cents: 0 }]) {
      const r = await patchA(`/rent-schedules/${created.id}`, bad);
      if (r.status !== 400)
        throw new Error(`expected 400 for ${JSON.stringify(bad)}, got ${r.status}`);
    }
  });

  // =========================================================================
  // (E) The policy forks with the era
  // =========================================================================
  async function servedNotice(tenancyId: string): Promise<string> {
    const r = await postA('/notices', {
      tenancy_id: tenancyId,
      notice_label: 'Rent increase',
      served_at: '2026-02-01T00:00:00.000Z',
    });
    if (r.status !== 201) throw new Error(`create notice: ${r.status} ${JSON.stringify(r.body)}`);
    return (r.body as { id: string }).id;
  }

  await check('a rent change carries the policy forward to the successor era', async () => {
    const t = await newTenancy();
    const before = (await newSchedule(t, { grace_days: 5, late_fee_cents: 8500 })).body as Schedule;
    const notice = await servedNotice(t);
    const r = await postA(`/tenancies/${t}/rent-changes`, {
      amount_cents: 210000,
      currency: 'USD',
      effective_date: '2026-04-01',
      source_notice_id: notice,
    });
    if (r.status !== 201) throw new Error(`rent-change: ${r.status} ${JSON.stringify(r.body)}`);
    const successor = (r.body as { rent_schedule: Schedule }).rent_schedule;
    if (successor.id === before.id) throw new Error('expected a NEW schedule row');
    if (successor.grace_days !== 5 || successor.late_fee_cents !== 8500)
      throw new Error(`policy not carried forward: ${JSON.stringify(successor)}`);
  });

  await check('an explicit value on the rent change overrides the inherited one', async () => {
    const t = await newTenancy();
    await newSchedule(t, { grace_days: 5, late_fee_cents: 8500 });
    const notice = await servedNotice(t);
    const r = await postA(`/tenancies/${t}/rent-changes`, {
      amount_cents: 210000,
      currency: 'USD',
      effective_date: '2026-04-01',
      source_notice_id: notice,
      late_fee_cents: 10000,
    });
    if (r.status !== 201) throw new Error(`rent-change: ${r.status} ${JSON.stringify(r.body)}`);
    const successor = (r.body as { rent_schedule: Schedule }).rent_schedule;
    if (successor.late_fee_cents !== 10000)
      throw new Error(`override ignored: ${JSON.stringify(successor)}`);
    if (successor.grace_days !== 5)
      throw new Error(`unspecified field should still inherit: ${JSON.stringify(successor)}`);
  });

  await check('an era with no policy stays unset through a rent change', async () => {
    const t = await newTenancy();
    await newSchedule(t);
    const notice = await servedNotice(t);
    const r = await postA(`/tenancies/${t}/rent-changes`, {
      amount_cents: 210000,
      currency: 'USD',
      effective_date: '2026-04-01',
      source_notice_id: notice,
    });
    const successor = (r.body as { rent_schedule: Schedule }).rent_schedule;
    if (successor.grace_days !== null || successor.late_fee_cents !== null)
      throw new Error(`a default was invented: ${JSON.stringify(successor)}`);
  });

  await check('out-of-range policy on a rent change -> 400', async () => {
    const t = await newTenancy();
    await newSchedule(t);
    const notice = await servedNotice(t);
    const r = await postA(`/tenancies/${t}/rent-changes`, {
      amount_cents: 210000,
      currency: 'USD',
      effective_date: '2026-04-01',
      source_notice_id: notice,
      grace_days: 45,
    });
    if (r.status !== 400)
      throw new Error(`expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  // =========================================================================
  // (F) Ledger: parent link + recorded-at beside occurred-at
  // =========================================================================
  await check('ledger exposes parent_charge_id and both created_at fields', async () => {
    const t = await newTenancy();
    const rent = await newRentCharge(t);
    const fee = await newLateFee(t, rent.id);
    if (fee.status !== 201) throw new Error(`fee: ${fee.status} ${JSON.stringify(fee.body)}`);

    // received_at is deliberately back-dated, so created_at (recorded-at) must
    // be a strictly later, distinguishable instant.
    const pay = await postA('/payments', {
      tenancy_id: t,
      amount_cents: 200000,
      currency: 'USD',
      received_at: '2026-03-02T00:00:00.000Z',
      method: 'check',
      allocations: [{ charge_id: rent.id, amount_cents: 200000 }],
    });
    if (pay.status !== 201) throw new Error(`payment: ${pay.status} ${JSON.stringify(pay.body)}`);

    const led = await getA(`/tenancies/${t}/ledger`);
    if (led.status !== 200) throw new Error(`ledger: ${led.status} ${JSON.stringify(led.body)}`);
    const entries = (led.body as { entries: LedgerEntry[] }).entries;

    const feeEntry = entries.find(
      (e): e is LedgerChargeEntry => e.kind === 'charge' && e.id === (fee.body as Charge).id,
    );
    if (!feeEntry) throw new Error('late fee missing from the ledger');
    if (feeEntry.parent_charge_id !== rent.id)
      throw new Error(`ledger parent_charge_id wrong: ${JSON.stringify(feeEntry)}`);

    const rentEntry = entries.find(
      (e): e is LedgerChargeEntry => e.kind === 'charge' && e.id === rent.id,
    );
    if (!rentEntry) throw new Error('rent charge missing from the ledger');
    if (rentEntry.parent_charge_id !== null)
      throw new Error(`an unparented charge should be null: ${JSON.stringify(rentEntry)}`);

    const payEntry = entries.find((e): e is LedgerPaymentEntry => e.kind === 'payment');
    if (!payEntry) throw new Error('payment missing from the ledger');
    if (typeof payEntry.created_at !== 'string')
      throw new Error(`payment created_at missing: ${JSON.stringify(payEntry)}`);
    if (!(Date.parse(payEntry.created_at) > Date.parse(payEntry.occurred_at)))
      throw new Error(
        `created_at must be the recorded-at instant, later than the back-dated ` +
          `occurred_at: ${payEntry.created_at} vs ${payEntry.occurred_at}`,
      );
    if (payEntry.allocations.length !== 1)
      throw new Error(`expected one allocation: ${JSON.stringify(payEntry.allocations)}`);
    if (typeof payEntry.allocations[0]!.created_at !== 'string')
      throw new Error(`allocation created_at missing: ${JSON.stringify(payEntry.allocations[0])}`);
  });

  // --- summary ---
  if (failures.length > 0) {
    console.error(`\n${failures.length} statement-policy failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: statement late-fee policy checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
