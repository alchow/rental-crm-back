begin;

-- Which setup wizard the frontend shows. Set by an operator in SQL like the other
-- rollout flags; the API accepts old and new setup payloads either way.
alter table public.accounts add column wizard_v2_enabled boolean not null default false;

notify pgrst, 'reload schema';
commit;
