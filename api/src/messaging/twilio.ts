// Twilio MessagingProvider implementation (agent-api plan Workstream E).
//
// Fetch-based — no twilio npm dependency. One POST to the Messages REST API
// does not justify an SDK (which would add ~10 MiB to the bundle, introduce
// a transitive dep surface, and require upgrading when Twilio versions the
// SDK). The full SDK becomes worth it if we add inbound/sub-account support.
//
// Auth: HTTP Basic with (TWILIO_ACCOUNT_SID : TWILIO_AUTH_TOKEN).
// Body: application/x-www-form-urlencoded (the Twilio API only accepts this).
// Timeout: 10 s via AbortSignal.timeout (built into Node 18+).

import { loadEnv } from '../env';
import { ProviderError, type MessagingProvider, type SendSmsArgs, type SendSmsResult } from './provider';

export class TwilioProvider implements MessagingProvider {
  async sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
    const env = loadEnv();
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;

    // Guard: these should have been checked by the route before ever reaching
    // the provider, but fail loudly if called misconfigured.
    if (!accountSid || !authToken || !messagingServiceSid) {
      throw new ProviderError('unknown', null, 'Twilio credentials are not configured');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

    const params = new URLSearchParams({
      To: args.to,
      Body: args.body,
      MessagingServiceSid: messagingServiceSid,
    });
    if (args.statusCallbackUrl) {
      params.set('StatusCallback', args.statusCallbackUrl);
    }

    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // fetch() threw — network failure, DNS, or AbortError from the timeout.
      // The message MAY have been sent before the connection dropped (unlikely
      // but possible on a slow Twilio edge). Mark 'unknown' so the outbox stays
      // 'sending' and the janitor / callback can resolve it.
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError('unknown', null, `Twilio request failed: ${msg}`);
    }

    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON body (e.g. HTML error page from a CDN). Treat as unknown.
      throw new ProviderError('unknown', String(res.status), `Twilio returned non-JSON (status ${res.status})`);
    }

    if (res.status === 201) {
      const sid = json.sid as string | undefined;
      if (!sid) {
        throw new ProviderError('unknown', null, 'Twilio 201 response missing sid field');
      }
      return { sid };
    }

    if (res.status >= 400 && res.status < 500) {
      // Definitive provider refusal: bad number, opt-out (21610), quota, etc.
      // The message was NOT sent; safe to mark the outbox 'failed'.
      const code = json.code !== undefined ? String(json.code) : String(res.status);
      const message = (json.message as string | undefined) ?? `Twilio ${res.status}`;
      throw new ProviderError('rejected', code, message);
    }

    // 5xx or unexpected status: treat as unknown.
    const code = json.code !== undefined ? String(json.code) : String(res.status);
    const message = (json.message as string | undefined) ?? `Twilio ${res.status}`;
    throw new ProviderError('unknown', code, message);
  }
}
