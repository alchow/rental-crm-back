import { getLogger } from '../log';
import {
  _resetHeicCapabilityForTests,
  heicSupported,
  recordHeicRenditionFailure,
} from './heic-capability';
import { HEVC_HEIC_FIXTURE } from './hevc-heic-fixture';
import { probeStoredHeicRendition } from './storage';

// Probes hosted HEIC-to-JPEG rendition without expanding HEVC in the API.
// Preserve the original as evidence; use bounded Storage transformation for
// PDF rendering. If unavailable, fail uploads with retryable 503 before rows
// commit and surface the degraded capability through startup logs/health.

interface ProbeResult {
  supported: boolean;
  error?: string;
}
let bootProbe: Promise<ProbeResult> | null = null;

/**
 * Runs a tiny HEVC-backed HEIC fixture through the exact authenticated Storage
 * transform path used by uploads. An AV1-only probe would pass while normal
 * iPhone HEICs still fail, hence the checked-in HEVC fixture.
 */
export async function probeHeicSupport(): Promise<ProbeResult> {
  try {
    await probeStoredHeicRendition(HEVC_HEIC_FIXTURE);
    return { supported: true };
  } catch (e) {
    recordHeicRenditionFailure(e);
    return { supported: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Idempotent boot-time check. First call probes; subsequent calls are
 * a no-op. If Storage transformation fails, warns loudly -- once.
 */
export async function assertImageStackAtBoot(): Promise<ProbeResult> {
  if (bootProbe) return bootProbe;
  bootProbe = (async () => {
    const result = await probeHeicSupport();
    if (!result.supported) {
      getLogger().warn(
        '[WARN][heic] Supabase Storage HEVC transformation is unavailable.\n' +
          '            HEIC uploads will return retryable 503 before evidence\n' +
          '            rows commit, so iPhone photos cannot silently disappear\n' +
          '            from inspection PDFs.\n' +
          '            Action: verify Storage image transformations are enabled\n' +
          '                    for the project before accepting HEIC uploads.\n' +
          `            transform error: ${result.error}`,
      );
    }
    return result;
  })();
  return bootProbe;
}

// /healthz reads the latest real rendition outcome. Any upload-time 503 flips
// it false; the next successful HEVC rendition flips it true again.
export { heicSupported };

/** Test-only: reset memoised probe state. */
export function _resetHeicProbeForTests(): void {
  bootProbe = null;
  _resetHeicCapabilityForTests();
}
