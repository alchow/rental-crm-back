// E.164 phone normalisation helper. Pure function: no I/O, safe to import
// anywhere. Used by the profile route to canonicalise a landlord-supplied
// number before it is stored (and checked against the DB CHECK constraint).
//
// Rules (deliberate — wrong country-code guesses would mis-store a number):
//   1. Strip spaces, dashes, parens, dots.
//   2. Keep a leading '+'.
//   3. Exactly 11 digits starting with '1' → prepend '+' (NANP convention).
//   4. Match ^\+[1-9][0-9]{6,14}$ → return as-is.
//   5. Anything else → return null (the caller decides how to reject it).

export function normalizePhone(raw: string): string | null {
  // Strip formatting characters that commonly appear in stored phone numbers.
  let s = raw.replace(/[\s\-().]/g, '');
  // 11 digits starting with '1' → NANP number without the '+'.
  if (/^1[2-9]\d{9}$/.test(s)) {
    s = '+' + s;
  }
  // Accept if it matches E.164.
  if (/^\+[1-9][0-9]{6,14}$/.test(s)) {
    return s;
  }
  return null;
}
