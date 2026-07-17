// Per-account email-branding validation — pure, DB-free, no env. The API layer
// (routes/accounts.ts) is the sole place branding input is validated; the DB
// enforces only the RFC-1035 FORMAT and global uniqueness (migration
// 20260704000001). Everything policy-shaped lives here so the reserved-word
// list can evolve without a migration.
//
// A branded subdomain becomes a public DNS label under the platform parent
// domain (`<subdomain>.<parent>`), so it must be a single lowercase RFC-1035
// label AND must not collide with an operational or reserved name. This module
// is a pure validator: it RETURNS a result and never throws — the caller
// (routes/accounts.ts) maps a failure to a 422 with field errors.
//
// The RFC-1035 label rule (LABEL_RE), the operational reserved list
// (RESERVED_SUBDOMAINS), and the ops list (OPS_SUBDOMAINS) are OWNED by the
// premium-subdomains loader (./premium-subdomains) — see that file for WHY
// (an import-cycle break). They are imported and RE-EXPORTED here so importers
// that resolved them from subdomain.ts are unaffected.
//
// The PREMIUM property-category names are no longer hardcoded here: they live
// in api/src/config/premium-subdomains.json, loaded + validated by
// ./premium-subdomains. Removing a name there RELEASES it for the next
// owner/manager to claim (the sale flow); adding one reserves it — both take
// effect at the next deploy. The DB backstop (public.reserved_subdomain_labels)
// is reconciled to that file's premium rows on every API boot
// (admin/sync-premium-subdomains.ts), so the list evolves without a migration.
import {
  LABEL_RE,
  OPS_SUBDOMAINS,
  PREMIUM_SUBDOMAINS,
  RESERVED_SUBDOMAINS,
} from './premium-subdomains';

// Re-export the loader-owned lists so callers keep resolving them from
// subdomain.ts (their pre-cycle-break home).
export { OPS_SUBDOMAINS, PREMIUM_SUBDOMAINS, RESERVED_SUBDOMAINS };

// C0/C1 control characters (incl. newlines/tabs). Rejected in a display name:
// they have no place there and are a header-injection vector on the transport
// side, which renders the value into a mail From header.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

// SMTP2GO return-path labels: the provider's bounce/return-path CNAME is
// `em<digits>.<parent>` (e.g. em682356.mail.example.com). A branded subdomain
// matching `em\d+` would collide with that provider record, so the whole shape
// is reserved — rejected as a reserved name (not premium).
const EM_RETURN_PATH_RE = /^em\d+$/;

export type SubdomainValidation =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Validate a candidate email subdomain. Trims and lowercases first (so a caller
 * pasting "  Acme " resolves to "acme"), then enforces the RFC-1035 label
 * format, rejects IDNA/punycode (`xn--`) labels, and rejects reserved names.
 * Returns the canonical value on success; a machine-usable reason on failure.
 * The caller maps a failure to a 422 field error.
 */
export function validateEmailSubdomain(raw: string): SubdomainValidation {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) {
    return { ok: false, reason: 'must not be empty' };
  }
  if (value.length > 63) {
    return { ok: false, reason: 'must be at most 63 characters' };
  }
  if (!LABEL_RE.test(value)) {
    return {
      ok: false,
      reason:
        'must be a single lowercase DNS label (a-z, 0-9, hyphen; no leading/trailing hyphen)',
    };
  }
  // Punycode/IDNA labels are rejected: a branded receiving subdomain must be a
  // plain ASCII label an operator can reason about, not an encoded homoglyph.
  if (value.startsWith('xn--')) {
    return { ok: false, reason: 'internationalised (xn--) labels are not allowed' };
  }
  if (RESERVED_SUBDOMAINS.includes(value) || OPS_SUBDOMAINS.includes(value)) {
    return { ok: false, reason: 'is a reserved name' };
  }
  // SMTP2GO return-path shape (`em<digits>`) is provider-owned — reserved.
  if (EM_RETURN_PATH_RE.test(value)) {
    return { ok: false, reason: 'is a reserved name' };
  }
  // Premium property-category names get a DISTINCT, STABLE reason string: the
  // frontend keys on this exact text to show a "reserved for resale" upsell.
  // Do not vary it.
  if (PREMIUM_SUBDOMAINS.includes(value)) {
    return { ok: false, reason: 'is a premium name reserved by the platform' };
  }
  return { ok: true, value };
}

// Corporate-suffix / filler tokens dropped when deriving a subdomain from an
// account name — they carry no brand identity ('Acme LLC' → 'acme').
const SUGGEST_STOP_WORDS: readonly string[] = [
  'llc', 'inc', 'co', 'corp', 'corporation', 'ltd', 'company',
  'the', 'of', 'and', 'group', 'mgmt',
];

// Property-domain tokens dropped when computing the CORE label — the branded
// subdomain hangs under a mail parent, so 'Acme Ridge Property Management' wants
// 'acmeridge', not 'acmeridgepropertymanagement'. Also, most of these are
// PREMIUM_SUBDOMAINS in their own right, so a core that dropped them avoids the
// premium wall. They are kept for the fuller all-minus-stop fallbacks below.
const SUGGEST_DOMAINY_WORDS: readonly string[] = [
  'property', 'properties', 'management', 'realty', 'rentals', 'rental',
  'homes', 'estates', 'real', 'estate', 'leasing', 'apartments', 'residential',
];

/**
 * Suggest up to 8 candidate email subdomains derived from an account name, in
 * priority order (shortest/brandiest first). Pure — no DB, no env. Every
 * candidate is run through validateEmailSubdomain, so reserved/premium/format
 * failures are dropped here rather than surfacing to the caller; the caller
 * (the suggestions endpoint) additionally filters already-taken labels and
 * caps the surfaced list. Note compounds like 'acme-properties' are LEGAL
 * (only the exact 'properties' label is reserved), so hyphenated fallbacks that
 * embed a domainy word survive.
 *
 * Data flow for 'Acme Ridge Property Management LLC':
 *   normalize → 'acme ridge property management llc'
 *   tokens    → [acme, ridge, property, management, llc]
 *   core      → [acme, ridge]                (minus STOP 'llc', minus DOMAINY)
 *   bases     → 'acmeridge', 'acme-ridge',
 *               'acmeridgepropertymanagement', 'acme-ridge-property-management'
 *   base(1st surviving) = 'acmeridge' → +'-hq','-team','-office','-pm'
 */
export function suggestEmailSubdomains(accountName: string): string[] {
  // Normalize: strip diacritics (NFD then drop combining marks), lowercase,
  // spell out '&', drop anything outside [a-z0-9 -], collapse whitespace.
  const normalized = accountName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // drop the combining diacritical marks NFD split off
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length === 0) return [];

  const tokens = normalized.split(' ').filter((t) => t.length > 0);
  const minusStop = tokens.filter((t) => !SUGGEST_STOP_WORDS.includes(t));
  const core = minusStop.filter((t) => !SUGGEST_DOMAINY_WORDS.includes(t));
  // Degenerate all-stopword name (e.g. 'The Of And'): fall back to all tokens
  // so we still emit something rather than an empty base.
  const fallback = minusStop.length > 0 ? minusStop : tokens;

  // Base candidates in priority order; skip empties (core may be empty when the
  // name is entirely stop/domainy words).
  const bases: string[] = [];
  if (core.length > 0) {
    bases.push(core.join(''), core.join('-'));
  }
  bases.push(fallback.join(''), fallback.join('-'));

  // The first base that passes validation seeds the '-hq'/'-team'/… variants.
  const base = bases.find((b) => b.length > 0 && validateEmailSubdomain(b).ok);
  const candidates = [...bases];
  if (base) {
    candidates.push(`${base}-hq`, `${base}-team`, `${base}-office`, `${base}-pm`);
  }

  // Validate, dedupe preserving order, cap at 8.
  const out: string[] = [];
  for (const cand of candidates) {
    if (cand.length === 0) continue;
    if (!validateEmailSubdomain(cand).ok) continue;
    if (out.includes(cand)) continue;
    out.push(cand);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Validate a candidate sender display name. Trims, rejects control characters
 * and newlines (they would corrupt the rendered From header), and enforces a
 * 1..120-char length matching the DB CHECK. Returns the canonical (trimmed)
 * value on success.
 */
export function validateSenderDisplayName(raw: string): SubdomainValidation {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, reason: 'must not be empty' };
  }
  if (value.length > 120) {
    return { ok: false, reason: 'must be at most 120 characters' };
  }
  if (CONTROL_RE.test(value)) {
    return { ok: false, reason: 'must not contain control characters or newlines' };
  }
  return { ok: true, value };
}

/**
 * Compute the full branded reply domain for an account, or null when branded
 * minting is off. Branding is active only when BOTH the account carries a
 * subdomain AND the platform parent domain is configured; otherwise callers
 * fall back to the shared EMAIL_REPLY_DOMAIN. Lowercased for parity with the
 * minted token and the equality-based resolve lookup.
 */
export function brandedReplyDomain(
  emailSubdomain: string | null,
  platformParentDomain: string | null,
): string | null {
  if (!emailSubdomain || !platformParentDomain) return null;
  return `${emailSubdomain}.${platformParentDomain}`.toLowerCase();
}

// A conservative lowercase email local part: 1..64 chars, starts and ends
// alphanumeric, dots/hyphens/underscores allowed in the interior. Same regex
// the accounts_persona_local_part_format DB CHECK enforces.
const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

// Reserved persona local parts: RFC-mandated mailboxes (postmaster, abuse),
// mail infrastructure, and support/ops names a landlord must not claim on a
// receiving domain. MIRRORED by the accounts_persona_local_part_reserved DB
// CHECK (migration 20260707000001) — the unbypassable backstop for direct
// column-granted PostgREST writes. Keep the two lists identical; evolving the
// list means a migration and an API change together.
const RESERVED_LOCAL_PARTS: readonly string[] = [
  'postmaster', 'abuse', 'mailer-daemon', 'hostmaster', 'webmaster',
  'admin', 'administrator', 'root',
  'noreply', 'no-reply', 'reply',
  'bounce', 'bounces', 'unsubscribe',
  'mail', 'email', 'smtp', 'imap', 'pop',
  'support', 'help', 'info', 'billing', 'security',
  'spam', 'dmarc', 'spf',
];

/**
 * Validate a candidate persona local part. Trims and lowercases first, then
 * enforces the local-part format, rejects the reply-token namespace (`t-`
 * prefix — minted tokens are `t-<32hex>@…` and the two namespaces must stay
 * disjoint forever), and rejects reserved names. Returns the canonical value
 * on success; a machine-usable reason on failure (caller maps to a 422 field
 * error).
 */
export function validatePersonaLocalPart(raw: string): SubdomainValidation {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) {
    return { ok: false, reason: 'must not be empty' };
  }
  if (value.length > 64) {
    return { ok: false, reason: 'must be at most 64 characters' };
  }
  if (!LOCAL_PART_RE.test(value)) {
    return {
      ok: false,
      reason:
        'must be a lowercase email local part (a-z, 0-9, dot, hyphen, underscore; no leading/trailing punctuation)',
    };
  }
  if (value.startsWith('t-')) {
    return { ok: false, reason: "must not start with 't-' (reserved for reply tokens)" };
  }
  if (RESERVED_LOCAL_PARTS.includes(value)) {
    return { ok: false, reason: 'is a reserved name' };
  }
  return { ok: true, value };
}

/**
 * Compute the account's full persona address, or null when the persona is
 * off. Active only when the local part, the branded subdomain, AND the
 * platform parent domain are all set — a persona on the shared reply domain
 * would be ambiguous across accounts, so it is branded-subdomain-only.
 */
export function personaAddress(
  personaLocalPart: string | null,
  emailSubdomain: string | null,
  platformParentDomain: string | null,
): string | null {
  const domain = brandedReplyDomain(emailSubdomain, platformParentDomain);
  if (!personaLocalPart || !domain) return null;
  return `${personaLocalPart}@${domain}`.toLowerCase();
}
