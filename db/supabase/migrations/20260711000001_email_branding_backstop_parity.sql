-- ----------------------------------------------------------------------------
-- Email-branding backstop parity — close two gaps where the DB CHECK backstop
-- did not mirror the API validators (api/src/routes/_lib/subdomain.ts).
--
-- The branding migration (20260704000001) grants owner/managers a direct,
-- column-scoped UPDATE on accounts.email_subdomain / .sender_display_name, so a
-- real GoTrue JWT can PATCH those columns straight through PostgREST, bypassing
-- the API handler. That migration's own header calls the DB CHECKs the
-- "unbypassable backstop" and says to keep them identical to the API rules —
-- but two API-only rules were never mirrored in the DB:
--
--   1. Punycode/IDNA labels. The API rejects any `xn--…` label
--      (subdomain.ts: `value.startsWith('xn--')`) so a branded receiving
--      subdomain is always a plain ASCII label, not an encoded homoglyph. The
--      DB format CHECK (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`) happily matches
--      `xn--…` (every char is `[a-z0-9-]`), so a direct write could claim
--      `xn--80ak6aa92e.<parent>` — the homoglyph the API forbids.
--
--   2. C1 control characters (U+0080–U+009F) in sender_display_name. The API
--      CONTROL_RE is `[\x00-\x1f\x7f-\x9f]` (C0 + DEL + C1); the DB no-ctrl
--      CHECK was only `[\x01-\x1F\x7F]` (C0 + DEL), leaving the entire C1 range
--      — including U+0085 NEL, which some Unicode-aware mail parsers treat as a
--      line break — writable on the direct path. (U+0000 is unstorable in
--      Postgres text, so its omission from both regexes is intentional.)
--
-- This migration adds the missing DB rules so the backstop matches the API.
-- No data migration is needed, but branding is LIVE now (persona accounts
-- carry real subdomains/display names), so note the apply-time behavior:
-- ADD CONSTRAINT validates every existing row and the migration fails atomically
-- if any row violates. Existing values all came through the API validators
-- (which enforce these exact rules) or the signup default (the account name,
-- API-validated); a violation would itself be evidence of a direct-write
-- bypass worth investigating before re-running.
-- ----------------------------------------------------------------------------

-- (1) Reject punycode/IDNA labels on the direct-write path, mirroring the API's
-- `xn--` reject. `%` is a LIKE wildcard; the string has no other LIKE
-- metacharacters, so this is exactly "starts with xn--".
alter table public.accounts
  add constraint accounts_email_subdomain_no_punycode
  check (
    email_subdomain is null
    or email_subdomain not like 'xn--%'
  );

-- (2) Widen the display-name control-char CHECK to include the C1 range, so it
-- mirrors the API CONTROL_RE. Drop + re-add (a CHECK's predicate can't be
-- altered in place) with the same name so the constraint identity is stable.
alter table public.accounts
  drop constraint accounts_sender_display_name_no_ctrl,
  add constraint accounts_sender_display_name_no_ctrl
  check (
    sender_display_name is null
    or sender_display_name !~ E'[\\x01-\\x1F\\x7F-\\x9F]'
  );
