-- A verifier key can attest only an SMS proof; it never creates an agent grant.
create table public.phone_verifier_keys (
  key_id text primary key check (key_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  verifier_id uuid not null,
  secret_hash text not null check (secret_hash ~ '^[a-f0-9]{64}$'),
  capability text not null default 'owner_phone_verification:record'
    check (capability = 'owner_phone_verification:record'),
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);
alter table public.phone_verifier_keys enable row level security;
alter table public.phone_verifier_keys force row level security;
revoke all on public.phone_verifier_keys from anon, authenticated;

create table public.owner_phone_verification_receipts (
  verifier_id uuid not null,
  user_id uuid not null,
  verification_id uuid not null,
  account_id uuid not null,
  phone text not null,
  expires_at timestamptz not null,
  phone_verified_at timestamptz not null,
  correlation_id text not null,
  primary key (verifier_id, user_id, verification_id),
  foreign key (account_id, user_id) references public.account_members(account_id, user_id)
);
alter table public.owner_phone_verification_receipts enable row level security;
alter table public.owner_phone_verification_receipts force row level security;
revoke all on public.owner_phone_verification_receipts from anon, authenticated;
grant select on public.owner_phone_verification_receipts to authenticated;
create policy owner_phone_receipts_self_select on public.owner_phone_verification_receipts
  for select to authenticated using (user_id = (select auth.uid()) and public.is_account_member(account_id));
-- Receipts are retained indefinitely. Any future purge must retain at least 30 days.

create function public.confirm_owner_phone_verification(
  p_key_id text, p_secret_hash text, p_user_id uuid, p_account_id uuid,
  p_verification_id uuid, p_phone text, p_expires_at timestamptz, p_correlation_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_verifier uuid;
  v_receipt public.owner_phone_verification_receipts%rowtype;
  v_verified_at timestamptz;
begin
  -- The API supplies the user id only after validating the human JWT. This RPC
  -- is executable only by the service role, never by a user or agent JWT.
  select verifier_id into v_verifier from public.phone_verifier_keys
    where key_id = p_key_id and secret_hash = p_secret_hash and disabled_at is null
      and capability = 'owner_phone_verification:record' for share;
  if not found then raise exception 'invalid verifier' using errcode = '42501'; end if;
  perform 1 from public.account_members m join public.accounts a on a.id = m.account_id
    where m.account_id = p_account_id and m.user_id = p_user_id
      and m.role in ('owner', 'manager') and m.deleted_at is null and a.deleted_at is null
    for share of m, a;
  if not found then raise exception 'not authorized' using errcode = '42501'; end if;
  -- Serializes both duplicate receipts and different challenges for this user.
  perform 1 from public.users where id = p_user_id and deleted_at is null for update;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
  select * into v_receipt from public.owner_phone_verification_receipts
    where verifier_id = v_verifier and user_id = p_user_id and verification_id = p_verification_id;
  if found then
    if v_receipt.account_id is distinct from p_account_id or v_receipt.phone is distinct from p_phone
        or v_receipt.expires_at is distinct from p_expires_at then
      raise exception 'verification conflict' using errcode = '23505';
    end if;
    -- Replay authenticates again but never overwrites a newer profile number.
    return jsonb_build_object('user_id', p_user_id, 'phone', v_receipt.phone,
      'phone_verified_at', v_receipt.phone_verified_at, 'replayed', true);
  end if;
  if p_expires_at is null or p_expires_at <= clock_timestamp()
      or p_expires_at > clock_timestamp() + interval '10 minutes 30 seconds'
      or p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid verification proof' using errcode = '22023';
  end if;
  v_verified_at := clock_timestamp();
  update public.users set phone = p_phone, phone_verified_at = v_verified_at,
    updated_at = v_verified_at where id = p_user_id;
  insert into public.owner_phone_verification_receipts
    values (v_verifier, p_user_id, p_verification_id, p_account_id, p_phone,
      p_expires_at, v_verified_at, p_correlation_id);
  return jsonb_build_object('user_id', p_user_id, 'phone', p_phone,
    'phone_verified_at', v_verified_at, 'replayed', false);
end;
$$;
revoke all on function public.confirm_owner_phone_verification(text,text,uuid,uuid,uuid,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.confirm_owner_phone_verification(text,text,uuid,uuid,uuid,text,timestamptz,text) to service_role;

-- RLS self-update alone does not protect individual columns. Raw user clients
-- must not set verification or carry it onto a different phone.
create function public.guard_user_phone_verification() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.phone_verified_at is not null and
      (tg_op = 'INSERT' or new.phone_verified_at is distinct from old.phone_verified_at) then
      raise exception 'verification requires SMS proof' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.phone is distinct from old.phone then
      new.phone_verified_at := null;
    end if;
  end if;
  return new;
end;
$$;
create trigger guard_user_phone_verification before insert or update on public.users
  for each row execute function public.guard_user_phone_verification();
