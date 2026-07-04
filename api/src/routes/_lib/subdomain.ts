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

// A single lowercase DNS label: 1..63 chars, starts and ends alphanumeric,
// hyphens allowed only in the interior. Same regex the DB CHECK enforces.
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// C0/C1 control characters (incl. newlines/tabs). Rejected in a display name:
// they have no place there and are a header-injection vector on the transport
// side, which renders the value into a mail From header.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

// Reserved labels a landlord may never claim: operational hostnames, mail
// infrastructure, and support/abuse mailbox local-parts that would collide
// with platform or provider expectations if they became a receiving subdomain.
// MIRRORED by the accounts_email_subdomain_reserved DB CHECK (migration
// 20260704000001) — the unbypassable backstop for direct column-granted
// PostgREST writes. Keep the two lists identical; evolving the list means a
// migration and an API change together.
const RESERVED_SUBDOMAINS: readonly string[] = [
  'www', 'mail', 'api', 'app', 'admin', 'root',
  'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2', 'ftp',
  'webmail', 'email', 'reply', 'noreply', 'no-reply',
  'bounce', 'bounces', 'unsubscribe',
  'abuse', 'postmaster', 'support', 'help', 'info',
  'billing', 'security', 'status',
  'dev', 'staging', 'test', 'internal',
];

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
  if (RESERVED_SUBDOMAINS.includes(value)) {
    return { ok: false, reason: 'is a reserved name' };
  }
  return { ok: true, value };
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
