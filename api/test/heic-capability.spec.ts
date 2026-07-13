import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetHeicCapabilityForTests,
  heicCapabilityResult,
  heicSupported,
  recordHeicRenditionFailure,
  recordHeicRenditionSuccess,
} from '../src/admin/heic-capability';

describe('HEIC rendition capability', () => {
  afterEach(_resetHeicCapabilityForTests);

  it('tracks real outage and recovery outcomes instead of freezing the boot result', () => {
    expect(heicSupported()).toBeNull();

    recordHeicRenditionSuccess();
    expect(heicSupported()).toBe(true);

    recordHeicRenditionFailure(new Error('Storage transformation unavailable'));
    expect(heicSupported()).toBe(false);
    expect(heicCapabilityResult()?.error).toContain('unavailable');

    recordHeicRenditionSuccess();
    expect(heicSupported()).toBe(true);
    expect(heicCapabilityResult()?.error).toBeUndefined();
  });
});
