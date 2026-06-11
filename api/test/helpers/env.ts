// Shared env bootstrap for unit specs (no Supabase stack). MUST be imported
// (and applied) before any module that reads env. Vitest evaluates module
// graphs per-file, so calling this at the top of a spec is sufficient.
export function setFakeEnv(overrides: Record<string, string> = {}): void {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '8787';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key-padded-to-min-length';
  process.env.SUPABASE_JWT_ISSUER = 'https://test.supabase.co/auth/v1';
  process.env.SUPABASE_JWT_AUDIENCE = 'authenticated';
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
}
