import type { getAdminClient } from '../supabase-admin';
import { readAttachmentBytes } from '../storage/locator';
import { readAllById } from '../../lib/postgrest-pages';
import { idChunks } from './chunks';

export interface AttachmentRow {
  id: string;
  entity_type: string;
  entity_id: string;
  storage_path: string;
  account_id: string;
  storage_bucket: string | null;
  content_hash: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  derived_from: string | null;
  received_at: string;
}

type AdminClient = ReturnType<typeof getAdminClient>;

const ATTACHMENT_COLS =
  'id, account_id, entity_type, entity_id, storage_bucket, storage_path, content_hash, mime_type, size_bytes, uploaded_by, derived_from, received_at';

export async function loadAttachmentsForEntityIds(
  admin: AdminClient,
  accountId: string,
  entityIds: Iterable<string>,
  opts: { entityType?: string; label: string },
): Promise<AttachmentRow[]> {
  const rows: AttachmentRow[] = [];
  for (const chunk of idChunks(entityIds)) {
    rows.push(
      ...(await readAllById(() => {
        let query = admin
          .from('attachments')
          .select(ATTACHMENT_COLS)
          .eq('account_id', accountId)
          .in('entity_id', chunk)
          .is('deleted_at', null);
        if (opts.entityType) query = query.eq('entity_type', opts.entityType);
        return query;
      }, opts.label)),
    );
  }
  return rows;
}

export async function renderAttachmentPhotos(
  doc: PDFKit.PDFDocument,
  data: {
    attachments: AttachmentRow[];
    uploaderNames?: Map<string, string>;
    intakeTokenById?: Map<string, string>;
  },
  pageOptions: PDFKit.PDFDocumentOptions = { size: 'LETTER', margin: 54 },
): Promise<void> {
  const photoOriginals = data.attachments.filter(
    (a) => a.derived_from === null && a.entity_type !== 'inspection_report',
  );
  if (photoOriginals.length > 0) {
    doc.addPage(pageOptions);
    doc.fontSize(14).text('Photos', doc.page.margins.left, doc.y, { underline: true });
    doc.moveDown(0.3);
    doc
      .fontSize(9)
      .fillColor('#555')
      .text(
        'Each photo shows the original content_hash (chain of custody to the bytes the uploader supplied), ' +
          'when the server received it, and who uploaded it. HEIC originals are embedded via a server-derived ' +
          'JPEG; the identity (hash) shown is the original.',
      )
      .fillColor('#000');
    doc.moveDown(0.5);

    const derivativesByOriginal = new Map<string, AttachmentRow>();
    for (const a of data.attachments) {
      if (a.derived_from) derivativesByOriginal.set(a.derived_from, a);
    }

    for (const p of photoOriginals) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 380) {
        doc.addPage(pageOptions);
        doc.x = doc.page.margins.left;
      }
      const isHeic = p.mime_type === 'image/heic' || p.mime_type === 'image/heif';
      const renderRow = isHeic ? (derivativesByOriginal.get(p.id) ?? p) : p;
      let bytes: Uint8Array | null = null;
      try {
        bytes = await readAttachmentBytes(renderRow);
      } catch {
        /* fall through to placeholder */
      }

      // Chain-of-custody header for this photo (ALWAYS shown, even when
      // bytes can't be downloaded -- the row is the evidence).
      doc
        .fontSize(9)
        .fillColor('#333')
        .text(`received_at: ${p.received_at}    original sha256: ${p.content_hash}`);
      const uploaderActor = p.uploaded_by
        ? `user:${p.uploaded_by} (${data.uploaderNames?.get(p.uploaded_by) ?? p.uploaded_by})`
        : data.intakeTokenById?.has(p.id)
          ? `tenant:${data.intakeTokenById?.get(p.id)}`
          : 'system';
      doc.text(
        `uploader:   ${uploaderActor}    mime: ${p.mime_type ?? '?'}    size: ${p.size_bytes ?? '?'} bytes`,
      );
      doc.fillColor('#000');

      const renderable =
        renderRow.mime_type === 'image/jpeg' || renderRow.mime_type === 'image/png';
      if (bytes && renderable) {
        try {
          const imageY = doc.y;
          doc.image(Buffer.from(bytes), { fit: [400, 300] });
          // PDFKit image orientation can leave its text cursor above the preview.
          doc.y = imageY + 300;
        } catch (e) {
          doc
            .fontSize(9)
            .fillColor('#a00')
            .text(`[failed to embed: ${(e as Error).message}]`)
            .fillColor('#000');
        }
      } else {
        doc
          .fontSize(9)
          .fillColor('#a00')
          .text(
            `[photo ${p.id} of type ${p.mime_type ?? '?'} could not be embedded -- download the original attachment]`,
          )
          .fillColor('#000');
      }
      doc.moveDown(0.8);
    }
  }
}
