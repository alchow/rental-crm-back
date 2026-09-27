import { createRoute } from '@hono/zod-openapi';
import { getSb } from '../../../supabase/request-client';
import { asJson } from '../../../supabase/db-types';
import { ApiError, conflictResponse, errorResponses } from '../../_lib/error';
import { AccountParam, CommOutbox, CreateOutboxBody } from '../schemas';
import { commDbError, type CommsApp, type OutboxRow } from '../shared';

import { authorizeOutbox } from './authorization';
import { resolveOutboxDestination, resolveOutboxPlatformNumber } from './destinations';
import { validateOutboxInput, verifyOutboxParties } from './validation';

export function registerOutboxCreateRoute(app: CommsApp): void {
  const createOutbox = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/outbox',
    tags: ['comms'],
    summary:
      'Create a send intent (status queued). Transport or landlord. The intent is ' +
      'durable BEFORE any provider call (ADR-0007); the journal entry is appended ' +
      'only by the completion path, never here.',
    description:
      'An email RELAY leg (relay_of_interaction_id set) whose target participant is a ' +
      'landlord_user is a notification, not the conversation surface: it dials the ' +
      "account's authoritative owner/manager email for that participant, falling back to " +
      'the thread binding when no authoritative email exists. When the relayed ' +
      "interaction's cast already contains the resolved address (exact lowercase compare " +
      '— the landlord physically received the original, e.g. as a visible Cc), the intent ' +
      'is refused with 409 error.code=relay_already_delivered and no row is created. ' +
      'Other 409 codes: conflict (closed thread / departed participant / an address ' +
      'claimed by two hinted parties). Any CONVERSATIONAL email send — bare OR a ' +
      'thread leg — on an account whose branding is not configured is refused 422 ' +
      "error.code=invalid_request, message 'email branding is not configured' (the " +
      'gate engages only when the platform parent domain is set).',
    request: {
      params: AccountParam,
      body: { content: { 'application/json': { schema: CreateOutboxBody } }, required: true },
    },
    responses: {
      201: {
        description: 'send intent created',
        content: { 'application/json': { schema: CommOutbox } },
      },
      ...errorResponses,
      ...conflictResponse,
    },
  });

  app.openapi(createOutbox, async (c) => {
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    const principal = c.get('principal');
    const role = c.get('account').role;

    if (principal.type !== 'agent' && role !== 'owner' && role !== 'manager') {
      throw new ApiError(
        403,
        'forbidden',
        'only the agent transport or an owner/manager may create send intents',
      );
    }

    validateOutboxInput(body);
    await authorizeOutbox(sb, accountId, body, principal, c.get('auth').userId);
    const { toAddress, groupAddresses, participantId, ccAddresses } =
      await resolveOutboxDestination(sb, accountId, body);
    const ccPartiesPayload = await verifyOutboxParties(sb, accountId, body, toAddress, ccAddresses);
    const platformNumber = await resolveOutboxPlatformNumber(sb, accountId, body);

    const { data, error } = await sb
      .from('comm_outbox')
      .insert({
        account_id: accountId,
        channel: body.channel,
        to_address: toAddress,
        group_addresses: groupAddresses,
        platform_number: platformNumber,
        cc_addresses: ccAddresses,
        to_party_type: body.to_party?.party_type ?? null,
        to_party_id: body.to_party?.party_id ?? null,
        cc_parties: ccPartiesPayload !== null ? asJson(ccPartiesPayload) : null,
        thread_id: body.thread_id ?? null,
        participant_id: participantId,
        body: body.body,
        subject: body.subject ?? null,
        template_id: body.template_id ?? null,
        not_before: body.not_before ?? null,
        relay_of_interaction_id: body.relay_of_interaction_id ?? null,
        tenancy_id: body.tenancy_id ?? null,
        maintenance_request_id: body.maintenance_request_id ?? null,
        approval_ref: body.approval_ref,
        approved_by: principal.type === 'agent' ? (body.approved_by ?? null) : c.get('auth').userId,
        author_type: principal.type === 'agent' ? 'agent' : 'landlord',
      })
      .select('*')
      .single();
    // The DB opt-out guard refuses the whole group send if any member opted out.
    if (error) throw commDbError(error);
    return c.json(data as OutboxRow, 201);
  });
}
