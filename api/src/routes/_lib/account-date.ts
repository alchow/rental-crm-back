import type { AppSupabaseClient } from '../../supabase/db-types';
import { ApiError } from './error';

/** Today's date (YYYY-MM-DD) in the account's time zone, from the same SQL the database uses. */
export async function accountDate(sb: AppSupabaseClient, accountId: string): Promise<string> {
  const { data, error } = await sb.rpc('_account_date', { p_account_id: accountId });
  if (error) throw new ApiError(500, 'database_error', error.message);
  return data;
}
