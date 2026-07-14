import type { MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { asJson } from '../supabase/db-types';
import { getSb } from '../supabase/request-client';
import { ApiError, dbError } from '../routes/_lib/error';
import { getLogger } from '../log';

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
// Cap how long the best-effort completion write may gate the (already-decided)
// response flush. Well under the 25s app request budget.
const COMPLETE_TIMEOUT_MS = 2500;

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
    const sb = getSb(c);

    // Fingerprint the request without consuming the body downstream. The
    // request can only be read once; Request.clone() gives us a separate
    // readable copy.
    //
    // The authenticated userId is included in the preimage so the same
    // key + body from different principals (e.g. landlord vs. agent) produces
    // a fingerprint mismatch rather than replaying one principal's cached
    // response to the other. Deploy-window effect: a key claimed pre-deploy
    // and retried post-deploy gets 409 instead of a replay -- acceptable and
    // transient (keys are 30-day TTL).
    const cloneReq = c.req.raw.clone();
    const bodyText = method === 'DELETE' ? '' : await cloneReq.text();
    const fingerprint = createHash('sha256')
      .update(method)
      .update('\n')
      .update(c.req.path)
      .update('\n')
      .update(c.get('auth').userId)
      .update('\n')
      .update(bodyText)
      .digest('hex');

    // Claim+inspect in ONE round trip (Phase 2.4): the SECURITY INVOKER RPC
    // does the placeholder INSERT and, on conflict, returns the winner's
    // state; RLS applies unchanged. The behavior matrix is frozen and lives
    // verbatim in the RPC migration (20260614000002).
    const { data: claimData, error: claimErr } = await sb.rpc('claim_idempotency_key', {
      p_account_id: accountId,
      p_key: key,
      p_fingerprint: fingerprint,
    });
    // The claim RPC is SECURITY INVOKER, so this INSERT is the FIRST
    // RLS-gated write on any mutating request -- a just-revoked agent (still
    // inside the membership-cache TTL, so it passed requireAccountMembership)
    // is denied HERE with 42501. Map it to a clean 403 rather than 500
    // (ADR-0009 Phase 4).
    if (claimErr) throw dbError(claimErr);
    const claim = (Array.isArray(claimData) ? claimData[0] : claimData) as {
      claimed: boolean;
      fingerprint_matches: boolean;
      in_flight: boolean;
      status_code: number | null;
      body: unknown;
    } | null;
    if (!claim) throw new ApiError(500, 'database_error', 'claim_idempotency_key returned no row');

    if (!claim.claimed) {
      if (!claim.fingerprint_matches) {
        // Same key, different body: the caller's key derivation is wrong.
        // Distinct code so clients do NOT blind-retry (a retry repeats the
        // conflict); contrast a domain 409 like invalid_correction_target,
        // which is about the resource state, not the key.
        throw new ApiError(
          409,
          'idempotency_conflict',
          'Idempotency-Key was used for a different request',
        );
      }
      if (claim.in_flight) {
        // Still in flight on the original request (or the row vanished mid-
        // race -- also retryable). Distinct, retryable code: retry shortly
        // with the SAME key + body.
        throw new ApiError(
          409,
          'idempotency_in_flight',
          'Idempotency-Key request in flight; retry shortly',
        );
      }
      // Replay of a completed request: return the cached response verbatim.
      // The Idempotency-Replay header lets the caller distinguish an absorbed
      // retry from a fresh execution (e.g. for dedup-rate metrics); the body
      // and status are byte-identical to the original either way.
      const replayStatus = claim.status_code ?? 200;
      // Null-body statuses (204/205/304) reject ANY body in the Response
      // constructor -- JSON.stringify(null) is the string "null", not no body,
      // so a replayed DELETE would throw and surface as a 500 instead of the
      // promised replay.
      if (replayStatus === 204 || replayStatus === 205 || replayStatus === 304) {
        return new Response(null, {
          status: replayStatus,
          headers: { 'Idempotency-Replay': 'true' },
        });
      }
      return new Response(JSON.stringify(claim.body), {
        status: replayStatus,
        headers: { 'content-type': 'application/json', 'Idempotency-Replay': 'true' },
      });
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
      await sb.from('idempotency_keys').delete().eq('account_id', accountId).eq('key', key);
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

    // Persist the outcome so future replays hit the cache -- but BOUND it. An
    // unbounded await here lets a slow/hung completion gate an already-decided
    // 2xx, which is exactly how a committed write becomes a client-visible edge
    // 503. Status+body are final; caching them is best-effort. On timeout we
    // flush the response now and let the write settle in the background; if it
    // never lands, claim_idempotency_key reclaims the stale in-flight row after
    // ~90s so a same-key retry recovers (rather than wedging for the prune TTL).
    const completion: Promise<void> = (async () => {
      try {
        const { error } = await sb.rpc('complete_idempotency_key', {
          p_account_id: accountId,
          p_key: key,
          p_status: status,
          p_body: asJson(cachedBody),
        });
        if (error) getLogger().error({ err: error, key }, 'idempotency completion failed');
      } catch (err) {
        getLogger().error({ err, key }, 'idempotency completion threw');
      }
    })();

    let completeTimer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<'timeout'>((resolve) => {
      completeTimer = setTimeout(() => resolve('timeout'), COMPLETE_TIMEOUT_MS);
    });
    const outcome = await Promise.race([completion.then(() => 'done' as const), capped]);
    if (completeTimer) clearTimeout(completeTimer);
    if (outcome === 'timeout') {
      getLogger().warn(
        { key },
        'idempotency completion slow; flushing response, in-flight key reclaimed ~90s if abandoned',
      );
    }
  };
}
