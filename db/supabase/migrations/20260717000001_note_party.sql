-- ----------------------------------------------------------------------------
-- Accept a counterparty on kind='note' (campaign-4 §12).
--
-- A note explicitly ABOUT a person ("spoke to Gina about the boiler") is
-- deliberate frontend semantics: the note should surface on that person's page
-- (campaign-2 D5). The original journal design pinned every note to a
-- party-less shape (interactions_note_fields forced party_type='none',
-- party_id/party_label null), which turned the capture flow's Note+WHO state
-- into a guaranteed post-save 400.
--
-- Relax the note-fields check so a note keeps direction='none' but MAY carry a
-- party, under the same id-coherence rule communications already follow: a
-- party_id needs a resolved role, never 'unspecified'.
--
-- No data migration: every existing note is party_type='none', party_id null,
-- party_label null -- all still valid under the relaxed check.
--
-- 'unspecified' stays unreachable on a note via interactions_unspecified_comm_only
-- (party_type='unspecified' => kind='communication'); the 'party_type <> unspecified'
-- arm below mirrors the communications rule for defense in depth.
-- ----------------------------------------------------------------------------

alter table public.interactions drop constraint interactions_note_fields;
alter table public.interactions add constraint interactions_note_fields
  check (
    channel <> 'note'
    or (direction = 'none' and (party_type <> 'unspecified' or party_id is null))
  );
