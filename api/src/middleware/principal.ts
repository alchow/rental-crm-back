// SECURITY: Classify once from the scoped membership role, never from client input.
// Run after requireAccountMembership; consumers use c.get('principal') (ADR-0009).
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
    c.set('principal', {
      type: c.get('account').role === 'agent' ? 'agent' : 'user',
      userId: c.get('auth').userId,
    });
    return next();
  };
}
