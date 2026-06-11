import { loadEnv } from '../env';
import { getLogger } from '../log';
import { loadAdminEnv } from './env';
import { getPool } from './db-pool';

// Reports whether the onboarding-import feature is configured AND usable, for
// /healthz -- the same pattern as the HEIC probe. Surfacing this lets a deploy
// monitor alert on a misconfigured environment instead of the user discovering
// it as a 502 on their first upload. Never throws: a missing service-role key
// (which loadAdminEnv requires) is reported as not-ready rather than crashing
// the health check.
//
// `db_reachable` is a live `select 1` through the executor's pool, because
// env-var PRESENCE proved insufficient: an unreachable DB host (June 2026:
// IPv6-only direct host on an IPv4-only platform) reported ready:true here
// while every preview 500'd. The probe is cached so health-check polling
// doesn't hammer the pool, and time-capped so /healthz stays fast even when
// the connect attempt has to time out.

export interface ImportCapability {
  /** True when the LLM key + DB URL are present AND the DB answered a probe. */
  ready: boolean;
  anthropic_key: boolean;
  db_url: boolean;
  /** Cached live-connectivity result; null when no DB URL is configured. */
  db_reachable: boolean | null;
}

const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_500;

let probeCache: { at: number; ok: boolean } | null = null;
let probeInFlight: Promise<boolean> | null = null;

async function probeDb(): Promise<boolean> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.ok;
  if (!probeInFlight) {
    probeInFlight = (async () => {
      try {
        const attempt = getPool().query('select 1');
        // A failure after the race below has resolved must not become an
        // unhandled rejection.
        attempt.catch(() => {});
        return await Promise.race([
          attempt.then(() => true),
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), PROBE_TIMEOUT_MS).unref();
          }),
        ]);
      } catch {
        return false;
      }
    })().then((ok) => {
      probeCache = { at: Date.now(), ok };
      probeInFlight = null;
      return ok;
    });
  }
  return probeInFlight;
}

export async function importCapability(): Promise<ImportCapability> {
  let anthropic = false;
  let db = false;
  try {
    anthropic = !!loadEnv().ANTHROPIC_API_KEY;
  } catch {
    anthropic = false;
  }
  try {
    db = !!loadAdminEnv().SUPABASE_DB_URL;
  } catch {
    db = false;
  }
  const reachable = db ? await probeDb() : null;
  return {
    ready: anthropic && db && reachable === true,
    anthropic_key: anthropic,
    db_url: db,
    db_reachable: reachable,
  };
}

// ----------------------------------------------------------------------------
// Boot recovery (Phase 2.2): recognition runs as an in-process job that does
// not survive a restart. A session still in 'parsing' at boot can never
// finish -- mark it failed with an actionable message. (v2 option: re-run
// recognition from the archived source_path instead of failing.) Must never
// throw; unit tests build the app with no DB configured.
// ----------------------------------------------------------------------------

export async function recoverOrphanedImportSessions(): Promise<void> {
  try {
    const { getAdminClient } = await import('./supabase-admin');
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('import_sessions')
      .update({
        status: 'failed',
        error: 'server restarted while recognizing this file; upload it again',
        updated_at: new Date().toISOString(),
      })
      .eq('status', 'parsing')
      .is('deleted_at', null)
      .select('id');
    if (error) {
      getLogger().warn({ err: error }, 'import-session boot recovery query failed');
      return;
    }
    if (data && data.length > 0) {
      getLogger().warn(
        { count: data.length, ids: data.map((r) => r.id) },
        'orphaned import sessions marked failed at boot',
      );
    }
  } catch (err) {
    getLogger().debug({ err }, 'import-session boot recovery skipped');
  }
}
