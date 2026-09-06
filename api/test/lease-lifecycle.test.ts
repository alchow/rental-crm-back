// ----------------------------------------------------------------------------
// Lease lifecycle (ADR-0014, migration 20260810000002).
//
// Status is the edit gate, not anchoring: draft is fully editable, active and
// expired freeze the rent terms, superseded is a historical record, and voided
// is closed. Removal is a void with a reason -- there is no DELETE -- and a
// correction is a replacement lease pointing back at the one it corrects.
//
// Covers, in contract order:
//    1 draft: term_start / rent_amount_cents / rent_currency edits apply.
//    2 activation freezes the rent: a changed value is 409 lease_executed, an
//      echoed (unchanged) value is a 200 no-op.
//    3 backward status transitions are lease_executed; a superseded lease is
//      lease_superseded for every field.
//    4 active: term_end / deposit / document stay editable.
//    5 void: reason required, the row stays readable, re-void is 404, a later
//      PATCH is lease_voided.
//    6 void of a lease anchoring a live schedule is instrument_anchored until
//      the schedule is gone.
//    7 replace an unanchored lease: old voided, replacement corrects it.
//    8 replace an anchored lease: the same rent repoints the schedule and
//      leaves billing untouched; a different rent is schedule_conflict.
//    9 replace a superseded lease: the replacement is superseded too.
//   10 create with corrects_lease_id: the target must be a voided lease of the
//      same tenancy.
//   11 DELETE /leases/{id} is gone.
//   12 anchoring: neither a draft nor a voided lease may anchor a schedule or a
//      rent change; a draft lease anchoring a rent change is activated by it.
//   13 isolation: account B cannot void or replace an account A lease.
//
// Bootstraps through test/helpers/integration.ts (env, api client, check
// harness). Needs the live local Supabase stack with 20260810000002 applied.
// ----------------------------------------------------------------------------

import type { ApiResponse } from './helpers/integration';
import {
  assert,
  assertStatus,
  configureIntegrationEnv,
  createApiClient,
  createCheckHarness,
  randomToken,
} from './helpers/integration';

configureIntegrationEnv('8809');

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { buildApp } = await import('../src/app');

const app = buildApp();
const api = createApiClient(app);
const { failures, check } = createCheckHarness();

// --- helpers ----------------------------------------------------------------

interface UserFixture {
  accessToken: string;
  accountId: string;
  unitAreaId: string;
}

interface Lease {
  id: string;
  tenancy_id: string;
  term_start: string;
  term_end: string | null;
  rent_amount_cents: number;
  rent_currency: string;
  deposit_amount_cents: number;
  deposit_currency: string | null;
  document: Record<string, unknown>;
  status: string;
  voided_at: string | null;
  void_reason: string | null;
  corrects_lease_id: string | null;
}

interface Schedule {
  id: string;
  amount_cents: number;
  source_lease_id: string | null;
}

interface ReplaceResult {
  voided: Lease;
  replacement: Lease;
  repointed_schedule_ids: string[];
}

interface LeaseOpts {
  status?: string;
  rent?: number;
  corrects?: string;
}

function codeOf(r: ApiResponse): string {
  return (r.body as { error?: { code?: string } })?.error?.code ?? '<none>';
}

function expectError(r: ApiResponse, status: number, code: string, context: string): void {
  assert(
    r.status === status && codeOf(r) === code,
    `${context}: expected ${status}/${code}, got ${r.status}/${codeOf(r)} ${JSON.stringify(r.body)}`,
  );
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `lease-lifecycle-${label}-${randomToken()}@example.test`;
  const password = `correct-horse-battery-${randomToken()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  assertStatus(su, 200, `signup ${label}`);
  const b = su.body as { account: { id: string }; session: { access_token: string } };
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: b.session.access_token, body });
    assertStatus(r, 201, `setup POST ${p}`);
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

async function main(): Promise<void> {
  console.info('Lease lifecycle checks');
  const A = await setupUser('a');
  const B = await setupUser('b');

  const postA = (p: string, body: unknown): Promise<ApiResponse> =>
    api('POST', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken, body });
  const getA = (p: string): Promise<ApiResponse> =>
    api('GET', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken });
  const patchA = (p: string, body: unknown): Promise<ApiResponse> =>
    api('PATCH', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken, body });
  const deleteA = (p: string): Promise<ApiResponse> =>
    api('DELETE', `/v1/accounts/${A.accountId}${p}`, { token: A.accessToken });

  async function newTenancy(): Promise<string> {
    const r = await postA('/tenancies', {
      area_id: A.unitAreaId,
      start_date: '2026-01-01',
      status: 'active',
    });
    assertStatus(r, 201, 'create tenancy');
    return (r.body as { id: string }).id;
  }

  function leaseBody(tenancyId: string, opts: LeaseOpts = {}): Record<string, unknown> {
    return {
      tenancy_id: tenancyId,
      term_start: '2026-01-01',
      term_end: '2026-12-31',
      rent_amount_cents: opts.rent ?? 200000,
      rent_currency: 'USD',
      status: opts.status ?? 'draft',
      ...(opts.corrects !== undefined ? { corrects_lease_id: opts.corrects } : {}),
    };
  }

  async function newLease(tenancyId: string, opts: LeaseOpts = {}): Promise<Lease> {
    const r = await postA('/leases', leaseBody(tenancyId, opts));
    assertStatus(r, 201, 'create lease');
    return r.body as Lease;
  }

  async function newSchedule(
    tenancyId: string,
    opts: { amount?: number; sourceLeaseId?: string } = {},
  ): Promise<Schedule> {
    const r = await postA('/rent-schedules', {
      tenancy_id: tenancyId,
      kind: 'rent',
      amount_cents: opts.amount ?? 200000,
      currency: 'USD',
      due_day: 1,
      start_date: '2026-01-01',
      ...(opts.sourceLeaseId !== undefined ? { source_lease_id: opts.sourceLeaseId } : {}),
    });
    assertStatus(r, 201, 'create schedule');
    return r.body as Schedule;
  }

  async function getLease(id: string): Promise<Lease> {
    const r = await getA(`/leases/${id}`);
    assertStatus(r, 200, `get lease ${id}`);
    return r.body as Lease;
  }

  async function getSchedule(id: string): Promise<Schedule> {
    const r = await getA(`/rent-schedules/${id}`);
    assertStatus(r, 200, `get schedule ${id}`);
    return r.body as Schedule;
  }

  const voidLease = (id: string, body: unknown): Promise<ApiResponse> =>
    postA(`/leases/${id}/void`, body);

  const replaceLease = (id: string, reason: string, rent: number): Promise<ApiResponse> =>
    postA(`/leases/${id}/replace`, {
      void_reason: reason,
      lease: {
        term_start: '2026-01-01',
        term_end: '2026-12-31',
        rent_amount_cents: rent,
        rent_currency: 'USD',
      },
    });

  const rentChange = (tenancyId: string, body: unknown): Promise<ApiResponse> =>
    postA(`/tenancies/${tenancyId}/rent-changes`, body);

  async function chargeCount(tenancyId: string): Promise<number> {
    const r = await getA(`/charges?tenancy_id=${tenancyId}`);
    assertStatus(r, 200, 'list charges');
    return (r.body as { data: unknown[] }).data.length;
  }

  // A lease-anchored rent change supersedes the tenancy's prior active lease.
  async function supersededLease(): Promise<string> {
    const tid = await newTenancy();
    const prior = await newLease(tid, { status: 'active' });
    await newSchedule(tid);
    const renewal = await newLease(tid, { status: 'draft', rent: 250000 });
    const r = await rentChange(tid, {
      amount_cents: 250000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
      source_lease_id: renewal.id,
    });
    assertStatus(r, 201, 'rent change');
    return prior.id;
  }

  // =========================================================================
  // 1. Draft: every term is editable.
  // =========================================================================
  await check('1 draft: term_start, rent_amount_cents and rent_currency apply', async () => {
    const lease = await newLease(await newTenancy(), { status: 'draft' });
    const r = await patchA(`/leases/${lease.id}`, {
      term_start: '2026-02-01',
      rent_amount_cents: 210000,
      rent_currency: 'CAD',
    });
    assertStatus(r, 200, 'draft edit');
    const after = await getLease(lease.id);
    assert(
      after.term_start === '2026-02-01' &&
        after.rent_amount_cents === 210000 &&
        after.rent_currency === 'CAD',
      `draft edit not applied: ${JSON.stringify(after)}`,
    );
  });

  // =========================================================================
  // 2. Execution freezes the rent terms; an echoed value is not a change.
  // =========================================================================
  await check('2 active: a rent change is lease_executed, an echo is a no-op', async () => {
    const lease = await newLease(await newTenancy(), { status: 'draft' });
    assertStatus(await patchA(`/leases/${lease.id}`, { status: 'active' }), 200, 'activate');

    const changed = await patchA(`/leases/${lease.id}`, { rent_amount_cents: 300000 });
    expectError(changed, 409, 'lease_executed', 'rent edit on an active lease');

    const echo = await patchA(`/leases/${lease.id}`, {
      term_end: '2027-06-30',
      rent_amount_cents: 200000,
      rent_currency: 'USD',
    });
    assertStatus(echo, 200, 'echo-back of unchanged rent');
    const after = await getLease(lease.id);
    assert(
      after.rent_amount_cents === 200000 && after.term_end === '2027-06-30',
      `echo left the row wrong: ${JSON.stringify(after)}`,
    );
  });

  // =========================================================================
  // 3. Status only moves forward, and superseded moves not at all.
  // =========================================================================
  await check('3 status: backward transitions and superseded edits are refused', async () => {
    const tid = await newTenancy();
    const active = await newLease(tid, { status: 'active' });
    expectError(
      await patchA(`/leases/${active.id}`, { status: 'draft' }),
      409,
      'lease_executed',
      'active -> draft',
    );

    const expired = await newLease(tid, { status: 'expired' });
    expectError(
      await patchA(`/leases/${expired.id}`, { status: 'active' }),
      409,
      'lease_executed',
      'expired -> active',
    );

    const superseded = await supersededLease();
    expectError(
      await patchA(`/leases/${superseded}`, { term_end: '2027-06-30' }),
      409,
      'lease_superseded',
      'term_end on a superseded lease',
    );
  });

  // =========================================================================
  // 4. Everything outside the frozen set stays editable while executed.
  // =========================================================================
  await check('4 active: term_end, deposit and document still apply', async () => {
    const lease = await newLease(await newTenancy(), { status: 'active' });
    const r = await patchA(`/leases/${lease.id}`, {
      term_end: '2027-06-30',
      deposit_amount_cents: 150000,
      deposit_currency: 'USD',
      document: { storage_key: 'leases/scan.pdf' },
    });
    assertStatus(r, 200, 'active non-frozen edit');
    const after = await getLease(lease.id);
    assert(
      after.term_end === '2027-06-30' &&
        after.deposit_amount_cents === 150000 &&
        after.document.storage_key === 'leases/scan.pdf',
      `non-frozen edit not applied: ${JSON.stringify(after)}`,
    );
  });

  // =========================================================================
  // 5. Void is the removal path: a reason, a surviving row, and a closed lease.
  // =========================================================================
  await check(
    '5 void: reason required, row survives, re-void 404, later PATCH refused',
    async () => {
      const tid = await newTenancy();
      const lease = await newLease(tid, { status: 'active' });
      for (const body of [{}, { void_reason: '' }, { void_reason: '   ' }]) {
        expectError(
          await voidLease(lease.id, body),
          400,
          'invalid_request',
          `void with ${JSON.stringify(body)}`,
        );
      }

      const ok = await voidLease(lease.id, { void_reason: 'signed in error' });
      assertStatus(ok, 200, 'void');
      const voided = ok.body as Lease;
      assert(
        voided.voided_at !== null && voided.void_reason === 'signed in error',
        `void did not stamp the row: ${JSON.stringify(voided)}`,
      );

      const listed = await getA(`/leases?tenancy_id=${tid}`);
      assertStatus(listed, 200, 'list after void');
      assert(
        (listed.body as { data: Lease[] }).data.some((l) => l.id === lease.id),
        'a voided lease must stay in the list',
      );
      assertStatus(await getA(`/leases/${lease.id}`), 200, 'get after void');

      expectError(
        await voidLease(lease.id, { void_reason: 'again' }),
        404,
        'not_found',
        'second void',
      );
      expectError(
        await patchA(`/leases/${lease.id}`, { term_end: '2027-06-30' }),
        409,
        'lease_voided',
        'PATCH after void',
      );
    },
  );

  // =========================================================================
  // 6. A lease anchoring a live schedule cannot be voided out from under it.
  // =========================================================================
  await check('6 void: an anchored lease is refused until the schedule is gone', async () => {
    const tid = await newTenancy();
    const lease = await newLease(tid, { status: 'active' });
    const schedule = await newSchedule(tid, { sourceLeaseId: lease.id });

    expectError(
      await voidLease(lease.id, { void_reason: 'wrong tenant' }),
      409,
      'instrument_anchored',
      'void of an anchoring lease',
    );

    // The schedule never billed here, so it deletes without a charge void first.
    assertStatus(await deleteA(`/rent-schedules/${schedule.id}`), 204, 'delete schedule');
    assertStatus(
      await voidLease(lease.id, { void_reason: 'wrong tenant' }),
      200,
      'void after unanchoring',
    );
  });

  // =========================================================================
  // 7. Replace: the correction path for an unanchored lease.
  // =========================================================================
  await check(
    '7 replace: unanchored lease is voided and corrected by the replacement',
    async () => {
      const lease = await newLease(await newTenancy(), { status: 'active' });
      const r = await replaceLease(lease.id, 'rent typed wrong', 250000);
      assertStatus(r, 200, 'replace');
      const res = r.body as ReplaceResult;
      assert(
        res.voided.id === lease.id &&
          res.voided.voided_at !== null &&
          res.voided.void_reason === 'rent typed wrong',
        `old lease not voided: ${JSON.stringify(res.voided)}`,
      );
      assert(
        res.replacement.corrects_lease_id === lease.id &&
          res.replacement.status === 'active' &&
          res.replacement.rent_amount_cents === 250000,
        `replacement wrong: ${JSON.stringify(res.replacement)}`,
      );
      assert(
        res.repointed_schedule_ids.length === 0,
        `nothing was anchored: ${JSON.stringify(res.repointed_schedule_ids)}`,
      );
    },
  );

  // =========================================================================
  // 8. Replace an anchored lease: the schedule follows, the rent may not move.
  // =========================================================================
  await check('8 replace: anchored lease repoints its schedule only at the same rent', async () => {
    const tid = await newTenancy();
    const lease = await newLease(tid, { status: 'active' });
    const schedule = await newSchedule(tid, { sourceLeaseId: lease.id });
    assertStatus(
      await postA('/charges', {
        tenancy_id: tid,
        type: 'rent',
        amount_cents: 200000,
        currency: 'USD',
        due_date: '2026-02-01',
        period_start: '2026-02-01',
        period_end: '2026-02-28',
        source_schedule_id: schedule.id,
      }),
      201,
      'seed charge',
    );
    const billedBefore = await chargeCount(tid);

    const r = await replaceLease(lease.id, 'document typo', 200000);
    assertStatus(r, 200, 'replace at the same rent');
    const res = r.body as ReplaceResult;
    assert(
      res.repointed_schedule_ids.length === 1 && res.repointed_schedule_ids[0] === schedule.id,
      `repointed ids ${JSON.stringify(res.repointed_schedule_ids)} != [${schedule.id}]`,
    );
    const repointed = await getSchedule(schedule.id);
    assert(
      repointed.source_lease_id === res.replacement.id,
      `schedule still anchored to ${repointed.source_lease_id}`,
    );
    assert(
      (await chargeCount(tid)) === billedBefore,
      'a replacement must not touch the billing history',
    );

    const differentRent = await replaceLease(res.replacement.id, 'raise the rent', 250000);
    expectError(differentRent, 409, 'schedule_conflict', 'replace at a different rent');
    const untouched = await getLease(res.replacement.id);
    assert(untouched.voided_at === null, 'the refused replace voided the lease anyway');
    assert(
      (await getSchedule(schedule.id)).source_lease_id === res.replacement.id,
      'the refused replace repointed the schedule anyway',
    );
  });

  // =========================================================================
  // 9. Replace keeps the status: a superseded lease begets a superseded one.
  // =========================================================================
  await check('9 replace: a superseded lease is replaced by a superseded lease', async () => {
    const r = await replaceLease(await supersededLease(), 'scanned the wrong page', 200000);
    assertStatus(r, 200, 'replace a superseded lease');
    const res = r.body as ReplaceResult;
    assert(
      res.replacement.status === 'superseded',
      `replacement status ${res.replacement.status} != superseded`,
    );
  });

  // =========================================================================
  // 10. corrects_lease_id may only name a voided lease of the same tenancy.
  // =========================================================================
  await check('10 create: corrects_lease_id must name a voided lease', async () => {
    const tid = await newTenancy();
    const target = await newLease(tid, { status: 'active' });
    expectError(
      await postA('/leases', leaseBody(tid, { corrects: target.id })),
      400,
      'invalid_request',
      'corrects a live lease',
    );

    assertStatus(await voidLease(target.id, { void_reason: 'junk' }), 200, 'void the target');
    const ok = await postA('/leases', leaseBody(tid, { corrects: target.id }));
    assertStatus(ok, 201, 'corrects a voided lease');
    assert(
      (ok.body as Lease).corrects_lease_id === target.id,
      `corrects_lease_id not stored: ${JSON.stringify(ok.body)}`,
    );
  });

  // =========================================================================
  // 11. DELETE is gone; void is the only removal.
  // =========================================================================
  await check('11 delete: the lease DELETE route no longer exists', async () => {
    const lease = await newLease(await newTenancy(), { status: 'active' });
    expectError(await deleteA(`/leases/${lease.id}`), 404, 'not_found', 'DELETE lease');
  });

  // =========================================================================
  // 12. Anchoring: only a live, executed lease is an instrument.
  // =========================================================================
  await check('12 anchoring: draft and voided leases anchor nothing', async () => {
    const draftTid = await newTenancy();
    const draft = await newLease(draftTid, { status: 'draft' });
    expectError(
      await postA('/rent-schedules', {
        tenancy_id: draftTid,
        kind: 'rent',
        amount_cents: 200000,
        currency: 'USD',
        due_day: 1,
        start_date: '2026-01-01',
        source_lease_id: draft.id,
      }),
      400,
      'invalid_request',
      'schedule anchored to a draft lease',
    );

    const voidedTid = await newTenancy();
    const voided = await newLease(voidedTid, { status: 'active' });
    assertStatus(await voidLease(voided.id, { void_reason: 'junk' }), 200, 'void the anchor');
    expectError(
      await postA('/rent-schedules', {
        tenancy_id: voidedTid,
        kind: 'rent',
        amount_cents: 200000,
        currency: 'USD',
        due_day: 1,
        start_date: '2026-01-01',
        source_lease_id: voided.id,
      }),
      400,
      'invalid_request',
      'schedule anchored to a voided lease',
    );

    await newSchedule(voidedTid);
    expectError(
      await rentChange(voidedTid, {
        amount_cents: 220000,
        currency: 'USD',
        effective_date: '2026-09-01',
        due_day: 1,
        source_lease_id: voided.id,
      }),
      409,
      'instrument_not_current',
      'rent change anchored to a voided lease',
    );

    await newSchedule(draftTid);
    const change = await rentChange(draftTid, {
      amount_cents: 220000,
      currency: 'USD',
      effective_date: '2026-09-01',
      due_day: 1,
      source_lease_id: draft.id,
    });
    assertStatus(change, 201, 'rent change anchored to a draft lease');
    assert(
      (await getLease(draft.id)).status === 'active',
      'the rent change must activate its draft anchor',
    );
  });

  // =========================================================================
  // 13. Cross-account: the new routes 404 like every other account-scoped one.
  // =========================================================================
  await check('13 isolation: B cannot void or replace an A lease', async () => {
    const lease = await newLease(await newTenancy(), { status: 'active' });
    const voided = await api('POST', `/v1/accounts/${A.accountId}/leases/${lease.id}/void`, {
      token: B.accessToken,
      body: { void_reason: 'attack' },
    });
    expectError(voided, 404, 'not_found', "B voiding A's lease");

    const replaced = await api('POST', `/v1/accounts/${A.accountId}/leases/${lease.id}/replace`, {
      token: B.accessToken,
      body: {
        void_reason: 'attack',
        lease: {
          term_start: '2026-01-01',
          term_end: '2026-12-31',
          rent_amount_cents: 100000,
          rent_currency: 'USD',
        },
      },
    });
    expectError(replaced, 404, 'not_found', "B replacing A's lease");
    assert((await getLease(lease.id)).voided_at === null, "A's lease was mutated");
  });
}

await main();

if (failures.length > 0) {
  console.error(`\n${failures.length} lease-lifecycle failure(s):`);
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.detail}`);
  process.exit(1);
}

console.info('\nOK: lease-lifecycle checks all green');
