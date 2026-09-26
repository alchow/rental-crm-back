import type { z } from '@hono/zod-openapi';
import type { CreateOutboxBody } from '../schemas';
import type { getSb } from '../../../supabase/request-client';
import type { Principal } from '../../../middleware/principal';
import { ApiError, dbError } from '../../_lib/error';
import { loadEnv } from '../../../env';
import { personaAddress } from '../../_lib/subdomain';
import { commDbError } from '../shared';

export async function authorizeOutbox(
  sb: ReturnType<typeof getSb>,
  accountId: string,
  body: z.infer<typeof CreateOutboxBody>,
  principal: Principal,
  userId: string,
): Promise<void> {
  // INVARIANT: Branded email requires a complete persona so replies cannot be lost.
  // Keep the rejection message stable for clients.
  if (body.channel === 'email') {
    const parent = loadEnv().EMAIL_PLATFORM_PARENT_DOMAIN;
    if (parent !== null) {
      const { data: acct, error: acctErr } = await sb
        .from('accounts')
        .select('email_subdomain, persona_local_part')
        .eq('id', accountId)
        .maybeSingle();
      if (acctErr) throw dbError(acctErr);
      if (!acct) throw new ApiError(404, 'not_found', 'not found');
      if (personaAddress(acct.persona_local_part, acct.email_subdomain, parent) === null) {
        throw new ApiError(422, 'invalid_request', 'email branding is not configured');
      }
    }
  }

  // Agent authorization: human approval, an active channel-matched grant,
  // or a relay tied to an active thread and its source interaction.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (principal.type === 'agent') {
    const isGrant = body.approval_ref.startsWith('grant:');
    const isThread = body.approval_ref.startsWith('thread:');
    if (body.approved_by === undefined && !isGrant && !isThread) {
      throw new ApiError(
        403,
        'agent_entry_type_forbidden',
        "agent send intents require approved_by (proposal-approved), a 'grant:' approval_ref (policy-authorized), or a 'thread:' approval_ref (relay)",
      );
    }
    if (body.approved_by !== undefined) {
      const { data: ok, error: approverErr } = await sb.rpc('is_approver_member', {
        p_account_id: accountId,
        p_user_id: body.approved_by,
      });
      if (approverErr) throw commDbError(approverErr);
      if (!ok) {
        throw new ApiError(
          400,
          'invalid_request',
          'approved_by must be a non-agent member of this account',
        );
      }
    } else if (isGrant) {
      // A standing grant authorizes only its own account and channel.
      const grantId = body.approval_ref.slice('grant:'.length);
      if (!UUID_RE.test(grantId)) {
        throw new ApiError(
          400,
          'invalid_request',
          "a 'grant:' approval_ref must carry the comm_policies id",
        );
      }
      const { data: policy, error: polErr } = await sb
        .from('comm_policies')
        .select('id, status, channel')
        .eq('account_id', accountId)
        .eq('id', grantId)
        .maybeSingle();
      if (polErr) throw commDbError(polErr);
      if (!policy || policy.status !== 'active') {
        throw new ApiError(
          403,
          'forbidden',
          'the referenced grant is not an active policy of this account',
        );
      }
      if (policy.channel !== body.channel) {
        throw new ApiError(
          403,
          'forbidden',
          `the referenced grant authorizes ${policy.channel}, not ${body.channel}`,
        );
      }
    } else {
      // A thread authorizes relays only for interactions belonging to that thread.
      if (body.relay_of_interaction_id === undefined) {
        throw new ApiError(
          403,
          'forbidden',
          "a 'thread:' approval_ref is only valid on a relay (relay_of_interaction_id required)",
        );
      }
      const threadRef = body.approval_ref.slice('thread:'.length);
      if (!UUID_RE.test(threadRef)) {
        throw new ApiError(
          400,
          'invalid_request',
          "a 'thread:' approval_ref must carry the thread id",
        );
      }
      const { data: thread, error: thErr } = await sb
        .from('comm_threads')
        .select('id, status')
        .eq('account_id', accountId)
        .eq('id', threadRef)
        .maybeSingle();
      if (thErr) throw commDbError(thErr);
      if (!thread || thread.status !== 'active') {
        throw new ApiError(
          403,
          'forbidden',
          'the referenced thread is not an active thread of this account',
        );
      }
      const { data: orig, error: origErr } = await sb
        .from('interactions')
        .select('id, thread_id')
        .eq('account_id', accountId)
        .eq('id', body.relay_of_interaction_id)
        .maybeSingle();
      if (origErr) throw commDbError(origErr);
      if (!orig || orig.thread_id !== threadRef) {
        throw new ApiError(
          403,
          'forbidden',
          'the relayed interaction does not belong to the referenced thread',
        );
      }
    }
  } else {
    // Landlord approval must identify the authenticated caller.
    const self = `self:${userId}`;
    if (body.approval_ref !== self) {
      throw new ApiError(
        400,
        'invalid_request',
        `landlord send intents carry approval_ref='${self}'`,
        {
          fieldErrors: { approval_ref: [`must be '${self}'`] },
        },
      );
    }
    if (body.approved_by !== undefined && body.approved_by !== userId) {
      throw new ApiError(
        400,
        'invalid_request',
        'landlord send intents are approved by the caller',
        {
          fieldErrors: { approved_by: ['must be your own user id (or omitted)'] },
        },
      );
    }
  }
}
