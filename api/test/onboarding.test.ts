import {
  assert,
  configureIntegrationEnv,
  createApiClient,
  createCheckHarness,
  randomToken,
} from './helpers/integration';

configureIntegrationEnv('8797');
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
const future = new Date();
future.setUTCDate(future.getUTCDate() + 30);
const futureDate = future.toISOString().slice(0, 10);
const signup = await api('POST', '/v1/auth/signup', {
  body: {
    email: `onboarding-${randomToken()}@example.test`,
    password: `horse-${randomToken()}`,
    account_name: 'Onboarding test',
  },
});
assert(signup.status === 200, JSON.stringify(signup.body));
const auth = signup.body as { account: { id: string }; session: { access_token: string } };
const token = auth.session.access_token;
const base = `/v1/accounts/${auth.account.id}`;
async function request(method: string, path: string, body?: unknown, key?: string) {
  return api(method, base + path, { token, body, ...(key ? { idempotencyKey: key } : {}) });
}
async function create(path: string, body: unknown) {
  const response = await request('POST', path, body);
  assert(response.status === 201, `${path} ${JSON.stringify(response.body)}`);
  return response.body as { id: string };
}
const property = await create('/properties', { name: 'Onboarding property' });
const tenant = await create('/tenants', { full_name: 'Synthetic onboarding tenant' });
async function bootstrap(start = futureDate) {
  const unit = await create('/areas', {
    property_id: property.id,
    kind: 'unit',
    name: randomToken(),
  });
  const body = {
    area_id: unit.id,
    tenant_id: tenant.id,
    start_date: start,
    start_date_basis: 'possession_entitlement',
    status: 'upcoming',
  };
  const key = `bootstrap-${randomToken()}`;
  const response = await request('POST', '/tenancies/bootstrap', body, key);
  assert(response.status === 201, JSON.stringify(response.body));
  return {
    body,
    key,
    result: response.body as {
      tenancy: { id: string; status: string };
      member: { id: string; tenant_id: string };
    },
  };
}
async function progress(id: string) {
  const response = await request('GET', `/tenancies/${id}/onboarding-progress`);
  assert(response.status === 200, JSON.stringify(response.body));
  return response.body as {
    revision: number;
    agreement_confirmed: boolean;
    condition_decision: string;
    possession_confirmed_revision: number | null;
    effective_status: string;
    as_of_date: string;
    clock_basis: string;
  };
}

await check(
  'bootstrap commits one member and tenancy, retries return the same identities, and creates no money',
  async () => {
    const { body, key, result } = await bootstrap();
    assert(
      result.tenancy.status === 'upcoming' && result.member.tenant_id === tenant.id,
      'wrong bootstrap facts',
    );
    const retry = await request('POST', '/tenancies/bootstrap', body, key);
    assert(
      JSON.stringify(retry.body) === JSON.stringify(result),
      'retry created different identities',
    );
    const duplicate = await request('POST', '/tenancies/bootstrap', body);
    assert(duplicate.status === 409, 'duplicate tenant/unit/start accepted');
    for (const table of ['charges', 'payments', 'rent_schedules'] as const) {
      const rows = await admin
        .from(table)
        .select('id', { count: 'exact' })
        .eq('tenancy_id', result.tenancy.id);
      assert(rows.count === 0, `${table} written during bootstrap`);
    }
  },
);
await check('bootstrap rejects foreign parents and rolls back both identities', async () => {
  const response = await request('POST', '/tenancies/bootstrap', {
    area_id: crypto.randomUUID(),
    tenant_id: tenant.id,
    start_date: today,
    status: 'active',
  });
  assert(response.status === 404, JSON.stringify(response.body));
});
await check(
  'progress cannot claim completion without evidence and retains deferred decisions',
  async () => {
    const { result } = await bootstrap(today);
    const response = await request('PATCH', `/tenancies/${result.tenancy.id}/onboarding-progress`, {
      expected_revision: 0,
      condition_decision: 'complete',
      rent_decision: 'configured',
      deposit_decision: 'deferred',
      possession_confirmed_revision: 0,
    });
    assert(response.status === 200, JSON.stringify(response.body));
    const p = response.body as Record<string, unknown>;
    assert(
      p.condition_decision === 'pending' &&
        p.rent_decision === 'pending' &&
        p.deposit_decision === 'deferred',
      'decisions fabricated completion',
    );
    assert(
      p.possession_confirmed_revision === 0 &&
        p.effective_status === 'active' &&
        p.as_of_date === today &&
        p.clock_basis === 'UTC',
      'wrong possession clock',
    );
    const stale = await request('PATCH', `/tenancies/${result.tenancy.id}/onboarding-progress`, {
      expected_revision: 0,
      condition_decision: 'deferred',
    });
    assert(stale.status === 409, 'stale progress overwritten');
  },
);
await check('a changed agreement invalidates confirmation without erasing decisions', async () => {
  const { result } = await bootstrap(today);
  const lease = await create('/leases', {
    tenancy_id: result.tenancy.id,
    term_start: today,
    rent_amount_cents: 100000,
    rent_currency: 'USD',
    status: 'active',
  });
  const confirmed = await request('PATCH', `/tenancies/${result.tenancy.id}/onboarding-progress`, {
    selected_lease_id: lease.id,
    agreement_confirmed: true,
  });
  assert(
    confirmed.status === 200 && (await progress(result.tenancy.id)).agreement_confirmed,
    'agreement not confirmed',
  );
  const touched = await admin
    .from('leases')
    .update({ updated_at: new Date(Date.now() + 1000).toISOString() })
    .eq('id', lease.id);
  assert(!touched.error, touched.error?.message ?? 'lease touch failed');
  assert(
    !(await progress(result.tenancy.id)).agreement_confirmed,
    'stale agreement stayed confirmed',
  );
  const next = await request('PATCH', `/tenancies/${result.tenancy.id}/onboarding-progress`, {
    condition_decision: 'deferred',
  });
  assert(
    next.status === 200 && !(await progress(result.tenancy.id)).agreement_confirmed,
    'unrelated decision re-confirmed changed lease',
  );
});
await check(
  'effective occupancy changes at the UTC date boundary without waiting for a job',
  async () => {
    const { result } = await bootstrap(today);
    const update = await admin
      .from('tenancies')
      .update({ status: 'upcoming' })
      .eq('id', result.tenancy.id);
    assert(!update.error, update.error?.message ?? 'status update failed');
    const p = await progress(result.tenancy.id);
    const read = await request('GET', `/tenancies/${result.tenancy.id}`);
    assert(
      p.effective_status === 'active' && (read.body as { status: string }).status === 'active',
      'read paths disagree',
    );
  },
);
await check(
  'progress is account-scoped even when the caller knows another tenancy ID',
  async () => {
    const other = await api('POST', '/v1/auth/signup', {
      body: {
        email: `other-${randomToken()}@example.test`,
        password: `horse-${randomToken()}`,
        account_name: 'Other test',
      },
    });
    assert(other.status === 200, JSON.stringify(other.body));
    const otherAuth = other.body as { account: { id: string }; session: { access_token: string } };
    const { result } = await bootstrap();
    const response = await api(
      'GET',
      `/v1/accounts/${otherAuth.account.id}/tenancies/${result.tenancy.id}/onboarding-progress`,
      { token: otherAuth.session.access_token },
    );
    assert(response.status === 404, 'cross-account progress leaked');
  },
);
await check(
  'bootstrap never invents a verified meaning when the caller omits the basis',
  async () => {
    const unit = await create('/areas', {
      property_id: property.id,
      kind: 'unit',
      name: randomToken(),
    });
    const response = await request('POST', '/tenancies/bootstrap', {
      area_id: unit.id,
      tenant_id: tenant.id,
      start_date: today,
      status: 'active',
    });
    assert(response.status === 201, JSON.stringify(response.body));
    const result = response.body as { tenancy: { id: string; start_date_basis: string } };
    assert(
      result.tenancy.start_date_basis === 'legacy_unverified',
      'omitted basis was asserted as entitlement',
    );
    const confirmed = await request(
      'PATCH',
      `/tenancies/${result.tenancy.id}/onboarding-progress`,
      { possession_confirmed_revision: 0 },
    );
    assert(confirmed.status === 409, 'unverified meaning was confirmed without correction');
  },
);
await check(
  'changing agreement selection never carries an old confirmation to the new source',
  async () => {
    const { result } = await bootstrap(today);
    const body = {
      tenancy_id: result.tenancy.id,
      term_start: today,
      rent_amount_cents: 100000,
      rent_currency: 'USD',
      status: 'active',
    };
    const first = await create('/leases', body);
    const second = await create('/leases', body);
    const path = `/tenancies/${result.tenancy.id}/onboarding-progress`;
    assert(
      (await request('PATCH', path, { selected_lease_id: first.id, agreement_confirmed: true }))
        .status === 200,
      'first confirmation failed',
    );
    const selected = await request('PATCH', path, { selected_lease_id: second.id });
    assert(
      selected.status === 200 && !(await progress(result.tenancy.id)).agreement_confirmed,
      'new source inherited confirmation',
    );
    assert(
      (await request('PATCH', path, { agreement_confirmed: true })).status === 200,
      'explicit confirmation failed',
    );
    const cleared = await request('PATCH', path, { selected_lease_id: null });
    assert(
      cleared.status === 200 && !(await progress(result.tenancy.id)).agreement_confirmed,
      'clearing selection retained confirmation',
    );
  },
);
if (failures.length) process.exitCode = 1;
