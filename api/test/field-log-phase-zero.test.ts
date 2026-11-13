import pg from 'pg';
import {
  assert,
  configureIntegrationEnv,
  createApiClient,
  createCheckHarness,
  randomToken,
} from './helpers/integration';
const stack = configureIntegrationEnv('8812');
const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');
const { loadExportData } = await import('../src/admin/export-pdf');
const { renderExportPdf } = await import('../src/admin/export-pdf/render');
const api = createApiClient(buildApp());
const { check, failures } = createCheckHarness();
const pool = new pg.Pool({ connectionString: stack.DB_URL });

const signup = await api('POST', '/v1/auth/signup', {
  body: {
    email: `field-log-${randomToken()}@example.test`,
    password: `test-${randomToken()}`,
    account_name: 'Field Log Phase 0',
    time_zone: 'America/Los_Angeles',
  },
});
assert(signup.status === 200, JSON.stringify(signup.body));
const auth = signup.body as {
  user: { id: string };
  account: { id: string };
  session: { access_token: string };
};
const accountId = auth.account.id;
const base = `/v1/accounts/${accountId}`;
await pool.query(
  'update public.accounts set opening_balance_ledger_enabled=true, scheduled_move_out_enabled=true where id=$1',
  [accountId],
);
async function request(method: string, path: string, body?: unknown, key?: string) {
  return api(method, base + path, {
    token: auth.session.access_token,
    body,
    ...(key ? { idempotencyKey: key } : {}),
  });
}

const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;
const nextMonth = new Date(`${monthStart}T12:00:00Z`);
nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
const moveOutOn = new Date(nextMonth);
moveOutOn.setUTCDate(10);
const lastDay = moveOutOn.toISOString().slice(0, 10);
const leaseStart = new Date(`${monthStart}T12:00:00Z`);
leaseStart.setUTCMonth(leaseStart.getUTCMonth() - 2);
const start = leaseStart.toISOString().slice(0, 10);

const property = await request('POST', '/properties', { name: 'Field Log Phase 0' });
assert(property.status === 201, JSON.stringify(property.body));

// One committed setup per call: a starting balance owed (> 0) or held as credit (< 0).
async function setupTenancy(openingCents: number): Promise<string> {
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
  const setup = {
    people: [{ key: crypto.randomUUID(), full_name: 'Sean Example', phones: [], emails: [] }],
    tenancy: { start_date: start, end_date: null },
    agreement: {
      id: crypto.randomUUID(),
      change_kind: 'new',
      term_start: start,
      term_end: null,
      rent_amount_cents: 147500,
      rent_currency: 'USD',
      deposit_amount_cents: 0,
      deposit_currency: 'USD',
      rent_due_rule: { kind: 'day_of_month', day: 1 },
      grace_days: 0,
      late_fee_policy: { kind: 'none' },
      deposit_knowledge: 'unknown',
      terms_source: { kind: 'manual' },
    },
    billing: {
      rent: {
        decision: 'configure',
        coverage_start: monthStart,
        regular_anchor: monthStart,
        due_day: 1,
        billing_due_rule: { kind: 'day_of_month', day: 1 },
        short_month_policy: 'last_day',
        amount_cents: 147500,
        currency: 'USD',
        grace_days: 0,
        late_fee_policy: { kind: 'none' },
        history_mode: 'opening_balance',
        charge_keys: [],
        opening_balance: {
          amount_cents: openingCents,
          basis: 'Rent',
          ...(openingCents > 0 ? { includes_current_rent: true } : {}),
        },
      },
      deposit: { decision: 'defer' },
      payments: [],
      credit_allocations: [],
      explanations: [],
    },
    receipt_purposes: {},
    warning_notes: {},
  };
  const review = await request('POST', `/tenancy-setup-sessions/${id}/preview`, setup);
  assert(review.status === 200, JSON.stringify(review.body));
  const committed = await request(
    'POST',
    `/tenancy-setup-sessions/${id}/commit`,
    {
      setup,
      expected_context: (review.body as { setup_context: string }).setup_context,
      accept_warnings: true,
    },
    crypto.randomUUID(),
  );
  assert(committed.status === 201, JSON.stringify(committed.body));
  return (committed.body as { tenancy_id: string }).tenancy_id;
}

interface Ledger {
  entries: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  adoption: { recorded_in_ledger?: boolean } | null;
}
interface RollupRow {
  tenancy_id: string;
  rent_balance_cents: number;
  unapplied_credit_cents: number;
  non_deposit_overdue_cents: number;
  opening_owed_cents?: number;
}
async function rollupRow(tenancyId: string): Promise<RollupRow> {
  const rollup = await request('GET', `/rent-rollup`);
  assert(rollup.status === 200, JSON.stringify(rollup.body));
  const row = (rollup.body as { data: RollupRow[] }).data.find((r) => r.tenancy_id === tenancyId);
  assert(row !== undefined, 'tenancy missing from rent roll');
  return row!;
}

const owed = await setupTenancy(65000);
const credit = await setupTenancy(-65000);

await check('ledger and rent roll count a starting balance as owed but not overdue', async () => {
  const ledger = await request('GET', `/tenancies/${owed}/ledger`);
  assert(ledger.status === 200, JSON.stringify(ledger.body));
  const body = ledger.body as Ledger;
  const opening = body.entries.find((e) => e.type === 'opening_balance');
  assert(
    opening?.source === 'landlord_statement' && opening.amount_cents === 65000,
    JSON.stringify(opening),
  );
  assert(body.totals.rent_balance_cents === 65000, JSON.stringify(body.totals));
  assert(body.adoption?.recorded_in_ledger === true, JSON.stringify(body.adoption));
  const row = await rollupRow(owed);
  assert(
    row.rent_balance_cents === 65000 &&
      row.opening_owed_cents === 65000 &&
      row.non_deposit_overdue_cents === 0,
    JSON.stringify(row),
  );
});

await check('a starting credit is available without counting as cash received', async () => {
  const ledger = await request('GET', `/tenancies/${credit}/ledger`);
  assert(ledger.status === 200, JSON.stringify(ledger.body));
  const body = ledger.body as Ledger;
  const entry = body.entries.find((e) => e.entry_source === 'opening_credit');
  assert(entry?.method === null && entry.occurred_at === null, JSON.stringify(entry));
  assert(
    body.totals.total_received_cents === 0 &&
      body.totals.opening_credit_cents === 65000 &&
      body.totals.unapplied_credit_cents === 65000,
    JSON.stringify(body.totals),
  );
  const row = await rollupRow(credit);
  assert(row.unapplied_credit_cents === 65000 && row.rent_balance_cents === 0, JSON.stringify(row));
});

// pdfkit writes text as hex strings inside TJ arrays; join each array's pieces.
function pdfText(pdf: Uint8Array): string {
  const source = Buffer.from(pdf).toString('latin1');
  const lines: string[] = [];
  for (const array of source.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    lines.push(
      [...array[1]!.matchAll(/<([0-9a-fA-F]+)>/g)]
        .map((hex) => Buffer.from(hex[1]!, 'hex').toString('latin1'))
        .join(''),
    );
  }
  return lines.join('\n');
}

await check('the statement PDF marks the starting balance entered at setup', async () => {
  const scope = { accountId, tenancyId: owed, exporter: null };
  const data = await loadExportData(scope);
  const pdf = await renderExportPdf({
    scope,
    generatedAt: new Date(),
    chain: { ok: true, message: 'verified', broken_at: null, broken_event_no: null },
    data,
  });
  const text = pdfText(pdf);
  assert(text.includes('(entered at setup)'), 'PDF does not label the starting balance');
  assert(
    !text.includes('from landlord statement; no itemized transactions'),
    'PDF still shows the separate statement path',
  );
});

await check('a late fee cannot be parented on a starting balance', async () => {
  const ledger = await request('GET', `/tenancies/${owed}/ledger`);
  const opening = (ledger.body as Ledger).entries.find((e) => e.type === 'opening_balance');
  const fee = await request(
    'POST',
    '/charges',
    {
      tenancy_id: owed,
      type: 'late_fee',
      amount_cents: 7500,
      currency: 'USD',
      due_date: today,
      parent_charge_id: opening?.id,
    },
    crypto.randomUUID(),
  );
  assert(fee.status === 400, JSON.stringify(fee.body));
});

await check('cancel move-out restores the tenancy and refuses a stale cancel', async () => {
  const scheduled = await request(
    'POST',
    `/tenancies/${owed}/end`,
    { kind: 'ended', effective_date: lastDay, initiated_by: 'tenant', reason_code: 'notice' },
    crypto.randomUUID(),
  );
  assert(scheduled.status === 200, JSON.stringify(scheduled.body));
  const result = scheduled.body as {
    tenancy: { move_out_on: string; status: string };
    ending: null;
  };
  assert(
    result.tenancy.move_out_on === lastDay &&
      result.tenancy.status === 'active' &&
      result.ending === null,
    JSON.stringify(result),
  );
  const ending = await request('GET', `/tenancies/${owed}/ending`);
  assert(ending.status === 404, JSON.stringify(ending.body));
  const cancelled = await request(
    'POST',
    `/tenancies/${owed}/move-out/cancel`,
    { expected_move_out_on: lastDay },
    crypto.randomUUID(),
  );
  assert(cancelled.status === 200, JSON.stringify(cancelled.body));
  assert(
    (cancelled.body as { move_out_on: string | null }).move_out_on === null,
    JSON.stringify(cancelled.body),
  );
  const stale = await request(
    'POST',
    `/tenancies/${owed}/move-out/cancel`,
    { expected_move_out_on: lastDay },
    crypto.randomUUID(),
  );
  assert(
    stale.status === 409 &&
      (stale.body as { error: { code: string } }).error.code === 'move_out_changed',
    JSON.stringify(stale.body),
  );
});

await check('after the last day the ending is derived and intake links stop working', async () => {
  const scheduled = await request(
    'POST',
    `/tenancies/${owed}/end`,
    {
      kind: 'ended',
      effective_date: lastDay,
      initiated_by: 'tenant',
      reason_code: 'notice',
      reason_note: 'Moving out of state',
    },
    crypto.randomUUID(),
  );
  assert(scheduled.status === 200, JSON.stringify(scheduled.body));
  const minted = await request('POST', `/tenancies/${owed}/intake-tokens`);
  assert(minted.status === 201, JSON.stringify(minted.body));
  const secret = (minted.body as { secret: string }).secret;
  const area = await pool.query<{ area_id: string }>(
    'select area_id from public.tenancies where id=$1',
    [owed],
  );

  // Simulate the calendar passing the last day: only the date command role may move it.
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: auth.user.id, role: 'authenticated' }),
    ]);
    await client.query('set local role tenancy_date_writer');
    await client.query(
      'update public.tenancies set move_out_on = public._account_date(account_id) - 1 where id = $1',
      [owed],
    );
    await client.query('commit');
  } finally {
    client.release();
  }

  const tenancy = await request('GET', `/tenancies/${owed}`);
  assert(
    tenancy.status === 200 && (tenancy.body as { status: string }).status === 'ended',
    JSON.stringify(tenancy.body),
  );
  const ending = await request('GET', `/tenancies/${owed}/ending`);
  assert(ending.status === 200, JSON.stringify(ending.body));
  const derived = ending.body as Record<string, unknown>;
  assert(
    derived.source === 'scheduled_move_out' &&
      derived.id === null &&
      derived.reason_code === 'notice' &&
      derived.reason_note === 'Moving out of state' &&
      derived.created_by === auth.user.id,
    JSON.stringify(derived),
  );
  const submitted = await api('POST', `/v1/intake/${secret}`, {
    body: { area_id: area.rows[0]!.area_id, title: 'leak', severity: 'routine' },
  });
  assert(submitted.status === 404, JSON.stringify(submitted.body));
  const again = await request('POST', `/tenancies/${owed}/intake-tokens`);
  assert(again.status === 409, JSON.stringify(again.body));
});

await pool.end();
if (failures.length) {
  console.error(failures);
  process.exit(1);
}
console.info('OK: Field Log Phase 0 ledger, statement export, move-out and intake checks.');
