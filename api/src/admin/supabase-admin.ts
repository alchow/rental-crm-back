import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../env';
import { loadAdminEnv } from './env';

// PRIVILEGED CLIENT. The service-role JWT bypasses RLS, so this module is
// the entire blast radius for any RLS-bypass mistake. Two guards keep it
// inside src/admin/:
//
//   1. ESLint no-restricted-imports forbids importing this file outside
//      api/src/admin/ (eslint.config.mjs).
//   2. scripts/lint-service-role.sh fails CI if the env var name or the
//      'service_role' literal appears outside src/admin/.
//
// User-facing routes that need admin privileges (e.g. signup creating an
// account + owner-membership row) wrap the call in a helper function
// elsewhere in src/admin/ and import THAT, not the client itself.

let cached: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (cached) return cached;
  const env = loadEnv();
  const adminEnv = loadAdminEnv();
  cached = createClient(env.SUPABASE_URL, adminEnv.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return cached;
}

// Test-only: clear the cached client so a fresh env can be used.
export function _resetAdminClientForTests(): void {
  cached = null;
}
