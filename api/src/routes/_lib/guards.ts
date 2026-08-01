import type { Context } from 'hono';
import { ApiError } from './error';

// Role guards shared across domains. RLS is role-agnostic -- an account
// membership row grants row access whatever the member's role is (and the
// agent principal reads through a member's grant) -- so these route guards are
// the ONLY lever that separates agent/viewer from owner/manager. That is why
// they exist here rather than being pushed down to the database.

// Transport endpoints are driven by the agent principal (the provider-calling
// module in the agent repo); everything else on it is 403.
export function requireTransport(c: Context): void {
  if (c.get('principal').type !== 'agent') {
    throw new ApiError(403, 'forbidden', 'this endpoint is reserved for the agent transport');
  }
}

// Landlord endpoints require owner|manager (viewers read the journal, not the
// comms controls; the agent principal holds role='agent' and is denied too).
export function requireManager(c: Context): void {
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only an owner or manager may use this endpoint');
  }
}

// Reads the transport ALSO needs (thread context for relay legs, standing
// policies for grant provenance): the agent principal or an owner/manager.
// Viewers stay denied. Same carve-out shape as createOutbox/getOutbox.
export function requireAgentOrManager(c: Context): void {
  if (c.get('principal').type === 'agent') return;
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(
      403,
      'forbidden',
      'only the agent transport or an owner/manager may use this endpoint',
    );
  }
}
