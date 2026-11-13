import {
  assert,
  configureIntegrationEnv,
  createApiClient,
  createCheckHarness,
  randomToken,
} from './helpers/integration';
configureIntegrationEnv('8814');
const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');
const api = createApiClient(buildApp());
const { check, failures } = createCheckHarness();

const signup = await api('POST', '/v1/auth/signup', {
  body: {
    email: `phase-four-${randomToken()}@example.test`,
    password: `test-${randomToken()}`,
    account_name: 'Field Log Phase 4',
    time_zone: 'America/Los_Angeles',
  },
});
assert(signup.status === 200, JSON.stringify(signup.body));
const auth = signup.body as { account: { id: string }; session: { access_token: string } };
const base = `/v1/accounts/${auth.account.id}`;
async function request(method: string, path: string, body?: unknown) {
  return api(method, base + path, { token: auth.session.access_token, body });
}
const property = await request('POST', '/properties', {
  name: '418 Juniper Avenue',
  address: {
    line1: '418 Juniper Avenue',
    city: 'Reedsport',
    state: 'Oregon',
    zip: '97467',
    provider_id: 'place.418',
  },
});
assert(property.status === 201, JSON.stringify(property.body));

const today = new Date().toISOString().slice(0, 10);
const lastMonth = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
const start = lastMonth.toISOString().slice(0, 10);

// Two people on a lease that started last month, $1,850 due on the 1st, 5 days' grace, $75 fee.
async function tenancy(people: number): Promise<{ tenancyId: string; personIds: string[] }> {
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
    payload: {},
  });
  assert(saved.status === 200, JSON.stringify(saved.body));
  const keys = Array.from({ length: people }, () => crypto.randomUUID());
  const setup = {
    people: keys.map((key, i) => ({
      key,
      full_name: ['Marcus Oyelaran', 'Priya Nair'][i]!,
      phones: [],
      emails: [],
    })),
    tenancy: { start_date: start, end_date: null },
    agreement: {
      id: crypto.randomUUID(),
      change_kind: 'new',
      term_start: start,
      term_end: null,
      rent_amount_cents: 185000,
      rent_currency: 'USD',
      deposit_amount_cents: 0,
      deposit_currency: 'USD',
      rent_due_rule: { kind: 'day_of_month', day: 1 },
      grace_days: 5,
      late_fee_policy: { kind: 'fixed', amount_cents: 7500, currency: 'USD' },
      deposit_knowledge: 'unknown',
      terms_source: { kind: 'manual' },
    },
    billing: {
      rent: {
        decision: 'configure',
        coverage_start: start,
        regular_anchor: start,
        due_day: 1,
        amount_cents: 1,
        currency: 'USD',
        history_mode: 'itemized',
        charge_keys: [],
        follows_lease: true,
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
  const committed = await request('POST', `/tenancy-setup-sessions/${id}/commit`, {
    setup,
    expected_context: (review.body as { setup_context: string }).setup_context,
    accept_warnings: true,
  });
  assert(committed.status === 201, JSON.stringify(committed.body));
  return { tenancyId: (committed.body as { tenancy_id: string }).tenancy_id, personIds: keys };
}

const pair = await tenancy(2);
const single = await tenancy(1);

await check('one owed summary with the type split, overdue and the next charge', async () => {
  const result = await request('GET', `/owed-summaries?tenancy_id=${pair.tenancyId}`);
  assert(result.status === 200, JSON.stringify(result.body));
  const row = (result.body as { data: Array<Record<string, unknown>> }).data[0]!;
  assert(
    row.total_cents === 370000 &&
      JSON.stringify(row.by_type) === '[{"type":"rent","cents":370000}]' &&
      row.oldest_due_on === start &&
      row.rent_tracked === true &&
      (row.next_charge as { source: string; cents: number }).cents === 185000,
    JSON.stringify(row),
  );
});

await check('late fees are suggested past grace, added or skipped once', async () => {
  const listed = await request('GET', `/late-fee-suggestions?tenancy_id=${pair.tenancyId}`);
  const rows = (
    listed.body as {
      data: Array<{
        charge_id: string;
        due_date: string;
        eligible_on: string;
        fee: { amount_cents: number };
      }>;
    }
  ).data;
  const first = rows.find((r) => r.due_date === start);
  assert(listed.status === 200 && first?.fee.amount_cents === 7500, JSON.stringify(listed.body));
  const added = await request('POST', '/charges', {
    tenancy_id: pair.tenancyId,
    type: 'late_fee',
    amount_cents: 7500,
    currency: 'USD',
    due_date: first!.eligible_on,
    parent_charge_id: first!.charge_id,
  });
  assert(added.status === 201, JSON.stringify(added.body));
  for (const row of rows.filter((r) => r.charge_id !== first!.charge_id)) {
    const skipped = await request('POST', `/charges/${row.charge_id}/late-fee-decision`, {
      decision: 'skipped',
    });
    assert(skipped.status === 200, JSON.stringify(skipped.body));
  }
  const after = await request('GET', `/late-fee-suggestions?tenancy_id=${pair.tenancyId}`);
  assert((after.body as { data: unknown[] }).data.length === 0, JSON.stringify(after.body));
  const owed = await request('GET', `/owed-summaries?tenancy_id=${pair.tenancyId}`);
  const row = (owed.body as { data: Array<{ by_type: Array<{ type: string; cents: number }> }> })
    .data[0]!;
  assert(
    row.by_type.some((t) => t.type === 'late_fee' && t.cents === 7500),
    JSON.stringify(row),
  );
});

await check('payments name the payer only when known and the ledger splits the month', async () => {
  const pay = (tenancyId: string, extra: Record<string, unknown>) =>
    request('POST', '/payments', {
      tenancy_id: tenancyId,
      amount_cents: 70000,
      currency: 'USD',
      received_at: `${today}T12:00:00Z`,
      method: 'zelle_venmo',
      ...extra,
    });
  const stranger = await pay(pair.tenancyId, { payer_tenant_id: single.personIds[0] });
  assert(stranger.status === 400, JSON.stringify(stranger.body));
  assert((await pay(pair.tenancyId, {})).status === 201, 'unattributed payment failed');
  assert(
    (await pay(pair.tenancyId, { payer_tenant_id: pair.personIds[1] })).status === 201,
    'Priya payment failed',
  );
  const ledger = await request('GET', `/tenancies/${pair.tenancyId}/ledger`);
  const body = ledger.body as {
    entries: Array<{ kind: string; payer_name?: string | null }>;
    payer_splits: Array<{
      payers: Array<{ full_name: string; amount_cents: number }>;
      unattributed_cents: number;
    }>;
  };
  const names = body.entries.filter((e) => e.kind === 'payment').map((e) => e.payer_name ?? null);
  assert(names.includes(null) && names.includes('Priya Nair'), JSON.stringify(names));
  assert(
    body.payer_splits[0]?.payers[0]?.full_name === 'Priya Nair' &&
      body.payer_splits[0]?.unattributed_cents === 70000,
    JSON.stringify(body.payer_splits),
  );
  assert((await pay(single.tenancyId, {})).status === 201, 'single payment failed');
  const singleLedger = await request('GET', `/tenancies/${single.tenancyId}/ledger`);
  const entry = (
    singleLedger.body as { entries: Array<{ kind: string; payer_name?: string | null }> }
  ).entries.find((e) => e.kind === 'payment');
  assert(entry?.payer_name === 'Marcus Oyelaran', JSON.stringify(entry));
});

await check('the account currency and duplicate properties are readable', async () => {
  const settings = await request('GET', '/settings');
  const s = settings.body as { currency: string; multi_currency: boolean };
  assert(s.currency === 'USD' && s.multi_currency === false, JSON.stringify(settings.body));
  const bad = await request('PATCH', '/settings', { currency: 'DOL' });
  assert(bad.status === 400, JSON.stringify(bad.body));
  const dup = await request(
    'GET',
    `/properties/duplicates?address=${encodeURIComponent('418 juniper ave')}`,
  );
  const matches = (
    dup.body as { data: Array<{ property_id: string; matched_on: string; door_count: number }> }
  ).data;
  assert(
    dup.status === 200 &&
      matches[0]?.property_id === (property.body as { id: string }).id &&
      matches[0]?.door_count === 2,
    JSON.stringify(dup.body),
  );
  const byPlace = await request('GET', '/properties/duplicates?provider_id=place.418');
  assert(
    (byPlace.body as { data: Array<{ matched_on: string }> }).data[0]?.matched_on === 'provider_id',
    JSON.stringify(byPlace.body),
  );
  const read = await request('GET', `/properties/${(property.body as { id: string }).id}`);
  assert(
    (read.body as { address: { city: string; provider_id: string } }).address.city === 'Reedsport',
    JSON.stringify(read.body),
  );
});

await check('a future rent change on the landlord statement warns and adds a step', async () => {
  const month = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
  month.setUTCMonth(month.getUTCMonth() + 2);
  const effective = month.toISOString().slice(0, 7);
  const body = {
    rent_change: {
      basis: { kind: 'landlord_statement', note: 'Told both tenants in writing' },
      effective_month: effective,
      amount_cents: 195000,
    },
  };
  const review = await request(
    'POST',
    `/tenancies/${single.tenancyId}/billing-transition/preview`,
    body,
  );
  assert(review.status === 200, JSON.stringify(review.body));
  const r = review.body as {
    can_commit: boolean;
    context_fingerprint: string;
    findings: Array<{
      rule_id: string;
      confirmation_required?: boolean;
      relationship_fingerprint?: string;
    }>;
  };
  const warning = r.findings.find((f) => f.rule_id === 'rent_change_undocumented');
  assert(warning?.confirmation_required === true && !r.can_commit, JSON.stringify(r.findings));
  const acknowledged = {
    ...body,
    warning_acknowledgements: r.findings
      .filter((f) => f.confirmation_required)
      .map((f) => ({ relationship_fingerprint: f.relationship_fingerprint })),
  };
  const again = await request(
    'POST',
    `/tenancies/${single.tenancyId}/billing-transition/preview`,
    acknowledged,
  );
  const a = again.body as { can_commit: boolean; context_fingerprint: string };
  assert(again.status === 200 && a.can_commit, JSON.stringify(again.body));
  const committed = await request(
    'POST',
    `/tenancies/${single.tenancyId}/billing-transition/commit`,
    {
      ...acknowledged,
      expected_context: a.context_fingerprint,
    },
  );
  assert(committed.status === 201, JSON.stringify(committed.body));
  const schedule = (committed.body as { rent_schedule: Record<string, unknown> }).rent_schedule;
  assert(
    schedule.basis_kind === 'landlord_statement' &&
      schedule.basis_note === 'Told both tenants in writing' &&
      schedule.follows_lease === false &&
      schedule.amount_cents === 195000 &&
      schedule.start_date === `${effective}-01`,
    JSON.stringify(schedule),
  );
  const current = await request('POST', `/tenancies/${pair.tenancyId}/billing-transition/preview`, {
    rent_change: { ...body.rent_change, effective_month: today.slice(0, 7) },
  });
  assert(current.status === 400, JSON.stringify(current.body));
});

if (failures.length) {
  console.error(failures);
  process.exit(1);
}
console.info(
  'OK: owed summary, late-fee suggestions, payer attribution, account currency and duplicate properties.',
);
