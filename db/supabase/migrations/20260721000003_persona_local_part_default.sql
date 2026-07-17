-- Default accounts.persona_local_part to 'manager' whenever the account holds a
-- branded email_subdomain (product decision 2026-07-17, owner): branded From
-- must engage as soon as a subdomain exists, without waiting for an explicit
-- persona choice. Before this, an account with a subdomain + display name but
-- no persona (settable nowhere in the frontend) silently kept sending from the
-- platform noreply@, whose replies are dropped.
--
-- Enforced as a BEFORE-write trigger (not API-layer code) so the invariant
-- holds for the PATCH /email-branding route and direct column-granted
-- PostgREST writes alike — same backstop posture as
-- accounts_email_subdomain_reserved_guard (20260721000001). Consequence: an
-- explicit persona_local_part=null write while a subdomain is set re-defaults
-- to 'manager' — "subdomain set, persona unset" is no longer a reachable
-- steady state. Clearing the subdomain leaves the persona value in place
-- (harmless: persona_address computes null without a subdomain).
--
-- 'manager' passes the format/token/reserved CHECKs from 20260707000001. Keep
-- it off RESERVED_LOCAL_PARTS (routes/_lib/subdomain.ts) and the mirrored
-- accounts_persona_local_part_reserved CHECK forever, or this trigger would
-- start writing rows those reject.

create or replace function public._default_persona_local_part()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.email_subdomain is not null and new.persona_local_part is null then
    new.persona_local_part := 'manager';
  end if;
  return new;
end;
$$;

comment on function public._default_persona_local_part() is
  'BEFORE-write default: a branded account (email_subdomain set) always carries a persona_local_part (''manager'' unless the writer chose one).';

-- `of <cols>` narrows only UPDATE firing; INSERT always fires. Among BEFORE
-- triggers Postgres fires alphabetically, so the reserved-subdomain guard
-- (accounts_email_subdomain_reserved_guard) runs first — order is immaterial
-- here (the two touch disjoint columns).
drop trigger if exists accounts_persona_local_part_default on public.accounts;
create trigger accounts_persona_local_part_default
  before insert or update of email_subdomain, persona_local_part on public.accounts
  for each row
  execute function public._default_persona_local_part();

-- One-time backfill: brand-ready accounts that never picked a persona start
-- sending branded From immediately after this deploy.
update public.accounts
  set persona_local_part = 'manager',
      updated_at = now()
  where email_subdomain is not null
    and persona_local_part is null;
