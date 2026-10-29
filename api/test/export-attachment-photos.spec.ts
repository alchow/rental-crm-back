import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { renderTenantCommunicationLog } from '../src/admin/export-pdf/tenant-communications';
import * as storage from '../src/admin/storage/locator';
import type { AttachmentRow } from '../src/admin/export-pdf/attachments';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=',
  'base64',
);
const attachment: AttachmentRow = {
  id: 'photo',
  account_id: 'account',
  entity_type: 'interactions',
  entity_id: 'record',
  storage_bucket: 'comm-attachments',
  storage_path: 'account/record/photo',
  content_hash: createHash('sha256').update(png).digest('hex'),
  mime_type: 'image/png',
  size_bytes: png.length,
  uploaded_by: null,
  derived_from: null,
  received_at: '2026-10-28T00:00:00Z',
};

async function render(attachments: AttachmentRow[] = [attachment]) {
  return Buffer.from(
    await renderTenantCommunicationLog(
      { accountId: 'account', tenantId: 'tenant', exporter: 'owner' },
      new Date('2026-10-28T00:00:00Z'),
      { ok: true, message: 'verified', broken_at: null, broken_event_no: null },
      { entries: [], casts: new Map(), name: 'Photo sender' },
      attachments,
    ),
  );
}

describe('communication photo exports', () => {
  it('embeds the stored original in the tenant communication PDF', async () => {
    const read = vi.spyOn(storage, 'readAttachmentBytes').mockResolvedValue(png);
    try {
      expect((await render()).includes(Buffer.from('/Subtype /Image'))).toBe(true);
      expect(read).toHaveBeenCalledWith(attachment);
    } finally {
      read.mockRestore();
    }
  });
  it('moves each additional photo to a page with space for its caption and preview', async () => {
    const read = vi.spyOn(storage, 'readAttachmentBytes').mockResolvedValue(png);
    const positions: { page: object; y: number; bottom: number }[] = [];
    const original = PDFDocument.prototype.image;
    const image = vi.spyOn(PDFDocument.prototype, 'image').mockImplementation(function (
      this: PDFKit.PDFDocument,
      source,
      x,
      y,
      options,
    ) {
      positions.push({
        page: this.page,
        y: this.y,
        bottom: this.page.height - this.page.margins.bottom,
      });
      return original.call(this, source, x, y, options);
    });
    try {
      await render(Array.from({ length: 3 }, (_, i) => ({ ...attachment, id: `photo-${i}` })));
      expect(positions).toHaveLength(3);
      expect(new Set(positions.map((position) => position.page)).size).toBe(3);
      expect(positions.every((position) => position.y + 300 <= position.bottom)).toBe(true);
    } finally {
      image.mockRestore();
      read.mockRestore();
    }
  });
  it('keeps an unavailable original explicit without claiming an image preview', async () => {
    const read = vi
      .spyOn(storage, 'readAttachmentBytes')
      .mockRejectedValue(new Error('unavailable'));
    try {
      expect((await render()).includes(Buffer.from('/Subtype /Image'))).toBe(false);
      expect(read).toHaveBeenCalledWith(attachment);
    } finally {
      read.mockRestore();
    }
  });
});
