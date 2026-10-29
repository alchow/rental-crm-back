import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type pg from 'pg';

export async function checkMmsStorageBackfill(client: pg.Client): Promise<void> {
  const migration = readFileSync(
    new URL('../supabase/migrations/20261028000001_comm_message_media.sql', import.meta.url),
    'utf8',
  );
  const sql = migration.match(/execute \$query\$([\s\S]*?)\$query\$/)?.[1];
  assert.ok(sql, 'storage inventory backfill must exist');
  await client.query('begin');
  try {
    await client.query(`create temporary table mms_legacy_attachments
      (id integer primary key, storage_path text, storage_bucket text default 'attachments') on commit drop;
      create temporary table mms_inventory_objects(bucket_id text,name text) on commit drop;
      insert into mms_legacy_attachments(id,storage_path) values
      (1,'frozen/photo'),(2,'message/photo'),(3,'missing/photo'),(4,'collision/photo');
      insert into mms_inventory_objects values ('attachments','frozen/photo'),
      ('comm-attachments','message/photo'),('attachments','collision/photo'),('comm-attachments','collision/photo');
      create function pg_temp.reject_frozen_attachment() returns trigger language plpgsql as $$
      begin if old.id=1 then raise exception 'completed inspection is immutable' using errcode='23514'; end if; return new; end $$;
      create trigger reject_frozen before update on mms_legacy_attachments
      for each row execute function pg_temp.reject_frozen_attachment();`);
    await client.query('savepoint frozen');
    await assert.rejects(
      client.query(`update mms_legacy_attachments set storage_bucket=storage_bucket where id=1`),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await client.query('rollback to savepoint frozen');
    const result = await client.query(
      sql
        .replaceAll('public.attachments', 'mms_legacy_attachments')
        .replaceAll('storage.objects', 'mms_inventory_objects'),
    );
    assert.equal(result.rowCount, 3, 'known inspection storage must not receive an update');
    const rows = (
      await client.query('select id,storage_bucket from mms_legacy_attachments order by id')
    ).rows;
    assert.deepEqual(rows, [
      { id: 1, storage_bucket: 'attachments' },
      { id: 2, storage_bucket: 'comm-attachments' },
      { id: 3, storage_bucket: null },
      { id: 4, storage_bucket: null },
    ]);
  } finally {
    await client.query('rollback');
  }
}
