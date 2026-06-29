# Runbook: diagnosing the bodyless 503 on `DELETE /v1/accounts/{id}/documents/{id}`

Front-end reported: `DELETE …/documents/{id}` consistently returns a **bodyless 503**, yet the soft-delete commits. Status didn't reflect the write, and a bodyless non-2xx breaks the "branch on `error.code`" client contract.

## What we know from the code (no repro needed)

- **The app never emits 503.** `503` exists only in the `ApiError` status union (`api/src/routes/_lib/error.ts`); nothing instantiates it (until this change set adds `service_unavailable`). Unknown errors map to `500` + `ErrorEnvelope`; Postgres `42501` → `403`; transient deps → `503 service_unavailable` (new). So a **bodyless** 503 with no matching app log is the **Render edge**, not the app.
- The DELETE handler is clean: `UPDATE documents SET deleted_at … → c.body(null, 204)`, no post-commit side effects. ~14 other deletes use the identical `c.body(null, 204)` path through the same idempotency middleware, so this is **not documents-specific**.
- Two plausible mechanisms for an edge 503 on a request whose write commits:
  - **Track A — timeout/hang:** something after the commit (e.g. the inline `complete_idempotency_key`) stalls and Render's ~30s edge timeout fires.
  - **Track B — fast malformed 204:** Render's HTTP/2 proxy rejects the 204 (e.g. a stray `Content-Length`/`Transfer-Encoding`) and resets the stream.

The **latency of the 503 is the discriminator** and was not in the report.

## Diagnose

1. **Local** (`pnpm --filter ./api dev`, `:8787`). Create a tenancy + document, then:
   ```sh
   curl -i -w '\n%{http_code} %{time_total}s\n' -X DELETE \
     -H "Authorization: Bearer $JWT" -H "Idempotency-Key: $(uuidgen)" \
     http://localhost:8787/v1/accounts/$ACC/documents/$DOC
   ```
   Expect `204`, empty body, sub-second. Repeat for a **lease** delete (identical pattern) to confirm the behaviour is shared, not documents-specific.
2. **Prod** (HTTP only — no DB creds, per the prod-reads policy). Same `curl -i -w` against the Render URL.
   - **Fast 503, low `time_total`** → Track B (edge/204 interaction).
   - **`time_total` ≈ 25–30s then bodyless 503** → Track A (post-commit hang to the edge timeout).
3. **Render logs.** Filter by the `x-request-id` returned (`request-log.ts` sets it). A `"ms"` near 25–30k confirms a hang; **no app log line for the request** confirms the edge produced the 503.

## Fix posture (this change set)

- **Track A + reliability (done, ships regardless):** app-level request timeout → typed `503 service_unavailable` + `Retry-After` (the app now responds before the edge at 25s < ~30s); bounded `complete_idempotency_key` so a slow completion can't gate the response; `claim_idempotency_key` reclaims an abandoned in-flight key after ~90s; `healthCheckPath: /livez`; Node connection-hygiene timeouts. After deploy, re-run step 2 — a slow-hang 503 should become a typed 503 (or disappear).
- **Track B (contingent on step 2 showing a *fast* 503):** verify `@hono/node-server`'s 204 emission (no stray `Content-Length`/`Transfer-Encoding`); if Render's proxy rejects it, normalize the delete responses (strip the offending header, or return `200 {deleted:true}` across the delete handlers). Do **not** churn every delete endpoint until the diagnosis confirms this is the cause.
