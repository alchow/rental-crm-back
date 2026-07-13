import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiError } from '../src/routes/_lib/error';

const storageMocks = vi.hoisted(() => ({
  upload: vi.fn(),
  download: vi.fn(),
  createSignedUrl: vi.fn(),
  fetch: vi.fn(),
  remove: vi.fn(),
  from: vi.fn(),
  dbFrom: vi.fn(),
}));

vi.mock('../src/admin/supabase-admin', () => ({
  getAdminClient: () => ({
    from: storageMocks.dbFrom,
    storage: { from: storageMocks.from },
  }),
}));

import {
  _resetHeicCapabilityForTests,
  heicSupported,
} from '../src/admin/heic-capability';
import { HEVC_HEIC_FIXTURE } from '../src/admin/hevc-heic-fixture';
import {
  MAX_BYTES,
  processAndStoreBytes,
  renderStoredImageToJpeg,
  storeGeneratedArtifactBytes,
  uploadAttachment,
} from '../src/admin/storage';

describe('HEIC rendition dependency failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetHeicCapabilityForTests();
    storageMocks.from.mockReturnValue({
      upload: storageMocks.upload,
      download: storageMocks.download,
      createSignedUrl: storageMocks.createSignedUrl,
      remove: storageMocks.remove,
    });
    storageMocks.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://storage.test/object' },
      error: null,
    });
    vi.stubGlobal('fetch', storageMocks.fetch);
    storageMocks.upload.mockResolvedValue({ data: {}, error: null });
  });

  const serveSignedObject = (bytes: Uint8Array) => {
    storageMocks.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
  };

  it('does not rewrite an immutable content-addressed object on retry', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    storageMocks.upload.mockResolvedValue({
      data: null,
      error: { status: 400, statusCode: '409', message: 'The resource already exists' },
    });
    serveSignedObject(bytes);

    const result = await processAndStoreBytes(
      '11111111-1111-4111-8111-111111111111',
      bytes,
      'image/jpeg',
    );

    expect(result.derivative).toBeNull();
    expect(storageMocks.upload).toHaveBeenCalledWith(
      result.primary.storagePath,
      expect.any(Uint8Array),
      expect.objectContaining({ upsert: false }),
    );
    expect(storageMocks.createSignedUrl).toHaveBeenCalledTimes(1);
    expect(storageMocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('stores trusted generated artifacts above the 20 MiB user-upload cap', async () => {
    const bytes = new Uint8Array(MAX_BYTES + 1);

    storageMocks.upload
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { status: 409, statusCode: 'Duplicate', message: 'The resource already exists' },
      });
    serveSignedObject(bytes);

    const result = await storeGeneratedArtifactBytes(
      '11111111-1111-4111-8111-111111111111',
      bytes,
      'application/pdf',
    );
    const duplicate = await storeGeneratedArtifactBytes(
      '11111111-1111-4111-8111-111111111111',
      bytes,
      'application/pdf',
    );

    expect(result.sizeBytes).toBe(MAX_BYTES + 1);
    expect(duplicate).toEqual(result);
    const [path, uploadedBytes, options] = storageMocks.upload.mock.calls[0]!;
    expect(path).toBe(result.storagePath);
    expect(uploadedBytes).toBe(bytes);
    expect(options).toMatchObject({ contentType: 'application/pdf', upsert: false });
    expect(storageMocks.download).not.toHaveBeenCalled();
    expect(storageMocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts the alternate Supabase duplicate error shape only after byte verification', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    storageMocks.upload.mockResolvedValue({
      data: null,
      error: { status: 409, statusCode: 'Duplicate', message: 'The resource already exists' },
    });
    serveSignedObject(bytes);

    await expect(
      processAndStoreBytes(
        '11111111-1111-4111-8111-111111111111',
        bytes,
        'image/jpeg',
      ),
    ).resolves.toMatchObject({ derivative: null });
    expect(storageMocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a dependency failure merely because its message says duplicate', async () => {
    storageMocks.upload.mockResolvedValue({
      data: null,
      error: { status: 500, statusCode: '500', message: 'duplicate service unavailable' },
    });

    await expect(
      processAndStoreBytes(
        '11111111-1111-4111-8111-111111111111',
        new Uint8Array([0xff, 0xd8, 0xff]),
        'image/jpeg',
      ),
    ).rejects.toMatchObject({ status: 500, code: 'database_error' } satisfies Partial<ApiError>);
    expect(storageMocks.download).not.toHaveBeenCalled();
  });

  it('rejects a duplicate path whose stored bytes do not match its hash', async () => {
    storageMocks.upload.mockResolvedValue({
      data: null,
      error: { statusCode: 409, message: 'The resource already exists' },
    });
    serveSignedObject(new Uint8Array([0x00]));

    await expect(
      processAndStoreBytes(
        '11111111-1111-4111-8111-111111111111',
        new Uint8Array([0xff, 0xd8, 0xff]),
        'image/jpeg',
      ),
    ).rejects.toMatchObject({ status: 500, code: 'database_error' } satisfies Partial<ApiError>);
  });

  it('never deletes a verified shared object when its new attachment row is rejected', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    storageMocks.upload.mockResolvedValue({
      data: null,
      error: { status: 409, statusCode: 'Duplicate', message: 'The resource already exists' },
    });
    serveSignedObject(bytes);

    const findQuery = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    for (const method of ['select', 'eq', 'is', 'order', 'limit'] as const) {
      findQuery[method].mockReturnValue(findQuery);
    }
    const insertQuery = {
      insert: vi.fn(),
      select: vi.fn(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: '23514', message: 'parent inspection is completed' },
      }),
    };
    insertQuery.insert.mockReturnValue(insertQuery);
    insertQuery.select.mockReturnValue(insertQuery);
    storageMocks.dbFrom.mockReturnValueOnce(findQuery).mockReturnValueOnce(insertQuery);

    await expect(
      uploadAttachment({
        accountId: '11111111-1111-4111-8111-111111111111',
        entityType: 'inspections',
        entityId: '22222222-2222-4222-8222-222222222222',
        bytes,
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' } satisfies Partial<ApiError>);
    expect(storageMocks.remove).not.toHaveBeenCalled();
  });

  it('retries a transient HEIC transform race and records the recovered capability', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    storageMocks.download
      .mockResolvedValueOnce({
        data: null,
        error: { statusCode: 500, message: 'Internal Server Error' },
      })
      .mockResolvedValueOnce({
        data: new Blob([jpeg], { type: 'image/jpeg' }),
        error: null,
      });

    const result = await processAndStoreBytes(
      '11111111-1111-4111-8111-111111111111',
      HEVC_HEIC_FIXTURE,
      'image/heic',
    );

    expect(result.derivative).not.toBeNull();
    expect(storageMocks.download).toHaveBeenCalledTimes(2);
    expect(heicSupported()).toBe(true);
  });

  it('propagates derivative storage failure instead of committing original-only evidence', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    storageMocks.download.mockResolvedValue({
      data: new Blob([jpeg], { type: 'image/jpeg' }),
      error: null,
    });
    storageMocks.upload
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { status: 500, statusCode: '500', message: 'storage unavailable' },
      });

    await expect(
      processAndStoreBytes(
        '11111111-1111-4111-8111-111111111111',
        HEVC_HEIC_FIXTURE,
        'image/heic',
      ),
    ).rejects.toMatchObject({ status: 500, code: 'database_error' } satisfies Partial<ApiError>);
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
    expect(storageMocks.download).toHaveBeenCalledTimes(3);
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
