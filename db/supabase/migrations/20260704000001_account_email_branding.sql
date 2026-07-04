-- ----------------------------------------------------------------------------
-- Per-account email branding — branded reply subdomains + sender display name.
--
-- Today every email thread mints its tokenized reply address
-- (`t-<token>@<domain>`) under ONE global receiving domain (env
-- EMAIL_REPLY_DOMAIN). This adds two OPTIONAL, account-level branding fields so
-- a landlord can present their own identity on relayed mail:
--
--   accounts.email_subdomain      a single lowercase DNS label (RFC-1035). When
--                                 set AND the platform parent domain env
--                                 (EMAIL_PLATFORM_PARENT_DOMAIN, e.g.
--                                 mail.example.com) is configured, NEW email
--                                 threads mint under `<subdomain>.<parent>`
--                                 (e.g. t-…@acme.mail.example.com) instead of
--                                 the shared EMAIL_REPLY_DOMAIN. Minting is at
--                                 the API layer; resolution stays a full-address
--                                 equality lookup, so already-minted tokens are
--                                 unaffected by a later branding change.
--   accounts.sender_display_name  the From display name the transport renders
--                                 on relayed mail ("Acme Properties <…>").
--
-- Reserved-word enforcement (www, mail, api, …) lives in TWO layers: the API
-- (routes/_lib/subdomain.ts) validates first and returns friendly 422 field
-- errors, and a CHECK below carries the SAME list as the unbypassable backstop
-- — the UPDATE grant added at the bottom of this migration means an
-- owner/manager can write these two columns directly against PostgREST, so a
-- policy that only the API enforced would be a bypassable control. Keep the two
-- lists identical; evolving the list means a migration AND an API change (the
-- API is checked first, so an API-only addition degrades gracefully to a 409/
-- 500-mapped CHECK failure rather than a silent bypass).
-- ----------------------------------------------------------------------------

alter table public.accounts
  add column email_subdomain     text,
  add column sender_display_name text;

-- email_subdomain: a single lowercase RFC-1035 DNS label (1..63 chars, starts
-- and ends alphanumeric, hyphens allowed inside). Nullable, so the CHECK is
-- guarded on null.
alter table public.accounts
  add constraint accounts_email_subdomain_format
  check (
    email_subdomain is null
    or email_subdomain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  add constraint accounts_sender_display_name_len
  check (
    sender_display_name is null
    or length(sender_display_name) between 1 and 120
  );

-- Reserved labels an account may never claim (mirror of RESERVED_SUBDOMAINS in
-- api/src/routes/_lib/subdomain.ts — keep in sync). Enforced here so a direct
-- PostgREST write under the column grant below cannot claim an operational or
-- mail-infrastructure name (postmaster.<parent>, mx.<parent>, …).
alter table public.accounts
  add constraint accounts_email_subdomain_reserved
  check (
    email_subdomain is null
    or email_subdomain <> all (array[
      'www', 'mail', 'api', 'app', 'admin', 'root',
      'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2', 'ftp',
      'webmail', 'email', 'reply', 'noreply', 'no-reply',
      'bounce', 'bounces', 'unsubscribe',
      'abuse', 'postmaster', 'support', 'help', 'info',
      'billing', 'security', 'status',
      'dev', 'staging', 'test', 'internal'
    ])
  ),
  -- C0 controls + DEL have no place in a From display name and are a
  -- header-injection vector; the API also rejects them (plus C1), this is the
  -- unbypassable backstop for direct column-granted writes.
  add constraint accounts_sender_display_name_no_ctrl
  check (
    sender_display_name is null
    or sender_display_name !~ E'[\\x01-\\x1F\\x7F]'
  );

-- Global uniqueness: a branded subdomain resolves to exactly one account, so a
-- reply address minted under it is unambiguous. Partial (nullable column) — the
-- unset case is the common one and never collides.
create unique index accounts_email_subdomain_uk
  on public.accounts (email_subdomain)
  where email_subdomain is not null;

-- accounts carries ONLY a member SELECT policy (20260604000001_phase2_schema.sql)
-- plus FORCE RLS, so a user-JWT write is denied by default. Branding is a
-- landlord-managed setting: permit an UPDATE, but only to owner/manager members
-- (viewers read; the agent transport is deliberately excluded — it never edits
-- account identity). No role-aware helper exists (is_account_member is
-- role-agnostic), so the policy carries an explicit exists-subquery over
-- account_members, in both USING and WITH CHECK, mirroring
-- account_legal_holds_manager_write (20260703000004_comms_evidence_provenance.sql).
create policy accounts_manager_update on public.accounts
  for update
  using (exists (
    select 1
    from public.account_members m
    where m.account_id = accounts.id
      and m.user_id    = (select auth.uid())
      and m.role in ('owner', 'manager')
      and m.deleted_at is null
  ))
  with check (exists (
    select 1
    from public.account_members m
    where m.account_id = accounts.id
      and m.user_id    = (select auth.uid())
      and m.role in ('owner', 'manager')
      and m.deleted_at is null
  ));

-- RLS is ROW-level: the policy above alone would let an owner/manager UPDATE
-- ANY column of their accounts row straight through PostgREST (Supabase's
-- default privileges grant authenticated table-wide UPDATE), including `name`
-- and `deleted_at`, bypassing the API entirely. Narrow the surface with
-- COLUMN privileges: only the two branding columns (+ updated_at, which the
-- API PATCH sets — accounts has no updated_at trigger) are writable by a user
-- JWT. service_role is unaffected (its grants are separate; admin paths keep
-- full access). What a direct write CAN still do is exactly what the API
-- would allow — format, reserved list, and uniqueness all enforced above.
revoke update on public.accounts from anon, authenticated;
grant update (email_subdomain, sender_display_name, updated_at)
  on public.accounts to authenticated;
