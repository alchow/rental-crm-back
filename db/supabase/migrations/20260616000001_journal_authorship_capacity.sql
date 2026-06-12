-- ----------------------------------------------------------------------------
-- Journal authorship capacity + agent-event vocabulary (agent-api plan,
-- Workstream A; ADR-0008).
--
-- WHO wrote a journal entry and UNDER WHAT AUTHORITY becomes first-class:
--
--   author_type   'landlord' | 'tenant' | 'agent' | 'system'. Stamped by the
--                 API from the resolved principal on every NEW write. Legacy
--                 rows stay NULL -- their authorship is already precisely
--                 recorded in `actor` ('user:'/'tenant:'/'system'), and the
--                 API resolves the wire value from it. NO backfill: a
--                 constant would write false history (intake rows are
--                 tenant-authored), and a derived UPDATE would churn one
--                 chained event per row for zero information gain.
--   approved_by   the landlord user who explicitly approved an
--                 agent-authored entry (nullable user reference).
--   approval_ref  opaque reference to the agent-side approval/proposal.
--   entry_type    agent exhaust vocabulary; non-null exactly on
--                 kind='agent_event' rows (whitelist below).
--   external_ref  provider-side message id (e.g. Twilio MessageSid) for
--                 send-pipeline-produced communications. Channel-agnostic.
--
-- Chain compatibility (ADR-0008): the audit chain hashes row SNAPSHOTS
-- (`to_jsonb(NEW)` at write time); verify_chain re-hashes the STORED
-- snapshot. Adding columns cannot invalidate any historical event, and new
-- rows carry the capacity fields inside the hashed payload automatically --
-- tamper-evident from the first post-migration write, no schema_version,
-- no verification change. Proven by db/test/chain-mixed-era.test.ts.
--
-- kind='agent_event' follows the sentinel precedent (import 20260611000001,
-- note 20260612000001): channel='agent_event', direction='none',
-- party_type='none', valid only in that combination. An agent_event is
-- structured machine exhaust (proposal lifecycle, step execution) -- refs
-- via the existing FK columns, body bounded so it can never carry
-- conversational payloads. The landlord<->agent private chat must NEVER
-- enter the journal; this vocabulary is the structural enforcement surface
-- (the app-layer firewall lands with the agent principal).
-- ----------------------------------------------------------------------------

alter table public.interactions
  add column author_type text
    constraint interactions_author_type_check
    check (author_type in ('landlord', 'tenant', 'agent', 'system')),
  add column approved_by uuid references public.users(id),
  add column approval_ref text
    constraint interactions_approval_ref_check
    check (length(approval_ref) between 1 and 200),
  add column entry_type text
    constraint interactions_entry_type_check
    check (entry_type in (
      'proposal_created', 'proposal_approved', 'proposal_rejected', 'step_executed'
    )),
  add column external_ref text
    constraint interactions_external_ref_check
    check (length(external_ref) between 1 and 255);

-- ---------------------------------------------------------------------------
-- Vocabulary: kind + channel gain 'agent_event'.
-- ---------------------------------------------------------------------------

alter table public.interactions drop constraint interactions_kind_check;
alter table public.interactions add constraint interactions_kind_check
  check (kind in ('communication', 'note', 'agent_event'));

alter table public.interactions drop constraint interactions_channel_check;
alter table public.interactions add constraint interactions_channel_check
  check (channel in (
    'in_person', 'phone', 'voicemail',
    'sms', 'email', 'letter', 'in_app',
    'import', 'note', 'agent_event'
  ));

alter table public.interactions drop constraint interactions_direction_none_check;
alter table public.interactions add constraint interactions_direction_none_check
  check (direction <> 'none' or channel in ('import', 'note', 'agent_event'));

-- An agent_event IS the 'agent_event' channel and vice versa; and it is
-- fully event-shaped: no direction, no counterparty of any kind.
alter table public.interactions add constraint interactions_agent_event_shape
  check ((kind = 'agent_event') = (channel = 'agent_event'));
alter table public.interactions add constraint interactions_agent_event_fields
  check (
    channel <> 'agent_event'
    or (direction = 'none' and party_type = 'none'
        and party_id is null and party_label is null)
  );

-- entry_type exists exactly on agent_event rows.
alter table public.interactions add constraint interactions_entry_type_pairing
  check ((entry_type is not null) = (kind = 'agent_event'));

-- ---------------------------------------------------------------------------
-- Evidence-grade invariants, DB-enforced (not just app-checked), because
-- they must hold under racing requests and direct writes:
--
--   1. An agent can never write landlord-meaningful prose the landlord did
--      not explicitly approve.
--   2. agent_event bodies are bounded -- structurally incapable of carrying
--      a conversation.
-- ---------------------------------------------------------------------------

alter table public.interactions add constraint interactions_agent_note_approval
  check (
    not (kind = 'note' and author_type = 'agent')
    or (approved_by is not null and approval_ref is not null)
  );

alter table public.interactions add constraint interactions_agent_event_body_bound
  check (kind <> 'agent_event' or body is null or length(body) <= 1000);

-- ---------------------------------------------------------------------------
-- Recreate the chain view: Postgres expands `i.*` at view-creation time, so
-- the new columns are invisible to the existing view until it is rebuilt.
-- Definition is otherwise verbatim from 20260612000001.
-- ---------------------------------------------------------------------------

drop view public.interactions_with_chain;
create view public.interactions_with_chain
  with (security_invoker = true) as
  select i.*,
         c.id as superseded_by_id,
         (c.id is null) as is_head
  from public.interactions i
  left join public.interactions c on c.corrects_id = i.id;

grant select on public.interactions_with_chain to authenticated, service_role;
