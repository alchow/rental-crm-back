import type { AppSupabaseClient } from '../supabase/db-types';
import { readAllById } from './postgrest-pages';

export async function paymentReceiptDates(
  sb: AppSupabaseClient,
  accountId: string,
  tenancyId?: string | null,
  asOf?: string | null,
  paymentIds?: readonly string[],
): Promise<Map<string, string | null>> {
  const dates = new Map<string, string | null>();
  if (paymentIds?.length === 0) return dates;
  const cutoff = asOf ? new Date(`${asOf}T00:00:00Z`) : null;
  if (cutoff) cutoff.setUTCDate(cutoff.getUTCDate() + 1);
  const chunks = paymentIds
    ? Array.from({ length: Math.ceil(paymentIds.length / 100) }, (_, index) =>
        paymentIds.slice(index * 100, (index + 1) * 100),
      )
    : [undefined];
  for (const ids of chunks) {
    const rows = await readAllById(() => {
      let query = sb
        .from('payments')
        .select('id,received_at')
        .eq('account_id', accountId)
        .is('deleted_at', null);
      if (tenancyId) query = query.eq('tenancy_id', tenancyId);
      if (cutoff) query = query.lt('received_at', cutoff.toISOString());
      if (ids) query = query.in('id', [...ids]);
      return query;
    }, 'payment receipt dates');
    for (const row of rows) dates.set(row.id, row.received_at);
  }
  return dates;
}
