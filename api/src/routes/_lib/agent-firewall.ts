// Journal firewall for the agent principal (agent-api plan Workstream D;
// ADR-0006). Called from the interactions create handler before any DB write.
//
// Invariants this enforces (in addition to the DB constraints that back-stop
// them):
//   - The agent cannot correct or retract any journal entry (only landlords
//     supersede history).
//   - Agent communications require authorization provenance: approval_ref plus
//     either approved_by (a human approved this exact message —
//     approval_ref='proposal:<id>') or a 'grant:'-prefixed approval_ref (sent
//     under a standing landlord-approved policy; no human read this specific
//     message). Free-text without provenance stays forbidden: a direct append
//     could fabricate a contact that never happened. (Rationale:
//     landlord-agent/docs/agent-sends-core-records.md in the sibling repo.)
//   - Agent notes require explicit landlord approval (approved_by + approval_ref).
//   - agent_events carry structured metadata and are vocabulary-constrained.
//   - Landlord users cannot supply agent-only fields (entry_type, approval_ref,
//     approved_by) or create agent_event entries.

import type { Principal } from '../../middleware/principal';
import { ApiError } from './error';

// The shape we check -- subset of the parsed CreateInteractionBody type.
// Written as a structural interface to avoid a circular import from
// interactions.ts while remaining type-safe.
export interface AgentFirewallBody {
  kind?: string;
  corrects_id?: string;
  entry_type?: string;
  approved_by?: string;
  approval_ref?: string;
  external_ref?: string;
  body?: string;
  // entity refs for step_executed validation
  work_order_id?: string;
  maintenance_request_id?: string;
  vendor_id?: string;
  tenancy_id?: string;
  area_id?: string;
  references_interaction_id?: string;
}

export function assertAgentJournalWrite(
  principal: Principal,
  body: AgentFirewallBody,
): void {
  const kind = body.kind ?? 'communication';

  if (principal.type === 'agent') {
    // Corrections and retractions are landlord-only operations: only landlords
    // supersede history. The agent principal has no authority to close a chain.
    if (body.corrects_id !== undefined) {
      throw new ApiError(
        403,
        'agent_forbidden',
        'the agent principal may not correct or retract journal entries',
      );
    }

    // Communications enter the journal only with authorization provenance,
    // never as bare agent free-text (a bare append would let the agent claim
    // a contact that never happened). Two provenance shapes are accepted,
    // mirroring the cross-repo convention:
    //   approval_ref='proposal:<id>' + approved_by  -> a human approved this
    //     exact message.
    //   approval_ref='grant:<id>'   (no approved_by) -> sent under a standing
    //     landlord-approved policy; the journal stays honest that no human
    //     read this specific message.
    if (kind === 'communication') {
      if (body.approval_ref === undefined) {
        throw new ApiError(
          403,
          'agent_entry_type_forbidden',
          'the agent may not append communications without authorization provenance (approval_ref)',
        );
      }
      if (body.approved_by === undefined && !body.approval_ref.startsWith('grant:')) {
        throw new ApiError(
          403,
          'agent_entry_type_forbidden',
          "agent communications require approved_by (proposal-approved) or a 'grant:'-prefixed approval_ref (policy-authorized)",
        );
      }
    }

    if (kind === 'note') {
      // note_logged: landlord approval is evidence-grade and DB-enforced.
      const missing: string[] = [];
      if (body.approved_by === undefined) missing.push('approved_by');
      if (body.approval_ref === undefined) missing.push('approval_ref');
      if (missing.length > 0) {
        throw new ApiError(
          400,
          'invalid_request',
          'agent-authored notes require landlord approval',
          { fieldErrors: Object.fromEntries(missing.map((f) => [f, [`${f} is required for agent-authored notes`]])) },
        );
      }
    }

    if (kind === 'agent_event') {
      // approval_ref is always required: every agent_event is tied to an
      // agent-side proposal or task id for audit continuity.
      if (body.approval_ref === undefined) {
        throw new ApiError(
          400,
          'invalid_request',
          'approval_ref is required for agent_event entries',
          { fieldErrors: { approval_ref: ['approval_ref is required for agent_event entries'] } },
        );
      }

      if (body.entry_type === 'step_executed') {
        // step_executed must reference at least one entity so the event is
        // anchored to something the landlord can look up.
        const hasEntityRef =
          body.work_order_id !== undefined ||
          body.maintenance_request_id !== undefined ||
          body.vendor_id !== undefined ||
          body.tenancy_id !== undefined ||
          body.area_id !== undefined ||
          body.references_interaction_id !== undefined;
        if (!hasEntityRef) {
          throw new ApiError(
            400,
            'invalid_request',
            'step_executed requires at least one entity reference (work_order_id, maintenance_request_id, vendor_id, tenancy_id, area_id, or references_interaction_id)',
            { fieldErrors: { entry_type: ['step_executed requires at least one entity reference'] } },
          );
        }
      }

      if (body.entry_type === 'proposal_approved') {
        if (body.approved_by === undefined) {
          throw new ApiError(
            400,
            'invalid_request',
            'approved_by is required for proposal_approved entries',
            { fieldErrors: { approved_by: ['approved_by is required for proposal_approved entries'] } },
          );
        }
      }

      // agent_event body is bounded at the DB level (1000 chars), but we
      // check here to return a useful 400 rather than an opaque 500.
      if (body.body !== undefined && body.body.length > 1000) {
        throw new ApiError(
          400,
          'invalid_request',
          'agent_event body must not exceed 1000 characters',
          { fieldErrors: { body: ['body must not exceed 1000 characters for agent_event entries'] } },
        );
      }
    }
  } else {
    // Landlord user: agent-only fields must not be present.
    if (kind === 'agent_event' || body.entry_type !== undefined) {
      throw new ApiError(
        403,
        'agent_only',
        'agent_event entries are reserved for the agent principal',
      );
    }
    if (body.approved_by !== undefined || body.approval_ref !== undefined) {
      throw new ApiError(
        400,
        'invalid_request',
        'approval fields are reserved for agent-authored entries',
        {
          fieldErrors: {
            ...(body.approved_by !== undefined ? { approved_by: ['reserved for agent-authored entries'] } : {}),
            ...(body.approval_ref !== undefined ? { approval_ref: ['reserved for agent-authored entries'] } : {}),
          },
        },
      );
    }
    // external_ref attests a provider-confirmed send; a landlord logging a
    // contact by hand has no such reference and must not fabricate one.
    if (body.external_ref !== undefined) {
      throw new ApiError(
        400,
        'invalid_request',
        'external_ref is reserved for agent-authored communications',
        { fieldErrors: { external_ref: ['reserved for agent-authored communications'] } },
      );
    }
  }
}
