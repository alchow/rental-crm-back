import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../env';

// Per-request Supabase client carrying the caller's access token. PostgREST
// receives the JWT and applies RLS under the caller's identity. The anon key
// is the *URL-level* auth used by PostgREST; the caller's token in the
// Authorization header is what RLS actually keys off.
//
// Do NOT cache this client across requests -- the token differs per call.
export function getUserClient(accessToken: string): SupabaseClient {
  const env = loadEnv();
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
