// ----------------------------------------------------------------------------
// Onboarding-import (Phase 1) DoD checks.
//
// Covers (review items 1-4):
//   1. Executor write-path validation reuses the SAME exported route Zod
//      schemas an HTTP POST would (no parallel/looser raw-pg validation).
//   2. Cross-account isolation under the service_role executor: an import in
//      account A cannot read or write account B's properties.
//   3. Full pipeline (recognize -> map -> resolve -> preview -> confirm) and
//      every decline/blocker branch, with the Anthropic client REPLACED by a
//      canned FakeAnthropic via __setAnthropicForTests -- no API key needed:
//        - out_of_scope/none everywhere -> no_importable_data, 0 writes, 409
//        - low-confidence column -> left unmapped
//        - unit with no property -> blocker -> confirm 409 -> resolved via
//          default_property_id (bind_existing), property_overrides
//          mode:'create' (create_new), and a mapped property column
//          (from_column); NO placeholder parent is ever auto-created.
//   4. HTTP route-level behavior: missing Idempotency-Key -> 400; the 409
//      gates; account scoping (404 cross-account); standard error envelope.
//
// A SEPARATE, opt-in live-LLM smoke test lives in imports-live.test.ts and is
// NOT part of this file or the default CI run.
// ----------------------------------------------------------------------------

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
process.env.PORT = '8787';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';
// Required by the executor's raw-pg pool (db-pool.ts). Local stack only.
process.env.SUPABASE_DB_URL = status.DB_URL;
// Deliberately NOT set: ANTHROPIC_API_KEY. __setAnthropicForTests below
// replaces the client before any code path would need a real key.
delete process.env.ANTHROPIC_API_KEY;

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { _resetIntakeIpBucketsForTests } = await import('../src/admin/intake');
const { __setAnthropicForTests } = await import('../src/admin/import-llm');
type FakeAnthropic = Parameters<typeof __setAnthropicForTests>[0] & object;
const { closePool } = await import('../src/admin/db-pool');
const { buildApp } = await import('../src/app');

const app = buildApp();
await _resetIntakeIpBucketsForTests();

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown; headers: Record<string, string> }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; multipart?: FormData; idempotencyKey?: string; noIdempotency?: boolean } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/') && !opts.noIdempotency) {
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
  propertyName: string;
}

async function setupUser(label: string): Promise<UserFixture> {
  const email = `imp-${label}-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Acct ${label}` },
  });
  if (su.status !== 200) throw new Error(`signup ${label} failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as {
    user: { id: string };
    account: { id: string };
    session: { access_token: string };
  };
  const userId = b.user.id;
  const accessToken = b.session.access_token;
  const accountId = b.account.id;
  const propertyName = `${label} Existing Bldg ${rnd()}`;
  const propRes = await api('POST', `/v1/accounts/${accountId}/properties`, {
    token: accessToken,
    body: { name: propertyName },
  });
  if (propRes.status !== 201) throw new Error(`setup property ${label} failed: ${propRes.status} ${JSON.stringify(propRes.body)}`);
  const propertyId = (propRes.body as { id: string }).id;
  return { userId, accessToken, accountId, propertyId, propertyName };
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

function assertEnvelope(body: unknown, ctx: string): { code: string; message: string } {
  const b = body as { error?: { code?: unknown; message?: unknown } };
  if (!b || typeof b !== 'object' || !b.error || typeof b.error.code !== 'string' || typeof b.error.message !== 'string') {
    throw new Error(`${ctx}: not a standard error envelope: ${JSON.stringify(body)}`);
  }
  return { code: b.error.code, message: b.error.message };
}

function csvFile(rows: string[][], filename = 'rentroll.csv'): File {
  const text = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  return new File([text], filename, { type: 'text/csv' });
}

async function uploadCsv(user: UserFixture, rows: string[][]): Promise<{ id: string; status: string; mapping: unknown[] }> {
  const fd = new FormData();
  fd.set('file', csvFile(rows));
  const r = await api('POST', `/v1/accounts/${user.accountId}/imports`, { token: user.accessToken, multipart: fd });
  if (r.status !== 201) throw new Error(`upload failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; status: string; mapping: unknown[] };
}

// --- canned LLM responses ----------------------------------------------------

interface ToolUseParams {
  tool_choice?: { type: string; name?: string };
  messages?: { role: string; content: unknown }[];
}

type MappingField = { target_field: string; source_column: string | null; constant: string | null; confidence: number };

/** A FakeAnthropic that returns a fixed recognition + per-entity mappings. */
function fakeAnthropic(opts: {
  recognition: { region_index: number; importable: boolean; summary: string; entity_types: { entity_type: string; confidence: number }[] }[];
  mappings?: Record<string, MappingField[]>;
}): FakeAnthropic {
  return {
    messages: {
      create: async (params: Record<string, unknown>) => {
        const p = params as ToolUseParams;
        const name = p.tool_choice?.name;
        if (name === 'report_recognition') {
          return { content: [{ type: 'tool_use', name, input: { regions: opts.recognition } }] };
        }
        if (name === 'report_mapping') {
          const msgText = JSON.stringify(p.messages ?? []);
          const m = /Entity: (\w+)/.exec(msgText);
          const entity = m?.[1];
          const fields = (entity && opts.mappings?.[entity]) ?? [];
          return { content: [{ type: 'tool_use', name, input: { fields } }] };
        }
        return { content: [{ type: 'text', text: '' }] };
      },
    },
  };
}

// --- tests --------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('Onboarding import (Phase 1) DoD checks');

  const A = await setupUser('A');
  const B = await setupUser('B');

  // =========================================================================
  // (1) out_of_scope/none everywhere -> no_importable_data, 0 writes, 409
  // =========================================================================
  await check('out-of-scope upload -> no_importable_data, mapping empty', async () => {
    __setAnthropicForTests(fakeAnthropic({
      recognition: [{ region_index: 0, importable: false, summary: 'a list of grocery items', entity_types: [] }],
    }));
    const session = await uploadCsv(A, [
      ['Item', 'Price'],
      ['Bananas', '1.50'],
      ['Bread', '3.00'],
    ]);
    if (session.status !== 'no_importable_data') {
      throw new Error(`expected status no_importable_data, got ${session.status}`);
    }
    if (session.mapping.length !== 0) {
      throw new Error(`expected empty mapping, got ${JSON.stringify(session.mapping)}`);
    }

    const previewR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/preview`, { token: A.accessToken });
    assertStatus(previewR, 409, 'preview on no_importable_data');
    assertEnvelope(previewR.body, 'preview on no_importable_data');

    const confirmR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/confirm`, { token: A.accessToken });
    assertStatus(confirmR, 409, 'confirm on no_importable_data');
    assertEnvelope(confirmR.body, 'confirm on no_importable_data');
  });

  // =========================================================================
  // (2) low-confidence column -> left unmapped
  // =========================================================================
  await check('low-confidence column mapping is dropped (left unmapped)', async () => {
    __setAnthropicForTests(fakeAnthropic({
      recognition: [{ region_index: 0, importable: true, summary: 'a property roster', entity_types: [{ entity_type: 'property', confidence: 0.9 }] }],
      mappings: {
        property: [
          { target_field: 'name', source_column: 'Building', constant: null, confidence: 0.95 },
          // Below MIN_CONFIDENCE (0.5) -- must be dropped, not guessed.
          { target_field: 'address_line1', source_column: 'Notes', constant: null, confidence: 0.3 },
        ],
      },
    }));
    const session = await uploadCsv(A, [
      ['Building', 'Notes'],
      ['Maple Court', 'corner lot'],
    ]);
    if (session.status !== 'awaiting_mapping') {
      throw new Error(`expected awaiting_mapping, got ${session.status}`);
    }
    const mapping = session.mapping as { entity_type: string; fields: MappingField[] }[];
    const propertyMapping = mapping.find((m) => m.entity_type === 'property');
    if (!propertyMapping) throw new Error('expected a property mapping entry');
    const fieldNames = propertyMapping.fields.map((f) => f.target_field);
    if (fieldNames.includes('address_line1')) {
      throw new Error(`low-confidence field address_line1 should be left unmapped, got fields=${JSON.stringify(propertyMapping.fields)}`);
    }
    if (!fieldNames.includes('name')) {
      throw new Error(`expected high-confidence field "name" to be mapped, got fields=${JSON.stringify(propertyMapping.fields)}`);
    }
  });

  // =========================================================================
  // (2b) malformed recognition entries are salvaged, not fatal
  // =========================================================================
  await check('malformed recognition entries are dropped; valid ones survive', async () => {
    // One junk region entry and one hallucinated entity_type (outside the
    // enum): both must be dropped without failing the import -- this exact
    // shape previously produced "recognition failed: malformed LLM response".
    __setAnthropicForTests({
      messages: {
        create: async (params: Record<string, unknown>) => {
          const p = params as ToolUseParams;
          if (p.tool_choice?.name === 'report_recognition') {
            return {
              content: [{
                type: 'tool_use',
                name: 'report_recognition',
                input: {
                  regions: [
                    'junk-not-an-object',
                    {
                      region_index: 0,
                      importable: true,
                      summary: 'a property roster',
                      entity_types: [
                        { entity_type: 'charge', confidence: 0.9 }, // out-of-scope hallucination
                        { entity_type: 'property', confidence: 0.9 },
                      ],
                    },
                  ],
                },
              }],
            };
          }
          if (p.tool_choice?.name === 'report_mapping') {
            return {
              content: [{
                type: 'tool_use',
                name: 'report_mapping',
                input: { fields: [{ target_field: 'name', source_column: 'Building', constant: null, confidence: 0.95 }] },
              }],
            };
          }
          return { content: [{ type: 'text', text: '' }] };
        },
      },
    });
    const session = await uploadCsv(A, [
      ['Building', 'Notes'],
      ['Maple Court', 'corner lot'],
    ]);
    if (session.status !== 'awaiting_mapping') {
      throw new Error(`expected awaiting_mapping (salvaged), got ${session.status}`);
    }
    const r = await api('GET', `/v1/accounts/${A.accountId}/imports/${session.id}`, { token: A.accessToken });
    const body = assertStatus(r, 200, 'get salvaged session') as {
      recognition: { entity_types: { entity_type: string }[] }[];
    };
    const entityTypes = body.recognition.flatMap((reg) => reg.entity_types.map((e) => e.entity_type));
    if (entityTypes.includes('charge')) {
      throw new Error(`hallucinated entity_type "charge" should be dropped, got ${JSON.stringify(entityTypes)}`);
    }
    if (!entityTypes.includes('property')) {
      throw new Error(`valid entity_type "property" should survive salvage, got ${JSON.stringify(entityTypes)}`);
    }
  });

  // =========================================================================
  // (2c) unusable recognition response -> one retry; then failed session
  // =========================================================================
  await check('recognition retries once on unusable response, then succeeds', async () => {
    let calls = 0;
    __setAnthropicForTests({
      messages: {
        create: async (params: Record<string, unknown>) => {
          const p = params as ToolUseParams;
          if (p.tool_choice?.name === 'report_recognition') {
            calls++;
            // First attempt: no usable tool input. Second: valid.
            if (calls === 1) return { content: [{ type: 'text', text: 'oops' }] };
            return {
              content: [{
                type: 'tool_use',
                name: 'report_recognition',
                input: { regions: [{ region_index: 0, importable: false, summary: 'nothing structural', entity_types: [] }] },
              }],
            };
          }
          return { content: [{ type: 'text', text: '' }] };
        },
      },
    });
    const session = await uploadCsv(A, [
      ['Item', 'Price'],
      ['Bananas', '1.50'],
    ]);
    if (calls !== 2) throw new Error(`expected exactly 2 recognition attempts, got ${calls}`);
    if (session.status !== 'no_importable_data') {
      throw new Error(`expected no_importable_data after retry, got ${session.status}`);
    }
  });

  await check('recognition unusable on both attempts -> failed session, no 500', async () => {
    let calls = 0;
    __setAnthropicForTests({
      messages: {
        create: async () => {
          calls++;
          return { content: [{ type: 'text', text: 'still oops' }] };
        },
      },
    });
    const session = await uploadCsv(A, [
      ['Item', 'Price'],
      ['Bananas', '1.50'],
    ]);
    if (calls !== 2) throw new Error(`expected exactly 2 recognition attempts, got ${calls}`);
    if (session.status !== 'failed') throw new Error(`expected failed, got ${session.status}`);
    const r = await api('GET', `/v1/accounts/${A.accountId}/imports/${session.id}`, { token: A.accessToken });
    const body = assertStatus(r, 200, 'get failed session') as { error: string | null };
    if (!body.error?.includes('recognition failed')) {
      throw new Error(`expected "recognition failed" in error, got ${JSON.stringify(body.error)}`);
    }
  });

  // =========================================================================
  // (2d) area kinds: units and common areas import; junk kind blocks
  // =========================================================================
  await check('area kind column imports units + common areas; unknown kind blocks the row', async () => {
    __setAnthropicForTests(fakeAnthropic({
      recognition: [{
        region_index: 0,
        importable: true,
        summary: 'a list of units and shared spaces',
        entity_types: [{ entity_type: 'area', confidence: 0.9 }],
      }],
      mappings: {
        area: [
          { target_field: 'name', source_column: 'Area', constant: null, confidence: 0.95 },
          { target_field: 'kind', source_column: 'Type', constant: null, confidence: 0.9 },
        ],
      },
    }));
    const session = await uploadCsv(A, [
      ['Area', 'Type'],
      ['Apt 9', ''],                       // empty kind -> defaults to unit
      ['Front lawn', 'Exterior Grounds'],  // normalizes to exterior_grounds
      ['Closet', 'broom_cupboard'],        // not an AreaKind -> row blocker
    ]);
    if (session.status !== 'awaiting_mapping') throw new Error(`expected awaiting_mapping, got ${session.status}`);

    const patchR = await api('PATCH', `/v1/accounts/${A.accountId}/imports/${session.id}/parents`, {
      token: A.accessToken,
      body: { parent_resolutions: { default_property_id: A.propertyId } },
    });
    assertStatus(patchR, 200, 'patch parents for kind test');

    const previewR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/preview`, { token: A.accessToken });
    const preview = assertStatus(previewR, 200, 'preview kinds') as {
      result: { blockers: { field: string | null; message: string }[]; counts: Record<string, { created: number }> };
    };
    if (preview.result.counts.area?.created !== 2) {
      throw new Error(`expected area created=2 (unit + exterior_grounds), got ${JSON.stringify(preview.result.counts.area)}`);
    }
    const kindBlocker = preview.result.blockers.find((b) => b.message.includes('unknown area kind'));
    if (!kindBlocker) {
      throw new Error(`expected an "unknown area kind" blocker for broom_cupboard, got ${JSON.stringify(preview.result.blockers)}`);
    }
    if ((kindBlocker as { code?: string }).code !== 'invalid_value') {
      throw new Error(`expected blocker code invalid_value, got ${JSON.stringify(kindBlocker)}`);
    }

    // Confirm refuses while the blocker stands; exclude the bad row, then confirm.
    const blockedConfirmR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/confirm`, { token: A.accessToken });
    assertStatus(blockedConfirmR, 409, 'confirm with kind blocker');

    const rowsR = await api('GET', `/v1/accounts/${A.accountId}/imports/${session.id}/rows`, { token: A.accessToken });
    const rows = assertStatus(rowsR, 200, 'list rows for kind test') as { data: { id: string; row_index: number }[] };
    const closetRow = rows.data.find((r) => r.row_index === 2);
    if (!closetRow) throw new Error('expected row_index 2 in rows list');
    const exclR = await api('PATCH', `/v1/accounts/${A.accountId}/imports/${session.id}/rows`, {
      token: A.accessToken,
      body: { updates: [{ id: closetRow.id, excluded: true }] },
    });
    assertStatus(exclR, 200, 'exclude blocked row');

    const confirmR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/confirm`, { token: A.accessToken });
    const confirm = assertStatus(confirmR, 200, 'confirm kinds') as { result: { committed: boolean } };
    if (!confirm.result.committed) throw new Error('expected committed=true');

    const areasR = await api('GET', `/v1/accounts/${A.accountId}/areas?property_id=${A.propertyId}`, { token: A.accessToken });
    const areas = assertStatus(areasR, 200, 'list areas after kind import') as { data: { name: string; kind: string }[] };
    const byName = new Map(areas.data.map((a) => [a.name, a.kind]));
    if (byName.get('Apt 9') !== 'unit') throw new Error(`expected Apt 9 kind=unit, got ${byName.get('Apt 9')}`);
    if (byName.get('Front lawn') !== 'exterior_grounds') {
      throw new Error(`expected Front lawn kind=exterior_grounds, got ${byName.get('Front lawn')}`);
    }
    if (byName.has('Closet')) throw new Error('blocked row "Closet" must not be imported');
  });

  // =========================================================================
  // (3) unit with no property -> blocker -> confirm 409 -> resolutions
  // =========================================================================
  let blockedSessionId = '';
  await check('unit with no property mapped -> blocker in preview, no placeholder property', async () => {
    __setAnthropicForTests(fakeAnthropic({
      recognition: [{
        region_index: 0,
        importable: true,
        summary: 'a unit + move-in roster, no property column',
        entity_types: [
          { entity_type: 'area', confidence: 0.9 },
          { entity_type: 'tenancy', confidence: 0.9 },
        ],
      }],
      mappings: {
        area: [{ target_field: 'name', source_column: 'Unit', constant: null, confidence: 0.9 }],
        tenancy: [{ target_field: 'start_date', source_column: 'Move-in', constant: null, confidence: 0.9 }],
      },
    }));
    const session = await uploadCsv(A, [
      ['Unit', 'Move-in'],
      ['101', '2026-02-01'],
    ]);
    if (session.status !== 'awaiting_mapping') throw new Error(`expected awaiting_mapping, got ${session.status}`);
    blockedSessionId = session.id;

    // The FE-facing machine-readable signal: property needed, nothing supplies
    // it yet -- available straight off the upload response, before any preview.
    const req = (session as unknown as { requirements: { property: { needed: boolean; satisfied: boolean; sources: string[] } } }).requirements;
    if (!req || req.property.needed !== true || req.property.satisfied !== false || req.property.sources.length !== 0) {
      throw new Error(`expected requirements.property {needed:true, satisfied:false, sources:[]}, got ${JSON.stringify(req)}`);
    }

    const previewR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/preview`, { token: A.accessToken });
    const previewBody = assertStatus(previewR, 200, 'preview') as { result: { blockers: { code?: string }[]; counts: Record<string, { created: number; reused: number }> } };
    if (previewBody.result.blockers.length === 0) {
      throw new Error('expected a blocker for the unmapped property parent');
    }
    if (!previewBody.result.blockers.some((b) => b.code === 'missing_parent_property')) {
      throw new Error(`expected a missing_parent_property code, got ${JSON.stringify(previewBody.result.blockers)}`);
    }
    const propCounts = previewBody.result.counts.property;
    if (!propCounts || propCounts.created !== 0 || propCounts.reused !== 0) {
      throw new Error(`expected NO placeholder property, got counts.property=${JSON.stringify(propCounts)}`);
    }

    const confirmR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/confirm`, { token: A.accessToken });
    const confirmBody = assertStatus(confirmR, 409, 'confirm with unresolved blocker');
    assertEnvelope(confirmBody, 'confirm with unresolved blocker');
  });

  await check('bind_existing via default_property_id resolves the blocker', async () => {
    const r = await api('PATCH', `/v1/accounts/${A.accountId}/imports/${blockedSessionId}/parents`, {
      token: A.accessToken,
      body: { parent_resolutions: { default_property_id: A.propertyId } },
    });
    const patched = assertStatus(r, 200, 'patch parents (default_property_id)') as {
      requirements: { property: { needed: boolean; satisfied: boolean; sources: string[] } };
    };
    // requirements flips to satisfied the moment the parent is supplied.
    const pr = patched.requirements?.property;
    if (!pr || pr.needed !== true || pr.satisfied !== true || !pr.sources.includes('default_property_id')) {
      throw new Error(`expected requirements.property satisfied via default_property_id, got ${JSON.stringify(patched.requirements)}`);
    }

    const previewR = await api('POST', `/v1/accounts/${A.accountId}/imports/${blockedSessionId}/preview`, { token: A.accessToken });
    const previewBody = assertStatus(previewR, 200, 'preview after default_property_id') as {
      result: { blockers: unknown[]; counts: Record<string, { created: number; reused: number }> };
    };
    if (previewBody.result.blockers.length !== 0) {
      throw new Error(`expected no blockers after binding default property, got ${JSON.stringify(previewBody.result.blockers)}`);
    }
    if (previewBody.result.counts.property?.reused !== 1 || previewBody.result.counts.property?.created !== 0) {
      throw new Error(`expected property reused=1 created=0, got ${JSON.stringify(previewBody.result.counts.property)}`);
    }
    if (previewBody.result.counts.area?.created !== 1) {
      throw new Error(`expected area created=1, got ${JSON.stringify(previewBody.result.counts.area)}`);
    }

    const confirmR = await api('POST', `/v1/accounts/${A.accountId}/imports/${blockedSessionId}/confirm`, { token: A.accessToken });
    const confirmBody = assertStatus(confirmR, 200, 'confirm after binding default property') as {
      result: { committed: boolean; counts: Record<string, { created: number; reused: number }> };
    };
    if (!confirmBody.result.committed) throw new Error('expected committed=true');
    if (confirmBody.result.counts.area?.created !== 1) {
      throw new Error(`expected area created=1 on commit, got ${JSON.stringify(confirmBody.result.counts.area)}`);
    }
  });

  // -- from_column (reuse-by-name AND create-by-name) + create_new override + bind_existing override
  let fromColumnSessionId = '';
  await check('from_column: property name reused by match, created when absent', async () => {
    __setAnthropicForTests(fakeAnthropic({
      recognition: [{
        region_index: 0,
        importable: true,
        summary: 'a property+unit+move-in roster',
        entity_types: [
          { entity_type: 'property', confidence: 0.9 },
          { entity_type: 'area', confidence: 0.9 },
          { entity_type: 'tenancy', confidence: 0.9 },
        ],
      }],
      mappings: {
        property: [{ target_field: 'name', source_column: 'Property', constant: null, confidence: 0.9 }],
        area: [{ target_field: 'name', source_column: 'Unit', constant: null, confidence: 0.9 }],
        tenancy: [{ target_field: 'start_date', source_column: 'Move-in', constant: null, confidence: 0.9 }],
      },
    }));
    const session = await uploadCsv(A, [
      ['Property', 'Unit', 'Move-in'],
      [A.propertyName, '201', '2026-03-01'], // matches A's existing property by name
      ['Brand New Bldg', '301', '2026-03-01'], // no match -> created
    ]);
    fromColumnSessionId = session.id;

    const previewR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/preview`, { token: A.accessToken });
    const previewBody = assertStatus(previewR, 200, 'preview from_column') as {
      result: { blockers: unknown[]; counts: Record<string, { created: number; reused: number }> };
    };
    if (previewBody.result.blockers.length !== 0) {
      throw new Error(`expected no blockers, got ${JSON.stringify(previewBody.result.blockers)}`);
    }
    if (previewBody.result.counts.property?.reused !== 1 || previewBody.result.counts.property?.created !== 1) {
      throw new Error(`expected property reused=1 created=1, got ${JSON.stringify(previewBody.result.counts.property)}`);
    }
  });

  await check('create_new override (mode:create) forces a new property despite a name match', async () => {
    const r = await api('PATCH', `/v1/accounts/${A.accountId}/imports/${fromColumnSessionId}/parents`, {
      token: A.accessToken,
      body: { parent_resolutions: { property_overrides: { [A.propertyName]: { mode: 'create' } } } },
    });
    assertStatus(r, 200, 'patch parents (create_new override)');

    const previewR = await api('POST', `/v1/accounts/${A.accountId}/imports/${fromColumnSessionId}/preview`, { token: A.accessToken });
    const previewBody = assertStatus(previewR, 200, 'preview create_new override') as {
      result: { blockers: unknown[]; counts: Record<string, { created: number; reused: number }> };
    };
    if (previewBody.result.blockers.length !== 0) {
      throw new Error(`expected no blockers, got ${JSON.stringify(previewBody.result.blockers)}`);
    }
    // Both rows now create a property: row1 forced via override, row2 still has no name match.
    if (previewBody.result.counts.property?.created !== 2 || previewBody.result.counts.property?.reused !== 0) {
      throw new Error(`expected property created=2 reused=0, got ${JSON.stringify(previewBody.result.counts.property)}`);
    }
  });

  await check('bind_existing override (mode:existing,id) binds a name to a specific property', async () => {
    const r = await api('PATCH', `/v1/accounts/${A.accountId}/imports/${fromColumnSessionId}/parents`, {
      token: A.accessToken,
      body: { parent_resolutions: { property_overrides: { 'Brand New Bldg': { mode: 'existing', id: A.propertyId } } } },
    });
    assertStatus(r, 200, 'patch parents (bind_existing override)');

    const previewR = await api('POST', `/v1/accounts/${A.accountId}/imports/${fromColumnSessionId}/preview`, { token: A.accessToken });
    const previewBody = assertStatus(previewR, 200, 'preview bind_existing override') as {
      result: { blockers: unknown[]; counts: Record<string, { created: number; reused: number }> };
    };
    if (previewBody.result.blockers.length !== 0) {
      throw new Error(`expected no blockers, got ${JSON.stringify(previewBody.result.blockers)}`);
    }
    // row1 matches A.propertyName by name (reused); row2 bound by id to the same property (reused).
    if (previewBody.result.counts.property?.reused !== 2 || previewBody.result.counts.property?.created !== 0) {
      throw new Error(`expected property reused=2 created=0, got ${JSON.stringify(previewBody.result.counts.property)}`);
    }
  });

  // =========================================================================
  // (item 2) cross-account isolation: account A's import cannot touch B's data
  // =========================================================================
  await check('cross-account: default_property_id pointing at B\'s property blocks, writes nothing', async () => {
    __setAnthropicForTests(fakeAnthropic({
      recognition: [{
        region_index: 0,
        importable: true,
        summary: 'unit + move-in roster, no property column',
        entity_types: [
          { entity_type: 'area', confidence: 0.9 },
          { entity_type: 'tenancy', confidence: 0.9 },
        ],
      }],
      mappings: {
        area: [{ target_field: 'name', source_column: 'Unit', constant: null, confidence: 0.9 }],
        tenancy: [{ target_field: 'start_date', source_column: 'Move-in', constant: null, confidence: 0.9 }],
      },
    }));
    const session = await uploadCsv(A, [
      ['Unit', 'Move-in'],
      ['XACCT', '2026-04-01'],
    ]);

    const patchR = await api('PATCH', `/v1/accounts/${A.accountId}/imports/${session.id}/parents`, {
      token: A.accessToken,
      body: { parent_resolutions: { default_property_id: B.propertyId } },
    });
    assertStatus(patchR, 200, 'patch parents (cross-account default_property_id)');

    // Snapshot B's properties/areas before the (attempted) import.
    const bAreasBefore = await api('GET', `/v1/accounts/${B.accountId}/areas`, { token: B.accessToken });
    assertStatus(bAreasBefore, 200, 'B areas before');
    const bAreaCountBefore = (bAreasBefore.body as { data: unknown[] }).data.length;

    const previewR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/preview`, { token: A.accessToken });
    const previewBody = assertStatus(previewR, 200, 'preview cross-account default_property_id') as {
      result: { blockers: { message: string }[]; counts: Record<string, { created: number; reused: number }> };
    };
    if (previewBody.result.blockers.length === 0) {
      throw new Error('expected a blocker: B\'s property is not in A\'s account');
    }
    if (!previewBody.result.blockers.some((bl) => /not found in this account/.test(bl.message))) {
      throw new Error(`expected "not found in this account" blocker, got ${JSON.stringify(previewBody.result.blockers)}`);
    }
    if (previewBody.result.counts.property?.created !== 0 || previewBody.result.counts.area?.created !== 0) {
      throw new Error(`expected zero creates, got property=${JSON.stringify(previewBody.result.counts.property)} area=${JSON.stringify(previewBody.result.counts.area)}`);
    }

    const confirmR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/confirm`, { token: A.accessToken });
    assertStatus(confirmR, 409, 'confirm cross-account default_property_id');

    // B's areas are unchanged -- no leakage of writes into account B.
    const bAreasAfter = await api('GET', `/v1/accounts/${B.accountId}/areas`, { token: B.accessToken });
    assertStatus(bAreasAfter, 200, 'B areas after');
    const bAreaCountAfter = (bAreasAfter.body as { data: unknown[] }).data.length;
    if (bAreaCountAfter !== bAreaCountBefore) {
      throw new Error(`account B gained areas from account A's import: before=${bAreaCountBefore} after=${bAreaCountAfter}`);
    }
  });

  await check('cross-account: bind_existing property_overrides with B\'s property id blocks', async () => {
    __setAnthropicForTests(fakeAnthropic({
      recognition: [{
        region_index: 0,
        importable: true,
        summary: 'property + unit + move-in roster',
        entity_types: [
          { entity_type: 'property', confidence: 0.9 },
          { entity_type: 'area', confidence: 0.9 },
          { entity_type: 'tenancy', confidence: 0.9 },
        ],
      }],
      mappings: {
        property: [{ target_field: 'name', source_column: 'Property', constant: null, confidence: 0.9 }],
        area: [{ target_field: 'name', source_column: 'Unit', constant: null, confidence: 0.9 }],
        tenancy: [{ target_field: 'start_date', source_column: 'Move-in', constant: null, confidence: 0.9 }],
      },
    }));
    const propName = `Cross Acct Bind ${rnd()}`;
    const session = await uploadCsv(A, [
      ['Property', 'Unit', 'Move-in'],
      [propName, 'X1', '2026-04-01'],
    ]);

    const patchR = await api('PATCH', `/v1/accounts/${A.accountId}/imports/${session.id}/parents`, {
      token: A.accessToken,
      body: { parent_resolutions: { property_overrides: { [propName]: { mode: 'existing', id: B.propertyId } } } },
    });
    assertStatus(patchR, 200, 'patch parents (cross-account bind_existing override)');

    const previewR = await api('POST', `/v1/accounts/${A.accountId}/imports/${session.id}/preview`, { token: A.accessToken });
    const previewBody = assertStatus(previewR, 200, 'preview cross-account bind_existing override') as {
      result: { blockers: { message: string }[]; counts: Record<string, { created: number; reused: number }> };
    };
    if (!previewBody.result.blockers.some((bl) => /not found in this account/.test(bl.message))) {
      throw new Error(`expected "not found in this account" blocker, got ${JSON.stringify(previewBody.result.blockers)}`);
    }
    if (previewBody.result.counts.property?.created !== 0 || previewBody.result.counts.property?.reused !== 0) {
      throw new Error(`expected zero property writes, got ${JSON.stringify(previewBody.result.counts.property)}`);
    }
  });

  // =========================================================================
  // (item 4) HTTP route-level behavior
  // =========================================================================
  await check('missing Idempotency-Key on POST import upload -> 400', async () => {
    const fd = new FormData();
    fd.set('file', csvFile([['A', 'B'], ['1', '2']]));
    const r = await api('POST', `/v1/accounts/${A.accountId}/imports`, { token: A.accessToken, multipart: fd, noIdempotency: true });
    const body = assertStatus(r, 400, 'missing idempotency key');
    const env = assertEnvelope(body, 'missing idempotency key');
    if (!/Idempotency-Key/i.test(env.message)) {
      throw new Error(`expected Idempotency-Key message, got ${JSON.stringify(env)}`);
    }
  });

  await check('account scoping: account B cannot read account A\'s import session (404)', async () => {
    const r = await api('GET', `/v1/accounts/${B.accountId}/imports/${blockedSessionId}`, { token: B.accessToken });
    const body = assertStatus(r, 404, 'cross-account session read');
    assertEnvelope(body, 'cross-account session read');
  });

  await check('account scoping: account B cannot preview/confirm account A\'s import session (404)', async () => {
    const previewR = await api('POST', `/v1/accounts/${B.accountId}/imports/${blockedSessionId}/preview`, { token: B.accessToken });
    assertStatus(previewR, 404, 'cross-account preview');
    const confirmR = await api('POST', `/v1/accounts/${B.accountId}/imports/${blockedSessionId}/confirm`, { token: B.accessToken });
    assertStatus(confirmR, 404, 'cross-account confirm');
  });

  await check('confirm on an already-done session -> 409 conflict, standard envelope', async () => {
    const confirmR = await api('POST', `/v1/accounts/${A.accountId}/imports/${blockedSessionId}/confirm`, { token: A.accessToken });
    const body = assertStatus(confirmR, 409, 'confirm already-done session');
    const env = assertEnvelope(body, 'confirm already-done session');
    if (env.code !== 'conflict') throw new Error(`expected code=conflict, got ${env.code}`);
  });

  // --- summary -----------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) FAILED:`);
    for (const f of failures) console.error(`  - ${f.name}: ${f.detail}`);
    await closePool();
    process.exit(1);
  }
  console.info('All onboarding-import checks passed.');
  await closePool();
}

main().catch(async (e) => {
  console.error(e);
  await closePool();
  process.exit(1);
});
