-- ----------------------------------------------------------------------------
-- Participants backfill: restate every legacy journal row's counterparty
-- slot as a cast row (source='backfill').
--
-- Prod contains only MANUALLY captured interactions (comms are dormant), so
-- this is a mechanical, insert-only restatement — after it, "everything
-- involving <person>" is ONE indexed cast query across all of history, and
-- readers never need a "cast if present, else party slot" fork.
--
-- The honesty rule: a backfilled row may only RESTATE what the slot already
-- attests, never say more. Concretely:
--   * no landlord row is invented (actor records who WROTE the row; writer
--     is not evidence of participation),
--   * party_type='unspecified' rows WITHOUT a label are skipped (nothing
--     known — the needs-attribution/classify flow remains their path to a
--     cast); 'unspecified' rows WITH a party_label restate as
--     party_type='unknown' + that label ("a real counterparty, recorded but
--     never identified" is information, and losing it would be the
--     backfill's only lie of omission),
--   * notes and agent_events are skipped (structurally no counterparty),
--   * no address is invented (the slot never held one),
--   * label = the frozen party_label where present, else the party's
--     CURRENT display name (a restatement of the same identity claim,
--     resolved at backfill time — the batch is dated by created_at and the
--     audit chain).
-- Role is derived from the row's own direction, the same mapping the
-- verified paths use in reverse: inbound → sender, outbound → recipient,
-- anything else (mutual / unspecified / none) → attendee.
--
-- Soft-deleted rows are included (they remain evidence). Idempotent: rows
-- that already carry a cast are skipped, so a re-run is a no-op.
-- Data-only migration by design (DDL lives in 20260703000003).
-- ----------------------------------------------------------------------------

insert into public.interaction_participants
  (account_id, interaction_id, role, party_type, party_id, address, label, source)
select
  i.account_id,
  i.id,
  case i.direction
    when 'inbound'  then 'sender'
    when 'outbound' then 'recipient'
    else 'attendee'
  end,
  i.party_type,
  i.party_id,
  null,
  left(coalesce(i.party_label, t.full_name, v.name), 200),
  'backfill'
from public.interactions i
left join public.tenants t
  on i.party_type = 'tenant'
 and t.account_id = i.account_id
 and t.id = i.party_id
left join public.vendors v
  on i.party_type = 'vendor'
 and v.account_id = i.account_id
 and v.id = i.party_id
where i.kind = 'communication'
  and i.party_type in ('tenant', 'vendor', 'inspector', 'other')
  and (i.party_id is not null or i.party_label is not null)
  and not exists (
    select 1 from public.interaction_participants ip
     where ip.interaction_id = i.id
  );

-- 'unspecified' + a recorded label: a real counterparty whose role/identity
-- was never resolved. Restated honestly as 'unknown' with the frozen label —
-- no id (none was ever claimed), no address (none was ever recorded).
insert into public.interaction_participants
  (account_id, interaction_id, role, party_type, party_id, address, label, source)
select
  i.account_id,
  i.id,
  case i.direction
    when 'inbound'  then 'sender'
    when 'outbound' then 'recipient'
    else 'attendee'
  end,
  'unknown',
  null,
  null,
  left(i.party_label, 200),
  'backfill'
from public.interactions i
where i.kind = 'communication'
  and i.party_type = 'unspecified'
  and i.party_label is not null
  and not exists (
    select 1 from public.interaction_participants ip
     where ip.interaction_id = i.id
  );
