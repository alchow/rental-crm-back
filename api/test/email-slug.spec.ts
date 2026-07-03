// Unit spec for the per-account email-slug policy helpers (_lib/email-slug):
// normalisation, format + reserved-name validation, and From-header
// composition (incl. the header-injection guard). Pure functions -- no env,
// no DB.

import { describe, expect, it } from 'vitest';
import {
  composeFromAddress,
  emailSlugError,
  normalizeEmailSlug,
} from '../src/routes/_lib/email-slug';

describe('normalizeEmailSlug', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmailSlug('  Sunset ')).toBe('sunset');
    expect(normalizeEmailSlug('ACME-12')).toBe('acme-12');
  });

  it('maps null and whitespace-only to null (clear)', () => {
    expect(normalizeEmailSlug(null)).toBeNull();
    expect(normalizeEmailSlug('   ')).toBeNull();
    expect(normalizeEmailSlug('')).toBeNull();
  });
});

describe('emailSlugError', () => {
  it('accepts DNS-label-safe slugs', () => {
    expect(emailSlugError('sunset')).toBeNull();
    expect(emailSlugError('a')).toBeNull();
    expect(emailSlugError('acme-props-2')).toBeNull();
    expect(emailSlugError('a'.repeat(63))).toBeNull();
  });

  it('rejects bad shapes with a readable reason', () => {
    for (const bad of ['-sunset', 'sunset-', 'sun set', 'sünset', 'a'.repeat(64), 'UPPER', 'dot.ted', 'at@sign']) {
      expect(emailSlugError(bad), bad).toMatch(/1-63 characters/);
    }
  });

  it('rejects reserved local parts', () => {
    for (const reserved of ['postmaster', 'noreply', 'abuse', 'admin', 'unsubscribe', 'www']) {
      expect(emailSlugError(reserved), reserved).toMatch(/reserved/);
    }
  });
});

describe('composeFromAddress', () => {
  it('is null unless both slug and domain are set', () => {
    expect(composeFromAddress('Acme', null, 'mydomain.com')).toBeNull();
    expect(composeFromAddress('Acme', 'acme', null)).toBeNull();
    expect(composeFromAddress('Acme', null, null)).toBeNull();
  });

  it('composes "Name <slug@domain>" for plain names', () => {
    expect(composeFromAddress('Sunset Properties', 'sunset', 'mydomain.com')).toBe(
      'Sunset Properties <sunset@mydomain.com>',
    );
  });

  it('falls back to the bare address when the name is empty', () => {
    expect(composeFromAddress('', 'sunset', 'mydomain.com')).toBe('sunset@mydomain.com');
    expect(composeFromAddress(null, 'sunset', 'mydomain.com')).toBe('sunset@mydomain.com');
  });

  it('quotes and escapes names outside RFC 5322 atext', () => {
    expect(composeFromAddress('Chow, Al & Sons', 'chow', 'mydomain.com')).toBe(
      '"Chow, Al & Sons" <chow@mydomain.com>',
    );
    expect(composeFromAddress('Say "hi"', 'hi', 'mydomain.com')).toBe(
      '"Say \\"hi\\"" <hi@mydomain.com>',
    );
  });

  it('strips CR/LF and control characters (header-injection guard)', () => {
    expect(
      composeFromAddress('Evil\r\nBcc: victim@example.com', 'evil', 'mydomain.com'),
    ).toBe('"EvilBcc: victim@example.com" <evil@mydomain.com>');
    expect(composeFromAddress('\r\n\t', 'x', 'mydomain.com')).toBe('x@mydomain.com');
  });
});
