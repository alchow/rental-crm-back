import { getLogger } from '../log';
import type { PoolClient } from 'pg';
import { getPool } from './db-pool';
import { ApiError } from '../routes/_lib/error';
import type { RegionEntityMapping } from './import-catalog';
import { ExecCtx } from './import-executor/context';
import type { ExecutionResult, ParentResolutions, RawImportRow } from './import-executor/types';

export type { EntityCounts, ExecutionBlocker, ExecutionResult } from './import-executor/types';

/**
 * Run an import session as a preview (dryRun=true) or a commit (dryRun=false).
 * One transaction, one code path, branching only at the end.
 */
export async function runImport(
  sessionId: string,
  accountId: string,
  dryRun: boolean,
): Promise<ExecutionResult> {
  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch (err) {
    // getPool() already throws a clean 502 when SUPABASE_DB_URL is unset.
    if (err instanceof ApiError) throw err;
    // Everything else here is connectivity (DNS/route/TLS/auth/timeouts) --
    // e.g. an IPv6-only DB host on an IPv4-only platform. Without this
    // mapping it surfaced as a detail-free 500; keep the cause in the log
    // and give the client an actionable envelope.
    getLogger().error({ err }, 'import db connect failed');
    throw new ApiError(
      502,
      'internal_error',
      'import database is unreachable; check SUPABASE_DB_URL and network/TLS configuration',
    );
  }
  try {
    await client.query('BEGIN');
    // Bypass RLS (service_role has BYPASSRLS) while keeping auth.uid() NULL so
    // audit.actor wins attribution for every entity the import creates.
    await client.query('SET LOCAL ROLE service_role');
    await client.query(`select set_config('audit.actor', $1, true)`, [
      `system:import:${sessionId}`,
    ]);

    const sess = await client.query(
      `select mapping, parent_resolutions from import_sessions
         where id = $1 and account_id = $2 and deleted_at is null`,
      [sessionId, accountId],
    );
    if (sess.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new ApiError(404, 'not_found', 'import session not found');
    }
    const mapping = (sess.rows[0].mapping ?? []) as RegionEntityMapping[];
    const parents = (sess.rows[0].parent_resolutions ?? {}) as ParentResolutions;

    const rowsRes = await client.query(
      `select id, region_index, row_index, raw, excluded from import_rows
         where session_id = $1 and account_id = $2 order by region_index, row_index`,
      [sessionId, accountId],
    );
    const allRows = rowsRes.rows as RawImportRow[];
    const activeRows = allRows.filter((r) => !r.excluded);

    await client.query('SAVEPOINT entity_writes');

    const ctx = new ExecCtx(client, accountId, sessionId, mapping, parents);
    await ctx.prefetch();
    for (const row of activeRows) {
      await ctx.processRow(row);
    }
    // Provenance is part of entity_writes: flush BEFORE any savepoint
    // rollback decision so preview rolls it back with the entities.
    await ctx.flushProvenance();
    const result = ctx.buildResult({
      dryRun,
      rowsTotal: allRows.length,
      rowsExcluded: allRows.length - activeRows.length,
      rowsActive: activeRows.length,
    });

    if (dryRun) {
      await client.query('ROLLBACK TO SAVEPOINT entity_writes');
      await ctx.persistRowBlockers();
      await client.query(
        `update import_sessions set preview_summary = $1::jsonb, status = 'preview_ready', error = null, updated_at = now()
           where id = $2 and account_id = $3`,
        [JSON.stringify(result), sessionId, accountId],
      );
      await client.query('COMMIT');
      return result;
    }

    // confirm: a blocker means we must not write anything.
    if (result.blockers.length > 0) {
      await client.query('ROLLBACK TO SAVEPOINT entity_writes');
      await ctx.persistRowBlockers();
      await client.query(
        `update import_sessions set preview_summary = $1::jsonb, status = 'preview_ready',
           error = 'import has unresolved blockers', updated_at = now()
           where id = $2 and account_id = $3`,
        [JSON.stringify(result), sessionId, accountId],
      );
      await client.query('COMMIT');
      return { ...result, committed: false };
    }

    const committed = { ...result, committed: true };
    await ctx.persistRowBlockers(); // clears any stale blockers from a prior preview
    await client.query(
      `update import_sessions set result = $1::jsonb, status = 'done', error = null, updated_at = now()
         where id = $2 and account_id = $3`,
      [JSON.stringify(committed), sessionId, accountId],
    );
    await client.query('COMMIT');
    return committed;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the transaction may already be aborted; ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
