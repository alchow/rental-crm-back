// Import-executor benchmark (Phase 2.3). NOT a pass/fail test -- prints the
// pg query count + wall clock for a 10k-row preview so before/after numbers
// can be recorded in the PR. Run: pnpm --filter ./api bench:import
// Requires the local Supabase stack.

import { execSync } from 'node:child_process';
import pg from 'pg';

function dbUrl(): string {
  const out = execSync('supabase status --output env --workdir db', {
    cwd: process.cwd().endsWith('/api') ? '..' : '.',
    encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.startsWith('DB_URL='));
  if (!line) throw new Error('no DB_URL from supabase status');
  return line.slice('DB_URL='.length).replace(/^"|"$/g, '');
}

const DB_URL = dbUrl();
process.env.NODE_ENV = 'test';
process.env.PORT = '8793';
process.env.SUPABASE_URL = 'https://bench.supabase.co';
process.env.SUPABASE_ANON_KEY = 'bench-anon-key-padded-to-min-len';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'bench-service-key-padded-to-min-len';
process.env.SUPABASE_DB_URL = DB_URL;

// Count every query issued through pg (the executor's pool clients included).
let queryCount = 0;
const origQuery = pg.Client.prototype.query;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(pg.Client.prototype as any).query = function (...args: unknown[]) {
  queryCount += 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origQuery as any).apply(this, args);
};

const { runImport } = await import('../src/admin/import-executor');
const { closePool } = await import('../src/admin/db-pool');

const ROWS = Number(process.env.BENCH_ROWS ?? 10_000);
const seed = new pg.Client({ connectionString: DB_URL });
await seed.connect();

const accountId = (await seed.query(`insert into accounts (name) values ('bench') returning id`)).rows[0].id as string;
const mapping = [
  { region_index: 0, entity_type: 'property', fields: [{ target_field: 'name', source_column: 'Property', constant: null, confidence: 1 }] },
  { region_index: 0, entity_type: 'area', fields: [{ target_field: 'name', source_column: 'Unit', constant: null, confidence: 1 }] },
  { region_index: 0, entity_type: 'tenant', fields: [{ target_field: 'full_name', source_column: 'Tenant', constant: null, confidence: 1 }] },
  { region_index: 0, entity_type: 'tenancy', fields: [{ target_field: 'start_date', source_column: 'Start', constant: null, confidence: 1 }] },
  { region_index: 0, entity_type: 'tenancy_member', fields: [{ target_field: 'role', source_column: null, constant: 'primary', confidence: 1 }] },
  { region_index: 0, entity_type: 'rent_schedule', fields: [{ target_field: 'amount', source_column: 'Rent', constant: null, confidence: 1 }] },
];
const sessionId = (
  await seed.query(
    `insert into import_sessions (account_id, status, source_filename, mapping)
     values ($1, 'awaiting_mapping', 'bench.csv', $2::jsonb) returning id`,
    [accountId, JSON.stringify(mapping)],
  )
).rows[0].id as string;

// ~40 properties x 10 units, tenants unique per row -> realistic reuse mix.
const BATCH = 1000;
for (let start = 0; start < ROWS; start += BATCH) {
  const values: string[] = [];
  const params: unknown[] = [];
  for (let i = start; i < Math.min(start + BATCH, ROWS); i++) {
    const p = params.length;
    values.push(`($${p + 1}, $${p + 2}, 0, $${p + 3}, $${p + 4}::jsonb)`);
    params.push(accountId, sessionId, i, JSON.stringify({
      Property: `Building ${i % 40}`,
      Unit: `Unit ${i % 400}`,
      Tenant: `Tenant ${i}`,
      Start: '01/01/2026',
      Rent: `$${1000 + (i % 900)}`,
    }));
  }
  await seed.query(
    `insert into import_rows (account_id, session_id, region_index, row_index, raw) values ${values.join(',')}`,
    params,
  );
}
console.info(`seeded ${ROWS} rows; running preview (dry-run)…`);

queryCount = 0;
const t0 = performance.now();
const result = await runImport(sessionId, accountId, true);
const ms = Math.round(performance.now() - t0);

console.info(JSON.stringify({
  rows: ROWS,
  queries: queryCount,
  ms,
  rows_imported: result.rows_imported,
  rows_blocked: result.rows_blocked,
  counts: result.counts,
}, null, 2));

await seed.query(`delete from import_rows where session_id = $1`, [sessionId]);
await seed.query(`delete from import_sessions where id = $1`, [sessionId]);
await seed.end();
await closePool();
