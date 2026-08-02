-- ----------------------------------------------------------------------------
-- Journal write hardening: deny member UPDATE/DELETE on interactions, and give
-- two API-only note/party invariants a DB shadow.
--
-- The append-only guarantee was route-surface only: interactions_member_all is
-- FOR ALL and the table carried GRANT ALL, so a member JWT could UPDATE/DELETE
-- journal rows directly through PostgREST -- tamper-EVIDENT (the
-- interactions_audit hash chain still records it) but not DENIED.
-- interaction_participants already meets the "evidence must be denied mutation,
-- not merely observed mutation" standard (20260703000003); this brings the
-- journal rows themselves up to it.
--
-- Revoke, not a raise-always trigger: the schema's two UPDATE writers are
-- SECURITY DEFINER RPCs (confirm_unverified_sender and
-- retract_unverified_interaction -- see the linked-evidence trigger header in
-- 20260801000002, which inventories both)
-- which run as the table owner and must keep working. A trigger would fire for
-- them too; the grant revoke stops exactly the direct member path and nothing
-- else. INSERT and SELECT stay: the API's note branch is a plain caller-JWT
-- insert. TRUNCATE goes too, matching the events (20260604000002) and
-- interaction_participants (20260703000003) revokes -- PostgREST never emits
-- it, but append-only should be a grant fact, not a client-behavior fact.
revoke update, delete, truncate on public.interactions
  from public, anon, authenticated;

-- Precheck: both constraints below validate every existing row at apply time.
-- The operator apply path sweeps all pending migrations (supabase db push via
-- scripts like apply-incidents-migration.sh), so this file must carry its own
-- diagnostics: fail HERE with a message naming the cause rather than an opaque
-- check_violation mid-ALTER. A nonzero count is evidence the direct-write
-- bypass these constraints close was actually used -- investigate, don't
-- delete.
do $$
declare
  v_comm_none int;
  v_bad_note  int;
begin
  select
    count(*) filter (where kind = 'communication' and party_type = 'none'),
    count(*) filter (where channel = 'note' and party_id is not null
                     and party_type not in ('tenant', 'vendor', 'inspector', 'other'))
    into v_comm_none, v_bad_note
  from public.interactions;
  if v_comm_none > 0 or v_bad_note > 0 then
    raise exception using message = format(
      'journal hardening precheck failed: %s communication row(s) with '
      'party_type=''none'', %s note row(s) with a party_id but no concrete '
      'role. These rows are evidence of a direct-write bypass (see header); '
      'investigate before applying.', v_comm_none, v_bad_note);
  end if;
end $$;

-- DB shadow for "party_type 'none' is reserved for kind='note'"
-- (routes/interactions.ts returns 400). Until now any direct insert --
-- including the authenticated-callable journal_with_participants RPC, which
-- does not validate the interaction row's party_type -- could store a
-- communication carrying the note sentinel.
alter table public.interactions add constraint interactions_comm_party_named
  check (kind <> 'communication' or party_type <> 'none');

-- DB shadow for "party_id on a note needs a resolved role" (the API's 400).
-- Simplification: the old "party_type <> 'unspecified' or party_id is null"
-- arm is subsumed -- 'unspecified' on a note is already impossible via
-- interactions_unspecified_comm_only, and the concrete-role list below covers
-- the party_id-set case.
alter table public.interactions drop constraint interactions_note_fields;
alter table public.interactions add constraint interactions_note_fields
  check (
    channel <> 'note'
    or (direction = 'none'
        and (party_id is null
             or party_type in ('tenant', 'vendor', 'inspector', 'other')))
  );
