// ----------------------------------------------------------------------------
// Phase 10 DoD tests — evidence export bundle.
//
// Covers:
//   (A) Round-trip on a live tenancy: build the export, the PDF lands as a
//       content-addressed attachment, download via the hardened proxy.
//   (B) Audit chain status embedded: chain_verified=true on a clean account.
//   (C) Tampered chain surfaces in the bundle and the response: we directly
//       mutate one event_hash with the admin client, re-export, and expect
//       chain_verified=false + a banner-shaped chain_message.
//   (D) Soft-deleted / ENDED tenancy: an export still works (this is the
//       case where disputes happen).
//   (E) HEIC photo provenance: when libheif is supported, the bundle embeds
//       the JPEG derivative; identity in the PDF is the ORIGINAL hash. If
//       libheif is missing this test asserts no derivative was created and
//       does NOT fail (the missing-libheif gap is surfaced at /healthz, not
//       by this test).
//   (F) Hardened download proxy: Content-Disposition: attachment + nosniff
//       + CSP + cache-control: no-store + X-Content-Sha256.
//   (G) Cross-account isolation: B cannot fetch metadata or download for
//       an export under A.
//   (H) Blank-scope rejected: POST with neither tenancy_id nor area_id
//       returns 400 (the schema-level check + the route-level refine both
//       defend this).
//   (I) Audit attribution: the evidence_exports.insert event carries
//       actor='user:<exporter_uuid>' (Phase 4 actor integrity via the
//       record_evidence_export SECURITY DEFINER RPC).
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from 'pg';

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
  const lines = out.split('\n');
  const get = (k: string) => {
    const line = lines.find((l) => l.startsWith(k + '='));
    if (!line) throw new Error(`supabase status missing: ${k}`);
    return line.slice(k.length + 1).replace(/^"|"$/g, '');
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
process.env.PORT = '8789';
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
const { _resetIntakeIpBucketsForTests } = await import('../src/admin/intake');
const { groupInteractionChains, loadExportData } = await import('../src/admin/export-pdf');
const { buildApp } = await import('../src/app');

const app = buildApp();
await _resetIntakeIpBucketsForTests();

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; multipart?: FormData; idempotencyKey?: string } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = opts.idempotencyKey ?? `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.multipart) {
    init = { ...init, body: opts.multipart };
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  const ctype = res.headers.get('content-type') ?? '';
  if (ctype.includes('application/json') || ctype === '') {
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: responseHeaders };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, body: buf, headers: responseHeaders };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

interface UserFixture {
  userId: string;
  accessToken: string;
  accountId: string;
  propertyId: string;
  unitAreaId: string;
  tenancyId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `p10-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status}`);
  const b = su.body as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: b.session.access_token, body });
    if (r.status !== 201) throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(
    `/v1/accounts/${b.account.id}/properties`, { name: `${label} prop` },
  );
  const unitArea = await post<{ id: string }>(
    `/v1/accounts/${b.account.id}/areas`,
    { property_id: property.id, kind: 'unit', name: `${label} unit` },
  );
  const tenancy = await post<{ id: string }>(
    `/v1/accounts/${b.account.id}/tenancies`,
    { area_id: unitArea.id, start_date: '2026-01-01', status: 'active' },
  );
  return {
    userId: b.user.id,
    accessToken: b.session.access_token,
    accountId: b.account.id,
    propertyId: property.id,
    unitAreaId: unitArea.id,
    tenancyId: tenancy.id,
  };
}

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
function assertStatus(r: ApiResp, expected: number, ctx: string): unknown {
  if (r.status !== expected) throw new Error(
    `${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`,
  );
  return r.body;
}

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63600100000005000156a04fe50000000049454e44ae426082',
  'hex',
);

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Phase 10 evidence-export DoD checks');
  const A = await setupUser('A');
  const B = await setupUser('B');
  const admin = getAdminClient();

  // ---- seed some content under A's tenancy --------------------------------
  // A lease, a couple of charges + a payment + allocation, an interaction,
  // a maintenance request with a photo. Enough that the export has real
  // content to render -- and so that the audit chain has events to verify.
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: A.accessToken, body });
    if (r.status !== 201) throw new Error(`seed POST ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  await post(`/v1/accounts/${A.accountId}/leases`, {
    tenancy_id: A.tenancyId,
    term_start: '2026-01-01',
    term_end: '2026-12-31',
    rent_amount_cents: 200000,
    rent_currency: 'USD',
    deposit_amount_cents: 200000,
    deposit_currency: 'USD',
    status: 'active',
  });
  const charge = await post<{ id: string }>(
    `/v1/accounts/${A.accountId}/charges`,
    { tenancy_id: A.tenancyId, type: 'rent', amount_cents: 200000, currency: 'USD', due_date: '2026-02-01', period_start: '2026-02-01', period_end: '2026-02-28', description: 'February rent' },
  );
  await post(`/v1/accounts/${A.accountId}/payments`, {
    tenancy_id: A.tenancyId, amount_cents: 200000, currency: 'USD',
    received_at: '2026-02-03T12:00:00Z', method: 'check', reference: '1234',
    allocations: [{ charge_id: charge.id, amount_cents: 200000 }],
  });
  const mreq = await post<{ id: string }>(
    `/v1/accounts/${A.accountId}/maintenance-requests`,
    { area_id: A.unitAreaId, title: 'leaky faucet', description: 'kitchen sink dripping', severity: 'routine' },
  );
  // Attach a photo to the maintenance request.
  const fd = new FormData();
  fd.set('entity_type', 'maintenance_requests');
  fd.set('entity_id', mreq.id);
  fd.set('file', new File([new Uint8Array(PNG_1X1)], 'leak.png', { type: 'image/png' }));
  const photo = await api('POST', `/v1/accounts/${A.accountId}/attachments`, {
    token: A.accessToken, multipart: fd,
  });
  if (photo.status !== 201) throw new Error(`photo upload failed: ${photo.status} ${JSON.stringify(photo.body)}`);

  // =========================================================================
  // (A) Round-trip: export, attachment, download
  // =========================================================================

  let exportId = '';
  let exportAttachmentId = '';
  let exportContentHash = '';
  let exportSizeBytes = 0;
  await check('export: build a bundle for an active tenancy', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/evidence-exports`, {
      token: A.accessToken,
      body: { tenancy_id: A.tenancyId },
    });
    const body = assertStatus(r, 201, 'create export') as {
      id: string;
      attachment_id: string;
      content_hash: string;
      size_bytes: number;
      generated_at: string;
      chain_verified: boolean;
      chain_message: string;
    };
    exportId = body.id;
    exportAttachmentId = body.attachment_id;
    exportContentHash = body.content_hash;
    exportSizeBytes = body.size_bytes;
    if (!/^[a-f0-9]{64}$/.test(body.content_hash)) {
      throw new Error(`content_hash not a sha256 hex: ${body.content_hash}`);
    }
    if (body.size_bytes <= 0) throw new Error(`size_bytes <= 0: ${body.size_bytes}`);
    if (!body.chain_verified) {
      throw new Error(`expected chain_verified=true on a fresh account; got message: ${body.chain_message}`);
    }
  });

  await check('export: download via hardened proxy returns the bundle bytes', async () => {
    const r = await api('GET', `/v1/accounts/${A.accountId}/evidence-exports/${exportId}/download`, {
      token: A.accessToken,
    });
    assertStatus(r, 200, 'download');
    if (r.headers['content-type'] !== 'application/pdf') {
      throw new Error(`content-type: ${r.headers['content-type']}`);
    }
    if (!(r.headers['content-disposition'] ?? '').toLowerCase().startsWith('attachment')) {
      throw new Error(`content-disposition: ${r.headers['content-disposition']}`);
    }
    if (r.headers['x-content-type-options'] !== 'nosniff') {
      throw new Error(`x-content-type-options: ${r.headers['x-content-type-options']}`);
    }
    if (!(r.headers['content-security-policy'] ?? '').includes("default-src 'none'")) {
      throw new Error(`csp missing: ${r.headers['content-security-policy']}`);
    }
    if ((r.headers['cache-control'] ?? '').indexOf('no-store') === -1) {
      throw new Error(`cache-control should include no-store: ${r.headers['cache-control']}`);
    }
    const got = createHash('sha256').update(r.body as Uint8Array).digest('hex');
    if (got !== exportContentHash) {
      throw new Error(`downloaded bytes hash != stored content_hash`);
    }
    if (r.headers['x-content-sha256'] !== exportContentHash) {
      throw new Error(`x-content-sha256 != content_hash`);
    }
    if ((r.body as Uint8Array).byteLength !== exportSizeBytes) {
      throw new Error('downloaded byte count differs from stored size_bytes');
    }
  });

  // =========================================================================
  // (I) Audit attribution: evidence_exports.insert event has actor=user:<id>
  // =========================================================================

  await check('export audit: evidence_exports insert is attributed to the operator', async () => {
    const { data } = await admin
      .from('events')
      .select('actor, event_type')
      .eq('account_id', A.accountId)
      .eq('entity_type', 'evidence_exports')
      .eq('entity_id', exportId)
      .eq('event_type', 'inserted')
      .maybeSingle();
    if (!data) throw new Error('no audit event for evidence_exports.insert');
    if (data.actor !== `user:${A.userId}`) {
      throw new Error(`expected actor=user:${A.userId}, got ${data.actor}`);
    }
  });

  await check('export audit: the bundle attachment insert is also attributed to operator', async () => {
    const { data } = await admin
      .from('events')
      .select('actor, event_type')
      .eq('account_id', A.accountId)
      .eq('entity_type', 'attachments')
      .eq('entity_id', exportAttachmentId)
      .eq('event_type', 'inserted')
      .maybeSingle();
    if (!data) throw new Error('no audit event for the export attachment insert');
    if (data.actor !== `user:${A.userId}`) {
      throw new Error(`expected actor=user:${A.userId}, got ${data.actor}`);
    }
  });

  // =========================================================================
  // (G) Cross-account isolation
  // =========================================================================

  await check("export: B cannot GET A's export metadata under their own account URL", async () => {
    const r = await api('GET', `/v1/accounts/${B.accountId}/evidence-exports/${exportId}`, {
      token: B.accessToken,
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  await check("export: B cannot download A's bundle", async () => {
    const r = await api('GET', `/v1/accounts/${B.accountId}/evidence-exports/${exportId}/download`, {
      token: B.accessToken,
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  await check("export: B with A's accountId in URL is rejected by membership middleware", async () => {
    const r = await api('GET', `/v1/accounts/${A.accountId}/evidence-exports/${exportId}`, {
      token: B.accessToken,
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  // =========================================================================
  // (H) Blank-scope rejected
  // =========================================================================

  await check('export: blank-scope (no tenancy_id and no area_id) rejected with 400', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/evidence-exports`, {
      token: A.accessToken, body: {},
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status} ${JSON.stringify(r.body)}`);
  });

  // =========================================================================
  // (D) Soft-deleted / ended tenancy still exports
  // =========================================================================

  let endedTenancyId = '';
  await check('setup: end and soft-delete a tenancy under A', async () => {
    // Create a new tenancy + give it an end date and status=ended, then
    // soft-delete it. This is the "post-eviction dispute" surface.
    const r = await api('POST', `/v1/accounts/${A.accountId}/tenancies`, {
      token: A.accessToken,
      body: { area_id: A.unitAreaId, start_date: '2025-01-01', status: 'active' },
    });
    const body = assertStatus(r, 201, 'create tenancy') as { id: string };
    endedTenancyId = body.id;
    // End it (PATCH).
    const patch = await api('PATCH', `/v1/accounts/${A.accountId}/tenancies/${endedTenancyId}`, {
      token: A.accessToken, body: { status: 'ended', end_date: '2025-12-31' },
    });
    if (patch.status !== 200) throw new Error(`patch tenancy: ${patch.status} ${JSON.stringify(patch.body)}`);
    // Soft-delete via admin client (the API may not expose tenancy delete).
    const { error } = await admin
      .from('tenancies')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', endedTenancyId);
    if (error) throw new Error(`soft-delete: ${error.message}`);
  });

  await check('export: ended + soft-deleted tenancy is exportable (dispute case)', async () => {
    const r = await api('POST', `/v1/accounts/${A.accountId}/evidence-exports`, {
      token: A.accessToken, body: { tenancy_id: endedTenancyId },
    });
    const body = assertStatus(r, 201, 'export ended tenancy') as {
      id: string; size_bytes: number; chain_verified: boolean;
    };
    if (body.size_bytes <= 0) throw new Error('size_bytes <= 0');
    if (!body.chain_verified) throw new Error('chain should still verify on an ended tenancy');
  });

  // =========================================================================
  // (E) HEIC photo provenance — original hash shown, derivative embedded
  // =========================================================================

  await check('export: HEIC original + derivative both reachable; export size grows', async () => {
    // PDFKit emits text as hex-encoded TJ operators, so we can't string-
    // grep the PDF binary for a literal hash. We verify the property via
    // the DB + the structural property of the bundle: a successful
    // export AFTER a HEIC upload produces a larger PDF than one without
    // photos (size grows), AND the attachment rows have the
    // original-and-derivative shape Phase 9 specified.
    const fd2 = new FormData();
    fd2.set('entity_type', 'maintenance_requests');
    fd2.set('entity_id', mreq.id);
    fd2.set('file', new File([new Uint8Array(PNG_1X1)], 'test.heic', { type: 'image/heic' }));
    const r = await api('POST', `/v1/accounts/${A.accountId}/attachments`, {
      token: A.accessToken, multipart: fd2,
    });
    const body = assertStatus(r, 201, 'heic upload') as {
      attachment: { id: string; content_hash: string; mime_type: string; derived_from: string | null };
      derivative: { id: string; content_hash: string; mime_type: string; derived_from: string | null } | null;
    };
    if (body.attachment.mime_type !== 'image/heic') {
      throw new Error(`original mime should be image/heic; got ${body.attachment.mime_type}`);
    }
    if (body.attachment.derived_from !== null) {
      throw new Error('original.derived_from must be null');
    }
    // libheif may not be available on every host; if it is, the derivative
    // exists and its derived_from points at the original.
    if (body.derivative) {
      if (body.derivative.mime_type !== 'image/jpeg') {
        throw new Error(`derivative mime should be image/jpeg; got ${body.derivative.mime_type}`);
      }
      if (body.derivative.derived_from !== body.attachment.id) {
        throw new Error(`derivative.derived_from should equal original.id`);
      }
    }
    // Build a fresh export. It must succeed and the PDF must be at least
    // as large as the prior (no-HEIC) export -- meaning the renderer
    // walked the photos section without erroring on the HEIC original.
    const exp = await api('POST', `/v1/accounts/${A.accountId}/evidence-exports`, {
      token: A.accessToken, body: { tenancy_id: A.tenancyId },
    });
    const expBody = assertStatus(exp, 201, 'export with heic') as {
      id: string; size_bytes: number;
    };
    if (expBody.size_bytes < exportSizeBytes) {
      throw new Error(`export with HEIC should not be smaller than without (got ${expBody.size_bytes} < ${exportSizeBytes})`);
    }
    // And the bundle still downloads -- a HEIC rendering exception used
    // to abort generation; we verify it doesn't.
    const dl = await api('GET', `/v1/accounts/${A.accountId}/evidence-exports/${expBody.id}/download`, {
      token: A.accessToken,
    });
    if (dl.status !== 200) throw new Error(`download after HEIC: ${dl.status}`);
  });

  // =========================================================================
  // (J) Evidentiary journal: the export carries COMPLETE correction chains.
  //
  // The PDF binary is not string-greppable (see (E)), so the property is
  // asserted at the two seams the renderer actually uses: loadExportData
  // (which must never return a chain split by the date window) and
  // groupInteractionChains (which must put the original first and every
  // correction after it -- the opposite of the collapsed latest-only view).
  // =========================================================================

  await check('export: amended + retracted interactions carry their FULL chains', async () => {
    const mk = async (body: Record<string, unknown>): Promise<{ id: string; occurred_at: string }> => {
      const r = await api('POST', `/v1/accounts/${A.accountId}/interactions`, {
        token: A.accessToken, body,
      });
      return assertStatus(r, 201, `interaction ${JSON.stringify(body)}`) as { id: string; occurred_at: string };
    };
    // One amended entry -- the amend is re-dated OUTSIDE the export window,
    // then amended again, so chain completion has to walk two links.
    const i1 = await mk({
      tenancy_id: A.tenancyId, party_type: 'tenant', channel: 'phone', direction: 'inbound',
      occurred_at: '2026-04-10T10:00:00.000Z', body: 'Tenant agreed to access on the 12th.',
    });
    const c1 = await mk({
      corrects_id: i1.id, correction_kind: 'amend',
      occurred_at: '2026-07-15T10:00:00.000Z', body: 'Access was agreed for July 15th, not April 12th.',
    });
    const c2 = await mk({
      corrects_id: c1.id, correction_kind: 'amend',
      body: 'Access agreed for July 15th, 9am-12pm.',
    });
    // One retracted entry.
    const i2 = await mk({
      tenancy_id: A.tenancyId, party_type: 'tenant', channel: 'in_person', direction: 'outbound',
      occurred_at: '2026-04-11T09:00:00.000Z', body: 'Asked tenant to clear the hallway.',
    });
    const r2 = await mk({
      corrects_id: i2.id, correction_kind: 'retract', body: 'Wrong tenant; this was unit 2B.',
    });

    // Seam 1: the windowed data set still carries every chain member, even
    // the re-dated amend (July) and its follow-up outside the April window.
    const data = await loadExportData({
      accountId: A.accountId, tenancyId: A.tenancyId,
      fromDate: '2026-04-01', toDate: '2026-04-30', exporter: null,
    });
    const gotIds = new Set(data.interactions.map((x) => String(x.id)));
    for (const [label, id] of [['original', i1.id], ['amend', c1.id], ['second amend', c2.id], ['retracted original', i2.id], ['retraction', r2.id]] as const) {
      if (!gotIds.has(id)) throw new Error(`windowed export data is missing the ${label} (${id}) -- chain was split`);
    }

    // Seam 2: chain grouping renders original-first with every correction
    // after it, in chain order; the retraction keeps its reason.
    const chains = groupInteractionChains(data.interactions);
    const chain1 = chains.find((ch) => String(ch.root.id) === i1.id);
    if (!chain1) throw new Error('amended entry must render as a chain ROOT (original first, never collapsed)');
    if (chain1.corrections.map((x) => String(x.id)).join(',') !== `${c1.id},${c2.id}`) {
      throw new Error(`chain order wrong: ${chain1.corrections.map((x) => x.id).join(',')}`);
    }
    const chain2 = chains.find((ch) => String(ch.root.id) === i2.id);
    if (!chain2) throw new Error('retracted entry must still render as a chain root, not be hidden');
    const retr = chain2.corrections[0];
    if (!retr || retr.correction_kind !== 'retract' || !String(retr.body).includes('unit 2B')) {
      throw new Error('retraction with its reason must follow the retracted original');
    }
    // No chain member may ALSO appear as a root (that would be the
    // collapsed view sneaking in).
    const rootIds = new Set(chains.map((ch) => String(ch.root.id)));
    for (const id of [c1.id, c2.id, r2.id]) {
      if (rootIds.has(id)) throw new Error('a correction leaked into the root set (latest-only collapse)');
    }

    // And the real artifact still builds end-to-end with chains in scope.
    const exp = await api('POST', `/v1/accounts/${A.accountId}/evidence-exports`, {
      token: A.accessToken, body: { tenancy_id: A.tenancyId },
    });
    assertStatus(exp, 201, 'export with correction chains');
  });

  // =========================================================================
  // (C) Tampered chain surfaces as chain_verified=false
  // =========================================================================

  await check('export: tampered event chain surfaces in chain_verified + chain_message', async () => {
    // The events table is locked even from service-role -- the audit
    // spine is meant to be immutable. To simulate a tamper, we connect
    // as the postgres superuser directly via pg and update the row. The
    // test point isn't "service-role can tamper" (good that it can't!)
    // but "if SOMETHING manages to tamper, the bundle says so".
    const c = new Client({ connectionString: status.DB_URL });
    await c.connect();
    try {
      const r = await c.query<{ id: string; event_hash: string }>(
        `select id, encode(event_hash, 'hex') as event_hash
           from public.events
          where account_id = $1 and entity_type = 'maintenance_requests' and event_type = 'inserted'
          order by account_seq asc limit 1`,
        [A.accountId],
      );
      if (r.rowCount === 0) throw new Error('no event to tamper');
      const ev = r.rows[0]!;
      const tampered = Buffer.from(ev.event_hash, 'hex');
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;
      await c.query(
        `update public.events set event_hash = $1 where id = $2`,
        [tampered, ev.id],
      );
    } finally {
      await c.end().catch(() => {});
    }

    const r = await api('POST', `/v1/accounts/${A.accountId}/evidence-exports`, {
      token: A.accessToken, body: { tenancy_id: A.tenancyId },
    });
    const body = assertStatus(r, 201, 'export after tamper') as {
      chain_verified: boolean; chain_message: string;
    };
    if (body.chain_verified) {
      throw new Error('chain should NOT verify after tampering an event_hash');
    }
    if (!/broken/i.test(body.chain_message)) {
      throw new Error(`chain_message should say "broken" or similar: ${body.chain_message}`);
    }
    // The chain_message is also persisted on the evidence_exports row so
    // anyone reading the audit trail later sees the captured-at-export-
    // time verdict, not a re-derivation that could be replayed against a
    // patched-clean chain.
    const idAfter = (body as unknown as { id: string }).id;
    const { data: row } = await admin
      .from('evidence_exports')
      .select('chain_verified, chain_message')
      .eq('id', idAfter).single();
    if (!row) throw new Error('evidence_exports row not found post-tamper');
    if (row.chain_verified !== false) {
      throw new Error('persisted chain_verified should be false');
    }
    if (!/broken/i.test(row.chain_message as string)) {
      throw new Error(`persisted chain_message missing 'broken': ${row.chain_message}`);
    }
  });

  // --- summary ---
  if (failures.length > 0) {
    console.error(`\n${failures.length} Phase 10 failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: Phase 10 evidence-export DoD checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
