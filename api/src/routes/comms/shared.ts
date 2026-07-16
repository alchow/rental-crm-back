import type { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { newApiApp } from '../_lib/app';
import { ApiError, dbError } from '../_lib/error';
import { normalizePhone } from '../_lib/phone';
import { getSb } from '../../supabase/request-client';
import type { CommOutbox, CommThreadParticipant } from './schemas';

export type CommsApp = ReturnType<typeof newApiApp>;

// module in the agent repo); everything else on it is 403.
export function requireTransport(c: Context): void {
  if (c.get('principal').type !== 'agent') {
    throw new ApiError(403, 'forbidden', 'this endpoint is reserved for the agent transport');
  }
}

// Landlord endpoints require owner|manager (viewers read the journal, not the
// comms controls; the agent principal holds role='agent' and is denied too).
export function requireManager(c: Context): void {
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only an owner or manager may use this endpoint');
  }
}

// Reads the transport ALSO needs (thread context for relay legs, standing
// policies for grant provenance): the agent principal or an owner/manager.
// Viewers stay denied. Same carve-out shape as createOutbox/getOutbox.
export function requireAgentOrManager(c: Context): void {
  if (c.get('principal').type === 'agent') return;
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(
      403,
      'forbidden',
      'only the agent transport or an owner/manager may use this endpoint',
    );
  }
}

// Pin an outbox mutation to the URL account BEFORE calling its RPC. The
// complete/fail/delivery RPCs self-defend on the row's OWN account (and
// fail_send/update_delivery rely on RLS), so a caller who is a member of both
// the URL account and the row's account could otherwise drive a row in the
// wrong account through the URL. account_id is immutable (guard trigger), so
// this check is race-free. 404 (not 403) so a foreign id is indistinguishable
// from a missing one.
export async function assertOutboxInAccount(
  c: Context,
  accountId: string,
  id: string,
): Promise<void> {
  const { data, error } = await getSb(c)
    .from('comm_outbox')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw commDbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
}

// Map the typed SQLSTATEs raised by the comms triggers/RPCs to the envelope.
export function commDbError(error: { code?: string; message: string }): ApiError {
  switch (error.code) {
    case 'P0002':
      return new ApiError(404, 'not_found', 'not found');
    case 'P0003':
      return new ApiError(409, 'conflict', error.message);
    case 'P0004':
      return new ApiError(
        422,
        'opted_out',
        'the destination address has opted out of this channel',
      );
    case '23505':
      return new ApiError(
        409,
        'conflict',
        'duplicate reference (provider_sid or routing key already recorded)',
      );
    case '23503':
      return new ApiError(404, 'not_found', 'a referenced row does not belong to this account');
    case '23514':
      return new ApiError(400, 'invalid_request', error.message);
    default:
      return dbError(error);
  }
}

// Destination validation is channel-specific: sms/voice must normalize to
// E.164; email gets a shape check. Returns the canonical address.
export function normalizeAddress(channel: string, raw: string): string {
  if (channel === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) || raw.length > 320) {
      throw new ApiError(422, 'invalid_request', 'to_address is not a valid email address', {
        fieldErrors: { to_address: ['not a valid email address'] },
      });
    }
    return raw.toLowerCase();
  }
  const e164 = normalizePhone(raw);
  if (!e164) {
    throw new ApiError(422, 'invalid_phone', 'to_address cannot be normalised to E.164', {
      fieldErrors: { to_address: ['cannot be normalised to E.164'] },
    });
  }
  return e164;
}

// Tiny offset cursor for the opt-out list: the global register has no uuid id
// to keyset on (PK is channel/address). SQL still applies the limit/offset so
// a landlord listing one page never pulls the whole visible register into API
// memory.
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}
export function decodeOffsetCursor(s: string): number {
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as { o?: unknown };
    if (
      typeof obj.o === 'number' &&
      Number.isInteger(obj.o) &&
      obj.o >= 0 &&
      obj.o <= 2_147_483_647
    ) {
      return obj.o;
    }
  } catch {
    /* fall through */
  }
  throw new ApiError(400, 'invalid_request', 'invalid cursor');
}

export type OutboxRow = z.infer<typeof CommOutbox>;
export type ParticipantRow = z.infer<typeof CommThreadParticipant>;

export const PARTICIPANT_COLS = 'id, thread_id, party_type, party_id, joined_at, left_at, is_cc';
// Explicit so the internal group_routing_key column (canonical member-set
// identity, enforced DB-side) never rides along into thread responses.
export const THREAD_COLS =
  'id, account_id, kind, mode, channel, subject, status, tenancy_id, maintenance_request_id, created_at, updated_at';
export const BINDING_COLS =
  'id, thread_id, participant_id, channel, platform_number, participant_address, reply_address, active';
