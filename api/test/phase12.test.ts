// ----------------------------------------------------------------------------
// Phase 12 DoD tests.
//
// Covers three guide-vs-spec drift fixes -- routes the integration guide
// documented and clients assumed, but that were never wired into the typed
// OpenAPI surface (or never built at all):
//
//   * GET /v1/me -- now a typed createRoute. Caller identity (off the
//     verified JWT only) + RLS-scoped account memberships, deterministically
//     ordered by (account_name, account_id) so a client's "auto-select the
//     first membership" is stable.
//   * DELETE /v1/accounts/{accountId}/inspection-templates/{id} -- plain
//     soft delete; list/get already filtered deleted_at, so this just closes
//     the loop.
//   * DELETE /v1/accounts/{accountId}/inspections/{inspectionId}/items/{id}
//     -- soft delete that reuses the existing completion-gate trigger
//     (_reject_item_update_on_completed_inspection): a completed inspection's
//     items stay immutable end to end (409), while an open inspection can
//     drop a draft item before it's ever rendered into the report.
//
// Each route also gets a contract-drift assertion: present in the committed
// openapi.json AND actually reachable through the generated SDK over a real
// HTTP round trip (an ephemeral @hono/node-server instance, not app.fetch
// directly) -- a route that's typed but unreachable, or reachable but
// missing from the spec, both fail this check.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createRentalCrmClient } from '@rentalcrm/sdk';

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
process.env.PORT = '8793';
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
const { buildApp } = await import('../src/app');

const app = buildApp();
await _resetIntakeIpBucketsForTests();

const { createClient } = await import('@supabase/supabase-js');
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = opts.idempotencyKey ?? `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });
  // Binary responses (e.g. attachment / report downloads) aren't JSON --
  // read them as bytes instead of trying to JSON.parse the PDF/image body.
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
  email: string;
  accessToken: string;
  accountId: string;
  accountName: string;
  unitAreaId: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `p12-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const accountName = `Phase12 ${label} ${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', { body: { email, password, account_name: accountName } });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { user: { id: string; email: string | null }; account: { id: string }; session: { access_token: string } };
  const accessToken = b.session.access_token;
  const accountId = b.account.id;
  // Supabase Auth normalises (lower-cases) stored emails -- echo back what
  // the server actually persisted rather than the mixed-case string we sent,
  // so later equality checks against /v1/me's response aren't a casing trap.
  const storedEmail = b.user.email ?? email;
  const post = async <T>(p: string, body: unknown): Promise<T> => {
    const r = await api('POST', p, { token: accessToken, body });
    if (r.status !== 201) throw new Error(`setup POST ${p} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as T;
  };
  const property = await post<{ id: string }>(`/v1/accounts/${accountId}/properties`, { name: `${label} prop` });
  const unitArea = await post<{ id: string }>(
    `/v1/accounts/${accountId}/areas`,
    { property_id: property.id, kind: 'unit', name: `${label} unit` },
  );
  return {
    userId: b.user.id, email: storedEmail, accessToken, accountId, accountName,
    unitAreaId: unitArea.id,
  };
}

async function createInspection(user: UserFixture): Promise<string> {
  const r = await api('POST', `/v1/accounts/${user.accountId}/inspections`, {
    token: user.accessToken,
    body: { area_id: user.unitAreaId, performed_at: '2026-05-01T10:00:00Z', notes: 'phase12 fixture' },
  });
  const body = assertStatus(r, 201, 'create inspection') as { id: string };
  return body.id;
}

async function createItem(user: UserFixture, inspectionId: string, label: string): Promise<string> {
  const r = await api('POST', `/v1/accounts/${user.accountId}/inspections/${inspectionId}/items`, {
    token: user.accessToken, body: { label },
  });
  const body = assertStatus(r, 201, 'create item') as { id: string };
  return body.id;
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

// --- PDF text extraction -----------------------------------------------------
//
// pdfkit compresses content streams with FlateDecode and shows text as
// hex-encoded glyph strings (`<...> Tj` / `[<...> kern <...> ...] TJ`),
// split at kerning-pair boundaries. To check whether a label string was (or
// wasn't) rendered, we inflate every stream, pull out every `<hex>` run in
// document order, and concatenate their decoded bytes -- kerning numbers
// live outside the angle brackets, so this reconstructs the shown text
// exactly regardless of where pdfkit chose to split it.
function pdfRenderedText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    let decompressed: string;
    try {
      decompressed = inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      continue; // binary stream (embedded font / image), not page content
    }
    const hexGroups = decompressed.match(/<[0-9a-fA-F]+>/g) ?? [];
    out.push(hexGroups.map((g) => Buffer.from(g.slice(1, -1), 'hex').toString('latin1')).join(''));
  }
  return out.join('\n');
}

// --- ephemeral HTTP server + SDK client for contract-drift assertions -------
//
// The contract-drift gate (pnpm check:drift) catches spec/SDK drift at
// commit time; these checks catch it at call time -- a route that's
// documented in openapi.json but unreachable, or reachable but missing
// from the generated types, both fail here. SDK calls must cross real HTTP
// (the generated client builds Requests and hits global fetch), so we bind
// the app to an OS-assigned ephemeral port rather than calling app.fetch.
function startEphemeralServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0 });
    server.once('error', reject);
    server.once('listening', () => {
      const addr = server.address() as AddressInfo | string | null;
      if (addr === null || typeof addr === 'string') {
        reject(new Error('ephemeral server did not yield an AddressInfo'));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

const specPath = `${process.cwd().endsWith('/api') ? '..' : '.'}/openapi/openapi.json`;
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { paths: Record<string, Record<string, unknown> | undefined> };

function assertInSpec(path: string, method: string): void {
  const ops = spec.paths[path];
  if (!ops || !(method in ops)) {
    throw new Error(`${method.toUpperCase()} ${path} missing from the committed openapi.json`);
  }
}

// --- tests -------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Phase 12 DoD checks: GET /v1/me + soft-delete inspection-templates/items');

  const A = await setupUser('A');
  const B = await setupUser('B');
  const C = await setupUser('C');

  const { port, close } = await startEphemeralServer();
  let sdkToken = '';
  const sdk = createRentalCrmClient({ baseUrl: `http://127.0.0.1:${port}`, accessToken: () => sdkToken });

  try {
    // =======================================================================
    // GET /v1/me
    // =======================================================================

    await check('me: caller in 2 accounts sees exactly those 2, deterministically ordered', async () => {
      // There is no "invite a member" endpoint -- the only way to put a
      // single user in a second account is to write account_members
      // directly (service-role, bypassing RLS), exactly the kind of
      // fixture-only state a real owner-adds-a-manager flow would produce.
      const { error: insErr } = await admin.from('account_members').insert({
        account_id: C.accountId, user_id: A.userId, role: 'viewer',
      });
      if (insErr) throw new Error(`fixture: add A to C's account failed: ${insErr.message}`);

      const r = await api('GET', '/v1/me', { token: A.accessToken });
      const body = assertStatus(r, 200, 'GET /v1/me') as {
        user: { id: string; email: string | null };
        memberships: Array<{ account_id: string; account_name: string; role: string }>;
      };
      if (body.user.id !== A.userId) throw new Error(`user.id mismatch: got ${body.user.id}`);
      if (body.user.email !== A.email) throw new Error(`user.email mismatch: got ${body.user.email}`);
      if (body.memberships.length !== 2) {
        throw new Error(`expected exactly 2 memberships, got ${body.memberships.length}: ${JSON.stringify(body.memberships)}`);
      }

      const own = body.memberships.find((m) => m.account_id === A.accountId);
      const extra = body.memberships.find((m) => m.account_id === C.accountId);
      if (!own || own.role !== 'owner' || own.account_name !== A.accountName) {
        throw new Error(`own-account membership wrong: ${JSON.stringify(own)}`);
      }
      if (!extra || extra.role !== 'viewer' || extra.account_name !== C.accountName) {
        throw new Error(`second-account membership wrong: ${JSON.stringify(extra)}`);
      }

      // Deterministic order: (account_name, account_id) ascending.
      const expected = [
        { account_id: A.accountId, account_name: A.accountName },
        { account_id: C.accountId, account_name: C.accountName },
      ].sort((x, y) => x.account_name.localeCompare(y.account_name) || x.account_id.localeCompare(y.account_id));
      const gotOrder = body.memberships.map((m) => m.account_id);
      const wantOrder = expected.map((m) => m.account_id);
      if (gotOrder.join(',') !== wantOrder.join(',')) {
        throw new Error(`membership order not deterministic by (account_name, account_id): got ${gotOrder}, want ${wantOrder}`);
      }
    });

    await check('me: caller with zero memberships sees memberships: []', async () => {
      const D = await setupUser('D');
      // Likewise, "a user who is in zero accounts" isn't reachable through
      // any existing endpoint (signup always creates one) -- soft-delete
      // their membership directly to model what an owner removing the last
      // member (or the user leaving) would leave behind.
      const { error } = await admin.from('account_members')
        .update({ deleted_at: new Date().toISOString() })
        .eq('user_id', D.userId).eq('account_id', D.accountId);
      if (error) throw new Error(`fixture: soft-delete D's membership failed: ${error.message}`);

      const r = await api('GET', '/v1/me', { token: D.accessToken });
      const body = assertStatus(r, 200, 'GET /v1/me (zero memberships)') as {
        user: { id: string };
        memberships: unknown[];
      };
      if (body.user.id !== D.userId) throw new Error(`user.id mismatch: got ${body.user.id}`);
      if (!Array.isArray(body.memberships) || body.memberships.length !== 0) {
        throw new Error(`expected memberships: [], got ${JSON.stringify(body.memberships)}`);
      }
    });

    await check('me: cross-account isolation -- caller sees only their own memberships', async () => {
      const r = await api('GET', '/v1/me', { token: B.accessToken });
      const body = assertStatus(r, 200, 'GET /v1/me (B)') as {
        memberships: Array<{ account_id: string }>;
      };
      const ids = body.memberships.map((m) => m.account_id);
      if (ids.length !== 1 || ids[0] !== B.accountId) {
        throw new Error(`expected B to see only [${B.accountId}], got ${JSON.stringify(ids)}`);
      }
      if (ids.includes(A.accountId) || ids.includes(C.accountId)) {
        throw new Error(`RLS leak: B's /v1/me exposed another account's membership: ${JSON.stringify(ids)}`);
      }
    });

    await check('me: GET /v1/me is in openapi.json and reachable through the generated SDK', async () => {
      assertInSpec('/v1/me', 'get');

      sdkToken = A.accessToken;
      const { data, error, response } = await sdk.GET('/v1/me', {});
      if (error || !data) throw new Error(`SDK GET /v1/me failed: ${response.status} ${JSON.stringify(error)}`);
      if (data.user.id !== A.userId) throw new Error(`SDK response user.id mismatch: ${data.user.id}`);
      if (!Array.isArray(data.memberships) || data.memberships.length !== 2) {
        throw new Error(`SDK response memberships wrong: ${JSON.stringify(data.memberships)}`);
      }
    });

    // =======================================================================
    // DELETE /v1/accounts/{accountId}/inspection-templates/{id}
    // =======================================================================

    let templateId = '';
    await check('templates: DELETE soft-deletes; list and get exclude it afterward', async () => {
      const created = await api('POST', `/v1/accounts/${A.accountId}/inspection-templates`, {
        token: A.accessToken, body: { name: `Move-out checklist ${rnd()}` },
      });
      const cb = assertStatus(created, 201, 'create template') as { id: string };
      templateId = cb.id;

      const del = await api('DELETE', `/v1/accounts/${A.accountId}/inspection-templates/${templateId}`, { token: A.accessToken });
      if (del.status !== 204) throw new Error(`expected 204, got ${del.status} body=${JSON.stringify(del.body)}`);

      const get = await api('GET', `/v1/accounts/${A.accountId}/inspection-templates/${templateId}`, { token: A.accessToken });
      if (get.status !== 404) throw new Error(`expected 404 fetching a deleted template, got ${get.status}`);

      const list = await api('GET', `/v1/accounts/${A.accountId}/inspection-templates`, { token: A.accessToken });
      const lb = assertStatus(list, 200, 'list templates') as { data: Array<{ id: string }> };
      if (lb.data.some((t) => t.id === templateId)) throw new Error('deleted template still appears in the list');

      // Soft delete, never a hard delete -- the row survives with deleted_at set.
      const { data: row, error } = await admin.from('inspection_templates')
        .select('deleted_at').eq('id', templateId).maybeSingle();
      if (error || !row) throw new Error(`template row missing after delete: ${error?.message ?? 'no row'}`);
      if (!row.deleted_at) throw new Error('deleted_at not set -- looks like a hard delete or a no-op');
    });

    await check('templates: DELETE is in openapi.json and reachable through the generated SDK', async () => {
      assertInSpec('/v1/accounts/{accountId}/inspection-templates/{id}', 'delete');

      const created = await api('POST', `/v1/accounts/${A.accountId}/inspection-templates`, {
        token: A.accessToken, body: { name: `SDK probe template ${rnd()}` },
      });
      const cb = assertStatus(created, 201, 'create probe template') as { id: string };

      sdkToken = A.accessToken;
      const { error, response } = await sdk.DELETE('/v1/accounts/{accountId}/inspection-templates/{id}', {
        params: {
          path: { accountId: A.accountId, id: cb.id },
          header: { 'Idempotency-Key': `sdk-probe-${rnd()}` },
        },
      });
      if (error) throw new Error(`SDK DELETE template failed: ${response.status} ${JSON.stringify(error)}`);
      if (response.status !== 204) throw new Error(`expected 204 via SDK, got ${response.status}`);
    });

    // =======================================================================
    // DELETE /v1/accounts/{accountId}/inspections/{inspectionId}/items/{id}
    // =======================================================================

    let openInspectionId = '';
    let keepItemId = '';
    let dropItemId = '';
    const keepLabel = `Keep-${rnd()}`;
    const dropLabel = `DropMe-${rnd()}`;

    await check('items, open inspection: DELETE soft-deletes a draft item; list excludes it', async () => {
      openInspectionId = await createInspection(A);
      keepItemId = await createItem(A, openInspectionId, keepLabel);
      dropItemId = await createItem(A, openInspectionId, dropLabel);

      const del = await api('DELETE', `/v1/accounts/${A.accountId}/inspections/${openInspectionId}/items/${dropItemId}`, { token: A.accessToken });
      if (del.status !== 204) throw new Error(`expected 204, got ${del.status} body=${JSON.stringify(del.body)}`);

      const list = await api('GET', `/v1/accounts/${A.accountId}/inspections/${openInspectionId}/items`, { token: A.accessToken });
      const lb = assertStatus(list, 200, 'list items') as { data: Array<{ id: string }> };
      if (lb.data.some((i) => i.id === dropItemId)) throw new Error('soft-deleted item still in the list');
      if (!lb.data.some((i) => i.id === keepItemId)) throw new Error('kept item missing from the list');
    });

    await check('items: create + delete are both present in the audit trail', async () => {
      const { data: events, error } = await admin.from('events')
        .select('event_type')
        .eq('account_id', A.accountId)
        .eq('entity_type', 'inspection_items')
        .eq('entity_id', dropItemId);
      if (error) throw new Error(`audit query failed: ${error.message}`);
      const types = (events ?? []).map((e) => e.event_type as string);
      if (!types.includes('inserted')) throw new Error(`no 'inserted' audit event for the deleted item; got ${JSON.stringify(types)}`);
      if (!types.includes('deleted')) throw new Error(`no 'deleted' audit event for the deleted item; got ${JSON.stringify(types)}`);
    });

    await check('items: a soft-deleted draft item never appears in the completion PDF', async () => {
      const complete = await api('POST', `/v1/accounts/${A.accountId}/inspections/${openInspectionId}/complete`, { token: A.accessToken });
      const cb = assertStatus(complete, 200, 'complete inspection') as {
        report: { attachment_id: string };
      };
      const dl = await api('GET', `/v1/accounts/${A.accountId}/attachments/${cb.report.attachment_id}/download`, { token: A.accessToken });
      assertStatus(dl, 200, 'download report PDF');
      const text = pdfRenderedText(dl.body as Uint8Array);
      if (!text.includes(keepLabel)) throw new Error(`kept item's label "${keepLabel}" is missing from the rendered PDF`);
      if (text.includes(dropLabel)) throw new Error(`soft-deleted item's label "${dropLabel}" leaked into the rendered PDF`);
    });

    let completedInspectionId = '';
    let lockedItemId = '';
    await check('items, COMPLETED inspection: DELETE is rejected with 409 and the item is unchanged', async () => {
      completedInspectionId = await createInspection(A);
      lockedItemId = await createItem(A, completedInspectionId, `Locked-${rnd()}`);
      const complete = await api('POST', `/v1/accounts/${A.accountId}/inspections/${completedInspectionId}/complete`, { token: A.accessToken });
      assertStatus(complete, 200, 'complete inspection');

      const del = await api('DELETE', `/v1/accounts/${A.accountId}/inspections/${completedInspectionId}/items/${lockedItemId}`, { token: A.accessToken });
      if (del.status !== 409) throw new Error(`expected 409 conflict, got ${del.status} body=${JSON.stringify(del.body)}`);

      const { data: row, error } = await admin.from('inspection_items')
        .select('deleted_at').eq('id', lockedItemId).maybeSingle();
      if (error || !row) throw new Error(`item row missing: ${error?.message ?? 'no row'}`);
      if (row.deleted_at !== null) throw new Error(`item was soft-deleted despite the 409: deleted_at=${row.deleted_at}`);
    });

    await check('items: cross-account DELETE is rejected as not_found, and the item is untouched', async () => {
      const bInspectionId = await createInspection(B);
      const bItemId = await createItem(B, bInspectionId, `B-item-${rnd()}`);

      const r = await api('DELETE', `/v1/accounts/${B.accountId}/inspections/${bInspectionId}/items/${bItemId}`, { token: A.accessToken });
      if (r.status !== 404) throw new Error(`expected 404 (no cross-account existence leak), got ${r.status} body=${JSON.stringify(r.body)}`);

      const { data: row } = await admin.from('inspection_items').select('deleted_at').eq('id', bItemId).maybeSingle();
      if (row?.deleted_at) throw new Error("cross-account DELETE soft-deleted another account's item");
    });

    await check('items: DELETE is in openapi.json and reachable through the generated SDK', async () => {
      assertInSpec('/v1/accounts/{accountId}/inspections/{inspectionId}/items/{id}', 'delete');

      const probeInspectionId = await createInspection(A);
      const probeItemId = await createItem(A, probeInspectionId, `SDK probe item ${rnd()}`);

      sdkToken = A.accessToken;
      const { error, response } = await sdk.DELETE('/v1/accounts/{accountId}/inspections/{inspectionId}/items/{id}', {
        params: {
          path: { accountId: A.accountId, inspectionId: probeInspectionId, id: probeItemId },
          header: { 'Idempotency-Key': `sdk-probe-${rnd()}` },
        },
      });
      if (error) throw new Error(`SDK DELETE item failed: ${response.status} ${JSON.stringify(error)}`);
      if (response.status !== 204) throw new Error(`expected 204 via SDK, got ${response.status}`);
    });
  } finally {
    await close();
  }

  // --- summary ---
  if (failures.length > 0) {
    console.error(`\n${failures.length} Phase 12 failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: Phase 12 DoD checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
