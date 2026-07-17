// ----------------------------------------------------------------------------
// POST /v1/auth/refresh regression test. Exercised against a real Supabase
// stack (GoTrue token endpoint), in-process via buildApp() + app.fetch.
//
// WHY THIS EXISTS — prod incident 2026-07-17 (cross-account session cross-talk).
// The refresh handler USED to call the shared anon supabase-js client's
// refreshSession(). gotrue-js collapses every concurrent _callRefreshToken on
// ONE client instance into a single in-flight promise, REGARDLESS of which
// refresh_token each caller passed ("refreshing is already in progress" →
// returns the winner's promise). This proxy serves many sessions at once — the
// agent transport refreshes one session per granted account, and those all land
// on the same tick because they were minted together at agent boot. Under the
// shared client, N concurrent refreshes of N DIFFERENT refresh_tokens all got
// the SAME winner's session, so every non-winning account received a token for
// the wrong user and its calls 404'd under RLS. The fix (api/src/routes/auth.ts)
// is a stateless fetch to GoTrue REST /auth/v1/token?grant_type=refresh_token —
// no shared client state to collapse on. The refresh route previously had ZERO
// direct coverage; this is that direct regression.
//
//   * Two fresh users signed up via the API; their two refresh_tokens are
//     refreshed CONCURRENTLY (Promise.all). BOTH must 200, and each returned
//     access_token's `sub` must match ITS OWN user id. Cross-talk (both subs
//     identical, i.e. one winner) is the incident and FAILS the test. The two
//     access_tokens must also differ.
//   * A garbage refresh_token → 401 with error.code 'unauthenticated' (GoTrue
//     4xx maps to a logout signal, not a retryable 503).
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
process.env.PORT = '8799';
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.SUPABASE_JWKS_URL = `${status.API_URL}/auth/v1/.well-known/jwks.json`;
process.env.SUPABASE_JWT_ISSUER = `${status.API_URL}/auth/v1`;
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

// Same boot ritual as accounts-branding.test.ts: reset the lazy singletons so
// they snapshot the test env set above, THEN import buildApp.
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { buildApp } = await import('../src/app');

const app = buildApp();

// --- helpers ----------------------------------------------------------------

interface ApiResp { status: number; body: unknown }

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResp> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
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
function assertStatus(r: ApiResp, expected: number, ctx: string): unknown {
  if (r.status !== expected) throw new Error(
    `${ctx}: expected ${expected}, got ${r.status} body=${JSON.stringify(r.body)}`,
  );
  return r.body;
}
function errCode(r: ApiResp): string {
  return ((r.body as { error?: { code?: string } })?.error?.code) ?? '';
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Decode a JWT payload without verifying the signature — we only need the
// `sub` claim to prove the refreshed session belongs to the right user. The
// middle segment is base64url; Buffer handles the url-alphabet + padding.
function jwtSub(accessToken: string): string {
  const seg = accessToken.split('.')[1];
  if (!seg) throw new Error(`not a JWT: ${accessToken.slice(0, 16)}…`);
  const json = Buffer.from(seg, 'base64url').toString('utf8');
  const claims = JSON.parse(json) as { sub?: string };
  if (!claims.sub) throw new Error(`JWT has no sub claim: ${json}`);
  return claims.sub;
}

interface Session { access_token: string; refresh_token: string }
interface Signup { userId: string; refreshToken: string; email: string }

// Sign a fresh user up via the public API and collect their session's
// refresh_token (the harness pattern — the local stack has email confirmation
// disabled, so signup returns a live session directly).
async function signup(): Promise<Signup> {
  const email = `auth-refresh-${rnd()}@example.test`;
  const password = `correct-horse-${rnd()}`;
  const su = await api('POST', '/v1/auth/signup', {
    body: { email, password, account_name: `Refresh Acct ${rnd()}` },
  });
  if (su.status !== 200) throw new Error(`signup failed: ${su.status} ${JSON.stringify(su.body)}`);
  const b = su.body as { user: { id: string }; session: Session };
  if (!b.session?.refresh_token) throw new Error(`signup returned no refresh_token: ${JSON.stringify(su.body)}`);
  return { userId: b.user.id, refreshToken: b.session.refresh_token, email };
}

// --- tests ------------------------------------------------------------------

async function main(): Promise<void> {
  console.info('POST /v1/auth/refresh regression tests');

  await check('concurrent refresh of two sessions returns each its OWN session (no cross-talk)', async () => {
    // Two independent users, minted separately, each holding its own token.
    const a = await signup();
    const b = await signup();
    assert(a.userId !== b.userId, 'the two signups must be different users');
    assert(a.refreshToken !== b.refreshToken, 'the two refresh tokens must differ');

    // Fire BOTH refreshes on the same tick — the exact shape that collapsed
    // onto a single winner under the old shared-client refreshSession().
    const [ra, rb] = await Promise.all([
      api('POST', '/v1/auth/refresh', { body: { refresh_token: a.refreshToken } }),
      api('POST', '/v1/auth/refresh', { body: { refresh_token: b.refreshToken } }),
    ]);

    const ba = assertStatus(ra, 200, 'refresh A') as { session: Session };
    const bb = assertStatus(rb, 200, 'refresh B') as { session: Session };

    const subA = jwtSub(ba.session.access_token);
    const subB = jwtSub(bb.session.access_token);

    // The incident, precisely: cross-talk makes BOTH subs equal the winner's.
    assert(
      subA === a.userId,
      `session A belongs to the wrong user: sub=${subA} expected=${a.userId} (cross-talk: subB=${subB})`,
    );
    assert(
      subB === b.userId,
      `session B belongs to the wrong user: sub=${subB} expected=${b.userId} (cross-talk: subA=${subA})`,
    );
    assert(
      subA !== subB,
      `both refreshed sessions carry the SAME sub (${subA}) — this is the collapse`,
    );
    assert(
      ba.session.access_token !== bb.session.access_token,
      'the two refreshed access_tokens must differ',
    );
  });

  await check('garbage refresh_token → 401 unauthenticated', async () => {
    const r = await api('POST', '/v1/auth/refresh', {
      body: { refresh_token: `not-a-real-refresh-token-${rnd()}` },
    });
    assertStatus(r, 401, 'garbage refresh');
    if (errCode(r) !== 'unauthenticated') throw new Error(`code: ${errCode(r)}`);
  });

  // --- summary ---------------------------------------------------------------
  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} auth-refresh check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: auth-refresh checks all green');
}

await main();
