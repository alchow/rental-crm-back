import type { z } from 'zod';
import { normalizePhone } from '../../routes/_lib/phone';
import { AreaKind } from '../../schemas/importable';

/** Concise first-issue message from a Zod safeParse error (no z import). */
export function firstIssue(err: {
  issues?: { path: (string | number)[]; message: string }[];
}): string {
  const i = err.issues?.[0];
  return i ? `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}` : 'validation failed';
}

// ----- coercion helpers ------------------------------------------------------

export function coerceDate(v: string | null): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isoIfValid(s);
  // US-style M/D/Y or M-D-Y.
  const us = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);
  if (us) {
    const [, mm, dd, yy] = us as unknown as [string, string, string, string];
    let year = parseInt(yy, 10);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const iso = `${year.toString().padStart(4, '0')}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    return isoIfValid(iso);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

function isoIfValid(iso: string): string | null {
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip guards against impossible dates like 2026-02-31.
  return d.toISOString().slice(0, 10) === iso ? iso : null;
}

export function coerceInt(v: string | null): number | null {
  if (v == null) return null;
  const m = /-?\d+/.exec(v.replace(/,/g, ''));
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

export function coerceDecimal(v: string | null): number | null {
  if (v == null) return null;
  const cleaned = v.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a mapped area-kind cell to the AreaKind enum. Empty/unmapped
 * defaults to 'unit'; anything else must normalize ("Exterior Grounds" ->
 * exterior_grounds) to an enum value or the row is blocked.
 */
export function coerceAreaKind(v: string | null): z.infer<typeof AreaKind> | null {
  if (v == null || v.trim() === '') return 'unit';
  const normalized = v
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const parsed = AreaKind.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

/** Parse a currency-ish amount to non-negative integer minor units (cents). */
export function coerceMoney(v: string | null): number | null {
  if (v == null) return null;
  let s = v.trim();
  if (s === '') return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[^0-9.]/g, '');
  if (s === '') return null;
  const parts = s.split('.');
  const normalized =
    parts.length > 2 ? parts.slice(0, -1).join('') + '.' + parts[parts.length - 1] : s;
  const val = parseFloat(normalized);
  if (!Number.isFinite(val) || negative) return null;
  return Math.round(val * 100);
}

export function coerceCurrency(v: string | null): string | null {
  if (v == null) return null;
  const s = v.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  const sym: Record<string, string> = { $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' };
  return sym[v.trim()] ?? null;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Extract a leading date prefix from a note: "6/2: Gardeners coming" or
 * "6/9/26 - canopy" -> ISO date. When the prefix has no year, the CURRENT
 * year is inferred (decision: imported journals are near-past; the full
 * original text is always kept as the body, so nothing is lost if the
 * inference is off). Returns null when there is no parseable prefix.
 */
/**
 * Canonicalize an imported tenant's phones to E.164 (same rule as the tenants
 * route). Returns the normalized array, or the first unresolvable raw value —
 * the caller blocks the row with it. Deliberately no country-code guessing:
 * a spreadsheet cell has no typist looking at the result.
 */
export function coercePhonesE164(phones: string[]): { ok: string[] } | { bad: string } {
  const ok: string[] = [];
  for (const p of phones) {
    const norm = normalizePhone(p);
    if (!norm) return { bad: p };
    ok.push(norm);
  }
  return { ok };
}

export function extractLeadingDate(text: string): string | null {
  const m = /^\s*(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\s*[:\u2013\u2014-]/.exec(text);
  if (!m) return null;
  const mm = m[1]!.padStart(2, '0');
  const dd = m[2]!.padStart(2, '0');
  let year: number;
  if (m[3]) {
    year = parseInt(m[3], 10);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
  } else {
    year = new Date().getUTCFullYear();
  }
  return isoIfValid(`${year}-${mm}-${dd}`);
}
