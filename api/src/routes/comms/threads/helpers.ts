import type { Context } from 'hono';
import { getSb } from '../../../supabase/request-client';
import { commDbError, PARTICIPANT_COLS, type ParticipantRow } from '../shared';

export async function loadParticipants(
  c: Context,
  accountId: string,
  threadIds: string[],
): Promise<Map<string, ParticipantRow[]>> {
  const map = new Map<string, ParticipantRow[]>();
  if (threadIds.length === 0) return map;
  const { data, error } = await getSb(c)
    .from('comm_thread_participants')
    .select(PARTICIPANT_COLS)
    .eq('account_id', accountId)
    .in('thread_id', threadIds)
    .order('joined_at', { ascending: true });
  if (error) throw commDbError(error);
  for (const p of (data ?? []) as ParticipantRow[]) {
    const list = map.get(p.thread_id) ?? [];
    list.push(p);
    map.set(p.thread_id, list);
  }
  return map;
}
