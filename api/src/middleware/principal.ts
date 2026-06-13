// Principal classification happens HERE and nowhere else: the firewall, send
// endpoints, and authorship stamping all read c.get('principal') -- they never
// re-derive the agent/user distinction (ADR-0006's single-classification-point
// contract, generalized to multi-tenant in ADR-0009).
//
// The agent principal is a Supabase service-account user holding a role='agent'
// membership in each account it serves (ADR-0006). We classify by the resolved
// membership role for the SCOPED account -- c.get('account').role, which
// requireAccountMembership has already loaded and cached, so no extra round
// trip. This generalizes to many agent service-account users (ADR-0009) without
// an environment-pinned id; role='agent' is reserved for the agent (a landlord
// can never hold it -- see is_approver_member), so the mapping is exact.
import type { MiddlewareHandler } from 'hono';

export interface Principal {
  type: 'agent' | 'user';
  userId: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    principal: Principal;
  }
}

export function resolvePrincipal(): MiddlewareHandler {
  return async (c, next) => {
    // resolvePrincipal is mounted after requireAccountMembership, so the
    // scoped-account membership (incl. role) is already in context.
    c.set('principal', {
      type: c.get('account').role === 'agent' ? 'agent' : 'user',
      userId: c.get('auth').userId,
    });
    return next();
  };
}
