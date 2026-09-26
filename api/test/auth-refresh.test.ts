// Concurrent refreshes must return each caller's own session.
// DATA FLOW: two users → two refresh tokens → concurrent refresh → distinct, correctly owned JWTs.

import {
  configureIntegrationEnv,
  createApiClient,
  type ApiResponse as ApiResp,
  createCheckHarness,
  randomToken as rnd,
  assertStatus,
  assert,
} from './helpers/integration';

configureIntegrationEnv('8799');

// Reset cached clients before loading the app with this suite's environment.
const { _resetAdminClientForTests } = await import('../src/admin/supabase-admin');
_resetAdminClientForTests();

const { _resetEnvCacheForTests } = await import('../src/env');
_resetEnvCacheForTests();
const { _resetJwksCacheForTests } = await import('../src/middleware/auth');
_resetJwksCacheForTests();
const { buildApp } = await import('../src/app');

const app = buildApp();

// --- helpers ----------------------------------------------------------------

const api = createApiClient(app);

const { check, failures } = createCheckHarness();

function errCode(r: ApiResp): string {
  return ((r.body as { error?: { code?: string } })?.error?.code) ?? '';
}

// Compare ownership claims; auth.spec.ts separately verifies JWT signatures.
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

// Local email confirmation is disabled, so signup returns a usable refresh token.
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

    // Start both refreshes together to expose accidental sharing of an in-flight result.
    const [ra, rb] = await Promise.all([
      api('POST', '/v1/auth/refresh', { body: { refresh_token: a.refreshToken } }),
      api('POST', '/v1/auth/refresh', { body: { refresh_token: b.refreshToken } }),
    ]);

    const ba = assertStatus(ra, 200, 'refresh A') as { session: Session };
    const bb = assertStatus(rb, 200, 'refresh B') as { session: Session };

    const subA = jwtSub(ba.session.access_token);
    const subB = jwtSub(bb.session.access_token);

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
