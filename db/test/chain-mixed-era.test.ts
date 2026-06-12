// ----------------------------------------------------------------------------
// Mixed-era chain verification (agent-api plan §2.4; ADR-0008).
//
// The capacity migration (20260616000001) adds authorship columns to
// interactions. ADR-0008's claim: because the chain hashes row SNAPSHOTS
// (the trigger stores to_jsonb(NEW) at write time, and verify_chain
// re-hashes the STORED payload), pre-migration events verify forever and
// post-migration events carry the capacity fields tamper-evidently — with
// zero version dispatch. This test is the proof, and the merge gate for the
// migration.
//
// Construction: a fresh account, then events inserted in three eras:
//
//   era 1  (real)      accounts INSERT via the trigger — the genesis link.
//   era 2  (fixture)   synthetic "pre-capacity" interactions events,
//                      inserted directly as the table owner with payload
//                      snapshots that LACK the capacity keys — byte-
//                      identical to events a real pre-migration deployment
//                      carries — hashed with the same canonical the trigger
//                      uses, chaining from era 1.
//   era 3  (real)      a live interactions INSERT through the trigger; its
//                      snapshot includes the capacity fields.
//
// Checks:
//   1. fixture authenticity: era-2 payloads lack the new keys; era-3
//      payload has them (guards against a vacuously-passing fixture).
//   2. verify_chain(account) = ok over the mixed chain.
//   3. tampering an era-3 CAPACITY field (author_type) breaks verification
//      at that row; byte-exact restore heals it.
//   4. tampering an era-2 (pre-capacity) payload breaks verification —
//      the fixture rows are genuinely protected, not just present.
// ----------------------------------------------------------------------------

import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL must be set');
  process.exit(2);
}

interface Failure {
  name: string;
  detail: string;
}

async function check(name: string, fn: () => Promise<void>, failures: Failure[]): Promise<void> {
  try {
    await fn();
    console.info(`  PASS  ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}: ${detail}`);
  }
}

async function main(): Promise<void> {
  const failures: Failure[] = [];
  console.info('Mixed-era chain verification (ADR-0008)');

  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();

  const accountId = randomUUID();

  try {
    // --- era 1: real account insert (genesis event via trigger) ------------
    await c.query(`insert into public.accounts (id, name) values ($1, 'Mixed-Era Test')`, [
      accountId,
    ]);

    // --- era 2: synthetic pre-capacity interactions events -----------------
    // Inserted as the table owner (no trigger on events), continuing the
    // chain from era 1, using the EXACT canonical the trigger/verify use.
    // The payload snapshot is the pre-capacity interactions row shape:
    // every column that existed before 20260616000001, none that came with it.
    await c.query(
      `
      do $mixed$
      declare
        v_account_id uuid := '${accountId}';
        v_prev       bytea;
        v_seq        bigint;
        v_row        jsonb;
        v_payload    jsonb;
        v_occurred   timestamptz;
        v_canonical  jsonb;
        v_hash       bytea;
        v_id         uuid;
        i            int;
      begin
        select event_hash, account_seq into v_prev, v_seq
        from public.events where account_id = v_account_id
        order by account_seq desc limit 1;

        for i in 1..3 loop
          v_id       := gen_random_uuid();
          v_occurred := clock_timestamp();
          v_seq      := v_seq + 1;
          -- Pre-capacity interactions snapshot: the 20260612000001-era
          -- column set. Deliberately NO author_type / approved_by /
          -- approval_ref / entry_type / external_ref keys.
          v_row := jsonb_build_object(
            'id', v_id,
            'account_id', v_account_id,
            'actor', case i when 1 then 'user:' || gen_random_uuid()::text
                            when 2 then 'tenant:' || gen_random_uuid()::text
                            else 'system' end,
            'party_type', 'tenant',
            'party_id', null,
            'party_label', 'Legacy Tenant',
            'channel', 'phone',
            'direction', 'inbound',
            'body', 'pre-capacity entry ' || i,
            'occurred_at', v_occurred,
            'logged_at', v_occurred,
            'kind', 'communication',
            'corrects_id', null,
            'correction_kind', null,
            'tenancy_id', null,
            'maintenance_request_id', null,
            'area_id', null,
            'work_order_id', null,
            'vendor_id', null,
            'created_at', v_occurred,
            'updated_at', v_occurred,
            'deleted_at', null
          );
          v_payload := jsonb_build_object('after', v_row);
          v_canonical := jsonb_build_object(
            'account_id',  v_account_id,
            'account_seq', v_seq,
            'entity_id',   v_id,
            'entity_type', 'interactions',
            'event_type',  'inserted',
            'occurred_at', v_occurred,
            'payload',     v_payload,
            'prev',        encode(v_prev, 'hex')
          );
          v_hash := digest(v_canonical::text, 'sha256');
          insert into public.events (
            account_id, account_seq, actor, entity_type, entity_id, event_type,
            payload, occurred_at, prev_event_hash, event_hash
          ) values (
            v_account_id, v_seq, v_row->>'actor', 'interactions', v_id, 'inserted',
            v_payload, v_occurred, v_prev, v_hash
          );
          v_prev := v_hash;
        end loop;
      end $mixed$;
      `,
    );

    // --- era 3: real post-capacity interactions insert (trigger fires) -----
    await c.query('begin');
    await c.query(`select set_config('audit.actor', 'agent:test-service', true)`);
    const ins = await c.query<{ id: string }>(
      `insert into public.interactions
         (account_id, actor, party_type, party_id, party_label, channel, direction,
          body, occurred_at, kind, entry_type, author_type, approval_ref)
       values
         ($1, 'agent:test-service', 'none', null, null, 'agent_event', 'none',
          'step executed: wo ref', now(), 'agent_event', 'step_executed', 'agent', 'prop-0001')
       returning id`,
      [accountId],
    );
    await c.query('commit');
    const v2InteractionId = ins.rows[0]!.id;

    // --- 1. fixture authenticity -------------------------------------------
    await check(
      'fixture authenticity: era-2 snapshots lack capacity keys; era-3 has them',
      async () => {
        const legacy = await c.query<{ has_key: boolean }>(
          `select (payload->'after') ? 'author_type' as has_key
           from public.events
           where account_id = $1 and entity_type = 'interactions' and entity_id <> $2`,
          [accountId, v2InteractionId],
        );
        if (legacy.rows.length !== 3) throw new Error(`expected 3 era-2 events, got ${legacy.rows.length}`);
        if (legacy.rows.some((r) => r.has_key)) {
          throw new Error('an era-2 fixture payload contains author_type — fixture is not pre-capacity-shaped');
        }
        const v2 = await c.query<{ author_type: string | null; entry_type: string | null }>(
          `select payload->'after'->>'author_type' as author_type,
                  payload->'after'->>'entry_type'  as entry_type
           from public.events
           where account_id = $1 and entity_id = $2 and event_type = 'inserted'`,
          [accountId, v2InteractionId],
        );
        if (v2.rows[0]?.author_type !== 'agent' || v2.rows[0]?.entry_type !== 'step_executed') {
          throw new Error(`era-3 snapshot missing capacity fields: ${JSON.stringify(v2.rows[0])}`);
        }
      },
      failures,
    );

    // --- 2. mixed chain verifies -------------------------------------------
    await check('verify_chain ok over mixed pre/post-capacity chain', async () => {
      const v = await c.query<{ ok: boolean; reason: string | null }>(
        `select ok, reason from public.verify_chain($1)`,
        [accountId],
      );
      if (!v.rows[0]!.ok) throw new Error(`chain broken: ${v.rows[0]!.reason}`);
    }, failures);

    // --- 3. tampering a v2 capacity field breaks verification ---------------
    await check(
      'tampering era-3 author_type breaks verification; byte-exact restore heals',
      async () => {
        const before = await c.query<{ id: string; payload: unknown; account_seq: string }>(
          `select id, payload, account_seq from public.events
           where account_id = $1 and entity_id = $2 and event_type = 'inserted'`,
          [accountId, v2InteractionId],
        );
        const evId = before.rows[0]!.id;
        await c.query(
          `update public.events
             set payload = jsonb_set(payload, '{after,author_type}', '"landlord"')
           where id = $1`,
          [evId],
        );
        const broken = await c.query<{ ok: boolean; broken_at: string | null }>(
          `select ok, broken_at from public.verify_chain($1)`,
          [accountId],
        );
        if (broken.rows[0]!.ok) throw new Error('verify_chain ok=true after capacity tamper');
        if (broken.rows[0]!.broken_at !== evId) {
          throw new Error(`broke at ${broken.rows[0]!.broken_at}, expected ${evId}`);
        }
        await c.query(`update public.events set payload = $1 where id = $2`, [
          before.rows[0]!.payload,
          evId,
        ]);
        const healed = await c.query<{ ok: boolean }>(`select ok from public.verify_chain($1)`, [
          accountId,
        ]);
        if (!healed.rows[0]!.ok) throw new Error('restore did not heal the chain');
      },
      failures,
    );

    // --- 4. era-2 fixture rows are genuinely protected ----------------------
    await check(
      'tampering an era-2 (pre-capacity) payload breaks verification',
      async () => {
        const target = await c.query<{ id: string; payload: unknown }>(
          `select id, payload from public.events
           where account_id = $1 and entity_type = 'interactions' and entity_id <> $2
           order by account_seq limit 1`,
          [accountId, v2InteractionId],
        );
        const evId = target.rows[0]!.id;
        await c.query(
          `update public.events
             set payload = jsonb_set(payload, '{after,body}', '"rewritten history"')
           where id = $1`,
          [evId],
        );
        const broken = await c.query<{ ok: boolean }>(`select ok from public.verify_chain($1)`, [
          accountId,
        ]);
        if (broken.rows[0]!.ok) throw new Error('verify_chain ok=true after era-2 tamper');
        await c.query(`update public.events set payload = $1 where id = $2`, [
          target.rows[0]!.payload,
          evId,
        ]);
        const healed = await c.query<{ ok: boolean }>(`select ok from public.verify_chain($1)`, [
          accountId,
        ]);
        if (!healed.rows[0]!.ok) throw new Error('restore did not heal the chain');
      },
      failures,
    );
  } finally {
    await c.end();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} mixed-era chain check(s) failed`);
    process.exit(1);
  }
  console.info('\nOK: mixed-era chain checks all green');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
