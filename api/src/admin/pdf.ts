import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { getAdminClient } from './supabase-admin';
import { storeGeneratedArtifactBytes } from './storage';

// Deterministic inspection PDF rendering. Content hashes are meaningful only
// if identical input yields identical bytes, so pin PDF dates, metadata, file
// ID, and base font. Condition-only sections are gated by kind/data; `general`
// inspections retain the legacy byte path and golden output.

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
  // Null for legacy `general` inspections; omitted from their reports.
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
    // Condition-report fields:
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
  // Report type and baseline are skipped for `general`, preserving legacy bytes.
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
  // Canonical sort_order wins when present; legacy
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

  // ---- checks (skipped when empty to preserve legacy bytes) --------------
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

  // ---- per-item photos (skipped when none to preserve legacy bytes) -------
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
// chain-of-custody identity. This behavior is shared by inspection
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
 * Render, hash, and store an inspection report. Reuse an existing live report
 * with the same hash so reruns cannot strand document_versions; only changed
 * bytes create a replacement. Call after setting completed_at, which locks the
 * inspection against further mutation.
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

  // Use the same content-addressed path as processAndStoreBytes().
  // uses for user uploads. The inspection_id is captured on the attachments
  // row's entity_id, not in the path.
  const stored = await storeGeneratedArtifactBytes(opts.accountId, pdfBytes, 'application/pdf');
  const storagePath = stored.storagePath;

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
    throw new Error(`report attachment insert failed: ${insErr?.message}`);
  }
  return {
    attachment_id: row.id as string,
    content_hash: contentHash,
    size_bytes: pdfBytes.byteLength,
  };
}
