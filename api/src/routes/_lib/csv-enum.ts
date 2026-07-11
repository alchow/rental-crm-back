import { ApiError } from './error';

/**
 * Parse a comma-separated enum query param (the multi-value form of a
 * single-valued filter). Returns null when `raw` is undefined so the caller
 * can skip the filter entirely; returns the de-duplicated, trimmed list
 * otherwise. Any unknown member — or an all-empty value like `""` / `","` —
 * is a 400 with the same `fieldErrors` shape search.ts (`parseKinds`) emits,
 * so a mistyped status reads as a clean client error, not a silent no-match.
 */
export function parseCsvEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  field: string,
): T[] | null {
  if (raw === undefined) return null;
  const values = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
  const bad = values.filter((v) => !(allowed as readonly string[]).includes(v));
  if (bad.length > 0 || values.length === 0) {
    throw new ApiError(
      400,
      'invalid_request',
      `unknown ${field} value(s): ${bad.join(', ') || '(empty)'}`,
      { fieldErrors: { [field]: bad.length > 0 ? bad : ['empty'] } },
    );
  }
  return values as T[];
}
