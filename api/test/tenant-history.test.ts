import {
  configureIntegrationEnv,
  createApiClient,
  assertStatus,
  assert,
} from './helpers/integration';
configureIntegrationEnv('8799');
const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { getAdminClient, _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');
const api = createApiClient(buildApp());
const admin = getAdminClient();
const signed = assertStatus(
  await api('POST', '/v1/auth/signup', {
    body: {
      email: `history-${crypto.randomUUID()}@example.test`,
      password: `long-password-${crypto.randomUUID()}`,
      account_name: 'History tests',
    },
  }),
  200,
  'signup',
) as { account: { id: string }; user: { id: string }; session: { access_token: string } };
const account = signed.account.id;
const token = signed.session.access_token;
const tenant = assertStatus(
  await api('POST', `/v1/accounts/${account}/tenants`, { token, body: { full_name: 'Alb' } }),
  201,
  'tenant',
) as { id: string };
const platform = await admin.from('platform_numbers').insert({
  account_id: account,
  number: '+1909' + String(Date.now()).slice(-7),
  provider: 'test',
  capabilities: ['sms', 'mms'],
});
if (platform.error) throw new Error(platform.error.message);
const thread = assertStatus(
  await api('POST', `/v1/accounts/${account}/comms/threads`, {
    token,
    body: {
      kind: 'bridged_tenant',
      mode: 'bridged',
      channel: 'sms',
      participants: [{ party_type: 'tenant', party_id: tenant.id, address: '+16175551234' }],
    },
  }),
  201,
  'thread',
) as { id: string };
const roots = Array.from({ length: 505 }, (_, index) => ({
  id: crypto.randomUUID(),
  account_id: account,
  actor: `user:${signed.user.id}`,
  author_type: 'tenant' as const,
  kind: 'communication' as const,
  channel: 'sms' as const,
  direction: 'inbound' as const,
  party_type: 'tenant' as const,
  party_id: tenant.id,
  body: `Captured ${index}`,
  thread_id: thread.id,
  occurred_at: '2026-10-20T12:00:00Z',
}));
const inserted = await admin.from('interactions').insert(roots);
if (inserted.error) throw new Error(inserted.error.message);
assertStatus(
  await api('POST', `/v1/accounts/${account}/interactions`, {
    token,
    body: {
      channel: 'sms',
      party_type: 'tenant',
      party_id: tenant.id,
      body: 'Manual SMS note',
      occurred_at: '2026-10-19T10:00:00Z',
    },
  }),
  201,
  'manual note',
);
const path = `/v1/accounts/${account}/comms/tenants/${tenant.id}/messages`;
type Page = {
  data: { id: string; body: string; participants: unknown[] }[];
  snapshot: string;
  next_cursor: string | null;
};
let page = assertStatus(
  await api('GET', `${path}?limit=100`, { token }),
  200,
  'first page',
) as Page;
const seen = [...page.data];
const snapshot = page.snapshot;
while (page.next_cursor) {
  page = assertStatus(
    await api(
      'GET',
      `${path}?limit=100&snapshot=${encodeURIComponent(snapshot)}&cursor=${encodeURIComponent(page.next_cursor)}`,
      { token },
    ),
    200,
    'next page',
  ) as Page;
  seen.push(...page.data);
}
assert(
  seen.length === 505 && new Set(seen.map((r) => r.id)).size === 505,
  `complete unique history: ${seen.length}`,
);
assert(
  seen.every((r) => r.body !== 'Manual SMS note'),
  'manual SMS excluded',
);
assert(
  seen.map((r) => r.id).join() ===
    seen
      .map((r) => r.id)
      .sort()
      .reverse()
      .join(),
  'equal-time deterministic descending IDs',
);
assertStatus(
  await api('GET', `${path}?cursor=garbage&snapshot=${encodeURIComponent(snapshot)}`, { token }),
  400,
  'invalid cursor',
);
assertStatus(
  await api('GET', `/v1/accounts/${account}/comms/tenants/${crypto.randomUUID()}/messages`, {
    token,
  }),
  404,
  'foreign/missing tenant',
);
const extra = { ...roots[0]!, id: crypto.randomUUID(), body: 'Captured after snapshot' };
const late = await admin.from('interactions').insert(extra);
if (late.error) throw new Error(late.error.message);
const frozen = assertStatus(
  await api('GET', `${path}?snapshot=${encodeURIComponent(snapshot)}&limit=100`, { token }),
  200,
  'snapshot repeat',
) as Page;
assert(!frozen.data.some((r) => r.id === extra.id), 'snapshot excludes later arrivals');
const fresh = assertStatus(
  await api('GET', `${path}?limit=100`, { token }),
  200,
  'refresh',
) as Page;
assert(fresh.snapshot !== snapshot, 'refresh obtains new snapshot');
const stranger = assertStatus(
  await api('POST', '/v1/auth/signup', {
    body: {
      email: `other-${crypto.randomUUID()}@example.test`,
      password: `long-password-${crypto.randomUUID()}`,
      account_name: 'Other account',
    },
  }),
  200,
  'other signup',
) as { session: { access_token: string } };
const denied = await api('GET', path, { token: stranger.session.access_token });
assert(denied.status === 403 || denied.status === 404, 'cross-account read denied');
const otherTenant = assertStatus(
  await api('POST', `/v1/accounts/${account}/tenants`, {
    token,
    body: { full_name: 'Other tenant' },
  }),
  201,
  'other tenant',
) as { id: string };
const castOnlyId = crypto.randomUUID();
const scopedRoots = await admin.from('interactions').insert([
  {
    ...roots[0]!,
    id: castOnlyId,
    party_type: 'unspecified',
    party_id: null,
    body: 'Cast-only person match',
  },
  {
    ...roots[0]!,
    id: crypto.randomUUID(),
    party_id: otherTenant.id,
    body: 'Other tenant only - exclude',
  },
]);
if (scopedRoots.error) throw new Error(scopedRoots.error.message);
const castInsert = await admin.from('interaction_participants').insert({
  account_id: account,
  interaction_id: castOnlyId,
  role: 'recipient',
  party_type: 'tenant',
  party_id: tenant.id,
  label: 'Alb',
  source: 'comms',
});
if (castInsert.error) throw new Error(castInsert.error.message);
const correction = assertStatus(
  await api('POST', `/v1/accounts/${account}/interactions`, {
    token,
    body: {
      corrects_id: roots[0]!.id,
      correction_kind: 'amend',
      body: 'Correction retained separately',
    },
  }),
  201,
  'correct captured record',
) as { id: string };
let correctedHistory = assertStatus(
  await api('GET', `${path}?limit=100`, { token }),
  200,
  'history with correction',
) as Page;
let foundCorrection = correctedHistory.data.some((r) => r.id === correction.id);
let foundCast = correctedHistory.data.some((r) => r.id === castOnlyId);
let foundOther = correctedHistory.data.some((r) => r.body === 'Other tenant only - exclude');
while (correctedHistory.next_cursor) {
  correctedHistory = assertStatus(
    await api(
      'GET',
      `${path}?limit=100&snapshot=${encodeURIComponent(correctedHistory.snapshot)}&cursor=${encodeURIComponent(correctedHistory.next_cursor)}`,
      { token },
    ),
    200,
    'correction page',
  ) as Page;
  foundCorrection ||= correctedHistory.data.some((r) => r.id === correction.id);
  foundCast ||= correctedHistory.data.some((r) => r.id === castOnlyId);
  foundOther ||= correctedHistory.data.some((r) => r.body === 'Other tenant only - exclude');
}
assert(foundCorrection, 'correction is explicit in person history');
assert(
  foundCast && !foundOther,
  'message-time cast includes the person without pulling in the whole thread',
);
const original = await admin.from('interactions').select('body').eq('id', roots[0]!.id).single();
assert(original.data?.body === 'Captured 0', 'original captured body unchanged');
const { loadTenantCommunications } = await import('../src/admin/export-pdf/tenant-communications');
const exported = await loadTenantCommunications(
  {
    accountId: account,
    tenantId: tenant.id,
    exporter: signed.user.id,
    timezone: 'America/Los_Angeles',
  },
  new Date().toISOString(),
);
assert(
  exported.entries.length === 509,
  `export includes all pages and manual note: ${exported.entries.length}`,
);
const { renderTenantCommunications } =
  await import('../src/admin/export-pdf/tenant-communications');
const bytes = await renderTenantCommunications(
  {
    accountId: account,
    tenantId: tenant.id,
    exporter: signed.user.id,
    timezone: 'America/Los_Angeles',
  },
  new Date(),
  { ok: true, message: 'Verified in test', broken_at: null, broken_event_no: null },
);
assert(bytes.length > 1000, 'PDF rendered');
await import('node:fs/promises').then((fs) =>
  fs.writeFile('/tmp/tenant-communications-test.pdf', bytes),
);
console.info(
  'PASS tenant history: 505 captured messages, manual note separation, cursors, export, PDF',
);
const queued = assertStatus(
  await api('POST', `/v1/accounts/${account}/evidence-exports`, {
    token,
    body: { tenant_id: tenant.id, timezone: 'America/Los_Angeles' },
  }),
  202,
  'queue person export',
) as { id: string };
let job: { status: string; attachment_id: string | null; error?: string } | undefined;
for (let attempt = 0; attempt < 60; attempt++) {
  job = assertStatus(
    await api('GET', `/v1/accounts/${account}/evidence-exports/${queued.id}`, { token }),
    200,
    'poll person export',
  ) as typeof job;
  if (job?.status === 'done' || job?.status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert(
  job?.status === 'done' && job.attachment_id,
  `person export completes through existing worker: ${JSON.stringify(job)}`,
);
const download = await api(
  'GET',
  `/v1/accounts/${account}/evidence-exports/${queued.id}/download`,
  { token, responseType: 'bytes' },
);
assert(
  download.status === 200 && download.body instanceof Uint8Array && download.body.length > 1000,
  'protected PDF download',
);
console.info('PASS person export queue, completion, integrity metadata and protected download');
