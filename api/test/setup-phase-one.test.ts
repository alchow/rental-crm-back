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
  const rollup = await request('GET', '/rent-rollup?status=upcoming');
  const row = (
    rollup.body as { data: Array<{ tenancy_id: string; deposit_held_cents: number }> }
  ).data.find((r) => r.tenancy_id === tenancyId);
  assert(row?.deposit_held_cents === 185000, `deposit held: ${JSON.stringify(rollup.body)}`);
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

await check('"Use the lease terms" is sending follows_lease true', async () => {
  const id = await draft();
  const differs = setup({}, { follows_lease: false, amount_cents: 190000, grace_days: 2 });
  const before = await request('POST', `/tenancy-setup-sessions/${id}/preview`, differs);
  assert(
    (before.body as { billing_differences: unknown[] }).billing_differences.length > 0,
    JSON.stringify(before.body),
  );
  const fixed = setup({}, { follows_lease: true, amount_cents: 190000, grace_days: 2 });
  const after = await request('POST', `/tenancy-setup-sessions/${id}/preview`, fixed);
  const body = after.body as {
    billing_differences: unknown[];
    billing_intent: { rent: { amount_cents: number; grace_days: number } };
  };
  assert(
    after.status === 200 &&
      body.billing_differences.length === 0 &&
      body.billing_intent.rent.amount_cents === 185000 &&
      body.billing_intent.rent.grace_days === 5,
    JSON.stringify(after.body),
  );
});

await check(
  'a receipt before the itemized months asks how it relates to the amount owed',
  async () => {
    await pool.query('update public.accounts set opening_balance_ledger_enabled=true where id=$1', [
      accountId,
    ]);
    const id = await draft();
    const month = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    month.setUTCMonth(month.getUTCMonth() - 1);
    const itemizeFrom = month.toISOString().slice(0, 7);
    const start = new Date(month);
    start.setUTCMonth(start.getUTCMonth() - 3);
    const startOn = start.toISOString().slice(0, 10);
    const input = (choice?: 'add_to_owed' | 'keep_owed') =>
      setup(
        {
          tenancy: { start_date: startOn, end_date: null },
          agreement: { ...setup().agreement, term_start: startOn },
        },
        {
          coverage_start: startOn,
          regular_anchor: startOn,
          opening_balance: {
            amount_cents: 65000,
            basis: 'Rent',
            itemize_from: itemizeFrom,
            ...(choice ? { earlier_receipts: [{ payment_key: 'early', choice }] } : {}),
          },
        },
      );
    const withReceipt = (choice?: 'add_to_owed' | 'keep_owed') => {
      const body = input(choice);
      (body.billing as { payments: unknown[] }).payments = [
        {
          draft_key: 'early',
          amount_cents: 30000,
          currency: 'USD',
          received_at: startOn,
          method: 'check',
          allocations: [],
        },
      ];
      return body;
    };
    const unanswered = await request(
      'POST',
      `/tenancy-setup-sessions/${id}/validate`,
      withReceipt(),
    );
    const errors = (
      unanswered.body as { errors: Array<{ code: string; meta?: Record<string, string> }> }
    ).errors;
    assert(
      errors.some(
        (e) =>
          e.code === 'opening.receipt_unanswered' &&
          e.meta?.draft_key === 'early' &&
          e.meta?.amount_cents === '30000',
      ),
      JSON.stringify(unanswered.body),
    );
    const twice = withReceipt('add_to_owed');
    const twiceOpening = (
      twice.billing.rent as unknown as { opening_balance: { earlier_receipts: unknown[] } }
    ).opening_balance;
    twiceOpening.earlier_receipts = [
      ...twiceOpening.earlier_receipts,
      ...twiceOpening.earlier_receipts,
    ];
    const repeated = await request('POST', `/tenancy-setup-sessions/${id}/validate`, twice);
    assert(
      (repeated.body as { ok: boolean; errors: Array<{ code: string }> }).errors.some(
        (e) => e.code === 'opening.receipt_answer_invalid',
      ),
      JSON.stringify(repeated.body),
    );
    const answered = withReceipt('keep_owed');
    const review = await request('POST', `/tenancy-setup-sessions/${id}/preview`, answered);
    const r = review.body as {
      can_confirm: boolean;
      setup_context: string;
      opening_receipts: Array<{ choice: string }>;
      opening_result: { still_owed_cents: number; applied_cents: number; paid_ahead_cents: number };
    };
    assert(
      review.status === 200 &&
        r.can_confirm &&
        r.opening_receipts[0]?.choice === 'keep_owed' &&
        r.opening_result.still_owed_cents === 35000 &&
        r.opening_result.applied_cents === 30000 &&
        r.opening_result.paid_ahead_cents === 0,
      JSON.stringify(review.body),
    );
    const committed = await request('POST', `/tenancy-setup-sessions/${id}/commit`, {
      setup: answered,
      expected_context: r.setup_context,
      accept_warnings: true,
    });
    assert(committed.status === 201, JSON.stringify(committed.body));
    const opening = await pool.query(
      `select c.amount_cents, a.typed_opening_cents from public.charges c
       join public.tenancy_adoptions a on a.id = c.opening_adoption_id
      where c.tenancy_id=$1 and c.type='opening_balance'`,
      [(committed.body as { tenancy_id: string }).tenancy_id],
    );
    assert(
      Number(opening.rows[0]?.amount_cents) === 65000 &&
        Number(opening.rows[0]?.typed_opening_cents) === 65000,
      JSON.stringify(opening.rows),
    );
    const zeroDraft = await draft();
    const zero = input();
    (zero.billing.rent as unknown as { opening_balance: Record<string, unknown> }).opening_balance =
      {
        amount_cents: 0,
        itemize_from: itemizeFrom,
      };
    const zeroReview = await request('POST', `/tenancy-setup-sessions/${zeroDraft}/preview`, zero);
    const z0 = zeroReview.body as {
      can_confirm: boolean;
      findings: Array<{ rule_id: string; severity: string }>;
    };
    assert(
      zeroReview.status === 200 &&
        z0.can_confirm &&
        z0.findings.some(
          (f) => f.rule_id === 'opening_months_treated_as_paid' && f.severity === 'info',
        ),
      JSON.stringify(zeroReview.body),
    );
  },
);

await check('a deposit paid before the itemized months keeps its deposit allocation', async () => {
  await pool.query('update public.accounts set opening_balance_ledger_enabled=true where id=$1', [
    accountId,
  ]);
  const id = await draft();
  const month = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
  month.setUTCMonth(month.getUTCMonth() - 1);
  const itemizeFrom = month.toISOString().slice(0, 7);
  const input = setup(
    {
      tenancy: { start_date: '2025-06-01', end_date: null },
      agreement: { ...setup().agreement, term_start: '2025-06-01' },
      deposit_answer: {
        amount_cents: 185000,
        paid: 'yes',
        payment: { method: 'check', received_at: '2025-06-01' },
      },
    },
    {
      coverage_start: '2025-06-01',
      regular_anchor: '2025-06-01',
      opening_balance: { amount_cents: 65000, basis: 'Rent', itemize_from: itemizeFrom },
    },
  );
  const review = await request('POST', `/tenancy-setup-sessions/${id}/preview`, input);
  const r = review.body as {
    can_confirm: boolean;
    setup_context: string;
    opening_receipts: unknown[];
    opening_result: { still_owed_cents: number; unanswered_count: number; applied_cents: number };
  };
  assert(
    review.status === 200 &&
      r.can_confirm &&
      r.opening_receipts.length === 0 &&
      r.opening_result.unanswered_count === 0 &&
      r.opening_result.applied_cents === 0 &&
      r.opening_result.still_owed_cents === 65000,
    JSON.stringify(review.body),
  );
  const committed = await request('POST', `/tenancy-setup-sessions/${id}/commit`, {
    setup: input,
    expected_context: r.setup_context,
    accept_warnings: true,
  });
  assert(committed.status === 201, JSON.stringify(committed.body));
  const tenancyId = (committed.body as { tenancy_id: string }).tenancy_id;
  const money = await pool.query(
    `select c.type, c.amount_cents,
              coalesce((select sum(x.amount_cents) from public.payment_allocations x
                where x.charge_id = c.id and x.voided_at is null), 0) as applied
         from public.charges c
        where c.tenancy_id = $1 and c.type in ('deposit', 'opening_balance') and c.voided_at is null`,
    [tenancyId],
  );
  const byType = Object.fromEntries(
    money.rows.map((row) => [row.type, [Number(row.amount_cents), Number(row.applied)]]),
  );
  assert(
    JSON.stringify(byType.deposit) === '[185000,185000]' &&
      JSON.stringify(byType.opening_balance) === '[65000,0]',
    JSON.stringify(money.rows),
  );
});

await check(
  'a period amount records whether it is the suggestion or the landlord own',
  async () => {
    const id = await draft();
    const midMonth = `${nextMonth.slice(0, 7)}-15`;
    const anchor = new Date(`${nextMonth}T12:00:00Z`);
    anchor.setUTCMonth(anchor.getUTCMonth() + 1);
    const base = setup(
      {
        tenancy: { start_date: midMonth, end_date: null },
        agreement: { ...setup().agreement, term_start: midMonth },
      },
      { coverage_start: midMonth, regular_anchor: anchor.toISOString().slice(0, 10) },
    );
    const first = await request('POST', `/tenancy-setup-sessions/${id}/preview`, base);
    assert(first.status === 200, JSON.stringify(first.body));
    const partial = first.body as {
      proration_suggestions: Array<{
        cycle_key: string;
        period_start: string;
        period_end: string;
        amount_cents: number;
      }>;
      history_periods: Array<{ cycle_key: string; due_date: string }>;
    };
    const suggestion = partial.proration_suggestions[0]!;
    const due = partial.history_periods.find((p) => p.cycle_key === suggestion.cycle_key)!.due_date;
    const withAmount = (amount: number) => {
      const body = structuredClone(base);
      (body.billing.rent as Record<string, unknown>).period_overrides = [
        {
          cycle_key: suggestion.cycle_key,
          period_start: suggestion.period_start,
          period_end: suggestion.period_end,
          due_date: due,
          amount_cents: amount,
          reason: 'Agreed with tenant',
        },
      ];
      return body;
    };
    for (const [amount, source] of [
      [suggestion.amount_cents, 'suggested'],
      [suggestion.amount_cents - 100, 'landlord'],
    ] as const) {
      const review = await request(
        'POST',
        `/tenancy-setup-sessions/${id}/preview`,
        withAmount(amount),
      );
      const sources = (review.body as { period_amount_sources: Array<{ amount_source: string }> })
        .period_amount_sources;
      assert(
        review.status === 200 && sources[0]?.amount_source === source,
        JSON.stringify(review.body),
      );
    }
  },
);

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

await check('a mistyped starting balance is voided and re-entered', async () => {
  await pool.query('update public.accounts set opening_balance_ledger_enabled=true where id=$1', [
    accountId,
  ]);
  const id = await draft();
  const monthStart = `${today.slice(0, 7)}-01`;
  const startDate = new Date(`${monthStart}T12:00:00Z`);
  startDate.setUTCMonth(startDate.getUTCMonth() - 2);
  const startOn = startDate.toISOString().slice(0, 10);
  const input = setup(
    {
      tenancy: { start_date: startOn, end_date: null },
      agreement: { ...setup().agreement, term_start: startOn },
    },
    {
      coverage_start: monthStart,
      regular_anchor: monthStart,
      history_mode: 'opening_balance',
      opening_balance: { amount_cents: 650000, basis: 'Rent', includes_current_rent: true },
    },
  );
  const review = await request('POST', `/tenancy-setup-sessions/${id}/preview`, input);
  assert(review.status === 200, JSON.stringify(review.body));
  const committed = await request('POST', `/tenancy-setup-sessions/${id}/commit`, {
    setup: input,
    expected_context: (review.body as { setup_context: string }).setup_context,
    accept_warnings: true,
  });
  assert(committed.status === 201, JSON.stringify(committed.body));
  const tenancyId = (committed.body as { tenancy_id: string }).tenancy_id;
  const path = `/tenancies/${tenancyId}/opening-balance/correction`;
  const body = { amount_cents: 65000, basis: 'Rent', reason: 'Typed one zero too many' };
  const preview = await request('POST', `${path}/preview`, body);
  const p = preview.body as {
    previous: { opening_cents: number };
    next: { opening_cents: number };
    owed_before: { total_cents: number };
    owed_after: { total_cents: number };
  };
  assert(
    preview.status === 200 &&
      p.previous.opening_cents === 650000 &&
      p.next.opening_cents === 65000 &&
      p.owed_before.total_cents === 650000 &&
      p.owed_after.total_cents === 65000,
    JSON.stringify(preview.body),
  );
  const key = crypto.randomUUID();
  const first = await api('POST', base + path, {
    token: auth.session.access_token,
    body,
    idempotencyKey: key,
  });
  assert(first.status === 200, JSON.stringify(first.body));
  const replay = await api('POST', base + path, {
    token: auth.session.access_token,
    body,
    idempotencyKey: key,
  });
  assert(
    replay.status === 200 &&
      replay.headers['idempotency-replay'] === 'true' &&
      JSON.stringify(replay.body) === JSON.stringify(first.body),
    JSON.stringify(replay.headers),
  );
  const ledger = await request('GET', `/tenancies/${tenancyId}/ledger`);
  const entries = (
    ledger.body as {
      entries: Array<{ type?: string; amount_cents: number; voided_at?: string | null }>;
    }
  ).entries.filter((e) => e.type === 'opening_balance');
  assert(
    entries.length === 2 &&
      entries.some((e) => e.amount_cents === 650000 && e.voided_at) &&
      entries.some((e) => e.amount_cents === 65000 && !e.voided_at),
    JSON.stringify(entries),
  );
  const unchanged = await request('POST', `${path}/preview`, body);
  assert(
    unchanged.status === 400 &&
      (unchanged.body as { error: { code: string } }).error.code === 'opening_unchanged',
    JSON.stringify(unchanged.body),
  );
  await pool.query('update public.accounts set opening_balance_ledger_enabled=false where id=$1', [
    accountId,
  ]);
  const off = await request('POST', `${path}/preview`, { ...body, amount_cents: 70000 });
  await pool.query('update public.accounts set opening_balance_ledger_enabled=true where id=$1', [
    accountId,
  ]);
  assert(
    off.status === 409 &&
      (off.body as { error: { code: string } }).error.code === 'opening_ledger_disabled',
    JSON.stringify(off.body),
  );
});
  assert(
    deleted.status === 409 &&
      (deleted.body as { error: { code: string } }).error.code === 'opening_entry_deleted',
    JSON.stringify(deleted.body),
  );
});

await check('the wizard flag is read-only on settings and set in SQL', async () => {
  const off = await request('GET', '/settings');
  assert(
    (off.body as { wizard_v2_enabled: boolean }).wizard_v2_enabled === false,
    JSON.stringify(off.body),
  );
  const patched = await request('PATCH', '/settings', { wizard_v2_enabled: true });
  assert(patched.status === 400, JSON.stringify(patched.body));
  await pool.query('update public.accounts set wizard_v2_enabled=true where id=$1', [accountId]);
  const on = await request('GET', '/settings');
  assert(
    (on.body as { wizard_v2_enabled: boolean }).wizard_v2_enabled === true,
    JSON.stringify(on.body),
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
