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
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';
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
        // can later restore and re-check. Phase 3.1: order by account_seq,
        // the only valid chain order key.
        const target = await c.query<{ id: string; payload: unknown }>(
          `select id, payload from public.events
            where account_id = $1
            order by account_seq asc
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

  // =======================================================================
  // Phase 3.1 amendments
  // =======================================================================

  // -----------------------------------------------------------------------
  // (A robustness) Pathological payload containing pipes, quotes, and braces
  // must not break the chain. With the pre-3.1 pipe-delimited canonical, a
  // payload like `"foo|bar"` could be confused with the entity_type | entity_id
  // boundary. The jsonb canonical encoding escapes these inside the JSON
  // string and removes the ambiguity.
  // -----------------------------------------------------------------------
  await check(
    'A: payload containing |, ", { does not break the chain',
    async () => {
      const pathological = `"x|y"|{"prev":"forge"}|"||"|}{|"sub":"forge"`;
      await asSuper(async (c) => {
        await c.query(
          `insert into public.vendors (account_id, name, notes) values ($1, $2, $3)`,
          [ACCOUNT_A, `pathological ${Date.now()}`, pathological],
        );
      });
      await asSuper(async (c) => {
        const v = await c.query<{ ok: boolean; reason: string | null }>(
          `select ok, reason from public.verify_chain($1)`,
          [ACCOUNT_A],
        );
        if (!v.rows[0]!.ok) {
          throw new Error(
            `chain broken by pathological payload (delimiter escaping bug): ${v.rows[0]!.reason}`,
          );
        }
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // (C) account_seq is gap-free, starts at 1 per account, and ordering by
  // account_seq matches the count -- proves the seq monotonicity contract.
  // -----------------------------------------------------------------------
  await check(
    'C: account_seq starts at 1 and is gap-free per account',
    async () => {
      await asSuper(async (c) => {
        for (const acc of [ACCOUNT_A, ACCOUNT_B]) {
          const res = await c.query<{ min: string; max: string; n: string }>(
            `select coalesce(min(account_seq), 0)::text as min,
                    coalesce(max(account_seq), 0)::text as max,
                    count(*)::text as n
               from public.events where account_id = $1`,
            [acc],
          );
          const mn = Number(res.rows[0]!.min);
          const mx = Number(res.rows[0]!.max);
          const n = Number(res.rows[0]!.n);
          if (n === 0) throw new Error(`${acc}: no events`);
          if (mn !== 1) throw new Error(`${acc}: account_seq min=${mn}, expected 1`);
          if (mx !== n) throw new Error(`${acc}: account_seq max=${mx} != count=${n} (gap)`);
        }
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // (D) Concurrency: many writers to account A in parallel plus simultaneous
  // writes to account B. After the dust settles:
  //   - verify_chain(A) ok = true
  //   - verify_chain(B) ok = true
  //   - A's account_seq is gap-free and equals A's event count
  //   - B's account_seq is gap-free and equals B's event count
  // This is the keystone path -- the advisory lock is the only thing making
  // the chain correct under load, and we now demonstrate it rather than
  // asserting it.
  // -----------------------------------------------------------------------
  await check(
    'D: concurrent writers (A in parallel, B simultaneous) keep both chains intact',
    async () => {
      const N_A = 25;
      const N_B = 15;

      // Snapshot counts before the storm so we can compare deltas.
      const before = await asSuper(async (c) => {
        const r = await c.query<{ acc: string; n: string }>(
          `select account_id::text as acc, count(*)::text as n
             from public.events
            where account_id in ($1, $2)
            group by account_id`,
          [ACCOUNT_A, ACCOUNT_B],
        );
        const m = new Map<string, number>();
        for (const row of r.rows) m.set(row.acc, Number(row.n));
        return m;
      });

      const writeOne = (acc: string, label: string) =>
        asSuper(async (c) => {
          await c.query(
            `insert into public.vendors (account_id, name) values ($1, $2)`,
            [acc, label],
          );
        });

      // Interleave A and B work in one Promise.all so the runtime really does
      // schedule them concurrently against the same pool.
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < N_A; i++) tasks.push(writeOne(ACCOUNT_A, `concA-${i}-${Date.now()}`));
      for (let i = 0; i < N_B; i++) tasks.push(writeOne(ACCOUNT_B, `concB-${i}-${Date.now()}`));
      await Promise.all(tasks);

      await asSuper(async (c) => {
        for (const [acc, expectedDelta, label] of [
          [ACCOUNT_A, N_A, 'A'] as const,
          [ACCOUNT_B, N_B, 'B'] as const,
        ]) {
          // Chain still valid?
          const v = await c.query<{ ok: boolean; reason: string | null }>(
            `select ok, reason from public.verify_chain($1)`,
            [acc],
          );
          if (!v.rows[0]!.ok) {
            throw new Error(
              `verify_chain(${label}) broken after concurrent writes: ${v.rows[0]!.reason}`,
            );
          }

          // Seq gap-free? max == count?
          const seq = await c.query<{ max: string; n: string }>(
            `select max(account_seq)::text as max, count(*)::text as n
               from public.events where account_id = $1`,
            [acc],
          );
          const mx = Number(seq.rows[0]!.max);
          const n = Number(seq.rows[0]!.n);
          if (mx !== n) {
            throw new Error(
              `${label}: account_seq has gaps after concurrent writes (max=${mx}, count=${n})`,
            );
          }

          // Delta matches the writes we issued? (one event per insert; the
          // inserts on each account that succeeded contribute exactly one
          // 'inserted' event each.)
          const beforeN = before.get(acc) ?? 0;
          const delta = n - beforeN;
          if (delta < expectedDelta) {
            throw new Error(
              `${label}: expected at least ${expectedDelta} new events, got ${delta}`,
            );
          }
        }
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // (F) Clearing deleted_at emits a 'restored' event (not a generic 'updated').
  // -----------------------------------------------------------------------
  await check(
    'F: clearing deleted_at emits a "restored" event type',
    async () => {
      await asSuper(async (c) => {
        const ins = await c.query<{ id: string }>(
          `insert into public.vendors (account_id, name) values ($1, $2) returning id`,
          [ACCOUNT_A, `restore-target ${Date.now()}`],
        );
        const id = ins.rows[0]!.id;
        await c.query(
          `update public.vendors set deleted_at = now() where id = $1`,
          [id],
        );
        await c.query(
          `update public.vendors set deleted_at = null where id = $1`,
          [id],
        );
        const hist = await c.query<{ event_type: string }>(
          `select event_type from public.entity_history('vendors', $1)
            order by occurred_at asc`,
          [id],
        );
        const types = hist.rows.map((r) => r.event_type);
        if (!types.includes('restored')) {
          throw new Error(
            `expected a "restored" event in history, got [${types.join(', ')}]`,
          );
        }
        // And the original "deleted" tombstone must still be present.
        if (!types.includes('deleted')) {
          throw new Error(
            `restore must follow a delete; expected a "deleted" event in history, got [${types.join(', ')}]`,
          );
        }
      });
    },
    failures,
  );

  // =======================================================================
  // Phase 4 amendment: actor integrity (B from review)
  // =======================================================================

  // -----------------------------------------------------------------------
  // (B) An authenticated user cannot forge actor via audit.actor. Even when
  // the user explicitly sets the GUC inside their transaction, the trigger
  // resolves actor from the verified auth.uid() and ignores the GUC.
  //
  // Pre-fix: audit.actor took precedence -> user could attribute writes to
  //          'system', or 'user:<victim>', or 'tenant:<fake-token>'.
  // Post-fix: with auth.uid() set, the GUC is ignored; actor is always
  //           'user:<the JWT sub>'.
  // -----------------------------------------------------------------------
  await check(
    'B: authenticated user cannot forge actor via audit.actor',
    async () => {
      // Run as authenticated user A. Inside the same txn, set audit.actor to
      // a series of would-be spoof values and write a row each time. The
      // trigger fires under the same transaction context and sees auth.uid().
      const spoofs = [
        'user:00000000-0000-0000-0000-000000000000',
        'system',
        'tenant:fake-token-id',
        'other:nobody',
        '',
      ];
      const nameTag = `actor-spoof-${Date.now()}`;
      await asUserA(async (c) => {
        for (const spoof of spoofs) {
          await c.query(`select set_config('audit.actor', $1, true)`, [spoof]);
          await c.query(
            `insert into public.vendors (account_id, name) values ($1, $2)`,
            [ACCOUNT_A, `${nameTag} ${spoof || 'empty'}`],
          );
        }
      });

      // Read back the events the trigger inserted for these vendors. Every
      // actor must be the JWT-derived 'user:<USER_A>'.
      const expected = `user:${USER_A}`;
      await asSuper(async (c) => {
        const r = await c.query<{ actor: string; payload: { after?: { name?: string } } }>(
          `select actor, payload
             from public.events
            where account_id = $1
              and entity_type = 'vendors'
              and event_type = 'inserted'
              and payload -> 'after' ->> 'name' like $2
            order by account_seq asc`,
          [ACCOUNT_A, `${nameTag}%`],
        );
        if (r.rowCount !== spoofs.length) {
          throw new Error(
            `expected ${spoofs.length} spoof-attempt insert events, got ${r.rowCount}`,
          );
        }
        for (const row of r.rows) {
          if (row.actor !== expected) {
            throw new Error(
              `actor spoofed: expected ${expected}, got ${row.actor} (row name: ${row.payload?.after?.name})`,
            );
          }
        }
      });
    },
    failures,
  );

  // -----------------------------------------------------------------------
  // Phase 3 (ADR-0002): chain watermark + incremental verification.
  // The sweep is O(new events); tamper AFTER the watermark is caught
  // immediately; tamper BEHIND it is caught by the bounded 24h full pass.
  // -----------------------------------------------------------------------

  await check(
    'watermark: genesis walk verifies all events, resumed walk checks zero',
    async () => {
      await asSuper(async (c) => {
        await c.query(`delete from public.chain_watermarks where account_id = $1`, [ACCOUNT_A]);
        const t0 = Date.now();
        const r1 = await c.query(`select * from public.verify_chain_incremental($1)`, [ACCOUNT_A]);
        const fullMs = Date.now() - t0;
        if (r1.rows[0]!.ok !== true) throw new Error(`genesis walk broken: ${r1.rows[0]!.reason}`);
        const total = Number(r1.rows[0]!.events_checked);
        if (total < 1) throw new Error('genesis walk checked zero events on seeded data');
        const t1 = Date.now();
        const r2 = await c.query(`select * from public.verify_chain_incremental($1)`, [ACCOUNT_A]);
        const incMs = Date.now() - t1;
        if (r2.rows[0]!.ok !== true) throw new Error(`resumed walk broken: ${r2.rows[0]!.reason}`);
        if (Number(r2.rows[0]!.events_checked) !== 0) {
          throw new Error(`resumed walk re-checked ${r2.rows[0]!.events_checked} events; expected 0`);
        }
        console.info(`        (full walk ${total} events: ${fullMs}ms; resumed: ${incMs}ms)`);
        const wm = await c.query(
          `select last_verified_seq::text as seq from public.chain_watermarks where account_id = $1`,
          [ACCOUNT_A],
        );
        if (Number(wm.rows[0]?.seq) !== total) {
          throw new Error(`watermark seq ${wm.rows[0]?.seq} != events checked ${total}`);
        }
      });
    },
    failures,
  );

  await check(
    'watermark: tamper AFTER the watermark is caught immediately by the incremental walk',
    async () => {
      await asSuper(async (c) => {
        // Append a fresh event: a direct UPDATE on a domain row fires the
        // audit trigger (the DoD #3 property), landing one event past the
        // watermark the previous check just advanced.
        await c.query(
          `update public.properties set name = name || '' where account_id = $1
             and id = (select id from public.properties where account_id = $1 limit 1)`,
          [ACCOUNT_A],
        );
        const newest = await c.query<{ id: string; payload: string }>(
          `select id, payload::text as payload from public.events
            where account_id = $1 order by account_seq desc limit 1`,
          [ACCOUNT_A],
        );
        const target = newest.rows[0]!;
        try {
          await c.query(
            `update public.events set payload = payload || '{"_wm_tamper": true}'::jsonb where id = $1`,
            [target.id],
          );
          const v = await c.query(`select * from public.verify_chain_incremental($1)`, [ACCOUNT_A]);
          if (v.rows[0]!.ok !== false) {
            throw new Error('incremental walk returned ok=true over a tampered post-watermark event');
          }
          if (v.rows[0]!.broken_at !== target.id) {
            throw new Error(`broken_at ${v.rows[0]!.broken_at} != tampered ${target.id}`);
          }
        } finally {
          // Restore byte-identical payload even on assertion failure -- a
          // leaked tamper poisons every later chain check.
          await c.query(`update public.events set payload = $2::jsonb where id = $1`, [
            target.id,
            target.payload,
          ]);
        }
        const v2 = await c.query(`select * from public.verify_chain_incremental($1)`, [ACCOUNT_A]);
        if (v2.rows[0]!.ok !== true) {
          throw new Error(`chain still broken after restore: ${v2.rows[0]!.reason}`);
        }
      });
    },
    failures,
  );

  await check(
    'watermark: tamper BEHIND the watermark passes incrementally (bounded window) and is caught by the 24h full pass',
    async () => {
      await asSuper(async (c) => {
        // Watermark is fresh and at the chain head (previous check).
        const early = await c.query<{ id: string; payload: string }>(
          `select id, payload::text as payload from public.events
            where account_id = $1 and account_seq = 2`,
          [ACCOUNT_A],
        );
        const target = early.rows[0]!;
        try {
          await c.query(
            `update public.events set payload = payload || '{"_wm_tamper": true}'::jsonb where id = $1`,
            [target.id],
          );
          // The documented detection window: incremental does NOT see it.
          const vi = await c.query(`select * from public.verify_chain_incremental($1)`, [ACCOUNT_A]);
          if (vi.rows[0]!.ok !== true) {
            throw new Error('expected the incremental walk to pass (behind-watermark window)');
          }
          // Healing cadence: a stale last_full_at forces the sweep onto the
          // full path, which catches the tamper and raises the alert.
          await c.query(
            `update public.chain_watermarks set last_full_at = now() - interval '25 hours'
              where account_id = $1`,
            [ACCOUNT_A],
          );
          const s = await c.query(`select * from public.verify_chain_sweep($1)`, [ACCOUNT_A]);
          if (s.rows[0]!.ok !== false) {
            throw new Error('stale-full sweep returned ok=true over a behind-watermark tamper');
          }
          // Rerun-safe assertion: on a persistent dev DB the alert row may
          // already exist from a prior run (then re-detection REOPENS it
          // rather than inserting). Either way an OPEN alert must now exist.
          const open = await c.query(
            `select 1 from public.chain_verification_alerts
              where account_id = $1 and resolved_at is null`,
            [ACCOUNT_A],
          );
          if (open.rowCount === 0) {
            throw new Error('sweep did not leave an OPEN chain_verification_alert');
          }
        } finally {
          // Restore even on assertion failure -- a leaked tamper poisons
          // every later chain check (and reruns on a persistent dev DB).
          await c.query(`update public.events set payload = $2::jsonb where id = $1`, [
            target.id,
            target.payload,
          ]);
        }
        // The (still stale) sweep runs full again, passes, and resolves.
        const s2 = await c.query(`select * from public.verify_chain_sweep($1)`, [ACCOUNT_A]);
        if (s2.rows[0]!.ok !== true) throw new Error('sweep still broken after restore');
        if (Number(s2.rows[0]!.alerts_resolved) < 1) {
          throw new Error('sweep did not resolve the alert after the restore');
        }
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
