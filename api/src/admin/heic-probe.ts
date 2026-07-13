import { getLogger } from '../log';
import { decodeDocumentImageToJpeg } from './document-image';
import { HEVC_HEIC_FIXTURE } from './hevc-heic-fixture';

// ============================================================================
// libheif support probe.
// ============================================================================
//
// HEIC is what iPhones shoot by default. To render a HEIC photo in our
// inspection-report PDF (the single most probative artifact in a
// habitability dispute), we transcode it server-side at upload time to a
// JPEG derivative via sharp / libvips. That decode path requires libvips
// to be compiled with libheif.
//
// If libheif is missing on the deploy target:
//   - HEIC uploads still land (original bytes hashed + stored);
//   - the JPEG derivative is silently skipped;
//   - the inspection-report PDF placeholders the photo.
//
// Silently degrading evidence rendering is the failure mode we are
// defending against. This module surfaces it LOUDLY at startup so ops
// can see the warning in deploy logs / health checks rather than
// discovering it from a missing photo three months into a dispute.

interface ProbeResult { supported: boolean; error?: string }
let probeResult: ProbeResult | null = null;

/**
 * Runs a tiny HEVC-backed HEIC fixture through the exact rotate/resize/JPEG
 * decode path used by tenancy-document uploads. Generating an AV1 HEIF at
 * runtime can pass on AVIF-only builds while normal iPhone HEICs still fail.
 */
export async function probeHeicSupport(): Promise<ProbeResult> {
  try {
    await decodeDocumentImageToJpeg(HEVC_HEIC_FIXTURE);
    return { supported: true };
  } catch (e) {
    return { supported: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Idempotent boot-time check. First call probes; subsequent calls are
 * a no-op. If libheif is absent, emits a loud warning to stderr -- once.
 */
export async function assertImageStackAtBoot(): Promise<ProbeResult> {
  if (probeResult !== null) return probeResult;
  probeResult = await probeHeicSupport();
  if (!probeResult.supported) {
    getLogger().warn(
      '[WARN][heic] libheif is NOT available in this sharp/libvips build.\n' +
      '            HEIC uploads will land (original bytes preserved), but the\n' +
      '            server-derived JPEG that the inspection-report PDF embeds\n' +
      '            WILL NOT be created. iPhone photos will placeholder in\n' +
      '            PDFs, weakening evidentiary value in habitability disputes.\n' +
      '            Action: install libvips compiled with libheif on the\n' +
      '                    deploy target (e.g., apt-get install libheif1, or\n' +
      '                    a sharp build that includes libheif).\n' +
      `            sharp error: ${probeResult.error}`,
    );
  }
  return probeResult;
}

/** Synchronous accessor for the most-recent probe result, post-boot. */
export function heicSupported(): boolean | null {
  return probeResult?.supported ?? null;
}

/** Test-only: reset memoised probe state. */
export function _resetHeicProbeForTests(): void {
  probeResult = null;
}
