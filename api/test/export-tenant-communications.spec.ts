import PDFDocument from 'pdfkit';
import { describe, expect, it, vi } from 'vitest';
import { renderTenantCommunicationLog } from '../src/admin/export-pdf/tenant-communications';
import type { ExportScope } from '../src/admin/export-pdf';

type Fragment = { text: string; x: number; y: number; page: number; size: number };

describe('tenant communication PDF layout', () => {
  it('preserves long tokens and multiline evidence across pages without overlapping headers or details', async () => {
    const fragments: Fragment[] = [];
    let page = 0;
    const prototype = PDFDocument.prototype as unknown as {
      _fragment(text: string, x: number, y: number, options: unknown): unknown;
      addPage(options?: unknown): PDFKit.PDFDocument;
    };
    const originalFragment = prototype._fragment;
    const originalAddPage = prototype.addPage;
    const addPage = vi.spyOn(prototype, 'addPage').mockImplementation(function (
      this: PDFKit.PDFDocument,
      options,
    ) {
      page += 1;
      return originalAddPage.call(this, options);
    });
    const fragment = vi.spyOn(prototype, '_fragment').mockImplementation(function (
      this: PDFKit.PDFDocument,
      text,
      x,
      y,
      options,
    ) {
      fragments.push({
        text,
        x,
        y,
        page,
        size: (this as unknown as { _fontSize: number })._fontSize,
      });
      return originalFragment.call(this, text, x, y, options);
    });
    const url = `https://example.com/${'abcdef0123456789'.repeat(800)}`;
    const body = `${url}\n${Array.from({ length: 180 }, (_, i) => `Evidence line ${i}`).join('\n')}\nFINAL EVIDENCE`;
    try {
      const output = await renderTenantCommunicationLog(
        { accountId: 'account', tenantId: 'tenant' } as ExportScope,
        new Date('2026-10-01T12:00:00Z'),
        { ok: true, message: 'verified', broken_at: null, broken_event_no: null },
        {
          name: 'Test person',
          casts: new Map(),
          entries: [
            {
              id: 'record-one',
              body,
              channel: 'sms',
              thread_id: 'thread',
              author_type: 'landlord',
              occurred_at: '2026-10-01T12:00:00Z',
              logged_at: '2026-10-01T12:00:00Z',
            },
          ],
        },
      );
      expect(output.length).toBeGreaterThan(1000);
      expect(page).toBeGreaterThan(2);
      const headers = fragments.filter((f) => f.text.startsWith('Communication log'));
      expect(headers).toHaveLength(page);
      const records = fragments.filter((f) => f.x === 220 && f.size === 10 && f.text !== 'Record');
      expect(
        records
          .map((f) => f.text)
          .join('')
          .replaceAll('\n', ''),
      ).toBe(body.replaceAll('\n', ''));
      for (const f of records) {
        const tableHeading = fragments.find((h) => h.page === f.page && h.text === 'Record');
        expect(tableHeading).toBeDefined();
        expect(f.y).toBeGreaterThanOrEqual(tableHeading!.y + 24);
        expect(f.y + 10).toBeLessThan(842 - 45);
      }
      const lastBody = records.at(-1)!;
      const author = fragments.find((f) => f.text.startsWith('Author:'))!;
      expect(author.page).toBeGreaterThanOrEqual(lastBody.page);
      if (author.page === lastBody.page) expect(author.y).toBeGreaterThan(lastBody.y + 10);
      for (let i = 1; i < records.length; i++) {
        if (records[i]!.page === records[i - 1]!.page)
          expect(records[i]!.y - records[i - 1]!.y).toBeGreaterThan(10);
      }
    } finally {
      fragment.mockRestore();
      addPage.mockRestore();
    }
  });
});
