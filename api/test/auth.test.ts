// ----------------------------------------------------------------------------
// Phase 4 JWT middleware unit test.
//
// Verifies the middleware end-to-end through a Hono in-process call (app.fetch),
// without an HTTP listener and without depending on Supabase Auth or PostgREST.
// The middleware verifies ES256 tokens against a JWKS; we mint a keypair here,
// publish the public key via the SUPABASE_JWKS_JSON env override, and sign
// tokens with the private key for each scenario.
//
// Coverage:
//   - valid token -> 200 with the right user_id (A and B)
//   - missing token -> 401 unauthenticated/missing
//   - garbage token -> 401 invalid
//   - expired token -> 401 expired
//   - wrong issuer -> 401
//   - wrong audience -> 401
//   - HS256-signed token rejected (algorithm-confusion mitigation)
//
// /v1/me end-to-end (membership-list response) is deferred to Phase 5 when
// the full Supabase stack (PostgREST + GoTrue via `supabase start`) is wired
// into CI. The middleware itself is fully covered here.
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from 'jose';

// --- env setup BEFORE importing anything that reads env -----------------------
process.env.NODE_ENV = 'test';
// PORT only matters when serve() is called; the in-process app.fetch tests
// here never bind to a port, so just satisfy the env schema with a sentinel.
process.env.PORT = '8787';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key-padded-to-min-length';
process.env.SUPABASE_JWT_ISSUER = 'https://test.supabase.co/auth/v1';
process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';

// Generate ES256 keypair and publish the public key as a JWKS.
const { publicKey: esPublic, privateKey: esPrivate } = await generateKeyPair('ES256');
const esJwk: JWK = await exportJWK(esPublic);
esJwk.kid = 'test-es256-1';
esJwk.alg = 'ES256';
esJwk.use = 'sig';

process.env.SUPABASE_JWKS_JSON = JSON.stringify({ keys: [esJwk] });

// Now safe to import modules that read env.
const { requireAuth, _resetJwksCacheForTests } = await import('../src/middleware/auth');
const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
_resetJwksCacheForTests();

// --- minimal Hono app: middleware + JWT echo handler --------------------------
const app = new Hono();
app.get('/whoami', requireAuth(), (c) => {
  const auth = c.get('auth');
  return c.json({ user_id: auth.userId, email: auth.claims.email ?? null });
});

// --- helpers -----------------------------------------------------------------
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface SignOpts {
  sub: string;
  email?: string;
  iss?: string;
  aud?: string;
  notBeforeOffsetSec?: number;
  expiresInSec?: number;
  alg?: 'ES256';
  kid?: string;
}

async function signEs256(opts: SignOpts): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = now + (opts.notBeforeOffsetSec ?? 0);
  const exp = iat + (opts.expiresInSec ?? 3600);
  return new SignJWT({ email: opts.email, role: 'authenticated' })
    .setProtectedHeader({ alg: opts.alg ?? 'ES256', kid: opts.kid ?? 'test-es256-1' })
    .setSubject(opts.sub)
    .setIssuer(opts.iss ?? 'https://test.supabase.co/auth/v1')
    .setAudience(opts.aud ?? 'authenticated')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(esPrivate);
}

interface CallResult {
  status: number;
  body: { user_id?: string; email?: string | null; error?: { code: string; message: string } };
}

async function call(token?: string): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await app.fetch(new Request('http://test/whoami', { headers }));
  const body = (await res.json()) as CallResult['body'];
  return { status: res.status, body };
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
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

function expect401(name: string, r: CallResult, codeMatch: RegExp, msgMatch?: RegExp): void {
  if (r.status !== 401) {
    throw new Error(`${name}: expected status 401, got ${r.status} body=${JSON.stringify(r.body)}`);
  }
  if (!r.body.error) {
    throw new Error(`${name}: 401 response missing error envelope: ${JSON.stringify(r.body)}`);
  }
  if (!codeMatch.test(r.body.error.code)) {
    throw new Error(`${name}: error.code ${r.body.error.code} does not match ${codeMatch}`);
  }
  if (msgMatch && !msgMatch.test(r.body.error.message)) {
    throw new Error(`${name}: error.message ${r.body.error.message} does not match ${msgMatch}`);
  }
}

// --- the tests ---------------------------------------------------------------
console.info('Phase 4 JWT middleware checks');

await check('valid A token -> 200 with user_id=A', async () => {
  const tok = await signEs256({ sub: USER_A, email: 'alice@test' });
  const r = await call(tok);
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  if (r.body.user_id !== USER_A) throw new Error(`user_id mismatch: ${r.body.user_id}`);
  if (r.body.email !== 'alice@test') throw new Error(`email mismatch: ${r.body.email}`);
});

await check('valid B token -> 200 with user_id=B (no cross-talk)', async () => {
  const tok = await signEs256({ sub: USER_B, email: 'bob@test' });
  const r = await call(tok);
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
  if (r.body.user_id !== USER_B) throw new Error(`user_id mismatch: ${r.body.user_id}`);
});

await check('missing token -> 401 unauthenticated/missing', async () => {
  const r = await call();
  expect401('missing token', r, /unauthenticated/, /missing bearer/i);
});

await check('garbage token -> 401 invalid', async () => {
  const r = await call('not-a-jwt');
  expect401('garbage', r, /unauthenticated/, /invalid token/i);
});

await check('expired token -> 401 expired', async () => {
  const tok = await signEs256({
    sub: USER_A,
    notBeforeOffsetSec: -7200,
    expiresInSec: 60,
  }); // iat 2h ago, exp 1h59m ago
  const r = await call(tok);
  expect401('expired', r, /unauthenticated/, /expired|invalid/i);
});

await check('wrong issuer -> 401', async () => {
  const tok = await signEs256({
    sub: USER_A,
    iss: 'https://malicious.example.com/auth/v1',
  });
  const r = await call(tok);
  expect401('wrong issuer', r, /unauthenticated/);
});

await check('wrong audience -> 401', async () => {
  const tok = await signEs256({ sub: USER_A, aud: 'not-authenticated' });
  const r = await call(tok);
  expect401('wrong audience', r, /unauthenticated/);
});

await check('HS256-signed token rejected (algorithm-confusion mitigation)', async () => {
  // Algorithm-confusion: a token signed with HS256 using the PUBLIC key
  // bytes as the secret. If a verifier doesn't pin the expected algorithm,
  // it might accept this as "valid" with HS256, defeating asymmetric
  // verification. jwtVerify is called with algorithms: ['ES256'] so it
  // should reject this.
  const encoder = new TextEncoder();
  const publicJwkText = JSON.stringify(esJwk);
  const hs256Token = await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER_A)
    .setIssuer('https://test.supabase.co/auth/v1')
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(encoder.encode(publicJwkText));
  const r = await call(hs256Token);
  expect401('HS256 rejected', r, /unauthenticated/);
});

// --- summary -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n${failures.length} JWT-middleware failure(s):`);
  for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.info('\nOK: JWT middleware checks all green');
