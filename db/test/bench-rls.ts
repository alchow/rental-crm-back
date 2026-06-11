// RLS policy-form benchmark (Phase 3, ADR-0003). NOT a pass/fail test.
//
// Compares the per-row correlated EXISTS function call (current policy form)
// against the initplan-cached IN-subquery form on a 100k-row scan under the
// authenticated role, exactly as PostgREST executes it. Run:
//   DATABASE_URL=... pnpm --filter ./db bench:rls
//
// Seeds 100k interactions for ACCOUNT_A with the audit trigger disabled
// (seeding speed; the benchmark measures READ policies), restores everything
// afterwards.

import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(2);
}

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ROWS = Number(process.env.BENCH_ROWS ?? 100_000);

const FORM_A = `create policy interactions_member_all on public.interactions
  for all
  using      (public.is_account_member(account_id))
  with check (public.is_account_member(account_id))`;

const FORM_B = `create policy interactions_member_all on public.interactions
  for all
  using (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))
  with check (account_id in (
    select m.account_id from public.account_members m
     where m.user_id = (select auth.uid()) and m.deleted_at is null))`;

async function asUserA<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: USER_A, role: 'authenticated' }),
    ]);
    await c.query('set local role authenticated');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } finally {
    await c.end();
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function measure(label: string): Promise<{ count_ms: number; page_ms: number }> {
  const counts: number[] = [];
  const pages: number[] = [];
  for (let i = 0; i < 5; i++) {
    await asUserA(async (c) => {
      let t0 = performance.now();
      await c.query(`select count(*) from public.interactions where account_id = $1`, [ACCOUNT_A]);
      counts.push(performance.now() - t0);
      t0 = performance.now();
      await c.query(
        `select * from public.interactions where account_id = $1 and deleted_at is null
          order by occurred_at, id limit 50`,
        [ACCOUNT_A],
      );
      pages.push(performance.now() - t0);
    });
  }
  const out = { count_ms: Math.round(median(counts)), page_ms: Math.round(median(pages) * 10) / 10 };
  console.info(`${label}: full-scan count ${out.count_ms}ms, keyset page ${out.page_ms}ms (medians of 5)`);
  return out;
}

const su = new Client({ connectionString: DATABASE_URL });
await su.connect();

console.info(`seeding ${ROWS} interactions (audit trigger disabled for speed)…`);
await su.query(`alter table public.interactions disable trigger interactions_audit`);
const BATCH = 5000;
for (let start = 0; start < ROWS; start += BATCH) {
  const n = Math.min(BATCH, ROWS - start);
  await su.query(
    `insert into public.interactions (account_id, actor, kind, party_type, channel, direction, body, occurred_at)
     select $1, 'system', 'note', 'none', 'note', 'none', 'rls-bench', now() - (g || ' seconds')::interval
       from generate_series($2::int, $3::int) g`,
    [ACCOUNT_A, start, start + n - 1],
  );
}
await su.query(`alter table public.interactions enable trigger interactions_audit`);
await su.query('analyze public.interactions');

// ADR-0003 adopted form B as the live policy; install form A explicitly for
// the comparison and restore form B at the end.
await su.query(`drop policy interactions_member_all on public.interactions`);
await su.query(FORM_A);
console.info('--- FORM A (legacy): per-row is_account_member() EXISTS ---');
const a = await measure('A');

await su.query(`drop policy interactions_member_all on public.interactions`);
await su.query(FORM_B);
console.info('--- FORM B (live): IN (initplan-cached membership subquery) ---');
const b = await measure('B');

// Remove the seeded rows; form B stays (it is the deployed policy).
await su.query(`alter table public.interactions disable trigger interactions_audit`);
await su.query(`delete from public.interactions where account_id = $1 and body = 'rls-bench'`, [ACCOUNT_A]);
await su.query(`alter table public.interactions enable trigger interactions_audit`);
await su.end();

const winPct = Math.round((1 - b.count_ms / Math.max(a.count_ms, 1)) * 100);
console.info(JSON.stringify({ rows: ROWS, form_a: a, form_b: b, full_scan_win_pct: winPct }));
console.info(winPct >= 20
  ? `VERDICT: form B wins ${winPct}% on full scans -- ADR-0003 says adopt.`
  : `VERDICT: form B wins only ${winPct}% -- below the 20% adoption bar; keep form A.`);
