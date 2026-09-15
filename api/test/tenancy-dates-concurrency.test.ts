// Live local DB checks for atomic corrections, serialized editors, and unchanged money.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const connectionString = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const account = randomUUID();
const user = randomUUID();
const tenancy = randomUUID();
const unit = randomUUID();
const property = randomUUID();
const admin = new pg.Client({ connectionString });
await admin.connect();

async function member<T>(
  fn: (client: pg.Client) => Promise<T>,
  actor = user,
  role = 'authenticated',
): Promise<T> {
  assert(['authenticated', 'service_role'].includes(role));
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '8s'");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: actor, role }),
    ]);
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

async function context(t = tenancy) {
  return member(
    async (c) =>
      (await c.query('select get_tenancy_date_context($1,$2) as v', [account, t])).rows[0].v,
  );
}
async function apply(body: Record<string, unknown>, key = randomUUID(), t = tenancy) {
  const fingerprint = createHash('sha256')
    .update(user + JSON.stringify(body))
    .digest('hex');
  return member(async (c) => {
    await c.query('select claim_idempotency_key($1,$2,$3)', [account, key, fingerprint]);
    return (
      await c.query('select correct_tenancy_dates($1,$2,$3,$4,$5) as v', [
        account,
        t,
        key,
        fingerprint,
        body,
      ])
    ).rows[0].v;
  });
}
function change(
  ctx: { context_fingerprint: string; facts: { date_revision: number } },
  start: string,
) {
  return {
    changes: { start_date: start },
    expected_date_revision: ctx.facts.date_revision,
    expected_context_fingerprint: ctx.context_fingerprint,
    expected_resulting_status: 'active',
    reason_code: 'data_entry_error',
    reason_note: 'Corrected from the key handover record.',
  };
}
async function money() {
  const result: Record<string, unknown> = {};
  for (const table of ['charges', 'payments', 'payment_allocations']) {
    result[table] = (
      await admin.query(`select * from ${table} where account_id=$1 order by id`, [account])
    ).rows;
  }
  return result;
}

try {
  await admin.query('begin');
  await admin.query('insert into auth.users(id,email) values($1,$2)', [
    user,
    `date-${user}@example.test`,
  ]);
  await admin.query('insert into accounts(id,name) values($1,$2)', [
    account,
    'Date concurrency fixture',
  ]);
  await admin.query("insert into account_members(account_id,user_id,role) values($1,$2,'owner')", [
    account,
    user,
  ]);
  await admin.query('insert into properties(id,account_id,name) values($1,$2,$3)', [
    property,
    account,
    'Date fixture',
  ]);
  await admin.query(
    "insert into areas(id,account_id,property_id,kind,name) values($1,$2,$3,'unit','Date unit')",
    [unit, account, property],
  );
  await admin.query(
    "insert into tenancies(id,account_id,area_id,start_date,status) values($1,$2,$3,'2026-07-01','active')",
    [tenancy, account, unit],
  );
  const charges = await admin.query(
    `insert into charges(account_id,tenancy_id,type,amount_cents,currency,due_date)
    select $1,$2,'rent',10000,'USD',date '2026-01-01' + (i * interval '1 month') from generate_series(0,11) i returning id`,
    [account, tenancy],
  );
  const payment = await admin.query(
    `insert into payments(account_id,tenancy_id,amount_cents,currency,received_at,method)
    values($1,$2,5000,'USD','2025-12-01','ach') returning id`,
    [account, tenancy],
  );
  await admin.query(
    'insert into payment_allocations(account_id,payment_id,charge_id,amount_cents) values($1,$2,$3,5000)',
    [account, payment.rows[0].id, charges.rows[0].id],
  );
  await admin.query('commit');

  const before = await money();
  const document = randomUUID();
  await admin.query(
    "insert into documents(id,account_id,tenancy_id,document_type,title) values($1,$2,$3,'move_in','Key handover')",
    [document, account, tenancy],
  );
  await admin.query(
    "insert into document_versions(account_id,document_id,version_no,source,static_template_id,static_asset_path,content_hash,size_bytes) values($1,$2,1,'bundled_static','fixture','fixture.pdf',$3,0)",
    [account, document, 'a'.repeat(64)],
  );
  const ctx = await context();
  const sameDates = randomUUID();
  await admin.query(
    "insert into tenancies(id,account_id,area_id,start_date,status) values($1,$2,$3,'2026-07-01','active')",
    [sameDates, account, unit],
  );
  assert.notEqual((await context(sameDates)).context_fingerprint, ctx.context_fingerprint);
  const proposal = { ...change(ctx, '2026-05-01'), source_document_id: document };
  const key = randomUUID();
  const saved = await apply(proposal, key);
  assert.equal(saved.tenancy.start_date, '2026-05-01');
  assert.equal(saved.record.created_by, user);
  assert.equal(saved.record.before_facts.start_date, '2026-07-01');
  assert.equal(saved.tenancy.date_revision, 1);
  assert.equal(saved.record.source_document_snapshot.versions[0].content_hash, 'a'.repeat(64));
  await admin.query(
    "insert into document_versions(account_id,document_id,version_no,source,static_template_id,static_asset_path,content_hash,size_bytes) values($1,$2,2,'bundled_static','fixture','fixture.pdf',$3,0)",
    [account, document, 'b'.repeat(64)],
  );
  assert.deepEqual(await money(), before);
  assert.deepEqual(await apply(proposal, key), saved);
  await assert.rejects(
    apply({ ...proposal, reason_note: 'Different request' }, key),
    /fingerprint/,
  );
  console.info(
    'PASS: 13 money entries and allocation preserved; durable replay and actor verified',
  );

  const fresh = await context();
  const rollbackKey = randomUUID();
  const rollbackBody = change(fresh, '2026-02-01');
  const rollbackFingerprint = createHash('sha256')
    .update(JSON.stringify(rollbackBody))
    .digest('hex');
  await assert.rejects(
    member(async (c) => {
      await c.query('select claim_idempotency_key($1,$2,$3)', [
        account,
        rollbackKey,
        rollbackFingerprint,
      ]);
      await c.query('select correct_tenancy_dates($1,$2,$3,$4,$5)', [
        account,
        tenancy,
        rollbackKey,
        rollbackFingerprint,
        rollbackBody,
      ]);
      throw new Error('injected transaction failure');
    }),
    /injected transaction failure/,
  );
  assert.deepEqual(await context(), fresh);
  assert.equal(
    (
      await admin.query(
        'select id from tenancy_date_records where account_id=$1 and request_key=$2',
        [account, rollbackKey],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await admin.query('select key from idempotency_keys where account_id=$1 and key=$2', [
        account,
        rollbackKey,
      ])
    ).rowCount,
    0,
  );
  assert.deepEqual(await money(), before);
  console.info(
    'PASS: transaction failure rolls back date facts, history, and idempotency together',
  );
  const raced = await Promise.allSettled([
    apply(change(fresh, '2026-04-01')),
    apply(change(fresh, '2026-03-01')),
  ]);
  assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = raced.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(rejected.reason), /date_context_changed/);
  assert.equal((await context()).facts.date_revision, 2);
  assert.deepEqual(await money(), before);
  console.info('PASS: concurrent editors serialize; stale editor cannot overwrite');

  const future = await apply(
    { ...change(await context(sameDates), '2030-04-01'), expected_resulting_status: 'upcoming' },
    randomUUID(),
    sameDates,
  );
  assert.equal(future.tenancy.status, 'upcoming');
  const futureCtx = await context(sameDates);
  const confirmed = await apply(
    {
      ...change(futureCtx, '2030-04-01'),
      changes: { start_date_basis: 'possession_entitlement', actual_move_in_date: '2026-04-01' },
      expected_resulting_status: 'upcoming',
    },
    randomUUID(),
    sameDates,
  );
  assert.equal(confirmed.tenancy.start_date, '2030-04-01');
  assert.equal(confirmed.tenancy.status, 'upcoming');
  assert.equal(confirmed.tenancy.actual_move_in_date, '2026-04-01');
  const restored = await apply(
    change(await context(sameDates), '2026-04-01'),
    randomUUID(),
    sameDates,
  );
  assert.equal(restored.tenancy.status, 'active');
  assert.deepEqual(await money(), before);
  console.info('PASS: future/past possession controls status; basis and physical arrival do not');

  for (const role of ['authenticated', 'service_role']) {
    await assert.rejects(
      member(
        async (c) => {
          await c.query("select set_config('audit.date_correction','true',true)");
          await c.query("update tenancies set start_date='2026-02-01' where id=$1", [tenancy]);
        },
        user,
        role,
      ),
      /date_correction_required/,
    );
  }
  // SET ROLE from this test's postgres session can use the session owner's rights.
  // Inspect the actual API roles' ability instead of mistaking that for escalation.
  for (const role of ['authenticated', 'anon', 'service_role', 'authenticator']) {
    const access = await admin.query(
      "select pg_has_role($1,'tenancy_date_writer','SET') as allowed",
      [role],
    );
    assert.equal(access.rows[0].allowed, false, `${role} must not assume the writer role`);
  }
  await assert.rejects(
    member((c) =>
      c.query("update tenancy_date_records set reason_note='forged' where tenancy_id=$1", [
        tenancy,
      ]),
    ),
    /permission denied|immutable/,
  );
  await assert.rejects(
    member(
      (c) => c.query('select get_tenancy_date_context($1,$2)', [account, tenancy]),
      randomUUID(),
    ),
    /not_found/,
  );
  console.info(
    'PASS: direct writes, forged flags, role escalation, and cross-account reads rejected',
  );

  const ordinary = randomUUID();
  const cancelled = randomUUID();
  await admin.query(
    "insert into tenancies(id,account_id,area_id,start_date,status) values($1,$3,$4,'2025-01-01','active'),($2,$3,$4,'2030-01-01','upcoming')",
    [ordinary, cancelled, account, unit],
  );
  await member(async (c) => {
    await c.query("select end_tenancy($1,$2,'ended','2025-12-31')", [account, ordinary]);
    await c.query("select end_tenancy($1,$2,'cancelled_before_move_in','2026-01-01')", [
      account,
      cancelled,
    ]);
  });
  const endedCtx = await context(ordinary);
  const ended = await apply(
    { ...change(endedCtx, '2024-12-01'), expected_resulting_status: 'ended' },
    randomUUID(),
    ordinary,
  );
  assert.equal(ended.tenancy.end_date, '2025-12-31');
  assert.equal(ended.tenancy.status, 'ended');
  await assert.rejects(
    apply(
      { ...change(await context(cancelled), '2029-01-01'), expected_resulting_status: 'ended' },
      randomUUID(),
      cancelled,
    ),
    /date_fixed_by_cancellation/,
  );
  console.info(
    'PASS: ordinary ending correction retains ending; cancellation boundary remains protected',
  );

  const chain = (await admin.query('select * from verify_chain($1)', [account])).rows;
  assert(
    chain.every((r) => r.ok),
    'audit chain remains intact',
  );
  console.info('PASS: audit chain intact');
} finally {
  await admin.end();
}
