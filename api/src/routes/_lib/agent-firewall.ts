// Journal firewall for the agent principal (agent-api plan Workstream D;
// ADR-0006). Called from the interactions create handler before any DB write.
//
// Invariants this enforces (in addition to the DB constraints that back-stop
// them):
//   - The agent cannot correct or retract any journal entry (only landlords
//     supersede history).
//   - The agent cannot append kind='communication' directly (communications
//     are produced by the send pipeline, which guarantees a Twilio SID behind
//     them; a direct append could fabricate a contact that never happened).
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

    // Communications are produced exclusively by the send pipeline so that a
    // Twilio SID is always present behind them. A direct append would let the
    // agent claim a contact that never happened.
    if (kind === 'communication') {
      throw new ApiError(
        403,
        'agent_entry_type_forbidden',
        'communications are journaled by the send pipeline; the agent may not append them directly',
      );
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
  }
}
