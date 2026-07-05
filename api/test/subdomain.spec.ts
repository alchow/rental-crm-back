// Unit spec for the per-account email-branding validators (routes/_lib/subdomain.ts).
// Pure functions — no env, no DB. Locks the RFC-1035 label rules, the reserved-
// word policy, the display-name guards, and the branded-domain composition.

import { describe, expect, it } from 'vitest';
import {
  brandedReplyDomain,
  validateEmailSubdomain,
  validateSenderDisplayName,
} from '../src/routes/_lib/subdomain';

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
