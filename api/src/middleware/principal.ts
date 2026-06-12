// THIS FILE is the only place in api/src/ where AGENT_USER_ID may be compared
// against an authenticated user id. The firewall, send endpoints, and
// authorship stamping all read c.get('principal') -- they never touch
// AGENT_USER_ID directly.  ADR-0006.
import type { MiddlewareHandler } from 'hono';
import { loadEnv } from '../env';

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
    const userId = c.get('auth').userId;
    const agentId = loadEnv().AGENT_USER_ID;
    c.set('principal', {
      type: agentId !== null && userId === agentId ? 'agent' : 'user',
      userId,
    });
    return next();
  };
}
