export interface HeicCapabilityResult {
  supported: boolean;
  error?: string;
  checkedAt: string;
}

let latestResult: HeicCapabilityResult | null = null;

/** Record the outcome of the real HEVC Storage path, not a local codec guess. */
export function recordHeicRenditionSuccess(): void {
  latestResult = { supported: true, checkedAt: new Date().toISOString() };
}

export function recordHeicRenditionFailure(error: unknown): void {
  latestResult = {
    supported: false,
    error: error instanceof Error ? error.message : String(error),
    checkedAt: new Date().toISOString(),
  };
}

export function heicCapabilityResult(): HeicCapabilityResult | null {
  return latestResult;
}

export function heicSupported(): boolean | null {
  return latestResult?.supported ?? null;
}

/** Test-only. */
export function _resetHeicCapabilityForTests(): void {
  latestResult = null;
}
