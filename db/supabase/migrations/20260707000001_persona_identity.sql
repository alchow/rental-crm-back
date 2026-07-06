-- ----------------------------------------------------------------------------
-- Persona email identity — one stable, human-friendly address per account.
--
-- accounts.persona_local_part is the local part of the account's persona
-- address (`<local>@<email_subdomain>.<EMAIL_PLATFORM_PARENT_DOMAIN>`, e.g.
-- riley@acme.mail.example.com). Null = the persona feature is off for the
-- account. The address only RESOLVES when the account also carries a branded
-- email_subdomain and the platform parent domain env is configured — a local
-- part on the SHARED reply domain would be ambiguous across accounts, so the
-- persona is branded-subdomain-only by design.
--
-- Namespace safety: the tokenized reply addresses that route thread legs are
-- minted as `t-<32hex>@<domain>` (comms email threads, 20260703000002). A
-- persona local part must never be confusable with that namespace, so the
-- CHECK below forbids the `t-` prefix outright (broader than the exact token
-- shape on purpose — cheap, and keeps the two namespaces disjoint forever).
--
-- Reserved-word enforcement mirrors the email_subdomain pattern
-- (20260704000001): the API (routes/_lib/subdomain.ts) validates first with
-- friendly 422s, and the CHECK here is the unbypassable backstop for direct
-- PostgREST writes under the column grant added below. Keep the two lists
-- identical; evolving the list means a migration AND an API change. The list
-- covers RFC-mandated mailboxes (postmaster, abuse), mail infrastructure, and
-- support/ops local parts a landlord must not claim on a receiving domain.
--
-- Also here: sender_display_name defaulting. Every account created before
-- this migration has a NULL display name (the column landed 20260704000001
-- with no default and signup never set it), which the transport renders as a
-- bare hex token From — the "phishing-looking From" problem. New accounts now
-- default it to the account name at signup; existing accounts are backfilled
-- the same way (control characters stripped to satisfy the header-injection
-- CHECK; landlords can PATCH it to taste afterwards).
-- ----------------------------------------------------------------------------

alter table public.accounts
  add column persona_local_part text;

-- Format: a conservative lowercase email local part — 1..64 chars, starts and
-- ends alphanumeric, dots/hyphens/underscores allowed inside. Nullable, so
-- every CHECK is guarded on null.
alter table public.accounts
  add constraint accounts_persona_local_part_format
  check (
    persona_local_part is null
    or persona_local_part ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
  ),
  -- Token-namespace disjointness: reply tokens are `t-<32hex>@…`; no persona
  -- may ever start with `t-`.
  add constraint accounts_persona_local_part_not_token
  check (
    persona_local_part is null
    or persona_local_part not like 't-%'
  ),
  -- Reserved local parts (mirror of RESERVED_LOCAL_PARTS in
  -- api/src/routes/_lib/subdomain.ts — keep in sync).
  add constraint accounts_persona_local_part_reserved
  check (
    persona_local_part is null
    or persona_local_part <> all (array[
      'postmaster', 'abuse', 'mailer-daemon', 'hostmaster', 'webmaster',
      'admin', 'administrator', 'root',
      'noreply', 'no-reply', 'reply',
      'bounce', 'bounces', 'unsubscribe',
      'mail', 'email', 'smtp', 'imap', 'pop',
      'support', 'help', 'info', 'billing', 'security',
      'spam', 'dmarc', 'spf'
    ])
  );

-- The branding column grant (20260704000001) is column-scoped; extend it so
-- an owner/manager can write the persona local part through the same fenced
-- path (RLS accounts_manager_update + the CHECKs above backstop it).
grant update (persona_local_part) on public.accounts to authenticated;

-- ----------------------------------------------------------------------------
-- sender_display_name defaulting.
-- ----------------------------------------------------------------------------

-- Backfill existing accounts: display name = account name, stripped of the
-- C0/DEL control characters the header-injection CHECK forbids, capped at 120.
-- nullif guards the degenerate all-control-chars name (stays null rather than
-- violating the 1..120 length CHECK).
update public.accounts
   set sender_display_name = nullif(
         left(regexp_replace(trim(name), E'[\\x01-\\x1F\\x7F]', '', 'g'), 120),
         ''
       )
 where sender_display_name is null;

-- Signup now stamps the same default at account creation. Full redefinition
-- of create_account_for_new_user (20260605000003) — only the accounts INSERT
-- changes; everything else is verbatim.
create or replace function public.create_account_for_new_user(
  p_account_name text,
  p_display_name text default null
)
returns table (
  account_id uuid,
  role       text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_account_id uuid;
begin
  if v_user_id is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if p_account_name is null or length(trim(p_account_name)) = 0 then
    raise exception 'account_name is required' using errcode = '22023';
  end if;

  -- One-shot: refuse if the caller already has any membership. A future
  -- "create another account" endpoint will live elsewhere with different
  -- semantics (e.g., does the caller have permission to create accounts).
  if exists (select 1 from public.account_members where user_id = v_user_id) then
    raise exception 'user already has account memberships'
      using errcode = 'unique_violation';
  end if;

  -- (1) profile mirror. Idempotent so a retried call after a partial failure
  -- elsewhere doesn't trip a duplicate-key error.
  insert into public.users (id, display_name)
       values (v_user_id, p_display_name)
  on conflict (id) do nothing;

  -- (2) new account. sender_display_name defaults to the account name
  -- (control chars stripped for the header-injection CHECK; landlords PATCH
  -- it to taste via /email-branding).
  insert into public.accounts (name, sender_display_name)
       values (
         trim(p_account_name),
         nullif(
           left(regexp_replace(trim(p_account_name), E'[\\x01-\\x1F\\x7F]', '', 'g'), 120),
           ''
         )
       )
    returning id into v_account_id;

  -- (3) owner membership. The audit trigger on account_members fires here
  -- and records actor = 'user:<v_user_id>' (the Phase-4 actor-integrity fix
  -- means audit.actor cannot override auth.uid()).
  insert into public.account_members (account_id, user_id, role)
       values (v_account_id, v_user_id, 'owner');

  account_id := v_account_id;
  role       := 'owner';
  return next;
end;
$$;

-- Same grant posture as the original definition (re-issued for clarity; a
-- CREATE OR REPLACE keeps existing grants, but redefinitions in this repo
-- state their grants explicitly).
grant execute on function public.create_account_for_new_user(text, text) to authenticated;
