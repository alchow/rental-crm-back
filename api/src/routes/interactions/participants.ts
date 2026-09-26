import type { getSb } from '../../supabase/request-client';
import type { InteractionParticipantRow } from '../../schemas/importable';
import { ApiError } from '../_lib/error';

/** Participants belong to the root entry; correction rows have no cast of their own. */
export async function loadInteractionParticipants(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  interactionIds: string[],
): Promise<Map<string, InteractionParticipantRow[]>> {
  const map = new Map<string, InteractionParticipantRow[]>();
  if (interactionIds.length === 0) return map;
  const { data, error } = await sb
    .from('interaction_participants')
    .select('interaction_id, role, party_type, party_id, address, label, source')
    .eq('account_id', accountId)
    .in('interaction_id', interactionIds)
    .order('created_at', { ascending: true });
  if (error) throw new ApiError(500, 'database_error', error.message);
  for (const row of (data ?? []) as (InteractionParticipantRow & { interaction_id: string })[]) {
    const { interaction_id, ...entry } = row;
    const list = map.get(interaction_id) ?? [];
    list.push(entry);
    map.set(interaction_id, list);
  }
  return map;
}

export interface CastParticipant {
  role: string;
  party_type: string;
  party_id: string | null;
  address: string | null;
  label: string | null;
}

// COMPAT: Derive one cast participant from a landlord's legacy counterparty
// slot so party filters include hand-logged contacts. Use the plain insert for
// agents, unresolved/no-party rows, imports, or referenced interactions because
// journal_with_participants cannot preserve those semantics. Role mapping:
// inbound -> sender, outbound -> recipient, otherwise attendee. Party-carrying
// notes use the row-slot filter and still write no cast.
export function deriveSingleParticipant(
  body: {
    channel?: string;
    direction?: string;
    party_type?: string;
    party_id?: string;
    party_label?: string;
    references_interaction_id?: string;
  },
  principalType: string,
): CastParticipant[] | null {
  if (principalType === 'agent') return null;
  if (body.channel === 'import') return null;
  if (body.references_interaction_id !== undefined) return null;
  const pt = body.party_type;
  if (pt !== 'tenant' && pt !== 'vendor' && pt !== 'inspector' && pt !== 'other') return null;
  if (body.party_id === undefined && body.party_label === undefined) return null;
  const role =
    body.direction === 'inbound'
      ? 'sender'
      : body.direction === 'outbound'
        ? 'recipient'
        : 'attendee';
  return [
    {
      role,
      party_type: pt,
      party_id: body.party_id ?? null,
      address: null,
      label: body.party_label ?? null,
    },
  ];
}
