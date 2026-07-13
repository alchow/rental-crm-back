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
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { _resetIntakeIpBucketsForTests } = await import('../src/admin/intake');
await _resetIntakeIpBucketsForTests();
const { buildApp } = await import('../src/app');

const app = buildApp();

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
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = `maintenance-reporter-${crypto.randomUUID()}`;
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
function assertStatus(response: ApiResp, expected: number, context: string): unknown {
  if (response.status !== expected) {
    throw new Error(
      `${context}: expected ${expected}, got ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

interface UserFixture {
  userId: string;
  token: string;
  accountId: string;
  propertyId: string;
  areaId: string;
  tenancyId: string;
  tenantId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const signup = assertStatus(
    await api('POST', '/v1/auth/signup', {
      body: {
        email: `maint-report-${label}-${rnd()}@example.test`,
        password: `correct-horse-battery-${rnd()}`,
        account_name: `Reporter ${label}`,
      },
    }),
    200,
    `signup ${label}`,
  ) as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  const post = async <T>(path: string, body: unknown): Promise<T> =>
    assertStatus(
      await api('POST', path, { token: signup.session.access_token, body }),
      201,
      path,
    ) as T;
  const property = await post<{ id: string }>(`/v1/accounts/${signup.account.id}/properties`, {
    name: `${label} property`,
  });
  const area = await post<{ id: string }>(`/v1/accounts/${signup.account.id}/areas`, {
    property_id: property.id,
    kind: 'unit',
    name: `${label} unit`,
  });
  const tenancy = await post<{ id: string }>(`/v1/accounts/${signup.account.id}/tenancies`, {
    area_id: area.id,
    start_date: '2026-01-01',
    status: 'active',
  });
  const tenant = await post<{ id: string }>(`/v1/accounts/${signup.account.id}/tenants`, {
    full_name: `${label} Tenant`,
  });
  await post(`/v1/accounts/${signup.account.id}/tenancies/${tenancy.id}/members`, {
    tenant_id: tenant.id,
    role: 'primary',
  });
  return {
    userId: signup.user.id,
    token: signup.session.access_token,
    accountId: signup.account.id,
    propertyId: property.id,
    areaId: area.id,
    tenancyId: tenancy.id,
    tenantId: tenant.id,
  };
}

interface ReportedBy {
  source: string;
  interaction_id: string;
  party_type: string;
  party_id: string | null;
  label: string | null;
  address: string | null;
  channel: string;
  reported_at: string;
  attestation: string | null;
}
interface MaintenanceRow {
  id: string;
  title: string;
  description: string | null;
  reported_by: ReportedBy | null;
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

console.info('Maintenance reporter provenance checks');
const A = await setupUser('A');
const base = `/v1/accounts/${A.accountId}`;
let requestId = '';
let firstInteractionId = '';

await check(
  'request + report interaction + sender cast commit and read as one provenance chain',
  async () => {
    const created = assertStatus(
      await api('POST', `${base}/maintenance-requests`, {
        token: A.token,
        body: {
          area_id: A.areaId,
          title: 'Radiator stopped heating',
          description: 'Radiator is cold even when the valve is open.',
          severity: 'urgent',
          report: {
            party_type: 'tenant',
            party_id: A.tenantId,
            label: 'A Tenant',
            address: '+14155550123',
            channel: 'phone',
            reported_at: '2026-07-10T16:30:00.000Z',
            body: 'The bedroom radiator has been cold since last night.',
          },
        },
      }),
      201,
      'create with report',
    ) as MaintenanceRow;
    requestId = created.id;
    if (created.description !== 'Radiator is cold even when the valve is open.') {
      throw new Error(`description was rewritten: ${created.description}`);
    }
    const report = created.reported_by;
    if (!report) throw new Error('reported_by missing');
    firstInteractionId = report.interaction_id;
    if (
      report.source !== 'interaction' ||
      report.party_type !== 'tenant' ||
      report.party_id !== A.tenantId ||
      report.label !== 'A Tenant' ||
      report.address !== '+14155550123' ||
      report.channel !== 'phone' ||
      report.reported_at !== '2026-07-10T16:30:00+00:00' ||
      report.attestation !== 'attested'
    ) {
      throw new Error(`wrong reported_by: ${JSON.stringify(report)}`);
    }

    const interaction = assertStatus(
      await api('GET', `${base}/interactions/${report.interaction_id}`, { token: A.token }),
      200,
      'get source interaction',
    ) as {
      maintenance_request_id: string;
      body: string;
      participants: Array<{ role: string; party_id: string; source: string }>;
    };
    if (interaction.maintenance_request_id !== created.id)
      throw new Error('interaction not linked to request');
    if (interaction.body !== 'The bedroom radiator has been cold since last night.') {
      throw new Error(`source wording lost: ${interaction.body}`);
    }
    if (
      interaction.participants.length !== 1 ||
      interaction.participants[0]?.role !== 'sender' ||
      interaction.participants[0]?.party_id !== A.tenantId ||
      interaction.participants[0]?.source !== 'capture'
    ) {
      throw new Error(`sender cast wrong: ${JSON.stringify(interaction.participants)}`);
    }
  },
);

await check('GET, list, and PATCH derive the same immutable first report', async () => {
  const get = assertStatus(
    await api('GET', `${base}/maintenance-requests/${requestId}`, { token: A.token }),
    200,
    'get request',
  ) as MaintenanceRow;
  if (get.reported_by?.interaction_id !== firstInteractionId)
    throw new Error('GET changed reporter source');

  const list = assertStatus(
    await api('GET', `${base}/maintenance-requests?limit=100`, { token: A.token }),
    200,
    'list requests',
  ) as { data: MaintenanceRow[] };
  const listed = list.data.find((row) => row.id === requestId);
  if (listed?.reported_by?.interaction_id !== firstInteractionId)
    throw new Error('list changed reporter source');

  // A later-captured inbound entry is useful journal evidence, but it is not
  // the original captured report and must not replace provenance even when
  // its claimed occurred_at is backdated before the report.
  assertStatus(
    await api('POST', `${base}/interactions`, {
      token: A.token,
      body: {
        party_type: 'tenant',
        party_id: A.tenantId,
        party_label: 'A Tenant',
        channel: 'sms',
        direction: 'inbound',
        body: 'I first noticed it two days earlier.',
        occurred_at: '2026-07-08T09:00:00.000Z',
        maintenance_request_id: requestId,
        area_id: A.areaId,
      },
    }),
    201,
    'later interaction',
  );

  const patched = assertStatus(
    await api('PATCH', `${base}/maintenance-requests/${requestId}`, {
      token: A.token,
      body: { description: 'Valve checked; technician required.' },
    }),
    200,
    'patch request',
  ) as MaintenanceRow;
  if (patched.reported_by?.interaction_id !== firstInteractionId) {
    throw new Error('PATCH response replaced the original report');
  }
});

await check('legacy-compatible create without report returns reported_by=null', async () => {
  const created = assertStatus(
    await api('POST', `${base}/maintenance-requests`, {
      token: A.token,
      body: {
        area_id: A.areaId,
        title: 'Landlord-observed loose handle',
        severity: 'routine',
      },
    }),
    201,
    'create without report',
  ) as MaintenanceRow;
  if (created.reported_by !== null)
    throw new Error(`expected null reporter: ${JSON.stringify(created.reported_by)}`);
});

await check(
  'tenant intake automatically reads as tenant-reported from its source interaction',
  async () => {
    const minted = assertStatus(
      await api('POST', `${base}/tenancies/${A.tenancyId}/intake-tokens`, { token: A.token }),
      201,
      'mint intake token',
    ) as { secret: string };
    const intake = assertStatus(
      await api('POST', `/v1/intake/${minted.secret}`, {
        body: {
          title: `Intake leak ${rnd()}`,
          description: 'Water under the kitchen sink.',
          severity: 'urgent',
          occurred_at: '2026-07-09T08:15:00.000Z',
        },
      }),
      201,
      'submit intake',
    ) as { maintenance_request_id: string; interaction_id: string };
    const request = assertStatus(
      await api('GET', `${base}/maintenance-requests/${intake.maintenance_request_id}`, {
        token: A.token,
      }),
      200,
      'get intake request',
    ) as MaintenanceRow;
    const report = request.reported_by;
    if (
      !report ||
      report.interaction_id !== intake.interaction_id ||
      report.party_type !== 'tenant' ||
      report.channel !== 'in_app' ||
      report.reported_at !== '2026-07-09T08:15:00+00:00'
    ) {
      throw new Error(`intake reporter not derived: ${JSON.stringify(report)}`);
    }
  },
);

if (failures.length > 0) {
  console.error(`\n${failures.length} maintenance-reporter failure(s):`);
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.detail}`);
  process.exit(1);
}

console.info('\nOK: maintenance reporter provenance checks all green');
