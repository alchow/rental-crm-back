import type { Context } from 'hono';
import type { z } from '@hono/zod-openapi';
import { getSb } from '../../../supabase/request-client';
import { commDbError } from '../shared';
import type { CommOutboxStatus, CommRelayLeg } from '../schemas';

export async function loadRelayLegs(
  c: Context,
  accountId: string,
  interactionIds: string[],
): Promise<Map<string, z.infer<typeof CommRelayLeg>[]>> {
  const map = new Map<string, z.infer<typeof CommRelayLeg>[]>();
  if (interactionIds.length === 0) return map;
  const { data, error } = await getSb(c)
    .from('comm_outbox')
    .select(
      'id, relay_of_interaction_id, participant_id, to_address, status, interaction_id, delivered_at',
    )
    .eq('account_id', accountId)
    .in('relay_of_interaction_id', interactionIds);
  if (error) throw commDbError(error);
  for (const o of (data ?? []) as {
    id: string;
    relay_of_interaction_id: string;
    participant_id: string | null;
    to_address: string | null;
    status: z.infer<typeof CommOutboxStatus>;
    interaction_id: string | null;
    delivered_at: string | null;
  }[]) {
    const leg = {
      outbox_id: o.id,
      participant_id: o.participant_id,
      to_address: o.to_address,
      status: o.status,
      interaction_id: o.interaction_id,
      delivered_at: o.delivered_at,
    };
    const list = map.get(o.relay_of_interaction_id) ?? [];
    list.push(leg);
    map.set(o.relay_of_interaction_id, list);
  }
  return map;
}
