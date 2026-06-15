// ----------------------------------------------------------------------------
// advance_tenancy_statuses DoD tests (DB-level).
//
// Exercises the idempotent upcoming→active cron function directly against
// the SQL. Uses a FIXED p_as_of of '2026-06-14T00:00:00Z' so the test is
// fully deterministic regardless of when it runs.
//
// Coverage:
//   (a) upcoming + start_date <= as_of               → flipped to active.
//   (b) upcoming + start_date > as_of (future)       → stays upcoming.
//   (c) ended                                         → untouched.
//   (d) holdover                                      → untouched.
//   (e) already active                                → untouched.
//   (f) soft-deleted upcoming + start_date <= as_of  → NOT flipped.
//   (g) idempotency: second call returns zero rows,  → nothing changes.
//   (h) return set equals exactly the flipped ids.
//   (i) audit attribution: flipped row has an event with actor =
//       'system:cron:tenancy' in public.events.
//
// Seeding strategy: we create a fresh unit-kind area under ACCOUNT_A so the
// _assert_area_is_unit trigger is satisfied, then insert one tenancy per
// scenario with explicit UUIDs. All assertions are scoped to our own ids so
// pre-existing seed rows don't interfere.
// ----------------------------------------------------------------------------

import pg from 'pg';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(2);
}

// Fixed reference instant; all start_date comparisons are relative to this.
const AS_OF = '2026-06-14T00:00:00Z';

// Use ACCOUNT_A from the two-account seed fixture.
const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';

// Fixed property UUID (seeded for ACCOUNT_A in seed_two_accounts.sql).
// We'll look it up dynamically rather than hard-coding, so let's declare a var.
let UNIT_AREA_ID = ''; // assigned in setup

// Fixed tenancy UUIDs for this test, chosen to be well outside any other range.
const T_UPCOMING_DUE      = 'a0000001-0000-0000-0000-000000000001'; // (a) flip
const T_UPCOMING_FUTURE   = 'a0000001-0000-0000-0000-000000000002'; // (b) no flip
const T_ENDED             = 'a0000001-0000-0000-0000-000000000003'; // (c) no flip
const T_HOLDOVER          = 'a0000001-0000-0000-0000-000000000004'; // (d) no flip
const T_ACTIVE            = 'a0000001-0000-0000-0000-000000000005'; // (e) no flip
const T_DELETED_UPCOMING  = 'a0000001-0000-0000-0000-000000000006'; // (f) no flip
const T_UPCOMING_BOUNDARY = 'a0000001-0000-0000-0000-000000000007'; // (a2) flip: start_date == as_of

interface Failure {
  name: string;
  detail: string;
}
const failures: Failure[] = [];

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.info(`  PASS  ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// -----------------------------------------------------------------------
// Setup: create a fresh unit-kind area under account A's existing property.
// (We reuse the seeded v_unit_a area that seed_two_accounts.sql creates for
// ACCOUNT_A -- look it up rather than assuming a fixed uuid, since the seed
// uses gen_random_uuid().)
// -----------------------------------------------------------------------
async function setup(): Promise<void> {
  await withClient(async (c) => {
    // Resolve the seeded unit area for account A.
    const r = await c.query<{ id: string }>(
      `select id from public.areas where account_id = $1 and kind = 'unit' limit 1`,
      [ACCOUNT_A],
    );
    if (!r.rows[0]) {
      throw new Error('setup: no unit-kind area found for ACCOUNT_A in seed');
    }
    UNIT_AREA_ID = r.rows[0].id;

    // Insert all scenario tenancies under ACCOUNT_A using UNIT_AREA_ID.
    // Use ON CONFLICT DO NOTHING so a re-run on a persistent DB is safe.
    await c.query(
      `insert into public.tenancies (id, account_id, area_id, start_date, status)
       values
         ($1, $2, $3, '2026-06-01', 'upcoming'),   -- (a) due
         ($4, $2, $3, '2026-06-15', 'upcoming'),   -- (b) future
         ($5, $2, $3, '2026-01-01', 'ended'),       -- (c) ended
         ($6, $2, $3, '2026-01-01', 'holdover'),    -- (d) holdover
         ($7, $2, $3, '2026-01-01', 'active'),      -- (e) already active
         ($8, $2, $3, '2026-06-01', 'upcoming'),    -- (f) soft-deleted upcoming
         ($9, $2, $3, '2026-06-14', 'upcoming')     -- (a2) boundary: start_date == as_of::date
       on conflict (id) do nothing`,
      [
        T_UPCOMING_DUE,
        ACCOUNT_A,
        UNIT_AREA_ID,
        T_UPCOMING_FUTURE,
        T_ENDED,
        T_HOLDOVER,
        T_ACTIVE,
        T_DELETED_UPCOMING,
        T_UPCOMING_BOUNDARY,
      ],
    );

    // Soft-delete (f).
    await c.query(
      `update public.tenancies set deleted_at = now() where id = $1 and deleted_at is null`,
      [T_DELETED_UPCOMING],
    );
  });
}

// -----------------------------------------------------------------------
// Teardown: remove all seeded rows (cleans up on persistent dev DBs).
// Delete in reverse dependency order; events rows are immutable so we skip
// them (they're harmless extra rows and the tests scope to our ids).
// -----------------------------------------------------------------------
async function teardown(): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `delete from public.tenancies where id = any($1::uuid[])`,
      [[T_UPCOMING_DUE, T_UPCOMING_FUTURE, T_ENDED, T_HOLDOVER, T_ACTIVE, T_DELETED_UPCOMING, T_UPCOMING_BOUNDARY]],
    );
  });
}

async function tenancyStatus(c: pg.Client, id: string): Promise<string | null> {
  const r = await c.query<{ status: string }>(
    `select status from public.tenancies where id = $1`,
    [id],
  );
  return r.rows[0]?.status ?? null;
}

// Count 'updated' events for a tenancy attributed to the cron actor. Used to
// assert a NEW event was emitted by the flip (delta), not just that some
// (possibly stale) event exists.
async function cronEventCount(c: pg.Client, id: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    `select count(*)::text as n
       from public.events
      where entity_type = 'tenancies'
        and entity_id   = $1
        and event_type  = 'updated'
        and actor       = 'system:cron:tenancy'`,
    [id],
  );
  return Number(r.rows[0]?.n ?? '0');
}

async function main(): Promise<void> {
  console.info('advance_tenancy_statuses DoD checks');

  await setup();

  // Capture the count of cron-attributed events for T_UPCOMING_DUE BEFORE the
  // flip. On a persistent dev DB, teardown leaves events rows behind (they're
  // immutable) and setup reuses the same id, so a stale event from a prior run
  // must not satisfy check (i). We assert a NEW event appears (delta == 1).
  const eventsBefore = await withClient((c) => cronEventCount(c, T_UPCOMING_DUE));

  // -----------------------------------------------------------------------
  // Run the function once and capture what it returned.
  // -----------------------------------------------------------------------
  let firstCallIds: string[] = [];
  await withClient(async (c) => {
    const r = await c.query<{ o_tenancy_id: string; o_account_id: string; o_start_date: string }>(
      `select o_tenancy_id, o_account_id, o_start_date
         from public.advance_tenancy_statuses($1::timestamptz)`,
      [AS_OF],
    );
    firstCallIds = r.rows.map((row) => row.o_tenancy_id);
  });

  // -----------------------------------------------------------------------
  // (a) upcoming + start_date <= as_of → flipped to active.
  // -----------------------------------------------------------------------
  await check('(a) upcoming start_date<=as_of flipped to active', async () => {
    const status = await withClient((c) => tenancyStatus(c, T_UPCOMING_DUE));
    if (status !== 'active') {
      throw new Error(`expected status='active', got '${status}'`);
    }
  });

  // -----------------------------------------------------------------------
  // (a2) boundary: start_date EXACTLY == as_of::date → flipped (inclusive <=).
  // -----------------------------------------------------------------------
  await check('(a2) upcoming start_date==as_of flipped to active (inclusive boundary)', async () => {
    const status = await withClient((c) => tenancyStatus(c, T_UPCOMING_BOUNDARY));
    if (status !== 'active') {
      throw new Error(`expected status='active' at the start_date==as_of boundary, got '${status}'`);
    }
  });

  // -----------------------------------------------------------------------
  // (b) upcoming + start_date > as_of → stays upcoming.
  // -----------------------------------------------------------------------
  await check('(b) upcoming future start_date stays upcoming', async () => {
    const status = await withClient((c) => tenancyStatus(c, T_UPCOMING_FUTURE));
    if (status !== 'upcoming') {
      throw new Error(`expected status='upcoming', got '${status}'`);
    }
  });

  // -----------------------------------------------------------------------
  // (c) ended → untouched.
  // -----------------------------------------------------------------------
  await check('(c) ended status untouched', async () => {
    const status = await withClient((c) => tenancyStatus(c, T_ENDED));
    if (status !== 'ended') {
      throw new Error(`expected status='ended', got '${status}'`);
    }
  });

  // -----------------------------------------------------------------------
  // (d) holdover → untouched.
  // -----------------------------------------------------------------------
  await check('(d) holdover status untouched', async () => {
    const status = await withClient((c) => tenancyStatus(c, T_HOLDOVER));
    if (status !== 'holdover') {
      throw new Error(`expected status='holdover', got '${status}'`);
    }
  });

  // -----------------------------------------------------------------------
  // (e) already active → untouched.
  // -----------------------------------------------------------------------
  await check('(e) already-active status untouched', async () => {
    const status = await withClient((c) => tenancyStatus(c, T_ACTIVE));
    if (status !== 'active') {
      throw new Error(`expected status='active', got '${status}'`);
    }
  });

  // -----------------------------------------------------------------------
  // (f) soft-deleted upcoming + start_date <= as_of → NOT flipped.
  // -----------------------------------------------------------------------
  await check('(f) soft-deleted upcoming NOT flipped', async () => {
    const status = await withClient((c) => tenancyStatus(c, T_DELETED_UPCOMING));
    if (status !== 'upcoming') {
      throw new Error(`expected status='upcoming' (soft-deleted, guard holds), got '${status}'`);
    }
  });

  // -----------------------------------------------------------------------
  // (g) idempotency: second call returns zero rows, changes nothing.
  // -----------------------------------------------------------------------
  await check('(g) idempotency: second call returns zero rows', async () => {
    const secondCallIds = await withClient(async (c) => {
      const r = await c.query<{ o_tenancy_id: string }>(
        `select o_tenancy_id from public.advance_tenancy_statuses($1::timestamptz)`,
        [AS_OF],
      );
      return r.rows.map((row) => row.o_tenancy_id);
    });
    if (secondCallIds.length !== 0) {
      throw new Error(
        `expected 0 rows on second call, got ${secondCallIds.length}: [${secondCallIds.join(', ')}]`,
      );
    }
    // Status of (a) must still be active after the second call.
    const status = await withClient((c) => tenancyStatus(c, T_UPCOMING_DUE));
    if (status !== 'active') {
      throw new Error(`status changed on second call: expected 'active', got '${status}'`);
    }
  });

  // -----------------------------------------------------------------------
  // (h) return set equals exactly the ids that were flipped.
  //     Only T_UPCOMING_DUE and T_UPCOMING_BOUNDARY qualify (upcoming +
  //     non-deleted + start_date <= as_of).
  // -----------------------------------------------------------------------
  await check('(h) return set equals exactly the flipped ids', async () => {
    const expected = new Set([T_UPCOMING_DUE, T_UPCOMING_BOUNDARY]);
    const actual = new Set(firstCallIds);
    // Every expected id must appear.
    for (const id of expected) {
      if (!actual.has(id)) {
        throw new Error(`expected id ${id} missing from return set`);
      }
    }
    // No unexpected id among OUR test rows should appear (pre-existing seed
    // rows from other suites are not our responsibility).
    const ourIds = new Set([
      T_UPCOMING_DUE,
      T_UPCOMING_FUTURE,
      T_ENDED,
      T_HOLDOVER,
      T_ACTIVE,
      T_DELETED_UPCOMING,
      T_UPCOMING_BOUNDARY,
    ]);
    for (const id of actual) {
      if (ourIds.has(id) && !expected.has(id)) {
        throw new Error(`unexpected id in return set: ${id}`);
      }
    }
  });

  // -----------------------------------------------------------------------
  // (i) audit attribution: the tenancy flip produced an event with
  //     actor = 'system:cron:tenancy' in public.events.
  //
  //     The _emit_event() trigger runs after each UPDATE on public.tenancies.
  //     With auth.uid()=null (cron context) and audit.actor set by the function,
  //     the trigger writes actor='system:cron:tenancy' to public.events.
  //     event_type='updated' (status field changed, deleted_at untouched).
  //     We query by entity_type='tenancies', entity_id=T_UPCOMING_DUE,
  //     event_type='updated', and actor='system:cron:tenancy'.
  // -----------------------------------------------------------------------
  await check(
    "(i) audit attribution: flip emitted a NEW event actor='system:cron:tenancy'",
    async () => {
      const eventsAfter = await withClient((c) => cronEventCount(c, T_UPCOMING_DUE));
      // Exactly one new cron-attributed 'updated' event from THIS run's flip.
      // (The idempotent second call in (g) flips nothing, so no extra event.)
      // Asserting the delta — not mere existence — defends against a stale
      // event left behind on a persistent dev DB.
      if (eventsAfter !== eventsBefore + 1) {
        throw new Error(
          `expected exactly 1 new system:cron:tenancy 'updated' event for ${T_UPCOMING_DUE}, ` +
            `got delta ${eventsAfter - eventsBefore} (before=${eventsBefore}, after=${eventsAfter})`,
        );
      }
    },
  );

  // -----------------------------------------------------------------------
  // Teardown (best-effort; non-fatal if it fails on an ephemeral DB).
  // -----------------------------------------------------------------------
  try {
    await teardown();
  } catch (e) {
    console.warn(`  WARN  teardown failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\n${failures.length} tenancy-status failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: advance_tenancy_statuses DoD checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
