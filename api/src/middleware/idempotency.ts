import type { MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { getUserClient } from '../supabase/user-client';
import { ApiError } from '../routes/_lib/error';

// Generic Idempotency-Key middleware. Mounted on every mutating endpoint
// under /v1/accounts/:accountId/* so the contract is uniform: a client
// retrying a POST / PATCH / PUT / DELETE with the same Idempotency-Key
// gets back the SAME response and the resource is created / modified
// EXACTLY ONCE.
//
// Design (single-DB-row claim):
//   1. Read the Idempotency-Key header (8-200 chars). Missing -> 400.
//   2. sha256(method + '\n' + path + '\n' + body) is the request
//      fingerprint. Saved on the row so a retry with the same key but a
//      DIFFERENT body returns 409 instead of silently overwriting a real
//      operation with a cached one.
//   3. INSERT a placeholder row into idempotency_keys to "claim" the key.
//      The (account_id, key) primary key is the lock.
//   4. If the INSERT conflicts (race), fetch the existing row:
//        - fingerprint mismatch -> 409 conflict
//        - completed_at is null -> 409 (request in flight; client retries)
//        - otherwise -> return the cached (status, body) verbatim
//   5. If we WON the claim, run the handler, then UPDATE the row with
//      the actual response status + body so future replays hit the cache.
//
// Things this DOES NOT do (intentionally):
//   - It does NOT cache 5xx responses. A 5xx is most often transient; the
//     client should be able to retry. We DELETE the placeholder so the
//     next try with the same key is a fresh attempt rather than a wedged
//     409-in-flight.
//   - It does NOT span multiple write tables transactionally with the
//     handler's own writes. The handler does its work in its own
//     transaction; we record the outcome after. The narrow race window
//     (insert handler-row + crash before we update idempotency_keys)
//     leaves the placeholder in-flight; the placeholder expires in 24h
//     OR a retry with a new key proceeds normally.

const KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function requireIdempotency(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (!MUTATING.has(method)) {
      return next();
    }

    const key = c.req.header('idempotency-key');
    if (!key) {
      throw new ApiError(
        400,
        'invalid_request',
        'Idempotency-Key header is required for mutating requests',
      );
    }
    if (!KEY_RE.test(key)) {
      throw new ApiError(
        400,
        'invalid_request',
        'Idempotency-Key must be 8-200 chars of [A-Za-z0-9_-]',
      );
    }

    const accountId = c.get('account').accountId;
    const sb = getUserClient(c.get('auth').accessToken);

    // Fingerprint the request without consuming the body downstream. The
    // request can only be read once; Request.clone() gives us a separate
    // readable copy.
    const cloneReq = c.req.raw.clone();
    const bodyText = method === 'DELETE' ? '' : await cloneReq.text();
    const fingerprint = createHash('sha256')
      .update(method)
      .update('\n')
      .update(c.req.path)
      .update('\n')
      .update(bodyText)
      .digest('hex');

    // Claim the key by INSERTing a placeholder row.
    const { error: insertErr } = await sb
      .from('idempotency_keys')
      .insert({
        account_id: accountId,
        key,
        request_fingerprint: fingerprint,
        // status_code / body / completed_at left null = "in flight"
      });

    if (insertErr) {
      if (insertErr.code === '23505') {
        // Race: an earlier request already claimed this key. Fetch it.
        const { data: existing, error: fetchErr } = await sb
          .from('idempotency_keys')
          .select('request_fingerprint, status_code, body, completed_at')
          .eq('account_id', accountId)
          .eq('key', key)
          .maybeSingle();
        if (fetchErr) {
          throw new ApiError(500, 'database_error', fetchErr.message);
        }
        if (!existing) {
          // Vanished between the insert and the lookup -- transient; ask to retry.
          throw new ApiError(409, 'conflict', 'idempotency-key state changed; retry');
        }
        if (existing.request_fingerprint !== fingerprint) {
          throw new ApiError(
            409,
            'conflict',
            'Idempotency-Key was used for a different request',
          );
        }
        if (existing.completed_at === null) {
          // Still in flight on the original request. Tell the client to retry.
          throw new ApiError(409, 'conflict', 'Idempotency-Key request in flight; retry shortly');
        }
        const cached = existing.body as unknown;
        const cachedStatus = existing.status_code ?? 200;
        return new Response(JSON.stringify(cached), {
          status: cachedStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new ApiError(500, 'database_error', insertErr.message);
    }

    // We claimed the key. Run the handler.
    let handlerError: unknown = null;
    try {
      await next();
    } catch (e) {
      handlerError = e;
    }

    // Inspect the response. Hono's onError will turn handlerError into a
    // Response and set c.res before this function returns, even though we
    // caught above -- but only if we rethrow. To keep the response capture
    // logic in one place, we DON'T rethrow here; we read c.res for the
    // status the framework decided, including any onError mapping.
    if (handlerError) {
      // Rethrow so onError formats the response, but cache cleanup first.
      // Hono's pattern: throwing in middleware after next() doesn't get
      // caught by onError -- it propagates as an unhandled exception. So
      // we deliberately do NOT rethrow; we let the onError-shaped response
      // (which we set in app.ts) flow through.
    }

    const res = c.res;
    const status = res.status;

    if (status >= 500) {
      // 5xx: don't cache. Clean up the placeholder so a retry can proceed.
      await sb
        .from('idempotency_keys')
        .delete()
        .eq('account_id', accountId)
        .eq('key', key);
      return; // c.res already set by handler / onError; let it flow
    }

    // Cache 2xx/3xx/4xx. Read the body once (clone first); leave c.res for
    // the framework to send.
    const cloneRes = res.clone();
    let cachedBody: unknown = null;
    if (status !== 204) {
      const ctype = cloneRes.headers.get('content-type') ?? '';
      if (ctype.includes('application/json')) {
        try {
          cachedBody = await cloneRes.json();
        } catch {
          cachedBody = null;
        }
      } else {
        cachedBody = await cloneRes.text();
      }
    }

    await sb
      .from('idempotency_keys')
      .update({
        status_code: status,
        body: cachedBody,
        completed_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)
      .eq('key', key);
  };
}
