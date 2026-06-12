// Messaging provider seam (agent-api plan Workstream E).
//
// A thin interface so integration tests can inject a fake without spinning up
// Twilio, and so a future second channel (email) can plug in without touching
// any send-path logic. The Twilio implementation lives in ./twilio.ts.

import { TwilioProvider } from './twilio';

export interface SendSmsArgs {
  to: string;
  body: string;
  statusCallbackUrl?: string;
}

export interface SendSmsResult {
  sid: string;
}

/**
 * ProviderError distinguishes two outcome classes that drive different
 * outbox-state decisions (ADR-0007 crash matrix):
 *
 *   'rejected' — the provider definitively refused (Twilio 4xx: bad number,
 *     opt-out 21610, …). Nothing was sent; it is safe to mark the outbox
 *     row 'failed' and surface the error to the caller.
 *
 *   'unknown'  — timeout / 5xx / network error. The message MAY already exist
 *     at the provider. The outbox row must stay 'sending' so the status
 *     callback (Phase 5) or the reconcile janitor can resolve it. Marking
 *     'failed' here would lose a message that actually went out.
 */
export class ProviderError extends Error {
  constructor(
    public readonly outcome: 'rejected' | 'unknown',
    public readonly providerCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface MessagingProvider {
  sendSms(args: SendSmsArgs): Promise<SendSmsResult>;
}

// ---------------------------------------------------------------------------
// Singleton + test seam
// ---------------------------------------------------------------------------

let _provider: MessagingProvider | null = null;

/**
 * Returns the configured MessagingProvider (Twilio by default), constructing
 * it lazily on first call. Tests call _setMessagingProviderForTests() to
 * inject a fake before any code path that triggers getMessagingProvider().
 *
 * TwilioProvider reads env vars inside sendSms(), not at construction time,
 * so the absence of TWILIO_* vars does not break non-messaging code paths.
 */
export function getMessagingProvider(): MessagingProvider {
  if (_provider) return _provider;
  _provider = new TwilioProvider();
  return _provider;
}

/**
 * Test-only: replace the provider singleton with a fake (or null to restore
 * the lazy-Twilio default). Production code must never call this.
 */
export function _setMessagingProviderForTests(p: MessagingProvider | null): void {
  _provider = p;
}
