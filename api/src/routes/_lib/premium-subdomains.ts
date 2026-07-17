// Premium email-subdomain loader — the config file is the single source of
// truth for the property-category names the platform reserves for RESALE.
//
// The list lives in api/src/config/premium-subdomains.json (a JSON object, so
// it self-documents). Removing a name there releases it for the next
// owner/manager to claim (the sale flow); adding one reserves it. Both take
// effect at the next deploy — no migration per edit. The DB backstop
// (public.reserved_subdomain_labels) is reconciled to the file's premium rows
// on every API boot (admin/sync-premium-subdomains.ts).
//
// WHY THE RESERVED/OPS/FORMAT PRIMITIVES LIVE HERE (not in subdomain.ts):
// subdomain.ts imports PREMIUM_SUBDOMAINS from this module, and this module
// needs RESERVED_SUBDOMAINS + OPS_SUBDOMAINS + the label rule to VALIDATE the
// file at module-eval time (PREMIUM_SUBDOMAINS below is computed on import). If
// those constants stayed in subdomain.ts, this module would import them back —
// a cycle whose eval order lands RESERVED_SUBDOMAINS in the temporal dead zone
// and crashes on boot. So the label primitives are OWNED here (a leaf that
// imports only the JSON) and RE-EXPORTED from subdomain.ts, so nothing that
// imported them before has to change.

import premiumConfig from '../../config/premium-subdomains.json';

// A single lowercase DNS label: 1..63 chars, starts and ends alphanumeric,
// hyphens allowed only in the interior. Same regex the DB CHECK enforces.
export const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Reserved labels a landlord may never claim: operational hostnames, mail
// infrastructure, and support/abuse mailbox local-parts that would collide
// with platform or provider expectations if they became a receiving subdomain.
// MIRRORED by the accounts_email_subdomain_reserved DB CHECK (migration
// 20260704000001) — the unbypassable backstop for direct column-granted
// PostgREST writes. Keep the two lists identical; evolving the list means a
// migration and an API change together.
export const RESERVED_SUBDOMAINS: readonly string[] = [
  'www', 'mail', 'api', 'app', 'admin', 'root',
  'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2', 'ftp',
  'webmail', 'email', 'reply', 'noreply', 'no-reply',
  'bounce', 'bounces', 'unsubscribe',
  'abuse', 'postmaster', 'support', 'help', 'info',
  'billing', 'security', 'status',
  'dev', 'staging', 'test', 'internal',
];

// Ops additions: mail-infrastructure / discovery hostnames the original
// RESERVED_SUBDOMAINS list missed. Kept as a SEPARATE list so the OLD
// accounts_email_subdomain_reserved DB CHECK (migration 20260704000001) stays
// byte-for-byte in sync with RESERVED_SUBDOMAINS. These are migration-managed
// (seeded as kind='ops' in reserved_subdomain_labels, 20260721000001) — the
// boot sync NEVER touches ops rows.
//   dkim/dmarc/spf/mta   — mail-auth + transfer hostnames a receiving subdomain
//                          would shadow.
//   autodiscover/autoconfig — the client mail-autoconfiguration well-known names.
//   smoke                — the platform's synthetic deliverability probe subdomain.
//   sterling             — the platform's own brand; reserved so no tenant impersonates it.
export const OPS_SUBDOMAINS: readonly string[] = [
  'smoke', 'dkim', 'dmarc', 'spf', 'mta', 'autodiscover', 'autoconfig', 'sterling',
];

// The SMTP2GO return-path shape (`em<digits>.<parent>` bounce CNAME). A premium
// label matching this would collide with that provider record, so it is
// forbidden in the file. Mirrors EM_RETURN_PATH_RE in subdomain.ts.
const EM_SHAPE_RE = /^em\d+$/;

/**
 * Validate a raw premium-subdomains list (the parsed JSON's `premium_subdomains`
 * value). PURE and STRICT: it throws an Error naming the offending entry and why
 * on the FIRST violation, so a bad config file fails loudly at import time
 * (boot/test) rather than silently shipping a broken reserved list.
 *
 * Every entry must be: a lowercase RFC-1035 label (LABEL_RE), at most 63 chars,
 * not an xn-- (IDNA) label, not the em<digits> return-path shape, not already an
 * operational (RESERVED_SUBDOMAINS) or ops (OPS_SUBDOMAINS) reserved name, and
 * not a duplicate of an earlier entry. Returns the validated labels.
 */
export function validatePremiumList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `premium_subdomains must be an array, got ${raw === null ? 'null' : typeof raw}`,
    );
  }
  const reserved = new Set(RESERVED_SUBDOMAINS);
  const ops = new Set(OPS_SUBDOMAINS);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new Error(
        `premium_subdomains entry must be a string, got ${
          entry === null ? 'null' : typeof entry
        } (${JSON.stringify(entry)})`,
      );
    }
    if (entry.length > 63) {
      throw new Error(`premium subdomain "${entry}" is too long (max 63 characters)`);
    }
    if (entry !== entry.toLowerCase()) {
      throw new Error(`premium subdomain "${entry}" must be lowercase`);
    }
    if (!LABEL_RE.test(entry)) {
      throw new Error(
        `premium subdomain "${entry}" is not a valid lowercase RFC-1035 label ` +
          '(a-z, 0-9, interior hyphens; no leading/trailing hyphen)',
      );
    }
    if (entry.startsWith('xn--')) {
      throw new Error(`premium subdomain "${entry}" must not be an internationalised (xn--) label`);
    }
    if (EM_SHAPE_RE.test(entry)) {
      throw new Error(
        `premium subdomain "${entry}" collides with the SMTP2GO return-path shape em<digits>`,
      );
    }
    if (reserved.has(entry)) {
      throw new Error(`premium subdomain "${entry}" is already an operational reserved name`);
    }
    if (ops.has(entry)) {
      throw new Error(`premium subdomain "${entry}" is already an ops reserved name`);
    }
    if (seen.has(entry)) {
      throw new Error(`premium subdomain "${entry}" is a duplicate`);
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

// Premium property-category names the platform intends to SELL, loaded and
// FROZEN from the config file at import time. A malformed file throws here — by
// design, so the failure surfaces on boot/test, not as a silent policy hole.
// Rejected with a DISTINCT reason in validateEmailSubdomain (subdomain.ts) so
// the frontend can render a "reserved for resale" upsell.
export const PREMIUM_SUBDOMAINS: readonly string[] = Object.freeze(
  validatePremiumList((premiumConfig as { premium_subdomains: unknown }).premium_subdomains),
);
