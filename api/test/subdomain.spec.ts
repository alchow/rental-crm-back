// Unit spec for the per-account email-branding validators (routes/_lib/subdomain.ts).
// Pure functions — no env, no DB. Locks the RFC-1035 label rules, the reserved-
// word policy, the display-name guards, and the branded-domain composition.

import { describe, expect, it } from 'vitest';
import {
  brandedReplyDomain,
  OPS_SUBDOMAINS,
  personaAddress,
  PREMIUM_SUBDOMAINS,
  RESERVED_SUBDOMAINS,
  suggestEmailSubdomains,
  validateEmailSubdomain,
  validatePersonaLocalPart,
  validateSenderDisplayName,
} from '../src/routes/_lib/subdomain';
import { validatePremiumList } from '../src/routes/_lib/premium-subdomains';

// The exact, stable reason string the frontend keys on to render a premium
// "reserved for resale" upsell (distinct from the generic reserved-name error).
const PREMIUM_REASON = 'is a premium name reserved by the platform';

// Keep in lockstep with RESERVED_SUBDOMAINS in subdomain.ts.
const RESERVED = [
  'www', 'mail', 'api', 'app', 'admin', 'root',
  'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2', 'ftp',
  'webmail', 'email', 'reply', 'noreply', 'no-reply',
  'bounce', 'bounces', 'unsubscribe',
  'abuse', 'postmaster', 'support', 'help', 'info',
  'billing', 'security', 'status',
  'dev', 'staging', 'test', 'internal',
];

describe('validateEmailSubdomain', () => {
  it('accepts a plain lowercase label', () => {
    expect(validateEmailSubdomain('acme')).toEqual({ ok: true, value: 'acme' });
  });

  it('accepts alphanumeric and interior hyphens', () => {
    expect(validateEmailSubdomain('acme-props-2')).toEqual({ ok: true, value: 'acme-props-2' });
    expect(validateEmailSubdomain('a1b2c3')).toEqual({ ok: true, value: 'a1b2c3' });
  });

  it('accepts a single character', () => {
    expect(validateEmailSubdomain('a')).toEqual({ ok: true, value: 'a' });
    expect(validateEmailSubdomain('7')).toEqual({ ok: true, value: '7' });
  });

  it('trims and lowercases before validating', () => {
    expect(validateEmailSubdomain('  Acme  ')).toEqual({ ok: true, value: 'acme' });
    expect(validateEmailSubdomain('ACME-Props')).toEqual({ ok: true, value: 'acme-props' });
  });

  it('accepts exactly 63 characters (the label boundary)', () => {
    const label = 'a'.repeat(63);
    expect(validateEmailSubdomain(label)).toEqual({ ok: true, value: label });
  });

  it('rejects 64 characters (over the boundary)', () => {
    const res = validateEmailSubdomain('a'.repeat(64));
    expect(res.ok).toBe(false);
  });

  it('rejects the empty string and whitespace-only input', () => {
    expect(validateEmailSubdomain('').ok).toBe(false);
    expect(validateEmailSubdomain('   ').ok).toBe(false);
  });

  it('rejects leading and trailing hyphens', () => {
    expect(validateEmailSubdomain('-acme').ok).toBe(false);
    expect(validateEmailSubdomain('acme-').ok).toBe(false);
    expect(validateEmailSubdomain('-').ok).toBe(false);
  });

  it('rejects dots (a subdomain is a single label, not a chain)', () => {
    expect(validateEmailSubdomain('acme.co').ok).toBe(false);
  });

  it('rejects underscores and other invalid characters', () => {
    expect(validateEmailSubdomain('acme_props').ok).toBe(false);
    expect(validateEmailSubdomain('acme props').ok).toBe(false);
    expect(validateEmailSubdomain('acme!').ok).toBe(false);
    expect(validateEmailSubdomain('acmé').ok).toBe(false);
  });

  it('rejects punycode/IDNA (xn--) labels', () => {
    expect(validateEmailSubdomain('xn--acme').ok).toBe(false);
    // Uppercased still normalizes to xn-- and is rejected.
    expect(validateEmailSubdomain('XN--80ak6aa92e').ok).toBe(false);
  });

  it('rejects every reserved word', () => {
    for (const word of RESERVED) {
      const res = validateEmailSubdomain(word);
      expect(res.ok, `expected reserved word "${word}" to be rejected`).toBe(false);
      // Case-insensitive: an uppercased reserved word is still rejected.
      expect(validateEmailSubdomain(word.toUpperCase()).ok, `uppercased "${word}"`).toBe(false);
    }
  });

  it('gives a machine-usable reason on failure', () => {
    const res = validateEmailSubdomain('mail');
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(typeof res.reason).toBe('string');
  });
});

// Ops additions (mirror OPS_SUBDOMAINS in subdomain.ts + the
// reserved_subdomain_labels write trigger backstop, migration 20260721000001).
const OPS = ['smoke', 'dkim', 'dmarc', 'spf', 'mta', 'autodiscover', 'autoconfig', 'sterling'];

describe('premium + ops reserved subdomains', () => {
  // File-integrity: the premium list is now loaded from the config file
  // (api/src/config/premium-subdomains.json via routes/_lib/premium-subdomains),
  // so these lock the invariants that used to be a fixed count + hardcoded array.
  it('is a non-empty, deduped list of well-formed labels', () => {
    expect(PREMIUM_SUBDOMAINS.length).toBeGreaterThan(0);
    // Deduped.
    expect(new Set(PREMIUM_SUBDOMAINS).size).toBe(PREMIUM_SUBDOMAINS.length);
    // Every entry passes its own format rules: lowercase RFC-1035 label, ≤63,
    // not an xn-- label, not the em<digits> return-path shape.
    for (const p of PREMIUM_SUBDOMAINS) {
      expect(p, `lowercase: ${p}`).toBe(p.toLowerCase());
      expect(p.length, `length: ${p}`).toBeLessThanOrEqual(63);
      expect(p, `label shape: ${p}`).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
      expect(p.startsWith('xn--'), `xn-- : ${p}`).toBe(false);
      expect(/^em\d+$/.test(p), `em<digits>: ${p}`).toBe(false);
    }
  });

  it('is disjoint from the RESERVED (operational) and OPS names', () => {
    const blocked = new Set([...RESERVED_SUBDOMAINS, ...OPS_SUBDOMAINS]);
    const overlap = PREMIUM_SUBDOMAINS.filter((p) => blocked.has(p));
    expect(
      overlap,
      `premium ∩ (reserved ∪ ops) must be empty, got: ${overlap.join(', ')}`,
    ).toEqual([]);
  });

  it('rejects every premium name with the EXACT premium reason', () => {
    for (const word of PREMIUM_SUBDOMAINS) {
      const res = validateEmailSubdomain(word);
      expect(res.ok, `expected premium "${word}" to be rejected`).toBe(false);
      if (!res.ok) expect(res.reason, `premium reason for "${word}"`).toBe(PREMIUM_REASON);
      // Case-insensitive: an uppercased premium name is still premium-rejected.
      const up = validateEmailSubdomain(word.toUpperCase());
      expect(up.ok, `uppercased premium "${word}"`).toBe(false);
      if (!up.ok) expect(up.reason).toBe(PREMIUM_REASON);
    }
  });

  it('rejects every ops name as a reserved name (not premium)', () => {
    for (const word of OPS) {
      const res = validateEmailSubdomain(word);
      expect(res.ok, `expected ops "${word}" to be rejected`).toBe(false);
      if (!res.ok) expect(res.reason, `ops reason for "${word}"`).toBe('is a reserved name');
    }
  });

  it('rejects the SMTP2GO return-path shape em<digits> as reserved', () => {
    for (const label of ['em682356', 'em1', 'em0']) {
      const res = validateEmailSubdomain(label);
      expect(res.ok, `expected "${label}" to be rejected`).toBe(false);
      if (!res.ok) expect(res.reason).toBe('is a reserved name');
    }
  });

  it('still accepts non-matching lookalikes ("em", "emily") and compounds', () => {
    // 'em' has no trailing digit; 'emily' is not em<digits>.
    expect(validateEmailSubdomain('em')).toEqual({ ok: true, value: 'em' });
    expect(validateEmailSubdomain('emily')).toEqual({ ok: true, value: 'emily' });
    // Only the EXACT premium label is reserved — a compound embedding one is legal.
    expect(validateEmailSubdomain('acme-properties')).toEqual({
      ok: true,
      value: 'acme-properties',
    });
  });
});

describe('validatePremiumList', () => {
  // The loader runs this on the config file at import time; a bad file must throw
  // a message that NAMES the offender so the failure is actionable.
  it('rejects a non-array', () => {
    expect(() => validatePremiumList('nope')).toThrow(/must be an array/);
    expect(() => validatePremiumList(null)).toThrow(/must be an array/);
    expect(() => validatePremiumList({ premium_subdomains: [] })).toThrow(/must be an array/);
  });

  it('rejects a non-string entry, naming it', () => {
    expect(() => validatePremiumList(['ok', 123])).toThrow(/must be a string.*123/);
    expect(() => validatePremiumList(['ok', null])).toThrow(/must be a string.*null/);
  });

  it('rejects an uppercase entry, naming it', () => {
    expect(() => validatePremiumList(['Rent'])).toThrow(/"Rent".*lowercase/);
  });

  it('rejects a badly-formed label, naming it', () => {
    expect(() => validatePremiumList(['acme_props'])).toThrow(/"acme_props".*valid.*label/);
    expect(() => validatePremiumList(['-acme'])).toThrow(/"-acme"/);
  });

  it("rejects an xn-- label, naming it", () => {
    expect(() => validatePremiumList(['xn--x'])).toThrow(/"xn--x".*xn--/);
  });

  it('rejects the em<digits> return-path shape, naming it', () => {
    expect(() => validatePremiumList(['em123'])).toThrow(/"em123".*em<digits>/);
  });

  it("rejects a reserved operational name ('mail'), naming it", () => {
    expect(() => validatePremiumList(['mail'])).toThrow(/"mail".*operational reserved/);
  });

  it("rejects an ops name ('smoke'), naming it", () => {
    expect(() => validatePremiumList(['smoke'])).toThrow(/"smoke".*ops reserved/);
  });

  it('rejects a duplicate, naming it', () => {
    expect(() => validatePremiumList(['acme', 'acme'])).toThrow(/"acme".*duplicate/);
  });

  it('accepts the real shipping file content', () => {
    // The frozen list is exactly what the loader validated on import; re-running
    // the validator over it must round-trip unchanged.
    expect(validatePremiumList([...PREMIUM_SUBDOMAINS])).toEqual([...PREMIUM_SUBDOMAINS]);
  });
});

describe('suggestEmailSubdomains', () => {
  it('derives core-first candidates from a typical name', () => {
    const out = suggestEmailSubdomains('Acme Ridge Property Management LLC');
    // Core (minus STOP 'llc', minus DOMAINY 'property'/'management') = [acme, ridge].
    expect(out.slice(0, 2)).toEqual(['acmeridge', 'acme-ridge']);
    // The '-hq'/'-team'/… variants seed off the first surviving base ('acmeridge').
    expect(out).toContain('acmeridge-hq');
    expect(out.length).toBeGreaterThan(2);
    expect(out.length).toBeLessThanOrEqual(8);
    // Every emitted candidate is itself valid.
    for (const s of out) expect(validateEmailSubdomain(s).ok, s).toBe(true);
  });

  it('falls back to all-tokens for an all-stopword-ish name (non-empty)', () => {
    // 'property'/'management' are DOMAINY and 'llc' is STOP, so core is empty;
    // the all-minus-STOP fallback ('property-management' — a legal compound)
    // keeps the result non-empty.
    const out = suggestEmailSubdomains('Property Management LLC');
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) expect(validateEmailSubdomain(s).ok, s).toBe(true);
  });

  it('strips diacritics to ascii-only labels', () => {
    const out = suggestEmailSubdomains('Café Ámbar Rentals');
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      expect(s, `ascii-only: ${s}`).toMatch(/^[a-z0-9-]+$/);
    }
    expect(out).toContain('cafeambar');
  });

  it('returns [] for a name that normalizes to empty', () => {
    expect(suggestEmailSubdomains('')).toEqual([]);
    expect(suggestEmailSubdomains('   ')).toEqual([]);
    expect(suggestEmailSubdomains('!!!')).toEqual([]);
  });
});

describe('validateSenderDisplayName', () => {
  it('accepts a normal display name and trims it', () => {
    expect(validateSenderDisplayName('  Acme Properties  ')).toEqual({
      ok: true,
      value: 'Acme Properties',
    });
  });

  it('accepts up to 120 characters and rejects 121', () => {
    expect(validateSenderDisplayName('x'.repeat(120))).toEqual({ ok: true, value: 'x'.repeat(120) });
    expect(validateSenderDisplayName('x'.repeat(121)).ok).toBe(false);
  });

  it('rejects empty and whitespace-only input', () => {
    expect(validateSenderDisplayName('').ok).toBe(false);
    expect(validateSenderDisplayName('   ').ok).toBe(false);
  });

  it('rejects control characters and newlines (header-injection guard)', () => {
    expect(validateSenderDisplayName('Acme\nEvil').ok).toBe(false);
    expect(validateSenderDisplayName('Acme\r\nBcc: x@y').ok).toBe(false);
    expect(validateSenderDisplayName('Acme\tProps').ok).toBe(false);
    expect(validateSenderDisplayName('Acme\x7fX').ok).toBe(false);
  });

  it('accepts unicode letters and punctuation', () => {
    expect(validateSenderDisplayName('Café Réalty, LLC').ok).toBe(true);
  });
});

describe('brandedReplyDomain', () => {
  it('composes <subdomain>.<parent> when both are set', () => {
    expect(brandedReplyDomain('acme', 'mail.example.com')).toBe('acme.mail.example.com');
  });

  it('lowercases the composed domain', () => {
    expect(brandedReplyDomain('Acme', 'Mail.Example.COM')).toBe('acme.mail.example.com');
  });

  it('returns null when the subdomain is unset', () => {
    expect(brandedReplyDomain(null, 'mail.example.com')).toBeNull();
  });

  it('returns null when the parent domain is unset', () => {
    expect(brandedReplyDomain('acme', null)).toBeNull();
  });

  it('returns null when both are unset', () => {
    expect(brandedReplyDomain(null, null)).toBeNull();
  });
});

// Keep in lockstep with RESERVED_LOCAL_PARTS in subdomain.ts (and the
// accounts_persona_local_part_reserved DB CHECK, 20260707000001).
const RESERVED_LOCALS = [
  'postmaster', 'abuse', 'mailer-daemon', 'hostmaster', 'webmaster',
  'admin', 'administrator', 'root',
  'noreply', 'no-reply', 'reply',
  'bounce', 'bounces', 'unsubscribe',
  'mail', 'email', 'smtp', 'imap', 'pop',
  'support', 'help', 'info', 'billing', 'security',
  'spam', 'dmarc', 'spf',
];

describe('validatePersonaLocalPart', () => {
  it('accepts a plain lowercase local part', () => {
    expect(validatePersonaLocalPart('riley')).toEqual({ ok: true, value: 'riley' });
  });

  it('trims and lowercases before validating', () => {
    expect(validatePersonaLocalPart('  Riley  ')).toEqual({ ok: true, value: 'riley' });
  });

  it('accepts interior dots, hyphens, and underscores', () => {
    expect(validatePersonaLocalPart('front.desk')).toEqual({ ok: true, value: 'front.desk' });
    expect(validatePersonaLocalPart('dave_office-1')).toEqual({ ok: true, value: 'dave_office-1' });
  });

  it('rejects leading/trailing punctuation and spaces', () => {
    expect(validatePersonaLocalPart('.riley').ok).toBe(false);
    expect(validatePersonaLocalPart('riley.').ok).toBe(false);
    expect(validatePersonaLocalPart('front desk').ok).toBe(false);
  });

  it('rejects the reply-token namespace (t- prefix)', () => {
    expect(validatePersonaLocalPart('t-riley').ok).toBe(false);
    expect(validatePersonaLocalPart('t-0123456789abcdef0123456789abcdef').ok).toBe(false);
  });

  it('rejects every reserved local part', () => {
    for (const name of RESERVED_LOCALS) {
      expect(validatePersonaLocalPart(name).ok, name).toBe(false);
    }
  });

  it('rejects empty input and over-length input', () => {
    expect(validatePersonaLocalPart('').ok).toBe(false);
    expect(validatePersonaLocalPart('a'.repeat(65)).ok).toBe(false);
  });
});

describe('personaAddress', () => {
  it('composes <local>@<subdomain>.<parent> when all three are set', () => {
    expect(personaAddress('riley', 'acme', 'mail.example.com')).toBe('riley@acme.mail.example.com');
  });

  it('returns null when the local part is unset', () => {
    expect(personaAddress(null, 'acme', 'mail.example.com')).toBeNull();
  });

  it('returns null when the subdomain is unset (persona is branded-only)', () => {
    expect(personaAddress('riley', null, 'mail.example.com')).toBeNull();
  });

  it('returns null when the parent domain is unset', () => {
    expect(personaAddress('riley', 'acme', null)).toBeNull();
  });
});
