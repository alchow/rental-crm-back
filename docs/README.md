# Documentation Index

Use this index to decide whether a document describes the current system or
preserves historical decision context.

## Current System

- `architecture.md` — current component boundaries, data flows, and sources of
  truth.
- `api-guide.md` — human integration guide. OpenAPI remains the complete
  machine-readable HTTP contract.
- `persona-email-contract.md` — current core/transport routing contract.
- `comms-evidence.md` — current communications evidence-archive contract.
- `agent-runbook.md` — agent service-account provisioning and rotation.
- `backup-recovery-runbook.md` — backup and restore operations.

## Architecture Decisions

`adr/` contains durable decisions. Each ADR must say one of:

- current/accepted;
- accepted but not yet triggered;
- superseded, with a link to the replacement;
- rejected, with a revisit trigger.

ADR-0007 is the current outbox-first, journal-on-confirmed-send invariant.
ADR-0009 supersedes the single-account identity portions of ADR-0006.

## Historical Plans and Replies

The following preserve implementation and cross-team decision history. They
are useful when investigating why a rule exists, but they are not current
architecture or work instructions:

- `architecture-plan.md`
- `phase-2-implementation.md`
- `agent-api-plan.md`
- `*-reply.md` and `*-reply-2.md`
- `search-context-enrichment.md`
- `delete-503-diagnosis-runbook.md` (incident-specific)

The former multi-repository coordination log is archived under
`archive/coordination-2026-07/`. Never execute its imperative instructions as
current work.

## Maintenance Rule

When a change invalidates a current document, update it in the same change.
When a plan finishes, mark it historical and add it here rather than leaving
ambiguous status text for the next human or agent.
