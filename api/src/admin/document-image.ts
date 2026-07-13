import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { ApiError } from '../routes/_lib/error';

// Covers current high-resolution phone cameras (including ~48 MP sensors)
// while cutting Sharp's default ~268 MP decompression envelope by >80%.
// The derived PDF only needs a screen/print rendition; the exact full-size
// original remains separately preserved in storage.
export const MAX_DOCUMENT_IMAGE_PIXELS = 50_000_000;
const MAX_RENDITION_EDGE = 4096;

export async function decodeDocumentImageToJpeg(
  originalBytes: Uint8Array,
): Promise<{ data: Buffer; width: number; height: number }> {
  const rendered = await sharp(Buffer.from(originalBytes), {
    limitInputPixels: MAX_DOCUMENT_IMAGE_PIXELS,
    sequentialRead: true,
    failOn: 'error',
  })
    .rotate()
    .resize({
      width: MAX_RENDITION_EDGE,
      height: MAX_RENDITION_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer({ resolveWithObject: true });
  return { data: rendered.data, width: rendered.info.width, height: rendered.info.height };
}

/**
 * Render one uploaded phone image into a deterministic, one-page PDF.
 * The original bytes are stored separately and remain the evidence identity;
 * this PDF is only the usable rendition tenants can view/download/acknowledge.
 */
export async function renderDocumentImagePdf(
  originalBytes: Uint8Array,
  originalHash: string,
): Promise<Uint8Array> {
  let jpeg: Buffer;
  let width: number;
  let height: number;
  try {
    const rendered = await decodeDocumentImageToJpeg(originalBytes);
    jpeg = rendered.data;
    width = rendered.width;
    height = rendered.height;
  } catch (error) {
    throw new ApiError(
      422,
      'invalid_request',
      `image could not be converted to PDF: ${error instanceof Error ? error.message : String(error)}`,
      { fieldErrors: { file: ['image bytes are invalid or use an unsupported codec'] } },
    );
  }

  const landscape = width > height;
  const page: [number, number] = landscape ? [792, 612] : [612, 792];
  const margin = 24;
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: false,
    info: {
      Title: 'Scanned tenancy document',
      Author: 'rentalcrm',
      Producer: 'rentalcrm',
      Creator: 'rentalcrm',
      CreationDate: new Date(0),
      ModDate: new Date(0),
    },
  });

  // PDFKit otherwise generates a random trailer ID, which defeats content
  // idempotency for repeated uploads of byte-identical images.
  const id = createHash('sha256').update(`document-image:${originalHash}`).digest().subarray(0, 16);
  (doc as unknown as { _id: Buffer })._id = id;

  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.once('end', resolve);
    doc.once('error', reject);
  });
  doc.addPage({ size: page, margin: 0 });
  doc.image(jpeg, margin, margin, {
    fit: [page[0] - margin * 2, page[1] - margin * 2],
    align: 'center',
    valign: 'center',
  });
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}
