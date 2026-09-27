import {
  assert,
  assertStatus,
  configureIntegrationEnv,
  createApiClient,
  createCheckHarness,
  randomToken,
} from './helpers/integration';

configureIntegrationEnv('8799');
const { _resetEnvCacheForTests } = await import('../src/env');
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetEnvCacheForTests();
_resetJwksCacheForTests();
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');
const api = createApiClient(buildApp());
const { check, failures } = createCheckHarness();

type Session = { token: string; accountId: string; areaId: string };
type Row = { id: string; [key: string]: unknown };
type Preview = {
  preview_token: string;
  blockers: { code: string }[];
  schedules: { id: string; selected: boolean }[];
  bills: {
    due_date: string;
    after_due_date?: string | null;
    period_start: string;
    carried_cents: number;
    credit_cents: number;
    balance_after_cents: number;
  }[];
};
type Receipt = {
  id: string;
  replacement_lease_id: string | null;
  source_lease_id: string | null;
  source_notice_id: string | null;
  schedule_ids: string[];
  charge_ids: string[];
  preview: Preview;
};

async function setup(label: string): Promise<Session> {
  const signup = assertStatus(
    await api('POST', '/v1/auth/signup', {
      body: {
        email: `adjust-${label}-${randomToken()}@example.test`,
        password: `correct-horse-${randomToken()}`,
        account_name: `Adjustment ${label}`,
      },
    }),
    200,
    'signup',
  ) as { account: { id: string }; session: { access_token: string } };
  const token = signup.session.access_token;
  const accountId = signup.account.id;
  const property = await post<Row>(token, accountId, '/properties', { name: `${label} property` });
  const area = await post<Row>(token, accountId, '/areas', {
    property_id: property.id,
    kind: 'unit',
    name: `${label} unit`,
  });
  return { token, accountId, areaId: area.id };
}

async function post<T>(token: string, accountId: string, path: string, body: unknown): Promise<T> {
  return assertStatus(
    await api('POST', `/v1/accounts/${accountId}${path}`, { token, body }),
    201,
    `POST ${path}`,
  ) as T;
}

async function tenancy(session: Session): Promise<string> {
  return (
    await post<Row>(session.token, session.accountId, '/tenancies', {
      area_id: session.areaId,
      start_date: '2026-09-01',
      status: 'active',
    })
  ).id;
}

const terms = (rent: number) => ({
  term_start: '2026-09-01',
  term_end: null,
  rent_amount_cents: rent,
  rent_currency: 'USD',
  deposit_amount_cents: 300_000,
  deposit_currency: 'USD',
});

async function lease(session: Session, tenancyId: string, rent: number, status = 'active') {
  return post<Row>(session.token, session.accountId, '/leases', {
    tenancy_id: tenancyId,
    ...terms(rent),
    status,
  });
}

async function schedule(
  session: Session,
  tenancyId: string,
  leaseId: string,
  rent: number,
  overrides: Record<string, unknown> = {},
) {
  return post<Row>(session.token, session.accountId, '/rent-schedules', {
    tenancy_id: tenancyId,
    kind: 'rent',
    amount_cents: rent,
    currency: 'USD',
    due_day: 15,
    start_date: '2026-09-01',
    source_lease_id: leaseId,
    ...overrides,
  });
}

async function bill(
  session: Session,
  tenancyId: string,
  scheduleId: string,
  amount: number,
  overrides: Record<string, unknown> = {},
) {
  return post<Row>(session.token, session.accountId, '/charges', {
    tenancy_id: tenancyId,
    type: 'rent',
    amount_cents: amount,
    currency: 'USD',
    due_date: '2026-09-15',
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    source_schedule_id: scheduleId,
    ...overrides,
  });
}

async function payment(session: Session, tenancyId: string, chargeId: string, amount: number) {
  return post<Row>(session.token, session.accountId, '/payments', {
    tenancy_id: tenancyId,
    amount_cents: amount,
    currency: 'USD',
    received_at: '2026-09-15T12:00:00Z',
    method: 'ach',
    allocations: [{ charge_id: chargeId, amount_cents: amount }],
  });
}

async function preview(session: Session, tenancyId: string, input: unknown): Promise<Preview> {
  return assertStatus(
    await api(
      'POST',
      `/v1/accounts/${session.accountId}/tenancies/${tenancyId}/rent-adjustments/preview`,
      { token: session.token, body: input },
    ),
    200,
    'preview adjustment',
  ) as Preview;
}

async function commit(
  session: Session,
  tenancyId: string,
  input: unknown,
  previewToken: string,
  key = `adjust-${crypto.randomUUID()}`,
) {
  return {
    key,
    response: await api(
      'POST',
      `/v1/accounts/${session.accountId}/tenancies/${tenancyId}/rent-adjustments`,
      { token: session.token, body: { input, preview_token: previewToken }, idempotencyKey: key },
    ),
  };
}

async function main(): Promise<void> {
  console.info('Rent adjustment API checks');
  const owner = await setup('owner');
  const outsider = await setup('outsider');
  const admin = getAdminClient();

  await check(
    'paid correction carries payment, voids fee, preserves waiver, and replays',
    async () => {
      const tenancyId = await tenancy(owner);
      const oldLease = await lease(owner, tenancyId, 150_000);
      const oldSchedule = await schedule(owner, tenancyId, oldLease.id, 150_000);
      const oldBill = await bill(owner, tenancyId, oldSchedule.id, 150_000);
      await payment(owner, tenancyId, oldBill.id, 150_000);
      const fee = await post<Row>(owner.token, owner.accountId, '/charges', {
        tenancy_id: tenancyId,
        type: 'late_fee',
        amount_cents: 5_000,
        currency: 'USD',
        due_date: '2026-09-20',
        parent_charge_id: oldBill.id,
      });
      const waived = await post<Row>(owner.token, owner.accountId, '/charges', {
        tenancy_id: tenancyId,
        type: 'rent',
        amount_cents: 150_000,
        currency: 'USD',
        due_date: '2026-10-15',
        period_start: '2026-10-01',
        period_end: '2026-10-31',
        source_schedule_id: oldSchedule.id,
      });
      assertStatus(
        await api('POST', `/v1/accounts/${owner.accountId}/charges/${waived.id}/void`, {
          token: owner.token,
          body: { void_reason: 'Rent waived' },
        }),
        200,
        'waive October',
      );
      const input = {
        kind: 'correct_rent',
        lease_id: oldLease.id,
        terms: terms(180_000),
        reason: 'Rent entered incorrectly',
        scope: { schedules: [{ schedule_id: oldSchedule.id }] },
      };
      const reviewed = await preview(owner, tenancyId, input);
      assert(
        reviewed.blockers.length === 0,
        `unexpected blockers ${JSON.stringify(reviewed.blockers)}`,
      );
      assert(reviewed.bills[0]?.carried_cents === 150_000, 'payment carryover preview');
      assert(reviewed.bills[0]?.balance_after_cents === 30_000, 'remaining rent preview');
      const saved = await commit(owner, tenancyId, input, reviewed.preview_token);
      const receipt = assertStatus(saved.response, 200, 'commit correction') as Receipt;
      assert(receipt.charge_ids.length === 1, 'one replacement rent bill');
      const replay = await commit(owner, tenancyId, input, reviewed.preview_token, saved.key);
      assert(
        (assertStatus(replay.response, 200, 'replay') as Receipt).id === receipt.id,
        'same receipt',
      );
      assert(replay.response.headers['idempotency-replay'] === 'true', 'middleware replay header');
      const recovered = assertStatus(
        await api(
          'GET',
          `/v1/accounts/${owner.accountId}/tenancies/${tenancyId}/rent-adjustments/by-request-key/${saved.key}`,
          { token: owner.token },
        ),
        200,
        'recover receipt',
      ) as { receipt: Receipt | null };
      assert(recovered.receipt?.id === receipt.id, 'durable request-key recovery');
      const history = assertStatus(
        await api(
          'GET',
          `/v1/accounts/${owner.accountId}/tenancies/${tenancyId}/rent-adjustments?limit=1`,
          { token: owner.token },
        ),
        200,
        'list adjustment history',
      ) as { items: Receipt[]; next_cursor: string | null };
      assert(history.items[0]?.id === receipt.id, 'newest receipt is discoverable');
      const charges = assertStatus(
        await api('GET', `/v1/accounts/${owner.accountId}/charges?tenancy_id=${tenancyId}`, {
          token: owner.token,
        }),
        200,
        'list charges',
      ) as {
        data: Array<
          Row & { id: string; voided_at: string | null; corrects_charge_id?: string | null }
        >;
      };
      assert(
        charges.data.find((row) => row.id === fee.id)?.voided_at !== null,
        'derived fee voided',
      );
      assert(
        charges.data.some((row) => row.corrects_charge_id === waived.id && row.voided_at !== null),
        'waived period preserved under successor schedule',
      );
      const cross = await api(
        'GET',
        `/v1/accounts/${outsider.accountId}/tenancies/${tenancyId}/rent-adjustments/${receipt.id}`,
        { token: outsider.token },
      );
      assert(cross.status === 404, `cross-account read exposed ${cross.status}`);
    },
  );

  await check('rent reduction releases excess as credit', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 180_000);
    const oldSchedule = await schedule(owner, tenancyId, oldLease.id, 180_000);
    const oldBill = await bill(owner, tenancyId, oldSchedule.id, 180_000);
    await payment(owner, tenancyId, oldBill.id, 180_000);
    const input = {
      kind: 'correct_rent',
      lease_id: oldLease.id,
      terms: terms(150_000),
      reason: 'Rent entered incorrectly',
      scope: { schedules: [{ schedule_id: oldSchedule.id }] },
    };
    const reviewed = await preview(owner, tenancyId, input);
    assert(reviewed.bills[0]?.carried_cents === 150_000, 'carried amount capped at corrected bill');
    assert(reviewed.bills[0]?.credit_cents === 30_000, 'excess released as credit');
    assertStatus(
      (await commit(owner, tenancyId, input, reviewed.preview_token)).response,
      200,
      'commit reduction',
    );
  });

  await check('partial payment remains attributed to the corrected bill', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    const oldSchedule = await schedule(owner, tenancyId, oldLease.id, 150_000);
    const oldBill = await bill(owner, tenancyId, oldSchedule.id, 150_000);
    await payment(owner, tenancyId, oldBill.id, 50_000);
    const input = {
      kind: 'correct_rent',
      lease_id: oldLease.id,
      terms: terms(180_000),
      reason: 'Rent entered incorrectly',
      scope: { schedules: [{ schedule_id: oldSchedule.id }] },
    };
    const reviewed = await preview(owner, tenancyId, input);
    assert(reviewed.bills[0]?.carried_cents === 50_000, 'partial payment carried exactly');
    assert(reviewed.bills[0]?.balance_after_cents === 130_000, 'correct remaining balance');
    assertStatus(
      (await commit(owner, tenancyId, input, reviewed.preview_token)).response,
      200,
      'commit partial-payment correction',
    );
  });

  await check('lease-only correction creates no billing', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    const input = {
      kind: 'edit_details',
      lease_id: oldLease.id,
      terms: { ...terms(150_000), deposit_amount_cents: 250_000 },
      reason: 'Wrong deposit',
    };
    const reviewed = await preview(owner, tenancyId, input);
    assert(reviewed.schedules.length === 0 && reviewed.bills.length === 0, 'no invented billing');
    const receipt = assertStatus(
      (await commit(owner, tenancyId, input, reviewed.preview_token)).response,
      200,
      'commit lease-only correction',
    ) as Receipt;
    assert(
      receipt.schedule_ids.length === 0 && receipt.charge_ids.length === 0,
      'empty money effects',
    );
  });

  await check('genuine change uses one reviewed source and returns its id', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    const oldSchedule = await schedule(owner, tenancyId, oldLease.id, 150_000);
    await post<Row>(owner.token, owner.accountId, '/charges', {
      tenancy_id: tenancyId,
      type: 'rent',
      amount_cents: 150_000,
      currency: 'USD',
      due_date: '2026-10-15',
      period_start: '2026-10-01',
      period_end: '2026-10-31',
      source_schedule_id: oldSchedule.id,
    });
    const source = await lease(owner, tenancyId, 180_000, 'draft');
    const input = {
      kind: 'change_rent',
      amount_cents: 180_000,
      currency: 'USD',
      effective_date: '2026-10-01',
      source: { kind: 'existing_lease', lease_id: source.id },
      reason: 'Renewal agreed',
    };
    const reviewed = await preview(owner, tenancyId, input);
    assert(
      reviewed.blockers.length === 0,
      `unexpected blockers ${JSON.stringify(reviewed.blockers)}`,
    );
    assert(reviewed.bills[0]?.after_due_date === '2026-10-15', 'October due day');
    const receipt = assertStatus(
      (await commit(owner, tenancyId, input, reviewed.preview_token)).response,
      200,
      'commit rent change',
    ) as Receipt;
    assert(receipt.source_lease_id === source.id, 'receipt identifies supporting lease');
    assert(receipt.schedule_ids.length === 1, 'one successor schedule');
    const { error: enableError } = await admin
      .from('accounts')
      .update({ auto_charge_enabled: true })
      .eq('id', owner.accountId);
    assert(!enableError, `enable generator: ${enableError?.message}`);
    const { error: generateError } = await admin.rpc('generate_rent_charges', {
      p_account_id: owner.accountId,
      p_as_of: '2026-10-01T12:00:00Z',
    });
    assert(!generateError, `generate rent: ${generateError?.message}`);
    const chargeList = assertStatus(
      await api('GET', `/v1/accounts/${owner.accountId}/charges?tenancy_id=${tenancyId}`, {
        token: owner.token,
      }),
      200,
      'list changed charges',
    ) as { data: Array<Row & { period_start: string | null; voided_at: string | null }> };
    assert(
      chargeList.data.filter(
        (row) =>
          row.period_start !== null &&
          row.period_start >= '2026-10-01' &&
          row.period_start <= '2026-10-31' &&
          row.voided_at === null,
      ).length === 1,
      'generator does not duplicate the reissued October bill',
    );
  });

  await check('wrong rent without a schedule remains a lease-only correction', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    const input = {
      kind: 'correct_rent',
      lease_id: oldLease.id,
      terms: terms(180_000),
      reason: 'Rent was entered incorrectly',
      scope: { schedules: [] },
    };
    const reviewed = await preview(owner, tenancyId, input);
    assert(reviewed.schedules.length === 0 && reviewed.bills.length === 0, 'no invented money');
    const receipt = assertStatus(
      (await commit(owner, tenancyId, input, reviewed.preview_token)).response,
      200,
      'commit schedule-free rent correction',
    ) as Receipt;
    assert(receipt.schedule_ids.length === 0 && receipt.charge_ids.length === 0, 'lease only');
  });

  await check('only selected schedule slice is corrected', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    const first = await schedule(owner, tenancyId, oldLease.id, 150_000, {
      start_date: '2026-08-15',
      end_date: '2026-11-30',
    });
    const second = await schedule(owner, tenancyId, oldLease.id, 150_000, {
      start_date: '2026-12-01',
    });
    await bill(owner, tenancyId, first.id, 150_000, {
      period_start: '2026-09-15',
      period_end: '2026-10-14',
    });
    await bill(owner, tenancyId, second.id, 150_000, {
      due_date: '2026-12-15',
      period_start: '2026-12-01',
      period_end: '2026-12-31',
    });
    const input = {
      kind: 'correct_rent',
      lease_id: oldLease.id,
      terms: terms(180_000),
      reason: 'Only the first schedule was wrong',
      scope: {
        schedules: [{ schedule_id: first.id, start_date: '2026-09-15', end_date: '2026-10-14' }],
      },
    };
    const reviewed = await preview(owner, tenancyId, input);
    assert(
      reviewed.schedules.filter((row) => row.selected).length === 1,
      `one selected schedule: ${JSON.stringify(reviewed)}`,
    );
    assert(reviewed.schedules.find((row) => row.id === second.id)?.selected === false, 'second untouched');
    assert(reviewed.bills.length === 1 && reviewed.bills[0]?.period_start === '2026-09-15', 'one bill affected');
    const receipt = assertStatus(
      (await commit(owner, tenancyId, input, reviewed.preview_token)).response,
      200,
      'commit partial schedule range',
    ) as Receipt;
    assert(receipt.schedule_ids.length >= 2, 'partial range split into replacement segments');
  });

  await check('unknown manual charge override is rejected during preview', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    const oldSchedule = await schedule(owner, tenancyId, oldLease.id, 150_000);
    const input = {
      kind: 'correct_rent',
      lease_id: oldLease.id,
      terms: terms(180_000),
      reason: 'Bad manual target',
      scope: {
        schedules: [{ schedule_id: oldSchedule.id }],
        charges: [{ charge_id: crypto.randomUUID(), amount_cents: 180_000 }],
      },
    };
    const response = await api(
      'POST',
      `/v1/accounts/${owner.accountId}/tenancies/${tenancyId}/rent-adjustments/preview`,
      { token: owner.token, body: input },
    );
    if (response.status === 200) {
      const reviewed = response.body as Preview;
      assert(reviewed.blockers.length > 0, 'unknown charge must block commit');
      const blocked = (await commit(owner, tenancyId, input, reviewed.preview_token)).response;
      const body = assertStatus(blocked, 409, 'blocked preview commit') as {
        error: { code: string };
      };
      assert(body.error.code === 'adjustment_scope_required', `wrong code ${body.error.code}`);
    } else {
      assert(response.status === 400 || response.status === 404, `unexpected status ${response.status}`);
    }
  });

  await check('same idempotency key rejects a different adjustment', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    const firstInput = {
      kind: 'edit_details',
      lease_id: oldLease.id,
      terms: { ...terms(150_000), deposit_amount_cents: 250_000 },
      reason: 'Correct deposit',
    };
    const firstReview = await preview(owner, tenancyId, firstInput);
    const saved = await commit(owner, tenancyId, firstInput, firstReview.preview_token);
    assertStatus(saved.response, 200, 'first keyed commit');
    const secondInput = { ...firstInput, reason: 'A different request' };
    const secondReview = await preview(owner, tenancyId, secondInput);
    const conflict = await commit(
      owner,
      tenancyId,
      secondInput,
      secondReview.preview_token,
      saved.key,
    );
    const body = assertStatus(conflict.response, 409, 'idempotency fingerprint conflict') as {
      error: { code: string };
    };
    assert(body.error.code === 'idempotency_conflict', `wrong code ${body.error.code}`);
  });

  await check('genuine change preserves a waived predecessor period', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    const oldSchedule = await schedule(owner, tenancyId, oldLease.id, 150_000);
    const october = await bill(owner, tenancyId, oldSchedule.id, 150_000, {
      due_date: '2026-10-15',
      period_start: '2026-10-01',
      period_end: '2026-10-31',
    });
    assertStatus(
      await api('POST', `/v1/accounts/${owner.accountId}/charges/${october.id}/void`, {
        token: owner.token,
        body: { void_reason: 'Rent waived' },
      }),
      200,
      'waive predecessor October',
    );
    const source = await lease(owner, tenancyId, 180_000, 'draft');
    const input = {
      kind: 'change_rent',
      amount_cents: 180_000,
      currency: 'USD',
      effective_date: '2026-10-01',
      source: { kind: 'existing_lease', lease_id: source.id },
      reason: 'New agreement',
    };
    const reviewed = await preview(owner, tenancyId, input);
    assertStatus(
      (await commit(owner, tenancyId, input, reviewed.preview_token)).response,
      200,
      'commit change over waiver',
    );
    const { error } = await admin.rpc('generate_rent_charges', {
      p_account_id: owner.accountId,
      p_as_of: '2026-10-01T12:00:00Z',
    });
    assert(!error, `generate rent: ${error?.message}`);
    const rows = assertStatus(
      await api('GET', `/v1/accounts/${owner.accountId}/charges?tenancy_id=${tenancyId}`, {
        token: owner.token,
      }),
      200,
      'list waived change charges',
    ) as { data: Array<Row & { period_start: string | null; voided_at: string | null }> };
    assert(
      rows.data.filter((row) => row.period_start === '2026-10-01' && row.voided_at === null).length === 0,
      'generator did not reassert waived October rent',
    );
  });

  await check('genuine change and lease metadata correction commit atomically', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    await schedule(owner, tenancyId, oldLease.id, 150_000);
    const input = {
      kind: 'change_rent',
      amount_cents: 180_000,
      currency: 'USD',
      effective_date: '2026-10-01',
      source: {
        kind: 'new_notice',
        notice_label: 'rent_increase',
        served_at: '2026-09-01T12:00:00Z',
        served_method: 'certified_mail',
      },
      details_correction: {
        lease_id: oldLease.id,
        terms: { ...terms(150_000), deposit_amount_cents: 250_000 },
        reason: 'Deposit typo',
      },
      reason: 'Annual rent increase',
    };
    const reviewed = await preview(owner, tenancyId, input);
    const receipt = assertStatus(
      (await commit(owner, tenancyId, input, reviewed.preview_token)).response,
      200,
      'commit metadata and rent change',
    ) as Receipt;
    assert(receipt.source_notice_id !== null, 'notice created in transaction');
    assert(receipt.replacement_lease_id !== null, 'corrected lease created in transaction');
    const [notice, replacement] = await Promise.all([
      admin.from('notices').select('notice_label').eq('id', receipt.source_notice_id!).single(),
      admin
        .from('leases')
        .select('deposit_amount_cents')
        .eq('id', receipt.replacement_lease_id!)
        .single(),
    ]);
    assert(!notice.error && notice.data.notice_label === 'rent_increase', 'notice persisted');
    assert(
      !replacement.error && replacement.data.deposit_amount_cents === 250_000,
      'metadata correction persisted',
    );
  });

  await check('correction preserves historical lease status on an ended tenancy', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000, 'expired');
    const oldSchedule = await schedule(owner, tenancyId, oldLease.id, 150_000, {
      end_date: '2026-09-30',
    });
    const { error: endError } = await admin
      .from('tenancies')
      .update({ status: 'ended', end_date: '2026-09-30' })
      .eq('id', tenancyId);
    assert(!endError, `end tenancy fixture: ${endError?.message}`);
    const input = {
      kind: 'correct_rent',
      lease_id: oldLease.id,
      terms: { ...terms(180_000), term_end: '2026-09-30' },
      reason: 'Historical rent typo',
      scope: { schedules: [{ schedule_id: oldSchedule.id }] },
    };
    const reviewed = await preview(owner, tenancyId, input);
    const receipt = assertStatus(
      (await commit(owner, tenancyId, input, reviewed.preview_token)).response,
      200,
      'commit historical correction',
    ) as Receipt;
    const replacement = await admin
      .from('leases')
      .select('status')
      .eq('id', receipt.replacement_lease_id!)
      .single();
    assert(!replacement.error && replacement.data.status === 'expired', 'expired status preserved');
  });

  await check('stale preview performs no adjustment write', async () => {
    const tenancyId = await tenancy(owner);
    const oldLease = await lease(owner, tenancyId, 150_000);
    const input = {
      kind: 'edit_details',
      lease_id: oldLease.id,
      terms: { ...terms(150_000), deposit_amount_cents: 275_000 },
      reason: 'Wrong deposit',
    };
    const reviewed = await preview(owner, tenancyId, input);
    await post<Row>(owner.token, owner.accountId, '/payments', {
      tenancy_id: tenancyId,
      amount_cents: 100,
      currency: 'USD',
      received_at: '2026-09-16T12:00:00Z',
      method: 'cash',
    });
    const stale = (await commit(owner, tenancyId, input, reviewed.preview_token)).response;
    const body = assertStatus(stale, 409, 'stale commit') as { error: { code: string } };
    assert(body.error.code === 'preview_stale', `wrong stale code ${body.error.code}`);
  });

  if (failures.length) {
    console.error(`\n${failures.length} rent-adjustment check(s) failed`);
    process.exit(1);
  }
  console.info('\nAll rent-adjustment checks passed');
}

await main();
