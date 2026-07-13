import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { ApiError } from '../src/routes/_lib/error';
import {
  decodeDocumentImageToJpeg,
  MAX_DOCUMENT_IMAGE_PIXELS,
  renderDocumentImagePdf,
} from '../src/admin/document-image';
import { HEVC_HEIC_FIXTURE } from '../src/admin/hevc-heic-fixture';

describe('tenancy document image rendering', () => {
  it('decodes and renders the HEVC-backed iPhone-style fixture on the production path', async () => {
    expect(HEVC_HEIC_FIXTURE.subarray(4, 12).toString('ascii')).toBe('ftypheic');
    expect(HEVC_HEIC_FIXTURE.includes(Buffer.from('hvc1'))).toBe(true);
    expect(HEVC_HEIC_FIXTURE.includes(Buffer.from('av01'))).toBe(false);
    const jpeg = await decodeDocumentImageToJpeg(HEVC_HEIC_FIXTURE);
    await expect(sharp(jpeg.data).metadata()).resolves.toMatchObject({ format: 'jpeg' });
    const pdf = await renderDocumentImagePdf(HEVC_HEIC_FIXTURE, '2'.repeat(64));
    expect(Buffer.from(pdf).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('rejects compressed inputs whose decoded pixel count exceeds the product limit', async () => {
    // SVG stays tiny on the wire while declaring a 100 MP canvas. Sharp reads
    // the dimensions before raster allocation and must reject it at our 50 MP
    // boundary rather than expanding it in API memory.
    const pixelBomb = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"><rect width="100%" height="100%" fill="white"/></svg>',
    );
    await expect(
      renderDocumentImagePdf(pixelBomb, '0'.repeat(64)),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_request' } satisfies Partial<ApiError>);
  });

  it('keeps ordinary phone-sized images deterministic', async () => {
    const image = await sharp({
      create: { width: 32, height: 48, channels: 3, background: '#f0f0f0' },
    })
      .png()
      .toBuffer();
    const hash = '1'.repeat(64);
    const first = await renderDocumentImagePdf(image, hash);
    const second = await renderDocumentImagePdf(image, hash);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(MAX_DOCUMENT_IMAGE_PIXELS).toBe(50_000_000);
  });
});
