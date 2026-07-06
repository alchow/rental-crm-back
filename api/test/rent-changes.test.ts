// ----------------------------------------------------------------------------
// Instrument-anchored rent changes (migration 20260706000001).
//
// A rent change is never a free-floating amount edit: it is anchored to the
// instrument that authorises it -- a renewal lease (fixed-term) or a served
// notice (month-to-month). change_tenancy_rent() does the whole swap atomically:
// ends the open same-kind schedule at effective_date-1, inserts the successor
// (with provenance back to the anchor), and -- when lease-anchored -- supersedes
// the prior active lease(s) and activates the draft anchor lease.
//
// Covers:
//   (A) Lease-anchored happy path: old schedule ended, successor carries the
//       provenance, prior lease -> superseded, draft anchor -> active.
//   (B) Notice-anchored happy path: schedule swap, source_notice_id set,
//       no leases superseded.
//   (C) Validation: no anchor -> 400; cross-tenancy lease -> 404; nonexistent
//       notice -> 404; ended tenancy -> 409; future-dated conflict -> 409.
//   (D) Generator interplay: a change effective next period bills the NEW
//       amount off the NEW schedule; the ended schedule bills nothing.
//   (E) Lease PATCH guard: a rent edit is 400; a term_end edit still 200.
//   (F) Drift: detect_rent_drift flags a lease/schedule mismatch, and a
//       rent-change that reconciles them clears it.
//   (G) RLS isolation: an account-B principal cannot drive an account-A change.
//   (H) Notices CRUD smoke.
//
// Plus the PR #60 review-finding regressions (labelled by finding number):
//   F1 advance-void  -- a change voids the old era's advance charge; the
//      successor re-bills the period at the new amount (voided_charge_ids).
//   F2 end-bound inheritance -- the successor inherits a bounded schedule's
//      end_date rather than silently going open-ended.
//   F5 echo-back tolerance -- a read-modify-write PATCH re-sending UNCHANGED
//      rent values is 200; a changed value is the 400 pointer.
//   F6 unserved notice -- anchoring to a notice without served_at -> 409.
//   F7 anchored notice locked -- PATCH/DELETE of an anchoring notice -> 409.
//   F8 cross-tenancy anchor on a direct schedule create -> 400.
//   F9 superseded lease resurrect -> 409; anchor-lease delete -> 409.
//
// Mirrors auto-charge.test.ts exactly (same env bootstrap, getAdminClient,
// check()). Needs the live local Supabase stack (SUPABASE_URL etc. resolved
// from `supabase status`) with migration 20260706000001 applied -- it will not
// run in a sandbox without that stack, same as its sibling tests.
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
process.env.PORT = '8792';
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
  propertyId: string;
  unitAreaId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `rentchange-${label}-${rnd()}@example.test`;
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
    propertyId: property.id,
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

interface Lease {
  id: string;
  status: string;
  rent_amount_cents: number;
}
interface Schedule {
  id: string;
  amount_cents: number;
  due_day: number;
  start_date: string;
  end_date: string | null;
  source_lease_id: string | null;
  source_notice_id: string | null;
  change_reason: string | null;
}
interface RentChangeResult {
  rent_schedule: Schedule;
  ended_schedule_ids: string[];
  superseded_lease_ids: string[];
  voided_charge_ids: string[];
}

async function main(): Promise<void> {
  console.info('Instrument-anchored rent-change checks');
  const A = await setupUser('A');
  const B = await setupUser('B');
  const admin = getAdminClient();

  // Per-user API verbs bound to A's token.
  const postA = async (p: string, body: unknown): Promise<ApiResp> =>
    api('POST', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken, body });
  const getA = async (p: string): Promise<ApiResp> =>
    api('GET', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken });
  const patchA = async (p: string, body: unknown): Promise<ApiResp> =>
    api('PATCH', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken, body });

  async function newTenancy(opts: { status?: string; start?: string } = {}): Promise<string> {
    const r = await postA('/tenancies', {
      area_id: A.unitAreaId,
      start_date: opts.start ?? '2026-01-01',
      status: opts.status ?? 'active',
    });
    if (r.status !== 201) throw new Error(`create tenancy: ${r.status} ${JSON.stringify(r.body)}`);
    return (r.body as { id: string }).id;
  }
  async function newLease(
    tenancyId: string,
    opts: { status: string; rent?: number },
  ): Promise<Lease> {
    const r = await postA('/leases', {
      tenancy_id: tenancyId,
      term_start: '2026-01-01',
      term_end: '2026-12-31',
      rent_amount_cents: opts.rent ?? 200000,
      rent_currency: 'USD',
      status: opts.status,
    });
    if (r.status !== 201) throw new Error(`create lease: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as Lease;
  }
  async function newSchedule(
    tenancyId: string,
    opts: { amount?: number; dueDay?: number; start?: string } = {},
  ): Promise<Schedule> {
    const r = await postA('/rent-schedules', {
      tenancy_id: tenancyId,
      kind: 'rent',
      amount_cents: opts.amount ?? 200000,
      currency: 'USD',
      due_day: opts.dueDay ?? 1,
      start_date: opts.start ?? '2026-01-01',
    });
    if (r.status !== 201) throw new Error(`create schedule: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as Schedule;
  }
  async function getLease(id: string): Promise<Lease> {
    const r = await getA(`/leases/${id}`);
    if (r.status !== 200) throw new Error(`get lease ${id}: ${r.status}`);
    return r.body as Lease;
  }
  async function getSchedule(id: string): Promise<Schedule> {
    const r = await getA(`/rent-schedules/${id}`);
    if (r.status !== 200) throw new Error(`get schedule ${id}: ${r.status}`);
    return r.body as Schedule;
  }
  async function rentChange(
    tenancyId: string,
    body: unknown,
    token = A.accessToken,
  ): Promise<ApiResp> {
    return api('POST', `/v1/accounts/${A.accountId}/tenancies/${tenancyId}/rent-changes`, {
      token,
      body,
    });
  }

  // =========================================================================
  // (A) Lease-anchored happy path
  // =========================================================================
  await check(
    'lease-anchored: schedule swaps, prior lease superseded, draft anchor activated',
    async () => {
      const tid = await newTenancy();
      const v1 = await newLease(tid, { status: 'active', rent: 200000 });
      const oldSched = await newSchedule(tid, { amount: 200000, dueDay: 1 });
      const v2 = await newLease(tid, { status: 'draft', rent: 250000 });

      const r = await rentChange(tid, {
        amount_cents: 250000,
        currency: 'USD',
        effective_date: '2026-09-01',
        due_day: 1,
        source_lease_id: v2.id,
        change_reason: 'annual renewal',
      });
      if (r.status !== 201)
        throw new Error(`expected 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const res = r.body as RentChangeResult;

      if (res.rent_schedule.amount_cents !== 250000) {
        throw new Error(`successor amount ${res.rent_schedule.amount_cents} != 250000`);
      }
      if (res.rent_schedule.start_date !== '2026-09-01') {
        throw new Error(`successor start_date ${res.rent_schedule.start_date} != 2026-09-01`);
      }
      if (res.rent_schedule.source_lease_id !== v2.id) {
        throw new Error(
          `successor source_lease_id ${res.rent_schedule.source_lease_id} != ${v2.id}`,
        );
      }
      if (res.rent_schedule.change_reason !== 'annual renewal') {
        throw new Error(
          `successor change_reason ${res.rent_schedule.change_reason} != 'annual renewal'`,
        );
      }
      if (!res.ended_schedule_ids.includes(oldSched.id)) {
        throw new Error(
          `ended_schedule_ids ${JSON.stringify(res.ended_schedule_ids)} missing old ${oldSched.id}`,
        );
      }
      if (!res.superseded_lease_ids.includes(v1.id)) {
        throw new Error(
          `superseded_lease_ids ${JSON.stringify(res.superseded_lease_ids)} missing v1 ${v1.id}`,
        );
      }

      const endedSched = await getSchedule(oldSched.id);
      if (endedSched.end_date !== '2026-08-31') {
        throw new Error(`old schedule end_date ${endedSched.end_date} != 2026-08-31 (effective-1)`);
      }
      const l1 = await getLease(v1.id);
      if (l1.status !== 'superseded') throw new Error(`v1 status ${l1.status} != superseded`);
      const l2 = await getLease(v2.id);
      if (l2.status !== 'active') throw new Error(`v2 status ${l2.status} != active`);
    },
  );

  // =========================================================================
  // (B) Notice-anchored happy path (no lease on the tenancy)
  // =========================================================================
  await check(
    'notice-anchored: schedule swaps, source_notice_id set, no leases superseded',
    async () => {
      const tid = await newTenancy();
      const oldSched = await newSchedule(tid, { amount: 180000, dueDay: 1 });
      const nRes = await postA('/notices', {
        tenancy_id: tid,
        notice_type: 'rent_increase',
        served_at: '2026-08-01T12:00:00Z',
        served_method: 'certified_mail',
      });
      if (nRes.status !== 201)
        throw new Error(`create notice: ${nRes.status} ${JSON.stringify(nRes.body)}`);
      const notice = nRes.body as { id: string };

      const r = await rentChange(tid, {
        amount_cents: 195000,
        currency: 'USD',
        effective_date: '2026-09-01',
        due_day: 1,
        source_notice_id: notice.id,
        change_reason: 'CPI adjustment',
      });
      if (r.status !== 201)
        throw new Error(`expected 201, got ${r.status} ${JSON.stringify(r.body)}`);
      const res = r.body as RentChangeResult;
      if (res.rent_schedule.source_notice_id !== notice.id) {
        throw new Error(
          `successor source_notice_id ${res.rent_schedule.source_notice_id} != ${notice.id}`,
        );
      }
      if (res.rent_schedule.source_lease_id !== null) {
        throw new Error(
          `successor source_lease_id should be null, got ${res.rent_schedule.source_lease_id}`,
        );
      }
      if (!res.ended_schedule_ids.includes(oldSched.id)) {
        throw new Error(`ended_schedule_ids missing old ${oldSched.id}`);
      }
      if (res.superseded_lease_ids.length !== 0) {
        throw new Error(
          `superseded_lease_ids should be empty, got ${JSON.stringify(res.superseded_lease_ids)}`,
        );
      }
    },
  );

  // =========================================================================
  // (C) Validation
  // =========================================================================
  await check('validation: no anchor -> 400', async () => {
    const tid = await newTenancy();
    await newSchedule(tid);
    const r = await rentChange(tid, {
      amount_cents: 210000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
    });
    if (r.status !== 400)
      throw new Error(`expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('validation: cross-tenancy lease -> 404', async () => {
    const t1 = await newTenancy();
    await newSchedule(t1);
    const t2 = await newTenancy();
    const otherLease = await newLease(t2, { status: 'draft', rent: 250000 });
    const r = await rentChange(t1, {
      amount_cents: 250000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
      source_lease_id: otherLease.id,
    });
    if (r.status !== 404)
      throw new Error(`expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('validation: nonexistent notice -> 404', async () => {
    const tid = await newTenancy();
    await newSchedule(tid);
    const r = await rentChange(tid, {
      amount_cents: 210000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
      source_notice_id: crypto.randomUUID(),
    });
    if (r.status !== 404)
      throw new Error(`expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('validation: ended tenancy -> 409', async () => {
    const tid = await newTenancy();
    await newSchedule(tid);
    const nRes = await postA('/notices', {
      tenancy_id: tid,
      notice_type: 'termination',
      served_at: '2026-06-01T12:00:00Z',
    });
    const notice = nRes.body as { id: string };
    const upd = await admin
      .from('tenancies')
      .update({ status: 'ended', end_date: '2026-06-30' })
      .eq('id', tid);
    if (upd.error) throw new Error(`end tenancy: ${upd.error.message}`);
    const r = await rentChange(tid, {
      amount_cents: 210000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
      source_notice_id: notice.id,
    });
    if (r.status !== 409)
      throw new Error(`expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('validation: future-dated conflicting schedule -> 409', async () => {
    const tid = await newTenancy();
    await newSchedule(tid, { start: '2026-01-01' });
    // A schedule already starting ON the effective date; ending it at
    // effective-1 would invert its date range, so the change conflicts.
    const future = await admin
      .from('rent_schedules')
      .insert({
        account_id: A.accountId,
        tenancy_id: tid,
        kind: 'rent',
        amount_cents: 220000,
        currency: 'USD',
        due_day: 1,
        start_date: '2026-09-01',
      })
      .select('id')
      .single();
    if (future.error) throw new Error(`seed future schedule: ${future.error.message}`);
    const nRes = await postA('/notices', { tenancy_id: tid, notice_type: 'rent_increase' });
    const notice = nRes.body as { id: string };
    const r = await rentChange(tid, {
      amount_cents: 230000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
      source_notice_id: notice.id,
    });
    if (r.status !== 409)
      throw new Error(`expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  // =========================================================================
  // (D) Generator interplay
  // =========================================================================
  await check(
    'generator: a change effective next period bills the NEW amount off the NEW schedule',
    async () => {
      // Opt the account in so generate_rent_charges will bill it.
      const en = await admin
        .from('accounts')
        .update({ auto_charge_enabled: true })
        .eq('id', A.accountId);
      if (en.error) throw new Error(`enable auto_charge: ${en.error.message}`);

      const tid = await newTenancy();
      const v1 = await newLease(tid, { status: 'active', rent: 200000 });
      const oldSched = await newSchedule(tid, { amount: 200000, dueDay: 1 });
      const v2 = await newLease(tid, { status: 'draft', rent: 250000 });

      const r = await rentChange(tid, {
        amount_cents: 250000,
        currency: 'USD',
        effective_date: '2026-08-01',
        due_day: 1,
        source_lease_id: v2.id,
        change_reason: 'renewal',
      });
      if (r.status !== 201) throw new Error(`rent-change: ${r.status} ${JSON.stringify(r.body)}`);
      const newSched = (r.body as RentChangeResult).rent_schedule;

      // due_day=1, as_of 2026-08-02 (day>due_day) -> bills next month's 1st = 2026-09-01.
      const gen = await admin.rpc('generate_rent_charges', {
        p_account_id: A.accountId,
        p_as_of: '2026-08-02T12:00:00Z',
      });
      if (gen.error) throw new Error(`generate: ${gen.error.message}`);

      const { data: charges, error: cErr } = await admin
        .from('charges')
        .select('amount_cents, period_start, source_schedule_id')
        .eq('account_id', A.accountId)
        .eq('tenancy_id', tid);
      if (cErr) throw new Error(`read charges: ${cErr.message}`);
      const rows = (charges ?? []) as {
        amount_cents: number;
        period_start: string;
        source_schedule_id: string;
      }[];

      const fromNew = rows.filter((x) => x.source_schedule_id === newSched.id);
      const fromOld = rows.filter((x) => x.source_schedule_id === oldSched.id);
      if (fromOld.length !== 0)
        throw new Error(`old schedule should bill nothing, got ${fromOld.length}`);
      if (fromNew.length !== 1)
        throw new Error(`new schedule should bill exactly 1, got ${fromNew.length}`);
      if (fromNew[0]!.amount_cents !== 250000) {
        throw new Error(`charge amount ${fromNew[0]!.amount_cents} != 250000 (new amount)`);
      }
      if (fromNew[0]!.period_start !== '2026-09-01') {
        throw new Error(`charge period_start ${fromNew[0]!.period_start} != 2026-09-01`);
      }
      // silence unused-var lint for v1 (kept for readability of the setup)
      void v1;
    },
  );

  // =========================================================================
  // (E) Lease PATCH guard
  // =========================================================================
  await check('lease PATCH: rent_amount_cents -> 400 with pointer message', async () => {
    const tid = await newTenancy();
    const lease = await newLease(tid, { status: 'active', rent: 200000 });
    // A realistic "old client" body: a valid patchable field alongside the rent
    // edit. Without the handler guard the term_end would apply and the rent be
    // silently stripped (a no-op); the guard turns that into an explicit 400.
    const r = await patchA(`/leases/${lease.id}`, {
      rent_amount_cents: 999000,
      term_end: '2027-06-30',
    });
    if (r.status !== 400)
      throw new Error(`expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
    const msg = (r.body as { error?: { message?: string } })?.error?.message ?? '';
    if (!/rent terms are immutable/i.test(msg)) {
      throw new Error(`expected immutability message, got: ${msg}`);
    }
    // The rent must be unchanged.
    const after = await getLease(lease.id);
    if (after.rent_amount_cents !== 200000) {
      throw new Error(`rent changed despite guard: ${after.rent_amount_cents}`);
    }
  });

  await check('lease PATCH: term_end alone still 200', async () => {
    const tid = await newTenancy();
    const lease = await newLease(tid, { status: 'active', rent: 200000 });
    const r = await patchA(`/leases/${lease.id}`, { term_end: '2027-06-30' });
    if (r.status !== 200)
      throw new Error(`expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  // =========================================================================
  // (F) Drift detection + reconciliation
  // =========================================================================
  await check('drift: lease/schedule mismatch surfaces, and a rent-change clears it', async () => {
    const tid = await newTenancy();
    await newLease(tid, { status: 'active', rent: 210000 });
    // Direct schedule create at a DIFFERENT amount than the active lease.
    await newSchedule(tid, { amount: 200000, dueDay: 1 });

    const d1 = await admin.rpc('detect_rent_drift', { p_account_id: A.accountId });
    if (d1.error) throw new Error(`detect_rent_drift: ${d1.error.message}`);
    const rows1 =
      (d1.data as Array<{
        o_tenancy_id: string;
        o_lease_amount_cents: number;
        o_schedule_total_cents: number;
      }> | null) ?? [];
    const mine = rows1.find((x) => x.o_tenancy_id === tid);
    if (!mine) throw new Error('expected a drift row for the mismatched tenancy');
    if (mine.o_lease_amount_cents !== 210000 || mine.o_schedule_total_cents !== 200000) {
      throw new Error(
        `drift amounts off: lease=${mine.o_lease_amount_cents} sched=${mine.o_schedule_total_cents}`,
      );
    }

    // Reconcile: anchor a draft renewal lease at 210000 and change the schedule
    // to match. The change must be effective TODAY: detect_rent_drift compares
    // the lease against the schedules open AS OF current_date, so a
    // future-dated reconciliation correctly leaves today's drift standing until
    // its effective date arrives (the old era is still the one billing).
    // current_date in the DB is pinned to UTC, so derive today in UTC too.
    const todayUtc = new Date().toISOString().slice(0, 10);
    const v2 = await newLease(tid, { status: 'draft', rent: 210000 });
    const fix = await rentChange(tid, {
      amount_cents: 210000,
      currency: 'USD',
      effective_date: todayUtc,
      due_day: 1,
      source_lease_id: v2.id,
      change_reason: 'reconcile drift',
    });
    if (fix.status !== 201)
      throw new Error(`reconcile rent-change: ${fix.status} ${JSON.stringify(fix.body)}`);

    const d2 = await admin.rpc('detect_rent_drift', { p_account_id: A.accountId });
    if (d2.error) throw new Error(`detect_rent_drift (2): ${d2.error.message}`);
    const rows2 = (d2.data as Array<{ o_tenancy_id: string }> | null) ?? [];
    if (rows2.some((x) => x.o_tenancy_id === tid)) {
      throw new Error('tenancy should have no drift after reconciliation');
    }
  });

  // =========================================================================
  // (G) RLS isolation
  // =========================================================================
  await check(
    'isolation: account-B principal cannot drive an account-A change -> 404',
    async () => {
      const tid = await newTenancy();
      await newSchedule(tid);
      const notice = await postA('/notices', { tenancy_id: tid, notice_type: 'rent_increase' });
      const noticeId = (notice.body as { id: string }).id;
      // B's token against A's account URL: not a member -> 404 (never reaches the RPC).
      const r = await rentChange(
        tid,
        {
          amount_cents: 210000,
          currency: 'USD',
          effective_date: '2026-09-01',
          due_day: 1,
          source_notice_id: noticeId,
        },
        B.accessToken,
      );
      if (r.status !== 404)
        throw new Error(`expected 404, got ${r.status} ${JSON.stringify(r.body)}`);
    },
  );

  // =========================================================================
  // (H) Notices CRUD smoke
  // =========================================================================
  await check('notices CRUD: create/get/list/patch/soft-delete', async () => {
    const tid = await newTenancy();
    const created = await postA('/notices', {
      tenancy_id: tid,
      notice_type: 'entry_notice',
      served_method: 'email',
      body: 'entry at 9am',
    });
    if (created.status !== 201)
      throw new Error(`create: ${created.status} ${JSON.stringify(created.body)}`);
    const notice = created.body as {
      id: string;
      served_at: string | null;
      served_method: string | null;
    };
    if (notice.served_at !== null)
      throw new Error(`served_at should be null, got ${notice.served_at}`);

    const got = await getA(`/notices/${notice.id}`);
    if (got.status !== 200) throw new Error(`get: ${got.status}`);

    const listed = await getA(`/notices?tenancy_id=${tid}`);
    if (listed.status !== 200) throw new Error(`list: ${listed.status}`);
    const listBody = listed.body as { data: Array<{ id: string }> };
    if (!listBody.data.some((x) => x.id === notice.id))
      throw new Error('created notice not in filtered list');

    const patched = await patchA(`/notices/${notice.id}`, { served_at: '2026-08-15T09:00:00Z' });
    if (patched.status !== 200)
      throw new Error(`patch: ${patched.status} ${JSON.stringify(patched.body)}`);
    if ((patched.body as { served_at: string }).served_at === null) {
      throw new Error('served_at should be set after patch');
    }

    const del = await api('DELETE', `/v1/accounts/${A.accountId}/notices/${notice.id}`, {
      token: A.accessToken,
    });
    if (del.status !== 204) throw new Error(`delete: ${del.status}`);
    const after = await getA(`/notices/${notice.id}`);
    if (after.status !== 404)
      throw new Error(`soft-deleted notice should 404, got ${after.status}`);
  });

  // =========================================================================
  // (F1) Advance-void: a rent change voids charges the generator already
  // advance-created off the OLD era, and the successor re-bills that period.
  // =========================================================================
  await check(
    'advance-void: old-era advance charge is voided and the successor re-bills the period',
    async () => {
      // Opt A into auto-charge so generate_rent_charges bills it.
      const en = await admin
        .from('accounts')
        .update({ auto_charge_enabled: true })
        .eq('id', A.accountId);
      if (en.error) throw new Error(`enable auto_charge: ${en.error.message}`);

      const tid = await newTenancy();
      await newLease(tid, { status: 'active', rent: 200000 });
      const oldSched = await newSchedule(tid, { amount: 200000, dueDay: 1 });

      // due_day=1, as_of the 15th (day > due_day) -> advance-bills NEXT month's
      // 1st. Fixed 2026 dates keep it deterministic (auto-charge.test.ts idiom).
      const asOf = '2026-08-15T12:00:00Z';
      const nextPeriod = '2026-09-01';
      const gen1 = await admin.rpc('generate_rent_charges', {
        p_account_id: A.accountId,
        p_as_of: asOf,
      });
      if (gen1.error) throw new Error(`generate #1: ${gen1.error.message}`);

      const charges0 = await admin
        .from('charges')
        .select('id, amount_cents, period_start, source_schedule_id, voided_at')
        .eq('account_id', A.accountId)
        .eq('tenancy_id', tid);
      if (charges0.error) throw new Error(`read charges #1: ${charges0.error.message}`);
      const before = (charges0.data ?? []) as {
        id: string;
        amount_cents: number;
        period_start: string;
        source_schedule_id: string;
        voided_at: string | null;
      }[];
      const oldCharge = before.find(
        (x) => x.source_schedule_id === oldSched.id && x.period_start === nextPeriod,
      );
      if (!oldCharge)
        throw new Error(`expected an advance charge for ${nextPeriod} off the old schedule`);

      // Rent change effective on that same next period -> the old-era advance
      // charge for it is voided; the successor era opens.
      const v2 = await newLease(tid, { status: 'draft', rent: 250000 });
      const r = await rentChange(tid, {
        amount_cents: 250000,
        currency: 'USD',
        effective_date: nextPeriod,
        due_day: 1,
        source_lease_id: v2.id,
        change_reason: 'annual renewal',
      });
      if (r.status !== 201) throw new Error(`rent-change: ${r.status} ${JSON.stringify(r.body)}`);
      const res = r.body as RentChangeResult;
      const newSched = res.rent_schedule;
      if (!res.voided_charge_ids || !res.voided_charge_ids.includes(oldCharge.id)) {
        throw new Error(
          `voided_charge_ids ${JSON.stringify(res.voided_charge_ids)} missing old charge ${oldCharge.id}`,
        );
      }

      // The old charge row is now voided with a reason referencing the successor.
      const voided = await admin
        .from('charges')
        .select('voided_at, void_reason')
        .eq('account_id', A.accountId)
        .eq('id', oldCharge.id)
        .single();
      if (voided.error) throw new Error(`read voided charge: ${voided.error.message}`);
      const vrow = voided.data as { voided_at: string | null; void_reason: string | null };
      if (!vrow.voided_at) throw new Error('old charge should have voided_at set');
      if (
        !vrow.void_reason ||
        !/(successor|schedule|rent change|superseded)/i.test(vrow.void_reason)
      ) {
        throw new Error(
          `void_reason should reference the successor schedule, got: ${vrow.void_reason}`,
        );
      }

      // Re-run the SAME as_of: exactly one NON-voided charge for that period, at
      // the new amount, off the successor schedule.
      const gen2 = await admin.rpc('generate_rent_charges', {
        p_account_id: A.accountId,
        p_as_of: asOf,
      });
      if (gen2.error) throw new Error(`generate #2: ${gen2.error.message}`);
      const charges1 = await admin
        .from('charges')
        .select('id, amount_cents, source_schedule_id')
        .eq('account_id', A.accountId)
        .eq('tenancy_id', tid)
        .eq('period_start', nextPeriod)
        .is('voided_at', null);
      if (charges1.error) throw new Error(`read charges #2: ${charges1.error.message}`);
      const live = (charges1.data ?? []) as {
        id: string;
        amount_cents: number;
        source_schedule_id: string;
      }[];
      if (live.length !== 1)
        throw new Error(`expected exactly 1 live charge for ${nextPeriod}, got ${live.length}`);
      if (live[0]!.amount_cents !== 250000)
        throw new Error(`live charge amount ${live[0]!.amount_cents} != 250000 (new amount)`);
      if (live[0]!.source_schedule_id !== newSched.id)
        throw new Error(
          `live charge source ${live[0]!.source_schedule_id} != successor ${newSched.id}`,
        );
    },
  );

  // =========================================================================
  // (F2) End-bound inheritance: a bounded old schedule hands its end_date to
  // the successor (so the new era doesn't silently become open-ended).
  // =========================================================================
  await check('end-bound inheritance: successor inherits the old schedule end_date', async () => {
    const tid = await newTenancy();
    const created = await postA('/rent-schedules', {
      tenancy_id: tid,
      kind: 'rent',
      amount_cents: 200000,
      currency: 'USD',
      due_day: 1,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    });
    if (created.status !== 201)
      throw new Error(`create bounded schedule: ${created.status} ${JSON.stringify(created.body)}`);
    const nRes = await postA('/notices', {
      tenancy_id: tid,
      notice_type: 'rent_increase',
      served_at: '2026-09-01T12:00:00Z',
    });
    const notice = nRes.body as { id: string };
    const r = await rentChange(tid, {
      amount_cents: 215000,
      currency: 'USD',
      effective_date: '2026-10-01',
      due_day: 1,
      source_notice_id: notice.id,
    });
    if (r.status !== 201) throw new Error(`rent-change: ${r.status} ${JSON.stringify(r.body)}`);
    const res = r.body as RentChangeResult;
    if (res.rent_schedule.end_date !== '2026-12-31') {
      throw new Error(
        `successor end_date ${res.rent_schedule.end_date} != 2026-12-31 (inherited bound)`,
      );
    }
  });

  // =========================================================================
  // (F6) Unserved notice: a notice can't authorise a change until it's served.
  // =========================================================================
  await check('unserved notice: anchoring to a notice without served_at -> 409', async () => {
    const tid = await newTenancy();
    await newSchedule(tid);
    const nRes = await postA('/notices', { tenancy_id: tid, notice_type: 'rent_increase' });
    if (nRes.status !== 201)
      throw new Error(`create notice: ${nRes.status} ${JSON.stringify(nRes.body)}`);
    const notice = nRes.body as { id: string; served_at: string | null };
    if (notice.served_at !== null) throw new Error('precondition: notice should be unserved');
    const r = await rentChange(tid, {
      amount_cents: 210000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
      source_notice_id: notice.id,
    });
    if (r.status !== 409)
      throw new Error(`expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
    const msg = (r.body as { error?: { message?: string } })?.error?.message ?? '';
    if (!/has not been served/i.test(msg))
      throw new Error(`expected 'has not been served' message, got: ${msg}`);
  });

  // =========================================================================
  // (F7) Anchored notice is locked: once it authorises billing it is evidence.
  // =========================================================================
  await check('anchored notice is locked: PATCH -> 409, DELETE -> 409', async () => {
    const tid = await newTenancy();
    await newSchedule(tid);
    const nRes = await postA('/notices', {
      tenancy_id: tid,
      notice_type: 'rent_increase',
      served_at: '2026-08-01T12:00:00Z',
    });
    const notice = nRes.body as { id: string };
    const r = await rentChange(tid, {
      amount_cents: 205000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
      source_notice_id: notice.id,
    });
    if (r.status !== 201) throw new Error(`rent-change: ${r.status} ${JSON.stringify(r.body)}`);

    const patched = await patchA(`/notices/${notice.id}`, { body: 'amended after billing' });
    if (patched.status !== 409)
      throw new Error(`expected PATCH 409, got ${patched.status} ${JSON.stringify(patched.body)}`);

    const del = await api('DELETE', `/v1/accounts/${A.accountId}/notices/${notice.id}`, {
      token: A.accessToken,
    });
    if (del.status !== 409)
      throw new Error(`expected DELETE 409, got ${del.status} ${JSON.stringify(del.body)}`);
  });

  // =========================================================================
  // (F8) Cross-tenancy anchor on a DIRECT schedule create -> 400 (DB trigger).
  // =========================================================================
  await check('cross-tenancy anchor on direct create -> 400', async () => {
    const t1 = await newTenancy();
    const t2 = await newTenancy();
    const leaseOnT2 = await newLease(t2, { status: 'active', rent: 200000 });
    const r = await postA('/rent-schedules', {
      tenancy_id: t1,
      kind: 'rent',
      amount_cents: 200000,
      currency: 'USD',
      due_day: 1,
      start_date: '2026-01-01',
      source_lease_id: leaseOnT2.id,
    });
    if (r.status !== 400)
      throw new Error(`expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  // =========================================================================
  // (F9) Superseded lease is a historical record; the anchor lease is locked.
  // =========================================================================
  await check('superseded lease resurrect -> 409; anchor lease delete -> 409', async () => {
    const tid = await newTenancy();
    const v1 = await newLease(tid, { status: 'active', rent: 200000 });
    await newSchedule(tid, { amount: 200000, dueDay: 1 });
    const v2 = await newLease(tid, { status: 'draft', rent: 250000 });
    const r = await rentChange(tid, {
      amount_cents: 250000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
      source_lease_id: v2.id,
    });
    if (r.status !== 201) throw new Error(`rent-change: ${r.status} ${JSON.stringify(r.body)}`);

    // v1 is now superseded; resurrecting it to active is refused with 409.
    const resurrect = await patchA(`/leases/${v1.id}`, { status: 'active' });
    if (resurrect.status !== 409)
      throw new Error(
        `expected resurrect 409, got ${resurrect.status} ${JSON.stringify(resurrect.body)}`,
      );

    // v2 now anchors the successor schedule; it is the instrument of record and
    // cannot be deleted.
    const del = await api('DELETE', `/v1/accounts/${A.accountId}/leases/${v2.id}`, {
      token: A.accessToken,
    });
    if (del.status !== 409)
      throw new Error(`expected delete 409, got ${del.status} ${JSON.stringify(del.body)}`);
  });

  // =========================================================================
  // (F5) Echo-back tolerance: unchanged rent values on a read-modify-write
  // PATCH are tolerated; a genuinely changed value is the 400 pointer.
  // =========================================================================
  await check('echo-back tolerance: unchanged rent -> 200, changed rent -> 400', async () => {
    const tid = await newTenancy();
    const lease = await newLease(tid, { status: 'active', rent: 200000 });
    const got = await getLease(lease.id);

    // Read-modify-write: echo the object back with a real term_end edit and the
    // UNCHANGED rent values -> tolerated (200, term_end applied).
    const echo = await patchA(`/leases/${lease.id}`, {
      term_end: '2027-06-30',
      rent_amount_cents: got.rent_amount_cents,
      rent_currency: 'USD',
    });
    if (echo.status !== 200)
      throw new Error(`expected echo 200, got ${echo.status} ${JSON.stringify(echo.body)}`);
    if ((echo.body as { term_end: string }).term_end !== '2027-06-30')
      throw new Error(`term_end not updated: ${(echo.body as { term_end: string }).term_end}`);

    // A genuinely different rent value alongside another field -> the handler
    // guard fires with the 400 pointer message.
    const bad = await patchA(`/leases/${lease.id}`, {
      term_end: '2027-07-31',
      rent_amount_cents: 300000,
    });
    if (bad.status !== 400)
      throw new Error(`expected 400, got ${bad.status} ${JSON.stringify(bad.body)}`);
    const msg = (bad.body as { error?: { message?: string } })?.error?.message ?? '';
    if (!/rent terms are immutable/i.test(msg))
      throw new Error(`expected immutability message, got: ${msg}`);

    // A body containing ONLY rent keys never reaches the handler: zod strips
    // the unknown keys, the empty remainder fails the at-least-one-field
    // refine, and the request 400s with the generic validation envelope. Still
    // a loud block (never a silent no-op) -- just a less specific message.
    const rentOnly = await patchA(`/leases/${lease.id}`, { rent_amount_cents: 300000 });
    if (rentOnly.status !== 400) throw new Error(`expected rent-only 400, got ${rentOnly.status}`);

    // And nothing changed on the row.
    const after = await getLease(lease.id);
    if (after.rent_amount_cents !== 200000)
      throw new Error(`rent mutated: ${after.rent_amount_cents}`);
  });

  // --- summary ---
  if (failures.length > 0) {
    console.error(`\n${failures.length} rent-change failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: instrument-anchored rent-change checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
