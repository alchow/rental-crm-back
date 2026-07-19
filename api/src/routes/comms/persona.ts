import { createRoute, z } from '@hono/zod-openapi';
import { getSb } from '../../supabase/request-client';
import { asJson, nullableRpcArg } from '../../supabase/db-types';
import { requireAuth } from '../../middleware/auth';
import { loadEnv } from '../../env';
import { ApiError, errorResponses } from '../_lib/error';
import { keysetPage } from '../_lib/cursor';
import { brandedReplyDomain } from '../_lib/subdomain';
import { queuePersonaAck } from '../../admin/persona-ack';
import {
  AccountAndIdParam,
  AccountParam,
  CapturePersonaInboundBody,
  CapturePersonaInboundResponse,
  CommUnmatchedInbound,
  ConfirmSenderResponse,
  InteractionAttachmentParams,
  LinkUnmatchedBody,
  LinkUnmatchedResponse,
  ResolvePersonaAddressResponse,
  RetractUnverifiedBody,
  RetractUnverifiedResponse,
  UnmatchedDetailResponse,
  UnmatchedListResponse,
} from './schemas';
import type { UnmatchedSuggestion } from './schemas';
import {
  commDbError,
  PARTICIPANT_COLS,
  requireManager,
  requireTransport,
  type CommsApp,
  type ParticipantRow,
} from './shared';

export function registerPersonaRoutes(app: CommsApp): void {
  const capturePersonaInbound = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/inbound-persona',
    tags: ['comms'],
    summary:
      'Capture an inbound email addressed to the account persona (transport). ' +
      'No reply token: the SENDER is the routing key — a known tenant/vendor ' +
      '(DMARC pass) journals into their active email thread, created atomically ' +
      'when none exists; everything else lands in triage. Idempotent on ' +
      'provider_msg_id (shared raw tier with token capture).',
    request: {
      params: AccountParam,
      body: {
        content: { 'application/json': { schema: CapturePersonaInboundBody } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'capture result',
        content: { 'application/json': { schema: CapturePersonaInboundResponse } },
      },
      ...errorResponses,
    },
  });

  const listUnmatched = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/unmatched',
    tags: ['comms'],
    summary:
      'The unknown-sender triage queue (landlord, owner|manager): persona mail ' +
      'core could not attribute, newest first. Rows carry their own copy of ' +
      'the message — they outlive the raw-tier retention prune.',
    request: {
      params: AccountParam,
      query: z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).default(50),
        status: z.enum(['pending', 'linked', 'dismissed']).optional(),
      }),
    },
    responses: {
      200: {
        description: 'page',
        content: { 'application/json': { schema: UnmatchedListResponse } },
      },
      ...errorResponses,
    },
  });

  const getUnmatched = createRoute({
    method: 'get',
    path: '/accounts/{accountId}/comms/unmatched/{id}',
    tags: ['comms'],
    summary:
      'One triage row with resolution suggestions (computed at read: exact ' +
      'contact-email hits, then trigram name matches on the From display name).',
    request: { params: AccountAndIdParam },
    responses: {
      200: {
        description: 'row + suggestions',
        content: { 'application/json': { schema: UnmatchedDetailResponse } },
      },
      ...errorResponses,
    },
  });

  const linkUnmatched = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/unmatched/{id}/link',
    tags: ['comms'],
    summary:
      '"This was tenant/vendor X" (owner|manager): journals the STORED original ' +
      'into their email thread (created atomically when none exists), learns ' +
      'the sender address so future mail auto-resolves, and marks the row ' +
      'linked. Attestation: provider_verified when the stored DMARC passed, ' +
      'else attested.',
    request: {
      params: AccountAndIdParam,
      body: { content: { 'application/json': { schema: LinkUnmatchedBody } }, required: true },
    },
    responses: {
      200: {
        description: 'journaled + linked',
        content: { 'application/json': { schema: LinkUnmatchedResponse } },
      },
      ...errorResponses,
    },
  });

  const dismissUnmatched = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/comms/unmatched/{id}/dismiss',
    tags: ['comms'],
    summary:
      'Not relevant (owner|manager). No side effects — dismissing never ' +
      'registers an opt-out. Idempotent.',
    request: { params: AccountAndIdParam },
    responses: {
      200: {
        description: 'dismissed row',
        content: { 'application/json': { schema: CommUnmatchedInbound } },
      },
      ...errorResponses,
    },
  });

  // Unverified-journal tier follow-ups (owner|manager). A journaled_unverified
  // row is a receipt whose sender is claimed, not asserted: it can be
  // retracted (soft delete with a mandatory reason; the raw receipt survives)
  // or confirmed ("yes, that really was them" — attested + human_link claim).
  const retractUnverified = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/interactions/{interactionId}/retract',
    tags: ['interactions'],
    summary:
      'Retract an UNVERIFIED journal entry (owner|manager): soft-deletes the ' +
      'row with a mandatory reason (deleted_at/by/reason stamped; hidden from ' +
      'default timeline reads). Only attestation=unverified rows qualify — ' +
      'anything else is 409. The inbound_raw receipt is untouched.',
    request: {
      params: InteractionAttachmentParams,
      body: {
        content: { 'application/json': { schema: RetractUnverifiedBody } },
        required: true,
      },
    },
    responses: {
      200: {
        description: 'retracted',
        content: { 'application/json': { schema: RetractUnverifiedResponse } },
      },
      ...errorResponses,
    },
  });

  const confirmSender = createRoute({
    method: 'post',
    path: '/accounts/{accountId}/interactions/{interactionId}/confirm-sender',
    tags: ['interactions'],
    summary:
      'Confirm the claimed sender of an UNVERIFIED journal entry ' +
      '(owner|manager): flips attestation to attested and human-links the ' +
      'sender address to the entry\'s party (link semantics: differing ' +
      'learned/legacy claims superseded; a differing live human claim is a ' +
      '409). Future mail from the address then resolves normally.',
    request: { params: InteractionAttachmentParams },
    responses: {
      200: {
        description: 'confirmed',
        content: { 'application/json': { schema: ConfirmSenderResponse } },
      },
      ...errorResponses,
    },
  });

  const resolvePersonaAddress = createRoute({
    method: 'get',
    path: '/comms/resolve-persona-address',
    tags: ['comms'],
    middleware: [requireAuth()] as const,
    summary:
      'Resolve a persona address (<local>@<subdomain>.<parent>) to its account — ' +
      'transport only, account-agnostic like resolve-reply-address (a cold ' +
      'inbound email carries nothing but the address). 404 for anything but a ' +
      'configured persona in an account the caller transports (uniform: unknown ' +
      'local parts, unknown subdomains, and foreign accounts are ' +
      'indistinguishable).',
    request: {
      query: z.object({
        /** The full persona address; matched trim+lowercased. */
        address: z.string().min(5).max(320),
      }),
    },
    responses: {
      200: {
        description: 'persona account',
        content: { 'application/json': { schema: ResolvePersonaAddressResponse } },
      },
      ...errorResponses,
    },
  });

  app.openapi(capturePersonaInbound, async (c) => {
    requireTransport(c);
    const { accountId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);

    // The persona mints thread tokens on the cold-create path, so the account
    // must still carry a branded receiving domain (it did at resolve time; a
    // branding change since then surfaces here as a retryable conflict).
    const { data: account, error: acctErr } = await sb
      .from('accounts')
      .select('email_subdomain')
      .eq('id', accountId)
      .maybeSingle();
    if (acctErr) throw commDbError(acctErr);
    const replyDomain = brandedReplyDomain(
      (account?.email_subdomain ?? null) as string | null,
      loadEnv().EMAIL_PLATFORM_PARENT_DOMAIN,
    );
    if (replyDomain === null) {
      throw new ApiError(
        409,
        'conflict',
        'the account has no branded receiving domain (persona is not configured)',
      );
    }

    const lower = (a: string): string => a.trim().toLowerCase();
    const fromAddress = lower(body.from_address);
    const { data, error } = await sb.rpc('capture_persona_inbound', {
      p_account_id: accountId,
      p_provider: body.provider,
      p_provider_msg_id: body.provider_msg_id,
      p_persona_address: lower(body.persona_address),
      p_from_address: fromAddress,
      p_from_display_name: nullableRpcArg(body.from_display_name ?? null),
      p_to_addresses: body.to_addresses.map(lower),
      p_cc_addresses: body.cc_addresses.map(lower),
      p_subject: nullableRpcArg(body.subject ?? null),
      p_body: nullableRpcArg(body.body ?? null),
      p_media: asJson(body.media ?? null),
      p_rfc822_message_id: nullableRpcArg(body.rfc822_message_id ?? null),
      p_in_reply_to: nullableRpcArg(body.in_reply_to ?? null),
      p_references: nullableRpcArg(body.references ?? null),
      p_spf: body.auth_results.spf,
      p_dkim: body.auth_results.dkim,
      p_dmarc: body.auth_results.dmarc,
      p_received_at: body.received_at,
      p_reply_domain: replyDomain,
    });
    if (error) throw commDbError(error);
    const result = (
      data as {
        disposition:
          | 'matched'
          | 'triaged'
          | 'duplicate'
          | 'opted_out'
          | 'cc_journaled'
          | 'cc_relayed'
          | 'journaled_unverified';
        interaction_id: string | null;
        thread_id: string | null;
        participant_id: string | null;
        unmatched_id: string | null;
      }[]
    )[0];
    if (!result) throw new ApiError(500, 'internal_error', 'capture returned no result');

    // Friendly front door: the ack is for STRANGERS only. A first-touch unknown
    // sender gets ONE ack — only on provider-verified mail (DMARC), rate-capped
    // inside. A recognized landlord (e.g. CCing about a counterparty core doesn't
    // know) or a self-addressed persona loop must NEVER receive the tenant-
    // oriented receipt. Fire-and-forget so ack latency/failures never couple to
    // capture. The triage row id rides along so the ack stamps auto_acked_at.
    if (
      result.disposition === 'triaged' &&
      body.auth_results.dmarc === 'pass' &&
      fromAddress !== lower(body.persona_address)
    ) {
      // Any LIVE landlord claim suppresses the ack (superseded claims do
      // not); limit(1) because one address can carry several claims now.
      const { data: landlordIdentity, error: identityErr } = await sb
        .from('channel_identities')
        .select('id')
        .eq('account_id', accountId)
        .eq('channel', 'email')
        .eq('party_type', 'landlord_user')
        .eq('address', fromAddress)
        .is('superseded_at', null)
        .limit(1)
        .maybeSingle();
      // Fail closed: an identity-read failure must never cause a mis-targeted
      // email, and a recognized landlord identity is never a stranger.
      if (!identityErr && !landlordIdentity) {
        queuePersonaAck(accountId, fromAddress, result.unmatched_id ?? undefined);
      }
    }

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
        unmatched_id: result.unmatched_id,
      },
      200,
    );
  });

  type UnmatchedRow = z.infer<typeof CommUnmatchedInbound>;

  app.openapi(listUnmatched, async (c) => {
    requireManager(c);
    const { accountId } = c.req.valid('param');
    const { cursor, limit, status } = c.req.valid('query');
    const sb = getSb(c);
    let q = sb.from('comm_unmatched_inbound').select('*').eq('account_id', accountId);
    if (status !== undefined) q = q.eq('status', status);
    const { items, next_cursor } = await keysetPage<UnmatchedRow>(q, {
      cursor,
      limit,
      column: 'received_at',
      descending: true,
    });
    return c.json({ data: items, next_cursor }, 200);
  });

  app.openapi(getUnmatched, async (c) => {
    requireManager(c);
    const { accountId, id } = c.req.valid('param');
    const sb = getSb(c);
    const { data, error } = await sb
      .from('comm_unmatched_inbound')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw commDbError(error);
    if (!data) throw new ApiError(404, 'not_found', 'not found');
    const row = data as UnmatchedRow;

    // Suggestions, computed at read so late-added parties still match.
    const suggestions: z.infer<typeof UnmatchedSuggestion>[] = [];
    const seen = new Set<string>();

    // (1) Exact contact-email hit (verbatim; the address book normalizes over
    // time via capture's learning step, so this is best-effort by design).
    const { data: exact, error: exErr } = await sb
      .from('tenants')
      .select('id, full_name')
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .contains('emails', [row.from_address])
      .limit(5);
    if (exErr) throw commDbError(exErr);
    for (const t of (exact ?? []) as { id: string; full_name: string }[]) {
      suggestions.push({
        party_type: 'tenant',
        party_id: t.id,
        title: t.full_name,
        subtitle: null,
        source: 'email_exact',
      });
      seen.add(t.id);
    }

    // (2) Trigram match of the sender ADDRESS against searchable party text
    // (tenant search text includes contact emails): catches the case variants
    // the verbatim probe misses — capture matching is case-insensitive, so a
    // mixed-case stored email that capture WOULD auto-resolve must still be
    // suggested here. (3) Trigram name match on the From display name.
    const probes: { q: string | null; source: 'address_match' | 'name_match' }[] = [
      { q: row.from_address, source: 'address_match' },
      { q: row.from_display_name, source: 'name_match' },
    ];
    for (const probe of probes) {
      if (!probe.q) continue;
      const { data: hits, error: sErr } = await sb.rpc('search_entities', {
        p_account_id: accountId,
        p_q: probe.q,
        p_types: ['tenant', 'vendor'],
        p_exclude: nullableRpcArg<string[]>(null),
        p_limit: 5,
      });
      if (sErr) throw commDbError(sErr);
      for (const h of (hits ?? []) as {
        entity_type: string;
        entity_id: string;
        title: string;
        subtitle: string | null;
      }[]) {
        if (seen.has(h.entity_id)) continue;
        if (h.entity_type !== 'tenant' && h.entity_type !== 'vendor') continue;
        suggestions.push({
          party_type: h.entity_type,
          party_id: h.entity_id,
          title: h.title,
          subtitle: h.subtitle,
          source: probe.source,
        });
        seen.add(h.entity_id);
      }
    }

    return c.json({ ...row, suggestions }, 200);
  });

  app.openapi(linkUnmatched, async (c) => {
    requireManager(c);
    const { accountId, id } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);

    // Linking may create a thread (mints tokens): derive the receiving domain
    // exactly like the persona capture path.
    const { data: account, error: acctErr } = await sb
      .from('accounts')
      .select('email_subdomain')
      .eq('id', accountId)
      .maybeSingle();
    if (acctErr) throw commDbError(acctErr);
    const env = loadEnv();
    const replyDomain =
      brandedReplyDomain(
        (account?.email_subdomain ?? null) as string | null,
        env.EMAIL_PLATFORM_PARENT_DOMAIN,
      ) ?? env.EMAIL_REPLY_DOMAIN;
    if (replyDomain === null) {
      throw new ApiError(
        503,
        'service_unavailable',
        'email threads are not configured (no receiving domain)',
      );
    }

    const { data, error } = await sb.rpc('link_unmatched_inbound', {
      p_account_id: accountId,
      p_unmatched_id: id,
      p_party_type: body.party_type,
      p_party_id: body.party_id,
      p_reply_domain: replyDomain,
    });
    if (error) throw commDbError(error);
    const result = (data as { thread_id: string; interaction_id: string }[])[0];
    if (!result) throw new ApiError(500, 'internal_error', 'link returned no result');
    return c.json(result, 200);
  });

  app.openapi(dismissUnmatched, async (c) => {
    requireManager(c);
    const { accountId, id } = c.req.valid('param');
    const sb = getSb(c);
    const { data, error } = await sb.rpc('dismiss_unmatched_inbound', {
      p_account_id: accountId,
      p_unmatched_id: id,
    });
    if (error) throw commDbError(error);
    return c.json(data as UnmatchedRow, 200);
  });

  app.openapi(retractUnverified, async (c) => {
    requireManager(c);
    const { accountId, interactionId } = c.req.valid('param');
    const body = c.req.valid('json');
    const sb = getSb(c);
    const { data, error } = await sb.rpc('retract_unverified_interaction', {
      p_account_id: accountId,
      p_interaction_id: interactionId,
      p_reason: body.reason,
    });
    if (error) throw commDbError(error);
    const result = (
      data as { id: string; deleted_at: string; deleted_reason: string }[]
    )[0];
    if (!result) throw new ApiError(500, 'internal_error', 'retract returned no result');
    return c.json(result, 200);
  });

  app.openapi(confirmSender, async (c) => {
    requireManager(c);
    const { accountId, interactionId } = c.req.valid('param');
    const sb = getSb(c);
    const { data, error } = await sb.rpc('confirm_unverified_sender', {
      p_account_id: accountId,
      p_interaction_id: interactionId,
    });
    if (error) throw commDbError(error);
    const result = (
      data as {
        id: string;
        attestation: 'attested';
        party_type: 'tenant' | 'vendor';
        party_id: string;
        address: string;
      }[]
    )[0];
    if (!result) throw new ApiError(500, 'internal_error', 'confirm returned no result');
    return c.json(result, 200);
  });

  app.openapi(resolvePersonaAddress, async (c) => {
    const { address } = c.req.valid('query');
    const sb = getSb(c);
    const parent = loadEnv().EMAIL_PLATFORM_PARENT_DOMAIN?.toLowerCase() ?? null;

    const canonical = address.trim().toLowerCase();
    const at = canonical.lastIndexOf('@');
    const local = at > 0 ? canonical.slice(0, at) : '';
    const domain = at > 0 ? canonical.slice(at + 1) : '';
    // The domain must be exactly one label under the platform parent.
    const label =
      parent !== null && domain.endsWith('.' + parent)
        ? domain.slice(0, domain.length - parent.length - 1)
        : '';
    if (local === '' || label === '' || label.includes('.')) {
      throw new ApiError(404, 'not_found', 'not found');
    }

    const { data: account, error } = await sb
      .from('accounts')
      .select('id')
      .eq('email_subdomain', label)
      .eq('persona_local_part', local)
      .maybeSingle();
    if (error) throw commDbError(error);
    if (!account) throw new ApiError(404, 'not_found', 'not found');

    const { data: membership, error: mErr } = await sb
      .from('account_members')
      .select('role')
      .eq('account_id', account.id)
      .is('deleted_at', null)
      .maybeSingle();
    if (mErr) throw commDbError(mErr);
    if (!membership || membership.role !== 'agent') {
      throw new ApiError(404, 'not_found', 'not found');
    }

    return c.json({ account_id: account.id as string }, 200);
  });
}
