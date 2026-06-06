// ----------------------------------------------------------------------------
// Phase 6 money-spine DoD tests (DB-level).
//
// All assertions exercise the rent subledger's INVARIANTS directly against
// the SQL, not via the HTTP layer. The HTTP layer tests live in
// api/test/api-isolation.test.ts; here we prove the DB itself refuses bad
// states the route handlers would otherwise have to police.
//
// Coverage:
//   1. Derived balance: a $700 payment + allocation on a $1,200 rent
//      charge yields a charge.amount - allocs = $500 balance, and the
//      charge row itself is byte-identical to before the payment
//      (NO mutation -- the contract).
//
//   2. Reversal-not-mutation: void the payment. The original payment row
//      stays visible (voided_at set, no rewriting); the derived balance
//      recomputes to $1,200 (the voided payment's allocation no longer
//      counts).
//
//   3. Allocation integrity at the DB:
//        (a) cross-tenancy: payment in tenancy T1, charge in tenancy T2,
//            allocation between them. Trigger rejects.
//        (b) cross-account: same shape but across accounts.
//        (c) over-allocation per charge: $1,200 charge, two allocations
//            of $700 each -- second rejected (sum 1400 > 1200).
//        (d) over-allocation per payment: $700 payment, allocations of
//            $400 + $400 -- second rejected.
//        (e) currency mismatch.
//
//   4. Concurrency: two writers race to over-allocate the same charge.
//      With the per-charge advisory lock + sum-after-write check, exactly
//      one wins; the other gets a clean rejection. No over-allocation.
//
//   5. Deposit segregation: a charge with type='deposit' does NOT count
//      against the rent_balance computation (we replicate the ledger's
//      computation here as the contract under test).
//
// Setup: spins up the same ephemeral postgres run-isolation.sh already
// uses (Phase 2 + 3 + 3.1 + 4 + 5 + 6 migrations), seeds the two-account
// fixture, then drives the assertions as the postgres superuser (which is
// allowed to write directly -- we're testing the DB invariants, not RLS
// here; RLS is the Phase 2 job).
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

interface Fixture {
  tenancyA: string;
  tenancyB: string;
}

async function loadFixture(): Promise<Fixture> {
  return withClient(async (c) => {
    const a = await c.query<{ id: string }>(
      `select id from public.tenancies where account_id = $1 limit 1`,
      [ACCOUNT_A],
    );
    const b = await c.query<{ id: string }>(
      `select id from public.tenancies where account_id = $1 limit 1`,
      [ACCOUNT_B],
    );
    if (!a.rows[0] || !b.rows[0]) {
      throw new Error('seed did not provide a tenancy for each account');
    }
    return { tenancyA: a.rows[0].id, tenancyB: b.rows[0].id };
  });
}

async function chargeRowFingerprint(c: pg.Client, chargeId: string): Promise<string> {
  const r = await c.query<{ json: string }>(
    `select to_jsonb(charges) #- '{updated_at}' as json from public.charges where id = $1`,
    [chargeId],
  );
  if (r.rowCount !== 1) throw new Error('charge row vanished');
  // updated_at is excluded above; the rest should be byte-identical
  // before/after a payment+allocation (we never UPDATE a charge here).
  return JSON.stringify(r.rows[0]!.json);
}

async function chargeBalance(c: pg.Client, chargeId: string): Promise<number> {
  const r = await c.query<{ amount_cents: string; allocated: string }>(
    `select c.amount_cents::text,
            coalesce((
              select sum(a.amount_cents)
              from public.payment_allocations a
              join public.payments p on p.id = a.payment_id
              where a.charge_id = c.id
                and a.deleted_at is null
                and p.voided_at is null
            ), 0)::text as allocated
       from public.charges c
       where c.id = $1`,
    [chargeId],
  );
  if (r.rowCount !== 1) throw new Error('charge row vanished');
  return Number(r.rows[0]!.amount_cents) - Number(r.rows[0]!.allocated);
}

async function main(): Promise<void> {
  const { tenancyA, tenancyB } = await loadFixture();
  console.info(`Phase 6 money-spine DoD checks`);

  // -----------------------------------------------------------------------
  // (1) Derived balance: $700 payment on $1,200 rent charge -> $500 balance,
  //     charge unmodified.
  // -----------------------------------------------------------------------
  await check('balance derived: $700 / $1200 rent -> $500; charge byte-identical', async () => {
    await withClient(async (c) => {
      const charge = await c.query<{ id: string }>(
        `insert into public.charges
           (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', 120000, 'USD', '2026-02-01')
         returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const chargeId = charge.rows[0]!.id;
      const before = await chargeRowFingerprint(c, chargeId);

      const payment = await c.query<{ id: string }>(
        `insert into public.payments
           (account_id, tenancy_id, amount_cents, currency, received_at, method)
         values ($1, $2, 70000, 'USD', '2026-02-03T12:00:00Z', 'check')
         returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const paymentId = payment.rows[0]!.id;
      await c.query(
        `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
         values ($1, $2, $3, 70000)`,
        [ACCOUNT_A, paymentId, chargeId],
      );

      const balance = await chargeBalance(c, chargeId);
      if (balance !== 50000) {
        throw new Error(`expected balance 50000, got ${balance}`);
      }
      const after = await chargeRowFingerprint(c, chargeId);
      if (before !== after) {
        throw new Error(`charge row mutated by the payment+allocation`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // (2) Reversal-not-mutation: void the payment. Original stays visible;
  //     allocation row stays too; the derived balance recomputes.
  // -----------------------------------------------------------------------
  await check('reversal: voiding a payment leaves original visible, balance recomputes', async () => {
    await withClient(async (c) => {
      const charge = await c.query<{ id: string }>(
        `insert into public.charges
           (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', 100000, 'USD', '2026-03-01')
         returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const chargeId = charge.rows[0]!.id;

      const payment = await c.query<{ id: string }>(
        `insert into public.payments
           (account_id, tenancy_id, amount_cents, currency, received_at, method)
         values ($1, $2, 100000, 'USD', '2026-03-03T12:00:00Z', 'check')
         returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const paymentId = payment.rows[0]!.id;
      await c.query(
        `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
         values ($1, $2, $3, 100000)`,
        [ACCOUNT_A, paymentId, chargeId],
      );

      if ((await chargeBalance(c, chargeId)) !== 0) {
        throw new Error('expected balance 0 before void');
      }

      // Void the payment.
      await c.query(
        `update public.payments set voided_at = now(), void_reason = 'bounced' where id = $1`,
        [paymentId],
      );

      // Original payment row still visible.
      const pr = await c.query<{ id: string; voided_at: string | null }>(
        `select id, voided_at from public.payments where id = $1`,
        [paymentId],
      );
      if (pr.rowCount !== 1) throw new Error('voided payment row missing');
      if (!pr.rows[0]!.voided_at) throw new Error('voided_at not set');

      // Allocation row still visible (we did NOT delete it).
      const ar = await c.query<{ n: string }>(
        `select count(*)::text as n from public.payment_allocations where payment_id = $1`,
        [paymentId],
      );
      if (Number(ar.rows[0]!.n) !== 1) {
        throw new Error(`allocation row should still exist; got ${ar.rows[0]!.n}`);
      }

      // Balance recomputes to amount_cents (allocation discounted by void).
      const bal = await chargeBalance(c, chargeId);
      if (bal !== 100000) {
        throw new Error(`expected balance 100000 after void, got ${bal}`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // (3) Allocation integrity at the DB.
  // -----------------------------------------------------------------------
  await check('integrity: cross-tenancy allocation rejected', async () => {
    await withClient(async (c) => {
      // A charge in tenancyA (this one will NOT be the allocation target;
      // we create it just to keep the fixture realistic).
      await c.query(
        `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', 50000, 'USD', '2026-04-01')`,
        [ACCOUNT_A, tenancyA],
      );
      const pay = await c.query<{ id: string }>(
        `insert into public.payments (account_id, tenancy_id, amount_cents, currency, received_at, method)
         values ($1, $2, 50000, 'USD', '2026-04-02T00:00:00Z', 'cash') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      // ACCOUNT_A still, but we need another tenancy in A. Create one.
      const other = await c.query<{ id: string }>(
        `insert into public.tenancies (account_id, area_id, start_date, status)
         select $1, area_id, '2026-01-01', 'active' from public.tenancies where id = $2
         returning id`,
        [ACCOUNT_A, tenancyA],
      );
      // Charge in the OTHER tenancy.
      const otherCh = await c.query<{ id: string }>(
        `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', 50000, 'USD', '2026-04-01') returning id`,
        [ACCOUNT_A, other.rows[0]!.id],
      );
      // Try to allocate the payment (tenancyA) to the OTHER tenancy's charge.
      let threw = false;
      try {
        await c.query(
          `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
           values ($1, $2, $3, 50000)`,
          [ACCOUNT_A, pay.rows[0]!.id, otherCh.rows[0]!.id],
        );
      } catch (e) {
        threw = /cross-tenancy/i.test((e as Error).message);
      }
      if (!threw) throw new Error('expected cross-tenancy rejection');
    });
  });

  await check('integrity: cross-account allocation rejected', async () => {
    await withClient(async (c) => {
      const payA = await c.query<{ id: string }>(
        `insert into public.payments (account_id, tenancy_id, amount_cents, currency, received_at, method)
         values ($1, $2, 50000, 'USD', '2026-04-02T00:00:00Z', 'cash') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const chB = await c.query<{ id: string }>(
        `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', 50000, 'USD', '2026-04-01') returning id`,
        [ACCOUNT_B, tenancyB],
      );
      // Try allocation with account_id = A but charge in account B.
      let threw = false;
      try {
        await c.query(
          `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
           values ($1, $2, $3, 50000)`,
          [ACCOUNT_A, payA.rows[0]!.id, chB.rows[0]!.id],
        );
      } catch (e) {
        threw = /account mismatch|cross-tenancy|foreign key/i.test((e as Error).message);
      }
      if (!threw) throw new Error('expected cross-account rejection');
    });
  });

  await check('integrity: per-charge over-allocation rejected', async () => {
    await withClient(async (c) => {
      const ch = await c.query<{ id: string }>(
        `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', 120000, 'USD', '2026-05-01') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const p1 = await c.query<{ id: string }>(
        `insert into public.payments (account_id, tenancy_id, amount_cents, currency, received_at, method)
         values ($1, $2, 70000, 'USD', '2026-05-02T00:00:00Z', 'cash') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const p2 = await c.query<{ id: string }>(
        `insert into public.payments (account_id, tenancy_id, amount_cents, currency, received_at, method)
         values ($1, $2, 70000, 'USD', '2026-05-03T00:00:00Z', 'cash') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      await c.query(
        `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
         values ($1, $2, $3, 70000)`,
        [ACCOUNT_A, p1.rows[0]!.id, ch.rows[0]!.id],
      );
      let threw = false;
      try {
        await c.query(
          `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
           values ($1, $2, $3, 70000)`,
          [ACCOUNT_A, p2.rows[0]!.id, ch.rows[0]!.id],
        );
      } catch (e) {
        threw = /exceed charge amount/i.test((e as Error).message);
      }
      if (!threw) throw new Error('expected over-allocation rejection');
    });
  });

  await check('integrity: per-payment over-allocation rejected', async () => {
    await withClient(async (c) => {
      const ch1 = await c.query<{ id: string }>(
        `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', 50000, 'USD', '2026-06-01') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const ch2 = await c.query<{ id: string }>(
        `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', 50000, 'USD', '2026-07-01') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const p = await c.query<{ id: string }>(
        `insert into public.payments (account_id, tenancy_id, amount_cents, currency, received_at, method)
         values ($1, $2, 50000, 'USD', '2026-06-02T00:00:00Z', 'cash') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      await c.query(
        `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
         values ($1, $2, $3, 40000)`,
        [ACCOUNT_A, p.rows[0]!.id, ch1.rows[0]!.id],
      );
      let threw = false;
      try {
        await c.query(
          `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
           values ($1, $2, $3, 40000)`,
          [ACCOUNT_A, p.rows[0]!.id, ch2.rows[0]!.id],
        );
      } catch (e) {
        threw = /exceed payment amount/i.test((e as Error).message);
      }
      if (!threw) throw new Error('expected over-allocation rejection');
    });
  });

  await check('integrity: currency mismatch rejected', async () => {
    await withClient(async (c) => {
      const ch = await c.query<{ id: string }>(
        `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', 50000, 'USD', '2026-08-01') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      const p = await c.query<{ id: string }>(
        `insert into public.payments (account_id, tenancy_id, amount_cents, currency, received_at, method)
         values ($1, $2, 50000, 'EUR', '2026-08-02T00:00:00Z', 'cash') returning id`,
        [ACCOUNT_A, tenancyA],
      );
      let threw = false;
      try {
        await c.query(
          `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
           values ($1, $2, $3, 50000)`,
          [ACCOUNT_A, p.rows[0]!.id, ch.rows[0]!.id],
        );
      } catch (e) {
        threw = /currency mismatch/i.test((e as Error).message);
      }
      if (!threw) throw new Error('expected currency-mismatch rejection');
    });
  });

  // -----------------------------------------------------------------------
  // (4) Concurrency: N parallel allocations against the same charge. The
  //     per-charge advisory lock should serialize them; total allocation
  //     must not exceed the charge amount.
  // -----------------------------------------------------------------------
  await check('concurrency: parallel allocations cannot over-allocate same charge', async () => {
    const N = 20;          // writers
    const chargeAmount = 50000;
    const allocEach    = 10000;
    // Setup: one charge and N tiny payments. The cap is 5 successful allocs.
    let chargeId = '';
    const paymentIds: string[] = [];
    await withClient(async (c) => {
      const ch = await c.query<{ id: string }>(
        `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'rent', $3, 'USD', '2026-09-01') returning id`,
        [ACCOUNT_A, tenancyA, chargeAmount],
      );
      chargeId = ch.rows[0]!.id;
      for (let i = 0; i < N; i++) {
        const p = await c.query<{ id: string }>(
          `insert into public.payments (account_id, tenancy_id, amount_cents, currency, received_at, method)
           values ($1, $2, $3, 'USD', '2026-09-02T00:00:00Z', 'cash') returning id`,
          [ACCOUNT_A, tenancyA, allocEach],
        );
        paymentIds.push(p.rows[0]!.id);
      }
    });

    const tasks = paymentIds.map((pid) =>
      withClient(async (c) => {
        try {
          await c.query(
            `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
             values ($1, $2, $3, $4)`,
            [ACCOUNT_A, pid, chargeId, allocEach],
          );
          return 'ok';
        } catch (e) {
          if (/exceed charge amount/i.test((e as Error).message)) return 'rejected';
          throw e;
        }
      }),
    );
    const results = await Promise.all(tasks);
    const ok = results.filter((r) => r === 'ok').length;
    const rejected = results.filter((r) => r === 'rejected').length;
    if (ok + rejected !== N) {
      throw new Error(`unexpected results: ${JSON.stringify(results)}`);
    }
    const expectedMax = chargeAmount / allocEach; // 5
    if (ok > expectedMax) {
      throw new Error(`too many succeeded: ${ok} (max ${expectedMax})`);
    }
    if (ok === 0) {
      throw new Error('no allocations succeeded at all');
    }

    // Total allocated must not exceed charge amount.
    await withClient(async (c) => {
      const sum = await c.query<{ total: string }>(
        `select coalesce(sum(amount_cents),0)::text as total
           from public.payment_allocations where charge_id = $1`,
        [chargeId],
      );
      const total = Number(sum.rows[0]!.total);
      if (total > chargeAmount) {
        throw new Error(`over-allocated: ${total} > ${chargeAmount}`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // (4.5) Atomicity: a payment created via create_payment_with_allocations
  //       with a BAD allocation rolls back the ENTIRE function. No phantom
  //       payment row. This is the Phase 6.1 fix.
  // -----------------------------------------------------------------------
  await check(
    'atomicity: rejected inline allocation rolls back the payment (no phantom row)',
    async () => {
      // Make ONE valid charge in tenancyA and ONE in tenancyB. Then try to
      // call the RPC for a payment in tenancyA whose allocations[] mixes a
      // valid charge in A with an INVALID charge in B (cross-tenancy). The
      // function should reject the whole thing -- no payment row left
      // behind.
      let chargeA = '';
      let chargeB = '';
      await withClient(async (c) => {
        const a = await c.query<{ id: string }>(
          `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
           values ($1, $2, 'rent', 50000, 'USD', '2026-10-01') returning id`,
          [ACCOUNT_A, tenancyA],
        );
        chargeA = a.rows[0]!.id;
        const b = await c.query<{ id: string }>(
          `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
           values ($1, $2, 'rent', 50000, 'USD', '2026-10-01') returning id`,
          [ACCOUNT_B, tenancyB],
        );
        chargeB = b.rows[0]!.id;
      });

      // Snapshot the payment count before the attempt.
      const before = await withClient(async (c) => {
        const r = await c.query<{ n: string }>(
          `select count(*)::text as n from public.payments where account_id = $1`,
          [ACCOUNT_A],
        );
        return Number(r.rows[0]!.n);
      });

      // Run the RPC as a superuser session. The function checks
      // is_account_member(...) via auth.uid(); to bypass that for this
      // direct-DB test we set the JWT claim manually before calling.
      let threw = false;
      let errMessage = '';
      try {
        await withClient(async (c) => {
          // Pretend to be a user-of-account-A by setting the JWT sub claim
          // to USER_A_ID. The seed inserted that user as a member of A.
          // set_config(..., true) is local to the current transaction, so
          // we need to BEGIN before setting it and COMMIT after the RPC
          // call -- otherwise each c.query runs in its own auto-commit and
          // the setting is lost between queries.
          await c.query('begin');
          await c.query(
            `select set_config('request.jwt.claims', $1, true)`,
            [JSON.stringify({ sub: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'authenticated' })],
          );
          await c.query(
            `select * from public.create_payment_with_allocations(
              $1::uuid, $2::uuid, $3::bigint, $4::text, $5::timestamptz, $6::text,
              $7::text, $8::uuid, $9::text, $10::jsonb)`,
            [
              ACCOUNT_A,
              tenancyA,
              100000,
              'USD',
              '2026-10-02T00:00:00Z',
              'cash',
              null,
              null,
              null,
              JSON.stringify([
                { charge_id: chargeA, amount_cents: 50000 },
                { charge_id: chargeB, amount_cents: 50000 }, // cross-tenancy -- rejected
              ]),
            ],
          );
          await c.query('commit');
        });
      } catch (e) {
        threw = true;
        errMessage = (e as Error).message;
      }
      if (!threw) {
        throw new Error('expected the RPC to reject; it did not');
      }
      if (!/cross-tenancy|account mismatch/i.test(errMessage)) {
        throw new Error(`unexpected error: ${errMessage}`);
      }

      // Count payments in A again. Must be unchanged.
      const after = await withClient(async (c) => {
        const r = await c.query<{ n: string }>(
          `select count(*)::text as n from public.payments where account_id = $1`,
          [ACCOUNT_A],
        );
        return Number(r.rows[0]!.n);
      });
      if (after !== before) {
        throw new Error(
          `payment count changed: ${before} -> ${after} (phantom row written by failed RPC)`,
        );
      }
    },
  );

  // -----------------------------------------------------------------------
  // (5) Deposit segregation: deposit charges don't show up in rent_balance.
  // -----------------------------------------------------------------------
  await check('deposits are NOT counted toward the rent balance', async () => {
    // Create a fresh tenancy for this test so prior tests don't contaminate
    // the totals.
    let tenancyId = '';
    await withClient(async (c) => {
      const t = await c.query<{ id: string }>(
        `insert into public.tenancies (account_id, area_id, start_date, status)
         select $1, area_id, '2026-01-01', 'active' from public.tenancies where id = $2
         returning id`,
        [ACCOUNT_A, tenancyA],
      );
      tenancyId = t.rows[0]!.id;
      await c.query(
        `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
         values ($1, $2, 'deposit', 100000, 'USD', '2026-01-01'),
                ($1, $2, 'rent',    120000, 'USD', '2026-02-01')`,
        [ACCOUNT_A, tenancyId],
      );

      // Compute the deposit-split totals the way the ledger route does.
      const r = await c.query<{
        rent_total: string;
        deposit_total: string;
      }>(
        `select coalesce(sum(amount_cents) filter (where type <> 'deposit'),0)::text as rent_total,
                coalesce(sum(amount_cents) filter (where type =  'deposit'),0)::text as deposit_total
           from public.charges
           where account_id = $1 and tenancy_id = $2 and deleted_at is null and voided_at is null`,
        [ACCOUNT_A, tenancyId],
      );
      if (Number(r.rows[0]!.rent_total) !== 120000) {
        throw new Error(`rent_total expected 120000, got ${r.rows[0]!.rent_total}`);
      }
      if (Number(r.rows[0]!.deposit_total) !== 100000) {
        throw new Error(`deposit_total expected 100000, got ${r.rows[0]!.deposit_total}`);
      }
    });
  });

  // -----------------------------------------------------------------------
  // (6) Ledger unapplied-credit: a payment whose charge was later voided is
  //     real money still owed back. The ledger surfaces it as
  //     unapplied_credit_cents = sum(non-voided payments) - sum(allocations
  //     on non-voided charges where the payment is also non-voided). This
  //     test replicates the SAME computation directly in SQL so the API
  //     handler's derivation can be cross-checked at the data layer.
  // -----------------------------------------------------------------------
  await check(
    'ledger unapplied credit: void-after-allocation surfaces as credit owed',
    async () => {
      let tenancyId = '';
      await withClient(async (c) => {
        const t = await c.query<{ id: string }>(
          `insert into public.tenancies (account_id, area_id, start_date, status)
           select $1, area_id, '2026-01-01', 'active' from public.tenancies where id = $2
           returning id`,
          [ACCOUNT_A, tenancyA],
        );
        tenancyId = t.rows[0]!.id;

        // $1000 rent charge, $1000 payment, fully allocated.
        const ch = await c.query<{ id: string }>(
          `insert into public.charges (account_id, tenancy_id, type, amount_cents, currency, due_date)
           values ($1, $2, 'rent', 100000, 'USD', '2026-11-01') returning id`,
          [ACCOUNT_A, tenancyId],
        );
        const chargeId = ch.rows[0]!.id;
        const p = await c.query<{ id: string }>(
          `insert into public.payments (account_id, tenancy_id, amount_cents, currency, received_at, method)
           values ($1, $2, 100000, 'USD', '2026-11-03T00:00:00Z', 'check') returning id`,
          [ACCOUNT_A, tenancyId],
        );
        const paymentId = p.rows[0]!.id;
        await c.query(
          `insert into public.payment_allocations (account_id, payment_id, charge_id, amount_cents)
           values ($1, $2, $3, 100000)`,
          [ACCOUNT_A, paymentId, chargeId],
        );

        // Pre-void: nothing unapplied (the payment is fully allocated to a
        // live charge).
        const pre = await c.query<{ credit: string }>(
          `select
             coalesce(sum(p.amount_cents) filter (where p.voided_at is null), 0)
             -
             coalesce(sum(a.amount_cents) filter (
               where p.voided_at is null
                 and exists (
                   select 1 from public.charges c
                    where c.id = a.charge_id and c.voided_at is null
                 )
             ), 0)
             as credit
             from public.payments p
             left join public.payment_allocations a on a.payment_id = p.id
            where p.account_id = $1 and p.tenancy_id = $2 and p.deleted_at is null`,
          [ACCOUNT_A, tenancyId],
        );
        if (Number(pre.rows[0]!.credit) !== 0) {
          throw new Error(`pre-void unapplied credit expected 0, got ${pre.rows[0]!.credit}`);
        }

        // Void the charge. The payment stays. The allocation row stays.
        // Ledger derivation says: payment counts toward total_received,
        // allocation does NOT count toward total_allocated (charge voided),
        // so unapplied_credit = 100000.
        await c.query(
          `update public.charges set voided_at = now(), void_reason = 'mistake' where id = $1`,
          [chargeId],
        );

        const post = await c.query<{ credit: string }>(
          `select
             coalesce(sum(p.amount_cents) filter (where p.voided_at is null), 0)
             -
             coalesce(sum(a.amount_cents) filter (
               where p.voided_at is null
                 and exists (
                   select 1 from public.charges c
                    where c.id = a.charge_id and c.voided_at is null
                 )
             ), 0)
             as credit
             from public.payments p
             left join public.payment_allocations a on a.payment_id = p.id
            where p.account_id = $1 and p.tenancy_id = $2 and p.deleted_at is null`,
          [ACCOUNT_A, tenancyId],
        );
        if (Number(post.rows[0]!.credit) !== 100000) {
          throw new Error(
            `post-void unapplied credit expected 100000, got ${post.rows[0]!.credit}`,
          );
        }
      });
    },
  );

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\n${failures.length} money-spine failure(s):`);
    for (const f of failures) console.error(`  ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.info('\nOK: money-spine DoD checks all green');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
