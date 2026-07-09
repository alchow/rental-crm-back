import { createRoute, z } from '@hono/zod-openapi';
import { getSb } from '../../supabase/request-client';
import { requireAuth } from '../../middleware/auth';
import { asJson, nullableRpcArg } from '../../supabase/db-types';
import { ApiError, errorResponses } from '../_lib/error';
import {
  evidenceSha256,
  evidenceStoragePath,
  storeEvidenceBytes,
  MAX_EVIDENCE_BYTES,
} from '../../admin/evidence';
import {
  AccountLegalHold,
  AccountParam,
  CaptureInboundBody,
  CaptureInboundResponse,
  CommChannel,
  CommEvidenceBody,
  CommInboundProvenance,
  CommOptOut,
  CreateOptOutBody,
  OptOutListResponse,
  ResolveReplyAddressResponse,
  SetLegalHoldBody,
} from './schemas';
import {
  commDbError,
  decodeOffsetCursor,
  encodeOffsetCursor,
  normalizeAddress,
  PARTICIPANT_COLS,
  requireManager,
  requireTransport,
  type CommsApp,
  type ParticipantRow,
} from './shared';

export function registerInboundRoutes(app: CommsApp): void {
  const captureInbound = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/inbound',
    tags: ['comms'],
    summary:
      'Capture an inbound message (transport). Raw payload is stored first; the ' +
      'active binding (platform number, from address) resolves the thread and ' +
      'participant; matched messages are journaled. Idempotent on ' +
      'provider_msg_id: a replay returns the original result.',
    request: {
      params: AccountParam,
      body: { content: { 'application/json': { schema: CaptureInboundBody } }, required: true },
    },
    responses: {
      200: {
        description: 'capture result',
        content: { 'application/json': { schema: CaptureInboundResponse } },
      },
      ...errorResponses,
    },
  });

  const captureEvidence = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/evidence',
    tags: ['comms'],
    summary:
      'Archive the verbatim signed webhook for an inbound message (transport). ' +
      'The body hash is computed server-side, recorded on an audit-anchored ' +
      'provenance row, and the exact bytes are stored in the private evidence ' +
      'bucket. Idempotent on provider_msg_id; a replay with a different body ' +
      'is refused (409) — the first archived claim wins. Independent of the ' +
      'inbound capture call: archive-then-process.',
    request: {
      params: AccountParam,
      body: { content: { 'application/json': { schema: CommEvidenceBody } }, required: true },
    },
    responses: {
      200: {
        description: 'provenance anchor',
        content: { 'application/json': { schema: CommInboundProvenance } },
      },
      ...errorResponses,
    },
  });

  const getLegalHold = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/legal-hold',
    tags: ['comms'],
    summary:
      'Read the account legal-hold state (any member). active=false with null ' +
      'timestamps means no hold was ever set.',
    request: { params: AccountParam },
    responses: {
      200: {
        description: 'hold state',
        content: { 'application/json': { schema: AccountLegalHold } },
      },
      ...errorResponses,
    },
  });

  const setLegalHold = createRoute({
    method: 'put',
    path: '/accounts/{accountId}/comms/legal-hold',
    tags: ['comms'],
    summary:
      'Set or release the account legal hold (owner|manager). While active, ' +
      'every comms destruction path (raw-capture prune, evidence-blob ' +
      'retention) skips this account. Audited.',
    request: {
      params: AccountParam,
      body: { content: { 'application/json': { schema: SetLegalHoldBody } }, required: true },
    },
    responses: {
      200: {
        description: 'hold state after the write',
        content: { 'application/json': { schema: AccountLegalHold } },
      },
      ...errorResponses,
    },
  });

  const createOptOut = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/opt-outs',
    tags: ['comms'],
    summary:
      'Record a carrier/provider opt-out (transport). Idempotent upsert keyed by ' +
      '(channel, address).',
    request: {
      params: AccountParam,
      body: { content: { 'application/json': { schema: CreateOptOutBody } }, required: true },
    },
    responses: {
      200: { description: 'opt-out row', content: { 'application/json': { schema: CommOptOut } } },
      ...errorResponses,
    },
  });

  const listOptOuts = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/opt-outs',
    tags: ['comms'],
    summary:
      'List opt-outs relevant to this account (landlord, read-only). The register ' +
      'is global by address; the read is filtered to addresses the account ' +
      'already knows (its channel identities) so it can never be used as a ' +
      'cross-account address oracle.',
    request: {
      params: AccountParam,
      query: z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).default(50),
        channel: CommChannel.optional(),
      }),
    },
    responses: {
      200: { description: 'page', content: { 'application/json': { schema: OptOutListResponse } } },
      ...errorResponses,
    },
  });

  const resolveReplyAddress = createRoute({
    method: 'get',
    path: '/comms/resolve-reply-address',
    tags: ['comms'],
    middleware: [requireAuth()] as const,
    summary:
      'Resolve a tokenized email reply address to its (account, thread, ' +
      'participant) — transport only, account-agnostic by design (the token is ' +
      'all an inbound email carries). 404 for anything but an ACTIVE email ' +
      'binding in an account the caller transports (uniform: unknown, revoked, ' +
      'and foreign tokens are indistinguishable).',
    request: {
      query: z.object({
        /** The full tokenized reply address (t-<token>@<domain>); matched
         *  trim+lowercased, like capture. */
        address: z.string().min(5).max(320),
      }),
    },
    responses: {
      200: {
        description: 'active binding',
        content: { 'application/json': { schema: ResolveReplyAddressResponse } },
      },
      ...errorResponses,
    },
  });

  app.openapi(captureInbound, async (c) => {
    requireTransport(c);
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    // Bound email addresses and reply tokens are stored lowercased; the token is
    // the routing key and the from-address is the sender-verification input, so
    // both normalize identically (trim + lowercase). The sms path is unchanged.
    const toNumber =
      body.channel === 'email' ? body.to_number.trim().toLowerCase() : body.to_number;
    const fromAddress =
      body.channel === 'email' ? body.from_address.trim().toLowerCase() : body.from_address;
    // Email header fields are email-only: reject them on sms/voice up front so
    // an sms capture can never smuggle a Message-ID into the dedupe space.
    if (body.channel !== 'email') {
      const emailOnly = [
        'subject',
        'rfc822_message_id',
        'in_reply_to',
        'references',
        'auth_results',
      ] as const;
      for (const f of emailOnly) {
        if (body[f] !== undefined) {
          throw new ApiError(400, 'invalid_request', `${f} is only valid on email captures`, {
            fieldErrors: { [f]: ['only valid when channel=email'] },
          });
        }
      }
    }
    const { data, error } = await sb.rpc('capture_inbound', {
      p_account_id: accountId,
      p_provider: body.provider,
      p_provider_msg_id: body.provider_msg_id,
      p_to_number: toNumber,
      p_from_address: fromAddress,
      p_channel: body.channel,
      p_body: nullableRpcArg(body.body ?? null),
      p_media: asJson(body.media ?? null),
      p_received_at: body.received_at,
      p_cc: body.cc,
      p_subject: body.subject,
      p_rfc822_message_id: body.rfc822_message_id,
      p_in_reply_to: body.in_reply_to,
      p_references: body.references,
      p_auth_results: asJson(body.auth_results),
    });
    if (error) throw commDbError(error);
    const result = (
      data as {
        disposition: 'matched' | 'orphan' | 'opted_out' | 'sender_mismatch' | 'duplicate';
        interaction_id: string | null;
        thread_id: string | null;
        participant_id: string | null;
      }[]
    )[0];
    if (!result) throw new ApiError(500, 'internal_error', 'capture returned no result');

    let participant: ParticipantRow | null = null;
    if (result.participant_id !== null) {
      const { data: part, error: pErr } = await sb
        .from('comm_thread_participants')
        .select(PARTICIPANT_COLS)
        .eq('account_id', accountId)
        .eq('id', result.participant_id)
        .maybeSingle();
      if (pErr) throw commDbError(pErr);
      participant = (part as ParticipantRow | null) ?? null;
    }
    return c.json(
      {
        disposition: result.disposition,
        interaction_id: result.interaction_id,
        thread_id: result.thread_id,
        participant,
      },
      200,
    );
  });

  const HOLD_COLS = 'account_id, active, reason, set_by, set_at, released_at';

  app.openapi(captureEvidence, async (c) => {
    requireTransport(c);
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');

    // The schema's regex admits only base64 alphabet; reject ragged length here
    // (Buffer.from silently drops trailing garbage, which would make the hash a
    // function of something other than what the caller sent).
    if (body.raw_body_b64.length % 4 !== 0) {
      throw new ApiError(400, 'invalid_request', 'raw_body_b64 is not valid base64', {
        fieldErrors: { raw_body_b64: ['not valid base64 (length not a multiple of 4)'] },
      });
    }
    const bytes = Buffer.from(body.raw_body_b64, 'base64');
    if (bytes.byteLength === 0) {
      throw new ApiError(400, 'invalid_request', 'raw_body_b64 decodes to zero bytes', {
        fieldErrors: { raw_body_b64: ['empty body'] },
      });
    }
    if (bytes.byteLength > MAX_EVIDENCE_BYTES) {
      throw new ApiError(
        400,
        'invalid_request',
        `evidence body exceeds max size (${bytes.byteLength} > ${MAX_EVIDENCE_BYTES} bytes)`,
      );
    }

    // Row first, then bytes: record_inbound_provenance is idempotent and
    // first-hash-wins, so the upload below only ever writes bytes whose hash
    // the audited row has already pinned (a crashed upload heals on retry; a
    // conflicting body 409s here and never touches storage).
    const sha256 = evidenceSha256(bytes);
    const { data, error } = await getSb(c).rpc('record_inbound_provenance', {
      p_account_id: accountId,
      p_provider: body.provider,
      p_provider_msg_id: body.provider_msg_id,
      p_body_sha256: sha256,
      p_signature: nullableRpcArg(body.signature ?? null),
      p_signature_timestamp: nullableRpcArg(body.signature_timestamp ?? null),
      p_storage_path: evidenceStoragePath(accountId, sha256),
      p_received_at: body.received_at,
    });
    if (error) throw commDbError(error);
    const row = data as z.infer<typeof CommInboundProvenance>;

    await storeEvidenceBytes(accountId, bytes);
    return c.json(row, 200);
  });

  // ---------------------------------------------------------------------------
  // GET/PUT /comms/legal-hold — destruction gate (read: member; write: manager)
  // ---------------------------------------------------------------------------

  const NO_HOLD = (accountId: string): z.infer<typeof AccountLegalHold> => ({
    account_id: accountId,
    active: false,
    reason: null,
    set_by: null,
    set_at: null,
    released_at: null,
  });

  app.openapi(getLegalHold, async (c) => {
    const { accountId } = c.req.valid('param');
    const { data, error } = await getSb(c)
      .from('account_legal_holds')
      .select(HOLD_COLS)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw commDbError(error);
    return c.json((data as z.infer<typeof AccountLegalHold> | null) ?? NO_HOLD(accountId), 200);
  });

  app.openapi(setLegalHold, async (c) => {
    requireManager(c);
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    const nowIso = new Date().toISOString();

    if (body.active) {
      const { data, error } = await sb
        .from('account_legal_holds')
        .upsert(
          {
            account_id: accountId,
            active: true,
            reason: body.reason ?? null,
            set_by: c.get('auth').userId,
            set_at: nowIso,
            released_at: null,
            updated_at: nowIso,
          },
          { onConflict: 'account_id' },
        )
        .select(HOLD_COLS)
        .single();
      if (error) throw commDbError(error);
      return c.json(data as z.infer<typeof AccountLegalHold>, 200);
    }

    // Release. Idempotent: releasing an account that never held returns the
    // default state without minting a row that records a release of nothing.
    const { data, error } = await sb
      .from('account_legal_holds')
      .update({ active: false, released_at: nowIso, updated_at: nowIso })
      .eq('account_id', accountId)
      .select(HOLD_COLS)
      .maybeSingle();
    if (error) throw commDbError(error);
    return c.json((data as z.infer<typeof AccountLegalHold> | null) ?? NO_HOLD(accountId), 200);
  });

  // ---------------------------------------------------------------------------
  // POST /comms/opt-outs — record (transport); GET — landlord read
  // ---------------------------------------------------------------------------

  app.openapi(createOptOut, async (c) => {
    requireTransport(c);
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    const { data, error } = await sb.rpc('record_opt_out', {
      p_account_id: accountId,
      p_channel: body.channel,
      p_address: normalizeAddress(body.channel, body.address),
      p_keyword: body.keyword,
      p_source_ref: body.source_ref,
    });
    if (error) throw commDbError(error);
    return c.json(data as z.infer<typeof CommOptOut>, 200);
  });

  app.openapi(listOptOuts, async (c) => {
    requireManager(c);
    const { accountId } = c.req.valid('param');
    const { cursor, limit, channel } = c.req.valid('query');
    const sb = getSb(c);
    const offset = cursor !== undefined ? decodeOffsetCursor(cursor) : 0;
    const { data, error } = await sb.rpc('list_account_opt_outs', {
      p_account_id: accountId,
      p_channel: channel,
      p_limit: limit + 1,
      p_offset: offset,
    });
    if (error) throw commDbError(error);
    const rows = (data ?? []) as z.infer<typeof CommOptOut>[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const next = hasMore ? encodeOffsetCursor(offset + limit) : null;
    return c.json({ data: page, next_cursor: next }, 200);
  });

  app.openapi(resolveReplyAddress, async (c) => {
    const { address } = c.req.valid('query');
    const sb = getSb(c);

    const { data: binding, error } = await sb
      .from('thread_channel_bindings')
      .select('account_id, thread_id, participant_id')
      .eq('reply_address', address.trim().toLowerCase())
      .eq('channel', 'email')
      .eq('active', true)
      .maybeSingle();
    if (error) throw commDbError(error);
    if (!binding) throw new ApiError(404, 'not_found', 'not found');

    const { data: membership, error: mErr } = await sb
      .from('account_members')
      .select('role')
      .eq('account_id', binding.account_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (mErr) throw commDbError(mErr);
    if (!membership || membership.role !== 'agent') {
      throw new ApiError(404, 'not_found', 'not found');
    }

    return c.json(
      {
        account_id: binding.account_id as string,
        thread_id: binding.thread_id as string,
        participant_id: binding.participant_id as string,
      },
      200,
    );
  });
}
