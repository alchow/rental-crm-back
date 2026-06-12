// Phone normalisation helper (agent-api plan Phase 5).
//
// Extracted from api/src/routes/messages.ts so both the send path AND the
// inbound webhook matching path share the identical normalisation rules.
// Pure function: no I/O, safe to import anywhere.
//
// Rules (Req 4 spec; deliberate — wrong country-code guesses send to strangers):
//   1. Strip spaces, dashes, parens, dots.
//   2. Keep a leading '+'.
//   3. Exactly 11 digits starting with '1' → prepend '+' (NANP convention).
//   4. Match ^\+[1-9][0-9]{6,14}$ → return as-is.
//   5. Anything else → return null (caller raises 422 no_sms_destination or
//      treats the number as un-matchable for inbound routing).

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
