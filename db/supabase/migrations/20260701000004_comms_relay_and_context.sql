-- ----------------------------------------------------------------------------
-- Comms ledger — relay journaling + relay provenance + journal context linkage.
--
-- Three pre-prod ledger items surfaced by Plan B's M3/M4 (coordinator REOPEN).
-- Forward-only follow-up to 20260701000002/03 (neither is in prod yet, but the
-- forward-only invariant stands). No provider work here; core-state only.
--
-- (1) complete_send must NOT double-journal a relay leg. A bridged message is
--     journaled ONCE — the inbound original (by capture_inbound). Relaying it
--     to the other participant is a delivery, not a new evidence record, so
--     the relay leg links to that original interaction rather than minting an
--     outbound copy attributed to a bare address. Per-leg delivery state lives
--     on the outbox rows (comm_outbox_relay_idx). Because several legs of one
--     relay share the original's id, the one-outbox-per-journal UNIQUE index
--     and the interactions_with_chain delivery join must EXCLUDE relay legs
--     (else a duplicate/foreign delivery_status would attach to the inbound
--     original and the view would multiply rows).
--
-- (2) Relay provenance vocabulary. An agent relay intent is authorized by the
--     THREAD itself — an owner/manager created it, a recorded act — not by a
--     per-message approval or a thread_autonomy grant (which stays reserved for
--     actual AI interjection). Accept approval_ref='thread:<thread_id>' on an
--     outbox intent IFF it is a relay (relay_of_interaction_id set). The
--     provenance CHECK is widened to admit that shape; the handler enforces
--     that the thread is live, account-owned, and the relayed interaction
--     belongs to it. approval_ref is already a free string — no spec shape
--     change from this item.
--
-- (3) Journal context linkage. Outbound sends journaled by complete_send
--     carried NULL tenancy_id / maintenance_request_id, so an approved send
--     about a maintenance request never appeared in that request's activity
--     feed (the app filters interactions by those refs). Add optional,
--     account-pinned tenancy_id / maintenance_request_id to comm_outbox;
--     complete_send copies them onto the journal row on the NON-relay insert
--     path (relay legs inherit context from the original interaction).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (3) Context columns on comm_outbox (nullable, composite-FK to the account).
-- ============================================================================
alter table public.comm_outbox
  add column tenancy_id             uuid,
  add column maintenance_request_id uuid;

alter table public.comm_outbox
  add constraint comm_outbox_tenancy_fk
    foreign key (account_id, tenancy_id)
    references public.tenancies (account_id, id) on delete set null,
  add constraint comm_outbox_mreq_fk
    foreign key (account_id, maintenance_request_id)
    references public.maintenance_requests (account_id, id) on delete set null;

-- ============================================================================
-- (2) Widen the provenance CHECK to admit thread:<id> for relay legs.
--     Locate the original unnamed CHECK by definition (inline checks get
--     conventional names, not guaranteed) and replace it with a named one.
-- ============================================================================
do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.comm_outbox'::regclass
    and contype  = 'c'
    and pg_get_constraintdef(oid) ilike '%approval_ref%grant%';
  if c is not null then
    execute format('alter table public.comm_outbox drop constraint %I', c);
  end if;
end $$;

alter table public.comm_outbox
  add constraint comm_outbox_provenance_check
  check (
    approved_by is not null
    or approval_ref like 'grant:%'
    or (approval_ref like 'thread:%' and relay_of_interaction_id is not null)
  );

-- ============================================================================
-- (1) Relay legs share the original journal row: exclude them from the
--     one-outbox-per-journal UNIQUE index and from the chain view's delivery
--     join, so the inbound original keeps its own (null) delivery_status and
--     the view never multiplies rows.
-- ============================================================================
drop index public.comm_outbox_interaction_id_uniq;
create unique index comm_outbox_interaction_id_uniq
  on public.comm_outbox (interaction_id)
  where interaction_id is not null and relay_of_interaction_id is null;

drop view public.interactions_with_chain;
create view public.interactions_with_chain
  with (security_invoker = true) as
  select i.*,
         c.id as superseded_by_id,
         (c.id is null) as is_head,
         o.id          as outbox_id,
         o.status      as delivery_status,
         o.delivered_at
  from public.interactions i
  left join public.interactions c on c.corrects_id = i.id
  left join public.comm_outbox o
         on o.interaction_id = i.id
        and o.relay_of_interaction_id is null;

grant select on public.interactions_with_chain to authenticated, service_role;

-- ============================================================================
-- (1)+(3) complete_send: relay short-circuit + non-relay context copy.
-- ============================================================================
create or replace function public.complete_send(
  p_outbox_id    uuid,
  p_provider     text,
  p_provider_sid text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox      public.comm_outbox%rowtype;
  v_interaction public.interactions%rowtype;
  v_party_type  text;
  v_party_id    uuid;
  v_party_label text;
  v_author_type text;
begin
  select * into v_outbox
    from public.comm_outbox
   where id = p_outbox_id
  for update;

  if not found then
    raise exception 'outbox row not found' using errcode = 'P0002';
  end if;

  -- Self-defense (DEFINER bypasses RLS): live membership in the row's account.
  if auth.uid() is null or not exists (
    select 1 from public.account_members m
     where m.user_id = auth.uid()
       and m.account_id = v_outbox.account_id
       and m.deleted_at is null
  ) then
    raise exception 'outbox row not found' using errcode = 'P0002';
  end if;

  -- Idempotent replay: same sid, already completed -> return the journal id
  -- (the linked interaction, which for a relay leg IS the original).
  if v_outbox.status in ('sent', 'delivered') and v_outbox.provider_sid = p_provider_sid then
    return v_outbox.interaction_id;
  end if;

  if v_outbox.status not in ('queued', 'sending', 'needs_reconcile') then
    raise exception 'outbox row is not completable (status=%)', v_outbox.status
      using errcode = 'P0003';
  end if;

  -- (1) Relay leg: link to the original interaction, do NOT mint a copy.
  if v_outbox.relay_of_interaction_id is not null then
    update public.comm_outbox
       set status         = 'sent',
           provider       = p_provider,
           provider_sid   = p_provider_sid,
           interaction_id = v_outbox.relay_of_interaction_id,
           updated_at     = now()
     where id = p_outbox_id;
    return v_outbox.relay_of_interaction_id;
  end if;

  -- Party attribution, best source first: the bound thread participant,
  -- else the account's channel identity for the dialed address, else the
  -- 'unspecified' sentinel with the address as the label.
  if v_outbox.participant_id is not null then
    select case p.party_type
             when 'tenant' then 'tenant'
             when 'vendor' then 'vendor'
             else 'other'
           end,
           p.party_id
      into v_party_type, v_party_id
      from public.comm_thread_participants p
     where p.id = v_outbox.participant_id;
  end if;
  if v_party_type is null then
    select case ci.party_type
             when 'tenant' then 'tenant'
             when 'vendor' then 'vendor'
             else 'other'
           end,
           ci.party_id
      into v_party_type, v_party_id
      from public.channel_identities ci
     where ci.account_id = v_outbox.account_id
       and ci.channel   = v_outbox.channel
       and ci.address   = v_outbox.to_address;
  end if;
  if v_party_type is null then
    v_party_type  := 'unspecified';
    v_party_id    := null;
    v_party_label := v_outbox.to_address;
  end if;

  v_author_type := v_outbox.author_type;

  -- The capacity trigger would (rightly) reject e.g. the agent transport
  -- writing author_type='landlord'; this is the verified completion path,
  -- so exempt this transaction AFTER the checks above.
  perform set_config('comm.verified_write', 'on', true);

  insert into public.interactions (
    account_id, actor, author_type, approved_by, approval_ref,
    entry_type, external_ref, kind, channel, direction,
    party_type, party_id, party_label, body, occurred_at,
    corrects_id, correction_kind, thread_id,
    tenancy_id, maintenance_request_id, area_id, work_order_id, vendor_id
  ) values (
    v_outbox.account_id,
    'user:' || auth.uid(),
    v_author_type,
    v_outbox.approved_by,
    v_outbox.approval_ref,
    null,
    p_provider_sid,
    'communication',
    public._comm_journal_channel(v_outbox.channel),
    'outbound',
    v_party_type,
    v_party_id,
    v_party_label,
    v_outbox.body,
    now(),
    null,
    null,
    v_outbox.thread_id,
    -- (3) carry the outbox's context onto the journal so the send shows up in
    -- the tenancy / maintenance-request activity feed.
    v_outbox.tenancy_id,
    v_outbox.maintenance_request_id,
    null,
    null,
    case when v_party_type = 'vendor' then v_party_id else null end
  )
  returning * into v_interaction;

  update public.comm_outbox
     set status         = 'sent',
         provider       = p_provider,
         provider_sid   = p_provider_sid,
         interaction_id = v_interaction.id,
         updated_at     = now()
   where id = p_outbox_id;

  return v_interaction.id;
end;
$$;

revoke execute on function public.complete_send(uuid, text, text) from public;
revoke execute on function public.complete_send(uuid, text, text) from anon;
grant  execute on function public.complete_send(uuid, text, text) to authenticated, service_role;
