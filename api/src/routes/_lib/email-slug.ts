// Per-account email-slug policy: normalisation, format, the reserved-name
// list, and From-header composition. Shared by the account-email route (echo
// + validation) and admin/account-email.ts (send-time resolution), so the
// address a landlord previews is byte-identical to the one on the wire.
//
// Format is DNS-label-safe (stricter than an RFC 5321 local part) and mirrors
// the accounts.email_slug DB CHECK (20260703000003) exactly -- the DB is the
// backstop, this is the front door with readable errors.

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Local parts that either carry protocol meaning (RFC 2142), imply the
// platform itself, or invite abuse on a shared domain. Policy, not schema:
// extend freely -- existing stored slugs are never re-validated against it.
const RESERVED_SLUGS = new Set([
  // RFC 2142 + operational mailboxes
  'abuse', 'admin', 'administrator', 'hostmaster', 'info', 'mailer-daemon',
  'noc', 'postmaster', 'root', 'security', 'support', 'webmaster',
  // sending/receiving infrastructure
  'bounce', 'bounces', 'mail', 'mx', 'no-reply', 'noreply', 'reply', 'send',
  'smtp', 'unsubscribe',
  // platform-identity words
  'api', 'app', 'billing', 'contact', 'dev', 'demo', 'help', 'hello',
  'legal', 'notifications', 'sales', 'staging', 'system', 'team', 'test',
  'www',
]);

/** Trim + lowercase; empty in -> null (clear). */
export function normalizeEmailSlug(raw: string | null): string | null {
  if (raw === null) return null;
  const slug = raw.trim().toLowerCase();
  return slug === '' ? null : slug;
}

/**
 * Validate a NORMALISED slug. Returns null when acceptable, otherwise a
 * human-readable reason (the route maps it onto a 422).
 */
export function emailSlugError(slug: string): string | null {
  if (!SLUG_RE.test(slug)) {
    return 'email slug must be 1-63 characters: lowercase letters, digits, and interior hyphens';
  }
  if (RESERVED_SLUGS.has(slug)) {
    return `'${slug}' is reserved and cannot be used as an email slug`;
  }
  return null;
}

/**
 * Compose the RFC 5322 From value for an account: `Name <slug@domain>`.
 * Returns null unless both the slug and the platform domain are set.
 *
 * The display name is derived from the free-text account name, so it is
 * sanitised for header safety: CR/LF and other control characters are
 * stripped (header-injection guard) and the result is quoted whenever it
 * contains anything outside RFC 5322 atext.
 */
export function composeFromAddress(
  accountName: string | null,
  slug: string | null,
  domain: string | null,
): string | null {
  if (!slug || !domain) return null;
  const address = `${slug}@${domain}`;
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const name = (accountName ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) return address;
  if (/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~.]+$/.test(name)) {
    return `${name} <${address}>`;
  }
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${address}>`;
}
