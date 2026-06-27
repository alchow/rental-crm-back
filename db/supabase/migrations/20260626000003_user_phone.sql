-- ----------------------------------------------------------------------------
-- Landlord phone collection (Workstream 1: foundation).
--
-- The landlord is the authenticated user (public.users, a mirror of
-- auth.users). Until now the profile carried only display_name. This adds an
-- optional phone number so the landlord has a contact-of-record on file.
--
-- Stored in E.164. The CHECK mirrors message_outbox.to_phone
-- (20260616000003_messaging.sql) and sms_opt_outs.phone, so any number that
-- lands here is already in the canonical form the messaging layer expects --
-- the API normalises via normalizePhone() before the write.
--
-- No RLS change: the self-only select/update policies on public.users
-- (20260604000001_phase2_schema.sql) already gate every column, new ones
-- included. No audit-trigger change: public.users is excluded from the audit
-- hash-chain by design (20260604000002_phase3_audit.sql), and the trigger
-- serialises whole rows via to_jsonb() regardless of column set.
-- ----------------------------------------------------------------------------

alter table public.users
  add column phone text
  check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$');
