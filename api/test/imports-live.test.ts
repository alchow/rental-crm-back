// ----------------------------------------------------------------------------
// OPT-IN live-LLM smoke test for the onboarding import.
//
// This is the ONLY import test that calls the real Anthropic API. It is NOT
// part of `pnpm check`, the `integration` CI job, or any per-PR run -- it
// requires a real ANTHROPIC_API_KEY and costs real tokens. Run it manually:
//
//   ANTHROPIC_API_KEY=sk-... pnpm --filter ./api test:imports-live
//
// Everything else about recognize -> map -> resolve -> preview -> confirm is
// covered deterministically (no key needed) by test/imports.test.ts via
// __setAnthropicForTests.
// ----------------------------------------------------------------------------

import { execSync } from 'node:child_process';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('SKIPPED: imports-live.test.ts requires a real ANTHROPIC_API_KEY (opt-in, not run in CI).');
  process.exit(0);
}

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
process.env.SUPABASE_DB_URL = status.DB_URL;
// ANTHROPIC_API_KEY left as-is from the environment (real key, real call).

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();
const { _resetIntakeIpBucketsForTests } = await import('../src/admin/intake');
const { closePool } = await import('../src/admin/db-pool');
const { buildApp } = await import('../src/app');

const app = buildApp();
await _resetIntakeIpBucketsForTests();

interface ApiResp { status: number; body: unknown }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; multipart?: FormData } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const mutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
  if (mutating && path.startsWith('/v1/accounts/')) {
    headers['idempotency-key'] = `t-${crypto.randomUUID()}`;
  }
  let init: RequestInit = { method, headers };
  if (opts.multipart) {
    init = { ...init, body: opts.multipart };
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init = { ...init, body: JSON.stringify(opts.body) };
  }
  const res = await app.fetch(new Request(`http://test${path}`, init));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function rnd(): string { return Math.random().toString(36).slice(2, 10); }

function csvFile(rows: string[][], filename = 'rentroll.csv'): File {
  const text = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  return new File([text], filename, { type: 'text/csv' });
}

async function main(): Promise<void> {
  console.info('Onboarding import LIVE LLM smoke test (real Anthropic API call)');

  const email = `imp-live-${rnd()}@example.test`;
  const password = `correct-horse-battery-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', { body: { email, password, account_name: 'Live Smoke Acct' } });
  if (su.status !== 200) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.body)}`);
  const { account, session } = su.body as { account: { id: string }; session: { access_token: string } };

  // A realistic small rent roll: property/unit/tenant/move-in/rent.
  const fd = new FormData();
  fd.set('file', csvFile([
    ['Property', 'Unit', 'Tenant Name', 'Move-in Date', 'Monthly Rent'],
    ['Maple Court', '1A', 'Jane Doe', '01/15/2026', '$1,500.00'],
    ['Maple Court', '1B', 'John Smith', '02/01/2026', '$1,650.00'],
  ]));
  const upload = await api('POST', `/v1/accounts/${account.id}/imports`, { token: session.access_token, multipart: fd });
  if (upload.status !== 201) throw new Error(`upload failed: ${upload.status} ${JSON.stringify(upload.body)}`);
  const created = upload.body as { id: string; status: string; recognition: unknown[]; mapping: unknown[] };

  console.info(`session status: ${created.status}`);
  console.info(`recognition: ${JSON.stringify(created.recognition, null, 2)}`);
  console.info(`mapping: ${JSON.stringify(created.mapping, null, 2)}`);

  if (created.status !== 'awaiting_mapping') {
    throw new Error(`expected the LLM to recognize this rent roll as importable, got status=${created.status}`);
  }
  if (created.mapping.length === 0) {
    throw new Error('expected a non-empty suggested mapping for a recognizable rent roll');
  }

  // Exercise the chat refinement turn against the real model too.
  const chatR = await api('POST', `/v1/accounts/${account.id}/imports/${created.id}/chat`, {
    token: session.access_token,
    body: { message: 'What did you map the "Monthly Rent" column to?' },
  });
  if (chatR.status !== 200) throw new Error(`chat failed: ${chatR.status} ${JSON.stringify(chatR.body)}`);
  const chatBody = chatR.body as { reply: string };
  console.info(`chat reply: ${chatBody.reply}`);
  if (!chatBody.reply) throw new Error('expected a non-empty chat reply from the live model');

  console.info('');
  console.info('Live LLM smoke test passed.');
  await closePool();
}

main().catch(async (e) => {
  console.error(e);
  await closePool();
  process.exit(1);
});
