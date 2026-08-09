import type { MiddlewareHandler } from 'hono';
import { getSb } from '../supabase/request-client';
import { ApiError } from '../routes/_lib/error';

// Resolves the immediate path parent under caller RLS and returns 404 when it
// is absent or cross-account. This prevents a wrong parent ID from masquerading
// as an empty list and aligns path behavior with account-safe body FKs. It is
// intentionally not a recursive hierarchy walk.

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
