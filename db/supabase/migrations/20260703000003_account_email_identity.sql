-- ----------------------------------------------------------------------------
-- Per-account outbound email identity (user-chosen local part).
--
-- Each account may pick a slug; outbound transactional email for that account
-- is then sent as `<slug>@<ACCOUNT_EMAIL_DOMAIN>` (env, api/src/env.ts) with
-- the account name as the display name. ONE provider domain is verified once
-- (Resend + DNS, ops); a slug needs NO per-account provider or DNS work
-- because any local part on a verified domain is sendable. This is
-- deliberately NOT per-account subdomains (`@<slug>.domain`): those would
-- require per-subdomain DKIM/SPF verification at the provider for every
-- account, which the local-part design exists to avoid.
--
-- Shape: a DNS-label-safe slug (the format is stricter than RFC 5321 local
-- parts on purpose -- keeping slugs label-safe preserves the option of
-- migrating to real subdomains later without a rename). Lowercase alnum with
-- interior hyphens, 1..63 chars. Uniqueness is global across accounts (the
-- slug IS the visible identity on a shared domain). Reserved names (postmaster,
-- noreply, ...) are an API-layer policy list, not a DB CHECK, so the list can
-- evolve without a migration.
--
-- Write path: accounts has no UPDATE policy (select-only RLS), and adding one
-- would open every column to every member. The slug is instead set through a
-- SECURITY DEFINER RPC that asserts the caller is an OWNER member of the
-- account. accounts is audited (phase 3): the update rides the existing
-- hash-chain trigger with the caller's auth.uid() as actor.
-- ----------------------------------------------------------------------------

alter table public.accounts
  add column email_slug text
  check (email_slug is null or email_slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');

-- Global uniqueness among set slugs. Partial so unset accounts don't collide.
create unique index accounts_email_slug_uk
  on public.accounts (email_slug)
  where email_slug is not null;

-- ----------------------------------------------------------------------------
-- set_account_email_slug -- owner-only setter (null clears).
--
-- DEFINER because accounts has no UPDATE policy for members (see header).
-- Self-defending: raises 42501 unless the caller holds a live OWNER
-- membership in p_account_id -- managers, viewers, and the agent role are all
-- refused (an account's sending identity is an owner decision). Listed in the
-- db/test/check_definer_grants.sql allowlist on that basis.
--
-- Validation: format is normalised (trim + lower) then re-checked against the
-- column CHECK's pattern here so a bad slug raises 23514 with a clear message
-- instead of a bare CHECK failure; a duplicate raises the unique index's
-- 23505. The API maps 42501 -> 403, 23505 -> 409, 23514 -> 422.
-- ----------------------------------------------------------------------------
create or replace function public.set_account_email_slug(
  p_account_id uuid,
  p_slug       text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
begin
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = p_account_id
       and m.role = 'owner'
       and m.deleted_at is null
  ) then
    raise exception 'only an account owner may set the email slug'
      using errcode = '42501';
  end if;

  v_slug := nullif(lower(trim(p_slug)), '');

  if v_slug is not null
     and v_slug !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' then
    raise exception
      'email slug must be 1-63 lowercase letters, digits, or interior hyphens'
      using errcode = '23514';
  end if;

  update public.accounts
     set email_slug = v_slug
   where id = p_account_id;

  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  return v_slug;
end;
$$;

revoke execute on function public.set_account_email_slug(uuid, text) from public;
revoke execute on function public.set_account_email_slug(uuid, text) from anon;
grant  execute on function public.set_account_email_slug(uuid, text) to authenticated, service_role;
