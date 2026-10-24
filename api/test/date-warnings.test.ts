import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readSupabaseStatus } from './helpers/integration';

const connectionString = process.env.DATABASE_URL ?? readSupabaseStatus().DB_URL;
const admin = new pg.Client({ connectionString });
await admin.connect();
const user = randomUUID(),
  account = randomUUID(),
  property = randomUUID(),
  unit = randomUUID(),
  tenancy = randomUUID();
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
async function member<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: 'authenticated' }),
    ]);
    await c.query('set local role authenticated');
    const result = await fn(c);
    await c.query('commit');
    return result;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    await c.end();
  }
}
async function preview(name: string, body: unknown) {
  return member(async (c) => (await c.query(`select ${name}($1,$2) v`, [account, body])).rows[0].v);
}
async function command(name: string, body: unknown, key = randomUUID()) {
  return member(async (c) => {
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await c.query('select claim_idempotency_key($1,$2,$3)', [account, key, hash]);
    return (await c.query(`select ${name}($1,$2,$3,$4) v`, [account, body, key, hash])).rows[0].v;
  });
}
try {
  await admin.query('insert into auth.users(id,email) values($1,$2)', [
    user,
    `${user}@test.invalid`,
  ]);
  await admin.query('insert into accounts(id,name) values($1,$2)', [account, 'Date warnings']);
  await admin.query("insert into account_members(account_id,user_id,role) values($1,$2,'owner')", [
    account,
    user,
  ]);
  await admin.query("insert into properties(id,account_id,name) values($1,$2,'Warnings')", [
    property,
    account,
  ]);
  await admin.query(
    "insert into areas(id,account_id,property_id,kind,name) values($1,$2,$3,'unit','Warnings')",
    [unit, account, property],
  );
  await admin.query(
    "insert into tenancies(id,account_id,area_id,start_date,status) values($1,$2,$3,'2025-01-01','active')",
    [tenancy, account, unit],
  );

  const payment = {
    tenancy_id: tenancy,
    amount_cents: 20000,
    currency: 'USD',
    received_at: tomorrow,
    method: 'cash',
    allocations: [],
  };
  const review = await preview('preview_payment', payment);
  assert.equal(review.can_commit, false);
  assert.equal(review.clock_basis, 'UTC');
  assert.equal(review.findings[0].rule_id, 'receipt_in_future');
  await assert.rejects(command('record_payment', payment), /explicit date warning confirmation/);
  const accepted = {
    ...payment,
    expected_context_fingerprint: review.context_fingerprint,
    warning_acknowledgements: [
      { relationship_fingerprint: review.findings[0].relationship_fingerprint },
    ],
  };
  assert.equal(
    (await preview('preview_payment', accepted)).context_fingerprint,
    review.context_fingerprint,
  );
  await assert.rejects(
    command('record_payment', { ...accepted, amount_cents: 20001 }),
    /no longer matches|date_context_changed/,
  );
  const key = randomUUID();
  const saved = await command('record_payment', accepted, key);
  assert.equal(saved.payment.amount_cents, 20000);
  assert.deepEqual(await command('record_payment', accepted, key), saved);
  const history = await admin.query(
    'select * from tenancy_date_records where account_id=$1 and subject_payment_id=$2',
    [account, saved.payment.id],
  );
  assert.equal(history.rows.length, 1);
  assert.equal(history.rows[0].reason_note, null);
  assert.equal(history.rows[0].kind, 'warning_confirmation');
  await assert.rejects(
    member((c) =>
      c.query(
        "insert into payments(account_id,tenancy_id,amount_cents,currency,received_at,method) values($1,$2,1,'USD',$3,'cash')",
        [account, tenancy, tomorrow],
      ),
    ),
    /explicit date warning confirmation/,
  );

  await member(async (c) => {
    const ctx = (await c.query('select get_tenancy_date_context($1,$2) v', [account, tenancy]))
      .rows[0].v;
    const body = {
      changes: { actual_move_in_date: tomorrow },
      expected_date_revision: ctx.facts.date_revision,
      expected_context_fingerprint: ctx.context_fingerprint,
      expected_resulting_status: 'active',
      reason_code: 'other',
    };
    const p = (
      await c.query('select preview_tenancy_date_correction($1,$2,$3) v', [account, tenancy, body])
    ).rows[0].v;
    assert.deepEqual(p.blockers, []);
    const payload = {
      ...body,
      warning_acknowledgements: p.findings.map((f: { relationship_fingerprint: string }) => ({
        relationship_fingerprint: f.relationship_fingerprint,
      })),
    };
    const key = randomUUID(),
      hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await c.query('select claim_idempotency_key($1,$2,$3)', [account, key, hash]);
    const r = (
      await c.query('select correct_tenancy_dates($1,$2,$3,$4,$5) v', [
        account,
        tenancy,
        key,
        hash,
        payload,
      ])
    ).rows[0].v;
    assert.equal(r.tenancy.actual_move_in_date, tomorrow);
    assert.equal(r.record.reason_note, '');
  });

  const afterArrival = await member(
    async (c) =>
      (await c.query('select get_tenancy_date_context($1,$2) v', [account, tenancy])).rows[0].v,
  );
  assert.equal(
    afterArrival.findings.find((f: { rule_id: string }) => f.rule_id === 'actual_move_in_in_future')
      .confirmed,
    true,
  );

  await member(async (c) => {
    const intent = {
      rent: { decision: 'defer' },
      deposit: { decision: 'defer' },
      payments: [
        {
          draft_key: 'setup_receipt',
          amount_cents: 30000,
          currency: 'USD',
          received_at: tomorrow,
          method: 'cash',
          allocations: [],
        },
      ],
      explanations: [],
      credit_allocations: [],
    };
    const p = (
      await c.query('select preview_billing_setup($1,$2,$3) v', [account, tenancy, intent])
    ).rows[0].v;
    assert.equal(p.can_commit, false);
    const payload = {
      ...intent,
      expected_context: p.context_fingerprint,
      warning_acknowledgements: p.findings.map((f: { relationship_fingerprint: string }) => ({
        relationship_fingerprint: f.relationship_fingerprint,
      })),
    };
    const key = randomUUID(),
      hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await c.query('select claim_idempotency_key($1,$2,$3)', [account, key, hash]);
    const r = (
      await c.query('select commit_billing_setup($1,$2,$3,$4,$5) v', [
        account,
        tenancy,
        payload,
        key,
        hash,
      ])
    ).rows[0].v;
    assert.ok(r.payment_ids.setup_receipt);
    assert.equal(
      (
        await c.query(
          'select count(*) n from tenancy_date_records where account_id=$1 and subject_payment_id=$2',
          [account, r.payment_ids.setup_receipt],
        )
      ).rows[0].n,
      '1',
    );
  });

  await member(async (c) => {
    const body = {
      kind: 'ended',
      effective_date: tomorrow,
      initiated_by: 'unknown',
      reason_code: 'other',
    };
    const p = (await c.query('select preview_tenancy_ending($1,$2,$3) v', [account, tenancy, body]))
      .rows[0].v;
    assert.match(p.findings[0].message, /ends the tenancy now/);
    const payload = {
      ...body,
      expected_context_fingerprint: p.context_fingerprint,
      warning_acknowledgements: p.findings.map((f: { relationship_fingerprint: string }) => ({
        relationship_fingerprint: f.relationship_fingerprint,
      })),
    };
    const key = randomUUID(),
      hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await c.query('select claim_idempotency_key($1,$2,$3)', [account, key, hash]);
    const r = (
      await c.query('select record_tenancy_ending($1,$2,$3,$4,$5) v', [
        account,
        tenancy,
        payload,
        key,
        hash,
      ])
    ).rows[0].v;
    assert.equal(r.tenancy.status, 'ended');
    assert.equal(r.tenancy.end_date, tomorrow);
  });
  const endedContext = await member(
    async (c) =>
      (await c.query('select get_tenancy_date_context($1,$2) v', [account, tenancy])).rows[0].v,
  );
  assert.equal(
    endedContext.findings.find((f: { rule_id: string }) => f.rule_id === 'actual_ending_in_future')
      .confirmed,
    true,
  );
  console.info('Date warning confirmation checks passed.');
} finally {
  await admin.end();
}
