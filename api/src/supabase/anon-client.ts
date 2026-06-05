import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../env';

// Anonymous Supabase client. Used for the unauthenticated leg of /v1/auth/*:
// signup, login, refresh, logout. RLS still applies (the anon role gets no
// privileges beyond the policies grant), so this client cannot read or write
// domain data -- only call auth endpoints.
let cached: SupabaseClient | null = null;

export function getAnonClient(): SupabaseClient {
  if (cached) return cached;
  const env = loadEnv();
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return cached;
}

export function _resetAnonClientForTests(): void {
  cached = null;
}
