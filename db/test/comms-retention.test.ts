// ----------------------------------------------------------------------------
// prune_inbound_raw DoD tests (DB-level).
//
// Exercises the inbound_raw retention janitor directly against the SQL. Runs
// as the connecting (superuser) role, which bypasses inbound_raw's deny-all
// RLS — the same posture as service_role in prod (the only grantee).
//
// Coverage:
//   (a) rows older than the TTL are pruned.
//   (b) rows within the TTL are kept.
//   (c) the returned count equals the number of rows pruned.
//   (d) idempotency: a second run over the same horizon prunes 0.
//   (e) the interval parameter is honoured (a tighter horizon prunes more).
//
// All rows use a fixed provider_msg_id prefix so assertions are scoped to this
// test and pre-existing rows don't interfere.
// ----------------------------------------------------------------------------

import pg from 'pg';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(2);
}

const PFX = `ret-${Math.floor(Math.random() * 1e9)}-`;

interface Failure {
  name: string;
  detail: string;
}
const failures: Failure[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.info(`  PASS  ${name}`);
  } else {
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

async function main(): Promise<void> {
  console.info('prune_inbound_raw DoD checks');
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    // Seed: two well-aged rows (200d, 91d), one recent (10d).
    await c.query(
      `insert into public.inbound_raw (provider, provider_msg_id, payload, received_at) values
         ('t', $1, '{}'::jsonb, now() - interval '200 days'),
         ('t', $2, '{}'::jsonb, now() - interval '91 days'),
         ('t', $3, '{}'::jsonb, now() - interval '10 days')`,
      [`${PFX}old-a`, `${PFX}old-b`, `${PFX}new`],
    );

    // (a)+(c) default 90d horizon prunes exactly the two aged rows.
    const r1 = await c.query<{ prune_inbound_raw: number }>(
      `select public.prune_inbound_raw() as prune_inbound_raw`,
    );
    const pruned = Number(r1.rows[0]!.prune_inbound_raw);
    // Other tests may have left aged rows; assert AT LEAST our two went, and
    // that ours specifically are the ones gone (scoped check below).
    check('(c) returns a prune count', Number.isInteger(pruned) && pruned >= 2, `pruned=${pruned}`);

    const mine = await c.query<{ provider_msg_id: string }>(
      `select provider_msg_id from public.inbound_raw where provider_msg_id like $1 order by 1`,
      [`${PFX}%`],
    );
    const remaining = mine.rows.map((x) => x.provider_msg_id);
    check('(a) rows older than the TTL are pruned', !remaining.includes(`${PFX}old-a`) && !remaining.includes(`${PFX}old-b`),
      `remaining=${JSON.stringify(remaining)}`);
    check('(b) rows within the TTL are kept', remaining.length === 1 && remaining[0] === `${PFX}new`,
      `remaining=${JSON.stringify(remaining)}`);

    // (d) idempotent: nothing of ours left to prune at 90d, so a re-run leaves
    //     our recent row intact.
    await c.query(`select public.prune_inbound_raw()`);
    const afterReRun = await c.query<{ n: string }>(
      `select count(*)::text as n from public.inbound_raw where provider_msg_id like $1`,
      [`${PFX}%`],
    );
    check('(d) idempotent: recent row survives a second run', afterReRun.rows[0]!.n === '1',
      `count=${afterReRun.rows[0]!.n}`);

    // (e) a tighter horizon (1 day) prunes the recent row too.
    await c.query(`select public.prune_inbound_raw(interval '1 day')`);
    const afterTight = await c.query<{ n: string }>(
      `select count(*)::text as n from public.inbound_raw where provider_msg_id like $1`,
      [`${PFX}%`],
    );
    check('(e) interval param honoured: 1-day horizon prunes the recent row', afterTight.rows[0]!.n === '0',
      `count=${afterTight.rows[0]!.n}`);
  } finally {
    // Clean up any of our rows that might survive a failed assertion.
    await c.query(`delete from public.inbound_raw where provider_msg_id like $1`, [`${PFX}%`]);
    await c.end();
  }

  console.info('');
  if (failures.length > 0) {
    console.error(`${failures.length} prune_inbound_raw check(s) FAILED`);
    process.exit(1);
  }
  console.info('OK: prune_inbound_raw DoD checks all green');
}

await main();
