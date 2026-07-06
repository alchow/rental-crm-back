// Persona auto-ack — the friendly front-door receipt for unknown senders.
//
// When a persona capture lands in triage (unknown sender), core may queue ONE
// short acknowledgement email so the stranger isn't met with silence. This is
// a core-originated transactional send: an outbox INTENT with
// approval_ref='system:persona_ack' / author_type='system' (the
// capture-renewal pattern — inspection-capture.ts); the transport makes the
// provider call off the row. Core never dials.
//
// Guard rails, in order:
//   * AUTH: the caller (the comms route) only invokes this on a DMARC pass —
//     acking unauthenticated mail is backscatter/amplification.
//   * RATE: at most 1 ack per account+sender per day and 20 per account per
//     day, via the shared sliding-window bucket (service-role only, hence this
//     module lives in the admin quarantine).
//   * OPT-OUT: the comm_outbox BEFORE-INSERT trigger refuses opted-out
//     destinations (P0004) — logged as compliant, never thrown.
//
// Fire-and-forget: capture latency and ack failures must never couple.

import { createHash } from 'node:crypto';
import { getAdminClient } from './supabase-admin';
import { getLogger } from '../log';

const SENDER_SCOPE = 'persona_ack';
const ACCOUNT_SCOPE = 'persona_ack_acct';
const WINDOW_SEC = 86_400;
// Caps are per account+sender per day: the sender bucket is keyed by
// sha256(`${accountId}:${senderAddress}`) so one account's traffic can't
// suppress another account's first-touch ack (a bare-address key would be
// global across accounts — a cheap cross-tenant griefing lever). Hashed
// because ip_rate_buckets.ip is CHECK-capped at 64 chars (uuid + ':' +
// address doesn't fit) — sha256 hex is exactly 64, deterministic, and keeps
// raw addresses out of the infra table. The account-wide bucket below is
// unchanged (a uuid fits as-is).
const SENDER_DAILY_CAP = 1;
const ACCOUNT_DAILY_CAP = 20;

/** Queue the ack intent (fire-and-forget; call WITHOUT await). Never throws.
 *  When the capture produced a triage row, pass its id so the row records
 *  that (and when) the sender was acked — the FE's "we already replied"
 *  signal. */
export function queuePersonaAck(accountId: string, senderAddress: string, unmatchedId?: string): void {
  void (async () => {
    try {
      const admin = getAdminClient();

      const senderKey = createHash('sha256')
        .update(`${accountId}:${senderAddress}`)
        .digest('hex');
      const { data: senderCount, error: sErr } = await admin.rpc('bump_ip_rate_bucket', {
        p_ip: senderKey,
        p_scope: SENDER_SCOPE,
        p_window_sec: WINDOW_SEC,
      });
      if (sErr || (senderCount as number) > SENDER_DAILY_CAP) {
        if (sErr) getLogger().warn(`[persona-ack] sender bucket failed: ${sErr.message}`);
        return; // capped (or bucket unavailable): fail closed — no ack
      }
      const { data: acctCount, error: aErr } = await admin.rpc('bump_ip_rate_bucket', {
        p_ip: accountId,
        p_scope: ACCOUNT_SCOPE,
        p_window_sec: WINDOW_SEC,
      });
      if (aErr || (acctCount as number) > ACCOUNT_DAILY_CAP) {
        if (aErr) getLogger().warn(`[persona-ack] account bucket failed: ${aErr.message}`);
        return;
      }

      const { data: account } = await admin
        .from('accounts')
        .select('sender_display_name, name')
        .eq('id', accountId)
        .maybeSingle();
      const displayName =
        (account?.sender_display_name as string | null) ??
        (account?.name as string | null) ??
        'the property manager';

      const { error } = await admin.from('comm_outbox').insert({
        account_id: accountId,
        channel: 'email',
        to_address: senderAddress,
        subject: 'We received your message',
        body:
          `Thanks for reaching out to ${displayName}. Your message has been ` +
          `received and will be routed to the right person.\n\n` +
          `If you are a current or former tenant, replying from the email ` +
          `address your landlord has on file helps us route you faster.`,
        approval_ref: 'system:persona_ack',
        author_type: 'system',
      });
      if (error) {
        if (error.code === 'P0004') {
          getLogger().info('[persona-ack] intent suppressed by opt-out (compliant)');
        } else {
          getLogger().error(`[persona-ack] outbox insert failed: ${error.message}`);
        }
        return;
      }

      // Record the ack on the triage row (service tier; client writes on the
      // table are revoked). Best-effort: a failed stamp only loses the FE
      // signal, never the ack itself.
      if (unmatchedId) {
        const { error: stampErr } = await admin
          .from('comm_unmatched_inbound')
          .update({ auto_acked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('account_id', accountId)
          .eq('id', unmatchedId);
        if (stampErr) {
          getLogger().warn(`[persona-ack] auto_acked_at stamp failed: ${stampErr.message}`);
        }
      }
    } catch (e) {
      getLogger().error(`[persona-ack] unexpected: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}
