// JWT middleware spec (vitest port of auth.test.ts, Phase 2.5).
//
// Verifies the middleware end-to-end through a Hono in-process call, without
// an HTTP listener and without Supabase Auth or PostgREST: we mint an ES256
// keypair, publish the public key via the SUPABASE_JWKS_JSON env override,
// and sign tokens with the private key per scenario.

import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { setFakeEnv } from './helpers/env';

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let esPrivate: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let esJwk: JWK;
let app: Hono;

interface SignOpts {
  sub: string;
  email?: string;
  iss?: string;
  aud?: string;
  expiresInSec?: number;
  kid?: string;
}

async function signEs256(opts: SignOpts): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: opts.email, role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? 'test-es256-1' })
    .setSubject(opts.sub)
    .setIssuer(opts.iss ?? 'https://test.supabase.co/auth/v1')
    .setAudience(opts.aud ?? 'authenticated')
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expiresInSec ?? 3600))
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
  return { status: res.status, body: (await res.json()) as CallResult['body'] };
}

function expect401(r: CallResult, codeMatch: RegExp): void {
  expect(r.status).toBe(401);
  expect(r.body.error).toBeDefined();
  expect(r.body.error!.code).toMatch(codeMatch);
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  esPrivate = pair.privateKey;
  esJwk = await exportJWK(pair.publicKey);
  esJwk.kid = 'test-es256-1';
  esJwk.alg = 'ES256';
  esJwk.use = 'sig';

  setFakeEnv({ SUPABASE_JWKS_JSON: JSON.stringify({ keys: [esJwk] }) });

  const { _resetEnvCacheForTests } = await import('../src/env');
  _resetEnvCacheForTests();
  const { requireAuth, _resetJwksCacheForTests } = await import('../src/middleware/auth');
  _resetJwksCacheForTests();

  app = new Hono();
  app.get('/whoami', requireAuth(), (c) => {
    const auth = c.get('auth');
    return c.json({ user_id: auth.userId, email: auth.claims.email ?? null });
  });
});

describe('JWT middleware (ES256 via JWKS)', () => {
  it('valid A token -> 200 with user_id=A', async () => {
    const r = await call(await signEs256({ sub: USER_A, email: 'alice@test' }));
    expect(r.status).toBe(200);
    expect(r.body.user_id).toBe(USER_A);
    expect(r.body.email).toBe('alice@test');
  });

  it('valid B token -> 200 with user_id=B (no cross-talk)', async () => {
    const r = await call(await signEs256({ sub: USER_B, email: 'bob@test' }));
    expect(r.status).toBe(200);
    expect(r.body.user_id).toBe(USER_B);
  });

  it('missing token -> 401', async () => {
    expect401(await call(), /unauthenticated/);
  });

  it('garbage token -> 401', async () => {
    expect401(await call('not-a-jwt'), /unauthenticated/);
  });

  it('expired token -> 401', async () => {
    expect401(await call(await signEs256({ sub: USER_A, expiresInSec: -60 })), /unauthenticated/);
  });

  it('wrong issuer -> 401', async () => {
    expect401(
      await call(await signEs256({ sub: USER_A, iss: 'https://evil.example.com/auth/v1' })),
      /unauthenticated/,
    );
  });

  it('wrong audience -> 401', async () => {
    expect401(await call(await signEs256({ sub: USER_A, aud: 'anon' })), /unauthenticated/);
  });

  it('HS256-signed token rejected (algorithm-confusion mitigation)', async () => {
    const encoder = new TextEncoder();
    const now = Math.floor(Date.now() / 1000);
    const hs256Token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER_A)
      .setIssuer('https://test.supabase.co/auth/v1')
      .setAudience('authenticated')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(encoder.encode(JSON.stringify(esJwk)));
    expect401(await call(hs256Token), /unauthenticated/);
  });
});
