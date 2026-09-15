import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must be set');

let ACCOUNT_ID = '';
let USER_ID = '';
const failures: Array<{ name: string; detail: string }> = [];

async function client(): Promise<pg.Client> {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  return c;
}

async function authClient(): Promise<pg.Client> {
  const c = await client();
  await c.query('begin');
  await c.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: USER_ID, role: 'authenticated' }),
  ]);
  await c.query('set local role authenticated');
  return c;
}

async function finish(c: pg.Client, commit = true): Promise<void> {
  try {
    await c.query(commit ? 'commit' : 'rollback');
  } finally {
    await c.end();
  }
}

async function rollbackEnd(c: pg.Client): Promise<void> {
  try {
    await c.query('rollback');
  } catch {
    // The successful path already closed this client.
  }
  try {
    await c.end();
  } catch {
    // Closing an already closed test client is harmless.
  }
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.info(`  PASS  ${name}`);
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.message}${'where' in error ? ` (${String(error.where)})` : ''}`
        : String(error);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

async function expectBlocked<T>(promise: Promise<T>, label: string): Promise<void> {
  const state = await Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 150)),
  ]);
  if (state !== 'blocked') throw new Error(`${label} did not wait for the tenancy lock`);
}

interface Fixture {
  areaId: string;
  manualTenancy: string;
  manualSchedule: string;
  generatorTenancy: string;
  generatorSchedule: string;
  adjustmentTenancy: string;
  adjustmentLease: string;
  adjustmentSchedule: string;
  adjustmentCharge: string;
  adjustmentAllocation: string;
}

async function setup(): Promise<Fixture> {
  const c = await client();
  try {
    const scope = await c.query<{ account_id: string; user_id: string; area_id: string }>(
      `select a.account_id,m.user_id,a.id as area_id
         from public.areas a
         join public.accounts ac on ac.id=a.account_id and ac.deleted_at is null
         join public.account_members m on m.account_id=a.account_id and m.deleted_at is null
        where a.kind='unit' and a.deleted_at is null and ac.auto_charge_enabled
          and m.role in ('owner','manager')
        order by a.created_at,a.id limit 1`,
    );
    if (!scope.rows[0]) throw new Error('local database has no member-owned unit area');
    ACCOUNT_ID = scope.rows[0].account_id;
    USER_ID = scope.rows[0].user_id;
    const ids = {
      areaId: scope.rows[0].area_id,
      manualTenancy: randomUUID(),
      manualSchedule: randomUUID(),
      generatorTenancy: randomUUID(),
      generatorSchedule: randomUUID(),
      adjustmentTenancy: randomUUID(),
      adjustmentLease: randomUUID(),
      adjustmentSchedule: randomUUID(),
      adjustmentCharge: randomUUID(),
      adjustmentAllocation: randomUUID(),
    };
    const paymentId = randomUUID();

    await c.query(
      `insert into public.tenancies(id,account_id,area_id,start_date,status)
       values ($1,$4,$5,'2026-01-01','active'),
              ($2,$4,$5,'2040-01-01','active'),
              ($3,$4,$5,'2026-01-01','active')`,
      [ids.manualTenancy, ids.generatorTenancy, ids.adjustmentTenancy, ACCOUNT_ID, ids.areaId],
    );
    await c.query(
      `insert into public.leases(id,account_id,tenancy_id,status,term_start,rent_amount_cents,
         rent_currency,deposit_amount_cents,document)
       values($1,$2,$3,'active','2026-01-01',150000,'USD',0,'{}')`,
      [ids.adjustmentLease, ACCOUNT_ID, ids.adjustmentTenancy],
    );
    await c.query(
      `insert into public.rent_schedules
         (id,account_id,tenancy_id,kind,amount_cents,currency,due_day,start_date,source_lease_id)
       values ($1,$4,$5,'rent',100000,'USD',1,'2026-01-01',null),
              ($2,$4,$6,'rent',100000,'USD',1,'2040-01-01',null),
              ($3,$4,$7,'rent',150000,'USD',1,'2026-01-01',$8)`,
      [
        ids.manualSchedule,
        ids.generatorSchedule,
        ids.adjustmentSchedule,
        ACCOUNT_ID,
        ids.manualTenancy,
        ids.generatorTenancy,
        ids.adjustmentTenancy,
        ids.adjustmentLease,
      ],
    );
    await c.query(
      `insert into public.charges
         (id,account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,source_schedule_id)
       values($1,$2,$3,'rent',150000,'USD','2026-09-01','2026-09-01','2026-09-30',$4)`,
      [ids.adjustmentCharge, ACCOUNT_ID, ids.adjustmentTenancy, ids.adjustmentSchedule],
    );
    await c.query(
      `insert into public.payments(id,account_id,tenancy_id,amount_cents,currency,received_at,method)
       values($1,$2,$3,150000,'USD','2026-09-02T00:00:00Z','cash')`,
      [paymentId, ACCOUNT_ID, ids.adjustmentTenancy],
    );
    await c.query(
      `insert into public.payment_allocations(id,account_id,payment_id,charge_id,amount_cents)
       values($1,$2,$3,$4,150000)`,
      [ids.adjustmentAllocation, ACCOUNT_ID, paymentId, ids.adjustmentCharge],
    );
    return ids;
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  const f = await setup();

  await check('manual charge waits, then rejects a schedule retired while it waited', async () => {
    const correction = await authClient();
    const writer = await authClient();
    try {
      await correction.query(
        `select pg_advisory_xact_lock(hashtextextended('rent_change:'||$1::text,0))`,
        [f.manualTenancy],
      );
      await correction.query(
        `update public.rent_schedules set end_date='2026-08-31',updated_at=now()
         where account_id=$1 and id=$2`,
        [ACCOUNT_ID, f.manualSchedule],
      );
      const insertion = writer.query(
        `insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,
           period_start,period_end,source_schedule_id)
         values($1,$2,'rent',100000,'USD','2026-09-01','2026-09-01','2026-09-30',$3)`,
        [ACCOUNT_ID, f.manualTenancy, f.manualSchedule],
      );
      await expectBlocked(insertion, 'manual charge insert');
      await finish(correction);
      const error = await insertion.then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
      if (error?.code !== '23514') throw new Error(`expected 23514, got ${error?.code ?? 'success'}`);
    } finally {
      await rollbackEnd(correction);
      await rollbackEnd(writer);
    }
  });

  await check('allocation reversal retries while a correction owns the tenancy', async () => {
    const payload = {
      kind: 'correct_rent',
      lease_id: f.adjustmentLease,
      terms: {
        term_start: '2026-01-01',
        term_end: null,
        rent_amount_cents: 180000,
        rent_currency: 'USD',
        deposit_amount_cents: 0,
        deposit_currency: null,
      },
      scope: {
        schedules: [{ schedule_id: f.adjustmentSchedule, start_date: '2026-01-01', end_date: null }],
        charges: [],
      },
      reason: 'Correct rent concurrency test',
    };
    const prepare = await authClient();
    const key = `rent-adjustment-test-${randomUUID()}`;
    const fingerprint = randomUUID().replaceAll('-', '').repeat(2);
    const preview = await prepare.query<{ result: Record<string, unknown> }>(
      `select public.preview_rent_adjustment($1,$2,$3::jsonb) as result`,
      [ACCOUNT_ID, f.adjustmentTenancy, JSON.stringify(payload)],
    );
    const body = preview.rows[0]!.result;
    if ((body.blockers as unknown[]).length) throw new Error(`preview blockers: ${JSON.stringify(body.blockers)}`);
    await prepare.query(`select * from public.claim_idempotency_key($1,$2,$3)`, [
      ACCOUNT_ID,
      key,
      fingerprint,
    ]);
    await finish(prepare);

    const correction = await authClient();
    const writer = await authClient();
    try {
      await correction.query(
        `select pg_advisory_xact_lock(hashtextextended('rent_change:'||$1::text,0))`,
        [f.adjustmentTenancy],
      );
      const error = await writer
        .query(
          `update public.payment_allocations
              set voided_at=now(),void_reason='racing reversal',updated_at=now()
            where account_id=$1 and id=$2`,
          [ACCOUNT_ID, f.adjustmentAllocation],
        )
        .then(
          () => null,
          (e: unknown) => e as { code?: string },
        );
      if (error?.code !== '40001') throw new Error(`expected retryable 40001, got ${error?.code ?? 'success'}`);
      await finish(writer, false);

      const committed = await correction.query<{ result: Record<string, unknown> }>(
        `select public.commit_rent_adjustment($1,$2,$3::jsonb,$4,$5,$6) as result`,
        [ACCOUNT_ID, f.adjustmentTenancy, JSON.stringify(payload), body.preview_token, key, fingerprint],
      );
      if (!committed.rows[0]?.result) throw new Error('adjustment RPC returned no receipt');
      await finish(correction);
    } finally {
      await rollbackEnd(correction);
      await rollbackEnd(writer);
    }

    const verify = await client();
    try {
      const old = await verify.query<{ voided_at: string | null }>(
        `select voided_at from public.payment_allocations where id=$1`,
        [f.adjustmentAllocation],
      );
      const replacement = await verify.query<{ n: string }>(
        `select count(*)::text as n from public.payment_allocations where corrects_allocation_id=$1`,
        [f.adjustmentAllocation],
      );
      if (!old.rows[0]?.voided_at || replacement.rows[0]?.n !== '1') {
        throw new Error('correction did not reverse and replace the application exactly once');
      }
    } finally {
      await verify.end();
    }

    const attacker = await authClient();
    try {
      const lineageError = await attacker
        .query(
          `insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,
             corrects_charge_id)
           values($1,$2,'rent',180000,'USD','2026-09-01',$3)`,
          [ACCOUNT_ID, f.adjustmentTenancy, f.adjustmentCharge],
        )
        .then(
          () => null,
          (e: unknown) => e as { code?: string },
        );
      if (lineageError?.code !== '42501') {
        throw new Error(`direct lineage write should be 42501, got ${lineageError?.code ?? 'success'}`);
      }
      await finish(attacker, false);
    } finally {
      await rollbackEnd(attacker);
    }

    const immutable = await client();
    try {
      const receiptError = await immutable
        .query(`update public.rent_adjustments set response_body='{}' where request_key=$1`, [key])
        .then(
          () => null,
          (e: unknown) => e as { code?: string },
        );
      if (receiptError?.code !== '42501') {
        throw new Error(`receipt mutation should be 42501, got ${receiptError?.code ?? 'success'}`);
      }
    } finally {
      await immutable.end();
    }
  });

  await check('late receipt failure rolls back every adjustment write', async () => {
    const admin = await client();
    const tenancyId = randomUUID();
    const leaseId = randomUUID();
    const scheduleId = randomUUID();
    const chargeId = randomUUID();
    const paymentId = randomUUID();
    const allocationId = randomUUID();
    const key = `rollback-proof-${randomUUID()}`;
    try {
      await admin.query(
        `insert into public.tenancies(id,account_id,area_id,start_date,status)
         values($1,$2,$3,'2026-01-01','active')`,
        [tenancyId, ACCOUNT_ID, f.areaId],
      );
      await admin.query(
        `insert into public.leases(id,account_id,tenancy_id,status,term_start,rent_amount_cents,
           rent_currency,deposit_amount_cents,document)
         values($1,$2,$3,'active','2026-01-01',150000,'USD',0,'{}')`,
        [leaseId, ACCOUNT_ID, tenancyId],
      );
      await admin.query(
        `insert into public.rent_schedules(id,account_id,tenancy_id,kind,amount_cents,currency,due_day,start_date,source_lease_id)
         values($1,$2,$3,'rent',150000,'USD',1,'2026-01-01',$4)`,
        [scheduleId, ACCOUNT_ID, tenancyId, leaseId],
      );
      await admin.query(
        `insert into public.charges(id,account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,source_schedule_id)
         values($1,$2,$3,'rent',150000,'USD','2026-09-01','2026-09-01','2026-09-30',$4)`,
        [chargeId, ACCOUNT_ID, tenancyId, scheduleId],
      );
      await admin.query(
        `insert into public.payments(id,account_id,tenancy_id,amount_cents,currency,received_at,method)
         values($1,$2,$3,150000,'USD','2026-09-02','cash')`,
        [paymentId, ACCOUNT_ID, tenancyId],
      );
      await admin.query(
        `insert into public.payment_allocations(id,account_id,payment_id,charge_id,amount_cents)
         values($1,$2,$3,$4,150000)`,
        [allocationId, ACCOUNT_ID, paymentId, chargeId],
      );
      await admin.query(`create function public._reject_rollback_proof() returns trigger language plpgsql as $$
        begin if new.request_key like 'rollback-proof-%' then raise exception 'rollback proof'; end if; return new; end $$`);
      await admin.query(`create trigger rent_adjustments_rollback_proof after insert on public.rent_adjustments
        for each row execute function public._reject_rollback_proof()`);

      const payload = {
        kind: 'correct_rent',
        lease_id: leaseId,
        terms: {
          term_start: '2026-01-01',
          term_end: null,
          rent_amount_cents: 180000,
          rent_currency: 'USD',
          deposit_amount_cents: 0,
          deposit_currency: null,
        },
        scope: { schedules: [{ schedule_id: scheduleId, start_date: '2026-01-01', end_date: null }], charges: [] },
        reason: 'Late rollback proof',
      };
      const writer = await authClient();
      try {
        const preview = await writer.query<{ result: Record<string, unknown> }>(
          `select public.preview_rent_adjustment($1,$2,$3::jsonb) result`,
          [ACCOUNT_ID, tenancyId, JSON.stringify(payload)],
        );
        const fingerprint = randomUUID().replaceAll('-', '').repeat(2);
        await writer.query(`select * from public.claim_idempotency_key($1,$2,$3)`, [ACCOUNT_ID, key, fingerprint]);
        await finish(writer);
        const commit = await authClient();
        try {
          const error = await commit
            .query(`select public.commit_rent_adjustment($1,$2,$3::jsonb,$4,$5,$6)`, [
              ACCOUNT_ID,
              tenancyId,
              JSON.stringify(payload),
              preview.rows[0]!.result.preview_token,
              key,
              fingerprint,
            ])
            .then(() => null, (e: unknown) => e as { message?: string });
          if (!error?.message?.includes('rollback proof')) throw new Error(`expected late receipt rejection, got ${error?.message ?? 'success'}`);
        } finally {
          await rollbackEnd(commit);
        }
      } finally {
        await rollbackEnd(writer);
      }

      const state = await admin.query<{ old_lease: boolean; old_schedule: boolean; old_charge: boolean; old_application: boolean; replacements: string; receipts: string }>(
        `select
          exists(select 1 from public.leases where id=$1 and voided_at is null) old_lease,
          exists(select 1 from public.rent_schedules where id=$2 and deleted_at is null) old_schedule,
          exists(select 1 from public.charges where id=$3 and voided_at is null) old_charge,
          exists(select 1 from public.payment_allocations where id=$4 and voided_at is null) old_application,
          (select count(*)::text from public.charges where corrects_charge_id=$3) replacements,
          (select count(*)::text from public.rent_adjustments where request_key=$5) receipts`,
        [leaseId, scheduleId, chargeId, allocationId, key],
      );
      const row = state.rows[0]!;
      if (!row.old_lease || !row.old_schedule || !row.old_charge || !row.old_application || row.replacements !== '0' || row.receipts !== '0') {
        throw new Error(`partial adjustment survived rollback: ${JSON.stringify(row)}`);
      }
    } finally {
      await admin.query('drop trigger if exists rent_adjustments_rollback_proof on public.rent_adjustments');
      await admin.query('drop function if exists public._reject_rollback_proof()');
      await admin.end();
    }
  });

  await check('generator waits, then reads the successor schedule', async () => {
    const correction = await authClient();
    const generator = await client();
    const successor = randomUUID();
    try {
      await correction.query(
        `select pg_advisory_xact_lock(hashtextextended('rent_change:'||$1::text,0))`,
        [f.generatorTenancy],
      );
      await correction.query(
        `update public.rent_schedules set end_date='2040-08-31',updated_at=now()
         where account_id=$1 and id=$2`,
        [ACCOUNT_ID, f.generatorSchedule],
      );
      await correction.query(
        `insert into public.rent_schedules(id,account_id,tenancy_id,kind,amount_cents,currency,due_day,start_date)
         values($1,$2,$3,'rent',180000,'USD',1,'2040-09-01')`,
        [successor, ACCOUNT_ID, f.generatorTenancy],
      );
      const generation = generator.query<{ o_schedule_id: string }>(
        `select * from public.generate_rent_charges($1,'2040-09-01T00:00:00Z')`,
        [ACCOUNT_ID],
      );
      await expectBlocked(generation, 'rent generator');
      await finish(correction);
      const generated = await generation;
      const ours = generated.rows.filter(
        (row) => row.o_schedule_id === f.generatorSchedule || row.o_schedule_id === successor,
      );
      if (ours.length !== 1 || ours[0]!.o_schedule_id !== successor) {
        throw new Error(`expected only successor charge, got ${JSON.stringify(ours)}`);
      }
      const live = await generator.query<{ n: string }>(
        `select count(*)::text n from public.charges
          where account_id=$1 and tenancy_id=$2 and type='rent'
            and voided_at is null and deleted_at is null
            and coalesce(period_start,due_date)>='2040-09-01'
            and coalesce(period_start,due_date)<'2040-10-01'`,
        [ACCOUNT_ID, f.generatorTenancy],
      );
      if (live.rows[0]?.n !== '1') {
        throw new Error(`expected one live September rent bill, got ${live.rows[0]?.n}`);
      }
    } finally {
      await rollbackEnd(correction);
      await generator.end();
    }
  });

  if (failures.length) {
    console.error(`\n${failures.length} rent-adjustment concurrency check(s) failed`);
    process.exit(1);
  }
  console.info('\nAll rent-adjustment concurrency checks passed.');
}

await main();
