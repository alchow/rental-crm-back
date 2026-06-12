// Unit tests for Twilio signature validation (api/src/admin/twilio-signature.ts).
//
// All fixtures are computed in-test via the same HMAC-SHA1 recipe so the
// tests are self-contained and provably exercise the correct algorithm.
// No network I/O, no DB, no Supabase.

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { validateTwilioSignature } from '../src/admin/twilio-signature';

/** Compute the canonical Twilio signature for a url + params using a given key. */
function computeSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  let toSign = url;
  for (const key of sortedKeys) {
    toSign += key + (params[key] ?? '');
  }
  return createHmac('sha1', authToken).update(toSign, 'utf8').digest('base64');
}

const TOKEN   = 'test_auth_token_abc123xyz';
const URL     = 'https://example.com/v1/twilio/inbound';
const PARAMS  = { MessageSid: 'SM123', From: '+15550001111', To: '+15559999999', Body: 'Hello' };

describe('validateTwilioSignature', () => {
  it('returns true for a valid signature', () => {
    const sig = computeSignature(TOKEN, URL, PARAMS);
    expect(validateTwilioSignature(TOKEN, URL, PARAMS, sig)).toBe(true);
  });

  it('returns false when a param value is tampered', () => {
    const sig = computeSignature(TOKEN, URL, PARAMS);
    const tampered = { ...PARAMS, Body: 'Tampered' };
    expect(validateTwilioSignature(TOKEN, URL, tampered, sig)).toBe(false);
  });

  it('returns false for a wrong auth token', () => {
    const sig = computeSignature('wrong_token', URL, PARAMS);
    expect(validateTwilioSignature(TOKEN, URL, PARAMS, sig)).toBe(false);
  });

  it('returns true for empty params (URL-only case)', () => {
    const emptyParams: Record<string, string> = {};
    const sig = computeSignature(TOKEN, URL, emptyParams);
    expect(validateTwilioSignature(TOKEN, URL, emptyParams, sig)).toBe(true);
  });

  it('returns false for a completely different signature', () => {
    expect(validateTwilioSignature(TOKEN, URL, PARAMS, 'bm90YXZhbGlkc2ln')).toBe(false);
  });

  it('returns false for a non-base64 signature', () => {
    // non-base64 triggers the decode guard
    expect(validateTwilioSignature(TOKEN, URL, PARAMS, '!!invalid!!')).toBe(false);
  });

  it('sorts params alphabetically before signing', () => {
    // Two param orderings should produce the same valid signature.
    const paramsA = { Z_last: 'z', A_first: 'a', M_mid: 'm' };
    const paramsB = { M_mid: 'm', A_first: 'a', Z_last: 'z' };
    const sig = computeSignature(TOKEN, URL, paramsA);
    expect(validateTwilioSignature(TOKEN, URL, paramsB, sig)).toBe(true);
  });
});
