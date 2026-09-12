-- Multiple partial applications and their reversals are distinct facts.
-- Amount caps remain serialized by payment_allocations_integrity; retries use request_key.
alter table public.payment_allocations
  drop constraint payment_allocations_payment_id_charge_id_key;
