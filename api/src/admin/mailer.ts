import { getLogger } from '../log';

// ============================================================================
// Outbound email abstraction.
// ============================================================================
//
// Twilio/messaging was removed, so there is no wired provider yet. The rest of
// the app depends ONLY on the Mailer interface; when a provider is chosen
// (Resend / Postmark / SES / SMTP) add a driver here and switch on env. Until
// then the stub logs what WOULD be sent so the capture/renewal flow runs
// end-to-end in dev without leaking anything.

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(msg: OutboundEmail): Promise<void>;
}

class StubMailer implements Mailer {
  async send(msg: OutboundEmail): Promise<void> {
    getLogger().warn(
      `[mailer:stub] no email provider wired; would send to=${msg.to} ` +
        `subject=${JSON.stringify(msg.subject)} body=${JSON.stringify(msg.text)}`,
    );
  }
}

let cached: Mailer | null = null;

export function getMailer(): Mailer {
  if (!cached) cached = new StubMailer();
  return cached;
}

/** Test seam: inject a fake mailer (pass null to reset to the stub). */
export function setMailer(m: Mailer | null): void {
  cached = m;
}
