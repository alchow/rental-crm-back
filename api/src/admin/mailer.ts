import { loadEnv } from '../env';
import { getLogger } from '../log';

// ============================================================================
// Outbound email abstraction.
// ============================================================================
//
// The rest of the app depends ONLY on the Mailer interface. The provider is
// chosen at startup from env: when RESEND_API_KEY (+ MAIL_FROM) is set we wire
// the Resend driver; otherwise we fall back to a stub that logs what WOULD be
// sent so the capture/renewal flow runs end-to-end in dev (and CI) without a
// provider or any leakage. Swapping providers (Postmark / SES / SMTP) is a new
// driver class here plus an env switch -- callers never change.

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Per-send From override ("Name <slug@domain>", see admin/account-email.ts).
   *  Unset -> the driver's global MAIL_FROM. */
  from?: string;
}

export interface Mailer {
  send(msg: OutboundEmail): Promise<void>;
}

class StubMailer implements Mailer {
  async send(msg: OutboundEmail): Promise<void> {
    getLogger().warn(
      `[mailer:stub] no email provider wired; would send to=${msg.to} ` +
        `${msg.from ? `from=${JSON.stringify(msg.from)} ` : ''}` +
        `subject=${JSON.stringify(msg.subject)} body=${JSON.stringify(msg.text)}`,
    );
  }
}

// Resend transactional driver. Uses the REST API directly via global fetch
// (Node 22) to avoid a new runtime dependency -- the request body maps 1:1
// onto OutboundEmail. Docs: https://resend.com/docs/api-reference/emails/send-email
class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(msg: OutboundEmail): Promise<void> {
    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: msg.from ?? this.from,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }),
      });
    } catch (cause) {
      getLogger().error(`[mailer:resend] network error sending to=${msg.to}: ${String(cause)}`);
      throw new Error('email send failed', { cause });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      getLogger().error(
        `[mailer:resend] send to=${msg.to} failed: ${res.status} ${res.statusText} ${body}`,
      );
      throw new Error(`email send failed: ${res.status}`);
    }
  }
}

let cached: Mailer | null = null;

export function getMailer(): Mailer {
  if (cached) return cached;
  const env = loadEnv();
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    cached = new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  } else {
    cached = new StubMailer();
  }
  return cached;
}

/** Test seam: inject a fake mailer (pass null to reset to the stub). */
export function setMailer(m: Mailer | null): void {
  cached = m;
}
