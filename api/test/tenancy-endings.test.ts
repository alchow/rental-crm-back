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
  const get = (key: string) => {
    const line = out.split('\n').find((candidate) => candidate.startsWith(`${key}=`));
    if (!line) throw new Error(`supabase status missing: ${key}`);
    return line.slice(key.length + 1).replace(/^"|"$/g, '');
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
const { createClient } = await import('@supabase/supabase-js');

const app = buildApp();
const admin = getAdminClient();

interface ApiResp {
  status: number;
  body: unknown;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    headers['idempotency-key'] = `tenancy-end-${crypto.randomUUID()}`;
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const response = await app.fetch(new Request(`http://test${path}`, init));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function rnd(): string {
  return Math.random().toString(36).slice(2, 10);
}

const signup = await api('POST', '/v1/auth/signup', {
  body: {
    email: `tenancy-end-${rnd()}@example.test`,
    password: `correct-horse-battery-${rnd()}`,
    account_name: 'Tenancy ending test',
  },
});
if (signup.status !== 200) throw new Error(`signup failed: ${JSON.stringify(signup.body)}`);
const signupBody = signup.body as {
  user: { id: string };
  account: { id: string };
  session: { access_token: string };
};
const accountId = signupBody.account.id;
const token = signupBody.session.access_token;

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await api('POST', path, { token, body });
  if (response.status !== 201) {
    throw new Error(`POST ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body as T;
}

const property = await post<{ id: string }>(`/v1/accounts/${accountId}/properties`, {
  name: 'Ending property',
});
const area = await post<{ id: string }>(`/v1/accounts/${accountId}/areas`, {
  property_id: property.id,
  kind: 'unit',
  name: 'Unit A',
});

async function createTenancy(
  start_date: string,
  statusValue: 'upcoming' | 'active' | 'holdover',
): Promise<{ id: string }> {
  return post(`/v1/accounts/${accountId}/tenancies`, {
    area_id: area.id,
    start_date,
    status: statusValue,
  });
}

async function seedSchedule(tenancyId: string, startDate: string): Promise<string> {
  const result = await admin
    .from('rent_schedules')
    .insert({
      account_id: accountId,
      tenancy_id: tenancyId,
      kind: 'rent',
      amount_cents: 150000,
      currency: 'USD',
      due_day: 1,
      start_date: startDate,
    })
    .select('id')
    .single();
  if (result.error || !result.data) throw new Error(`seed schedule: ${result.error?.message}`);
  return result.data.id;
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

console.info('Atomic tenancy-ending checks');

let cancelledTenancyId = '';
let cancellationEndingId = '';

await check(
  'cancel-before-move-in preserves the cancellation date and deletes an unbilled schedule',
  async () => {
    const tenancy = await createTenancy('2030-08-15', 'upcoming');
    cancelledTenancyId = tenancy.id;
    const scheduleId = await seedSchedule(tenancy.id, '2030-08-15');

    const response = await api('POST', `/v1/accounts/${accountId}/tenancies/${tenancy.id}/end`, {
      token,
      body: {
        kind: 'cancelled_before_move_in',
        effective_date: '2030-08-01',
        initiated_by: 'tenant',
        reason_code: 'applicant_withdrew',
        reason_note: 'Plans changed before possession.',
      },
    });
    if (response.status !== 200) {
      throw new Error(`end returned ${response.status}: ${JSON.stringify(response.body)}`);
    }
    const body = response.body as {
      tenancy: { status: string; end_date: string };
      ending: { id: string; effective_date: string; kind: string; created_by: string };
    };
    cancellationEndingId = body.ending.id;
    if (body.tenancy.status !== 'ended') throw new Error('tenancy was not ended');
    if (body.tenancy.end_date !== '2030-08-15') {
      throw new Error(`tenancy end_date must preserve its invariant, got ${body.tenancy.end_date}`);
    }
    if (body.ending.effective_date !== '2030-08-01') {
      throw new Error(`actual cancellation date was lost: ${body.ending.effective_date}`);
    }
    if (body.ending.kind !== 'cancelled_before_move_in') throw new Error('wrong ending kind');
    if (body.ending.created_by !== signupBody.user.id)
      throw new Error('created_by is not the JWT user');

    const schedule = await admin
      .from('rent_schedules')
      .select('deleted_at')
      .eq('id', scheduleId)
      .single();
    if (schedule.error || !schedule.data?.deleted_at) {
      throw new Error(`unbilled schedule was not soft-deleted: ${schedule.error?.message}`);
    }
  },
);

await check('ending is readable, audited, immutable, and repeat-safe', async () => {
  const get = await api('GET', `/v1/accounts/${accountId}/tenancies/${cancelledTenancyId}/ending`, {
    token,
  });
  if (get.status !== 200) throw new Error(`GET ending returned ${get.status}`);
  if ((get.body as { id: string }).id !== cancellationEndingId)
    throw new Error('GET returned wrong ending');

  const event = await admin
    .from('events')
    .select('actor, entity_id, event_type')
    .eq('account_id', accountId)
    .eq('entity_type', 'tenancy_endings')
    .eq('entity_id', cancellationEndingId)
    .single();
  if (event.error || !event.data)
    throw new Error(`ending audit event missing: ${event.error?.message}`);
  if (event.data.actor !== `user:${signupBody.user.id}` || event.data.event_type !== 'inserted') {
    throw new Error(`wrong ending audit attribution: ${JSON.stringify(event.data)}`);
  }

  const repeat = await api(
    'POST',
    `/v1/accounts/${accountId}/tenancies/${cancelledTenancyId}/end`,
    { token, body: { kind: 'cancelled_before_move_in', effective_date: '2030-08-01' } },
  );
  if (repeat.status !== 409) throw new Error(`repeat expected 409, got ${repeat.status}`);
  const repeatCode = (repeat.body as { error: { code: string } }).error.code;
  if (repeatCode !== 'tenancy_already_ended') throw new Error(`wrong repeat code: ${repeatCode}`);

  const userSb = createClient(status.API_URL, status.ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const directInsert = await userSb.from('tenancy_endings').insert({
    account_id: accountId,
    tenancy_id: cancelledTenancyId,
    kind: 'cancelled_before_move_in',
    effective_date: '2030-08-01',
    reason_code: 'other',
  });
  if (!directInsert.error || directInsert.error.code !== '23514') {
    throw new Error(`direct insert should hit workflow guard: ${directInsert.error?.code}`);
  }
  const mutate = await userSb
    .from('tenancy_endings')
    .update({ reason_note: 'rewritten history' })
    .eq('id', cancellationEndingId);
  if (!mutate.error || mutate.error.code !== '42501') {
    throw new Error(`direct update should lack privilege: ${mutate.error?.code}`);
  }
});

await check(
  'normal ending truncates current schedules and soft-deletes unbilled future schedules',
  async () => {
    const tenancy = await createTenancy('2026-01-01', 'active');
    const currentScheduleId = await seedSchedule(tenancy.id, '2026-01-01');
    const futureScheduleId = await seedSchedule(tenancy.id, '2027-01-01');

    const response = await api('POST', `/v1/accounts/${accountId}/tenancies/${tenancy.id}/end`, {
      token,
      body: {
        kind: 'ended',
        effective_date: '2026-07-31',
        initiated_by: 'mutual',
        reason_code: 'mutual_surrender',
      },
    });
    if (response.status !== 200) throw new Error(`normal end returned ${response.status}`);

    const schedules = await admin
      .from('rent_schedules')
      .select('id, end_date, deleted_at')
      .in('id', [currentScheduleId, futureScheduleId]);
    if (schedules.error) throw new Error(`read schedules: ${schedules.error.message}`);
    const current = schedules.data?.find((row) => row.id === currentScheduleId);
    const future = schedules.data?.find((row) => row.id === futureScheduleId);
    if (current?.end_date !== '2026-07-31' || current.deleted_at !== null) {
      throw new Error(`current schedule not truncated: ${JSON.stringify(current)}`);
    }
    if (!future?.deleted_at)
      throw new Error(`future schedule not soft-deleted: ${JSON.stringify(future)}`);
  },
);

await check(
  'a future schedule with a live charge is preserved for explicit correction',
  async () => {
    const tenancy = await createTenancy('2026-01-01', 'active');
    const scheduleId = await seedSchedule(tenancy.id, '2027-01-01');
    const charge = await admin.from('charges').insert({
      account_id: accountId,
      tenancy_id: tenancy.id,
      type: 'rent',
      amount_cents: 150000,
      currency: 'USD',
      due_date: '2027-01-01',
      period_start: '2027-01-01',
      period_end: '2027-01-31',
      source_schedule_id: scheduleId,
    });
    if (charge.error) throw new Error(`seed charge: ${charge.error.message}`);

    const response = await api('POST', `/v1/accounts/${accountId}/tenancies/${tenancy.id}/end`, {
      token,
      body: { kind: 'ended', effective_date: '2026-07-31' },
    });
    if (response.status !== 200)
      throw new Error(`end with future charge returned ${response.status}`);

    const schedule = await admin
      .from('rent_schedules')
      .select('end_date, deleted_at')
      .eq('id', scheduleId)
      .single();
    if (schedule.error || !schedule.data)
      throw new Error(`read preserved schedule: ${schedule.error?.message}`);
    if (schedule.data.deleted_at !== null || schedule.data.end_date !== null) {
      throw new Error(`charged future schedule was mutated: ${JSON.stringify(schedule.data)}`);
    }
  },
);

await check(
  'a cross-tenancy source is rejected and the workflow rolls back atomically',
  async () => {
    const target = await createTenancy('2026-01-01', 'active');
    const other = await createTenancy('2026-01-01', 'active');
    const interaction = await admin
      .from('interactions')
      .insert({
        account_id: accountId,
        actor: `user:${signupBody.user.id}`,
        party_type: 'tenant',
        channel: 'phone',
        direction: 'inbound',
        occurred_at: '2026-07-01T12:00:00Z',
        tenancy_id: other.id,
      })
      .select('id')
      .single();
    if (interaction.error || !interaction.data)
      throw new Error(`seed interaction: ${interaction.error?.message}`);

    const response = await api('POST', `/v1/accounts/${accountId}/tenancies/${target.id}/end`, {
      token,
      body: {
        kind: 'ended',
        effective_date: '2026-07-31',
        source_interaction_id: interaction.data.id,
      },
    });
    if (response.status !== 404)
      throw new Error(`cross-tenancy source expected 404, got ${response.status}`);

    const unchanged = await admin
      .from('tenancies')
      .select('status, end_date')
      .eq('id', target.id)
      .single();
    if (
      unchanged.error ||
      unchanged.data?.status !== 'active' ||
      unchanged.data.end_date !== null
    ) {
      throw new Error(
        `failed workflow partially mutated tenancy: ${JSON.stringify(unchanged.data)}`,
      );
    }
    const ending = await admin
      .from('tenancy_endings')
      .select('id', { count: 'exact', head: true })
      .eq('tenancy_id', target.id);
    if (ending.error || ending.count !== 0) throw new Error('failed workflow left an ending row');
  },
);

if (failures.length > 0) {
  console.error(`\n${failures.length} tenancy-ending failure(s):`);
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.detail}`);
  process.exit(1);
}

console.info('\nOK: atomic tenancy-ending checks all green');
