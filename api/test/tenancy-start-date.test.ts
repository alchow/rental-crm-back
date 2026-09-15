// ----------------------------------------------------------------------------
// Tenancy possession-date API transition and audited correction flow.
//
// Requires the local Supabase stack (`supabase start` in db/), same as the
// other integration suites.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';

interface SupabaseStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function readSupabaseStatus(): SupabaseStatus {
  const out = execSync('supabase status --output env --workdir db', {
    cwd: process.cwd().endsWith('/api') ? '..' : '.',
    encoding: 'utf8',
  });
  const lines = out.split('\n');
  const get = (k: string) => {
    const line = lines.find((l) => l.startsWith(k + '='));
    if (!line) throw new Error(`supabase status missing: ${k}`);
    return line.slice(k.length + 1).replace(/^"|"$/g, '');
  };
  return {
    API_URL: get('API_URL'),
    ANON_KEY: get('ANON_KEY'),
    SERVICE_ROLE_KEY: get('SERVICE_ROLE_KEY'),
  };
}

const status = readSupabaseStatus();
process.env.NODE_ENV = 'test';
process.env.PORT = '8804';
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
const { buildApp } = await import('../src/app');

const app = buildApp();

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown }
interface DateFacts {
  start_date: string;
  start_date_basis: string;
  status: string;
  date_revision: number;
}
interface DateContextBody {
  version: number;
  facts: DateFacts;
  context_fingerprint: string;
}
interface DatePreviewBody {
  current: DateFacts;
  proposed: DateFacts;
  context_fingerprint: string;
  blockers: string[];
  financial_review: { live_charges: number; live_payments: number };
}
interface DateRecordBody {
  tenancy: { start_date: string };
  record: { id: string; kind: string };
}
interface DateHistoryBody {
  data: Array<{ id: string; [key: string]: unknown }>;
  next_cursor: string | null;
}
interface ErrorBody {
  error?: { details?: { correction_endpoint?: string } };
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase()) && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface Failure { name: string; detail: string }
const failures: Failure[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.info(`  PASS  ${name}`); }
  catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}
function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}
function errorCode(r: ApiResp): string | undefined {
  return (r.body as { error?: { code?: string } }).error?.code;
}

// --- fixture ------------------------------------------------------------------

const email = `startdate-${rnd()}@example.test`;
const su = await api('POST', '/v1/auth/signup', {
  body: { email, password: `correct-horse-battery-${rnd()}`, account_name: 'StartDate Acct' },
});
if (su.status !== 200) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.body)}`);
const sub = su.body as { account: { id: string }; session: { access_token: string } };
const token = sub.session.access_token;
const acct = sub.account.id;

const post = async <T>(p: string, body: unknown): Promise<T> => {
  const r = await api('POST', `/v1/accounts/${acct}${p}`, { token, body });
  if (r.status !== 201) throw new Error(`POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
};
const patchTenancy = (id: string, body: unknown): Promise<ApiResp> =>
  api('PATCH', `/v1/accounts/${acct}/tenancies/${id}`, { token, body });

const property = await post<{ id: string }>('/properties', { name: 'StartDate prop' });
const area = await post<{ id: string }>('/areas', { property_id: property.id, kind: 'unit', name: 'Unit SD' });
// The Jordan Kim shape: created with the wrong (earlier) date, already active.
const tenancy = await post<{ id: string }>('/tenancies', {
  area_id: area.id, start_date: '2026-01-07', status: 'active',
});

// --- tests --------------------------------------------------------------------

console.info('tenancy possession-date checks');

let context: DateContextBody;
let preview: DatePreviewBody;
await check('(0) creating a future actual move-in fact is rejected', async () => {
  const r = await api('POST', `/v1/accounts/${acct}/tenancies`, {
    token,
    body: {
      area_id: area.id,
      start_date: '2027-01-01',
      actual_move_in_date: '2027-01-01',
      status: 'upcoming',
    },
  });
  assertEq(r.status, 400, 'create status');
  assertEq(errorCode(r), 'invalid_request', 'schema validation code');
});
await check('(1) changed legacy PATCH directs the caller to the audited command', async () => {
  const r = await patchTenancy(tenancy.id, { start_date: '2026-01-15', status: 'upcoming' });
  assertEq(r.status, 409, 'patch status');
  assertEq(errorCode(r), 'date_correction_required', 'error code');
  const details = (r.body as ErrorBody).error?.details;
  if (!String(details?.correction_endpoint).endsWith(`/tenancies/${tenancy.id}/date-corrections`)) {
    throw new Error(`missing correction endpoint: ${JSON.stringify(r.body)}`);
  }
  const g = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancy.id}`, { token });
  assertEq((g.body as { status: string }).status, 'active', 'mixed PATCH must be atomic');
});

await check('(2) unchanged legacy start and status/end-only PATCH remain compatible', async () => {
  assertEq((await patchTenancy(tenancy.id, { start_date: '2026-01-07' })).status, 200, 'no-op start');
  assertEq((await patchTenancy(tenancy.id, { end_date: null, status: 'active' })).status, 200, 'ordinary patch');
});

await post('/charges', {
  tenancy_id: tenancy.id, type: 'rent', amount_cents: 100000, currency: 'USD', due_date: '2026-02-01',
});
await post('/payments', {
  tenancy_id: tenancy.id, amount_cents: 5000, currency: 'USD',
  received_at: '2026-02-02T00:00:00.000Z', method: 'cash',
});

await check('(3) context distinguishes possession from selected lease and rent dates', async () => {
  const r = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancy.id}/date-context`, { token });
  assertEq(r.status, 200, 'context status');
  context = r.body as DateContextBody;
  assertEq(context.version, 1, 'context version');
  assertEq(context.facts.start_date, '2026-01-07', 'possession start');
  assertEq(context.facts.start_date_basis, 'legacy_unverified', 'basis');
  if (!context.context_fingerprint) throw new Error('missing context fingerprint');
});

await check('(4) preview reports money for review without blocking correction', async () => {
  const r = await api('POST', `/v1/accounts/${acct}/tenancies/${tenancy.id}/date-corrections/preview`, {
    token, body: { changes: { start_date: '2026-01-15', start_date_basis: 'possession_entitlement' } },
  });
  assertEq(r.status, 200, 'preview status');
  preview = r.body as DatePreviewBody;
  assertEq(preview.proposed.start_date, '2026-01-15', 'proposed start');
  assertEq(preview.financial_review.live_charges, 1, 'live charges');
  assertEq(preview.financial_review.live_payments, 1, 'live payments');
  assertEq(preview.blockers.length, 0, 'blockers');
});

let correctionRecordId = '';
await check('(5) correction succeeds with money and appends history', async () => {
  const r = await api('POST', `/v1/accounts/${acct}/tenancies/${tenancy.id}/date-corrections`, {
    token,
    body: {
      changes: { start_date: '2026-01-15', start_date_basis: 'possession_entitlement' },
      expected_date_revision: preview.current.date_revision,
      expected_context_fingerprint: preview.context_fingerprint,
      expected_resulting_status: preview.proposed.status,
      reason_code: 'data_entry_error',
      reason_note: 'The possession record was entered eight days early.',
    },
  });
  assertEq(r.status, 200, 'correction status');
  const body = r.body as DateRecordBody;
  assertEq(body.tenancy.start_date, '2026-01-15', 'corrected start');
  assertEq(body.record.kind, 'correction', 'record kind');
  correctionRecordId = body.record.id;
});

await check('(6) stale preview fails with date_context_changed', async () => {
  const r = await api('POST', `/v1/accounts/${acct}/tenancies/${tenancy.id}/date-corrections`, {
    token,
    body: {
      changes: { start_date: '2026-01-20' },
      expected_date_revision: preview.current.date_revision,
      expected_context_fingerprint: preview.context_fingerprint,
      expected_resulting_status: preview.proposed.status,
      reason_code: 'data_entry_error', reason_note: 'Stale correction attempt.',
    },
  });
  assertEq(r.status, 409, 'stale status');
  assertEq(errorCode(r), 'date_context_changed', 'stale code');
});

await check('(7) explanation records the current selected context without mutation', async () => {
  const current = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancy.id}/date-context`, { token });
  assertEq(current.status, 200, 'context status');
  const fingerprint = (current.body as DateContextBody).context_fingerprint;
  const r = await api('POST', `/v1/accounts/${acct}/tenancies/${tenancy.id}/date-explanations`, {
    token,
    body: {
      expected_context_fingerprint: fingerprint,
      reason_code: 'other',
      reason_note: 'The lease and rent schedule dates are independently documented.',
    },
  });
  assertEq(r.status, 200, 'explanation status');
  assertEq((r.body as DateRecordBody).record.kind, 'explanation', 'record kind');
  assertEq((r.body as DateRecordBody).tenancy.start_date, '2026-01-15', 'unchanged start');
});

await check('(8) history is paginated and omits idempotency internals', async () => {
  const r = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancy.id}/date-history?limit=1`, { token });
  assertEq(r.status, 200, 'history status');
  const body = r.body as DateHistoryBody;
  assertEq(body.data.length, 1, 'page size');
  if (!body.next_cursor) throw new Error('expected next cursor');
  const firstRecord = body.data[0];
  if (!firstRecord) throw new Error('missing first history record');
  if ('request_key' in firstRecord || 'request_fingerprint' in firstRecord || 'response_body' in firstRecord) {
    throw new Error('history exposed private idempotency fields');
  }
  const page2 = await api('GET', `/v1/accounts/${acct}/tenancies/${tenancy.id}/date-history?limit=10&cursor=${encodeURIComponent(body.next_cursor)}`, { token });
  assertEq(page2.status, 200, 'second page status');
  const bothPages = [...body.data, ...(page2.body as DateHistoryBody).data];
  if (!bothPages.some((record) => record.id === correctionRecordId)) {
    throw new Error('correction missing from history');
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} start-date failure(s):`);
  for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.info('\nOK: tenancy start_date correction checks all green');
