import { Pool } from 'pg';
import { loadAdminEnv } from './env';
import { getLogger } from '../log';
import { ApiError } from '../routes/_lib/error';

// PRIVILEGED. A raw direct-Postgres connection pool, used ONLY by the
// onboarding-import executor (import-executor.ts).
//
// Why raw pg and not the PostgREST clients: "preview" (dry-run) and "commit"
// must be ONE code path -- the same writes, executed inside a transaction that
// is ROLLED BACK for preview and COMMITTED for confirm. PostgREST/supabase-js
// can't express an explicit BEGIN/SAVEPOINT/ROLLBACK/COMMIT, so the executor
// drives a real pg transaction here.
//
// Connects with SUPABASE_DB_URL (the `postgres` role). The executor issues
// `SET LOCAL role = service_role` per-transaction so its writes BYPASS RLS
// while auth.uid() stays NULL -- which is exactly what lets `audit.actor` win
// attribution (Phase 4 actor-integrity rule). Lives in src/admin/ alongside
// the other privileged surfaces; nothing outside src/admin/ imports it.

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const { SUPABASE_DB_URL } = loadAdminEnv();
  if (!SUPABASE_DB_URL) {
    // Surfaces as a clean 502 on the import preview/confirm routes rather than
    // a generic crash. The var is optional in the admin env schema so the rest
    // of the admin paths (signup/intake/storage) boot without it.
    throw new ApiError(
      502,
      'internal_error',
      'onboarding import is not configured: SUPABASE_DB_URL is unset',
    );
  }
  pool = new Pool({
    connectionString: SUPABASE_DB_URL,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client whose connection drops (network blip, pooler reaping the
  // session) emits 'error' on the pool. With no listener that is an unhandled
  // 'error' event -- it kills the whole process, not one request. pg has
  // already discarded the client when this fires; logging is the only action.
  pool.on('error', (err) => {
    getLogger().error({ err }, 'import-db idle client error');
  });
  return pool;
}

// Test/shutdown hook: close the pool so the process can exit cleanly.
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
