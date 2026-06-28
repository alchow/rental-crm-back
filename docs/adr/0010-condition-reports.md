# ADR-0010: Check-in / check-out condition reports

- **Status:** accepted and BUILT (migrations `20260628000001`–`7`), 2026-06-28

## Context

Landlords (and tenants) need move-in / move-out **condition forms** whose data
holds up as evidence in US security-deposit disputes — the move-out condition
compared against move-in, item by item, drives what's deductible. A real target
is the Texas REALTORS® TXR-2006 inventory form (~17 sections, ~150 lines, with a
side-by-side Move-In / Move-Out column per line).

The codebase already ships an **inspections** subsystem (Phase 8) that is ~80%
of this: area-scoped inspection + items, a completion lock (`completed_at` +
immutability triggers), a byte-deterministic content-hashed report PDF
(`api/src/admin/pdf.ts`), photo chain-of-custody on `attachments`, and the
hash-chained audit spine under everything. A `documents` vault (Phase 26)
already defines `move_in`/`move_out` types with a tenant magic-link review +
audited `acknowledged` flow.

## Decision

**Extend `inspections` as the capture engine and compose the existing
subsystems** rather than build a parallel one.

- `inspections` gains `kind` (move_in/move_out/periodic/general), `tenancy_id`,
  `baseline_inspection_id` (checkout → its check-in), a capture `status`
  lifecycle, `capture_mode` (landlord/tenant/collaborative), `void` columns, and
  `template_snapshot`/`subject_snapshot` (frozen at completion). A coherence
  trigger ties a tenancy-bound inspection to its unit area; the completion lock
  is widened to permit exactly two post-completion transitions — soft-delete and
  void — and nothing that mutates report data.
- `inspection_items` gains `item_key` (the stable diff/upsert key), `group_label`
  (room), `change_type` (the move-out verdict), `sort_order`. A new typed
  `inspection_checks` table holds yes/no, scalar, and count fields (e.g. keys
  Received/Returned), which the diff pairs by `field_key`.
- **Output is our own deterministic report**, NOT the official PDF filled in.
  Facts aren't copyrightable; a specific form's layout is, and TXR-2006 is
  member-restricted. (An "export to the official form" overlay remains a future
  opt-in for licensed accounts.)
- **Tenant attestation is acknowledgment-only** (no drawn-signature images in
  v1): the tenant submits/attests during capture (audit actor `tenant:<token>`)
  and acknowledges the finished report via the existing documents magic-link.
- **Both landlord- and tenant-filled capture**, configurable per inspection.
  Tenant writes go through a write-scoped magic link (`inspection_capture_tokens`)
  and `SECURITY DEFINER` RPCs that stamp the audit actor — **revoked from
  `public`, granted only to `service_role`** so an authed user can't call them
  around the token check (mirrors the intake flow).
- **On completion** the report PDF is rendered (idempotent on its content hash,
  so it can't drift from the `document_version` that points at it) and a
  `move_in`/`move_out` `documents` row is emitted for the tenant ack flow.
- A read-only `inspection_checkout_diff` RPC pairs move-out vs move-in (items by
  `item_key`, checks by `field_key`) — the input to an itemized deduction
  statement. A bundled, generic **starter template catalog** seeds real forms.
- Outbound email (renewal links) sits behind a `Mailer` interface — a logging
  stub until a provider is wired (messaging was removed in #39).

## Rejected alternatives

1. **A separate `condition_form_*` subsystem.** Re-certifies the
   evidence-critical machinery we already ship (deterministic PDF, immutability,
   token security, audit wiring) and leaves two "inspection-like" things. It also
   wouldn't have the diff. (An external plan proposed this; we merged its genuine
   catches — typed checks, snapshots, void/supersede, `sort_order`, jurisdiction
   columns, evidence-export — onto the reuse-first base.)
2. **A generic JSONB "forms" engine.** JSONB answers fight the evidence
   requirement: hard to constrain, index, and deterministically diff. The typed
   item/check model is what makes the checkout comparison defensible.
3. **Filling the official TXR-2006 PDF.** Copyright + member-restriction, and an
   overlay onto a third-party PDF is far harder to keep byte-deterministic.

## Consequences

- Maximal reuse; the only genuinely new primitives are typed checks + the
  write-scoped capture token. No new tenant-facing security surface beyond the
  documents pattern it mirrors.
- `completed_at` keeps its exact meaning (capture frozen, PDF rendered);
  distribution lives in `documents`, attestation in `document_access_events`,
  workflow in `status` — none overload `completed_at`.
- Evidence exports now carry condition reports (kind/status/change_type, typed
  checks, item-level photos fetched chunked, the report's content hash).
- **Deferred:** the mutable deposit-**deduction**/itemized-statement layer (you
  can't put an editable dollar figure on a frozen record); per-item tenant
  dissent; drawn signatures (if acknowledgment-only proves insufficient);
  official-form export; and wiring a concrete email provider. The tenant capture
  **UI** and landlord console are separate frontend work — this is API + DB only.
