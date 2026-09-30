import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import {
  configureIntegrationEnv,
  createApiClient,
  assertStatus,
  assert,
  createCheckHarness,
} from './helpers/integration';

const status = configureIntegrationEnv('8796', { LOG_LEVEL: 'fatal' });
const { buildApp } = await import('../src/app');
const { getAdminClient } = await import('../src/admin/supabase-admin');
const { provisionRootSecret } = await import('../src/admin/agent-tokens');
const admin = getAdminClient();
const api = createApiClient(buildApp());
const { check, failures } = createCheckHarness();
const secret = randomBytes(32).toString('hex');
const keyId = `test-${randomUUID()}`;
const verifierId = randomUUID();
async function signup() {
  const r = await api('POST', '/v1/auth/signup', {
    body: {
      email: `phone-${randomUUID()}@example.test`,
      password: randomBytes(24).toString('hex'),
      account_name: 'Phone test',
    },
  });
  const b = assertStatus(r, 200, 'signup') as {
    user: { id: string };
    session: { access_token: string };
  };
  const { data, error } = await admin
    .from('account_members')
    .select('account_id')
    .eq('user_id', b.user.id)
    .single();
  if (error) throw error;
  return { id: b.user.id, token: b.session.access_token, accountId: data.account_id };
}
const owner = await signup();
const other = await signup();
// Signup enables the default assistant. Revoke it through the public API so
// this fixture actually represents a no-grant account.
const grants = (
  await api('GET', `/v1/accounts/${owner.accountId}/agent-grants`, { token: owner.token })
).body as { data: { id: string }[] };
for (const grant of grants.data) {
  assertStatus(
    await api('POST', `/v1/accounts/${owner.accountId}/agent-grants/${grant.id}/revoke`, {
      token: owner.token,
    }),
    200,
    'revoke fixture grant',
  );
}
const key = await admin.from('phone_verifier_keys').insert({
  key_id: keyId,
  verifier_id: verifierId,
  secret_hash: createHash('sha256').update(secret).digest('hex'),
});
if (key.error) throw key.error;
const proof = {
  verification_id: randomUUID(),
  phone: '+14155550123',
  expires_at: new Date(Date.now() + 600_000).toISOString(),
};
const path = `/v1/accounts/${owner.accountId}/owner-phone-verifications/confirm`;
const headers = {
  'x-phone-verifier-key-id': keyId,
  'x-phone-verifier-secret': secret,
  'x-correlation-id': `owner-phone-${proof.verification_id}`,
};
const confirm = (body = proof, extra: Parameters<typeof api>[2] = {}) =>
  api('POST', path, {
    token: owner.token,
    headers,
    body,
    idempotencyKey: `owner-phone-${body.verification_id}`,
    ...extra,
  });
let first: unknown;
await check('no agent grant: owner + verifier commits and profile reflects it', async () => {
  first = assertStatus(await confirm(), 200, 'confirm');
  const p = assertStatus(
    await api('GET', '/v1/profile', { token: owner.token }),
    200,
    'profile',
  ) as { phone: string; phone_verified_at: string };
  assert(p.phone === proof.phone && p.phone_verified_at, 'profile not verified');
});
await check('account that has never had a grant can verify', async () => {
  const freshAccount = randomUUID();
  const account = await admin.from('accounts').insert({ id: freshAccount, name: 'Never granted' });
  if (account.error) throw account.error;
  const member = await admin
    .from('account_members')
    .insert({ account_id: freshAccount, user_id: owner.id, role: 'owner' });
  if (member.error) throw member.error;
  const body = { ...proof, verification_id: randomUUID() };
  assertStatus(
    await api('POST', `/v1/accounts/${freshAccount}/owner-phone-verifications/confirm`, {
      token: owner.token,
      headers,
      body,
      idempotencyKey: `owner-phone-${body.verification_id}`,
    }),
    200,
    'never-granted account',
  );
  const { count } = await admin
    .from('agent_grants')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', freshAccount);
  assert(count === 0, 'verification created a grant');
});
await check('receipt failure rolls back the profile update', async () => {
  const db = new pg.Client({ connectionString: status.DB_URL });
  await db.connect();
  const id = randomUUID();
  const name = `test_phone_${id.replaceAll('-', '')}`;
  const prior = assertStatus(
    await api('GET', '/v1/profile', { token: owner.token }),
    200,
    'prior profile',
  );
  try {
    await db.query(`create function public.${name}() returns trigger language plpgsql as $$
      begin if new.verification_id = '${id}'::uuid then raise exception 'simulated receipt failure'; end if;
      return new; end; $$;
      create trigger ${name} before insert on public.owner_phone_verification_receipts for each row execute function public.${name}();`);
    assertStatus(
      await confirm({ ...proof, verification_id: id, phone: '+14155550199' }),
      500,
      'receipt failure',
    );
    const after = assertStatus(
      await api('GET', '/v1/profile', { token: owner.token }),
      200,
      'profile after rollback',
    );
    assert(JSON.stringify(prior) === JSON.stringify(after), 'profile write escaped transaction');
    const { count } = await admin
      .from('owner_phone_verification_receipts')
      .select('*', { count: 'exact', head: true })
      .eq('verification_id', id);
    assert(count === 0, 'failed receipt persisted');
  } finally {
    await db.query(
      `drop trigger if exists ${name} on public.owner_phone_verification_receipts; drop function if exists public.${name}();`,
    );
    await db.end();
  }
});
await check('same request replays exactly; changed phone/expiry conflict', async () => {
  const r = await confirm();
  assertStatus(r, 200, 'replay');
  assert(r.headers['idempotency-replay'] === 'true', 'missing replay marker');
  assert(JSON.stringify(r.body) === JSON.stringify(first), 'replay changed result');
  assertStatus(await confirm({ ...proof, phone: '+14155550124' }), 409, 'phone conflict');
  assertStatus(
    await confirm({ ...proof, expires_at: new Date(Date.now() + 10000).toISOString() }),
    409,
    'expiry conflict',
  );
});
await check('retry reauthenticates verifier; neither credential alone works', async () => {
  assertStatus(
    await confirm(proof, {
      headers: { ...headers, 'x-phone-verifier-secret': 'wrong'.repeat(10) },
    }),
    403,
    'wrong secret',
  );
  assertStatus(await confirm(proof, { headers: {} }), 400, 'missing verifier');
  assertStatus(await confirm(proof, { token: undefined }), 401, 'missing user');
  assertStatus(await confirm(proof, { token: other.token }), 404, 'cross account');
  assertStatus(
    await confirm({ ...proof, user_id: other.id } as typeof proof),
    400,
    'target injection',
  );
});
await check('expiry and maximum horizon checked on first commit', async () => {
  for (const delta of [-1000, 700_000]) {
    assertStatus(
      await confirm({
        ...proof,
        verification_id: randomUUID(),
        expires_at: new Date(Date.now() + delta).toISOString(),
      }),
      400,
      'invalid expiry',
    );
  }
});
await check('concurrent submissions produce one receipt and one timestamp', async () => {
  const body = { ...proof, verification_id: randomUUID(), phone: '+14155550125' };
  const rs = await Promise.all([confirm(body), confirm(body)]);
  for (const r of rs) assertStatus(r, 200, 'concurrent');
  assert(JSON.stringify(rs[0]!.body) === JSON.stringify(rs[1]!.body), 'different commits');
  const { count } = await admin
    .from('owner_phone_verification_receipts')
    .select('*', { count: 'exact', head: true })
    .eq('verification_id', body.verification_id);
  assert(count === 1, 'duplicate receipt');
  assertStatus(await confirm(), 200, 'old replay');
  const p = (await api('GET', '/v1/profile', { token: owner.token })).body as { phone: string };
  assert(p.phone === body.phone, 'old replay overwrote new phone');
});
await check('same human and proof cannot change accounts', async () => {
  const { error } = await admin
    .from('account_members')
    .insert({ account_id: other.accountId, user_id: owner.id, role: 'manager' });
  if (error) throw error;
  assertStatus(
    await api('POST', `/v1/accounts/${other.accountId}/owner-phone-verifications/confirm`, {
      token: owner.token,
      headers,
      body: proof,
      idempotencyKey: `owner-phone-${proof.verification_id}`,
    }),
    409,
    'account conflict',
  );
});
await check('authenticated replay survives proof expiry', async () => {
  const body = {
    ...proof,
    verification_id: randomUUID(),
    expires_at: new Date(Date.now() + 2000).toISOString(),
  };
  const before = assertStatus(await confirm(body), 200, 'short proof');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const replay = assertStatus(await confirm(body), 200, 'expired replay');
  assert(JSON.stringify(before) === JSON.stringify(replay), 'expired replay changed');
});
await check('key rotation preserves receipts; disabled key cannot replay', async () => {
  const rotated = `${keyId}-r`;
  const { error } = await admin.from('phone_verifier_keys').insert({
    key_id: rotated,
    verifier_id: verifierId,
    secret_hash: createHash('sha256').update(secret).digest('hex'),
  });
  if (error) throw error;
  await admin
    .from('phone_verifier_keys')
    .update({ disabled_at: new Date().toISOString() })
    .eq('key_id', keyId);
  assertStatus(await confirm(), 403, 'disabled');
  const r = await confirm(proof, { headers: { ...headers, 'x-phone-verifier-key-id': rotated } });
  assertStatus(r, 200, 'rotated replay');
  assert(JSON.stringify(r.body) === JSON.stringify(first), 'rotation rewrote');
  await admin.from('phone_verifier_keys').update({ disabled_at: null }).eq('key_id', keyId);
});
await check('live role check rejects cached owner after demotion; manager succeeds', async () => {
  await admin
    .from('account_members')
    .update({ role: 'viewer' })
    .eq('account_id', owner.accountId)
    .eq('user_id', owner.id);
  assertStatus(await confirm(), 403, 'demoted retry');
  await admin
    .from('account_members')
    .update({ role: 'manager' })
    .eq('account_id', owner.accountId)
    .eq('user_id', owner.id);
  assertStatus(await confirm(), 200, 'manager');
  await admin
    .from('account_members')
    .update({ deleted_at: new Date().toISOString() })
    .eq('account_id', owner.accountId)
    .eq('user_id', owner.id);
  assertStatus(await confirm(), 403, 'removed cached member');
  await admin
    .from('account_members')
    .update({ role: 'owner', deleted_at: null })
    .eq('account_id', owner.accountId)
    .eq('user_id', owner.id);
});
await check('raw human cannot call privileged RPC or set verified column', async () => {
  const caller = createClient(status.API_URL, status.ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${owner.token}` } },
  });
  const rpc = await caller.rpc('confirm_owner_phone_verification', {
    p_key_id: keyId,
    p_secret_hash: createHash('sha256').update(secret).digest('hex'),
    p_user_id: owner.id,
    p_account_id: owner.accountId,
    p_verification_id: randomUUID(),
    p_phone: proof.phone,
    p_expires_at: proof.expires_at,
    p_correlation_id: 'direct-test',
  });
  assert(rpc.error, 'raw user executed privileged function');
  const patch = await caller
    .from('users')
    .update({ phone_verified_at: new Date().toISOString() })
    .eq('id', owner.id);
  assert(patch.error, 'raw user bypassed verification');
  const change = await caller
    .from('users')
    .update({ phone: '+14155550129' })
    .eq('id', owner.id)
    .select('phone_verified_at')
    .single();
  assert(
    !change.error && change.data.phone_verified_at === null,
    'phone change retained verification',
  );
});
await check('verifier cannot discover or mint agent access', async () => {
  assertStatus(
    await api('GET', '/v1/agent/accounts', { headers: { 'x-agent-secret': secret } }),
    401,
    'discovery',
  );
  assertStatus(
    await api('POST', '/v1/agent/tokens', {
      headers: { 'x-agent-secret': secret },
      body: { account_id: owner.accountId },
    }),
    401,
    'mint',
  );
});
await check('legacy agent route still works; agent JWT rejected by confirm', async () => {
  const root = await provisionRootSecret('default');
  const grant = await api('POST', `/v1/accounts/${owner.accountId}/agent-grants`, {
    token: owner.token,
  });
  assertStatus(grant, 201, 'grant');
  const minted = await api('POST', '/v1/agent/tokens', {
    headers: { 'x-agent-secret': root.secret },
    body: { account_id: owner.accountId },
  });
  const token = (assertStatus(minted, 200, 'mint') as { access_token: string }).access_token;
  assertStatus(await confirm(proof, { token }), 403, 'agent confirm');
  assertStatus(
    await api('POST', `/v1/accounts/${owner.accountId}/owner-phone-verifications`, {
      token,
      body: { user_id: owner.id, phone: proof.phone },
    }),
    200,
    'legacy',
  );
});
if (failures.length) process.exitCode = 1;
else console.info('All owner phone verifier checks passed.');
