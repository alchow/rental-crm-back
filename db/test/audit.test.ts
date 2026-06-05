// ----------------------------------------------------------------------------
// Phase 3 audit-spine DoD test.
//
// Runs after the Phase 2 isolation test (same ephemeral DB, same seed). Tests
// the five guarantees the audit spine promises:
//
//   1. an UPDATE on a domain row produces a new event AND the pre-edit value
//      still appears in entity_history.
//   2. events are immutable to non-owner roles (UPDATE on events is denied
//      to authenticated; DELETE on events is denied to authenticated).
//   3. a direct postgres-superuser INSERT (bypassing the API entirely) still
//      produces an event -- this is the "trigger coverage" property; the
//      audit spine is enforcement at the DB, not the app.
//   4. a hand-tampered event payload makes verify_chain(account_id) report
//      ok = false at the tampered row. Same row hand-restored makes it pass.
//   5. interactions.logged_at is immutable: any UPDATE that changes it
//      raises (the BEFORE trigger fires before the audit AFTER trigger).
//
// Also samples a couple of structural sanity checks at the top:
//   - verify_chain returns ok = true on the seeded data
//   - the seed produced events for every domain table per account
//
// On any failure: prints which check broke and exits 1. CI is red on the
// first failed assertion.
// ----------------------------------------------------------------------------

import pg from 'pg';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(2);
}

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

interface Failure {
  name: string;
  detail: string;
}

async function check(
  name: string,
  fn: () => Promise<void>,
  failures: Failure[],
): Promise<void> {
  try {
    await fn();
    console.info(`  PASS  ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

async function asSuper<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

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
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

async function expectThrows(
  name: string,
  fn: () => Promise<void>,
  matchesAny: RegExp[],
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (matchesAny.some((re) => re.test(msg))) return;
    throw new Error(
      `expected error matching one of [${matchesAny.map((r) => r.source).join(', ')}], got: ${msg}`,
    );
  }
  throw new Error(`${name}: expected an error but none was thrown`);
}

async function main(): Promise<void> {
  const failures: Failure[] = [];
  console.info('Phase 3 audit-spine DoD checks');

  // -----------------------------------------------------------------------
  // Structural sanity: seed produced events; chain is intact at baseline.
  // -----------------------------------------------------------------------
  await check(
    'baseline: seed produced events for account A',
    async () => {
      await asSuper(async (c) => {
        const res = await c.query<{ n: string }>(
          `select count(*)::text as n from public.events where account_id = $1`,
          [ACCOUNT_A],
        );
        const n = Number(res.rows[0]!.n);
        if (n < 20) {
          throw new Error(`expected >= 20 seed events for account A, got ${n}`);
        }
      });
    },
    failures,
  );

  await check(
    'baseline: verify_chain(A) ok = true on freshly-seeded data',
    async () => {
      await asSuper(async (c) => {
        const res = await c.query<{ ok: boolean; reason: string | null }>(
          `select ok, reason from public.verify_chain($1)`,
          [ACCOUNT_A],
        );
        if (!res.rows[0]!.ok) {
          throw new Error(`chain broken at baseline: ${res.rows[0]!.reason}`);
        }
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // DoD #1: edit creates a new event; original survives in history.
  // -----------------------------------------------------------------------
  await check(
    'edit -> new "updated" event; pre-edit value remains in history',
    async () => {
      await asSuper(async (c) => {
        // Pick the seeded vendor for account A.
        const v = await c.query<{ id: string; notes: string | null }>(
          `select id, notes from public.vendors where account_id = $1`,
          [ACCOUNT_A],
        );
        const vendor = v.rows[0]!;
        const originalNotes = vendor.notes; // null in the seed
        const newNotes = `edited ${Date.now()}`;

        await c.query(`update public.vendors set notes = $1 where id = $2`, [
          newNotes,
          vendor.id,
        ]);

        // history for this vendor row
        const hist = await c.query<{
          event_type: string;
          payload: { before?: { notes?: unknown }; after?: { notes?: unknown } };
        }>(`select event_type, payload from public.entity_history('vendors', $1)`, [
          vendor.id,
        ]);

        const types = hist.rows.map((r) => r.event_type);
        if (!types.includes('inserted')) {
          throw new Error(`expected inserted event in history, got [${types.join(', ')}]`);
        }
        if (!types.includes('updated')) {
          throw new Error(`expected updated event in history, got [${types.join(', ')}]`);
        }

        // The pre-edit value must still appear in history somewhere
        // (either in inserted.after.notes or updated.before.notes).
        const preEditAppears = hist.rows.some((r) => {
          const before = r.payload?.before?.notes;
          const after = r.payload?.after?.notes;
          return before === originalNotes || (r.event_type === 'inserted' && after === originalNotes);
        });
        if (!preEditAppears) {
          throw new Error(`pre-edit notes value (${JSON.stringify(originalNotes)}) not found in history`);
        }
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // DoD #2: events are immutable (UPDATE denied for authenticated users).
  // -----------------------------------------------------------------------
  await check(
    'authenticated user cannot UPDATE events',
    async () => {
      await expectThrows(
        'authenticated UPDATE events',
        async () => {
          await asUserA(async (c) => {
            await c.query(
              `update public.events set payload = '{}'::jsonb where account_id = $1`,
              [ACCOUNT_A],
            );
          });
        },
        [/permission denied/i, /row-level security/i, /must be owner/i],
      );
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // DoD #3: events are undeletable (DELETE denied for authenticated users).
  // -----------------------------------------------------------------------
  await check(
    'authenticated user cannot DELETE events',
    async () => {
      await expectThrows(
        'authenticated DELETE events',
        async () => {
          await asUserA(async (c) => {
            await c.query(`delete from public.events where account_id = $1`, [
              ACCOUNT_A,
            ]);
          });
        },
        [/permission denied/i, /row-level security/i, /must be owner/i],
      );
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // DoD #4: direct DB write (bypassing the API) still produces an event.
  // -----------------------------------------------------------------------
  await check(
    'direct postgres INSERT into a domain table produces an event',
    async () => {
      await asSuper(async (c) => {
        const before = await c.query<{ n: string }>(
          `select count(*)::text as n from public.events
            where account_id = $1 and entity_type = 'properties' and event_type = 'inserted'`,
          [ACCOUNT_A],
        );
        const beforeN = Number(before.rows[0]!.n);

        await c.query(
          `insert into public.properties (account_id, name) values ($1, $2)`,
          [ACCOUNT_A, `bypass-the-api ${Date.now()}`],
        );

        const after = await c.query<{ n: string }>(
          `select count(*)::text as n from public.events
            where account_id = $1 and entity_type = 'properties' and event_type = 'inserted'`,
          [ACCOUNT_A],
        );
        const afterN = Number(after.rows[0]!.n);
        if (afterN !== beforeN + 1) {
          throw new Error(
            `properties inserted-event count did not advance: ${beforeN} -> ${afterN}`,
          );
        }
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // DoD #5: tampered event makes verify_chain fail.
  // -----------------------------------------------------------------------
  await check(
    'verify_chain(A) detects a tampered event',
    async () => {
      await asSuper(async (c) => {
        // Find a tamper target -- pick the second event in chain order so we
        // can later restore and re-check.
        const target = await c.query<{ id: string; payload: unknown }>(
          `select id, payload from public.events
            where account_id = $1
            order by occurred_at asc, id asc
            limit 1 offset 1`,
          [ACCOUNT_A],
        );
        if (target.rowCount !== 1) {
          throw new Error('no second event to tamper with -- seed too small');
        }
        const targetId = target.rows[0]!.id;
        const originalPayload = JSON.stringify(target.rows[0]!.payload);

        // The events table grants are revoked from authenticated/anon/service_role,
        // but the postgres superuser owns the table and can still UPDATE -- which
        // is exactly the threat model the chain is meant to detect.
        await c.query(
          `update public.events set payload = payload || '{"_tampered": true}'::jsonb where id = $1`,
          [targetId],
        );

        const v = await c.query<{ ok: boolean; broken_at: string | null; reason: string | null }>(
          `select ok, broken_at, reason from public.verify_chain($1)`,
          [ACCOUNT_A],
        );
        try {
          if (v.rows[0]!.ok) {
            throw new Error('verify_chain returned ok=true after a payload tampering');
          }
          if (v.rows[0]!.broken_at !== targetId) {
            throw new Error(
              `verify_chain pointed at the wrong row: expected ${targetId}, got ${v.rows[0]!.broken_at}`,
            );
          }
        } finally {
          // Restore so subsequent checks (and an idempotent re-run of this test)
          // don't see broken state.
          await c.query(`update public.events set payload = $2::jsonb where id = $1`, [
            targetId,
            originalPayload,
          ]);
        }

        // After restore, chain should pass again.
        const v2 = await c.query<{ ok: boolean; reason: string | null }>(
          `select ok, reason from public.verify_chain($1)`,
          [ACCOUNT_A],
        );
        if (!v2.rows[0]!.ok) {
          throw new Error(
            `chain still broken after restore: ${v2.rows[0]!.reason} -- the restore did not put the byte-identical jsonb back`,
          );
        }
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // DoD #6 (bonus): soft-delete emits a tombstone 'deleted' event.
  // -----------------------------------------------------------------------
  await check(
    'soft-delete (deleted_at flip) emits a "deleted" tombstone event',
    async () => {
      await asSuper(async (c) => {
        // Insert a throwaway vendor we can soft-delete without disturbing
        // other tests' assumptions.
        const ins = await c.query<{ id: string }>(
          `insert into public.vendors (account_id, name)
            values ($1, $2) returning id`,
          [ACCOUNT_A, `soft-delete target ${Date.now()}`],
        );
        const id = ins.rows[0]!.id;
        await c.query(
          `update public.vendors set deleted_at = now() where id = $1`,
          [id],
        );
        const hist = await c.query<{ event_type: string }>(
          `select event_type from public.entity_history('vendors', $1) order by occurred_at asc`,
          [id],
        );
        const types = hist.rows.map((r) => r.event_type);
        if (!types.includes('deleted')) {
          throw new Error(`expected a "deleted" tombstone in history, got [${types.join(', ')}]`);
        }
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // DoD #7 (bonus): interactions.logged_at is immutable.
  // -----------------------------------------------------------------------
  await check(
    'UPDATE on interactions.logged_at is rejected',
    async () => {
      await asSuper(async (c) => {
        const i = await c.query<{ id: string }>(
          `select id from public.interactions where account_id = $1 limit 1`,
          [ACCOUNT_A],
        );
        if (i.rowCount !== 1) {
          throw new Error('seed had no interactions for A');
        }
        const id = i.rows[0]!.id;
        await expectThrows(
          'UPDATE logged_at',
          async () => {
            await c.query(
              `update public.interactions set logged_at = now() - interval '1 day' where id = $1`,
              [id],
            );
          },
          [/logged_at is immutable/i],
        );
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\n${failures.length} audit DoD failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: audit-spine DoD checks all green');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
