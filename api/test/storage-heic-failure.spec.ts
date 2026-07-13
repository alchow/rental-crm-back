import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError } from '../src/routes/_lib/error';

const storageMocks = vi.hoisted(() => ({
  upload: vi.fn(),
  download: vi.fn(),
  from: vi.fn(),
}));

vi.mock('../src/admin/supabase-admin', () => ({
  getAdminClient: () => ({ storage: { from: storageMocks.from } }),
}));

import {
  _resetHeicCapabilityForTests,
  heicSupported,
} from '../src/admin/heic-capability';
import { HEVC_HEIC_FIXTURE } from '../src/admin/hevc-heic-fixture';
import { processAndStoreBytes, renderStoredImageToJpeg } from '../src/admin/storage';

describe('HEIC rendition dependency failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetHeicCapabilityForTests();
    storageMocks.from.mockReturnValue({
      upload: storageMocks.upload,
      download: storageMocks.download,
    });
    storageMocks.upload.mockResolvedValue({ data: {}, error: null });
  });

  it('turns an unexpected transform format into 503 before attachment rows can commit', async () => {
    storageMocks.download.mockResolvedValue({
      data: new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'image/webp' }),
      error: null,
    });

    await expect(
      processAndStoreBytes('11111111-1111-4111-8111-111111111111', HEVC_HEIC_FIXTURE, 'image/heic'),
    ).rejects.toMatchObject({
      status: 503,
      code: 'service_unavailable',
    } satisfies Partial<ApiError>);
    expect(heicSupported()).toBe(false);
    expect(storageMocks.upload).toHaveBeenCalledTimes(1); // exact original only; no derivative
    expect(storageMocks.download).toHaveBeenCalledTimes(1);
  });

  it('rejects a mislabeled source as 422 without blaming the rendition dependency', async () => {
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await expect(renderStoredImageToJpeg('fake.heic', pngHeader)).rejects.toMatchObject({
      status: 422,
      code: 'invalid_request',
    } satisfies Partial<ApiError>);
    expect(heicSupported()).toBeNull();
    expect(storageMocks.download).not.toHaveBeenCalled();
  });
});
