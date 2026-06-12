import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { withResolvedAuthorship } from './_lib/authorship';
import { Interaction } from './interactions';
import { getMessagingProvider, ProviderError } from '../messaging/provider';
import { normalizePhone } from '../messaging/phone';
import { loadEnv } from '../env';
import { getLogger } from '../log';

// ---------------------------------------------------------------------------
// Outbound messaging route (agent-api plan Workstream E; ADR-0007).
//
// POST /accounts/{accountId}/messages  — send an SMS to a tenant or vendor.
// GET  /accounts/{accountId}/messages/{id} — retrieve an outbox row by id.
//
// Handler order on POST is the ADR-0007 failure-ordering contract:
//   1. Principal/approval_ref validation (no DB)
//   2. Messaging env check (no DB)
//   3. Recipient resolve + phone normalize (read-only DB)
//   4. Opt-out check (read-only DB via security-definer RPC)
//   5. INTENT: insert outbox row — THE COMMIT POINT
//   6. Provider call
//   7a. Success → complete_sms_send (atomic sent+journal+link) → 201
//   7b. ProviderError 'rejected' → fail_sms_send → 422 send_failed
//   7c. ProviderError 'unknown' → leave outbox 'sending' → 409 send_state_unknown
//
// Each step's position is load-bearing: a crash between any two consecutive
// steps is handled by the failure matrix in ADR-0007. Do NOT reorder.
// ---------------------------------------------------------------------------

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});
const AccountAndIdParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

const SendMessageBody = z
  .object({
    channel: z.literal('sms'),
    recipient_type: z.enum(['tenant', 'vendor']),
    recipient_id: z.string().uuid(),
    body: z.string().min(1).max(1600),
    /** Agent principal only: opaque reference to the agent-side approval or
     *  proposal that authorises this send. Required when the principal is
     *  agent; forbidden when the principal is landlord (Req 4). */
    approval_ref: z.string().min(1).max(200).optional(),
    tenancy_id: z.string().uuid().optional(),
    maintenance_request_id: z.string().uuid().optional(),
    work_order_id: z.string().uuid().optional(),
  })
  .openapi('SendMessageBody');

// Mirror of the message_outbox columns returned on GET.
const MessageOutbox = z
  .object({
    id: z.string().uuid(),
    account_id: z.string().uuid(),
    channel: z.literal('sms'),
    tenant_id: z.string().uuid().nullable(),
    vendor_id: z.string().uuid().nullable(),
    to_phone: z.string(),
    body: z.string(),
    status: z.enum(['sending', 'sent', 'delivered', 'failed', 'undeliverable', 'needs_reconcile']),
    provider_sid: z.string().nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    interaction_id: z.string().uuid().nullable(),
    author_type: z.enum(['landlord', 'agent']),
    created_by_actor: z.string(),
    approval_ref: z.string().nullable(),
    tenancy_id: z.string().uuid().nullable(),
    maintenance_request_id: z.string().uuid().nullable(),
    work_order_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    delivered_at: z.string().nullable(),
  })
  .openapi('MessageOutbox');

const SendMessageResponse = z
  .object({
    outbox_id: z.string().uuid(),
    status: z.literal('sent'),
    provider_sid: z.string(),
    /** The journal entry appended by the confirmed send (full chain shape). */
    interaction: Interaction,
  })
  .openapi('SendMessageResponse');

const send = createRoute({
  method: 'post',
  path: '/accounts/{accountId}/messages',
  tags: ['messages'],
  summary:
    'Send an outbound SMS to a tenant or vendor. The intent is recorded before ' +
    'the provider call (ADR-0007). On success returns the created outbox row and ' +
    'the journal interaction.',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: SendMessageBody } }, required: true },
  },
  responses: {
    201: { description: 'sent', content: { 'application/json': { schema: SendMessageResponse } } },
    ...errorResponses,
  },
});

const getOutbox = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/messages/{id}',
  tags: ['messages'],
  summary:
    'Retrieve an outbox row by id. Use this to resolve a send_state_unknown response.',
  request: { params: AccountAndIdParam },
  responses: {
    200: { description: 'outbox row', content: { 'application/json': { schema: MessageOutbox } } },
    ...errorResponses,
  },
});

export const messagesApp = newApiApp();

// ---------------------------------------------------------------------------
// POST /accounts/{accountId}/messages
// ---------------------------------------------------------------------------
messagesApp.openapi(send, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);
  const auth = c.get('auth');
  const principal = c.get('principal');

  // -------------------------------------------------------------------------
  // STEP 1: Principal / approval_ref validation (no DB; before everything else
  // so violations never touch the operational or evidence tier).
  // -------------------------------------------------------------------------
  if (principal.type === 'agent' && body.approval_ref === undefined) {
    throw new ApiError(
      400,
      'invalid_request',
      'approval_ref is required when the agent principal sends a message',
    );
  }
  if (principal.type === 'user' && body.approval_ref !== undefined) {
    throw new ApiError(
      400,
      'invalid_request',
      'approval_ref is reserved for the agent principal',
    );
  }

  // -------------------------------------------------------------------------
  // STEP 2: Messaging env check. All three Twilio vars must be present.
  // PUBLIC_BASE_URL absence is allowed (no status callback URL registered).
  // -------------------------------------------------------------------------
  const env = loadEnv();
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_MESSAGING_SERVICE_SID) {
    throw new ApiError(503, 'messaging_unconfigured', 'outbound messaging is not configured for this environment');
  }

  // -------------------------------------------------------------------------
  // STEP 3: Resolve recipient → raw phone → normalise to E.164.
  // Soft-deleted / missing → 404.  No normalizable phone → 422.
  // -------------------------------------------------------------------------
  let rawPhone: string | null = null;
  let tenantId: string | null = null;
  let vendorId: string | null = null;

  if (body.recipient_type === 'tenant') {
    const { data: tenant, error: tenantErr } = await sb
      .from('tenants')
      .select('id, phones, deleted_at')
      .eq('account_id', accountId)
      .eq('id', body.recipient_id)
      .maybeSingle();
    if (tenantErr) throw new ApiError(500, 'database_error', tenantErr.message);
    if (!tenant || tenant.deleted_at !== null) {
      throw new ApiError(404, 'not_found', 'tenant not found');
    }
    tenantId = tenant.id as string;
    const phones = (tenant.phones as string[]) ?? [];
    rawPhone = phones[0] ?? null;
  } else {
    const { data: vendor, error: vendorErr } = await sb
      .from('vendors')
      .select('id, contact, deleted_at')
      .eq('account_id', accountId)
      .eq('id', body.recipient_id)
      .maybeSingle();
    if (vendorErr) throw new ApiError(500, 'database_error', vendorErr.message);
    if (!vendor || vendor.deleted_at !== null) {
      throw new ApiError(404, 'not_found', 'vendor not found');
    }
    vendorId = vendor.id as string;
    const contact = (vendor.contact as Record<string, unknown>) ?? {};
    rawPhone = (contact['phone'] as string | undefined) ?? null;
  }

  if (!rawPhone) {
    throw new ApiError(
      422,
      'no_sms_destination',
      'recipient has no phone number; store an E.164 number (+1XXXXXXXXXX) and retry',
    );
  }

  const toPhone = normalizePhone(rawPhone);
  if (!toPhone) {
    throw new ApiError(
      422,
      'no_sms_destination',
      `could not resolve '${rawPhone}' to a valid E.164 number; store the number in E.164 format (+[country][number]) and retry`,
    );
  }

  // -------------------------------------------------------------------------
  // STEP 4: Opt-out check. Before any write — a refused send leaves no trace
  // except the API error (ADR-0007: no outbox row for an opted-out number).
  // -------------------------------------------------------------------------
  const { data: isOptedOut, error: optErr } = await sb.rpc('is_phone_opted_out', {
    p_phone: toPhone,
  });
  if (optErr) throw new ApiError(500, 'database_error', optErr.message);
  if (isOptedOut) {
    throw new ApiError(409, 'sms_opted_out', 'the recipient has opted out of SMS messages');
  }

  // -------------------------------------------------------------------------
  // STEP 5: INTENT — insert the outbox row.
  // THE COMMIT POINT: from here the send attempt is recorded forever (the
  // audit trigger chains this insert). A crash after this commit but before
  // a successful provider call leaves the row in 'sending'; the reconcile
  // janitor (Phase 5) resolves it.
  // -------------------------------------------------------------------------
  const actor = `user:${auth.userId}`;
  const authorType = principal.type === 'agent' ? 'agent' : 'landlord';

  const { data: outbox, error: outboxErr } = await sb
    .from('message_outbox')
    .insert({
      account_id: accountId,
      channel: 'sms',
      tenant_id: tenantId,
      vendor_id: vendorId,
      to_phone: toPhone,
      body: body.body,
      // status defaults to 'sending' at the DB level
      author_type: authorType,
      created_by_actor: actor,
      approval_ref: body.approval_ref ?? null,
      tenancy_id: body.tenancy_id ?? null,
      maintenance_request_id: body.maintenance_request_id ?? null,
      work_order_id: body.work_order_id ?? null,
    })
    .select('*')
    .single();

  if (outboxErr) {
    if (outboxErr.code === '23503') {
      throw new ApiError(404, 'not_found', 'a referenced row does not belong to this account');
    }
    throw new ApiError(500, 'database_error', outboxErr.message);
  }

  const outboxId = (outbox as { id: string }).id;

  // -------------------------------------------------------------------------
  // STEP 6: Provider call.
  // From this point onward, the outbox row exists and is audited. The three
  // possible outcomes (7a/7b/7c) are decided by what the provider returns.
  // -------------------------------------------------------------------------
  const statusCallbackUrl = env.PUBLIC_BASE_URL
    ? `${env.PUBLIC_BASE_URL}/v1/twilio/status?outbox_id=${outboxId}`
    : undefined;

  let providerSid: string;
  try {
    const result = await getMessagingProvider().sendSms({
      to: toPhone,
      body: body.body,
      statusCallbackUrl,
    });
    providerSid = result.sid;
  } catch (err) {
    if (err instanceof ProviderError) {
      if (err.outcome === 'rejected') {
        // -----------------------------------------------------------------------
        // STEP 7b: Definitive provider refusal — mark outbox 'failed', no journal.
        // Nothing was sent; the operational record carries the attempt (audited).
        // -----------------------------------------------------------------------
        await sb.rpc('fail_sms_send', {
          p_outbox_id: outboxId,
          p_error_code: err.providerCode ?? 'unknown',
          p_error_message: err.message,
        });
        throw new ApiError(422, 'send_failed', err.message, {
          provider_code: err.providerCode,
        });
      }

      // -----------------------------------------------------------------------
      // STEP 7c: Unknown provider outcome — leave outbox 'sending'.
      // 409 is deliberate: a 4xx is CACHED by the idempotency middleware, so
      // retrying with the same key returns this cached response instead of
      // re-dialing Twilio. A 5xx would free the key and a retry could
      // double-send: the middleware deletes placeholders on 5xx. The caller
      // must check the outbox/journal and use a NEW idempotency key only after
      // confirming the message did not go out.
      // -----------------------------------------------------------------------
      getLogger().error(
        { outboxId, error: err.message, providerCode: err.providerCode },
        'send_state_unknown: provider call returned unknown outcome; outbox stays sending',
      );
      throw new ApiError(
        409,
        'send_state_unknown',
        'the send outcome is unknown; the outbox row remains in sending state — check the outbox id before retrying with a new idempotency key',
        { outbox_id: outboxId },
      );
    }
    // Unexpected (non-ProviderError) throw from the provider.
    throw err;
  }

  // -------------------------------------------------------------------------
  // STEP 7a: Success — complete_sms_send atomically marks outbox 'sent' and
  // appends the journal interaction in one transaction.
  // -------------------------------------------------------------------------
  const { data: interaction, error: completeErr } = await sb.rpc('complete_sms_send', {
    p_outbox_id: outboxId,
    p_provider_sid: providerSid,
  });

  if (completeErr) {
    // The provider accepted the message but our completion transaction failed.
    // The outbox row is still 'sending' (the RPC failed before updating it),
    // the Twilio SID exists, and the status callback (Phase 5) or janitor will
    // complete the record. Return 409 send_state_unknown — same contract as 7c.
    getLogger().error(
      { outboxId, providerSid, error: completeErr.message },
      'send_state_unknown: complete_sms_send RPC failed after provider accepted; status callback or janitor will resolve',
    );
    throw new ApiError(
      409,
      'send_state_unknown',
      'message was sent but the record could not be finalised; the outbox row will be resolved by the status callback',
      { outbox_id: outboxId, provider_sid: providerSid },
    );
  }

  // The RPC returns the interactions row. Add derived fields expected by the
  // Interaction schema (the view fields are not present on the raw insert return).
  const interactionRow = withResolvedAuthorship(
    interaction as { author_type?: string | null; actor: string },
  );

  return c.json(
    {
      outbox_id: outboxId,
      status: 'sent' as const,
      provider_sid: providerSid,
      interaction: {
        ...interactionRow,
        superseded_by_id: null,
        is_head: true,
        delivery_status: 'sent',
        delivered_at: null,
      } as z.infer<typeof Interaction>,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// GET /accounts/{accountId}/messages/{id}
// ---------------------------------------------------------------------------
// Retrieve an outbox row by id (member RLS via user-scoped client; 404 when
// the row is missing or belongs to another account). This is how a caller
// resolves a send_state_unknown: poll the outbox status until it leaves
// 'sending'.
messagesApp.openapi(getOutbox, async (c) => {
  const { accountId, id } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('message_outbox')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'outbox row not found');
  return c.json(data as z.infer<typeof MessageOutbox>, 200);
});
