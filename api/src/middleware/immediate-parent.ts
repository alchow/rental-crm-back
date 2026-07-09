import type { MiddlewareHandler } from 'hono';
import { getSb } from '../supabase/request-client';
import { ApiError } from '../routes/_lib/error';

// Resolves the IMMEDIATE path parent of a sub-resource against the active
// account and 404s if the parent is not in this account (or doesn't exist
// for this caller under RLS).
//
// Why this matters: without this, a URL like
//   /v1/accounts/<A>/tenancies/<B>/members
// passes the account-membership resolver (A IS in A) and the route's query
// just filters by tenancy_id=<B>, which under RLS returns no rows. The
// LIST endpoint then renders an empty roster -- not a leak, but it masks
// the client bug (wrong id in URL) and is inconsistent with the BODY
// equivalent: a cross-account reference in a body returns 404 via the
// composite FK. This middleware unifies the behavior: cross-account parent
// in the PATH also 404s, before any handler logic.
//
// Scope: IMMEDIATE parent only. Not a deep hierarchy walk. Each sub-resource
// route mounts this with its own (table, paramName).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ImmediateParentTable = 'areas' | 'tenancies';

export interface ImmediateParentOptions {
  /** The public.* table name the parent lives in. */
  table: ImmediateParentTable;
  /** The path-param name that holds the parent's id (e.g. 'tenancyId'). */
  paramName: string;
  /** Set to false for tables that don't soft-delete (e.g. unit_details). */
  hasDeletedAt?: boolean;
}

export function requireImmediateParent(opts: ImmediateParentOptions): MiddlewareHandler {
  const hasDeletedAt = opts.hasDeletedAt ?? true;
  return async (c, next) => {
    const accountId = c.get('account').accountId;
    const parentId = c.req.param(opts.paramName);
    if (!parentId || !UUID_RE.test(parentId)) {
      throw new ApiError(404, 'not_found', 'not found');
    }
    const sb = getSb(c);
    let q = sb.from(opts.table).select('id').eq('account_id', accountId).eq('id', parentId);
    if (hasDeletedAt) {
      q = q.is('deleted_at', null);
    }
    const { data, error } = await q.maybeSingle();
    if (error) throw new ApiError(500, 'database_error', error.message);
    if (!data) {
      // Parent is invisible (wrong account) or soft-deleted. 404, same as
      // every other not-found in this API. Don't confirm existence.
      throw new ApiError(404, 'not_found', 'not found');
    }
    return next();
  };
}
