import { createRoute, z } from '@hono/zod-openapi';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { ApiError, errorResponses } from './_lib/error';
import { composeFromAddress, emailSlugError, normalizeEmailSlug } from './_lib/email-slug';
import { loadEnv } from '../env';

// GET/PUT /v1/accounts/{accountId}/email-identity -- the account's outbound
// email identity (user-chosen local part on the ONE platform sending domain).
//
// Design (why a local part, not a subdomain): the platform verifies exactly
// one sending domain at the provider (Resend) + DNS, once, by hand. A chosen
// slug makes the account's mail `<slug>@<ACCOUNT_EMAIL_DOMAIN>` with the
// account name as display name -- no per-account provider domain, DNS record,
// or verification wait, because any local part on a verified domain is
// sendable. Per-account SUBDOMAINS (`@<slug>.domain`) would require a
// provider-verified domain per account; the slug format stays DNS-label-safe
// so that upgrade remains a rename-free migration if ever wanted.
//
// Authorization: any member may READ the identity; only an account OWNER may
// change it (the write goes through the set_account_email_slug SECURITY
// DEFINER RPC -- accounts has select-only RLS -- which enforces the owner
// check with 42501). The agent principal is refused up front: an account's
// sending identity is a human decision, never agent-writable.
//
// from_address is a PREVIEW of what the mailer will put on the wire
// (admin/account-email.ts composes through the same _lib helper). It is null
// until both the slug and the platform domain are configured.

const EmailIdentity = z
  .object({
    /** The account's chosen local part; null when unset. */
    email_slug: z.string().nullable(),
    /** The platform-wide sending domain (env ACCOUNT_EMAIL_DOMAIN); null when the platform has not configured one. */
    email_domain: z.string().nullable(),
    /** The exact From value outbound mail will carry ("Name <slug@domain>"); null unless slug AND domain are set. */
    from_address: z.string().nullable(),
  })
  .openapi('AccountEmailIdentity');

const PutEmailIdentityBody = z
  .object({
    /** The desired local part (trimmed + lowercased server-side); null clears it. */
    email_slug: z.string().min(1).max(63).nullable(),
  })
  .openapi('PutAccountEmailIdentityBody');

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});

const getRoute = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/email-identity',
  tags: ['account-email'],
  summary: "Get the account's outbound email identity",
  request: { params: AccountParam },
  responses: {
    200: { description: 'identity', content: { 'application/json': { schema: EmailIdentity } } },
    ...errorResponses,
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/accounts/{accountId}/email-identity',
  tags: ['account-email'],
  summary: "Set or clear the account's email slug (owner only)",
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: PutEmailIdentityBody } }, required: true },
  },
  responses: {
    200: { description: 'updated identity', content: { 'application/json': { schema: EmailIdentity } } },
    ...errorResponses,
  },
});

export const accountEmailApp = newApiApp();

function identityJson(name: string | null, slug: string | null) {
  const domain = loadEnv().ACCOUNT_EMAIL_DOMAIN;
  return {
    email_slug: slug,
    email_domain: domain,
    from_address: composeFromAddress(name, slug, domain),
  };
}

accountEmailApp.openapi(getRoute, async (c) => {
  const { accountId } = c.req.valid('param');
  const sb = getSb(c);
  const { data, error } = await sb
    .from('accounts')
    .select('name, email_slug')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw new ApiError(500, 'database_error', error.message);
  if (!data) throw new ApiError(404, 'not_found', 'account not found');
  return c.json(identityJson(data.name as string, (data.email_slug as string | null) ?? null), 200);
});

accountEmailApp.openapi(putRoute, async (c) => {
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');

  if (c.get('principal').type === 'agent') {
    throw new ApiError(403, 'forbidden', 'the agent may not change the account email identity');
  }

  const slug = normalizeEmailSlug(body.email_slug);
  if (slug !== null) {
    const reason = emailSlugError(slug);
    if (reason) throw new ApiError(422, 'invalid_email_slug', reason);
  }

  const sb = getSb(c);
  const { data, error } = await sb.rpc('set_account_email_slug', {
    p_account_id: accountId,
    p_slug: slug,
  });
  if (error) {
    // The RPC's typed refusals, mapped onto the API envelope. 23514 is the
    // belt-and-braces format backstop -- normally unreachable past the
    // validation above.
    if (error.code === '42501')
      throw new ApiError(403, 'forbidden', 'only an account owner may set the email slug');
    if (error.code === '23505')
      throw new ApiError(409, 'conflict', `the email slug '${slug}' is already taken`);
    if (error.code === '23514')
      throw new ApiError(422, 'invalid_email_slug', error.message);
    if (error.code === 'P0002') throw new ApiError(404, 'not_found', 'account not found');
    throw new ApiError(500, 'database_error', error.message);
  }

  // Echo through the same read the GET uses (name comes from the account row,
  // not the request), so the preview matches what a re-GET returns.
  const { data: account, error: readError } = await sb
    .from('accounts')
    .select('name')
    .eq('id', accountId)
    .maybeSingle();
  if (readError) throw new ApiError(500, 'database_error', readError.message);
  return c.json(identityJson((account?.name as string | null) ?? null, (data as string | null) ?? null), 200);
});
