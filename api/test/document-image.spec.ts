import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { ApiError } from '../src/routes/_lib/error';
import {
  decodeDocumentImageToJpeg,
  MAX_DOCUMENT_IMAGE_PIXELS,
  renderDocumentImagePdf,
} from '../src/admin/document-image';

describe('tenancy document image rendering', () => {
  it('decodes an ordinary web image into a bounded JPEG', async () => {
    const image = await sharp({
      create: { width: 32, height: 48, channels: 3, background: '#f0f0f0' },
    })
      .png()
      .toBuffer();
    const jpeg = await decodeDocumentImageToJpeg(image);
    await expect(sharp(jpeg.data).metadata()).resolves.toMatchObject({ format: 'jpeg' });
    const pdf = await renderDocumentImagePdf(image, '2'.repeat(64));
    expect(Buffer.from(pdf).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('rejects compressed inputs whose decoded pixel count exceeds the product limit', async () => {
    // SVG stays tiny on the wire while declaring a 100 MP canvas. Sharp reads
    // the dimensions before raster allocation and must reject it at our 50 MP
    // boundary rather than expanding it in API memory.
    const pixelBomb = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"><rect width="100%" height="100%" fill="white"/></svg>',
    );
    await expect(renderDocumentImagePdf(pixelBomb, '0'.repeat(64))).rejects.toMatchObject({
      status: 422,
      code: 'invalid_request',
    } satisfies Partial<ApiError>);
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
