-- ----------------------------------------------------------------------------
-- Phase 6: money correctness + generic idempotency.
--
-- Two additions, both enforcement-at-the-DB:
--
-- (A) idempotency_keys table
--     Single key per (account_id, key). The middleware INSERTs a placeholder
--     row to "claim" the key, runs the handler, then UPDATEs the row with
--     the response. Concurrent requests with the same key get a unique-
--     constraint conflict and resolve to either the cached response (same
--     fingerprint, completed) or a 409 (different fingerprint, or still in
--     flight). The brief's "same key never double-creates" depends on the
--     PK race here being the lock.
--
-- (B) _assert_allocation_integrity trigger on payment_allocations
--     Allocation correctness MUST live at the DB, not the handler. The
--     attack vectors the user listed:
--       - cross-tenancy allocation: payment in tenancy X allocated to a
--         charge in tenancy Y. Trigger compares payment.tenancy_id to
--         charge.tenancy_id and rejects on mismatch.
--       - cross-account allocation: same shape one level up.
--       - over-allocation per payment: SUM(allocations against payment)
--         must not exceed payment.amount_cents.
--       - over-allocation per charge: SUM(allocations against charge)
--         must not exceed charge.amount_cents.
--       - currency mismatch: payment.currency must equal charge.currency.
--     Concurrency: per-payment and per-charge advisory xact locks so two
--     concurrent allocations against the same payment / same charge
--     serialize and can't both pass the sum check. This is the money
--     analog of the audit-chain concurrency test.
--
-- A reversal-not-mutation note for the routes: this migration does NOT add
-- any "void" logic. Voids set payments.voided_at and charges.voided_at via
-- normal UPDATEs (the existing audit trigger captures it; the data layer
-- doesn't care). The DERIVED ledger computation excludes voided rows.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) idempotency_keys
-- ============================================================================

create table public.idempotency_keys (
  account_id          uuid not null references public.accounts(id) on delete cascade,
  -- Client-chosen key. UUIDs are recommended; we accept any 8-200 char string.
  key                 text not null check (length(key) between 8 and 200),
  -- sha256 of method + path + body. A retry with the same key + same body
  -- replays the cached response; a retry with same key + DIFFERENT body
  -- conflicts (409) so a key collision can't cause silent data corruption.
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  -- Cached response. null until the handler completes (placeholder).
  status_code         int,
  body                jsonb,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  -- Cleanup horizon. Phase 9's scheduled jobs will prune expired rows.
  expires_at          timestamptz not null default (now() + interval '24 hours'),
  primary key (account_id, key)
);
create index idempotency_keys_expires_at_idx on public.idempotency_keys (expires_at);

-- RLS: per-account. Members can SELECT, INSERT, UPDATE their own keys.
-- DELETE is reserved for the cron cleanup path (service-role, admin/).
alter table public.idempotency_keys enable row level security;
alter table public.idempotency_keys force  row level security;

create policy idempotency_keys_member_select on public.idempotency_keys
  for select using (public.is_account_member(account_id));
create policy idempotency_keys_member_insert on public.idempotency_keys
  for insert with check (public.is_account_member(account_id));
create policy idempotency_keys_member_update on public.idempotency_keys
  for update using (public.is_account_member(account_id))
              with check (public.is_account_member(account_id));

-- Idempotency_keys is caching infrastructure, not evidentiary. Excluded
-- from the audit trigger sweep (it's not in the audited-tables list in
-- the Phase 3 migration and we don't add it here).

-- ============================================================================
-- (B) _assert_allocation_integrity
-- ============================================================================

create or replace function public._assert_allocation_integrity()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_payment      record;
  v_charge       record;
  v_alloc_sum    bigint;
begin
  if NEW.amount_cents is null or NEW.amount_cents <= 0 then
    raise exception 'allocation amount_cents must be positive (got %)', NEW.amount_cents
      using errcode = 'check_violation';
  end if;

  -- Fetch the referenced payment and charge under the DEFINER's privileges
  -- (we're SECURITY DEFINER) so the trigger sees the real rows regardless
  -- of the caller's RLS context. We re-verify scoping below.
  select id, account_id, tenancy_id, amount_cents, currency, voided_at
    into v_payment
    from public.payments where id = NEW.payment_id;
  if v_payment.id is null then
    raise exception 'payment % not found', NEW.payment_id
      using errcode = 'foreign_key_violation';
  end if;

  select id, account_id, tenancy_id, amount_cents, currency, voided_at
    into v_charge
    from public.charges where id = NEW.charge_id;
  if v_charge.id is null then
    raise exception 'charge % not found', NEW.charge_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Same account_id throughout. The composite FK already enforces this for
  -- the (account_id, payment_id) and (account_id, charge_id) links, but we
  -- compare the bare account_id of payment and charge as belt-and-braces.
  if v_payment.account_id <> NEW.account_id then
    raise exception 'allocation/payment account mismatch (alloc=%, payment=%)',
      NEW.account_id, v_payment.account_id
      using errcode = 'check_violation';
  end if;
  if v_charge.account_id <> NEW.account_id then
    raise exception 'allocation/charge account mismatch (alloc=%, charge=%)',
      NEW.account_id, v_charge.account_id
      using errcode = 'check_violation';
  end if;

  -- Same tenancy_id between payment and charge. The attack the brief flags:
  -- allocate A's payment to a different tenancy's (or another account's)
  -- charge. Rejected at the DB, not in the handler.
  if v_payment.tenancy_id <> v_charge.tenancy_id then
    raise exception 'cross-tenancy allocation: payment.tenancy=% charge.tenancy=%',
      v_payment.tenancy_id, v_charge.tenancy_id
      using errcode = 'check_violation';
  end if;

  -- Same currency.
  if v_payment.currency <> v_charge.currency then
    raise exception 'currency mismatch in allocation: payment=% charge=%',
      v_payment.currency, v_charge.currency
      using errcode = 'check_violation';
  end if;

  -- Voided sources can't accept new allocations.
  if v_payment.voided_at is not null then
    raise exception 'cannot allocate from a voided payment'
      using errcode = 'check_violation';
  end if;
  if v_charge.voided_at is not null then
    raise exception 'cannot allocate to a voided charge'
      using errcode = 'check_violation';
  end if;

  -- Per-payment + per-charge advisory locks so two concurrent allocations
  -- against the same payment / same charge serialize. Without this, two
  -- parallel writers could each see the OLD sum and both pass the cap
  -- check.
  perform pg_advisory_xact_lock(
    hashtextextended('payment_alloc:' || NEW.payment_id::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('charge_alloc:'  || NEW.charge_id::text,  0)
  );

  -- Sum of allocations against this payment after this row.
  select coalesce(sum(amount_cents), 0) into v_alloc_sum
    from public.payment_allocations
    where payment_id = NEW.payment_id
      and (TG_OP = 'INSERT' or id <> NEW.id)
      and deleted_at is null;
  v_alloc_sum := v_alloc_sum + NEW.amount_cents;
  if v_alloc_sum > v_payment.amount_cents then
    raise exception 'allocations (%) exceed payment amount (%) for payment %',
      v_alloc_sum, v_payment.amount_cents, NEW.payment_id
      using errcode = 'check_violation';
  end if;

  -- Sum of allocations against this charge after this row.
  select coalesce(sum(amount_cents), 0) into v_alloc_sum
    from public.payment_allocations
    where charge_id = NEW.charge_id
      and (TG_OP = 'INSERT' or id <> NEW.id)
      and deleted_at is null;
  v_alloc_sum := v_alloc_sum + NEW.amount_cents;
  if v_alloc_sum > v_charge.amount_cents then
    raise exception 'allocations (%) exceed charge amount (%) for charge %',
      v_alloc_sum, v_charge.amount_cents, NEW.charge_id
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

create trigger payment_allocations_integrity
  before insert or update on public.payment_allocations
  for each row execute function public._assert_allocation_integrity();
