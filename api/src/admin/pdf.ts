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
//
// Phase 27 (condition reports): move-in/move-out inspections render extra
// sections (report type/baseline header, per-item group/change_type lines, a
// Checks section, and per-item photos). EVERY new bit is gated on kind or on
// data presence -- a kind='general' inspection has null group/change_type, no
// checks, and no item photos, so its rendering path (and therefore its bytes)
// is UNCHANGED. The pre-existing golden output is preserved.

export interface InspectionPdfPhoto {
  id: string;
  received_at: string;
  content_hash: string;
  mime_type: string | null;
  bytes: Uint8Array; // raw image bytes; pdfkit embeds JPEG/PNG natively
}

export interface InspectionPdfItem {
  id: string;
  label: string;
  condition: string | null;
  notes: string | null;
  created_at: string;
  // Phase 27 (null for legacy 'general' inspections -> not rendered):
  item_key?: string | null;
  group_label?: string | null;
  change_type?: string | null;
  sort_order?: number | null;
  photos?: InspectionPdfPhoto[];
}

export interface InspectionPdfCheck {
  id: string;
  field_key: string;
  label: string;
  group_label: string | null;
  value: unknown;
  sort_order: number | null;
  created_at: string;
}

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
    // Phase 27:
    kind: string;
    baseline_inspection_id?: string | null;
  };
  area: { name: string; kind: string };
  template: { name: string } | null;
  items: InspectionPdfItem[];
  checks?: InspectionPdfCheck[];
  photos: InspectionPdfPhoto[];
}

// Embed one photo + its provenance caption. Extracted verbatim from the
// original inline loop so the 'general' Photos section stays byte-identical;
// reused for per-item photos.
function embedPhoto(doc: PDFKit.PDFDocument, p: InspectionPdfPhoto): void {
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

function photoSort(a: InspectionPdfPhoto, b: InspectionPdfPhoto): number {
  const c = a.received_at.localeCompare(b.received_at);
  return c !== 0 ? c : a.id.localeCompare(b.id);
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
  // Phase 27: report-type + baseline header (skipped for 'general' -> bytes
  // unchanged for legacy reports).
  if (input.inspection.kind !== 'general') {
    doc.text(`Report type:   ${input.inspection.kind}`);
    if (input.inspection.baseline_inspection_id) {
      doc.text(`Baseline insp: ${input.inspection.baseline_inspection_id}`);
    }
  }
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
  // sort_order (Phase 27, canonical form order) wins when present; legacy
  // items have null sort_order so they fall through to created_at/id exactly
  // as before.
  const items = [...input.items].sort((a, b) => {
    const sa = a.sort_order ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sort_order ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    const c = a.created_at.localeCompare(b.created_at);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });
  if (items.length === 0) {
    doc.fontSize(10).fillColor('#555').text('(no items)').fillColor('#000');
  } else {
    for (const it of items) {
      doc.fontSize(11).text(`• ${it.label}`);
      if (it.group_label) doc.fontSize(10).fillColor('#333').text(`  area: ${it.group_label}`);
      if (it.condition) doc.fontSize(10).fillColor('#333').text(`  condition: ${it.condition}`);
      if (it.change_type) doc.fontSize(10).fillColor('#333').text(`  change: ${it.change_type}`);
      if (it.notes)     doc.fontSize(10).fillColor('#333').text(`  notes: ${it.notes}`);
      doc.fillColor('#000');
      doc.moveDown(0.2);
    }
  }

  // ---- checks (Phase 27; skipped when empty -> bytes unchanged) -----------
  if (input.checks && input.checks.length > 0) {
    doc.moveDown(1);
    doc.fontSize(14).text('Checks', { underline: true });
    doc.moveDown(0.3);
    const checks = [...input.checks].sort((a, b) => {
      const sa = a.sort_order ?? Number.MAX_SAFE_INTEGER;
      const sb = b.sort_order ?? Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      const c = a.created_at.localeCompare(b.created_at);
      return c !== 0 ? c : a.id.localeCompare(b.id);
    });
    for (const ck of checks) {
      const val =
        ck.value === null || ck.value === undefined
          ? ''
          : typeof ck.value === 'string'
            ? ck.value
            : JSON.stringify(ck.value);
      doc.fontSize(11).text(`• ${ck.label}: ${val}`);
      if (ck.group_label) {
        doc.fontSize(10).fillColor('#333').text(`  area: ${ck.group_label}`).fillColor('#000');
      }
      doc.moveDown(0.2);
    }
  }

  // ---- inspection-level photos --------------------------------------------
  const photos = [...input.photos].sort(photoSort);

  if (photos.length > 0) {
    doc.addPage({ size: 'LETTER', margin: 54 });
    doc.fontSize(14).text('Photos', { underline: true });
    doc.moveDown(0.5);
    for (const p of photos) {
      // pdfkit embeds JPEG and PNG natively; we accept HEIC at the upload
      // layer (it stays in storage) but the report-builder skips embedding
      // anything pdfkit can't render (rather than failing the whole PDF).
      embedPhoto(doc, p);
    }
  }

  // ---- per-item photos (Phase 27; skipped when none -> bytes unchanged) ----
  const itemsWithPhotos = items.filter((it) => it.photos && it.photos.length > 0);
  if (itemsWithPhotos.length > 0) {
    doc.addPage({ size: 'LETTER', margin: 54 });
    doc.fontSize(14).text('Item Photos', { underline: true });
    doc.moveDown(0.5);
    for (const it of itemsWithPhotos) {
      const heading = it.group_label ? `${it.group_label} — ${it.label}` : it.label;
      doc.fontSize(11).fillColor('#000').text(heading);
      doc.moveDown(0.2);
      for (const p of [...it.photos!].sort(photoSort)) {
        embedPhoto(doc, p);
      }
      doc.moveDown(0.4);
    }
  }

  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

// Load an entity's photos as renderable bytes. Originals (derived_from null)
// drive identity; for a HEIC original we embed its server-derived JPEG instead
// (pdfkit can't render HEIC) while KEEPING the original's content_hash as the
// chain-of-custody identity. Mirrors the Phase 9 behaviour for inspection
// photos; reused for both entity_type='inspections' and 'inspection_items'.
async function loadRenderablePhotos(
  admin: ReturnType<typeof getAdminClient>,
  accountId: string,
  entityType: 'inspections' | 'inspection_items',
  entityId: string,
): Promise<InspectionPdfPhoto[]> {
  const metas = await admin
    .from('attachments')
    .select('id, received_at, content_hash, mime_type, storage_path, derived_from')
    .eq('account_id', accountId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .is('deleted_at', null);
  if (metas.error) throw new Error(`photo metas query failed: ${metas.error.message}`);
  const allRows = (metas.data ?? []) as Array<{
    id: string; received_at: string; content_hash: string;
    mime_type: string | null; storage_path: string; derived_from: string | null;
  }>;
  const originals = allRows.filter((r) => r.derived_from === null);
  const derivativesByOriginal = new Map<string, typeof allRows[number]>();
  for (const r of allRows) {
    if (r.derived_from !== null) derivativesByOriginal.set(r.derived_from, r);
  }

  return Promise.all(
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
        received_at: p.received_at,
        content_hash: p.content_hash,
        mime_type: renderRow.mime_type,
        bytes,
      };
    }),
  );
}

/**
 * Composes the inspection PDF for a given inspection id, hashes the result,
 * and stores it as an attachment of entity_type='inspection_report'.
 * Returns the attachment row plus the hash.
 *
 * IDEMPOTENT: the PDF is byte-deterministic, so if a live inspection_report
 * attachment with the SAME content hash already exists for this inspection we
 * reuse it (no delete/insert) -- otherwise a re-run would strand the
 * document_versions.attachment_id pointing at a now-soft-deleted row. Only a
 * genuine renderer change (different bytes) replaces the report; the document
 * emitter then bumps the version pointing at the new row.
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

  const insp = await admin
    .from('inspections')
    .select(
      'id, account_id, area_id, template_id, performed_by, performed_at, completed_at, notes, kind, baseline_inspection_id',
    )
    .eq('id', opts.inspectionId)
    .single();
  if (insp.error || !insp.data) throw new Error(`inspection not found: ${insp.error?.message}`);
  const i = insp.data as {
    id: string; account_id: string; area_id: string; template_id: string | null;
    performed_by: string | null; performed_at: string | null;
    completed_at: string | null; notes: string | null;
    kind: string; baseline_inspection_id: string | null;
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

  const itemsRes = await admin
    .from('inspection_items')
    .select('id, label, condition, notes, created_at, item_key, group_label, change_type, sort_order')
    .eq('inspection_id', i.id)
    .is('deleted_at', null);
  if (itemsRes.error) throw new Error(`items query failed: ${itemsRes.error.message}`);
  const itemRows = (itemsRes.data ?? []) as InspectionPdfItem[];

  const checksRes = await admin
    .from('inspection_checks')
    .select('id, field_key, label, group_label, value, sort_order, created_at')
    .eq('account_id', opts.accountId)
    .eq('inspection_id', i.id)
    .is('deleted_at', null);
  if (checksRes.error) throw new Error(`checks query failed: ${checksRes.error.message}`);
  const checks = (checksRes.data ?? []) as InspectionPdfCheck[];

  // Inspection-level photos (entity_type='inspections') -- the legacy section.
  const photos = await loadRenderablePhotos(admin, opts.accountId, 'inspections', i.id);

  // Per-item photos (entity_type='inspection_items'). Attach to each item so
  // the report can group them under the item they document.
  const items = await Promise.all(
    itemRows.map(async (it) => ({
      ...it,
      photos: await loadRenderablePhotos(admin, opts.accountId, 'inspection_items', it.id),
    })),
  );

  const pdfBytes = await renderInspectionPdf({
    inspection: { ...i, completed_at: i.completed_at },
    area: area.data as { name: string; kind: string },
    template,
    items,
    checks,
    photos,
  });

  const contentHash = createHash('sha256').update(pdfBytes).digest('hex');

  // Idempotency: a live report row with the SAME bytes already exists? reuse it.
  const existing = await admin
    .from('attachments')
    .select('id, content_hash, size_bytes')
    .eq('account_id', opts.accountId)
    .eq('entity_type', 'inspection_report')
    .eq('entity_id', i.id)
    .is('deleted_at', null);
  if (existing.error) throw new Error(`report lookup failed: ${existing.error.message}`);
  const sameHash = (existing.data ?? []).find(
    (r) => (r as { content_hash: string }).content_hash === contentHash,
  ) as { id: string; size_bytes: number | null } | undefined;
  if (sameHash) {
    return {
      attachment_id: sameHash.id,
      content_hash: contentHash,
      size_bytes: sameHash.size_bytes ?? pdfBytes.byteLength,
    };
  }

  // Phase 9: content-addressed path -- same scheme as processAndStoreBytes()
  // uses for user uploads. The inspection_id is captured on the attachments
  // row's entity_id, not in the path.
  const storagePath = `${opts.accountId}/${contentHash}.pdf`;
  const { error: upErr } = await admin.storage.from('attachments').upload(
    storagePath,
    pdfBytes,
    { contentType: 'application/pdf', upsert: true },
  );
  if (upErr) throw new Error(`pdf upload failed: ${upErr.message}`);

  // Replace any previous report (a renderer change -> different hash) so there
  // is a SINGLE current report row. Old rows stay in events history.
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
