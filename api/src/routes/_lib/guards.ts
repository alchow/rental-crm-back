import type { Context } from 'hono';
import { ApiError } from './error';

// SECURITY: Apply endpoint role checks in addition to caller RLS and account membership.

export function requireTransport(c: Context): void {
  if (c.get('principal').type !== 'agent') {
    throw new ApiError(403, 'forbidden', 'this endpoint is reserved for the agent transport');
  }
}

export function requireManager(c: Context): void {
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only an owner or manager may use this endpoint');
  }
}

// Transport and owner/manager share these operations; viewers remain excluded.
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
