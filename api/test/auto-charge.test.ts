// ----------------------------------------------------------------------------
// Automatic rent charging tests (migration 20260704000001).
//
// Covers the three pieces that migration adds on top of the Phase 9 generator:
//
//   (A) Opt-in gate. With accounts.auto_charge_enabled = false (the default),
//       generate_rent_charges returns ZERO rows and writes NO charge, even for
//       a perfectly billable schedule. Flipping the flag true unblocks it.
//
//   (B) Advance timing. The period_start of the generated charge follows the
//       "next due date at or after we pass this month's due day" rule:
//         due_day=1,  as_of 2026-07-01 -> 2026-07-01 (day == due_day)
//         due_day=1,  as_of 2026-07-02 -> 2026-08-01 (day >  due_day)
//         due_day=15, as_of 2026-07-10 -> 2026-07-15
//         due_day=15, as_of 2026-07-16 -> 2026-08-15
//
//   (C) Idempotency carries over: running the same as_of twice still yields
//       exactly one charge per (schedule, period).
//
//   (D) Period-scoped bounds: a schedule whose end_date is before the derived
//       p_start is not charged; an ENDED tenancy with a still-open schedule is
//       not charged.
//
//   (E) End cascade: admin-updating a tenancy to set end_date + status='ended'
//       (the shape the settings/tenancy PATCH produces) writes that end_date
//       onto the tenancy's open rent_schedules, and a later generate emits
//       nothing for periods after it.
//
// Mirrors phase9.test.ts exactly (same env bootstrap, getAdminClient, check()).
// Needs the live local Supabase stack (SUPABASE_URL etc. resolved from
// `supabase status`), so it will not run in a sandbox without that stack --
// same as its sibling tests; CI/dev run it against the local DB.
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
process.env.PORT = '8790';
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

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

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
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    headers: responseHeaders,
  };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface UserFixture {
  userId: string;
  accessToken: string;
  accountId: string;
  propertyId: string;
  unitAreaId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `autocharge-${label}-${rnd()}@example.test`;
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
    if (r.status !== 201) throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(
    `/v1/accounts/${b.account.id}/properties`, { name: `${label} prop` },
  );
  const unitArea = await post<{ id: string }>(
    `/v1/accounts/${b.account.id}/areas`,
    { property_id: property.id, kind: 'unit', name: `${label} unit` },
  );
  return {
    userId: b.user.id,
    accessToken: b.session.access_token,
    accountId: b.account.id,
    propertyId: property.id,
    unitAreaId: unitArea.id,
  };
}

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

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Auto rent-charging checks');
  const A = await setupUser('A');
  const admin = getAdminClient();

  // Seed a tenancy + rent_schedule directly via the admin client (the same
  // seeding style phase9.test.ts uses). Returns both ids.
  async function seed(opts: {
    dueDay: number;
    tenancyStart?: string;
    tenancyEnd?: string | null;
    tenancyStatus?: 'upcoming' | 'active' | 'ended' | 'holdover';
    schedStart?: string;
    schedEnd?: string | null;
    amount?: number;
  }): Promise<{ tenancyId: string; scheduleId: string }> {
    const t = await admin.from('tenancies').insert({
      account_id: A.accountId,
      area_id: A.unitAreaId,
      start_date: opts.tenancyStart ?? '2026-01-01',
      end_date: opts.tenancyEnd ?? null,
      status: opts.tenancyStatus ?? 'active',
    }).select('id').single();
    if (t.error || !t.data) throw new Error(`seed tenancy: ${t.error?.message}`);
    const s = await admin.from('rent_schedules').insert({
      account_id: A.accountId,
      tenancy_id: t.data.id,
      kind: 'rent',
      amount_cents: opts.amount ?? 200000,
      currency: 'USD',
      due_day: opts.dueDay,
      start_date: opts.schedStart ?? '2026-01-01',
      end_date: opts.schedEnd ?? null,
    }).select('id').single();
    if (s.error || !s.data) throw new Error(`seed schedule: ${s.error?.message}`);
    return { tenancyId: t.data.id, scheduleId: s.data.id };
  }

  interface GenRow { o_charge_id: string; o_schedule_id: string; o_period_start: string; o_amount_cents: number }
  async function generate(asOf: string): Promise<GenRow[]> {
    const r = await admin.rpc('generate_rent_charges', {
      p_account_id: A.accountId,
      p_as_of: asOf,
    });
    if (r.error) throw new Error(`generate(${asOf}): ${r.error.message}`);
    return ((r.data as GenRow[] | null) ?? []);
  }

  async function chargesFor(scheduleId: string): Promise<{ id: string; period_start: string }[]> {
    const { data, error } = await admin
      .from('charges')
      .select('id, period_start')
      .eq('account_id', A.accountId)
      .eq('source_schedule_id', scheduleId);
    if (error) throw new Error(`chargesFor: ${error.message}`);
    return (data ?? []) as { id: string; period_start: string }[];
  }

  // =========================================================================
  // (A) Opt-in gate
  // =========================================================================

  await check('flag OFF (default): generate returns 0 rows and writes no charge', async () => {
    const { scheduleId } = await seed({ dueDay: 1 });
    const rows = await generate('2026-07-02T12:00:00Z');
    const mine = rows.filter((r) => r.o_schedule_id === scheduleId);
    if (mine.length !== 0) throw new Error(`expected 0 generated rows while flag off, got ${mine.length}`);
    const charges = await chargesFor(scheduleId);
    if (charges.length !== 0) throw new Error(`expected 0 charges while flag off, got ${charges.length}`);
  });

  // Flip the opt-in on for A (admin path -- the API PATCH route would do this
  // under the user's JWT via the accounts_member_settings_update policy).
  await check('flag ON: admin sets auto_charge_enabled=true', async () => {
    const { error } = await admin
      .from('accounts')
      .update({ auto_charge_enabled: true })
      .eq('id', A.accountId);
    if (error) throw new Error(`enable flag: ${error.message}`);
    const { data } = await admin
      .from('accounts')
      .select('auto_charge_enabled')
      .eq('id', A.accountId)
      .single();
    if (data?.auto_charge_enabled !== true) throw new Error('flag did not persist true');
  });

  // =========================================================================
  // (B) Advance timing -- period_start correctness
  // =========================================================================

  await check('timing: due_day=1, as_of 2026-07-01 -> period_start 2026-07-01', async () => {
    const { scheduleId } = await seed({ dueDay: 1 });
    const rows = await generate('2026-07-01T12:00:00Z');
    const mine = rows.filter((r) => r.o_schedule_id === scheduleId);
    if (mine.length !== 1) throw new Error(`expected 1 generated row, got ${mine.length}`);
    if (mine[0]!.o_period_start !== '2026-07-01') {
      throw new Error(`expected period_start 2026-07-01, got ${mine[0]!.o_period_start}`);
    }
  });

  await check('timing: due_day=1, as_of 2026-07-02 -> period_start 2026-08-01 (advance)', async () => {
    const { scheduleId } = await seed({ dueDay: 1 });
    const rows = await generate('2026-07-02T12:00:00Z');
    const mine = rows.filter((r) => r.o_schedule_id === scheduleId);
    if (mine.length !== 1) throw new Error(`expected 1 generated row, got ${mine.length}`);
    if (mine[0]!.o_period_start !== '2026-08-01') {
      throw new Error(`expected period_start 2026-08-01, got ${mine[0]!.o_period_start}`);
    }
  });

  await check('timing: due_day=15, as_of 2026-07-10 -> period_start 2026-07-15', async () => {
    const { scheduleId } = await seed({ dueDay: 15 });
    const rows = await generate('2026-07-10T12:00:00Z');
    const mine = rows.filter((r) => r.o_schedule_id === scheduleId);
    if (mine.length !== 1) throw new Error(`expected 1 generated row, got ${mine.length}`);
    if (mine[0]!.o_period_start !== '2026-07-15') {
      throw new Error(`expected period_start 2026-07-15, got ${mine[0]!.o_period_start}`);
    }
  });

  await check('timing: due_day=15, as_of 2026-07-16 -> period_start 2026-08-15 (advance)', async () => {
    const { scheduleId } = await seed({ dueDay: 15 });
    const rows = await generate('2026-07-16T12:00:00Z');
    const mine = rows.filter((r) => r.o_schedule_id === scheduleId);
    if (mine.length !== 1) throw new Error(`expected 1 generated row, got ${mine.length}`);
    if (mine[0]!.o_period_start !== '2026-08-15') {
      throw new Error(`expected period_start 2026-08-15, got ${mine[0]!.o_period_start}`);
    }
  });

  // =========================================================================
  // (C) Idempotency -- double-run same as_of
  // =========================================================================

  await check('idempotent: same as_of twice -> exactly one charge per (schedule, period)', async () => {
    const { scheduleId } = await seed({ dueDay: 1 });
    const r1 = (await generate('2026-07-02T12:00:00Z')).filter((r) => r.o_schedule_id === scheduleId);
    const r2 = (await generate('2026-07-02T12:00:00Z')).filter((r) => r.o_schedule_id === scheduleId);
    if (r1.length !== 1) throw new Error(`run1 expected 1 insert, got ${r1.length}`);
    if (r2.length !== 0) throw new Error(`run2 expected 0 inserts (ON CONFLICT), got ${r2.length}`);
    const charges = await chargesFor(scheduleId);
    if (charges.length !== 1) throw new Error(`expected exactly 1 charge, got ${charges.length}`);
    if (charges[0]!.period_start !== '2026-08-01') {
      throw new Error(`expected period 2026-08-01, got ${charges[0]!.period_start}`);
    }
  });

  // =========================================================================
  // (D) Period-scoped bounds
  // =========================================================================

  await check('bounds: schedule end_date < p_start -> not charged', async () => {
    // due_day=1, as_of 2026-07-02 -> p_start 2026-08-01. end_date 2026-06-30
    // is before that period, so nothing should generate.
    const { scheduleId } = await seed({ dueDay: 1, schedEnd: '2026-06-30' });
    const rows = (await generate('2026-07-02T12:00:00Z')).filter((r) => r.o_schedule_id === scheduleId);
    if (rows.length !== 0) throw new Error(`expected 0 generated rows past schedule end, got ${rows.length}`);
    if ((await chargesFor(scheduleId)).length !== 0) throw new Error('expected 0 charges past schedule end');
  });

  await check('bounds: ended tenancy with open schedule -> not charged', async () => {
    const { scheduleId } = await seed({ dueDay: 1, tenancyStatus: 'ended' });
    const rows = (await generate('2026-07-02T12:00:00Z')).filter((r) => r.o_schedule_id === scheduleId);
    if (rows.length !== 0) throw new Error(`expected 0 generated rows for ended tenancy, got ${rows.length}`);
    if ((await chargesFor(scheduleId)).length !== 0) throw new Error('expected 0 charges for ended tenancy');
  });

  // =========================================================================
  // (E) End cascade
  // =========================================================================

  await check('cascade: ending a tenancy writes end_date onto its open schedule', async () => {
    const { tenancyId, scheduleId } = await seed({ dueDay: 1 });

    // PATCH-equivalent: set the move-out date AND mark the tenancy ended in one
    // update (the trigger fires on the status flip / end_date set).
    const upd = await admin
      .from('tenancies')
      .update({ end_date: '2026-07-31', status: 'ended' })
      .eq('id', tenancyId);
    if (upd.error) throw new Error(`end tenancy: ${upd.error.message}`);

    const { data: sched, error } = await admin
      .from('rent_schedules')
      .select('end_date')
      .eq('id', scheduleId)
      .single();
    if (error || !sched) throw new Error(`read schedule: ${error?.message}`);
    if (sched.end_date !== '2026-07-31') {
      throw new Error(`expected schedule end_date 2026-07-31 after cascade, got ${sched.end_date}`);
    }

    // A subsequent generate for a period AFTER the end must emit nothing: both
    // the schedule end_date (2026-07-31) and the ended-tenancy guard exclude it.
    const rows = (await generate('2026-08-02T12:00:00Z')).filter((r) => r.o_schedule_id === scheduleId);
    if (rows.length !== 0) throw new Error(`expected 0 generated rows after tenancy end, got ${rows.length}`);
  });

  // --- summary ---
  if (failures.length > 0) {
    console.error(`\n${failures.length} auto-charge failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: auto rent-charging checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
