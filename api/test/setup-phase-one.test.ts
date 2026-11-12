import pg from 'pg';
import {
  assert,
  configureIntegrationEnv,
  createApiClient,
  createCheckHarness,
  randomToken,
} from './helpers/integration';
const stack = configureIntegrationEnv('8813');
const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');
const api = createApiClient(buildApp());
const { check, failures } = createCheckHarness();
const pool = new pg.Pool({ connectionString: stack.DB_URL });

const signup = await api('POST', '/v1/auth/signup', {
  body: {
    email: `phase-one-${randomToken()}@example.test`,
    password: `test-${randomToken()}`,
    account_name: 'Setup Phase 1',
    time_zone: 'America/Los_Angeles',
  },
});
assert(signup.status === 200, JSON.stringify(signup.body));
const auth = signup.body as { account: { id: string }; session: { access_token: string } };
const accountId = auth.account.id;
const base = `/v1/accounts/${accountId}`;
async function request(method: string, path: string, body?: unknown) {
  return api(method, base + path, { token: auth.session.access_token, body });
}
const property = await request('POST', '/properties', { name: '418 Juniper Avenue' });
assert(property.status === 201, JSON.stringify(property.body));

const today = new Date().toISOString().slice(0, 10);
const future = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
future.setUTCMonth(future.getUTCMonth() + 1);
const nextMonth = future.toISOString().slice(0, 10);

async function draft(): Promise<string> {
  const unit = await request('POST', '/areas', {
    property_id: (property.body as { id: string }).id,
    kind: 'unit',
    name: randomToken(),
  });
  assert(unit.status === 201, JSON.stringify(unit.body));
  const id = crypto.randomUUID();
  const saved = await request('PUT', `/tenancy-setup-sessions/${id}`, {
    area_id: (unit.body as { id: string }).id,
    expected_revision: 0,
    payload: { screen: 'who' },
  });
  assert(saved.status === 200, JSON.stringify(saved.body));
  return id;
}
function setup(overrides: Record<string, unknown> = {}, rent: Record<string, unknown> = {}) {
  return {
    people: [{ key: crypto.randomUUID(), full_name: 'Dana Whitfield', phones: [], emails: [] }],
    tenancy: { start_date: nextMonth, end_date: null },
    agreement: {
      id: crypto.randomUUID(),
      change_kind: 'new',
      term_start: nextMonth,
      term_end: null,
      rent_amount_cents: 185000,
      rent_currency: 'USD',
      deposit_amount_cents: 0,
      deposit_currency: 'USD',
      rent_due_rule: { kind: 'day_of_month', day: 1 },
      grace_days: 5,
      late_fee_policy: { kind: 'percent', percent: 4 },
      deposit_knowledge: 'unknown',
      terms_source: { kind: 'manual' },
    },
    billing: {
      rent: {
        decision: 'configure',
        coverage_start: nextMonth,
        regular_anchor: nextMonth,
        due_day: 1,
        amount_cents: 1,
        currency: 'USD',
        history_mode: 'itemized',
        charge_keys: [],
        follows_lease: true,
        ...rent,
      },
      deposit: { decision: 'defer' },
      payments: [],
      credit_allocations: [],
      explanations: [],
    },
    receipt_purposes: {},
    warning_notes: {},
    ...overrides,
  };
}

await check('validate lists every field error at once with stable codes', async () => {
  const id = await draft();
  const bad = setup();
  (bad.agreement as Record<string, unknown>).term_end = '2020-01-01';
  (bad.agreement as Record<string, unknown>).rent_currency = 'DOL';
  const result = await request('POST', `/tenancy-setup-sessions/${id}/validate`, bad);
  assert(result.status === 200, JSON.stringify(result.body));
  const body = result.body as {
    ok: boolean;
    errors: Array<{ code: string; step: string; field: string }>;
  };
  const codes = body.errors.map((e) => `${e.code}@${e.field}`);
  assert(
    !body.ok &&
      codes.includes('lease.end_before_start@agreement.term_end') &&
      codes.includes('currency.unsupported@agreement.rent_currency'),
    JSON.stringify(body),
  );
  const letters = setup();
  (letters.agreement as Record<string, unknown>).rent_amount_cents = 'abc';
  const typed = await request('POST', `/tenancy-setup-sessions/${id}/validate`, letters);
  assert(
    typed.status === 200 &&
      (typed.body as { errors: Array<{ code: string }> }).errors.some(
        (e) => e.code === 'rent.not_a_number',
      ),
    JSON.stringify(typed.body),
  );
  const good = await request('POST', `/tenancy-setup-sessions/${id}/validate`, setup());
  assert(good.status === 200 && (good.body as { ok: boolean }).ok, JSON.stringify(good.body));
});

await check('confirm returns the same field errors as validate', async () => {
  const id = await draft();
  const bad = setup();
  (bad.agreement as Record<string, unknown>).term_end = '2020-01-01';
  const commit = await request('POST', `/tenancy-setup-sessions/${id}/commit`, {
    setup: bad,
    expected_context: 'x',
    accept_warnings: true,
  });
  const error = (
    commit.body as { error: { code: string; details: { errors: Array<{ code: string }> } } }
  ).error;
  assert(
    commit.status === 400 &&
      error.code === 'invalid_request' &&
      error.details.errors[0]?.code === 'lease.end_before_start',
    JSON.stringify(commit.body),
  );
});

await check('people match finds existing people only while the flag is on', async () => {
  const person = await request('POST', '/tenants', {
    full_name: 'Marcus Oyelaran',
    emails: [`marcus-${randomToken()}@example.test`],
    phones: ['+15035550188'],
  });
  assert(person.status === 201, JSON.stringify(person.body));
  const email = (person.body as { emails: string[] }).emails[0]!;
  const off = await request(
    'GET',
    `/people/match?email=${encodeURIComponent(email.toUpperCase())}`,
  );
  assert(
    off.status === 200 && (off.body as { enabled: boolean }).enabled === false,
    JSON.stringify(off.body),
  );
  await pool.query('update public.accounts set person_match_enabled=true where id=$1', [accountId]);
  const exact = await request(
    'GET',
    `/people/match?email=${encodeURIComponent(email.toUpperCase())}`,
  );
  const body = exact.body as {
    exact: Array<{ person_id: string; matched_on: string[] }>;
    possible: unknown[];
  };
  assert(
    exact.status === 200 &&
      body.exact[0]?.person_id === (person.body as { id: string }).id &&
      body.exact[0]?.matched_on.join() === 'email',
    JSON.stringify(exact.body),
  );
  const possible = await request(
    'GET',
    `/people/match?name=${encodeURIComponent('  marcus  oyelaran')}`,
  );
  assert(
    (possible.body as { possible: unknown[] }).possible.length === 1,
    JSON.stringify(possible.body),
  );
  await pool.query('update public.accounts set person_match_enabled=false where id=$1', [
    accountId,
  ]);
});

await check('billing follows the lease and the deposit is entered once', async () => {
  const id = await draft();
  const input = setup({
    deposit_answer: {
      amount_cents: 185000,
      paid: 'yes',
      payment: { method: 'check', received_at: today },
    },
  });
  const review = await request('POST', `/tenancy-setup-sessions/${id}/preview`, input);
  assert(review.status === 200, JSON.stringify(review.body));
  const r = review.body as {
    setup_context: string;
    can_confirm: boolean;
    billing_intent: {
      rent: { amount_cents: number; grace_days: number; late_fee_policy: unknown };
    };
    billing_differences: unknown[];
    charge_candidates: Array<{ type: string; due_date: string; amount_cents: number }>;
  };
  assert(
    r.billing_intent.rent.amount_cents === 185000 &&
      r.billing_intent.rent.grace_days === 5 &&
      JSON.stringify(r.billing_intent.rent.late_fee_policy) === '{"kind":"percent","percent":4}' &&
      r.billing_differences.length === 0,
    JSON.stringify(r.billing_intent),
  );
  const deposit = r.charge_candidates.find((c) => c.type === 'deposit');
  assert(
    deposit?.due_date === nextMonth && deposit.amount_cents === 185000,
    JSON.stringify(r.charge_candidates),
  );
  const committed = await request('POST', `/tenancy-setup-sessions/${id}/commit`, {
    setup: input,
    expected_context: r.setup_context,
    accept_warnings: true,
  });
  assert(committed.status === 201, JSON.stringify(committed.body));
  const tenancyId = (committed.body as { tenancy_id: string }).tenancy_id;
  const ledger = await request('GET', `/tenancies/${tenancyId}/ledger`);
  const totals = (ledger.body as { totals: Record<string, number> }).totals;
  assert(
    totals.deposit_charges_cents === 185000 && totals.deposit_payments_cents === 185000,
    JSON.stringify(totals),
  );
  const schedule = await pool.query(
    'select follows_lease from public.rent_schedules where tenancy_id=$1',
    [tenancyId],
  );
  assert(schedule.rows[0]?.follows_lease === true, 'follows_lease not stored');
});

await check('billing that differs from the lease lists each difference', async () => {
  const id = await draft();
  const review = await request(
    'POST',
    `/tenancy-setup-sessions/${id}/preview`,
    setup(
      {},
      {
        follows_lease: false,
        amount_cents: 190000,
        grace_days: 5,
        late_fee_policy: { kind: 'percent', percent: 4 },
      },
    ),
  );
  assert(review.status === 200, JSON.stringify(review.body));
  const diffs = (
    review.body as {
      billing_differences: Array<{ field: string; lease: unknown; billing: unknown }>;
    }
  ).billing_differences;
  assert(
    diffs.some((d) => d.field === 'amount_cents' && d.lease === 185000 && d.billing === 190000),
    JSON.stringify(diffs),
  );
});

await check('settings change the proration method', async () => {
  const patched = await request('PATCH', '/settings', { proration_method: 'thirty_day_month' });
  assert(
    patched.status === 200 &&
      (patched.body as { proration_method: string }).proration_method === 'thirty_day_month',
    JSON.stringify(patched.body),
  );
  const read = await request('GET', '/settings');
  assert(
    (read.body as { proration_method: string }).proration_method === 'thirty_day_month',
    JSON.stringify(read.body),
  );
});

await pool.end();
if (failures.length) {
  console.error(failures);
  process.exit(1);
}
console.info(
  'OK: setup validation, people matching, lease-derived billing, deposit and proration settings.',
);
