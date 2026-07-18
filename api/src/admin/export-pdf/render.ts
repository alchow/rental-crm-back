import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { getAdminClient } from '../supabase-admin';
import type { AttachmentRow, ChainStatus, ExportData, ExportScope } from '../export-pdf';
import { deriveLedger, inRangeISO } from './ledger';
import {
  groupInteractionChains,
  interactionCastDisplay,
  interactionPartyDisplay,
  retractedInteractionMarker,
} from './interactions';

// ---- PDF rendering ----------------------------------------------------------

interface RenderInput {
  scope: ExportScope;
  generatedAt: Date;
  chain: ChainStatus;
  data: ExportData;
}

function fmtMoney(cents: number, currency: string | null): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${(abs / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

export async function renderExportPdf(input: RenderInput): Promise<Uint8Array> {
  const { scope, generatedAt, chain, data } = input;
  const fromDate = scope.fromDate ?? null;
  const toDate = scope.toDate ?? null;
  const ledger = deriveLedger(data, fromDate, toDate);

  // PDF info dict + file id derived from (scope, generatedAt) so each
  // export has a stable identity within its own bytes. Unlike the inspection
  // report we do NOT pin info to a fixed timestamp -- two exports differ
  // (that's the point: snapshot at THIS generation).
  const fileIdSeed = createHash('sha256')
    .update(
      `${scope.accountId}|${scope.tenancyId ?? ''}|${scope.areaId ?? ''}|${generatedAt.toISOString()}`,
    )
    .digest();
  const fileId = [fileIdSeed.subarray(0, 16), fileIdSeed.subarray(16, 32)];

  const doc = new PDFDocument({
    autoFirstPage: false,
    // compress: false makes the content streams human-readable in the
    // PDF. The bundle gets a bit larger but stays well under the
    // generated-artifact cap. The real reason: forensic readability --
    // a litigant who needs to grep the PDF for a specific hash should be
    // able to do that without a special tool.
    compress: false,
    info: {
      Title: `Evidence Export — ${data.account_name}`,
      Author: 'rentalcrm',
      Producer: 'rentalcrm',
      Creator: 'rentalcrm',
      CreationDate: generatedAt,
      ModDate: generatedAt,
    },
  });
  (doc as unknown as { _id: Buffer[] })._id = fileId;

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', (e) => reject(e));
  });

  doc.addPage({ size: 'LETTER', margin: 54 });
  doc.font('Helvetica');

  // ----- Title + scope ------------------------------------------------------
  doc.fontSize(20).text('Evidence Export', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(11).fillColor('#333');
  doc.text(`Account:       ${data.account_name} (${scope.accountId})`);
  if (data.property) doc.text(`Property:      ${(data.property.name as string) ?? ''}`);
  if (data.area)
    doc.text(
      `Area:          ${(data.area.name as string) ?? ''} (${(data.area.kind as string) ?? ''})`,
    );
  if (data.tenancy) {
    doc.text(`Tenancy:       ${data.tenancy.id as string}`);
    doc.text(
      `Tenancy span:  ${data.tenancy.start_date as string} → ${(data.tenancy.end_date as string) ?? 'open'}`,
    );
    doc.text(
      `Tenancy state: ${data.tenancy.status as string}${data.tenancy.deleted_at ? ' (soft-deleted)' : ''}`,
    );
  }
  if (scope.fromDate || scope.toDate) {
    doc.text(`Date range:    ${scope.fromDate ?? '∞'} → ${scope.toDate ?? '∞'}`);
  }
  doc.text(`Generated at:  ${generatedAt.toISOString()}`);
  if (scope.exporter) doc.text(`Exported by:   user:${scope.exporter}`);
  doc.fillColor('#000');

  // ----- Chain verification banner -----------------------------------------
  doc.moveDown(1);
  const banner = chain.ok
    ? { bg: '#e6f4ea', fg: '#1e5a2c', label: 'AUDIT CHAIN VERIFIED INTACT' }
    : { bg: '#fbe9e7', fg: '#a02810', label: 'AUDIT CHAIN BROKEN — TAMPER SUSPECTED' };
  const bannerY = doc.y;
  doc.save();
  doc.rect(54, bannerY, 504, 44).fill(banner.bg);
  doc.restore();
  doc
    .fillColor(banner.fg)
    .fontSize(13)
    .text(banner.label, 60, bannerY + 6, { width: 492 });
  doc.fontSize(9).text(chain.message, 60, bannerY + 24, { width: 492 });
  doc.fillColor('#000').y = bannerY + 50;

  // ----- Lease(s) -----------------------------------------------------------
  section(doc, 'Lease(s)');
  if (data.leases.length === 0) {
    italicNote(doc, '(no leases recorded for this tenancy)');
  } else {
    for (const ls of data.leases) {
      doc
        .fontSize(10)
        .text(
          `• ${ls.status as string}   ${ls.term_start as string} → ${(ls.term_end as string) ?? 'open'}` +
            `   rent ${fmtMoney(ls.rent_amount_cents as number, ls.rent_currency as string)}` +
            (ls.deposit_amount_cents
              ? `   deposit ${fmtMoney(ls.deposit_amount_cents as number, (ls.deposit_currency as string) ?? (ls.rent_currency as string))}`
              : ''),
        );
    }
  }

  // ----- Occupants ----------------------------------------------------------
  section(doc, 'Occupants');
  if (data.occupants.length === 0) {
    italicNote(doc, '(no occupants on file)');
  } else {
    for (const o of data.occupants) {
      const t = (o as { tenants?: { full_name: string } }).tenants;
      doc.fontSize(10).text(`• ${t?.full_name ?? '(no name)'}   role=${o.role as string}`);
    }
  }

  // ----- Rent ledger --------------------------------------------------------
  section(doc, 'Rent ledger');
  doc.fontSize(11);
  if (fromDate) {
    // Phase 11 flag B: the opening balance is the carried-in debt at the
    // start of the date range. Without it, a narrowed-range bundle would
    // misstate the actual obligation.
    doc.text(
      `Opening balance as of ${fromDate}:  ${fmtMoney(ledger.opening_balance_cents, ledger.currency)}` +
        (ledger.opening_balance_cents > 0 ? '  (carried in)' : ''),
    );
  }
  doc.text(
    `Rent charged${fromDate || toDate ? ' (in range)' : ''}:  ${fmtMoney(ledger.rent_charges_in_range_cents, ledger.currency)}`,
  );
  doc.text(
    `Rent paid${fromDate || toDate ? ' (in range)' : ''}:     ${fmtMoney(ledger.rent_payments_in_range_cents, ledger.currency)}`,
  );
  doc.text(
    `Closing balance${fromDate ? ` as of ${toDate ?? 'now'}` : ''}:  ${fmtMoney(ledger.closing_balance_cents, ledger.currency)}` +
      (ledger.closing_balance_cents > 0
        ? '  (owed by tenant)'
        : ledger.closing_balance_cents < 0
          ? '  (overpaid)'
          : ''),
  );
  doc.text(
    `Deposit held:   ${fmtMoney(ledger.deposit_payments_cents, ledger.currency)}` +
      ` / charged ${fmtMoney(ledger.deposit_charges_cents, ledger.currency)}`,
  );
  if (ledger.unapplied_credit_cents > 0) {
    doc
      .fillColor('#7a1e1e')
      .text(
        `Unapplied credit: ${fmtMoney(ledger.unapplied_credit_cents, ledger.currency)}  (money received but not allocated -- may be owed back)`,
      )
      .fillColor('#000');
  }

  // Charge / payment listings: in-range only when a range is set. Charges
  // BEFORE the range that are still open contribute via the opening
  // balance above (their detail is intentionally suppressed -- the goal
  // of a date-narrowed bundle is to spotlight activity, with carry-in
  // summarised). We always include voided rows so a litigant sees that
  // the void happened (not just the absence).
  const isInRangeCharge = (due: string) =>
    (!fromDate || due >= fromDate) && (!toDate || due <= toDate);
  const isInRangePayment = (received: string) => inRangeISO(received, fromDate, toDate);

  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#333');
  doc.text(`Charges${fromDate || toDate ? ' (in range)' : ''}:`);
  const chargesSorted = [...data.charges].sort((a, b) =>
    String(a.due_date).localeCompare(String(b.due_date)),
  );
  let renderedCharges = 0;
  for (const cr of chargesSorted) {
    if (!isInRangeCharge(cr.due_date as string)) continue;
    const v = cr.voided_at ? ' [VOID]' : '';
    doc.text(
      `  ${cr.due_date as string}  ${(cr.type as string).padEnd(10)}  ${fmtMoney(cr.amount_cents as number, cr.currency as string)}${v}`,
    );
    renderedCharges += 1;
  }
  if (renderedCharges === 0) doc.text('  (none in range)');

  doc.moveDown(0.3);
  doc.text(`Payments + allocations${fromDate || toDate ? ' (in range)' : ''}:`);
  const paymentsSorted = [...data.payments].sort((a, b) =>
    String(a.received_at).localeCompare(String(b.received_at)),
  );
  let renderedPayments = 0;
  for (const pr of paymentsSorted) {
    if (!isInRangePayment(pr.received_at as string)) continue;
    const v = pr.voided_at ? ' [VOID]' : '';
    doc.text(
      `  ${pr.received_at as string}  via ${pr.method as string}  ${fmtMoney(pr.amount_cents as number, pr.currency as string)}${v}`,
    );
    const allocs = data.allocations.filter((a) => a.payment_id === pr.id);
    for (const a of allocs) {
      const ch = data.charges.find((c) => c.id === a.charge_id);
      doc.text(
        `     → ${fmtMoney(a.amount_cents as number, (ch?.currency as string) ?? '')} to charge ${(ch?.due_date as string) ?? '?'} (${(ch?.type as string) ?? '?'})`,
      );
    }
    renderedPayments += 1;
  }
  if (renderedPayments === 0) doc.text('  (none in range)');
  doc.fillColor('#000');

  // ----- Interactions -------------------------------------------------------
  // Full chains, ALWAYS: for a corrected entry, the original renders first
  // (its own occurred_at/logged_at/body), then each correction with its own
  // logged_at, labeled Corrected/Retracted. Retracted entries stay visible,
  // withdrawn with their reason. Showing only the latest would make a
  // good-faith correction look like a concealed edit -- completeness is the
  // point of this artifact. A SOFT-DELETED row (an unverified-journal receipt
  // retracted with a reason, 20260723000003) renders as a marker line only —
  // present (never silently omitted from a legal bundle) but stripped of the
  // repudiated content (retractedInteractionMarker).
  section(doc, 'Interactions');
  if (data.interactions.length === 0) {
    italicNote(doc, '(no interactions in scope)');
  } else {
    doc.fontSize(9).fillColor('#333');
    for (const chain of groupInteractionChains(data.interactions)) {
      const root = chain.root;
      if (root.deleted_at) {
        doc.text(
          `• ${root.occurred_at as string}  ${retractedInteractionMarker(root, data.uploaderNames)}`,
        );
        continue;
      }
      const what =
        root.kind === 'note'
          ? 'note'.padEnd(19)
          : root.kind === 'agent_event'
            ? `agent:${root.entry_type as string}`.padEnd(19)
            : `${(root.direction as string).padEnd(8)} ${(root.channel as string).padEnd(10)}`;
      // Authorship capacity (post-capacity-migration rows). Agent-authored
      // entries carry the approval trail the chain protects; rendering it is
      // the point of the capacity fields. Legacy rows show actor= alone.
      const capacity = root.author_type
        ? `  capacity=${root.author_type as string}` +
          (root.author_type === 'agent'
            ? `  approved_by=${(root.approved_by as string | null) ?? '—'}  approval_ref=${(root.approval_ref as string | null) ?? '—'}`
            : '')
        : '';
      const sid = root.external_ref ? `  provider_ref=${root.external_ref as string}` : '';
      // Trust tier (EV-A rework): how the record is known. provider_verified
      // = carrier-confirmed transmission (DB-gated); attested = someone's
      // account of an off-platform event; imported = bulk import. Legacy
      // rows (null) render nothing rather than implying a tier.
      const att = root.attestation ? `  attestation=${root.attestation as string}` : '';
      // Never overclaim: 'sent' = provider accepted; only 'delivered' means
      // a delivery receipt arrived. Rendered separately from attestation.
      const delivery = data.deliveryByInteraction.get(String(root.id));
      const deliveryStr = delivery
        ? `  delivery=${delivery.status}${delivery.delivered_at ? ` @ ${delivery.delivered_at}` : ''}`
        : '';
      // Counterparty (PR 2): communications now name who they were with --
      // resolved tenant/vendor name, else party_label, else party_type
      // ('unspecified' for a role-unknown capture). Notes/agent_events: none.
      const party = interactionPartyDisplay(root, data.partyNames);
      doc.text(
        `• ${root.occurred_at as string}  ${what}${party ? `  with ${party}` : ''}  ` +
          `actor=${root.actor as string}${capacity}${sid}${att}${deliveryStr}  (logged ${root.logged_at as string})`,
      );
      // The cast: everyone on this event, by role, as named people. This is
      // where a group message stops reading as a comma-string of numbers.
      const castLine = interactionCastDisplay(
        data.castByInteraction.get(String(root.id)) ?? [],
        data.partyNames,
      );
      if (castLine) doc.text(`    participants: ${castLine}`);
      // Inbound proof handle: the archived signed webhook's hash — what a
      // provider_verified claim can be independently checked against
      // (dispute playbook, docs/comms-evidence.md).
      const proofSha = root.external_ref
        ? data.provenanceShaByMsgId.get(String(root.external_ref))
        : undefined;
      if (proofSha) doc.text(`    proof: signed webhook sha256=${proofSha}`);
      if (root.body) doc.text(`    ${String(root.body).slice(0, 400)}`);
      for (const corr of chain.corrections) {
        // classify completes metadata only -- the body is inherited, unchanged.
        // Labeling it "Corrected: <body>" would mis-state that content changed,
        // so name the attribution it added (resolved counterparty), falling back
        // to a generic note when it completed non-party metadata.
        const classified = interactionPartyDisplay(corr, data.partyNames);
        const label =
          corr.correction_kind === 'retract'
            ? `Retracted: ${String(corr.body ?? '').slice(0, 400)}`
            : corr.correction_kind === 'classify'
              ? `Attribution: ${classified && classified !== 'unspecified' ? classified : 'metadata completed'}`
              : `Corrected: ${String(corr.body ?? '').slice(0, 400)}`;
        const redated =
          corr.occurred_at !== root.occurred_at ? `  occurred ${corr.occurred_at as string}` : '';
        doc.text(`    ${label}`);
        doc
          .fillColor('#666')
          .text(`      by ${corr.actor as string}  (logged ${corr.logged_at as string})${redated}`)
          .fillColor('#333');
      }
    }
    doc.fillColor('#000');
  }

  // ----- Maintenance requests ----------------------------------------------
  section(doc, 'Maintenance requests');
  if (data.maintenanceRequests.length === 0) {
    italicNote(doc, '(no maintenance requests in scope)');
  } else {
    for (const mr of data.maintenanceRequests) {
      doc
        .fontSize(10)
        .text(
          `• ${mr.created_at as string}  [${mr.severity as string}/${mr.status as string}]  ${mr.title as string}`,
        );
      if (mr.description)
        doc
          .fontSize(9)
          .fillColor('#555')
          .text(`    ${String(mr.description).slice(0, 400)}`)
          .fillColor('#000');
      // Status history derived from the events table.
      const hist = data.events.filter(
        (e) => e.entity_type === 'maintenance_requests' && e.entity_id === mr.id,
      );
      for (const h of hist) {
        doc
          .fontSize(8)
          .fillColor('#666')
          .text(
            `    audit: ${h.occurred_at as string}  ${h.event_type as string}  by ${h.actor as string}`,
          )
          .fillColor('#000');
      }
      // Work orders for this request.
      const wos = data.workOrders.filter((w) => w.maintenance_request_id === mr.id);
      for (const w of wos) {
        doc
          .fontSize(9)
          .text(
            `    work-order ${w.created_at as string}  [${w.status as string}]  ${w.summary as string}` +
              (w.cost_cents
                ? `  cost ${fmtMoney(w.cost_cents as number, (w.cost_currency as string) ?? '')}`
                : ''),
          );
      }
    }
  }

  // ----- Inspections --------------------------------------------------------
  section(doc, 'Inspections');
  if (data.inspections.length === 0) {
    italicNote(doc, '(no inspections in scope)');
  } else {
    for (const insp of data.inspections) {
      const kind = (insp.kind as string) ?? 'general';
      const stateLabel = insp.completed_at
        ? `COMPLETED ${insp.completed_at as string}`
        : `in progress (${(insp.status as string) ?? 'draft'})`;
      doc
        .fontSize(10)
        .text(
          `• ${kind}  ${(insp.performed_at as string) ?? (insp.created_at as string)}  [${stateLabel}]` +
            (insp.status === 'voided' ? '  [VOIDED]' : '') +
            (insp.baseline_inspection_id
              ? `  (checkout; baseline ${(insp.baseline_inspection_id as string).slice(0, 8)}…)`
              : ''),
        );
      // The frozen, content-hashed report PDF (chain of custody to the bytes
      // the tenant acknowledged). Shown here rather than in Photos.
      const report = data.attachments.find(
        (a) =>
          a.entity_type === 'inspection_report' &&
          a.entity_id === insp.id &&
          a.derived_from === null,
      );
      if (report) {
        doc
          .fontSize(8)
          .fillColor('#555')
          .text(`    report sha256: ${report.content_hash}`)
          .fillColor('#000');
      }
      // Items/checks are loaded WITHOUT a deleted_at filter (evidence
      // completeness, same policy as tenancies above) -- so tombstones must
      // say so, mirroring the "(soft-deleted)" tenancy annotation.
      const items = data.inspectionItems.filter((it) => it.inspection_id === insp.id);
      for (const it of items) {
        doc
          .fontSize(9)
          .fillColor('#333')
          .text(
            `    ${it.group_label ? `${it.group_label as string} / ` : ''}${it.label as string}` +
              (it.condition ? `  condition=${it.condition as string}` : '') +
              (it.change_type ? `  change=${it.change_type as string}` : '') +
              (it.notes ? `  notes=${String(it.notes).slice(0, 200)}` : '') +
              (it.deleted_at ? '  (removed)' : ''),
          )
          .fillColor('#000');
      }
      const checks = data.inspectionChecks.filter((ck) => ck.inspection_id === insp.id);
      for (const ck of checks) {
        const v =
          ck.value === null || ck.value === undefined
            ? ''
            : typeof ck.value === 'string'
              ? ck.value
              : JSON.stringify(ck.value);
        doc
          .fontSize(9)
          .fillColor('#333')
          .text(
            `    [check] ${ck.group_label ? `${ck.group_label as string} / ` : ''}${ck.label as string}: ${v}` +
              (ck.deleted_at ? '  (removed)' : ''),
          )
          .fillColor('#000');
      }
    }
  }

  // ----- Notices ------------------------------------------------------------
  section(doc, 'Notices');
  if (data.notices.length === 0) {
    italicNote(doc, '(no notices in scope)');
  } else {
    for (const n of data.notices) {
      doc
        .fontSize(10)
        .text(
          `• ${(n.served_at as string) ?? '(not served)'}  ${n.notice_type as string}` +
            (n.served_method ? `  via ${n.served_method as string}` : ''),
        );
    }
  }

  // ----- Photos (chain of custody + embedded preview) ----------------------
  // Source photos only: exclude the rendered inspection_report PDFs (derived
  // artifacts; their hash is shown under each inspection above).
  const photoOriginals = data.attachments.filter(
    (a) => a.derived_from === null && a.entity_type !== 'inspection_report',
  );
  if (photoOriginals.length > 0) {
    doc.addPage({ size: 'LETTER', margin: 54 });
    doc.fontSize(14).text('Photos', { underline: true });
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

    const admin = getAdminClient();
    for (const p of photoOriginals) {
      const isHeic = p.mime_type === 'image/heic' || p.mime_type === 'image/heif';
      const renderRow = isHeic ? (derivativesByOriginal.get(p.id) ?? p) : p;
      let bytes: Uint8Array | null = null;
      try {
        const dl = await admin.storage.from('attachments').download(renderRow.storage_path);
        if (!dl.error && dl.data) bytes = new Uint8Array(await dl.data.arrayBuffer());
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
        ? `user:${p.uploaded_by} (${data.uploaderNames.get(p.uploaded_by) ?? p.uploaded_by})`
        : data.intakeTokenById.has(p.id)
          ? `tenant:${data.intakeTokenById.get(p.id)}`
          : 'system';
      doc.text(
        `uploader:   ${uploaderActor}    mime: ${p.mime_type ?? '?'}    size: ${p.size_bytes ?? '?'} bytes`,
      );
      doc.fillColor('#000');

      const renderable =
        renderRow.mime_type === 'image/jpeg' || renderRow.mime_type === 'image/png';
      if (bytes && renderable) {
        try {
          doc.image(Buffer.from(bytes), { fit: [400, 300] });
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
            `[photo ${p.id} of type ${p.mime_type ?? '?'} could not be embedded -- bytes available at storage_path]`,
          )
          .fillColor('#000');
      }
      doc.moveDown(0.8);
    }
  }

  // ----- Audit trail (entities in scope) -----------------------------------
  doc.addPage({ size: 'LETTER', margin: 54 });
  doc.fontSize(14).text('Audit trail', { underline: true });
  doc.moveDown(0.3);
  doc
    .fontSize(8)
    .fillColor('#444')
    .text(
      'Every consequential write to the entities above is recorded as an immutable, ' +
        'server-timestamped, attributed event. The hash chain over these events is ' +
        'what the verification banner on page 1 attests to.',
    )
    .fillColor('#000');
  doc.moveDown(0.3);
  if (data.events.length === 0) {
    italicNote(doc, '(no audit events in scope)');
  } else {
    doc.fontSize(8);
    for (const e of data.events) {
      doc.text(
        `#${(e.account_seq as number) ?? '?'}  ${e.occurred_at as string}  ${(e.event_type as string).padEnd(10)}  ` +
          `${(e.entity_type as string).padEnd(22)}  ${(e.entity_id as string).slice(0, 8)}…  ${e.actor as string}`,
      );
    }
  }

  // ----- Footer with content-of-bundle hash placeholder --------------------
  // The hash of these bytes is computed AFTER doc.end() and stored on the
  // evidence_exports row; we don't write it into the PDF (would change the
  // hash). The audit event for evidence_exports.insert is the canonical
  // record of THIS bundle's identity.

  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

function section(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.8);
  doc.fontSize(13).text(title, { underline: true });
  doc.moveDown(0.2);
}

function italicNote(doc: PDFKit.PDFDocument, text: string): void {
  doc.fontSize(9).fillColor('#777').text(text).fillColor('#000');
}
