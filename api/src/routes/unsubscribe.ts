import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { ApiError, errorResponses } from './_lib/error';
import {
  bumpUnsubscribeIpRate,
  verifyUnsubscribeToken,
  registerEmailUnsubscribe,
  unsubscribeConfigured,
} from '../admin/unsubscribe';

// ============================================================================
// PUBLIC email unsubscribe (CAN-SPAM single-visit + RFC 8058 one-click).
// ============================================================================
//
// Mounted OUTSIDE the /v1/accounts auth stack (no JWT; the signed HMAC token IS
// the auth and carries the recipient address). The transport repo mints the
// per-address URLs statelessly from the shared UNSUBSCRIBE_HMAC_SECRET and puts
// them in the email body and the List-Unsubscribe header. ALL service-role work
// is quarantined in ../admin/unsubscribe; this file only calls those functions.

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  return null;
}

async function guard(c: Parameters<typeof clientIp>[0]): Promise<void> {
  const ip = clientIp(c);
  if (!ip) return;
  const { ok } = await bumpUnsubscribeIpRate(ip);
  if (!ok) throw new ApiError(429, 'conflict', 'rate limit exceeded; try again later');
}

const rateLimitedResponse = {
  429: {
    description: 'rate limited',
    content: { 'application/json': { schema: errorResponses[400].content['application/json'].schema } },
  },
} as const;

const TokenParam = z.object({
  token: z.string().min(1).max(2000).openapi({ param: { name: 'token', in: 'path' } }),
});

const UnsubscribeResponse = z
  .object({ status: z.literal('unsubscribed') })
  .openapi('UnsubscribeResponse');

export const unsubscribeApp = newApiApp();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

// Shared guard -> configured-check -> verify -> register. Registering here (on
// BOTH the GET and the POST) is deliberate: CAN-SPAM honors a single visit, and
// many recipients (and some clients) unsubscribe simply by opening the link,
// while Gmail/Yahoo one-click uses the POST. The register is idempotent, so a
// GET followed by the provider's POST (or any replay) is harmless.
async function resolveAndRegister(
  c: Parameters<typeof clientIp>[0],
  token: string,
): Promise<string> {
  await guard(c);
  if (!unsubscribeConfigured()) {
    throw new ApiError(503, 'service_unavailable', 'the unsubscribe endpoint is not configured');
  }
  const address = verifyUnsubscribeToken(token);
  // Uniform 404 for BOTH a malformed token and a bad signature — no oracle that
  // distinguishes "this was a real, signed address" from "garbage".
  if (!address) throw new ApiError(404, 'not_found', 'invalid or expired unsubscribe link');
  await registerEmailUnsubscribe(address); // idempotent — replays are fine
  return address;
}

// --- GET (renders a confirmation page; single-visit honoring) ---------------
const getRoute = createRoute({
  method: 'get',
  path: '/unsubscribe/email/{token}',
  tags: ['unsubscribe'],
  summary: 'Unsubscribe an email address via a signed link and render a confirmation page',
  request: { params: TokenParam },
  responses: {
    200: { description: 'unsubscribed', content: { 'text/html': { schema: z.string() } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
unsubscribeApp.openapi(getRoute, async (c) => {
  const { token } = c.req.valid('param');
  const address = await resolveAndRegister(c, token);
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Unsubscribed</title></head><body>' +
    `<p>You're unsubscribed — ${escapeHtml(address)} will no longer receive email from this sender.</p>` +
    '</body></html>';
  // A text/html response resolves to a bare Response in the route's typed union
  // (only application/*json and text/plain map to a TypedResponse), so c.html's
  // Response satisfies it directly.
  return c.html(html, 200);
});

// --- POST (RFC 8058 List-Unsubscribe=One-Click) -----------------------------
// Mail providers POST application/x-www-form-urlencoded (List-Unsubscribe=
// One-Click). We MUST NOT require or parse a request body, so none is declared
// on this route (the body is ignored entirely).
const postRoute = createRoute({
  method: 'post',
  path: '/unsubscribe/email/{token}',
  tags: ['unsubscribe'],
  summary: 'RFC 8058 one-click unsubscribe (no request body; returns JSON)',
  request: { params: TokenParam },
  responses: {
    200: { description: 'unsubscribed', content: { 'application/json': { schema: UnsubscribeResponse } } },
    ...errorResponses,
    ...rateLimitedResponse,
  },
});
unsubscribeApp.openapi(postRoute, async (c) => {
  const { token } = c.req.valid('param');
  await resolveAndRegister(c, token);
  return c.json({ status: 'unsubscribed' as const }, 200);
});
