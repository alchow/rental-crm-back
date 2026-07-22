-- ----------------------------------------------------------------------------
-- Canonical E.164 tenant phones — backfill + write-time trigger backstop.
--
-- PRODUCT RULE
-- Every stored phone on the platform is E.164 (+[country][number]): the
-- landlord profile phone (users_phone_check), platform numbers (Telnyx's own
-- shape), message_outbox.to_phone, sms_opt_outs.phone. tenants.phones was the
-- one raw-storage exception: values landed exactly as typed, and the first
-- strict consumer (comms group-thread create, normalizeAddress) rejected them
-- at SEND time — the worst place to surface a data-entry problem. The API now
-- canonicalizes on write (routes/tenants.ts + the import executor); this
-- migration fixes the rows that already exist and backstops future writers
-- that bypass the API (the RLS tenants_member_all policy lets any member row
-- write, including the agent principal).
--
-- BACKFILL (one-shot, conservative)
-- Each element is normalized with the SAME rules as api/src/routes/_lib/phone.ts
-- normalizePhone: strip [space - ( ) .], 11-digit leading-1 gets '+', accept
-- only ^\+[1-9][0-9]{6,14}$. An element that cannot be resolved is KEPT AS-IS
-- (grandfathered) — a wrong guess at a country code would corrupt a number we
-- can still show a human, and the write-time trigger forces cleanup on the
-- row's next phones edit. Normalization can collapse two spellings of one
-- number; the rebuild dedupes while preserving first-seen order.
--
-- WRITE-TIME TRIGGER (mirrors 20260721000002's grandfathering posture)
-- BEFORE INSERT OR UPDATE OF phones: every element of NEW.phones must already
-- be E.164. The API normalizes before writing, so this trigger firing means a
-- non-API writer sent raw data — raise check_violation naming the value.
-- Grandfathered dirty rows never fire it until someone edits their phones.
-- NOTE deliberately NOT NANP-defaulting bare 10-digit strings anywhere here:
-- guessing a country code in SQL could mis-store a non-US number; only the
-- unambiguous 11-digit leading-1 NANP shape is upgraded (same as the API).
-- ----------------------------------------------------------------------------

-- Normalizer — IMMUTABLE, mirrors normalizePhone in api/src/routes/_lib/phone.ts.
-- Returns null when the value cannot be resolved to E.164.
create or replace function public._phone_to_e164(raw text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  s text;
begin
  s := regexp_replace(coalesce(raw, ''), '[\s\-().]', '', 'g');
  if s ~ '^1[2-9][0-9]{9}$' then
    s := '+' || s;
  end if;
  if s ~ '^\+[1-9][0-9]{6,14}$' then
    return s;
  end if;
  return null;
end;
$$;

revoke all on function public._phone_to_e164(text) from public, anon, authenticated;
grant execute on function public._phone_to_e164(text) to service_role;

-- One-shot backfill: rebuild each phones array element-wise (normalize what
-- resolves, keep what does not), deduped in first-seen order. Only rows whose
-- rebuilt array differs are touched, so re-running is a no-op.
with rebuilt as (
  select t.id,
         (
           select coalesce(array_agg(v order by ord), '{}'::text[])
           from (
             select distinct on (coalesce(public._phone_to_e164(p.elem), p.elem))
                    coalesce(public._phone_to_e164(p.elem), p.elem) as v,
                    p.ord
             from unnest(t.phones) with ordinality as p(elem, ord)
             order by coalesce(public._phone_to_e164(p.elem), p.elem), p.ord
           ) dedup
         ) as phones_new
  from public.tenants t
  where array_length(t.phones, 1) is not null
)
update public.tenants t
set phones = r.phones_new,
    updated_at = now()
from rebuilt r
where t.id = r.id
  and t.phones is distinct from r.phones_new;

-- Write-time backstop: every element of a WRITTEN phones array must be E.164.
create or replace function public._tenants_phone_e164_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bad text;
begin
  select p.elem into bad
  from unnest(new.phones) as p(elem)
  where p.elem !~ '^\+[1-9][0-9]{6,14}$'
  limit 1;
  if bad is not null then
    raise exception 'tenants.phones element ''%'' is not E.164 (+[country][number]); normalize before writing', bad
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public._tenants_phone_e164_guard() from public, anon, authenticated;

drop trigger if exists tenants_phone_e164_guard on public.tenants;
create trigger tenants_phone_e164_guard
  before insert or update of phones on public.tenants
  for each row
  when (new.phones is not null and array_length(new.phones, 1) is not null)
  execute function public._tenants_phone_e164_guard();

