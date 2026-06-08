import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { getAdminClient } from './supabase-admin';

// ============================================================================
// Deterministic inspection PDF rendering.
// ============================================================================
//
// Why deterministic: the rendered PDF is stored as an attachment with its
// own content hash; if rendering the same inspection twice produces
// different bytes, the hash means nothing. The Phase 10 evidence export
// will use this same approach for the bundled report -- the inspection PDF
// is the dress rehearsal.
//
// pdfkit's non-determinism comes from:
//   1. info.CreationDate / ModDate default to new Date()
//   2. info.Producer / Creator default to "PDFKit"
//   3. File ID (PDF trailer /ID) defaults to a random pair
//   4. Embedded fonts can be subset differently across runs
//
// We pin all four:
//   1+2: explicit info { ... } with the inspection's completed_at as both
//        CreationDate and ModDate;
//   3:   _id set to a deterministic pair derived from the inspection id;
//   4:   Helvetica (one of the 14 PDF base fonts that PDF readers ship
//        natively -- not embedded, not subset, byte-identical across runs).

export interface InspectionPdfInput {
  inspection: {
    id: string;
    account_id: string;
    area_id: string;
    template_id: string | null;
    performed_by: string | null;
    performed_at: string | null;
    completed_at: string;
    notes: string | null;
  };
  area: { name: string; kind: string };
  template: { name: string } | null;
  items: Array<{
    id: string;
    label: string;
    condition: string | null;
    notes: string | null;
    created_at: string;
  }>;
  photos: Array<{
    id: string;
    received_at: string;
    content_hash: string;
    mime_type: string | null;
    bytes: Uint8Array; // raw image bytes; pdfkit embeds JPEG/PNG natively
  }>;
}

/**
 * Renders an inspection to a deterministic PDF.
 *
 * Returns the raw bytes; callers content-hash and persist them.
 */
export async function renderInspectionPdf(input: InspectionPdfInput): Promise<Uint8Array> {
  // ---- determinism setup --------------------------------------------------
  // The completed_at is the canonical timestamp for the report. Use it for
  // both CreationDate and ModDate -- subsequent edits are impossible
  // (the DB trigger forbids them) so ModDate has no other meaningful value.
  const completedAt = new Date(input.inspection.completed_at);

  // The PDF trailer /ID is two hex strings. Derive both from the
  // inspection id so identical inputs produce identical IDs.
  const idHash = createHash('sha256').update(input.inspection.id).digest();
  const fileId = [idHash.subarray(0, 16), idHash.subarray(16, 32)];

  const doc = new PDFDocument({
    autoFirstPage: false,
    info: {
      Title: `Inspection ${input.inspection.id}`,
      Author: 'rentalcrm',
      Producer: 'rentalcrm',
      Creator: 'rentalcrm',
      CreationDate: completedAt,
      ModDate: completedAt,
    },
    // pdfkit reads the trailer ID from _id if present (set below). The
    // options object doesn't have a public `id` field, so we patch after
    // construction.
  });
  // Pin the trailer ID. The cast avoids reaching into pdfkit's internal
  // typing -- this is documented in pdfkit's spec but not in its types.
  (doc as unknown as { _id: Buffer[] })._id = fileId;

  // ---- buffer the output --------------------------------------------------
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', (e) => reject(e));
  });

  // ---- content ------------------------------------------------------------
  doc.addPage({ size: 'LETTER', margin: 54 });
  doc.font('Helvetica');

  doc.fontSize(20).text('Inspection Report', { align: 'left' });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#555').text(`Inspection ID: ${input.inspection.id}`);
  doc.text(`Account ID:    ${input.inspection.account_id}`);
  doc.text(`Area:          ${input.area.name} (${input.area.kind})`);
  if (input.template) doc.text(`Template:      ${input.template.name}`);
  if (input.inspection.performed_at) {
    doc.text(`Performed at:  ${input.inspection.performed_at}`);
  }
  doc.text(`Completed at:  ${input.inspection.completed_at}`);
  if (input.inspection.notes) {
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#000').text('Notes', { underline: true });
    doc.fontSize(10).fillColor('#000').text(input.inspection.notes);
  }
  doc.fillColor('#000');

  // ---- items --------------------------------------------------------------
  doc.moveDown(1);
  doc.fontSize(14).text('Items', { underline: true });
  doc.moveDown(0.3);

  // Sort items deterministically -- the test asserts byte-equivalence
  // across renders, so any unordered iteration would break determinism.
  const items = [...input.items].sort((a, b) => {
    const c = a.created_at.localeCompare(b.created_at);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });
  if (items.length === 0) {
    doc.fontSize(10).fillColor('#555').text('(no items)').fillColor('#000');
  } else {
    for (const it of items) {
      doc.fontSize(11).text(`• ${it.label}`);
      if (it.condition) doc.fontSize(10).fillColor('#333').text(`  condition: ${it.condition}`);
      if (it.notes)     doc.fontSize(10).fillColor('#333').text(`  notes: ${it.notes}`);
      doc.fillColor('#000');
      doc.moveDown(0.2);
    }
  }

  // ---- photos -------------------------------------------------------------
  const photos = [...input.photos].sort((a, b) => {
    const c = a.received_at.localeCompare(b.received_at);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });

  if (photos.length > 0) {
    doc.addPage({ size: 'LETTER', margin: 54 });
    doc.fontSize(14).text('Photos', { underline: true });
    doc.moveDown(0.5);
    for (const p of photos) {
      // pdfkit embeds JPEG and PNG natively; we accept HEIC at the upload
      // layer (it stays in storage) but the report-builder skips embedding
      // anything pdfkit can't render (rather than failing the whole PDF).
      if (p.mime_type === 'image/jpeg' || p.mime_type === 'image/png') {
        try {
          doc.image(Buffer.from(p.bytes), { fit: [400, 300] });
        } catch (e) {
          doc.fontSize(10).fillColor('#a00').text(
            `[failed to embed photo ${p.id} (${(e as Error).message})]`,
          ).fillColor('#000');
        }
      } else {
        doc.fontSize(10).fillColor('#555').text(
          `[photo ${p.id} of type ${p.mime_type ?? 'unknown'} -- not embedded]`,
        ).fillColor('#000');
      }
      doc.fontSize(8).fillColor('#666').text(
        `received_at: ${p.received_at}    sha256: ${p.content_hash}`,
        { align: 'left' },
      ).fillColor('#000');
      doc.moveDown(0.8);
    }
  }

  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Composes the inspection PDF for a given inspection id, hashes the result,
 * and stores it as an attachment of entity_type='inspection_report'.
 * Returns the attachment row plus the hash.
 *
 * Mutating: takes the inspection -> completed_at lock + writes the report.
 * Callers should run this inside the inspection-completion endpoint AFTER
 * setting completed_at; the DB trigger keeps the inspection immutable
 * thereafter.
 */
export async function generateAndStoreInspectionReport(opts: {
  accountId: string;
  inspectionId: string;
}): Promise<{ attachment_id: string; content_hash: string; size_bytes: number }> {
  const admin = getAdminClient();

  // Load the inspection, the area, the template, the items, and the photos
  // (attachments where entity_type='inspections' and entity_id=this id).
  const insp = await admin
    .from('inspections')
    .select('id, account_id, area_id, template_id, performed_by, performed_at, completed_at, notes')
    .eq('id', opts.inspectionId)
    .single();
  if (insp.error || !insp.data) throw new Error(`inspection not found: ${insp.error?.message}`);
  const i = insp.data as {
    id: string; account_id: string; area_id: string; template_id: string | null;
    performed_by: string | null; performed_at: string | null;
    completed_at: string | null; notes: string | null;
  };
  if (!i.completed_at) throw new Error('cannot render a non-completed inspection');

  const area = await admin
    .from('areas')
    .select('name, kind')
    .eq('id', i.area_id)
    .single();
  if (area.error || !area.data) throw new Error(`area not found: ${area.error?.message}`);

  let template: { name: string } | null = null;
  if (i.template_id) {
    const tpl = await admin.from('inspection_templates').select('name').eq('id', i.template_id).maybeSingle();
    template = (tpl.data as { name: string } | null) ?? null;
  }

  const items = await admin
    .from('inspection_items')
    .select('id, label, condition, notes, created_at')
    .eq('inspection_id', i.id)
    .is('deleted_at', null);
  if (items.error) throw new Error(`items query failed: ${items.error.message}`);

  // Photos = attachments tied to this inspection. Phase 9: an iPhone HEIC
  // upload produces TWO rows -- the original HEIC plus a server-derived
  // JPEG with derived_from = original.id. We list the ORIGINALS only
  // (derived_from is null) and then, for each HEIC original, look up its
  // JPEG derivative and embed THAT into the PDF in place of the HEIC. The
  // photo's identity in the report stays the original's content_hash so
  // chain of custody points at the bytes the tenant actually uploaded;
  // the JPEG is just the renderable substitute the server produced. If
  // the derivative is missing (transcoding failed at upload time), we
  // fall through to the HEIC bytes, which pdfkit will placeholder.
  const photoMetas = await admin
    .from('attachments')
    .select('id, received_at, content_hash, mime_type, storage_path, derived_from')
    .eq('account_id', opts.accountId)
    .eq('entity_type', 'inspections')
    .eq('entity_id', i.id)
    .is('deleted_at', null);
  if (photoMetas.error) throw new Error(`photo metas query failed: ${photoMetas.error.message}`);
  const allRows = (photoMetas.data ?? []) as Array<{
    id: string; received_at: string; content_hash: string;
    mime_type: string | null; storage_path: string; derived_from: string | null;
  }>;
  const originals = allRows.filter((r) => r.derived_from === null);
  const derivativesByOriginal = new Map<string, typeof allRows[number]>();
  for (const r of allRows) {
    if (r.derived_from !== null) derivativesByOriginal.set(r.derived_from, r);
  }

  const photos = await Promise.all(
    originals.map(async (p) => {
      const isHeic = p.mime_type === 'image/heic' || p.mime_type === 'image/heif';
      const renderRow = isHeic ? (derivativesByOriginal.get(p.id) ?? p) : p;
      const dl = await admin.storage.from('attachments').download(renderRow.storage_path);
      if (dl.error || !dl.data) {
        throw new Error(`photo download failed for ${p.id}: ${dl.error?.message}`);
      }
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      return {
        id: p.id,
        // Always show the ORIGINAL's content_hash in the report -- that's
        // the chain-of-custody identity. The derivative is an
        // implementation detail of rendering.
        received_at: p.received_at,
        content_hash: p.content_hash,
        // mime_type drives the embedder branch in renderInspectionPdf; use
        // the renderable row's mime so JPEG-derived-from-HEIC actually
        // embeds (instead of hitting the HEIC placeholder branch).
        mime_type: renderRow.mime_type,
        bytes,
      };
    }),
  );

  const pdfBytes = await renderInspectionPdf({
    inspection: { ...i, completed_at: i.completed_at },
    area: area.data as { name: string; kind: string },
    template,
    items: (items.data ?? []) as InspectionPdfInput['items'],
    photos,
  });

  const contentHash = createHash('sha256').update(pdfBytes).digest('hex');
  // Phase 9: content-addressed path -- same scheme as
  // processAndStoreBytes() uses for user uploads. The inspection_id is
  // captured on the attachments row's entity_id, not in the path.
  const storagePath = `${opts.accountId}/${contentHash}.pdf`;
  const { error: upErr } = await admin.storage.from('attachments').upload(
    storagePath,
    pdfBytes,
    { contentType: 'application/pdf', upsert: true },
  );
  if (upErr) throw new Error(`pdf upload failed: ${upErr.message}`);

  // If a previous report was already stored for this inspection (different
  // hash from a previous code version?), soft-delete it so there is a
  // SINGLE current report row. Old rows stay in events history per the
  // audit spine.
  await admin
    .from('attachments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('account_id', opts.accountId)
    .eq('entity_type', 'inspection_report')
    .eq('entity_id', i.id)
    .is('deleted_at', null);

  const { data: row, error: insErr } = await admin
    .from('attachments')
    .insert({
      account_id: opts.accountId,
      entity_type: 'inspection_report',
      entity_id: i.id,
      storage_path: storagePath,
      content_hash: contentHash,
      mime_type: 'application/pdf',
      size_bytes: pdfBytes.byteLength,
    })
    .select('id')
    .single();
  if (insErr || !row) {
    await admin.storage.from('attachments').remove([storagePath]).catch(() => {});
    throw new Error(`report attachment insert failed: ${insErr?.message}`);
  }
  return {
    attachment_id: row.id as string,
    content_hash: contentHash,
    size_bytes: pdfBytes.byteLength,
  };
}
