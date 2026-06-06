// ----------------------------------------------------------------------------
// DB-level tenant isolation test (Phase 2 DoD #1).
//
// Connects to an EPHEMERAL Postgres (CI service container or local docker),
// where:
//   - supabase_compat.sql created the `auth` schema, the `authenticated`
//     role, and auth.uid()
//   - 20260604000001_phase2_schema.sql created all domain tables + RLS
//   - seed_two_accounts.sql inserted two accounts, two real auth users,
//     two account_members, and one row of every domain table per account
//
// The test logs in as each user by SET ROLE authenticated + SET LOCAL
// request.jwt.claims TO '{"sub":"...","role":"authenticated"}' -- same
// shape PostgREST sets when verifying a real Supabase access token.
//
// For every public.* table:
//   - cross-tenant rows MUST be 0 (the isolation guarantee)
//   - own-tenant rows MUST be > 0 (sanity that the seed wrote AND the
//     policy doesn't over-restrict)
//
// Tables without an account_id column (accounts, users) get their own
// shape-specific assertions.
//
// Any leak prints the offending table and exits non-zero. CI is red on
// leak by construction.
// ----------------------------------------------------------------------------

import pg from 'pg';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(2);
}

// Match seed_two_accounts.sql.
const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const SELF_ONLY_TABLES = new Set(['users']);
const ACCOUNT_PK_TABLE = 'accounts';
// Tables we do NOT seed with domain rows. They still get the cross-tenant
// isolation check (cross-account count == 0), but we skip the
// "must-have-own-rows" assertion because there's no natural seed entry.
const NO_SEED_REQUIRED = new Set(['idempotency_keys', 'intake_tokens']);

interface ColumnInfo {
  has_account_id: boolean;
}

interface Failure {
  user: 'A' | 'B';
  table: string;
  kind: 'cross_tenant_leak' | 'own_tenant_invisible' | 'self_only_overreach';
  detail: string;
}

async function listPublicTables(superClient: pg.Client): Promise<string[]> {
  const res = await superClient.query<{ table_name: string }>(`
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `);
  return res.rows.map((r) => r.table_name);
}

async function tableColumns(
  superClient: pg.Client,
  tables: string[],
): Promise<Record<string, ColumnInfo>> {
  const res = await superClient.query<{ table_name: string; column_name: string }>(`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
  `);
  const cols: Record<string, Set<string>> = {};
  for (const r of res.rows) {
    (cols[r.table_name] ??= new Set()).add(r.column_name);
  }
  const out: Record<string, ColumnInfo> = {};
  for (const t of tables) {
    out[t] = { has_account_id: cols[t]?.has('account_id') ?? false };
  }
  return out;
}

async function assertSeededOwn(superClient: pg.Client, tables: string[]): Promise<void> {
  // As superuser (bypassing RLS), confirm every account_id-bearing table has
  // rows for both accounts. If the seed didn't write to a table, the under-
  // RLS check below would pass vacuously.
  for (const t of tables) {
    if (t === ACCOUNT_PK_TABLE || SELF_ONLY_TABLES.has(t) || NO_SEED_REQUIRED.has(t)) continue;
    const colRes = await superClient.query(
      `select 1 from information_schema.columns
        where table_schema='public' and table_name=$1 and column_name='account_id'`,
      [t],
    );
    if (colRes.rowCount === 0) continue;
    const aRes = await superClient.query<{ n: string }>(
      `select count(*)::text as n from public.${t} where account_id = $1`,
      [ACCOUNT_A],
    );
    const bRes = await superClient.query<{ n: string }>(
      `select count(*)::text as n from public.${t} where account_id = $1`,
      [ACCOUNT_B],
    );
    const aN = Number(aRes.rows[0]!.n);
    const bN = Number(bRes.rows[0]!.n);
    if (aN === 0 || bN === 0) {
      throw new Error(
        `seed gap: ${t} has ${aN} rows for A and ${bN} rows for B (both must be > 0)`,
      );
    }
  }
}

async function withAuthUser(
  url: string,
  userId: string,
  fn: (c: pg.Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('begin');
    // The order matters: set the JWT claims first (still as the connecting
    // role, which has permission to set the parameter), then drop into the
    // unprivileged `authenticated` role.
    await client.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: userId, role: 'authenticated' })],
    );
    await client.query('set local role authenticated');
    await fn(client);
    await client.query('commit');
  } finally {
    await client.end();
  }
}

async function checkTable(
  client: pg.Client,
  table: string,
  info: ColumnInfo,
  asUser: 'A' | 'B',
  ownAccount: string,
  otherAccount: string,
  failures: Failure[],
): Promise<void> {
  if (table === ACCOUNT_PK_TABLE) {
    // accounts: under RLS user should see only own account.
    const own = await client.query<{ n: string }>(
      `select count(*)::text as n from public.accounts where id = $1`,
      [ownAccount],
    );
    const other = await client.query<{ n: string }>(
      `select count(*)::text as n from public.accounts where id = $1`,
      [otherAccount],
    );
    if (Number(other.rows[0]!.n) !== 0) {
      failures.push({
        user: asUser,
        table,
        kind: 'cross_tenant_leak',
        detail: `accounts: ${other.rows[0]!.n} rows visible for other account`,
      });
    }
    if (Number(own.rows[0]!.n) === 0) {
      failures.push({
        user: asUser,
        table,
        kind: 'own_tenant_invisible',
        detail: `accounts: own account not visible`,
      });
    }
    return;
  }

  if (SELF_ONLY_TABLES.has(table)) {
    // users: self-only. Total visible should be exactly 1 (own row).
    const total = await client.query<{ n: string }>(
      `select count(*)::text as n from public.${table}`,
    );
    const n = Number(total.rows[0]!.n);
    if (n > 1) {
      failures.push({
        user: asUser,
        table,
        kind: 'self_only_overreach',
        detail: `${table}: ${n} rows visible (expected at most 1)`,
      });
    }
    if (n === 0) {
      failures.push({
        user: asUser,
        table,
        kind: 'own_tenant_invisible',
        detail: `${table}: own row not visible`,
      });
    }
    return;
  }

  if (!info.has_account_id) {
    // Unexpected — every other domain table should have account_id. Flag.
    failures.push({
      user: asUser,
      table,
      kind: 'cross_tenant_leak',
      detail: `${table}: no account_id column; cannot check isolation`,
    });
    return;
  }

  const cross = await client.query<{ n: string }>(
    `select count(*)::text as n from public.${table} where account_id = $1`,
    [otherAccount],
  );
  const own = await client.query<{ n: string }>(
    `select count(*)::text as n from public.${table} where account_id = $1`,
    [ownAccount],
  );
  const crossN = Number(cross.rows[0]!.n);
  const ownN = Number(own.rows[0]!.n);

  // account_members is self-only by policy: even within own account, user A
  // sees only their own membership row, not every member of A. So "ownN > 0"
  // is still the right check (must see at least themselves).
  if (crossN !== 0) {
    failures.push({
      user: asUser,
      table,
      kind: 'cross_tenant_leak',
      detail: `${crossN} rows from other account visible`,
    });
  }
  if (ownN === 0 && !NO_SEED_REQUIRED.has(table)) {
    failures.push({
      user: asUser,
      table,
      kind: 'own_tenant_invisible',
      detail: `0 rows of own account visible`,
    });
  }
}

async function main(): Promise<void> {
  const superClient = new Client({ connectionString: DATABASE_URL });
  await superClient.connect();
  const tables = await listPublicTables(superClient);
  const cols = await tableColumns(superClient, tables);
  await assertSeededOwn(superClient, tables);
  await superClient.end();

  const failures: Failure[] = [];

  for (const t of tables) {
    await withAuthUser(DATABASE_URL!, USER_A, async (c) => {
      await checkTable(c, t, cols[t]!, 'A', ACCOUNT_A, ACCOUNT_B, failures);
    });
    await withAuthUser(DATABASE_URL!, USER_B, async (c) => {
      await checkTable(c, t, cols[t]!, 'B', ACCOUNT_B, ACCOUNT_A, failures);
    });
  }

  if (failures.length > 0) {
    console.error('TENANT ISOLATION FAILURES:');
    for (const f of failures) {
      console.error(`  [user ${f.user}] ${f.table} (${f.kind}): ${f.detail}`);
    }
    console.error(`\n${failures.length} failure(s) across ${tables.length} tables`);
    process.exit(1);
  }

  console.info(`OK: ${tables.length} public tables, two users, two accounts — no cross-tenant leaks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
