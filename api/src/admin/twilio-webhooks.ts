// Twilio webhook routes (agent-api plan Phase 5).
//
// PUBLIC, UNAUTHENTICATED — lives in src/admin/ because:
//   1. The admin (service-role) client is the only write path (no user JWT
//      from Twilio; RLS would refuse the writes). This is the same rationale
//      as intake.ts.
//   2. Twilio signs every webhook with HMAC-SHA1; validateTwilioSignature()
//      replaces the absent JWT as the authentication mechanism.
//
// Two routes, mounted outside the account auth stack in app.ts:
//   POST /v1/twilio/inbound   — inbound SMS from Twilio
//   POST /v1/twilio/status    — delivery status callback (outbox_id in query)
//
// Threat model:
//   * Signature validation rejects any unsigned/tampered request with 403.
//   * URL must be reconstructed from PUBLIC_BASE_URL (not the Host header,
//     which is not trustworthy behind Render's proxy).
//   * Requests arriving when messaging is unconfigured get 404 (the webhooks
//     don't exist if they were never registered with Twilio).
//   * Inbound deduplication via provider_sid UNIQUE: a Twilio retry of an
//     already-processed webhook is caught at the INSERT and returns 200.

import { Hono } from 'hono';
import { getAdminClient } from './supabase-admin';
import { validateTwilioSignature } from './twilio-signature';
import { normalizePhone } from '../messaging/phone';
import { loadEnv } from '../env';
import { getLogger } from '../log';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// STOP/opt-out keywords (carrier-mandated; Twilio Advanced Opt-Out handles
// the auto-replies; we keep authoritative local state for the send-path check).
const OPT_OUT_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
// Opt-in keywords (carrier-mandated).
const OPT_IN_KEYWORDS  = new Set(['START', 'YES', 'UNSTOP']);
// Help keyword.
const HELP_KEYWORD = 'HELP';

// Twilio error code for carrier opt-out (returned in status callbacks).
const TWILIO_CARRIER_OPTOUT_CODE = '21610';

// ---------------------------------------------------------------------------
// Helper: reconstruct the exact URL Twilio signed.
// Twilio signs the URL it called; behind the proxy the Host header is not
// trustworthy. PUBLIC_BASE_URL is the canonical public base.
// ---------------------------------------------------------------------------
function buildSignedUrl(baseUrl: string, path: string, queryString: string): string {
  if (queryString) {
    return `${baseUrl}${path}?${queryString}`;
  }
  return `${baseUrl}${path}`;
}

// ---------------------------------------------------------------------------
// Helper: parse application/x-www-form-urlencoded body into a plain object.
// Hono provides c.req.parseBody() but we need a plain Record<string,string>
// for the signature validation and for repeated access without re-buffering.
// ---------------------------------------------------------------------------
async function parseFormBody(request: Request): Promise<Record<string, string>> {
  const text = await request.text();
  const params: Record<string, string> = {};
  if (!text) return params;
  for (const pair of text.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key   = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
    const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    params[key] = value;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Shared preamble: validate env + parse + validate signature.
// Returns the form params on success; throws a Response-like object on error.
// ---------------------------------------------------------------------------
async function preamble(
  req: Request,
  path: string,
): Promise<{ params: Record<string, string> }> {
  const env = loadEnv();

  // 404 when messaging is not configured (webhooks were never registered with Twilio).
  if (!env.TWILIO_AUTH_TOKEN || !env.PUBLIC_BASE_URL) {
    throw new Response(
      JSON.stringify({ error: { code: 'not_found', message: 'not found' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  // Parse body before signature check (signature covers the params).
  const params = await parseFormBody(req.clone());

  // Reconstruct the exact signed URL: PUBLIC_BASE_URL + path + query string.
  const urlObj = new URL(req.url);
  const queryString = urlObj.searchParams.toString();
  const signedUrl = buildSignedUrl(env.PUBLIC_BASE_URL, path, queryString);

  const signature = req.headers.get('x-twilio-signature') ?? '';

  if (!validateTwilioSignature(env.TWILIO_AUTH_TOKEN, signedUrl, params, signature)) {
    getLogger().warn(
      { path, signedUrl, from: params['From'] ? `…${(params['From'] as string).slice(-4)}` : 'unknown' },
      'twilio-webhook: invalid signature — request rejected',
    );
    throw new Response(
      JSON.stringify({ error: { code: 'forbidden', message: 'invalid signature' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  return { params };
}

// Empty TwiML response — Twilio expects this content-type even when there is
// no reply body. Returning application/json causes Twilio to log a warning
// and the delivery status callback machinery can stall in some configurations.
function twimlOk(): Response {
  return new Response('<Response/>', {
    status: 200,
    headers: { 'content-type': 'text/xml' },
  });
}

// ---------------------------------------------------------------------------
// Hono app (mounted in app.ts outside the account auth stack, like intakeApp)
// ---------------------------------------------------------------------------
export const twilioWebhooksApp = new Hono();

// ---------------------------------------------------------------------------
// POST /v1/twilio/inbound
// ---------------------------------------------------------------------------
//
// Processing order (crash semantics: see header comment):
//   1. Preamble (env check, parse body, signature validation).
//   2. Keyword detection → upsert/delete sms_opt_outs.
//   3. Match From across ALL accounts.
//   4. Exactly one match → capture_inbound_sms RPC.
//   5. Insert twilio_inbound_raw (last: dedupe point; 23505 → 200 replay).
//   6. 200 TwiML.
//
// Crash semantics: a crash before step 5 means Twilio retries the whole
// webhook. Steps 2–4 are idempotent (upsert/delete/RPC) so replays are safe.
// Step 5 catches duplicates via the UNIQUE constraint on provider_sid.

twilioWebhooksApp.post('/v1/twilio/inbound', async (c) => {
  let params: Record<string, string>;
  try {
    ({ params } = await preamble(c.req.raw, '/v1/twilio/inbound'));
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  const admin = getAdminClient();

  const messageSid = params['MessageSid'] ?? '';
  const fromPhone  = params['From']       ?? '';
  const toPhone    = params['To']         ?? '';
  const body       = params['Body']       ?? '';

  // -------------------------------------------------------------------------
  // FAST-PATH DEDUPE: check whether this MessageSid was already processed.
  // Checked before any DB writes so Twilio retries of already-processed
  // webhooks are completely idempotent (no keyword re-processing, no second
  // journal entry). The raw-row insert at the END of the success path is the
  // canonical dedupe gate for crash-recovery replays (where a prior attempt
  // never completed the raw-row insert); this early check handles the normal
  // Twilio-retry-after-200 case.
  // -------------------------------------------------------------------------
  const { data: existing } = await admin
    .from('twilio_inbound_raw')
    .select('id')
    .eq('provider_sid', messageSid)
    .maybeSingle();
  if (existing) {
    return twimlOk();
  }

  // -------------------------------------------------------------------------
  // STEP 2: Keyword detection.
  // Detect STOP/START/HELP keywords on the normalized (trimmed/uppercased) body.
  // Keyword messages still continue to step 3: a tenant's STOP is
  // consent-withdrawal evidence and belongs in the journal when matched.
  // -------------------------------------------------------------------------
  const keyword = body.trim().toUpperCase();
  let lastKeyword: string | null = null;

  if (OPT_OUT_KEYWORDS.has(keyword)) {
    lastKeyword = keyword;
    // Upsert opt-out: on conflict update the timestamp, keyword, and source SID.
    await admin.from('sms_opt_outs').upsert(
      { phone: fromPhone, opted_out_at: new Date().toISOString(), last_keyword: keyword, source_sid: messageSid },
      { onConflict: 'phone' },
    );
  } else if (OPT_IN_KEYWORDS.has(keyword)) {
    lastKeyword = keyword;
    // Delete opt-out: carrier has confirmed the number re-opted in.
    await admin.from('sms_opt_outs').delete().eq('phone', fromPhone);
  } else if (keyword === HELP_KEYWORD) {
    lastKeyword = keyword;
    // HELP does not change opt-out state; record the keyword for ops visibility.
  }

  // -------------------------------------------------------------------------
  // STEP 3: Match From across ALL accounts.
  // Scan non-deleted tenants and vendors; compare normalizePhone of stored
  // values to the E.164 From that Twilio delivers.
  //
  // Scale note: full scan across tenants + vendors is fine at single-landlord
  // scale. Revisit trigger = matching p95 > 250ms.
  // -------------------------------------------------------------------------

  interface TenantRow { id: string; account_id: string; phones: string[] }
  interface VendorRow { id: string; account_id: string; contact: Record<string, unknown> | null }

  interface Match {
    account_id: string;
    party_type: 'tenant' | 'vendor';
    party_id: string;
  }

  const matches: Match[] = [];

  // Tenant scan.
  const { data: tenants } = await admin
    .from('tenants')
    .select('id, account_id, phones')
    .is('deleted_at', null);

  for (const t of (tenants ?? []) as TenantRow[]) {
    for (const raw of (t.phones ?? [])) {
      if (normalizePhone(raw) === fromPhone) {
        matches.push({ account_id: t.account_id, party_type: 'tenant', party_id: t.id });
        break; // one match per tenant row; stop checking remaining phones
      }
    }
  }

  // Vendor scan.
  const { data: vendors } = await admin
    .from('vendors')
    .select('id, account_id, contact')
    .is('deleted_at', null);

  for (const v of (vendors ?? []) as VendorRow[]) {
    const rawPhone = (v.contact?.['phone'] as string | undefined) ?? null;
    if (rawPhone && normalizePhone(rawPhone) === fromPhone) {
      matches.push({ account_id: v.account_id, party_type: 'vendor', party_id: v.id });
    }
  }

  // -------------------------------------------------------------------------
  // STEP 4 / 5: Route by match count.
  // -------------------------------------------------------------------------
  let matchStatus: 'matched' | 'unmatched' | 'ambiguous';
  let matchedAccountId: string | null = null;
  let matchedInteractionId: string | null = null;

  if (matches.length === 1) {
    const match = matches[0]!;
    matchStatus      = 'matched';
    matchedAccountId = match.account_id;

    // Capture the inbound interaction via the SECURITY DEFINER RPC.
    // The RPC sets audit.actor='system:twilio-inbound' before the insert,
    // following the intake.ts pattern.
    const authorType = match.party_type; // 'tenant' or 'vendor'
    const { data: interaction, error: rpcErr } = await admin.rpc('capture_inbound_sms', {
      p_account_id:   match.account_id,
      p_author_type:  authorType,
      p_party_type:   match.party_type,
      p_party_id:     match.party_id,
      p_body:         body || null,
      p_occurred_at:  new Date().toISOString(),
      p_external_ref: messageSid,
    });

    if (rpcErr) {
      getLogger().error({ rpcErr, messageSid }, 'capture_inbound_sms RPC failed');
      // Still insert the raw row as unmatched to preserve the dedupe record.
      matchStatus = 'unmatched';
    } else {
      const row = Array.isArray(interaction) ? interaction[0] : interaction;
      matchedInteractionId = (row as { id?: string } | null)?.id ?? null;
    }
  } else if (matches.length === 0) {
    matchStatus = 'unmatched';
    getLogger().warn(
      { from: `…${fromPhone.slice(-4)}`, to: toPhone },
      'twilio-inbound: no tenant/vendor match — storing as unmatched',
    );
  } else {
    // > 1 match: ambiguous. Never auto-create contacts or journal entries.
    matchStatus = 'ambiguous';
    getLogger().warn(
      { from: `…${fromPhone.slice(-4)}`, to: toPhone, matchCount: matches.length },
      'twilio-inbound: ambiguous match — storing as ambiguous, no journal entry',
    );
  }

  // -------------------------------------------------------------------------
  // STEP 5: Insert the raw capture row (last — the dedupe point).
  // A crash mid-handler before this insert causes Twilio to retry the whole
  // webhook — idempotent because the replay re-runs steps 2–4 identically
  // and then hits this UNIQUE constraint again.
  // -------------------------------------------------------------------------
  const { error: insertErr } = await admin.from('twilio_inbound_raw').insert({
    provider_sid:          messageSid,
    from_phone:            fromPhone,
    to_phone:              toPhone,
    body:                  body || null,
    payload:               params,
    match_status:          matchStatus,
    matched_account_id:    matchedAccountId,
    matched_interaction_id: matchedInteractionId,
    last_keyword:          lastKeyword,
    received_at:           new Date().toISOString(),
  });

  if (insertErr) {
    if (insertErr.code === '23505') {
      // Duplicate provider_sid: Twilio retried a webhook we already processed.
      // Return 200 so Twilio stops retrying.
      return twimlOk();
    }
    getLogger().error({ insertErr, messageSid }, 'twilio_inbound_raw insert failed');
    // Return 200 anyway: returning 5xx causes Twilio to retry indefinitely,
    // which could re-insert the journal entry. We prefer one potential gap
    // over a journal duplicate.
  }

  return twimlOk();
});

// ---------------------------------------------------------------------------
// POST /v1/twilio/status?outbox_id=<uuid>
// ---------------------------------------------------------------------------
//
// Called by Twilio when the delivery status of an outbound message changes.
// The outbox_id is appended to the statusCallback URL when the message is sent
// so the record can always re-associate even if the synchronous response was lost.

twilioWebhooksApp.post('/v1/twilio/status', async (c) => {
  let params: Record<string, string>;
  try {
    ({ params } = await preamble(c.req.raw, '/v1/twilio/status'));
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  const admin = getAdminClient();

  // STEP 1: Validate outbox_id from the query param.
  const outboxId = c.req.query('outbox_id') ?? '';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(outboxId)) {
    return c.json({ error: { code: 'invalid_request', message: 'outbox_id must be a valid UUID' } }, 400);
  }

  const messageSid    = params['MessageSid']    ?? '';
  const twilioStatus  = params['MessageStatus'] ?? '';
  const errorCode     = params['ErrorCode']     ?? null;

  // STEP 2: Load the outbox row. Missing → 200 (idempotent ack; nothing to do).
  // Never 404 — Twilio would retry forever on a non-2xx.
  const { data: outbox, error: loadErr } = await admin
    .from('message_outbox')
    .select('id, provider_sid, status, account_id')
    .eq('id', outboxId)
    .maybeSingle();

  if (loadErr) {
    getLogger().error({ loadErr, outboxId }, 'twilio-status: outbox load failed');
    return twimlOk(); // prefer silent 200 over Twilio infinite retry
  }

  if (!outbox) {
    // Row doesn't exist. Ack and move on.
    return twimlOk();
  }

  // STEP 3: Crash-window recovery.
  // If the outbox row has no provider_sid yet, the synchronous complete_sms_send
  // RPC failed or the API crashed after Twilio accepted but before completion.
  // The status callback carries the SID, so we can recover now.
  if (outbox.provider_sid === null && twilioStatus === 'sent') {
    const { error: recoveryErr } = await admin.rpc('complete_sms_send_system', {
      p_outbox_id:    outboxId,
      p_provider_sid: messageSid,
    });
    if (recoveryErr) {
      getLogger().error({ recoveryErr, outboxId, messageSid }, 'twilio-status: complete_sms_send_system failed');
      return twimlOk();
    }
  }

  // STEP 4: Map Twilio MessageStatus → our outbox statuses.
  // queued/accepted → not a meaningful update (we're already 'sending');
  // skip these sub-'sent' states to avoid spurious transitions.
  // sent → 'sent', delivered → 'delivered', undelivered → 'undeliverable',
  // failed → 'failed'. The mapping is done here; update_sms_delivery is
  // purely mechanical from this point.
  const statusMap: Record<string, string> = {
    sent:        'sent',
    delivered:   'delivered',
    undelivered: 'undeliverable',
    failed:      'failed',
  };

  const ourStatus = statusMap[twilioStatus];
  if (!ourStatus) {
    // queued/accepted/sending or unknown: nothing to update.
    return twimlOk();
  }

  const { error: updateErr } = await admin.rpc('update_sms_delivery', {
    p_outbox_id:    outboxId,
    p_provider_sid: messageSid,
    p_status:       ourStatus,
    p_error_code:   errorCode,
  });

  if (updateErr) {
    getLogger().error({ updateErr, outboxId, ourStatus }, 'twilio-status: update_sms_delivery failed');
  }

  // STEP 4 extra: Twilio error code 21610 = carrier opt-out.
  // The carrier rejected the message because the number opted out through the
  // carrier (not our interface). Upsert to keep our local registry in sync.
  if (errorCode === TWILIO_CARRIER_OPTOUT_CODE) {
    const toPhone = (outbox as { to_phone?: string })['to_phone'] as string | undefined;
    if (toPhone) {
      await admin.from('sms_opt_outs').upsert(
        { phone: toPhone, opted_out_at: new Date().toISOString(), last_keyword: 'STOP', source_sid: messageSid },
        { onConflict: 'phone' },
      );
    }
  }

  return twimlOk();
});
