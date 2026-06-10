import { z } from 'zod';

// PRIVILEGED ENV — service-role only. The service-role key bypasses RLS,
// so this module is quarantined to api/src/admin/. Importing this from
// outside src/admin/ is a security incident, enforced by:
//   1. scripts/lint-service-role.sh (grep gate in CI)
//   2. (phase 4) an ESLint rule forbidding cross-boundary import of the
//      admin Supabase client and its type.

const AdminEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // Direct-Postgres connection string for the onboarding-import executor's
  // transactional preview/commit (api/src/admin/db-pool.ts). PostgREST can't
  // express a transaction with SAVEPOINT/ROLLBACK, so the executor needs a raw
  // pg connection. Highly privileged (full DB), hence it lives in the admin
  // env. Optional in the schema so loadAdminEnv() still succeeds for the other
  // admin paths (signup, intake, storage) without it; db-pool.ts asserts its
  // presence when the import executor actually runs.
  SUPABASE_DB_URL: z.string().url().optional(),
});

export interface AdminEnv {
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_DB_URL: string | null;
}

let cached: AdminEnv | null = null;

export function loadAdminEnv(): AdminEnv {
  if (cached) return cached;
  const parsed = AdminEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid admin environment configuration:\n${issues}`);
  }
  cached = {
    SUPABASE_SERVICE_ROLE_KEY: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_DB_URL: parsed.data.SUPABASE_DB_URL ?? null,
  };
  return cached;
}
