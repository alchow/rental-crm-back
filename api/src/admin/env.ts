import { z } from 'zod';

// PRIVILEGED ENV — service-role only. The service-role key bypasses RLS,
// so this module is quarantined to api/src/admin/. Importing this from
// outside src/admin/ is a security incident, enforced by:
//   1. scripts/lint-service-role.sh (grep gate in CI)
//   2. (phase 4) an ESLint rule forbidding cross-boundary import of the
//      admin Supabase client and its type.

const AdminEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
});

export interface AdminEnv {
  SUPABASE_SERVICE_ROLE_KEY: string;
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
  cached = { SUPABASE_SERVICE_ROLE_KEY: parsed.data.SUPABASE_SERVICE_ROLE_KEY };
  return cached;
}
