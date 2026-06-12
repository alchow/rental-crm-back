// Twilio webhook signature validation (agent-api plan Phase 5).
//
// Twilio signs every webhook by computing HMAC-SHA1 over:
//   url + sorted(paramName + paramValue for each form param)
// and base64-encoding the result. The signature is sent in the
// X-Twilio-Signature header.
//
// Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//
// Design: pure function, unit-testable without I/O. The caller is responsible
// for reconstructing the exact URL Twilio signed (PUBLIC_BASE_URL + path +
// query string — the Host header is not trustworthy behind a proxy).

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validate a Twilio webhook X-Twilio-Signature against the HMAC-SHA1 of the
 * URL and sorted form parameters.
 *
 * @param authToken  TWILIO_AUTH_TOKEN — the HMAC key.
 * @param url        The exact URL Twilio called, including query string.
 * @param params     The parsed application/x-www-form-urlencoded body params.
 * @param signature  The value of the X-Twilio-Signature header (base64).
 * @returns true when the signature is valid; false otherwise.
 */
export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  // Build the string-to-sign: url + sorted param entries (name then value,
  // concatenated with no separator, sorted by key name ascending).
  const sortedKeys = Object.keys(params).sort();
  let toSign = url;
  for (const key of sortedKeys) {
    toSign += key + (params[key] ?? '');
  }

  // Compute HMAC-SHA1.
  const expectedBuffer = createHmac('sha1', authToken).update(toSign, 'utf8').digest();

  // Decode the incoming signature from base64 for timing-safe comparison.
  let incomingBuffer: Buffer;
  try {
    incomingBuffer = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  // Length guard before timingSafeEqual (requires same-length buffers).
  if (expectedBuffer.length !== incomingBuffer.length) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks.
  return timingSafeEqual(expectedBuffer, incomingBuffer);
}
