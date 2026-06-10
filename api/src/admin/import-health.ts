import { loadEnv } from '../env';
import { loadAdminEnv } from './env';

// Reports whether the onboarding-import feature is configured, for /healthz --
// the same pattern as the HEIC probe. Surfacing this lets a deploy monitor
// alert on a misconfigured environment instead of the user discovering it as a
// 502 on their first upload. Never throws: a missing service-role key (which
// loadAdminEnv requires) is reported as not-ready rather than crashing the
// health check.

export interface ImportCapability {
  /** True when both the LLM key and the DB URL are present. */
  ready: boolean;
  anthropic_key: boolean;
  db_url: boolean;
}

export function importCapability(): ImportCapability {
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
  return { ready: anthropic && db, anthropic_key: anthropic, db_url: db };
}
