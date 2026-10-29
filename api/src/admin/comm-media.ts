import { getAdminClient } from './supabase-admin';
import { commDbError } from '../routes/comms/shared';

export async function reportCommMediaOutcome(input: {
  accountId: string;
  interactionId: string;
  slotId: string;
  state: string;
  failureCode: string;
  attemptGeneration: number;
}): Promise<void> {
  const { error } = await getAdminClient().rpc('report_comm_media_outcome', {
    p_account_id: input.accountId,
    p_interaction_id: input.interactionId,
    p_slot_id: input.slotId,
    p_state: input.state,
    p_failure_code: input.failureCode,
    p_attempt_generation: input.attemptGeneration,
  });
  if (error) throw commDbError(error);
}
