-- ----------------------------------------------------------------------------
-- Onboarding import: imported notes/log entries land in `interactions` as
-- channel='import', direction='none'.
--
-- A journal note ("6/9: Gardeners coming.") is not a communication: it has no
-- channel and no direction. Rather than forcing it into a comms channel and
-- fabricating a direction, the import gets its own channel value, and 'none'
-- becomes a valid direction FOR THAT CHANNEL ONLY -- the inbound/outbound
-- semantics of every existing channel are untouched, enforced by the
-- cross-column check below.
-- ----------------------------------------------------------------------------

alter table public.interactions drop constraint interactions_channel_check;
alter table public.interactions add constraint interactions_channel_check
  check (channel in (
    'in_person', 'phone', 'voicemail',
    'sms', 'email', 'letter', 'in_app',
    'import'
  ));

alter table public.interactions drop constraint interactions_direction_check;
alter table public.interactions add constraint interactions_direction_check
  check (direction in ('inbound', 'outbound', 'none'));

alter table public.interactions add constraint interactions_direction_none_import_only
  check (direction <> 'none' or channel = 'import');
