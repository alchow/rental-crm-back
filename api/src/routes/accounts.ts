import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { newApiApp } from './_lib/app';
import { getSb } from '../supabase/request-client';
import type { DbTableUpdate } from '../supabase/db-types';
import { loadEnv } from '../env';
import { ApiError, dbError, errorResponses } from './_lib/error';
import {
  brandedReplyDomain,
  personaAddress,
  suggestEmailSubdomains,
  validateEmailSubdomain,
  validatePersonaLocalPart,
  validateSenderDisplayName,
} from './_lib/subdomain';
// The taken-oracle is a service_role-only RPC (migration 20260721000001), so it
// is reachable only through the admin quarantine — same cross-import precedent
// as routes/comms/persona.ts importing admin/persona-ack.
import { emailSubdomainsTaken } from '../admin/subdomains-taken';

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
  accountId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'accountId', in: 'path' } }),
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

const EmailBrandingSuggestions = z
  .object({
    /** Up to 5 branded subdomain labels derived from the account name that are
     *  valid (format + reserved/premium rules) AND not already claimed by any
     *  account. May be empty (e.g. a purely generic name whose every candidate
     *  is reserved). Ordered brandiest-first. */
    suggested_subdomains: z.array(z.string()).max(5),
    /** A suggested From display name: the account's existing
     *  sender_display_name when set, otherwise the account name (trimmed,
     *  control-chars stripped, capped at 120 — re-submittable through PATCH).
     *  Null only when the account name reduces to empty after stripping. */
    suggested_display_name: z.string().nullable(),
    /** Suggested persona LOCAL PARTS (bare labels like 'riley', NOT the full
     *  '<local>@<sub>.<parent>' address), filtered to those that pass persona
     *  validation. A stable starter set; the landlord may PATCH any valid value
     *  instead. */
    suggested_persona_local_parts: z.array(z.string()),
  })
  .openapi('EmailBrandingSuggestions');

const getBranding = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/email-branding',
  tags: ['accounts'],
  summary: "Get an account's email branding",
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
  summary: "Update an account's email branding (partial; owner/manager only)",
  request: {
    params: AccountParam,
    body: { content: { 'application/json': { schema: PatchEmailBrandingBody } }, required: true },
  },
  responses: {
    200: {
      description: 'updated branding',
      content: { 'application/json': { schema: EmailBranding } },
    },
    ...errorResponses,
  },
});

const getBrandingSuggestions = createRoute({
  method: 'get',
  path: '/accounts/{accountId}/email-branding/suggestions',
  tags: ['accounts'],
  summary: "Suggest email branding for an account (owner/manager only)",
  request: { params: AccountParam },
  responses: {
    200: {
      description: 'branding suggestions',
      content: { 'application/json': { schema: EmailBrandingSuggestions } },
    },
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

// C0/DEL/C1 control characters — stripped from a derived display-name suggestion
// so it is always re-submittable through PATCH (the sender_display_name validator
// rejects these). Mirrors the 20260707000001 backfill's regexp_replace set.
// eslint-disable-next-line no-control-regex
const DISPLAY_CTRL_RE = /[\x00-\x1f\x7f-\x9f]/g;

// Suggest a From display name: the existing sender_display_name when set,
// otherwise the account name trimmed, control-stripped, and capped at 120 — the
// same shape the signup default / backfill (20260707000001) produces. Null when
// the name reduces to empty (matches that backfill's nullif('')).
function suggestedDisplayName(existing: string | null, accountName: string): string | null {
  if (existing !== null) return existing;
  const derived = accountName.trim().replace(DISPLAY_CTRL_RE, '').slice(0, 120);
  return derived.length > 0 ? derived : null;
}

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
  const update: DbTableUpdate<'accounts'> = { updated_at: new Date().toISOString() };
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
    // Reserved-label backstop tripped (the reserved_subdomain_labels write
    // trigger and the branding format/reserved CHECKs raise 23514). This exists
    // to cover the drift window: a label RELEASED from premium-subdomains.json
    // passes the file-based validator (validateEmailSubdomain) immediately, but
    // the DB backstop row lingers until the next boot sync reconciles the table
    // — so a just-released label can clear the API validator yet still trip the
    // trigger. Surface it as the same friendly validation 422 the validator
    // would have produced, not a 500. (23505 → 409 above is unaffected.)
    if (error.code === '23514') {
      throw new ApiError(422, 'invalid_request', 'email branding input is invalid', {
        fieldErrors: { email_subdomain: ['is a reserved name'] },
      });
    }
    throw dbError(error);
  }
  if (!data) throw new ApiError(404, 'not_found', 'not found');

  return c.json(brandingResponse(data as unknown as BrandingRow), 200);
});

// Persona local parts offered by default. Filtered through validatePersonaLocalPart
// so a name that ever lands on the reserved/token lists is dropped rather than
// suggested. Order is the presentation order.
const PERSONA_STARTERS = ['riley', 'assistant', 'office', 'hello'] as const;

interface SuggestRow extends BrandingRow {
  name: string;
}

accountsApp.openapi(getBrandingSuggestions, async (c) => {
  // The taken-oracle (`_email_subdomains_taken`, which reveals whether a
  // candidate label is claimed by ANY account) is service_role-only at the DB
  // grant — it is called server-side via the admin client (emailSubdomainsTaken),
  // never off this user's JWT. requireManager gates the HTTP surface to
  // owner/manager, the same principals who would learn "taken" from a 409 anyway.
  requireManager(c);
  const { accountId } = c.req.valid('param');
  const sb = getSb(c);

  const { data, error } = await sb
    .from('accounts')
    .select(`name, ${BRANDING_COLS}`)
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'not found');
  const row = data as unknown as SuggestRow;

  // Derive candidates (pure), then a SINGLE round trip to learn which are taken.
  const candidates = suggestEmailSubdomains(row.name);
  let taken = new Set<string>();
  if (candidates.length > 0) {
    taken = new Set(await emailSubdomainsTaken(candidates));
  }
  const suggested_subdomains = candidates.filter((s) => !taken.has(s)).slice(0, 5);

  const suggested_persona_local_parts = PERSONA_STARTERS.filter(
    (p) => validatePersonaLocalPart(p).ok,
  );

  const body: z.infer<typeof EmailBrandingSuggestions> = {
    suggested_subdomains,
    suggested_display_name: suggestedDisplayName(row.sender_display_name, row.name),
    suggested_persona_local_parts,
  };
  return c.json(body, 200);
});
