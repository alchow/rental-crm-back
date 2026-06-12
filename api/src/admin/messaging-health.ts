// Messaging capability probe for /healthz (agent-api plan Phase 5).
//
// Pattern mirrors import-health.ts: cached, non-throwing, surfaced on /healthz
// so a deploy monitor can alert on unconfigured or degraded environments rather
// than the operator discovering it when a webhook fails.
//
// capabilities.messaging:
//   configured: boolean         — all required Twilio env vars present
//   unmatched_inbound: number | null  — count of twilio_inbound_raw rows
//     where match_status <> 'matched' (ops "needs human" scan); null when
//     unconfigured or the DB query fails (never throws).

import { loadEnv } from '../env';
import { getAdminClient } from './supabase-admin';
import { getLogger } from '../log';

export interface MessagingCapability {
  configured: boolean;
  /** Count of inbound rows awaiting human attention. null when unconfigured or query fails. */
  unmatched_inbound: number | null;
}

const PROBE_TTL_MS = 60_000;

let probeCache: { at: number; value: MessagingCapability } | null = null;
let probeInFlight: Promise<MessagingCapability> | null = null;

async function probeMessaging(): Promise<MessagingCapability> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return probeCache.value;
  }
  if (!probeInFlight) {
    probeInFlight = (async (): Promise<MessagingCapability> => {
      const env = loadEnv();
      const configured =
        !!env.TWILIO_ACCOUNT_SID &&
        !!env.TWILIO_AUTH_TOKEN &&
        !!env.TWILIO_MESSAGING_SERVICE_SID &&
        !!env.PUBLIC_BASE_URL;

      if (!configured) {
        return { configured: false, unmatched_inbound: null };
      }

      let unmatched: number | null = null;
      try {
        const admin = getAdminClient();
        const { count, error } = await admin
          .from('twilio_inbound_raw')
          .select('*', { count: 'exact', head: true })
          .neq('match_status', 'matched');
        if (!error && count !== null) {
          unmatched = count;
        }
      } catch (err) {
        getLogger().warn({ err }, 'messaging healthz probe failed');
      }

      return { configured: true, unmatched_inbound: unmatched };
    })().then((value) => {
      probeCache = { at: Date.now(), value };
      probeInFlight = null;
      return value;
    });
  }
  return probeInFlight;
}

export async function messagingCapability(): Promise<MessagingCapability> {
  try {
    return await probeMessaging();
  } catch {
    return { configured: false, unmatched_inbound: null };
  }
}

/** Test-only: clear cache so subsequent calls re-probe. */
export function _resetMessagingCapabilityCacheForTests(): void {
  probeCache = null;
  probeInFlight = null;
}
