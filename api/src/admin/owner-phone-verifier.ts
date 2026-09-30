import { createHash, timingSafeEqual } from 'node:crypto';
import { getAdminClient } from './supabase-admin';
import { ApiError, dbError } from '../routes/_lib/error';

export async function recordOwnerPhoneVerification(input: {
  keyId: string;
  secret: string;
  userId: string;
  accountId: string;
  verificationId: string;
  phone: string;
  expiresAt: string;
  correlationId: string;
}): Promise<{ user_id: string; phone: string; phone_verified_at: string; replayed: boolean }> {
  const sb = getAdminClient();
  const digest = createHash('sha256').update(input.secret).digest();
  const { data: key, error: lookupError } = await sb
    .from('phone_verifier_keys')
    .select('secret_hash')
    .eq('key_id', input.keyId)
    .is('disabled_at', null)
    .maybeSingle();
  if (lookupError) throw new ApiError(503, 'service_unavailable', 'verifier lookup unavailable');
  const expected = Buffer.from(key?.secret_hash ?? '0'.repeat(64), 'hex');
  if (!timingSafeEqual(digest, expected) || !key) {
    throw new ApiError(403, 'forbidden', 'invalid phone verifier credentials');
  }
  // The transaction rechecks the key and live membership before receipt replay.
  const { data, error } = await sb.rpc('confirm_owner_phone_verification', {
    p_key_id: input.keyId,
    p_secret_hash: digest.toString('hex'),
    p_user_id: input.userId,
    p_account_id: input.accountId,
    p_verification_id: input.verificationId,
    p_phone: input.phone,
    p_expires_at: input.expiresAt,
    p_correlation_id: input.correlationId,
  });
  if (error) {
    if (error.code === '42501')
      throw new ApiError(403, 'forbidden', 'phone verification not authorized');
    if (error.code === '23505')
      throw new ApiError(409, 'idempotency_conflict', 'verification proof changed');
    if (error.code === '22023')
      throw new ApiError(400, 'invalid_request', 'invalid or expired verification proof');
    if (error.code === 'P0002') throw new ApiError(404, 'not_found', 'profile not found');
    throw dbError(error);
  }
  return data as { user_id: string; phone: string; phone_verified_at: string; replayed: boolean };
}

/** Operator-only provisioning; plaintext exists only in the invoking process. */
export async function provisionPhoneVerifierKey(input: {
  keyId: string;
  verifierId: string;
  secret: string;
}): Promise<void> {
  const { error } = await getAdminClient()
    .from('phone_verifier_keys')
    .insert({
      key_id: input.keyId,
      verifier_id: input.verifierId,
      secret_hash: createHash('sha256').update(input.secret).digest('hex'),
    });
  if (error) throw new Error('phone verifier key provisioning failed; key ids must be unique');
}
