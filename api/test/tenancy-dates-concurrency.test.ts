// Live local DB checks for atomic corrections, serialized editors, and unchanged money.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
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

async function context(
  t = tenancy,
  leaseId: string | null = null,
  scheduleId: string | null = null,
) {
  return member(
    async (c) =>
      (
        await c.query('select get_tenancy_date_context($1,$2,$3,$4) as v', [
          account,
          t,
          leaseId,
          scheduleId,
        ])
      ).rows[0].v,
  );
}
const reviewedRequests = new Map<string, { body: string; payload: Record<string, unknown> }>();
async function apply(
  body: Record<string, unknown>,
  key = randomUUID(),
  t = tenancy,
  operation:
    | 'correct_tenancy_dates'
    | 'correct_tenancy_ending'
    | 'record_tenancy_date_explanation' = 'correct_tenancy_dates',
) {
  const originalBody = JSON.stringify(body);
  const prior = reviewedRequests.get(key);
  if (prior?.body === originalBody) body = prior.payload;
  else {
    const reviewed = await member(async (c) => {
      if (operation === 'record_tenancy_date_explanation')
        return (
          await c.query('select get_tenancy_date_context($1,$2,$3,$4) v', [
            account,
            t,
            body.lease_id ?? null,
            body.rent_schedule_id ?? null,
          ])
        ).rows[0].v;
      return (
        await c.query('select _preview_tenancy_date_change($1,$2,$3,$4) v', [
          account,
          t,
          body,
          operation === 'correct_tenancy_ending',
        ])
      ).rows[0].v;
    });
    body = {
      ...body,
      warning_acknowledgements: reviewed.findings.map(
        (f: { relationship_fingerprint: string }) => ({
          relationship_fingerprint: f.relationship_fingerprint,
        }),
      ),
    };
    reviewedRequests.set(key, { body: originalBody, payload: body });
  }
  const fingerprint = createHash('sha256')
    .update(user + JSON.stringify(body))
    .digest('hex');
  return member(async (c) => {
    await c.query('select claim_idempotency_key($1,$2,$3)', [account, key, fingerprint]);
    return (
      await c.query(`select ${operation}($1,$2,$3,$4,$5) as v`, [
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

  const originalLease = randomUUID();
  const renewalLease = randomUUID();
  const selectedSchedule = randomUUID();
  await admin.query(
    `insert into leases(id,account_id,tenancy_id,term_start,term_end,rent_amount_cents,rent_currency,status)
    values($1,$2,$3,'2026-05-01','2026-12-31',220000,'USD','active')`,
    [originalLease, account, sameDates],
  );
  await admin.query(
    `insert into leases(id,account_id,tenancy_id,term_start,term_end,rent_amount_cents,rent_currency,status,agreement_kind,predecessor_lease_id)
    values($1,$2,$3,'2027-01-01','2027-12-31',220000,'USD','active','renewal',$4)`,
    [renewalLease, account, sameDates, originalLease],
  );
  await admin.query(
    `insert into rent_schedules(id,account_id,tenancy_id,kind,amount_cents,currency,due_day,start_date,source_lease_id)
    values($1,$2,$3,'rent',220000,'USD',1,'2026-05-01',$4)`,
    [selectedSchedule, account, sameDates, originalLease],
  );
  const selected = await context(sameDates, originalLease, selectedSchedule);
  assert.equal(selected.clock_basis, 'UTC');
  assert.match(selected.as_of_date, /^\d{4}-\d{2}-\d{2}$/);
  assert(
    selected.findings.some((f: { rule_id: string }) => f.rule_id === 'possession_lease_start'),
  );
  assert(
    !(await context(sameDates, renewalLease)).findings.some(
      (f: { rule_id: string }) => f.rule_id === 'possession_lease_start',
    ),
  );
  const emptyScope = await apply(
    {
      expected_context_fingerprint: selected.context_fingerprint,
      lease_id: originalLease,
      rent_schedule_id: selectedSchedule,
      reason_code: 'other',
      reason_note: 'The date relationship review remains outstanding.',
      explained_rule_ids: [],
    },
    randomUUID(),
    sameDates,
    'record_tenancy_date_explanation',
  );
  assert.deepEqual(emptyScope.record.relationship_snapshots, []);
  assert.equal(emptyScope.record.context_snapshot.relationship_scope_version, 1);
  assert(
    (await context(sameDates, originalLease, selectedSchedule)).findings.every(
      (f: { explained: boolean }) => !f.explained,
    ),
    'an explicitly empty explanation scope must leave every relationship unexplained',
  );
  await apply(
    {
      expected_context_fingerprint: selected.context_fingerprint,
      lease_id: originalLease,
      rent_schedule_id: selectedSchedule,
      reason_code: 'early_access',
      reason_note: 'Early possession is agreed before the original lease term.',
      explained_rule_ids: ['possession_lease_start'],
    },
    randomUUID(),
    sameDates,
    'record_tenancy_date_explanation',
  );
  const explained = await context(sameDates, originalLease, selectedSchedule);
  assert.equal(
    explained.findings.find((f: { rule_id: string }) => f.rule_id === 'possession_lease_start')
      .explained,
    true,
  );
  assert.equal(
    explained.findings.find((f: { rule_id: string }) => f.rule_id === 'billing_possession_start')
      .explained,
    false,
  );
  assert.deepEqual(
    explained.findings
      .filter((f: { explained: boolean }) => f.explained)
      .map((f: { rule_id: string }) => f.rule_id),
    ['possession_lease_start'],
    'a selected subset must explain only the named relationships',
  );
  await admin.query('update leases set updated_at=clock_timestamp() where id=$1', [originalLease]);
  const metadataChanged = await context(sameDates, originalLease, selectedSchedule);
  assert.notEqual(metadataChanged.context_fingerprint, explained.context_fingerprint);
  assert.equal(
    metadataChanged.findings.find(
      (f: { rule_id: string }) => f.rule_id === 'possession_lease_start',
    ).explained,
    true,
  );
  const planned = await apply(
    {
      ...change(metadataChanged, '2026-04-01'),
      changes: { end_date: '2026-12-15' },
      lease_id: originalLease,
      rent_schedule_id: selectedSchedule,
    },
    randomUUID(),
    sameDates,
  );
  assert.equal(planned.tenancy.end_date, '2026-12-15');
  assert.equal(planned.tenancy.status, 'active');
  const withEnd = await context(sameDates, originalLease, selectedSchedule);
  const cleared = await apply(
    {
      ...change(withEnd, '2026-04-01'),
      changes: { end_date: null },
      lease_id: originalLease,
      rent_schedule_id: selectedSchedule,
    },
    randomUUID(),
    sameDates,
  );
  assert.equal(cleared.tenancy.end_date, null);
  const changedStart = await apply(
    {
      ...change(await context(sameDates, originalLease, selectedSchedule), '2026-04-15'),
      lease_id: originalLease,
      rent_schedule_id: selectedSchedule,
      explained_rule_ids: [],
    },
    randomUUID(),
    sameDates,
  );
  assert.equal(changedStart.tenancy.start_date, '2026-04-15');
  assert.equal(
    (await context(sameDates, originalLease, selectedSchedule)).findings.find(
      (f: { rule_id: string }) => f.rule_id === 'possession_lease_start',
    ).explained,
    false,
  );
  assert.deepEqual(await money(), before);
  console.info(
    'PASS: UTC context, renewal exemption, per-rule explanations and planned-end correction retain money',
  );

  async function insertCompatibilityExplanation(snapshot: Record<string, unknown>, facts: unknown) {
    await admin.query('begin');
    try {
      await admin.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: user, role: 'authenticated' }),
      ]);
      await admin.query('set local role tenancy_date_writer');
      await admin.query(
        `insert into tenancy_date_records(account_id,tenancy_id,kind,before_facts,after_facts,
          context_snapshot,context_fingerprint,reason_code,reason_note,created_by,
          request_key,request_fingerprint,response_body)
        values($1,$2,'explanation',$3,$3,$4,$5,'other','Compatibility fixture',$6,$7,$8,'{}')`,
        [
          account,
          sameDates,
          facts,
          snapshot,
          randomUUID(),
          user,
          randomUUID(),
          createHash('sha256').update(randomUUID()).digest('hex'),
        ],
      );
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }
  }
  const legacyContext = await context(sameDates, originalLease, selectedSchedule);
  await insertCompatibilityExplanation(
    {
      version: 1,
      facts: legacyContext.facts,
      lease: legacyContext.lease,
      schedule: legacyContext.schedule,
      ending: legacyContext.ending,
      deposits: legacyContext.deposits,
    },
    legacyContext.facts,
  );
  assert(
    (await context(sameDates, originalLease, selectedSchedule)).findings.every(
      (f: { explained: boolean }) => f.explained,
    ),
    'legacy explanations retain the relationships covered by their original full context',
  );
  await apply(
    {
      ...change(await context(sameDates, originalLease, selectedSchedule), '2026-04-16'),
      lease_id: originalLease,
      rent_schedule_id: selectedSchedule,
      explained_rule_ids: [],
    },
    randomUUID(),
    sameDates,
  );
  const changedLegacyContext = await context(sameDates, originalLease, selectedSchedule);
  const legacyFingerprints = new Map<string, string>(
    legacyContext.findings.map(
      (f: {
        rule_id: string;
        relationship_fingerprint: string;
        explanation_fingerprint?: string;
      }): [string, string] => [f.rule_id, f.explanation_fingerprint ?? f.relationship_fingerprint],
    ),
  );
  const retainedLegacyFingerprints = new Set<string>();
  const changedLegacyRules: string[] = [];
  for (const finding of changedLegacyContext.findings) {
    assert(legacyFingerprints.has(finding.rule_id), 'the fixture must compare an existing rule');
    const unchanged =
      legacyFingerprints.get(finding.rule_id) ===
      (finding.explanation_fingerprint ?? finding.relationship_fingerprint);
    assert.equal(
      finding.explained,
      unchanged,
      `${finding.rule_id}: only unchanged relationship facts retain their legacy reason`,
    );
    if (unchanged) retainedLegacyFingerprints.add(finding.relationship_fingerprint);
    else changedLegacyRules.push(finding.rule_id);
  }
  assert.deepEqual(changedLegacyRules.sort(), [
    'billing_possession_start',
    'possession_lease_start',
  ]);
  const billingFinding = changedLegacyContext.findings.find(
    (f: { rule_id: string }) => f.rule_id === 'billing_possession_start',
  );
  await insertCompatibilityExplanation(
    {
      version: 2,
      relationship_fingerprint:
        billingFinding.explanation_fingerprint ?? billingFinding.relationship_fingerprint,
    },
    changedLegacyContext.facts,
  );
  const billingExplained = await context(sameDates, originalLease, selectedSchedule);
  assert.deepEqual(
    billingExplained.findings
      .filter((f: { explained: boolean }) => f.explained)
      .map((f: { relationship_fingerprint: string }) => f.relationship_fingerprint)
      .sort(),
    [...new Set([...retainedLegacyFingerprints, billingFinding.relationship_fingerprint])].sort(),
    'the billing reason adds only its exact relationship to the unchanged legacy scope',
  );
  assert.deepEqual(await money(), before);
  console.info(
    'PASS: empty/subset explanation scope, legacy compatibility and exact billing fingerprints',
  );

  const endingBefore = (
    await admin.query('select * from tenancy_endings where account_id=$1 and tenancy_id=$2', [
      account,
      ordinary,
    ])
  ).rows[0];
  const endingCtx = await context(ordinary);
  const actualBody = {
    ...change(endingCtx, '2024-12-01'),
    changes: { end_date: '2025-12-20' },
    expected_resulting_status: 'ended',
  };
  await assert.rejects(apply(actualBody, randomUUID(), ordinary), /ending_correction_required/);
  const endingKey = randomUUID();
  const correctedEnding = await apply(actualBody, endingKey, ordinary, 'correct_tenancy_ending');
  assert.equal(correctedEnding.tenancy.end_date, '2025-12-20');
  assert.equal(correctedEnding.record.corrects_ending_id, endingBefore.id);
  assert.deepEqual(
    (await admin.query('select * from tenancy_endings where id=$1', [endingBefore.id])).rows[0],
    endingBefore,
  );
  assert.deepEqual(
    await apply(actualBody, endingKey, ordinary, 'correct_tenancy_ending'),
    correctedEnding,
  );
  const resolvedEnding = (await context(ordinary)).ending;
  assert.equal(resolvedEnding.effective_date, '2025-12-20');
  assert.equal(resolvedEnding.original_effective_date, '2025-12-31');
  assert.equal(resolvedEnding.correction_record_id, correctedEnding.record.id);
  const nextEndingCtx = await context(ordinary);
  const second = await apply(
    {
      ...actualBody,
      expected_context_fingerprint: nextEndingCtx.context_fingerprint,
      expected_date_revision: nextEndingCtx.facts.date_revision,
      changes: { end_date: '2025-12-21' },
    },
    randomUUID(),
    ordinary,
    'correct_tenancy_ending',
  );
  assert.equal(second.record.corrects_record_id, correctedEnding.record.id);
  await assert.rejects(
    member((c) => c.query("update tenancies set end_date='2025-12-22' where id=$1", [ordinary])),
    /date_correction_required|recorded ending/,
  );
  const finalEndingCtx = await context(ordinary);
  const confirmedFutureEnding = await apply(
    {
      ...actualBody,
      expected_context_fingerprint: finalEndingCtx.context_fingerprint,
      expected_date_revision: finalEndingCtx.facts.date_revision,
      changes: { end_date: '2030-01-01' },
    },
    randomUUID(),
    ordinary,
    'correct_tenancy_ending',
  );
  assert.equal(confirmedFutureEnding.tenancy.status, 'ended');
  assert.equal(confirmedFutureEnding.tenancy.end_date, '2030-01-01');
  assert.deepEqual(await money(), before);
  console.info(
    'PASS: actual-end corrections append linked immutable evidence, replay safely and preserve original ending/money',
  );

  const staleActive = randomUUID();
  const staleUpcoming = randomUUID();
  const currentUnit = randomUUID();
  const futureUnit = randomUUID();
  const person = randomUUID();
  const label = `ClockFixture${randomUUID().slice(0, 8)}`;
  await admin.query(
    "insert into areas(id,account_id,property_id,kind,name) values($1,$3,$4,'unit',$5),($2,$3,$4,'unit',$6)",
    [currentUnit, futureUnit, account, property, `${label}Current`, `${label}Future`],
  );
  await admin.query('insert into tenants(id,account_id,full_name) values($1,$2,$3)', [
    person,
    account,
    label,
  ]);
  // Simulate rows whose daily status materialization has not run yet.
  await admin.query('begin');
  await admin.query("set local session_replication_role='replica'");
  await admin.query(
    `insert into tenancies(id,account_id,area_id,start_date,status)
    values($1,$3,$4,(now() at time zone 'UTC')::date-1,'upcoming'),
      ($2,$3,$5,(now() at time zone 'UTC')::date+1,'active')`,
    [staleActive, staleUpcoming, account, currentUnit, futureUnit],
  );
  await admin.query('commit');
  await admin.query(
    "insert into tenancy_tenants(account_id,tenancy_id,tenant_id,role) values($1,$2,$4,'primary'),($1,$3,$4,'primary')",
    [account, staleActive, staleUpcoming, person],
  );
  const occupancy = await member(async (c) => {
    const projected = (
      await c.query('select id,status from tenancy_current where account_id=$1 and id=any($2)', [
        account,
        [staleActive, staleUpcoming],
      ])
    ).rows;
    const activeRollup = (
      await c.query(
        "select tenancy_id,status from rent_rollup($1,array['active'],(now() at time zone 'UTC')::date)",
        [account],
      )
    ).rows;
    const upcomingRollup = (
      await c.query(
        "select tenancy_id,status from rent_rollup($1,array['upcoming'],(now() at time zone 'UTC')::date)",
        [account],
      )
    ).rows;
    const search = (
      await c.query('select * from search_entities($1,$2,null,null,50)', [account, label])
    ).rows;
    return { projected, activeRollup, upcomingRollup, search };
  });
  assert.equal(occupancy.projected.find((r) => r.id === staleActive).status, 'active');
  assert.equal(occupancy.projected.find((r) => r.id === staleUpcoming).status, 'upcoming');
  assert(occupancy.activeRollup.some((r) => r.tenancy_id === staleActive && r.status === 'active'));
  assert(!occupancy.activeRollup.some((r) => r.tenancy_id === staleUpcoming));
  assert(
    occupancy.upcomingRollup.some((r) => r.tenancy_id === staleUpcoming && r.status === 'upcoming'),
  );
  assert.equal(
    occupancy.search.find((r) => r.entity_id === person).context.tenancy_id,
    staleActive,
  );
  assert.equal(
    occupancy.search.find((r) => r.entity_id === person).context.tenancy_status,
    'active',
  );
  assert.equal(
    occupancy.search.find((r) => r.entity_id === currentUnit).context.occupancy_status,
    'occupied',
  );
  assert.equal(
    occupancy.search.find((r) => r.entity_id === futureUnit).context.occupancy_status,
    'vacant',
  );
  assert.equal((await context(staleActive)).effective_status, 'active');
  assert.equal((await context(staleUpcoming)).facts.status, 'upcoming');
  assert.deepEqual(
    await member(
      (c) => c.query('select id from tenancy_current where account_id=$1', [account]),
      randomUUID(),
    ).then((r) => r.rows),
    [],
  );
  await admin.query('begin');
  const route = (
    await admin.query(
      "select * from _persona_find_or_create_thread($1,'tenant',$2,$3,'Clock fixture','example.invalid')",
      [account, person, `${label}@example.invalid`],
    )
  ).rows[0];
  assert.equal(route.tenancy_id, staleActive);
  await admin.query('rollback');
  const utc = await member(async (c) => {
    await c.query("set local timezone='America/Los_Angeles'");
    return (
      await c.query(
        "select effective_tenancy_status('upcoming',(now() at time zone 'UTC')::date) as status",
      )
    ).rows[0];
  });
  assert.equal(utc.status, 'active');
  assert.equal(
    (await admin.query('select status from tenancies where id=$1', [staleActive])).rows[0].status,
    'upcoming',
  );
  console.info(
    'PASS: UTC occupancy view, search, recipient scope and rollup agree before materialization; cross-account view is fenced',
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
