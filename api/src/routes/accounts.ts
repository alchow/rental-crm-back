import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import { loadEnv } from '../env';
import { ApiError, dbError, errorResponses } from './_lib/error';
import {
  brandedReplyDomain,
  personaAddress,
  validateEmailSubdomain,
  validatePersonaLocalPart,
  validateSenderDisplayName,
} from './_lib/subdomain';

// ---------------------------------------------------------------------------
// Account-level settings — per-account email branding (branded reply subdomain
// + sender display name).
//
// Reply addresses are minted in comms.ts at thread creation. When an account
// carries an email_subdomain AND EMAIL_PLATFORM_PARENT_DOMAIN is configured,
// new email threads mint under `<subdomain>.<parent>`; otherwise they fall back
// to the shared EMAIL_REPLY_DOMAIN. sender_display_name is the From display
// name the transport renders. These routes read and (owner/manager only) write
// those two account columns; the DB enforces format + uniqueness, and the API
// layer (routes/_lib/subdomain.ts) enforces the reserved-word policy.
// ---------------------------------------------------------------------------

const AccountParam = z.object({
  accountId: z.string().uuid().openapi({ param: { name: 'accountId', in: 'path' } }),
});

const EmailBranding = z
  .object({
    /** The account's branded DNS label, or null when unset. */
    email_subdomain: z.string().nullable(),
    /** The From display name the transport renders on relayed mail; null when unset. */
    sender_display_name: z.string().nullable(),
    /** The computed full branded receiving domain (`<subdomain>.<parent>`) when
     *  BOTH the subdomain and EMAIL_PLATFORM_PARENT_DOMAIN are set; null
     *  otherwise (branded minting off — threads fall back to EMAIL_REPLY_DOMAIN). */
    reply_domain: z.string().nullable(),
    /** The local part of the account's persona address (e.g. 'riley'); null
     *  when the persona feature is off for the account. */
    persona_local_part: z.string().nullable(),
    /** The computed full persona address
     *  (`<persona_local_part>@<subdomain>.<parent>`) when the local part, the
     *  branded subdomain, AND the platform parent domain are all set; null
     *  otherwise. The persona is branded-subdomain-only by design — a local
     *  part on the shared reply domain would be ambiguous across accounts. */
    persona_address: z.string().nullable(),
  })
  .openapi('AccountEmailBranding');

const PatchEmailBrandingBody = z
  .object({
    /** Partial update. Omit to leave unchanged; explicit null clears the field. */
    email_subdomain: z.string().nullable().optional(),
    sender_display_name: z.string().nullable().optional(),
    persona_local_part: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  })
  .openapi('PatchAccountEmailBrandingBody');

const getBranding = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/email-branding',
  tags: ['accounts'],
  summary: 'Get an account\'s email branding',
  request: { params: AccountParam },
  responses: {
    200: { description: 'branding', content: { 'application/json': { schema: EmailBranding } } },
    ...errorResponses,
  },
});

const patchBranding = createRoute({
  method: 'patch',
  path: '/accounts/{accountId}/email-branding',
  tags: ['accounts'],
  summary: 'Update an account\'s email branding (partial; owner/manager only)',
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: PatchEmailBrandingBody } }, required: true },
  },
  responses: {
    200: { description: 'updated branding', content: { 'application/json': { schema: EmailBranding } } },
    ...errorResponses,
  },
});

export const accountsApp = newApiApp();

// Branding writes require owner|manager (viewers read; the agent principal
// holds role='agent' and is denied too). Same shape as comms.ts requireManager.
function requireManager(c: Context): void {
  const role = c.get('account').role;
  if (role !== 'owner' && role !== 'manager') {
    throw new ApiError(403, 'forbidden', 'only an owner or manager may use this endpoint');
  }
}

// Shape the account row + env into the API response (shared by GET and PATCH).
interface BrandingRow {
  email_subdomain: string | null;
  sender_display_name: string | null;
  persona_local_part: string | null;
}
function brandingResponse(row: BrandingRow): z.infer<typeof EmailBranding> {
  const parent = loadEnv().EMAIL_PLATFORM_PARENT_DOMAIN;
  return {
    email_subdomain: row.email_subdomain,
    sender_display_name: row.sender_display_name,
    reply_domain: brandedReplyDomain(row.email_subdomain, parent),
    persona_local_part: row.persona_local_part,
    persona_address: personaAddress(row.persona_local_part, row.email_subdomain, parent),
  };
}

const BRANDING_COLS = 'email_subdomain, sender_display_name, persona_local_part';

accountsApp.openapi(getBranding, async (c) => {
  const { accountId } = c.req.valid('param');
  const sb = getSb(c);

  const { data, error } = await sb
    .from('accounts')
    .select(BRANDING_COLS)
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'not found');

  return c.json(brandingResponse(data as unknown as BrandingRow), 200);
});

accountsApp.openapi(patchBranding, async (c) => {
  requireManager(c);
  const { accountId } = c.req.valid('param');
  const body = c.req.valid('json');
  const sb = getSb(c);

  // Validate + canonicalize each supplied field. Explicit null clears; a bad
  // value collects a field-scoped error so a two-bad-field PATCH reports both.
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const fieldErrors: Record<string, string[]> = {};

  if (body.email_subdomain !== undefined) {
    if (body.email_subdomain === null) {
      update.email_subdomain = null;
    } else {
      const res = validateEmailSubdomain(body.email_subdomain);
      if (res.ok) update.email_subdomain = res.value;
      else fieldErrors.email_subdomain = [res.reason];
    }
  }
  if (body.sender_display_name !== undefined) {
    if (body.sender_display_name === null) {
      update.sender_display_name = null;
    } else {
      const res = validateSenderDisplayName(body.sender_display_name);
      if (res.ok) update.sender_display_name = res.value;
      else fieldErrors.sender_display_name = [res.reason];
    }
  }
  if (body.persona_local_part !== undefined) {
    if (body.persona_local_part === null) {
      update.persona_local_part = null;
    } else {
      const res = validatePersonaLocalPart(body.persona_local_part);
      if (res.ok) update.persona_local_part = res.value;
      else fieldErrors.persona_local_part = [res.reason];
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new ApiError(422, 'invalid_request', 'email branding input is invalid', { fieldErrors });
  }

  const { data, error } = await sb
    .from('accounts')
    .update(update)
    .eq('id', accountId)
    .select(BRANDING_COLS)
    .maybeSingle();
  if (error) {
    // Global uniqueness on email_subdomain: another account already holds it.
    if (error.code === '23505') {
      throw new ApiError(409, 'conflict', 'email_subdomain is already taken');
    }
    throw dbError(error);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');

  return c.json(brandingResponse(data as unknown as BrandingRow), 200);
});
