import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type pg from 'pg';

function migration(name: string): string {
  return readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
}

export async function checkLegacyBillingBackfill(client: pg.Client): Promise<void> {
  const foundation = migration('20261023000008_billing_period_foundation');
  const update = foundation.match(/update public\.charges set cycle_key[\s\S]*?;/)?.[0];
  const cycleIndex = foundation.match(/create unique index charges_one_per_schedule_cycle[\s\S]*?;/)?.[0];
  const periodIndex = migration('20260605000010_phase9_cron_intake_heic')
    .match(/create unique index charges_one_per_schedule_period[\s\S]*?;/)?.[0];
  const periodCheck = migration('20260718000001_money_semantics')
    .match(/alter table public\.charges\s+add constraint charges_period_pair_check[\s\S]*?;/)?.[0];
  assert.ok(update && cycleIndex && periodIndex && periodCheck, 'migration statements must exist');
  const onClone = (sql: string): string => sql.replaceAll('public.charges', 'legacy_billing_charges');

  await client.query('begin');
  try {
    // Clone columns without today's checks so the fixture can model rows predating NOT VALID.
    await client.query(`create temporary table legacy_billing_charges on commit drop as
      select * from public.charges with no data`);
    await client.query(`insert into legacy_billing_charges
      (id,source_schedule_id,period_start,period_end,amount_cents,due_date,voided_at)
      values
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','2020-01-01',null,12345,'2020-01-01',null),
      ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000010','2020-02-01','2020-01-31',23456,'2020-02-01',now()),
      ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000010','2020-03-01','2020-03-31',34567,'2020-03-01',null),
      ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000010',null,'2020-04-30',45678,'2020-04-01',null)`);
    await client.query(onClone(periodCheck));
    await client.query(onClone(periodIndex));
    await client.query('savepoint legacy_update');
    await assert.rejects(client.query(`update legacy_billing_charges
      set cycle_key='legacy:'||period_start::text
      where source_schedule_id is not null and period_start is not null`),
    (error: unknown) => (error as { constraint?: string }).constraint === 'charges_period_pair_check');
    await client.query('rollback to savepoint legacy_update');
    const before = (await client.query('select * from legacy_billing_charges order by id')).rows;
    await client.query(onClone(update));
    await client.query(onClone(cycleIndex));
    const after = (await client.query('select * from legacy_billing_charges order by id')).rows;
    assert.deepEqual(after, before.map((row, index) => ({
      ...row, cycle_key: index === 2 ? 'legacy:2020-03-01' : null,
    })), 'backfill must preserve every historical fact, including voided and invalid periods');

    // The generator's untargeted ON CONFLICT must still honor the original period index.
    for (const month of ['01', '02']) {
      const duplicate = await client.query(`insert into legacy_billing_charges
        (id,source_schedule_id,period_start,period_end,amount_cents,due_date,cycle_key)
        values(gen_random_uuid(),'00000000-0000-0000-0000-000000000010',
          $1::date,($1::date+interval '1 month'-interval '1 day')::date,99999,$1::date,'legacy:'||$1)
        on conflict do nothing returning id`, [`2020-${month}-01`]);
      assert.equal(duplicate.rowCount, 0, 'legacy NULL cycle key must not free an occupied or voided slot');
    }
    const next = await client.query(`insert into legacy_billing_charges
      (id,source_schedule_id,period_start,period_end,amount_cents,due_date,cycle_key)
      values(gen_random_uuid(),'00000000-0000-0000-0000-000000000010',
        '2020-05-01','2020-05-31',99999,'2020-05-01','legacy:2020-05-01')
      on conflict do nothing returning id`);
    assert.equal(next.rowCount, 1, 'an unoccupied next cycle must remain insertable');
    await client.query('savepoint invalid_new_period');
    await assert.rejects(client.query(`insert into legacy_billing_charges(period_start)
      values('2020-06-01')`), (error: unknown) =>
      (error as { constraint?: string }).constraint === 'charges_period_pair_check');
    await client.query('rollback to savepoint invalid_new_period');
  } finally {
    await client.query('rollback');
  }
}
