import type { Context } from 'hono';
import { asDbFunctionArgs, asJson, type DbFunctionName } from '../../supabase/db-types';
import { getSb } from '../../supabase/request-client';
import { ApiError } from '../_lib/error';

export function mapDateRpcError(error: { code?: string; message?: string }): never {
  const message = (error.message ?? '').trim();
  const code = message.split(':', 1)[0] ?? message;
  if (error.code === 'P0002' || error.code === '42501') {
    throw new ApiError(404, 'not_found', 'tenancy or selected date context not found');
  }
  if (error.code === 'P0001' || code === 'date_context_changed' || code === 'date_correction_required') {
    const conflictCode = code === 'date_context_changed' || code === 'date_correction_required'
      ? code
      : 'conflict';
    throw new ApiError(409, conflictCode, message || 'date context changed');
  }
  if (error.code === '22023' || error.code === '23514' || error.code === '22P02') {
    const invalidCodes = [
      'no_date_change', 'invalid_date_order', 'date_status_conflict',
      'date_fixed_by_cancellation', 'source_scope_invalid', 'actual_move_in_in_future',
    ] as const;
    const invalidCode = invalidCodes.find((candidate) => candidate === code) ?? 'invalid_request';
    throw new ApiError(400, invalidCode, message || 'invalid date request');
  }
  throw new ApiError(500, 'database_error', message || 'date operation failed');
}

export async function dateRpc<T>(
  c: Context,
  name: DbFunctionName,
  args: Record<string, unknown>,
): Promise<T> {
  const sb = getSb(c);
  const { data, error } = await sb.rpc(name, asDbFunctionArgs(args));
  if (error) mapDateRpcError(error);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError(500, 'database_error', `${name} returned no result`);
  }
  return data as T;
}

export function atomicDateArgs(c: Context, payload: unknown): Record<string, unknown> {
  const claim = c.get('idempotencyClaim');
  if (!claim) throw new ApiError(500, 'database_error', 'idempotency claim is unavailable');
  return {
    p_idempotency_key: claim.key,
    p_request_fingerprint: claim.fingerprint,
    p_payload: asJson(payload),
  };
}
