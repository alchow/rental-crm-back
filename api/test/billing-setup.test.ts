import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import {
  assert,
  configureIntegrationEnv,
  createApiClient,
  createCheckHarness,
  randomToken,
} from './helpers/integration';
const localStack = configureIntegrationEnv('8798');
const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { getAdminClient, _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');
const api = createApiClient(buildApp());
const admin = getAdminClient();
const { failures, check } = createCheckHarness();
const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;
const nextMonth = new Date(`${monthStart}T12:00:00Z`);
nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
const futureStart = nextMonth.toISOString().slice(0, 10);
const futureEndDate = new Date(nextMonth);
futureEndDate.setUTCMonth(futureEndDate.getUTCMonth() + 1);
futureEndDate.setUTCDate(0);
const futureEnd = futureEndDate.toISOString().slice(0, 10);
const uuid = () => crypto.randomUUID();
const signup = await api('POST', '/v1/auth/signup', {
  body: {
    email: `billing-${randomToken()}@example.test`,
    password: `horse-${randomToken()}`,
    account_name: 'Billing tests',
  },
});
assert(signup.status === 200, `signup ${JSON.stringify(signup.body)}`);
const auth = signup.body as { account: { id: string }; session: { access_token: string } };
const base = `/v1/accounts/${auth.account.id}`;
const token = auth.session.access_token;
const caller = createClient(localStack.API_URL, localStack.ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${token}` } },
  auth: { persistSession: false },
});
async function post(path: string, body: unknown, key?: string) {
  return api('POST', base + path, { token, body, ...(key ? { idempotencyKey: key } : {}) });
}
async function created(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await post(path, body);
  assert(response.status === 201, `${path}: ${JSON.stringify(response.body)}`);
  return response.body as Record<string, unknown>;
}
const property = await created('/properties', { name: 'Billing property' });
async function tenancy(start = futureStart, end?: string): Promise<string> {
  const unit = await created('/areas', { property_id: property.id, kind: 'unit', name: uuid() });
  return (
    await created('/tenancies', {
      area_id: unit.id,
      start_date: start,
      start_date_basis: 'possession_entitlement',
      status: 'upcoming',
      ...(end ? { end_date: end } : {}),
    })
  ).id as string;
}
function intent(start = futureStart): Record<string, unknown> {
  return {
    rent: {
      decision: 'configure',
      coverage_start: start,
      regular_anchor: start,
      due_day: 5,
      amount_cents: 220000,
      currency: 'USD',
      manual_basis: 'Confirmed monthly billing',
      history_mode: 'itemized',
      period_overrides: [],
      charge_keys: [],
    },
    deposit: { decision: 'defer' },
    payments: [],
    credit_allocations: [],
    explanations: [],
  };
}
async function preview(id: string, body: unknown) {
  const response = await post(`/tenancies/${id}/billing-setup/preview`, body);
  assert(response.status === 200, `preview ${response.status} ${JSON.stringify(response.body)}`);
  return response.body as Record<string, unknown>;
}
async function commit(id: string, body: Record<string, unknown>, context: string, key?: string) {
  return post(`/tenancies/${id}/billing-setup/commit`, { ...body, expected_context: context }, key);
}
async function moneyCount(id: string): Promise<number> {
  const rows = await Promise.all(
    ['rent_schedules', 'charges', 'payments'].map((table) =>
      admin
        .from(table as 'charges')
        .select('id', { count: 'exact' })
        .eq('account_id', auth.account.id)
        .eq('tenancy_id', id),
    ),
  );
  return rows.reduce((sum, r) => sum + (r.count ?? 0), 0);
}

await check(
  'saving confirmed lease terms writes no financial facts and retains unknown distinct from none',
  async () => {
    const id = await tenancy();
    const lease = await created('/leases', {
      tenancy_id: id,
      term_start: futureStart,
      rent_amount_cents: 220000,
      rent_currency: 'USD',
      deposit_amount_cents: 440000,
      deposit_currency: 'USD',
      deposit_knowledge: 'amount',
      status: 'active',
      rent_due_rule: { kind: 'day_of_month', day: 1 },
      grace_days: 5,
      late_fee_policy: { kind: 'fixed', amount_cents: 5000, currency: 'USD' },
      terms_source: { kind: 'manual' },
    });
    assert((await moneyCount(id)) === 0, 'lease save unexpectedly billed');
    assert(
      (lease.late_fee_policy as { amount_cents: number }).amount_cents === 5000,
      'policy lost',
    );
    const changed = await api('PATCH', `${base}/leases/${lease.id}`, {
      token,
      body: { grace_days: 0 },
    });
    assert(changed.status === 409, 'executed terms were editable');
    const unknown = await created('/leases', {
      tenancy_id: id,
      term_start: futureStart,
      rent_amount_cents: 1,
      rent_currency: 'USD',
      status: 'draft',
    });
    assert(
      unknown.grace_days === null &&
        (unknown.late_fee_policy as { kind: string }).kind === 'unknown',
      'invented missing terms',
    );
  },
);
await check(
  'coverage and due date are distinct, preview is read only, retry returns original IDs',
  async () => {
    const id = await tenancy();
    const body = intent();
    (body.rent as Record<string, unknown>).charge_keys = [
      { cycle_key: futureStart.slice(0, 7), draft_key: 'rent_future' },
    ];
    const reviewed = await preview(id, body);
    assert(reviewed.can_commit === true, 'future setup blocked');
    assert((await moneyCount(id)) === 0, 'preview wrote money');
    const candidate = (reviewed.charge_candidates as Record<string, unknown>[])[0]!;
    assert(
      candidate.period_start === futureStart && candidate.period_end === futureEnd,
      'wrong coverage',
    );
    assert(candidate.due_date === `${futureStart.slice(0, 7)}-05`, 'due date copied from coverage');
    const key = `billing-${uuid()}`;
    const saved = await commit(id, body, reviewed.context_fingerprint as string, key);
    assert(saved.status === 201, JSON.stringify(saved.body));
    const replay = await commit(id, body, reviewed.context_fingerprint as string, key);
    assert(
      replay.status === 201 && JSON.stringify(replay.body) === JSON.stringify(saved.body),
      'lost response duplicated IDs',
    );
    assert(replay.headers['idempotency-replay'] === 'true', 'retry was not durable replay');
    assert((await moneyCount(id)) === 2, 'retry duplicated money');
  },
);
await check(
  'deposit due and multiple early receipt dates commit as separate facts and currencies',
  async () => {
    const id = await tenancy();
    const body = {
      rent: { decision: 'defer' },
      deposit: {
        decision: 'record',
        draft_key: 'deposit',
        amount_cents: 440000,
        currency: 'USD',
        due_date: futureStart,
      },
      payments: [
        {
          draft_key: 'first',
          amount_cents: 100000,
          currency: 'USD',
          received_at: `${today}T00:00:00Z`,
          method: 'cash',
          allocations: [{ charge_key: 'deposit', amount_cents: 100000 }],
        },
        {
          draft_key: 'second',
          amount_cents: 340000,
          currency: 'USD',
          received_at: `${today}T00:00:00Z`,
          method: 'ach',
          allocations: [{ charge_key: 'deposit', amount_cents: 340000 }],
        },
      ],
    };
    const reviewed = await preview(id, body);
    const saved = await commit(id, body, reviewed.context_fingerprint as string);
    assert(saved.status === 201, JSON.stringify(saved.body));
    assert((await moneyCount(id)) === 3, 'one deposit/two receipts not preserved');
    const result = saved.body as {
      charge_ids: Record<string, string>;
      payment_ids: Record<string, string>;
      allocation_ids: string[];
    };
    const charge = await admin
      .from('charges')
      .select('*')
      .eq('id', result.charge_ids.deposit!)
      .single();
    assert(charge.data?.due_date === futureStart, 'deposit due date became receipt date');
    assert(result.allocation_ids.length === 2, 'partial allocations lost');
  },
);
await check(
  'unknown deposit due records unallocated receipt without inventing a charge',
  async () => {
    const id = await tenancy();
    const body = {
      rent: { decision: 'defer' },
      deposit: { decision: 'defer' },
      payments: [
        {
          draft_key: 'held',
          amount_cents: 100,
          currency: 'EUR',
          received_at: `${today}T00:00:00Z`,
          method: 'other',
          allocations: [],
        },
      ],
    };
    const reviewed = await preview(id, body);
    const saved = await commit(id, body, reviewed.context_fingerprint as string);
    assert(saved.status === 201 && (await moneyCount(id)) === 1, JSON.stringify(saved.body));
  },
);
await check(
  'deposit-only date warnings accept an explicit confirmation without a note or justification',
  async () => {
    const planned = await tenancy(futureStart, futureStart);
    const ended = await tenancy(monthStart);
    const ending = await post(`/tenancies/${ended}/end`, { kind: 'ended', effective_date: today });
    assert(ending.status === 200, JSON.stringify(ending.body));
    for (const id of [planned, ended]) {
      const body: Record<string, unknown> = {
        rent: { decision: 'defer' },
        deposit: {
          decision: 'record',
          draft_key: 'deposit',
          amount_cents: 100,
          currency: 'USD',
          due_date: futureEnd,
        },
        payments: [],
        credit_allocations: [],
        explanations: [],
      };
      const blocked = await preview(id, body);
      const findings = blocked.findings as { rule_id: string; relationship_fingerprint: string }[];
      assert(
        blocked.can_commit === false &&
          findings.length === 1 &&
          findings.some((f) => f.rule_id === 'deposit_due_after_possession_end'),
        'deposit-only missing end-date review',
      );
      const refused = await commit(id, body, blocked.context_fingerprint as string);
      assert(
        refused.status === 400 && (await moneyCount(id)) === 0,
        'unconfirmed deposit committed',
      );
      body.warning_acknowledgements = findings.map((f) => ({
        relationship_fingerprint: f.relationship_fingerprint,
      }));
      const ready = await preview(id, body);
      assert(ready.can_commit === true, 'deposit confirmation did not resolve review');
      const saved = await commit(id, body, ready.context_fingerprint as string);
      assert(saved.status === 201, JSON.stringify(saved.body));
      const records = await admin
        .from('tenancy_date_records')
        .select('context_snapshot,reason_note,relationship_snapshots')
        .eq('tenancy_id', id)
        .eq('kind', 'warning_confirmation');
      const snapshot = (
        records.data?.[0]?.relationship_snapshots as { relationship_fingerprint: string }[]
      )?.[0];
      assert(
        records.data?.length === 1 &&
          records.data[0]?.reason_note === null &&
          snapshot?.relationship_fingerprint ===
            findings.find((f) => f.rule_id === 'deposit_due_after_possession_end')
              ?.relationship_fingerprint,
        'verified deposit confirmation snapshot lost',
      );
      const context = await api('GET', `${base}/tenancies/${id}/date-context`, { token });
      assert(context.status === 200, JSON.stringify(context.body));
      const finding = (
        context.body as { findings: { rule_id: string; explained: boolean; confirmed: boolean }[] }
      ).findings.find((f) => f.rule_id === 'deposit_due_after_possession_end');
      assert(
        finding?.explained === false,
        'a confirmation without a note was mislabeled as a justification',
      );
      assert(
        finding?.confirmed === true,
        'the saved deposit date immediately expired its confirmation',
      );
      const noop = await preview(id, {
        rent: { decision: 'defer' },
        deposit: { decision: 'keep' },
        payments: [],
        credit_allocations: [],
        explanations: [],
      });
      assert(
        (noop.findings as unknown[]).length === 0,
        'pure defer/keep asked for unrelated date explanations',
      );
    }
  },
);
await check(
  'existing deposit can precede rent setup without a second adoption or deposit',
  async () => {
    const id = await tenancy();
    await created('/charges', {
      tenancy_id: id,
      type: 'deposit',
      amount_cents: 100,
      currency: 'USD',
      due_date: futureStart,
    });
    const body = intent();
    body.deposit = { decision: 'keep' };
    const reviewed = await preview(id, body);
    assert(reviewed.mode === 'initial_rent_existing_money', 'server misclassified deposit history');
    const saved = await commit(id, body, reviewed.context_fingerprint as string);
    assert(saved.status === 201, JSON.stringify(saved.body));
    assert((await moneyCount(id)) === 2, 'deposit duplicated');
    const again = await post(`/tenancies/${id}/billing-setup/preview`, body);
    assert(again.status === 409, 'existing rent was re-adoptable');
  },
);
await check(
  'same month history needs review and partial intervals need explicit amount or concession',
  async () => {
    const id = await tenancy(monthStart);
    const body = intent(monthStart);
    const reviewed = await preview(id, body);
    assert(
      (reviewed.history_periods as unknown[]).length === 1 && reviewed.can_commit === false,
      'current elapsed period omitted',
    );
    const partialStart = `${futureStart.slice(0, 7)}-15`;
    const partial = intent(partialStart);
    const anchor = new Date(`${futureStart}T12:00:00Z`);
    anchor.setUTCMonth(anchor.getUTCMonth() + 1);
    (partial.rent as Record<string, unknown>).regular_anchor = anchor.toISOString().slice(0, 10);
    const incomplete = await preview(await tenancy(partialStart), partial);
    assert(incomplete.can_commit === false, 'partial charged at full rent without confirmation');
    const partialId = await tenancy(partialStart);
    (partial.rent as Record<string, unknown>).period_overrides = [
      {
        cycle_key: futureStart.slice(0, 7),
        period_start: partialStart,
        period_end: futureEnd,
        due_date: partialStart,
        amount_cents: 0,
        reason: 'Agreed first-period concession',
      },
    ];
    const ready = await preview(partialId, partial);
    assert(ready.can_commit === true, 'concession did not resolve partial');
    const saved = await commit(partialId, partial, ready.context_fingerprint as string);
    assert(saved.status === 201, JSON.stringify(saved.body));
    const result = saved.body as { schedule_id: string };
    await admin.from('accounts').update({ auto_charge_enabled: true }).eq('id', auth.account.id);
    const generated = await admin.rpc('generate_rent_charges', {
      p_account_id: auth.account.id,
      p_as_of: `${partialStart}T00:00:00Z`,
    });
    assert(!generated.error, generated.error?.message ?? 'generator error');
    assert(
      !generated.data?.some((row) => row.o_schedule_id === result.schedule_id),
      'concession revived as a full regular bill',
    );
  },
);
await check('stale context and mixed currency allocation write nothing', async () => {
  const id = await tenancy();
  const body = intent();
  const reviewed = await preview(id, body);
  await created('/payments', {
    tenancy_id: id,
    amount_cents: 100,
    currency: 'USD',
    received_at: `${today}T00:00:00Z`,
    method: 'cash',
  });
  const stale = await commit(id, body, reviewed.context_fingerprint as string);
  assert(stale.status === 409 && (await moneyCount(id)) === 1, 'stale context wrote setup');
  const bad = {
    rent: { decision: 'defer' },
    deposit: {
      decision: 'record',
      draft_key: 'deposit',
      amount_cents: 100,
      currency: 'USD',
      due_date: futureStart,
    },
    payments: [
      {
        draft_key: 'eur',
        amount_cents: 100,
        currency: 'EUR',
        received_at: `${today}T00:00:00Z`,
        method: 'cash',
        allocations: [{ charge_key: 'deposit', amount_cents: 100 }],
      },
    ],
  };
  const response = await post(`/tenancies/${id}/billing-setup/preview`, bad);
  assert(
    response.status === 400 && (await moneyCount(id)) === 1,
    'cross-currency allocation accepted',
  );
});
await check(
  'racing setup commits and cron occupy one canonical cycle including voided slots',
  async () => {
    const id = await tenancy();
    const body = intent();
    (body.rent as Record<string, unknown>).charge_keys = [
      { cycle_key: futureStart.slice(0, 7), draft_key: 'rent' },
    ];
    const reviewed = await preview(id, body);
    const outcomes = await Promise.all([
      commit(id, body, reviewed.context_fingerprint as string),
      commit(id, body, reviewed.context_fingerprint as string),
    ]);
    assert(
      outcomes.filter((r) => r.status === 201).length === 1 &&
        outcomes.filter((r) => r.status === 409).length === 1,
      'racing setup was not serialized',
    );
    const saved = outcomes.find((r) => r.status === 201)!.body as {
      charge_ids: Record<string, string>;
      schedule_id: string;
    };
    await admin.from('accounts').update({ auto_charge_enabled: true }).eq('id', auth.account.id);
    await Promise.all([
      admin.rpc('generate_rent_charges', {
        p_account_id: auth.account.id,
        p_as_of: `${futureStart}T00:00:00Z`,
      }),
      admin.rpc('generate_rent_charges', {
        p_account_id: auth.account.id,
        p_as_of: `${futureStart}T00:00:00Z`,
      }),
    ]);
    const charges = await admin
      .from('charges')
      .select('id')
      .eq('source_schedule_id', saved.schedule_id);
    assert(charges.data?.length === 1, 'cron duplicated advanced cycle');
    await post(`/charges/${saved.charge_ids.rent}/void`, {
      void_reason: 'Incorrect recorded charge',
    });
    await admin.rpc('generate_rent_charges', {
      p_account_id: auth.account.id,
      p_as_of: `${futureStart}T00:00:00Z`,
    });
    const after = await admin
      .from('charges')
      .select('id')
      .eq('source_schedule_id', saved.schedule_id);
    assert(after.data?.length === 1, 'voided occupied slot resurrected');
  },
);
await check(
  'a complete successor has explicit unknown policy, preserves old snapshots and never supersedes agreements early',
  async () => {
    const id = await tenancy();
    const first = intent();
    const firstTerms = {
      tenancy_id: id,
      term_start: futureStart,
      rent_amount_cents: 220000,
      rent_currency: 'USD',
      status: 'active',
      rent_due_rule: { kind: 'day_of_month', day: 5 },
      grace_days: 5,
      late_fee_policy: { kind: 'fixed', amount_cents: 5000, currency: 'USD' },
      terms_source: { kind: 'manual' },
    };
    const lease = await created('/leases', firstTerms);
    const later = new Date(`${futureStart}T12:00:00Z`);
    later.setUTCMonth(later.getUTCMonth() + 1);
    const successorStart = later.toISOString().slice(0, 10);
    Object.assign(first.rent as Record<string, unknown>, {
      source_lease_id: lease.id,
      grace_days: 5,
      late_fee_policy: { kind: 'fixed', amount_cents: 5000, currency: 'USD' },
      charge_keys: [
        { cycle_key: futureStart.slice(0, 7), draft_key: 'first' },
        { cycle_key: successorStart.slice(0, 7), draft_key: 'advance' },
      ],
    });
    const review = await preview(id, first);
    assert(review.can_commit === true, JSON.stringify(review.findings));
    const saved = await commit(id, first, review.context_fingerprint as string);
    assert(saved.status === 201, JSON.stringify(saved.body));
    const original = saved.body as { schedule_id: string; charge_ids: Record<string, string> };
    const charge = await admin
      .from('charges')
      .select('*')
      .eq('id', original.charge_ids.first!)
      .single();
    const basis = charge.data?.terms_snapshot as {
      billing: { late_fee_policy: { amount_cents: number } };
    };
    assert(basis.billing.late_fee_policy.amount_cents === 5000, 'initial snapshot missing');
    const corrected = await post(`/leases/${lease.id}/replace`, {
      void_reason: 'Correct recorded fee',
      lease: {
        ...firstTerms,
        late_fee_policy: { kind: 'fixed', amount_cents: 6000, currency: 'USD' },
      },
    });
    assert(corrected.status === 200, JSON.stringify(corrected.body));
    const after = await admin
      .from('charges')
      .select('*')
      .eq('id', original.charge_ids.first!)
      .single();
    assert(
      JSON.stringify(after.data?.terms_snapshot) === JSON.stringify(charge.data?.terms_snapshot),
      'lease correction rewrote old basis',
    );
    const replacement = (corrected.body as { replacement: { id: string } }).replacement;
    const renewal = await created('/leases', {
      tenancy_id: id,
      term_start: successorStart,
      rent_amount_cents: 240000,
      rent_currency: 'USD',
      status: 'active',
      agreement_kind: 'renewal',
      predecessor_lease_id: replacement.id,
      rent_due_rule: { kind: 'day_of_month', day: 10 },
      terms_source: { kind: 'manual' },
    });
    const transition = intent(successorStart);
    transition.deposit = { decision: 'keep' };
    Object.assign(transition.rent as Record<string, unknown>, {
      source_lease_id: renewal.id,
      amount_cents: 240000,
      due_day: 10,
      grace_days: null,
      late_fee_policy: { kind: 'unknown' },
      charge_keys: [{ cycle_key: successorStart.slice(0, 7), draft_key: 'successor' }],
    });
    const reviewed = await post(`/tenancies/${id}/billing-transition/preview`, transition);
    assert(reviewed.status === 200, JSON.stringify(reviewed.body));
    const details = reviewed.body as {
      context_fingerprint: string;
      can_commit: boolean;
      transition: { voided_charge_ids: string[] };
    };
    assert(details.can_commit, 'successor unexpectedly blocked');
    assert(
      details.transition.voided_charge_ids.includes(original.charge_ids.advance!),
      'advance charge omitted from review',
    );
    const result = await post(`/tenancies/${id}/billing-transition/commit`, {
      ...transition,
      expected_context: details.context_fingerprint,
    });
    assert(result.status === 201, JSON.stringify(result.body));
    const newSchedule = await admin
      .from('rent_schedules')
      .select('*')
      .eq('id', (result.body as { schedule_id: string }).schedule_id)
      .single();
    assert(
      newSchedule.data?.grace_days === null && newSchedule.data?.late_fee_cents === null,
      'unknown inherited old policy',
    );
    const oldAgreement = await admin
      .from('leases')
      .select('status')
      .eq('id', replacement.id)
      .single();
    assert(oldAgreement.data?.status === 'active', 'future billing superseded present agreement');
    const bad = intent(`${successorStart.slice(0, 7)}-15`);
    bad.deposit = { decision: 'keep' };
    (bad.rent as Record<string, unknown>).source_lease_id = renewal.id;
    const blocked = await post(`/tenancies/${id}/billing-transition/preview`, bad);
    assert(
      blocked.status === 200 && (blocked.body as { can_commit: boolean }).can_commit === false,
      'mid-cycle transition was silently trimmed',
    );
  },
);
await check(
  'version-3 automation preserves the agreed 31st with an explicit short-month policy',
  async () => {
    const id = await tenancy();
    const lease = await created('/leases', {
      tenancy_id: id,
      term_start: futureStart,
      rent_amount_cents: 220000,
      rent_currency: 'USD',
      status: 'active',
      rent_due_rule: { kind: 'day_of_month', day: 31 },
    });
    const body = intent();
    Object.assign(body.rent as Record<string, unknown>, {
      source_lease_id: lease.id,
      due_day: 31,
      billing_due_rule: { kind: 'day_of_month', day: 31 },
      short_month_policy: 'last_day',
    });
    const reviewed = await post(`/tenancies/${id}/billing-setup/preview`, body);
    assert(
      reviewed.status === 200 &&
        (reviewed.body as { can_commit: boolean }).can_commit &&
        (await moneyCount(id)) === 0,
      'explicit version-3 monthly rule was not previewable',
    );
    assert((lease.rent_due_rule as { day: number }).day === 31, 'agreement due day was clamped');
  },
);
await check(
  'opening balance is testimony, mutually exclusive with receipts and blocked with existing deposit',
  async () => {
    const id = await tenancy();
    const body = intent();
    Object.assign(body.rent as Record<string, unknown>, {
      history_mode: 'opening_balance',
      opening_balance: { amount_cents: 220000, basis: 'Owner confirmed prior arrears' },
    });
    const reviewed = await preview(id, body);
    const saved = await commit(id, body, reviewed.context_fingerprint as string);
    assert(saved.status === 201, JSON.stringify(saved.body));
    assert((await moneyCount(id)) === 1, 'opening balance was turned into a charge');
    const adoption = await admin
      .from('tenancy_adoptions')
      .select('*')
      .eq('tenancy_id', id)
      .single();
    assert(adoption.data?.opening_balance_cents === 220000, 'opening testimony lost');
    const depositId = await tenancy();
    await created('/charges', {
      tenancy_id: depositId,
      type: 'deposit',
      amount_cents: 100,
      currency: 'USD',
      due_date: futureStart,
    });
    const no = await post(`/tenancies/${depositId}/billing-setup/preview`, body);
    assert(no.status === 400, 'existing history allowed opening re-foundation');
  },
);
await check(
  'existing credit is explicitly reused with aggregate caps and no duplicate receipt',
  async () => {
    const id = await tenancy();
    const receipt = await created('/payments', {
      tenancy_id: id,
      amount_cents: 100,
      currency: 'USD',
      received_at: `${today}T00:00:00Z`,
      method: 'cash',
    });
    const receiptId = (receipt.payment as { id: string }).id;
    const body = {
      rent: { decision: 'defer' },
      deposit: {
        decision: 'record',
        draft_key: 'deposit',
        amount_cents: 100,
        currency: 'USD',
        due_date: futureStart,
      },
      payments: [],
      credit_allocations: [
        { payment_id: receiptId, charge_key: 'deposit', amount_cents: 60 },
        { payment_id: receiptId, charge_key: 'deposit', amount_cents: 40 },
      ],
    };
    const reviewed = await preview(id, body);
    const saved = await commit(id, body, reviewed.context_fingerprint as string);
    assert(saved.status === 201 && (await moneyCount(id)) === 2, JSON.stringify(saved.body));
    assert(
      (saved.body as { allocation_ids: string[] }).allocation_ids.length === 2,
      'credit slices lost',
    );
  },
);
await check(
  'rent and deposit currencies persist separately and ledger never sums them',
  async () => {
    const id = await tenancy();
    const body = intent();
    (body.rent as Record<string, unknown>).charge_keys = [
      { cycle_key: futureStart.slice(0, 7), draft_key: 'rent' },
    ];
    body.deposit = {
      decision: 'record',
      draft_key: 'deposit',
      amount_cents: 440000,
      currency: 'EUR',
      due_date: futureStart,
    };
    body.payments = [
      {
        draft_key: 'usd',
        amount_cents: 50000,
        currency: 'USD',
        received_at: today,
        method: 'cash',
        allocations: [{ charge_key: 'rent', amount_cents: 50000 }],
      },
      {
        draft_key: 'eur',
        amount_cents: 100000,
        currency: 'EUR',
        received_at: today,
        method: 'ach',
        allocations: [{ charge_key: 'deposit', amount_cents: 100000 }],
      },
    ];
    const reviewed = await preview(id, body);
    const saved = await commit(id, body, reviewed.context_fingerprint as string);
    assert(saved.status === 201, JSON.stringify(saved.body));
    const ledger = await api('GET', `${base}/tenancies/${id}/ledger?currency=USD`, { token });
    assert(ledger.status === 200, JSON.stringify(ledger.body));
    const result = ledger.body as {
      currency: string;
      entries: { currency: string }[];
      totals: { rent_balance_cents: number; deposit_balance_cents: number };
      available_currencies: string[];
      totals_by_currency: Record<
        string,
        { rent_balance_cents: number; deposit_balance_cents: number }
      >;
    };
    assert(
      result.currency === 'USD' &&
        result.totals.rent_balance_cents === 170000 &&
        result.totals.deposit_balance_cents === 0,
      'selected currency mixed balances',
    );
    assert(
      result.totals_by_currency.EUR?.deposit_balance_cents === 340000 &&
        result.totals_by_currency.USD?.rent_balance_cents === 170000,
      'currency group balances lost',
    );
    assert(
      result.entries.every((entry) => entry.currency === 'USD') &&
        result.available_currencies.includes('EUR'),
      'selected entries crossed currencies',
    );
  },
);
await check(
  'direct callers cannot forge an explanation context or cross account scope',
  async () => {
    const id = await tenancy();
    const forged = await caller.rpc('record_billing_setup_explanations', {
      p_account_id: auth.account.id,
      p_tenancy_id: id,
      p_intent: intent(),
      p_context_fingerprint: 'forged',
      p_request_key: 'forged-billing-request',
      p_request_fingerprint: 'forged',
    });
    assert(forged.error?.message.includes('context changed'), 'forged context accepted');
    const foreign = await caller.rpc('preview_billing_setup', {
      p_account_id: uuid(),
      p_tenancy_id: id,
      p_intent: intent(),
    });
    assert(foreign.error, 'foreign account visible');
    const rows = await admin.from('tenancy_date_records').select('id').eq('tenancy_id', id);
    assert(rows.data?.length === 0, 'forged history committed');
  },
);
await check(
  'calendar coverage uses the same leap-year and month-end calculator independently of due dates',
  async () => {
    const calculated = await admin.rpc('_billing_period', {
      p_rent: {
        coverage_start: '2028-02-01',
        coverage_end: '2028-02-29',
        regular_anchor: '2028-02-01',
        due_day: 5,
        amount_cents: 100,
        currency: 'USD',
        period_overrides: [],
      },
      p_cycle_key: '2028-02',
    });
    assert(!calculated.error, calculated.error?.message ?? 'period failure');
    const period = calculated.data as {
      period_start: string;
      period_end: string;
      due_date: string;
    };
    assert(
      period.period_start === '2028-02-01' &&
        period.period_end === '2028-02-29' &&
        period.due_date === '2028-02-05',
      'leap year calculator differs',
    );
  },
);

await check('already-due rent needs review even when coverage starts in the future', async () => {
  const day = Number(today.slice(8));
  if (day > 1 && day < 28) {
    const start = `${today.slice(0, 7)}-${String(day + 1).padStart(2, '0')}`;
    const id = await tenancy(start);
    const body = intent(start);
    (body.rent as Record<string, unknown>).due_day = 1;
    const blocked = await preview(id, body);
    const history = blocked.history_periods as {
      cycle_key: string;
      due_date: string;
      is_elapsed: boolean;
    }[];
    assert(
      blocked.can_commit === false && history.length === 1 && history[0]?.is_elapsed,
      'future coverage hid the already-due first obligation',
    );
    assert(history[0]!.due_date < today, 'first obligation was not already due');
    const refused = await commit(id, body, blocked.context_fingerprint as string);
    assert(
      refused.status === 400 && (await moneyCount(id)) === 0,
      'unreviewed obligation committed',
    );
    (body.rent as Record<string, unknown>).charge_keys = [
      { cycle_key: history[0]!.cycle_key, draft_key: 'first' },
    ];
    const ready = await preview(id, body);
    const saved = await commit(id, body, ready.context_fingerprint as string);
    assert(saved.status === 201, JSON.stringify(saved.body));
    const result = saved.body as { schedule_id: string; charge_ids: { first: string } };
    const charge = await admin
      .from('charges')
      .select('due_date,period_start')
      .eq('id', result.charge_ids.first)
      .single();
    assert(
      charge.data?.due_date === history[0]!.due_date && charge.data.period_start === start,
      'reviewed obligation lost its independent due and coverage dates',
    );
    const generated = await admin.rpc('generate_rent_charges', {
      p_account_id: auth.account.id,
      p_as_of: new Date().toISOString(),
    });
    assert(!generated.error, generated.error?.message ?? 'generator failed');
    const first = await admin
      .from('charges')
      .select('id')
      .eq('source_schedule_id', result.schedule_id)
      .eq('period_start', start);
    assert(first.data?.length === 1, 'generator duplicated the reviewed first obligation');
  }
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  for (const { offset, dueDate } of [
    { offset: 0, dueDate: yesterday.toISOString().slice(0, 10) },
    { offset: 2, dueDate: yesterday.toISOString().slice(0, 10) },
    { offset: 0, dueDate: today },
  ]) {
    const cycleStart = new Date(nextMonth);
    cycleStart.setUTCMonth(cycleStart.getUTCMonth() + offset);
    const cycleEnd = new Date(cycleStart);
    cycleEnd.setUTCMonth(cycleEnd.getUTCMonth() + 1);
    cycleEnd.setUTCDate(0);
    const start = cycleStart.toISOString().slice(0, 10);
    const id = await tenancy();
    const body = intent();
    (body.rent as Record<string, unknown>).period_overrides = [
      {
        cycle_key: start.slice(0, 7),
        period_start: start,
        period_end: cycleEnd.toISOString().slice(0, 10),
        due_date: dueDate,
        amount_cents: 220000,
        reason: 'The confirmed advance rent obligation was due before this future coverage period',
      },
    ];
    const blocked = await preview(id, body);
    const history = blocked.history_periods as { cycle_key: string; is_elapsed: boolean }[];
    assert(
      blocked.can_commit === false &&
        history.filter((p) => p.cycle_key === start.slice(0, 7) && p.is_elapsed).length === 1,
      'explicit overdue override was omitted or duplicated in review',
    );
    (body.rent as Record<string, unknown>).charge_keys = [
      { cycle_key: start.slice(0, 7), draft_key: 'advance' },
    ];
    const ready = await preview(id, body);
    const saved = await commit(id, body, ready.context_fingerprint as string);
    assert(
      saved.status === 201 &&
        (saved.body as { charge_ids: { advance?: string } }).charge_ids.advance,
      `reviewed advance obligation was not materialized: ${JSON.stringify(saved.body)}`,
    );
  }
});

await check(
  'lease replacement preserves omitted lineage and respects an explicit original reset',
  async () => {
    for (const kind of ['renewal', 'amendment']) {
      const id = await tenancy();
      const terms = {
        tenancy_id: id,
        term_start: futureStart,
        rent_amount_cents: 100,
        rent_currency: 'USD',
        status: 'active',
      };
      const original = await created('/leases', terms);
      const derived = await created('/leases', {
        ...terms,
        agreement_kind: kind,
        predecessor_lease_id: original.id,
      });
      const body = {
        void_reason: 'Correct the recorded agreement',
        lease: { term_start: futureStart, rent_amount_cents: 100, rent_currency: 'USD' },
      };
      const saved = await post(`/leases/${derived.id}/replace`, body);
      assert(saved.status === 200, JSON.stringify(saved.body));
      const replacement = (
        saved.body as {
          replacement: {
            id: string;
            agreement_kind: string;
            predecessor_lease_id: string;
            corrects_lease_id: string;
          };
        }
      ).replacement;
      assert(
        replacement.agreement_kind === kind &&
          replacement.predecessor_lease_id === original.id &&
          replacement.corrects_lease_id === derived.id,
        'omitted lineage changed the replacement agreement relationship',
      );
      const reset = await post(`/leases/${replacement.id}/replace`, {
        ...body,
        lease: { ...body.lease, agreement_kind: 'original', predecessor_lease_id: null },
      });
      assert(reset.status === 200, JSON.stringify(reset.body));
      const resetLease = (
        reset.body as {
          replacement: { agreement_kind: string; predecessor_lease_id: string | null };
        }
      ).replacement;
      assert(
        resetLease.agreement_kind === 'original' && resetLease.predecessor_lease_id === null,
        'explicit null predecessor inherited the old relationship',
      );
    }
  },
);

await check(
  'legacy scheduled charges retain optional coverage dates without weakening version-2 periods',
  async () => {
    const id = await tenancy();
    const schedule = await created('/rent-schedules', {
      tenancy_id: id,
      kind: 'rent',
      amount_cents: 100,
      currency: 'USD',
      due_day: 5,
      start_date: futureStart,
    });
    const body = {
      tenancy_id: id,
      type: 'rent',
      amount_cents: 100,
      currency: 'USD',
      due_date: `${futureStart.slice(0, 7)}-05`,
      source_schedule_id: schedule.id,
    };
    const saved = await created('/charges', body);
    assert(
      saved.period_start === null &&
        saved.period_end === null &&
        saved.cycle_key === `legacy:${body.due_date}`,
      'legacy request invented coverage or lost its canonical cycle',
    );
    const duplicate = await post('/charges', body);
    assert(duplicate.status === 409, 'legacy request bypassed cycle uniqueness');
    const modernId = await tenancy();
    const modernBody = intent();
    const reviewed = await preview(modernId, modernBody);
    const modern = await commit(modernId, modernBody, reviewed.context_fingerprint as string);
    assert(modern.status === 201, JSON.stringify(modern.body));
    const invalid = await caller.from('charges').insert({
      ...body,
      account_id: auth.account.id,
      tenancy_id: modernId,
      source_schedule_id: (modern.body as { schedule_id: string }).schedule_id,
    });
    assert(
      invalid.error?.message.includes('requires both coverage dates'),
      'version-2 charge accepted missing coverage',
    );
  },
);

await check(
  'billing after a possession correction clears stale confirmation without accepting explicit stale reconfirmation',
  async () => {
    const id = await tenancy();
    const path = `${base}/tenancies/${id}/onboarding-progress`;
    const confirmed = await api('PATCH', path, {
      token,
      body: { possession_confirmed_revision: 0, condition_decision: 'deferred' },
    });
    assert(confirmed.status === 200, JSON.stringify(confirmed.body));
    const start = `${futureStart.slice(0, 7)}-02`;
    const changes = { start_date: start };
    const proposed = await post(`/tenancies/${id}/date-corrections/preview`, { changes });
    assert(proposed.status === 200, JSON.stringify(proposed.body));
    const context = proposed.body as {
      current: { date_revision: number };
      proposed: { status: string };
      context_fingerprint: string;
    };
    const corrected = await post(`/tenancies/${id}/date-corrections`, {
      changes,
      expected_date_revision: context.current.date_revision,
      expected_context_fingerprint: context.context_fingerprint,
      expected_resulting_status: context.proposed.status,
      reason_code: 'data_entry_error',
      reason_note: 'Correct the recorded possession day',
    });
    assert(corrected.status === 200, JSON.stringify(corrected.body));
    const stale = await api('PATCH', path, { token, body: { possession_confirmed_revision: 0 } });
    assert(stale.status === 409, 'repeating the stale confirmation was accepted');
    const body = intent(start);
    const reviewed = await preview(id, body);
    const saved = await commit(id, body, reviewed.context_fingerprint as string);
    assert(saved.status === 201, JSON.stringify(saved.body));
    const progress = (
      saved.body as {
        progress: {
          possession_confirmed_revision: number | null;
          condition_decision: string;
          rent_decision: string;
        };
      }
    ).progress;
    assert(
      progress.possession_confirmed_revision === null &&
        progress.condition_decision === 'deferred' &&
        progress.rent_decision === 'configured',
      'billing inherited a stale possession confirmation or erased independent progress',
    );
    const current = await api('PATCH', path, { token, body: { possession_confirmed_revision: 1 } });
    assert(
      current.status === 200 &&
        (current.body as { possession_confirmed_revision: number })
          .possession_confirmed_revision === 1,
      'current possession revision could not be confirmed',
    );
  },
);

const pool = new pg.Pool({ connectionString: localStack.DB_URL });
await check(
  'database failure after schedule/charge inserts rolls back money and idempotency completion',
  async () => {
    const id = await tenancy();
    const body = intent();
    body.deposit = {
      decision: 'record',
      draft_key: 'deposit',
      amount_cents: 100,
      currency: 'USD',
      due_date: futureStart,
    };
    body.payments = [
      {
        draft_key: 'test',
        amount_cents: 100,
        currency: 'USD',
        received_at: `${today}T00:00:00Z`,
        method: 'cash',
        reference: 'onboarding_rollback_probe',
        allocations: [],
      },
    ];
    const reviewed = await preview(id, body);
    await pool.query(
      "create function public.onboarding_test_failure() returns trigger language plpgsql as $$ begin if NEW.reference = 'onboarding_rollback_probe' then raise exception 'rollback probe'; end if; return NEW; end $$",
    );
    await pool.query(
      'create trigger onboarding_test_failure before insert on public.payments for each row execute function public.onboarding_test_failure()',
    );
    try {
      const result = await commit(id, body, reviewed.context_fingerprint as string);
      assert(result.status === 500, JSON.stringify(result.body));
      assert((await moneyCount(id)) === 0, 'failed transaction left financial rows');
    } finally {
      await pool.query('drop trigger onboarding_test_failure on public.payments');
      await pool.query('drop function public.onboarding_test_failure()');
    }
  },
);
await pool.end();
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
