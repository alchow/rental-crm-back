import { readFileSync, readdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';

// These migrations must commit together: the second restores the rent generator.
const root = new URL('../../', import.meta.url);
const directory = new URL('db/supabase/migrations/', root);
const versions = ['20260912000001', '20260912000002', '20260912000003'];
const apply = process.argv.includes('--apply');
if (process.argv[2] !== 'prod')
  throw new Error('Usage: node db/scripts/apply-credit-migrations.mjs prod [--apply]');
const env = parseEnv(readFileSync(new URL('.env.local', root), 'utf8'));
const connectionString = process.env.SUPABASE_DB_URL_PROD || env.SUPABASE_DB_URL_PROD;
if (!connectionString) throw new Error('SUPABASE_DB_URL_PROD is required');
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query(apply ? 'begin' : 'begin read only');
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '30s'");
  const applied = new Set(
    (await client.query('select version from supabase_migrations.schema_migrations')).rows.map(
      (row) => row.version,
    ),
  );
  const pending = readdirSync(directory)
    .filter((file) => file.endsWith('.sql') && !applied.has(file.split('_')[0]))
    .sort();
  console.info('Pending migrations:', pending);
  if (
    pending.length !== versions.length ||
    pending.some((file, index) => !file.startsWith(versions[index] + '_'))
  ) {
    throw new Error(
      'Expected exactly the three credit migrations; inspect history before applying',
    );
  }
  const generator = (
    await client.query(
      "select prosrc from pg_proc where oid = 'public.generate_rent_charges(uuid,timestamptz)'::regprocedure",
    )
  ).rows[0].prosrc;
  if (apply) await client.query('lock table public.payment_allocations in access exclusive mode');
  const before = (
    await client.query(
      'select count(*)::int as rows, coalesce(sum(amount_cents),0)::text as cents from public.payment_allocations',
    )
  ).rows[0];
  console.info('Application facts before:', before);
  if (apply) {
    for (const file of pending) {
      const sql = readFileSync(new URL(file, directory), 'utf8');
      await client.query(sql);
      await client.query(
        'insert into supabase_migrations.schema_migrations(version, statements, name) values ($1,$2,$3)',
        [file.split('_')[0], [sql], file.slice(15, -4)],
      );
    }
    const after = (
      await client.query(
        'select count(*)::int as rows, coalesce(sum(amount_cents),0)::text as cents from public.payment_allocations',
      )
    ).rows[0];
    const restored = (
      await client.query(
        "select prosrc from pg_proc where oid = 'public.generate_rent_charges(uuid,timestamptz)'::regprocedure",
      )
    ).rows[0].prosrc;
    if (restored.trim() !== generator.trim() || JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Generator or application facts changed unexpectedly');
    }
    const rollup = (
      await client.query(
        "select prosrc from pg_proc where oid = 'public.rent_rollup(uuid,text[],date)'::regprocedure",
      )
    ).rows[0].prosrc;
    if (!rollup.includes('and a.voided_at is null'))
      throw new Error('Rollup reversal filter is missing');
    await client.query("notify pgrst, 'reload schema'");
    await client.query('commit');
    console.info(
      'Committed all three migrations; original generator and application amounts preserved.',
    );
  } else {
    await client.query('rollback');
    console.info('Read-only preflight passed. Add --apply to commit all three atomically.');
  }
} catch (error) {
  await client.query('rollback').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
