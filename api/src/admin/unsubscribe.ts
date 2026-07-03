import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../env';
import { getAdminClient } from './supabase-admin';

// ============================================================================
// HMAC email unsubscribe (service-role). CAN-SPAM single-visit + RFC 8058
// one-click honoring. The token is minted STATELESSLY by the transport repo
// (which holds the same UNSUBSCRIBE_HMAC_SECRET) and carries the recipient
// address; core stores nothing per-address until the recipient actually
// unsubscribes. All service-role work (the admin client, record_opt_out with
// p_account_id=null, the IP-rate RPC) is quarantined here so the public route
// file never touches admin privileges.
// ============================================================================
//
// Token format v1 (broadcast to the transport repo — must match byte-for-byte):
//   address_lc = trim + lowercase of the recipient email address
//   mac        = HMAC-SHA256(UNSUBSCRIBE_HMAC_SECRET (utf8),
//                            'unsub:v1:email:' + address_lc)   -- full 32 bytes
//   token      = base64url_nopad(utf8(address_lc)) + '.' + base64url_nopad(mac)
//
// (Node's base64url encoding is already unpadded, so encode/decode need no
// manual padding handling.)

const UNSUB_IP_SCOPE = 'unsubscribe';
const UNSUB_IP_WINDOW_S = 10 * 60;
const UNSUB_IP_LIMIT = 120;

function computeMac(secret: string, addressLc: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update('unsub:v1:email:' + addressLc, 'utf8')
    .digest();
}

/**
 * Whether the unsubscribe feature is configured (the HMAC secret is set).
 * Unset -> the public endpoint 503s instead of 404ing, so an operator sees a
 * misconfiguration rather than a silent no-op, and the transport must not emit
 * List-Unsubscribe headers.
 */
export function unsubscribeConfigured(): boolean {
  return !!loadEnv().UNSUBSCRIBE_HMAC_SECRET;
}

/**
 * Verify a v1 unsubscribe token and return the recipient address, or null if
 * the token is malformed, its signature does not verify, or the feature is
 * unconfigured. Constant-time MAC comparison (length-guarded first). The
 * decoded address is shape-checked lightly: it must contain '@', be <=320
 * chars, and already equal its own trim+lowercase (a mixed-case forgery can't
 * verify against the lowercased signing message anyway, but the check keeps a
 * decoded non-address blob from ever reaching the caller).
 */
export function verifyUnsubscribeToken(token: string): string | null {
  const secret = loadEnv().UNSUBSCRIBE_HMAC_SECRET;
  if (!secret) return null;

  // Exactly two dot-separated parts, both non-empty.
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return null;
  const addrPart = token.slice(0, dot);
  const macPart = token.slice(dot + 1);

  let addressLc: string;
  let mac: Buffer;
  try {
    addressLc = Buffer.from(addrPart, 'base64url').toString('utf8');
    mac = Buffer.from(macPart, 'base64url');
  } catch {
    return null;
  }

  if (
    addressLc.length === 0 ||
    addressLc.length > 320 ||
    !addressLc.includes('@') ||
    addressLc !== addressLc.trim().toLowerCase()
  ) {
    return null;
  }

  const expected = computeMac(secret, addressLc);
  // Length guard BEFORE timingSafeEqual (which throws on a length mismatch).
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(mac, expected)) return null;
  return addressLc;
}

/**
 * Register a GLOBAL email opt-out for `address` via the service tier
 * (record_opt_out with p_account_id=null). Idempotent — the RPC upserts on
 * (channel, address), so a replay is a harmless no-op. Throws on RPC error.
 */
export async function registerEmailUnsubscribe(address: string): Promise<void> {
  const admin = getAdminClient();
  const { error } = await admin.rpc('record_opt_out', {
    p_account_id: null,
    p_channel: 'email',
    p_address: address,
    p_keyword: 'unsubscribe',
    p_source_ref: 'unsub:web:v1',
  });
  if (error) throw new Error(`record_opt_out failed: ${error.message}`);
}

/**
 * Per-IP sliding-window backstop for the public unsubscribe endpoints. Fails
 * OPEN (same posture as bumpCaptureIpRate): the signed HMAC token is the real
 * guard, this is only an abuse throttle.
 */
export async function bumpUnsubscribeIpRate(ip: string): Promise<{ ok: boolean }> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc('bump_ip_rate_bucket', {
    p_ip: ip.slice(0, 64),
    p_scope: UNSUB_IP_SCOPE,
    p_window_sec: UNSUB_IP_WINDOW_S,
  });
  if (error) return { ok: true };
  const count = typeof data === 'number' ? data : Number(data);
  if (!Number.isFinite(count)) return { ok: true };
  return { ok: count <= UNSUB_IP_LIMIT };
}
