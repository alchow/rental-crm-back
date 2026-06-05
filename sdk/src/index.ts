// Generated TypeScript client for the /v1 contract.
//
// The types in ./generated/types.ts are produced by openapi-typescript from
// openapi/openapi.json. Don't hand-edit. Re-run `pnpm --filter ./sdk generate`
// after a schema change; CI fails on drift between this committed file and a
// fresh regeneration.

import createClient, { type Client } from 'openapi-fetch';
import type { paths } from './generated/types.js';

export interface RentalCrmClientOpts {
  baseUrl: string;
  /**
   * Bearer token forwarded as Authorization on every request. For Supabase
   * Auth flows, this is the session.access_token returned by /v1/auth/login
   * or /v1/auth/signup.
   */
  accessToken?: string | (() => string | Promise<string>);
}

export function createRentalCrmClient(opts: RentalCrmClientOpts): Client<paths> {
  return createClient<paths>({
    baseUrl: opts.baseUrl,
    fetch: async (req: Request): Promise<Response> => {
      if (opts.accessToken) {
        const token =
          typeof opts.accessToken === 'function'
            ? await opts.accessToken()
            : opts.accessToken;
        if (token) {
          req.headers.set('Authorization', `Bearer ${token}`);
        }
      }
      return fetch(req);
    },
  });
}

export type { paths, components } from './generated/types.js';
