import {
  assert,
  configureIntegrationEnv,
  createApiClient,
  createCheckHarness,
  randomToken,
} from './helpers/integration';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
const stack = configureIntegrationEnv('8799');
const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { _resetAdminClientForTests, getAdminClient } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { buildApp } = await import('../src/app');
const api = createApiClient(buildApp());
const admin = getAdminClient();
const { check, failures } = createCheckHarness();
const signup = await api('POST', '/v1/auth/signup', {
  body: {
    email: `setup-v3-${randomToken()}@example.test`,
    password: `test-${randomToken()}`,
    account_name: 'Setup v3',
  },
});
assert(signup.status === 200, JSON.stringify(signup.body));
const auth = signup.body as { account: { id: string }; session: { access_token: string } };
const base = `/v1/accounts/${auth.account.id}`;
const caller = createClient(stack.API_URL, stack.ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${auth.session.access_token}` } },
  auth: { persistSession: false },
});
const pool = new pg.Pool({ connectionString: stack.DB_URL });
async function request(method: string, path: string, body?: unknown, key?: string) {
  return api(method, base + path, {
    token: auth.session.access_token,
    body,
    ...(key ? { idempotencyKey: key } : {}),
  });
}
const property = await request('POST', '/properties', { name: 'Setup v3 tests' });
assert(property.status === 201, JSON.stringify(property.body));
async function fixture() {
  const unit = await request('POST', '/areas', {
    property_id: (property.body as { id: string }).id,
    kind: 'unit',
    name: randomToken(),
  });
  assert(unit.status === 201, JSON.stringify(unit.body));
  const id = crypto.randomUUID();
  const area_id = (unit.body as { id: string }).id;
  const saved = await request('PUT', `/tenancy-setup-sessions/${id}`, {
    area_id,
    expected_revision: 0,
    payload: { screen: 'who', name: 'Unfinished' },
  });
  assert(saved.status === 200, JSON.stringify(saved.body));
  const start = '2028-02-01';
  const lease = crypto.randomUUID();
  const setup = {
    people: [
      {
        key: crypto.randomUUID(),
        full_name: 'Synthetic setup resident',
        phones: [],
        emails: [],
      },
    ],
    tenancy: { start_date: start, end_date: null },
    agreement: {
      id: lease,
      change_kind: 'new',
      term_start: start,
      term_end: null,
      rent_amount_cents: 185000,
      rent_currency: 'USD',
      deposit_amount_cents: 0,
      deposit_currency: 'USD',
      rent_due_rule: { kind: 'last_day' },
      grace_days: 45,
      late_fee_policy: { kind: 'none' },
      deposit_knowledge: 'unknown',
      terms_source: { kind: 'manual' },
    },
    billing: {
      rent: {
        decision: 'configure',
        coverage_start: start,
        regular_anchor: start,
        due_day: 31,
        billing_due_rule: { kind: 'last_day' },
        short_month_policy: 'last_day',
        amount_cents: 185000,
        currency: 'USD',
        grace_days: 45,
        late_fee_policy: { kind: 'none' },
        history_mode: 'itemized',
        charge_keys: [{ cycle_key: '2028-02', draft_key: 'feb' }],
      },
      deposit: { decision: 'defer' },
      payments: [],
      credit_allocations: [],
      explanations: [],
    },
    receipt_purposes: {},
    warning_notes: {},
  };
  return { id, area_id, setup };
}
await check('drafts create no tenancy, people, or money; stale saves are rejected', async () => {
  const f = await fixture();
  const { count } = await admin
    .from('tenancies')
    .select('id', { count: 'exact' })
    .eq('area_id', f.area_id);
  assert(count === 0, 'draft created a tenancy');
  const stale = await request('PUT', `/tenancy-setup-sessions/${f.id}`, {
    area_id: f.area_id,
    expected_revision: 0,
    payload: {},
  });
  assert(stale.status === 409, JSON.stringify(stale.body));
});
await check(
  'last-day leap-year preview is read-only; longer grace is retained; retries return one complete setup',
  async () => {
    const f = await fixture();
    const review = await request('POST', `/tenancy-setup-sessions/${f.id}/preview`, f.setup);
    assert(review.status === 200, JSON.stringify(review.body));
    const p = review.body as {
      setup_context: string;
      can_confirm: boolean;
      charge_candidates: { due_date: string }[];
    };
    assert(p.can_confirm, JSON.stringify(p));
    assert(p.charge_candidates[0]?.due_date === '2028-02-29', 'wrong leap-year due date');
    assert(
      (await admin.from('tenancies').select('id', { count: 'exact' }).eq('area_id', f.area_id))
        .count === 0,
      'preview wrote a tenancy',
    );
    const key = `setup-${randomToken()}`;
    const body = { setup: f.setup, expected_context: p.setup_context, accept_warnings: true };
    const saved = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, body, key);
    assert(saved.status === 201, JSON.stringify(saved.body));
    const retry = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, body, key);
    assert(JSON.stringify(retry.body) === JSON.stringify(saved.body), 'retry changed result');
    const t = saved.body as { tenancy_id: string; status: string };
    assert(t.status === 'upcoming', 'future tenant marked occupied');
    const schedules = await admin.from('rent_schedules').select('*').eq('tenancy_id', t.tenancy_id);
    assert(
      schedules.data?.length === 1 && schedules.data[0]?.grace_days === 45,
      'wrong recurring terms',
    );
  },
);
await check(
  'unknown-date receipt reduces current debt without inventing a receipt date',
  async () => {
    const f = await fixture();
    const setup = {
      ...f.setup,
      billing: {
        ...f.setup.billing,
        payments: [
          {
            draft_key: 'receipt',
            amount_cents: 50000,
            currency: 'USD',
            received_at: null,
            receipt_date_unknown: true,
            method: 'check',
            allocations: [],
          },
        ],
      },
    };
    const review = await request('POST', `/tenancy-setup-sessions/${f.id}/preview`, setup);
    assert(review.status === 200, JSON.stringify(review.body));
    const p = review.body as { setup_context: string };
    const saved = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, {
      setup,
      expected_context: p.setup_context,
      accept_warnings: true,
    });
    assert(saved.status === 201, JSON.stringify(saved.body));
    const id = (saved.body as { tenancy_id: string }).tenancy_id;
    const payments = await admin.from('payments').select('*').eq('tenancy_id', id);
    assert(
      payments.data?.[0]?.received_at === null && payments.data[0]?.receipt_date_unknown,
      'unknown date was fabricated',
    );
    const ledger = await request('GET', `/tenancies/${id}/ledger`);
    assert(ledger.status === 200, JSON.stringify(ledger.body));
    assert(
      (ledger.body as { totals: { total_received_cents: number } }).totals.total_received_cents ===
        50000,
      'current receipt missing',
    );
    const cutoff = await request('GET', `/tenancies/${id}/ledger?as_of=2028-03-01`);
    assert(cutoff.status === 200, JSON.stringify(cutoff.body));
    assert(
      (cutoff.body as { totals: { total_received_cents: number } }).totals.total_received_cents ===
        0,
      'undated receipt included in dated total',
    );
  },
);
await check('starting rent balance cannot be combined with deposit receipts', async () => {
  const f = await fixture();
  const setup = {
    ...f.setup,
    billing: {
      ...f.setup.billing,
      rent: {
        ...f.setup.billing.rent,
        history_mode: 'opening_balance',
        charge_keys: [],
        opening_balance: { amount_cents: 60000, basis: 'Landlord statement' },
      },
      payments: [
        {
          draft_key: 'deposit',
          amount_cents: 185000,
          currency: 'USD',
          received_at: '2026-10-01',
          method: 'check',
          allocations: [],
        },
      ],
    },
    receipt_purposes: { deposit: 'deposit' },
  };
  const review = await request('POST', `/tenancy-setup-sessions/${f.id}/preview`, setup);
  assert(review.status === 400, JSON.stringify(review.body));
});
async function reviewed(f: { id: string; setup: unknown }, setup: unknown = f.setup) {
  const response = await request('POST', `/tenancy-setup-sessions/${f.id}/preview`, setup);
  assert(response.status === 200, JSON.stringify(response.body));
  return response.body as {
    setup_context: string;
    can_confirm: boolean;
    findings: { rule_id: string }[];
    proposed_tenancy: { status: string };
    billing_intent: Record<string, unknown>;
  };
}
async function complete(f: { id: string; setup: unknown }, setup: unknown = f.setup) {
  const p = await reviewed(f, setup);
  const response = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, {
    setup,
    expected_context: p.setup_context,
    accept_warnings: true,
  });
  assert(response.status === 201, JSON.stringify(response.body));
  return response.body as { tenancy_id: string; lease_id: string; status: string };
}
async function existingFixture() {
  const original = await fixture();
  const committed = await complete(original);
  const id = crypto.randomUUID();
  const saved = await request('PUT', `/tenancy-setup-sessions/${id}`, {
    area_id: original.area_id,
    tenancy_id: committed.tenancy_id,
    expected_revision: 0,
    payload: {},
  });
  assert(saved.status === 200, JSON.stringify(saved.body));
  const setup = {
    ...original.setup,
    people: original.setup.people.map((person) => ({ ...person, tenant_id: person.key })),
    agreement: {
      ...original.setup.agreement,
      existing_id: committed.lease_id,
      change_kind: 'reuse',
    },
    billing: {
      ...original.setup.billing,
      rent: { decision: 'keep' },
      deposit: { decision: 'keep' },
    },
  };
  return { ...original, id, setup, committed };
}
await check('setup needs no lease membership field and does not store it', async () => {
  const f = await existingFixture();
  await complete(f);
  const members = await request('GET', `/tenancies/${f.committed.tenancy_id}/members`);
  assert(members.status === 200, JSON.stringify(members.body));
  const rows = (members.body as { data: Record<string, unknown>[] }).data;
  assert(
    rows.length === 1 && !Object.hasOwn(rows[0]!, 'on_lease'),
    'membership field still returned',
  );
  const lease = await admin
    .from('leases')
    .select('document')
    .eq('id', f.committed.lease_id)
    .single();
  assert(!lease.error, lease.error?.message ?? 'missing lease');
  const parties = (lease.data?.document as { parties: Record<string, unknown>[] }).parties;
  assert(!Object.hasOwn(parties[0]!, 'on_lease'), 'setup stored lease membership');
  const column = await pool.query(
    "select 1 from information_schema.columns where table_schema='public' and table_name='tenancy_tenants' and column_name='on_lease'",
  );
  assert(column.rowCount === 0, 'removed membership column still exists');
});
await check(
  'saving pending request metadata does not invalidate a reviewed domain context',
  async () => {
    const f = await fixture();
    const p = await reviewed(f);
    const saved = await request('PUT', `/tenancy-setup-sessions/${f.id}`, {
      area_id: f.area_id,
      expected_revision: 1,
      payload: { setup: f.setup, pending: { key: 'frozen-key', context: p.setup_context } },
    });
    assert(saved.status === 200, JSON.stringify(saved.body));
    const again = await reviewed(f);
    assert(
      again.setup_context === p.setup_context,
      'UI metadata invalidated its own domain review',
    );
    const changed = { ...f.setup, agreement: { ...f.setup.agreement, grace_days: 46 } };
    const stale = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, {
      setup: changed,
      expected_context: p.setup_context,
      accept_warnings: true,
    });
    assert(stale.status === 409, 'changed domain intent reused old review');
    const completed = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, {
      setup: f.setup,
      expected_context: p.setup_context,
      accept_warnings: true,
    });
    assert(completed.status === 201, JSON.stringify(completed.body));
    const fetched = await request('GET', `/tenancy-setup-sessions/${f.id}`);
    assert(fetched.status === 200, JSON.stringify(fetched.body));
    const session = fetched.body as { completed_at: string | null; result: unknown };
    assert(
      session.completed_at && JSON.stringify(session.result) === JSON.stringify(completed.body),
      'completion cannot be recovered by session identity',
    );
  },
);
await check(
  'unconfirmed elapsed partial coverage remains discoverable before an explicit concession',
  async () => {
    const f = await fixture();
    const monthStart = new Date().toISOString().slice(0, 7) + '-01';
    const next = new Date(`${monthStart}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const anchor = next.toISOString().slice(0, 10);
    const start = monthStart.slice(0, 7) + '-02';
    const end = new Date(next.getTime() - 86400000).toISOString().slice(0, 10);
    const setup = {
      ...f.setup,
      tenancy: { start_date: start, end_date: null },
      agreement: { ...f.setup.agreement, term_start: start },
      billing: {
        ...f.setup.billing,
        rent: {
          ...f.setup.billing.rent,
          coverage_start: start,
          regular_anchor: anchor,
          charge_keys: [],
          period_overrides: [] as {
            cycle_key: string;
            period_start: string;
            period_end: string;
            due_date: string;
            amount_cents: number;
            reason: string;
          }[],
        },
      },
    };
    const p = await reviewed(f, setup);
    assert(
      !p.can_confirm &&
        p.findings.some(
          (finding) => finding.rule_id === `partial_period:${monthStart.slice(0, 7)}`,
        ),
      'partial discovery threw or concealed the exact interval',
    );
    assert(
      (await admin.from('tenancies').select('id', { count: 'exact' }).eq('area_id', f.area_id))
        .count === 0,
      'partial discovery wrote a tenancy',
    );
    setup.billing.rent.period_overrides = [
      {
        cycle_key: monthStart.slice(0, 7),
        period_start: start,
        period_end: end,
        due_date: monthStart.slice(0, 7) + '-28',
        amount_cents: 0,
        reason: 'First-period concession',
      },
    ];
    const result = await complete(f, setup);
    const charges = await admin.from('charges').select('id').eq('tenancy_id', result.tenancy_id);
    assert(charges.data?.length === 0, 'a zero concession created a charge');
  },
);
await check(
  'existing-tenancy correction audits possession changes without rewriting money',
  async () => {
    const f = await existingFixture();
    const before = await admin.from('charges').select('*').eq('tenancy_id', f.committed.tenancy_id);
    const today = new Date().toISOString().slice(0, 10);
    const setup = {
      ...f.setup,
      tenancy: { start_date: today, end_date: null },
      agreement: {
        ...f.setup.agreement,
        id: crypto.randomUUID(),
        change_kind: 'correction',
        term_start: today,
      },
      change_reason: 'Correct recorded agreement commencement',
      move_in_note: 'Possession entitlement was confirmed from the signed agreement',
    };
    const p = await reviewed(f, setup);
    assert(p.proposed_tenancy.status === 'active', 'wrong proposed occupancy after correction');
    const result = await complete(f, setup);
    assert(result.status === 'active', 'returned tenancy status predates the correction');
    const history = await admin
      .from('tenancy_date_records')
      .select('kind,before_facts,after_facts')
      .eq('tenancy_id', result.tenancy_id)
      .eq('kind', 'correction');
    assert(history.data?.length === 1, 'possession correction was not audited');
    const now = await admin
      .from('tenancies')
      .select('start_date,date_revision')
      .eq('id', result.tenancy_id)
      .single();
    assert(
      now.data?.start_date === today && now.data.date_revision === 1,
      'correction facts missing',
    );
    const after = await admin.from('charges').select('*').eq('tenancy_id', result.tenancy_id);
    assert(
      JSON.stringify(after.data) === JSON.stringify(before.data),
      'correction rewrote the financial evidence',
    );
    const old = await admin
      .from('leases')
      .select('voided_at')
      .eq('id', f.committed.lease_id)
      .single();
    assert(
      old.data?.voided_at && result.lease_id !== f.committed.lease_id,
      'agreement correction lost its predecessor',
    );
    const members = await request('GET', `/tenancies/${result.tenancy_id}/members`);
    assert(members.status === 200, JSON.stringify(members.body));
    assert((members.body as { data: unknown[] }).data.length === 1, 'correction lost the person');
  },
);
await check('concurrent membership changes invalidate an existing-tenancy review', async () => {
  const f = await existingFixture();
  const p = await reviewed(f, f.setup);
  const added = await request('POST', '/tenants', { full_name: 'Concurrent occupant' });
  assert(added.status === 201, JSON.stringify(added.body));
  const member = await request('POST', `/tenancies/${f.committed.tenancy_id}/members`, {
    tenant_id: (added.body as { id: string }).id,
    role: 'occupant',
  });
  assert(member.status === 201, JSON.stringify(member.body));
  const stale = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, {
    setup: f.setup,
    expected_context: p.setup_context,
    accept_warnings: true,
  });
  assert(stale.status === 409, 'unreviewed person would be removed');
  const membership = await admin
    .from('tenancy_tenants')
    .select('deleted_at')
    .eq('id', (member.body as { id: string }).id)
    .single();
  assert(membership.data?.deleted_at === null, 'stale commit removed a person');
});
await check(
  'setup scope, role checks, and warning consent cannot be forged by direct callers',
  async () => {
    const f = await fixture();
    const p = await reviewed(f);
    const foreign = await caller.rpc('preview_tenancy_setup_session', {
      p_account_id: crypto.randomUUID(),
      p_id: f.id,
      p_setup: f.setup,
    });
    assert(foreign.error, 'cross-account setup was visible');
    const noConsent = await caller.rpc('commit_tenancy_setup_session', {
      p_account_id: auth.account.id,
      p_id: f.id,
      p_setup: f.setup,
      p_expected_context: p.setup_context,
      p_accept_warnings: false,
      p_idempotency_key: 'no-claim',
      p_request_fingerprint: 'forged',
    });
    assert(noConsent.error, 'direct commit accepted no durable claim');
    const directPreview = await caller.rpc('preview_tenancy_setup_session', {
      p_account_id: auth.account.id,
      p_id: f.id,
      p_setup: f.setup,
    });
    assert(!directPreview.error, directPreview.error?.message ?? 'direct preview failed');
    const consentKey = `consent-${randomToken()}`;
    const fingerprint = 'a'.repeat(64);
    const claim = await caller.rpc('claim_idempotency_key', {
      p_account_id: auth.account.id,
      p_key: consentKey,
      p_fingerprint: fingerprint,
    });
    assert(!claim.error, claim.error?.message ?? 'claim failed');
    const nullConsent = await caller.rpc('commit_tenancy_setup_session', {
      p_account_id: auth.account.id,
      p_id: f.id,
      p_setup: f.setup,
      p_expected_context: directPreview.data.setup_context,
      p_accept_warnings: null,
      p_idempotency_key: consentKey,
      p_request_fingerprint: fingerprint,
    });
    assert(
      nullConsent.error?.message.includes('confirm the reviewed setup'),
      'null consent bypassed the confirmation guard',
    );
    const unconfirmed = await request('POST', `/tenancy-setup-sessions/${f.id}/preview`, {
      ...f.setup,
      people: [{ ...f.setup.people[0]!, on_lease: null }],
    });
    assert(unconfirmed.status === 400, 'removed membership input was accepted');
    const signupOther = await api('POST', '/v1/auth/signup', {
      body: {
        email: `setup-viewer-${randomToken()}@example.test`,
        password: `test-${randomToken()}`,
        account_name: 'Other setup account',
      },
    });
    assert(signupOther.status === 200, JSON.stringify(signupOther.body));
    const other = signupOther.body as {
      session: { access_token: string };
      account: { id: string };
    };
    const user = await admin.auth.getUser(other.session.access_token);
    assert(user.data.user, 'missing synthetic viewer');
    const membership = await admin
      .from('account_members')
      .insert({ account_id: auth.account.id, user_id: user.data.user.id, role: 'viewer' });
    assert(!membership.error, membership.error?.message ?? 'viewer membership failed');
    const denied = await api('POST', `${base}/tenancy-setup-sessions/${f.id}/commit`, {
      token: other.session.access_token,
      body: { setup: f.setup, expected_context: p.setup_context, accept_warnings: true },
    });
    assert(denied.status === 404 || denied.status === 403, 'viewer finalized setup');
    const viewerUpload = new FormData();
    viewerUpload.set('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'lease.pdf');
    const forbiddenUpload = await api('POST', `${base}/tenancy-setup-sessions/${f.id}/document`, {
      token: other.session.access_token,
      multipart: viewerUpload,
    });
    assert(forbiddenUpload.status === 403, 'viewer reached privileged storage upload');
    const viewerReceipts = await admin
      .from('document_upload_receipts')
      .select('id', { count: 'exact' })
      .eq('uploaded_by', user.data.user.id);
    assert(viewerReceipts.count === 0, 'denied viewer left staged bytes/receipt');
    const foreignRead = await api(
      'GET',
      `/v1/accounts/${other.account.id}/tenancy-setup-sessions/${f.id}`,
      { token: other.session.access_token },
    );
    assert(foreignRead.status === 404, 'foreign session result leaked');
    const foreignPerson = await api('POST', `/v1/accounts/${other.account.id}/tenants`, {
      token: other.session.access_token,
      body: { full_name: 'Foreign person' },
    });
    assert(foreignPerson.status === 201, JSON.stringify(foreignPerson.body));
    const wrongPerson = {
      ...f.setup,
      people: [{ ...f.setup.people[0]!, tenant_id: (foreignPerson.body as { id: string }).id }],
    };
    const previewForeign = await request(
      'POST',
      `/tenancy-setup-sessions/${f.id}/preview`,
      wrongPerson,
    );
    assert(previewForeign.status === 404, 'foreign person used as a setup party');
    assert(
      (await admin.from('tenancies').select('id', { count: 'exact' }).eq('area_id', f.area_id))
        .count === 0,
      'rejected caller left a tenancy',
    );
  },
);
await check(
  'active setup upload bindings survive cleanup; expired or claimed uploads cannot be revived',
  async () => {
    const f = await fixture();
    const file = new FormData();
    file.set(
      'file',
      new Blob([`%PDF-1.4\nsetup-${randomToken()}\n%%EOF`], { type: 'application/pdf' }),
      'signed-lease.pdf',
    );
    const uploaded = await api('POST', `${base}/tenancy-setup-sessions/${f.id}/document`, {
      token: auth.session.access_token,
      multipart: file,
    });
    assert(uploaded.status === 201, JSON.stringify(uploaded.body));
    const document = uploaded.body as { receipt_id: string; name: string };
    const aged = await admin
      .from('document_upload_receipts')
      .update({ created_at: new Date(Date.now() - 49 * 3600000).toISOString() })
      .eq('id', document.receipt_id)
      .select('storage_path')
      .single();
    assert(!aged.error && aged.data, aged.error?.message ?? 'receipt missing');
    const { pruneDocumentUploadOrphans } = await import('../src/admin/storage');
    await pruneDocumentUploadOrphans();
    const retained = await admin.storage.from('attachments').download(aged.data.storage_path);
    assert(!retained.error, 'active setup upload bytes were deleted');
    const other = await fixture();
    const wrong = await request('POST', `/tenancy-setup-sessions/${other.id}/preview`, {
      ...other.setup,
      document,
    });
    assert(wrong.status === 404, 'another setup consumed this document binding');
    const p = await reviewed(f, { ...f.setup, document });
    assert(p.can_confirm, 'retained document is not resumable');
    const expiry = await admin
      .from('tenancy_setup_sessions')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', f.id);
    assert(!expiry.error, expiry.error?.message ?? 'expiration failed');
    await pruneDocumentUploadOrphans();
    const gone = await admin.storage.from('attachments').download(aged.data.storage_path);
    assert(gone.error, 'expired setup retained orphan bytes');
    const resumed = await request('PUT', `/tenancy-setup-sessions/${f.id}`, {
      area_id: f.area_id,
      expected_revision: 1,
      payload: {},
    });
    assert(resumed.status === 409, 'expired binding revived after deletion');
    const orphan = await fixture();
    const orphanFile = new FormData();
    orphanFile.set('file', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'lease.pdf');
    const staged = await api('POST', `${base}/tenancy-setup-sessions/${orphan.id}/document`, {
      token: auth.session.access_token,
      multipart: orphanFile,
    });
    assert(staged.status === 201, JSON.stringify(staged.body));
    const receipt = (staged.body as { receipt_id: string }).receipt_id;
    const unbound = await admin
      .from('document_upload_receipts')
      .update({
        setup_session_id: null,
        created_at: new Date(Date.now() - 49 * 3600000).toISOString(),
      })
      .eq('id', receipt);
    assert(!unbound.error, unbound.error?.message ?? 'unbind failed');
    const claimed = await admin.rpc('claim_document_upload_orphan', {
      p_account_id: auth.account.id,
      p_receipt_id: receipt,
    });
    assert(claimed.data === true, claimed.error?.message ?? 'claim failed');
    const rebind = await caller
      .from('document_upload_receipts')
      .update({ setup_session_id: orphan.id })
      .eq('id', receipt);
    assert(rebind.error, 'cleanup claim allowed a concurrent rebind');
    const unauthorizedClaim = await caller.rpc('claim_document_upload_orphan', {
      p_account_id: auth.account.id,
      p_receipt_id: receipt,
    });
    assert(unauthorizedClaim.error, 'caller claimed privileged cleanup');
  },
);
await check('final setup testimony preserves optional notes and rejects rewrites', async () => {
  const f = await fixture();
  const setup = {
    ...f.setup,
    warning_notes: { lease_fee_policy: 'Confirmed no fee despite the account suggestion' },
  };
  const saved = await complete(f, setup);
  const evidence = await caller
    .from('tenancy_setup_confirmations')
    .select('*')
    .eq('account_id', auth.account.id)
    .eq('setup_session_id', f.id)
    .single();
  assert(!evidence.error && evidence.data, evidence.error?.message ?? 'setup confirmation missing');
  assert(
    evidence.data.setup_snapshot.warning_notes.lease_fee_policy ===
      setup.warning_notes.lease_fee_policy && evidence.data.lease_id === saved.lease_id,
    'reviewed optional note or saved agreement identity lost',
  );
  const forgedTime = await caller.from('tenancy_setup_confirmations').insert({
    account_id: auth.account.id,
    setup_session_id: f.id,
    tenancy_id: saved.tenancy_id,
    lease_id: saved.lease_id,
    setup_snapshot: {},
    review_snapshot: {},
    entered_by: evidence.data.entered_by,
    entered_at: '2000-01-01T00:00:00Z',
  });
  assert(forgedTime.error?.code === '42501', 'caller supplied the server confirmation timestamp');
  const forgedId = await caller.from('tenancy_setup_confirmations').insert({
    id: crypto.randomUUID(),
    account_id: auth.account.id,
    setup_session_id: f.id,
    tenancy_id: saved.tenancy_id,
    lease_id: saved.lease_id,
    setup_snapshot: {},
    review_snapshot: {},
    entered_by: evidence.data.entered_by,
  });
  assert(forgedId.error?.code === '42501', 'caller supplied the server confirmation identity');
  const rewrite = await caller
    .from('tenancy_setup_confirmations')
    .update({ setup_snapshot: {} })
    .eq('id', evidence.data.id);
  assert(rewrite.error, 'authenticated caller rewrote final testimony');
  const privilegedRewrite = await pool
    .query('update public.tenancy_setup_confirmations set setup_snapshot=$1 where id=$2', [
      '{}',
      evidence.data.id,
    ])
    .then(
      () => null,
      (error: Error) => error,
    );
  assert(privilegedRewrite, 'operator rewrite bypassed immutability trigger');
  const editSession = await caller
    .from('tenancy_setup_sessions')
    .update({ payload: { rewritten: true } })
    .eq('id', f.id);
  assert(editSession.error, 'completed UI draft rewrote immutable final state');
  const audit = await admin
    .from('events')
    .select('id', { count: 'exact' })
    .eq('account_id', auth.account.id)
    .eq('entity_type', 'tenancy_setup_confirmations')
    .eq('entity_id', evidence.data.id);
  assert(audit.count === 1, 'final setup testimony lacks an audit event');
});
await check(
  'receipt matching keeps currencies separate and monthly generation honors leap last-day and the 31st',
  async () => {
    for (const rule of [{ kind: 'last_day' }, { kind: 'day_of_month', day: 31 }]) {
      const f = await fixture();
      const setup = {
        ...f.setup,
        agreement: { ...f.setup.agreement, rent_due_rule: rule },
        billing: {
          ...f.setup.billing,
          rent: { ...f.setup.billing.rent, billing_due_rule: rule },
          payments: [
            {
              draft_key: 'eur-credit',
              amount_cents: 10000,
              currency: 'EUR',
              received_at: null,
              receipt_date_unknown: true,
              method: 'cash',
              allocations: [],
            },
          ],
        },
      };
      const p = await reviewed(f, setup);
      const reviewedPayments = p.billing_intent.payments as { allocations: unknown[] }[];
      assert(reviewedPayments[0]?.allocations.length === 0, 'EUR receipt matched a USD obligation');
      const saved = await complete(f, setup);
      const payment = await admin
        .from('payments')
        .select('id')
        .eq('tenancy_id', saved.tenancy_id)
        .single();
      assert(payment.data, 'setup receipt missing');
      const rewriteSource = await caller
        .from('payments')
        .update({ entry_source: 'manual' })
        .eq('id', payment.data.id);
      assert(rewriteSource.error?.code === '23514', 'setup receipt provenance was rewritten');
      const rewriteKnowledge = await caller
        .from('payments')
        .update({ received_at: '2028-02-01T12:00:00Z', receipt_date_unknown: false })
        .eq('id', payment.data.id);
      assert(
        rewriteKnowledge.error?.code === '23514',
        'unknown receipt date was invented after confirmation',
      );
      const schedule = await admin
        .from('rent_schedules')
        .select('id')
        .eq('tenancy_id', saved.tenancy_id)
        .single();
      assert(schedule.data, 'schedule missing');
      const enabled = await admin
        .from('accounts')
        .update({ auto_charge_enabled: true })
        .eq('id', auth.account.id);
      assert(!enabled.error, enabled.error?.message ?? 'generator switch failed');
      const generated = await admin.rpc('generate_rent_charges', {
        p_account_id: auth.account.id,
        p_as_of: '2028-03-01T00:00:00Z',
      });
      assert(!generated.error, generated.error?.message ?? 'generation failed');
      const charges = await admin
        .from('charges')
        .select('due_date,period_start,period_end')
        .eq('source_schedule_id', schedule.data.id)
        .order('due_date');
      assert(
        charges.data?.[0]?.due_date === '2028-02-29' && charges.data[1]?.due_date === '2028-03-31',
        'generator did not honor leap-month/31st policy',
      );
      assert(
        charges.data[1]?.period_start === '2028-03-01' &&
          charges.data[1].period_end === '2028-03-31',
        'due rule changed monthly coverage',
      );
    }
  },
);
await check(
  'late finalization failure rolls back tenancy, people, agreement, money, defaults and completion',
  async () => {
    const f = await fixture();
    const setup = { ...f.setup, save_defaults: true };
    const p = await reviewed(f, setup);
    await pool.query(
      `create function public.setup_v3_rollback_probe() returns trigger language plpgsql as $$ begin if NEW.id='${f.id}'::uuid and NEW.completed_at is not null then raise exception 'late setup rollback probe' using errcode='XX000';end if;return NEW;end $$`,
    );
    await pool.query(
      'create trigger setup_v3_rollback_probe before update on public.tenancy_setup_sessions for each row execute function public.setup_v3_rollback_probe()',
    );
    try {
      const failed = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, {
        setup,
        expected_context: p.setup_context,
        accept_warnings: true,
      });
      assert(failed.status === 500, JSON.stringify(failed.body));
      assert(
        (await admin.from('tenancies').select('id', { count: 'exact' }).eq('area_id', f.area_id))
          .count === 0,
        'failed setup left tenancy',
      );
      assert(
        (
          await admin
            .from('tenants')
            .select('id', { count: 'exact' })
            .eq('id', f.setup.people[0]!.key)
        ).count === 0,
        'failed setup left person',
      );
      assert(
        (await admin.from('leases').select('id', { count: 'exact' }).eq('id', f.setup.agreement.id))
          .count === 0,
        'failed setup left agreement',
      );
      for (const table of ['charges', 'payments', 'rent_schedules'] as const)
        assert(
          (await admin.from(table).select('id', { count: 'exact' }).eq('tenancy_id', f.id))
            .count === 0,
          `failed setup left ${table}`,
        );
      const session = await request('GET', `/tenancy-setup-sessions/${f.id}`);
      assert(
        (session.body as { completed_at: string | null }).completed_at === null,
        'failed setup marked complete',
      );
      assert(
        (
          await admin
            .from('account_rent_defaults')
            .select('account_id', { count: 'exact' })
            .eq('account_id', auth.account.id)
        ).count === 0,
        'failed setup saved defaults',
      );
    } finally {
      await pool.query('drop trigger setup_v3_rollback_probe on public.tenancy_setup_sessions');
      await pool.query('drop function public.setup_v3_rollback_probe()');
    }
  },
);
await check(
  'cron uses the same day28, last-day and explicit day31 short-month rules as setup',
  async () => {
    await admin.from('accounts').update({ auto_charge_enabled: true }).eq('id', auth.account.id);
    for (const sample of [
      { rule: { kind: 'day_of_month', day: 28 }, due: 28, expected: '2028-02-28' },
      { rule: { kind: 'last_day' }, due: 31, expected: '2028-02-29' },
      { rule: { kind: 'day_of_month', day: 31 }, due: 31, expected: '2028-02-29' },
    ]) {
      const f = await fixture();
      const setup = {
        ...f.setup,
        agreement: { ...f.setup.agreement, rent_due_rule: sample.rule },
        billing: {
          ...f.setup.billing,
          rent: {
            ...f.setup.billing.rent,
            due_day: sample.due,
            billing_due_rule: sample.rule,
            short_month_policy: 'last_day',
            charge_keys: [],
          },
        },
      };
      const preview = await request('POST', `/tenancy-setup-sessions/${f.id}/preview`, setup);
      assert(preview.status === 200, JSON.stringify(preview.body));
      const saved = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, {
        setup,
        expected_context: (preview.body as { setup_context: string }).setup_context,
        accept_warnings: true,
      });
      assert(saved.status === 201, JSON.stringify(saved.body));
      for (let retry = 0; retry < 2; retry++) {
        const generated = await admin.rpc('generate_rent_charges', {
          p_account_id: auth.account.id,
          p_as_of: '2028-02-01T12:00:00Z',
        });
        assert(!generated.error, JSON.stringify(generated.error));
      }
      const charges = await admin
        .from('charges')
        .select('due_date,period_start,period_end,amount_cents')
        .eq('tenancy_id', f.id);
      assert(charges.data?.length === 1, JSON.stringify(charges));
      assert(
        charges.data[0]?.due_date === sample.expected &&
          charges.data[0]?.period_start === '2028-02-01' &&
          charges.data[0]?.period_end === '2028-02-29' &&
          charges.data[0]?.amount_cents === 185000,
        JSON.stringify(charges.data),
      );
    }
  },
);
await check(
  'a lease shorter than a month requires an explicit amount and cron stops on its exact ending',
  async () => {
    const f = await fixture();
    const baseSetup = {
      ...f.setup,
      tenancy: { start_date: '2028-02-15', end_date: '2028-02-20' },
      agreement: { ...f.setup.agreement, term_start: '2028-02-15', term_end: '2028-02-20' },
      billing: {
        ...f.setup.billing,
        rent: {
          ...f.setup.billing.rent,
          coverage_start: '2028-02-15',
          coverage_end: '2028-02-20',
          regular_anchor: '2028-03-01',
          charge_keys: [],
        },
      },
    };
    const unresolved = await request('POST', `/tenancy-setup-sessions/${f.id}/preview`, baseSetup);
    assert(unresolved.status === 200, JSON.stringify(unresolved.body));
    assert(
      !(unresolved.body as { can_confirm: boolean }).can_confirm,
      'partial period silently accepted without amount',
    );
    const setup = {
      ...baseSetup,
      billing: {
        ...baseSetup.billing,
        rent: {
          ...baseSetup.billing.rent,
          period_overrides: [
            {
              cycle_key: '2028-02',
              period_start: '2028-02-15',
              period_end: '2028-02-20',
              due_date: '2028-02-15',
              amount_cents: 50000,
              reason: 'Landlord confirmed agreed short-term rent',
            },
          ],
        },
      },
    };
    const preview = await request('POST', `/tenancy-setup-sessions/${f.id}/preview`, setup);
    assert(preview.status === 200, JSON.stringify(preview.body));
    const saved = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, {
      setup,
      expected_context: (preview.body as { setup_context: string }).setup_context,
      accept_warnings: true,
    });
    assert(saved.status === 201, JSON.stringify(saved.body));
    for (const asOf of ['2028-02-01T12:00:00Z', '2028-03-01T12:00:00Z']) {
      const generated = await admin.rpc('generate_rent_charges', {
        p_account_id: auth.account.id,
        p_as_of: asOf,
      });
      assert(!generated.error, JSON.stringify(generated.error));
    }
    const charges = await admin
      .from('charges')
      .select('period_start,period_end,amount_cents')
      .eq('tenancy_id', f.id);
    assert(
      charges.data?.length === 1 &&
        charges.data[0]?.period_start === '2028-02-15' &&
        charges.data[0]?.period_end === '2028-02-20' &&
        charges.data[0]?.amount_cents === 50000,
      JSON.stringify(charges),
    );
  },
);
await check('only setup commands can create final testimony or complete a draft', async () => {
  const f = await existingFixture();
  const user = await caller.auth.getUser();
  assert(user.data.user, 'missing caller');
  const forged = await caller.from('tenancy_setup_confirmations').insert({
    account_id: auth.account.id,
    setup_session_id: f.id,
    tenancy_id: f.committed.tenancy_id,
    lease_id: f.committed.lease_id,
    setup_snapshot: {},
    review_snapshot: {},
    entered_by: user.data.user.id,
  });
  assert(forged.error?.code === '42501', 'caller manufactured final setup testimony');
  const finished = await caller
    .from('tenancy_setup_sessions')
    .update({
      completed_at: new Date().toISOString(),
      result: { forged: true },
    })
    .eq('id', f.id);
  assert(finished.error?.code === '42501', 'caller manufactured completion');
  const inserted = await caller.from('tenancy_setup_sessions').insert({
    id: crypto.randomUUID(),
    account_id: auth.account.id,
    area_id: f.area_id,
    completed_at: new Date().toISOString(),
    result: { forged: true },
  });
  assert(inserted.error?.code === '42501', 'caller inserted a completed session');
  const operatorCompletion = await admin
    .from('tenancy_setup_sessions')
    .update({
      completed_at: new Date().toISOString(),
      result: { forged: true },
    })
    .eq('id', f.id);
  assert(operatorCompletion.error?.code === '42501', 'operator bypassed the completion command');
  const operatorConfirmation = await admin.from('tenancy_setup_confirmations').insert({
    account_id: auth.account.id,
    setup_session_id: f.id,
    tenancy_id: f.committed.tenancy_id,
    lease_id: f.committed.lease_id,
    setup_snapshot: {},
    review_snapshot: {},
    entered_by: user.data.user.id,
  });
  assert(operatorConfirmation.error?.code === '42501', 'operator manufactured final testimony');
  const saved = await complete(f);
  assert(
    saved.tenancy_id === f.committed.tenancy_id,
    'valid command failed after rejected forgery',
  );
});
await check(
  'optional agreement knowledge and explicit null source commit as reviewed',
  async () => {
    const f = await fixture();
    const agreement = { ...f.setup.agreement } as Record<string, unknown>;
    delete agreement.deposit_knowledge;
    delete agreement.rent_due_rule;
    delete agreement.late_fee_policy;
    agreement.terms_source = null;
    const setup = { ...f.setup, agreement };
    const p = await reviewed(f, setup);
    assert(p.can_confirm, JSON.stringify(p));
    const saved = await complete(f, setup);
    const lease = await caller
      .from('leases')
      .select('deposit_knowledge,terms_source,rent_due_rule,late_fee_policy')
      .eq('id', saved.lease_id)
      .single();
    assert(
      lease.data?.deposit_knowledge === 'unknown' && lease.data.terms_source === null,
      JSON.stringify(lease),
    );
    assert(
      (lease.data.rent_due_rule as { kind: string }).kind === 'unknown' &&
        (lease.data.late_fee_policy as { kind: string }).kind === 'unknown',
      'missing agreement knowledge was not preserved',
    );
  },
);
await check(
  'day31 compatibility input preserves last-day policy through persistence and cron',
  async () => {
    const f = await fixture();
    const rent = { ...f.setup.billing.rent, charge_keys: [] } as Record<string, unknown>;
    delete rent.billing_due_rule;
    const setup = { ...f.setup, billing: { ...f.setup.billing, rent } };
    const saved = await complete(f, setup);
    const schedule = await caller
      .from('rent_schedules')
      .select('id,billing_due_rule,short_month_policy')
      .eq('tenancy_id', saved.tenancy_id)
      .single();
    assert(
      schedule.data?.short_month_policy === 'last_day' &&
        (schedule.data.billing_due_rule as { kind: string; day: number }).day === 31,
      JSON.stringify(schedule),
    );
    await admin.from('accounts').update({ auto_charge_enabled: true }).eq('id', auth.account.id);
    const generated = await admin.rpc('generate_rent_charges', {
      p_account_id: auth.account.id,
      p_as_of: '2028-02-01T12:00:00Z',
    });
    assert(!generated.error, JSON.stringify(generated));
    const charge = await caller
      .from('charges')
      .select('due_date,period_start,period_end')
      .eq('source_schedule_id', schedule.data.id)
      .eq('cycle_key', '2028-02')
      .single();
    assert(
      charge.data?.due_date === '2028-02-29' &&
        charge.data.period_start === '2028-02-01' &&
        charge.data.period_end === '2028-02-29',
      JSON.stringify(charge),
    );
  },
);
await check(
  'each independent billing terms difference survives review and final evidence',
  async () => {
    for (const difference of [
      { amount_cents: 200000 },
      { currency: 'EUR' },
      { billing_due_rule: { kind: 'day_of_month', day: 15 }, due_day: 15 },
      { grace_days: 1 },
      { late_fee_policy: { kind: 'fixed', amount_cents: 5000, currency: 'USD' } },
    ]) {
      const f = await fixture();
      const setup = {
        ...f.setup,
        billing: { ...f.setup.billing, rent: { ...f.setup.billing.rent, ...difference } },
      };
      const p = await reviewed(f, setup);
      assert(
        p.findings.some((finding) => finding.rule_id === 'billing_terms_differ'),
        JSON.stringify(p),
      );
      const saved = await complete(f, setup);
      const evidence = await caller
        .from('tenancy_setup_confirmations')
        .select('review_snapshot')
        .eq('tenancy_id', saved.tenancy_id)
        .single();
      const review = evidence.data?.review_snapshot as { findings: { rule_id: string }[] };
      assert(
        review.findings.some((finding) => finding.rule_id === 'billing_terms_differ'),
        'final review lost the billing difference',
      );
    }
  },
);
await check('renewal and amendment corrections preserve their predecessor and kind', async () => {
  for (const kind of ['renewal', 'amendment']) {
    const f = await existingFixture();
    const lease = await request('POST', '/leases', {
      ...f.setup.agreement,
      id: undefined,
      existing_id: undefined,
      change_kind: undefined,
      tenancy_id: f.committed.tenancy_id,
      status: 'active',
      agreement_kind: kind,
      predecessor_lease_id: f.committed.lease_id,
    });
    assert(lease.status === 201, JSON.stringify(lease.body));
    const leaseId = (lease.body as { id: string }).id;
    const setup = {
      ...f.setup,
      agreement: {
        ...f.setup.agreement,
        existing_id: leaseId,
        id: crypto.randomUUID(),
        change_kind: 'correction',
      },
      change_reason: 'Correct the recorded grace knowledge',
    };
    const p = await reviewed(f, setup);
    assert(p.can_confirm, JSON.stringify(p));
    const saved = await complete(f, setup);
    const corrected = await caller
      .from('leases')
      .select('agreement_kind,predecessor_lease_id,corrects_lease_id')
      .eq('id', saved.lease_id)
      .single();
    assert(
      corrected.data?.agreement_kind === kind &&
        corrected.data.predecessor_lease_id === f.committed.lease_id &&
        corrected.data.corrects_lease_id === leaseId,
      JSON.stringify(corrected),
    );
  }
});
await check(
  'kept money still reviews changed possession against the agreement and schedule',
  async () => {
    const f = await existingFixture();
    const setup = { ...f.setup, tenancy: { start_date: '2028-03-01', end_date: null } };
    const p = await reviewed(f, setup);
    for (const rule of ['possession_lease_start', 'billing_possession_start']) {
      assert(
        p.findings.some((finding) => finding.rule_id === rule),
        `missing ${rule}: ${JSON.stringify(p)}`,
      );
    }
    const saved = await complete(f, setup);
    const records = await caller
      .from('tenancy_date_records')
      .select('relationship_snapshots')
      .eq('tenancy_id', saved.tenancy_id)
      .eq('kind', 'warning_confirmation');
    const snapshots =
      records.data?.flatMap((record) => record.relationship_snapshots as { rule_id: string }[]) ??
      [];
    assert(
      snapshots.some((finding) => finding.rule_id === 'billing_possession_start'),
      'kept schedule relationship was not recorded',
    );
  },
);
await check('preview blocks a correction that conflicts with anchored billing', async () => {
  const f = await existingFixture();
  const setup = {
    ...f.setup,
    agreement: {
      ...f.setup.agreement,
      id: crypto.randomUUID(),
      change_kind: 'correction',
      rent_amount_cents: 200000,
    },
    change_reason: 'Different recorded rent',
  };
  const p = await reviewed(f, setup);
  assert(
    !p.can_confirm &&
      p.findings.some((finding) => finding.rule_id === 'agreement_correction_schedule_conflict'),
    JSON.stringify(p),
  );
  const saved = await request('POST', `/tenancy-setup-sessions/${f.id}/commit`, {
    setup,
    expected_context: p.setup_context,
    accept_warnings: true,
  });
  assert(saved.status === 400, JSON.stringify(saved.body));
});
await pool.end();
if (failures.length) {
  console.error(failures);
  process.exitCode = 1;
}
