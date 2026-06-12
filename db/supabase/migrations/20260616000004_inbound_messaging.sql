-- ----------------------------------------------------------------------------
-- Inbound messaging + webhook completion RPCs (agent-api plan Phase 5).
--
-- (A) interactions.author_type: widen to include 'vendor'.
--     An inbound SMS from a vendor is vendor-authored; recording it as
--     anything else would be false capacity evidence. Uses the defensive
--     locate-by-definition drop pattern from 20260616000002 §A because the
--     constraint was added inline in 20260616000001 and the name is
--     conventional, not guaranteed.
--
-- (B) twilio_inbound_raw: service-level capture table for every inbound
--     Twilio webhook. Written before any matching/journal work so a crash
--     mid-handler causes Twilio to retry the whole webhook — idempotent by
--     the provider_sid UNIQUE constraint.
--
-- (C) complete_sms_send_system: ADR-0007 crash-window recovery path.
--     Used when the provider accepted the message, the synchronous
--     complete_sms_send RPC failed, AND the status callback later arrives
--     with the outbox_id + SID. SECURITY DEFINER; service_role only.
--
-- (D) update_sms_delivery: monotonic delivery-state advancement driven by
--     Twilio status callbacks. SECURITY DEFINER; service_role only.
--
-- (E) reconcile_message_outbox: janitor that parks stale 'sending' rows in
--     'needs_reconcile' for documented manual recovery. SECURITY DEFINER;
--     service_role only. Does NOT auto-retry or mark failed.
--
-- (F) capture_inbound_sms: SECURITY DEFINER RPC that sets
--     audit.actor='system:twilio-inbound' and inserts the journal interaction
--     for a matched inbound SMS. Called from the webhook handler (which lives
--     in api/src/admin/ and uses the admin client) following the intake.ts
--     pattern of setting actor inside the RPC before the writes.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (A) interactions.author_type: add 'vendor'
-- ============================================================================
--
-- The original check was named interactions_author_type_check in
-- 20260616000001, but we locate by definition so we never hard-code that
-- assumption. The new value 'vendor' is needed so inbound SMS from a vendor
-- can be stored with honest authorship.

do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.interactions'::regclass
    and contype  = 'c'
    and pg_get_constraintdef(oid) ilike '%author_type%landlord%';
  if c is not null then
    execute format('alter table public.interactions drop constraint %I', c);
  end if;
end $$;

alter table public.interactions
  add constraint interactions_author_type_check
  check (author_type in ('landlord', 'tenant', 'agent', 'system', 'vendor'));

-- ============================================================================
-- (B) twilio_inbound_raw
-- ============================================================================
--
-- Service-level capture table (no account_id until matching completes).
-- Rows may not belong to any account — a member-readable table would leak
-- cross-account phone traffic. RLS enabled with NO policies: authenticated
-- and anon are denied; service-role bypasses RLS.
--
-- NOT audited (_emit_event not attached): the table has no account_id so the
-- chain's per-account event stream would receive rows that don't belong to any
-- account. Capture integrity is maintained by the UNIQUE constraint on
-- provider_sid (dedupe) rather than the chain.

create table public.twilio_inbound_raw (
  id                      uuid        primary key default gen_random_uuid(),
  -- Webhook replay dedupe: Twilio retries on non-2xx; UNIQUE prevents double-processing.
  provider_sid            text        not null unique,
  from_phone              text        not null,
  to_phone                text        not null,
  body                    text,
  payload                 jsonb       not null,
  -- 'matched'   = exactly one (account, contact) match found; journal written
  -- 'unmatched' = no match found across all accounts
  -- 'ambiguous' = more than one match found
  match_status            text        not null
                          check (match_status in ('matched', 'unmatched', 'ambiguous')),
  matched_account_id      uuid        references public.accounts(id),
  -- No FK: the interaction may belong to any account or none; a composite FK
  -- would require matched_account_id to also be set which adds coupling.
  -- The link is used for operational debugging, not referential integrity.
  matched_interaction_id  uuid,
  -- Normalized keyword when the inbound message triggered opt-out processing
  -- (STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/START/YES/UNSTOP/HELP).
  last_keyword            text,
  received_at             timestamptz not null default now()
);

-- RLS: deny all authenticated/anon access. Service-role bypasses RLS.
alter table public.twilio_inbound_raw enable row level security;
alter table public.twilio_inbound_raw force  row level security;
-- No policies: all non-service-role access denied.
revoke all on public.twilio_inbound_raw from anon, authenticated;

-- Ops scan: quickly find unmatched/ambiguous rows that need human attention.
-- Partial on <> 'matched' keeps the index tight — matched rows are the
-- happy path and dominate the table at scale.
create index twilio_inbound_raw_pending_idx
  on public.twilio_inbound_raw (match_status)
  where match_status <> 'matched';

-- ============================================================================
-- (C) complete_sms_send_system
-- ============================================================================
--
-- ADR-0007 crash-window recovery path. Called when:
--   - The provider accepted the send (SID exists at Twilio).
--   - The synchronous complete_sms_send RPC failed or the API process crashed
--     before it could run.
--   - A Twilio status callback arrives later carrying the outbox_id + SID.
--
-- Identical in structure to complete_sms_send but:
--   - SECURITY DEFINER (no RLS; webhook has no user JWT; lock is safe because
--     definer bypasses the member RLS that complete_sms_send depends on).
--   - actor set to 'system:twilio-status' (the webhook is the mechanical writer;
--     author_type from the outbox preserves WHO originally authored the send so
--     evidence capacity survives the crash window).
--   - Idempotent: if not found OR status <> 'sending' → RETURN silently.
--     The normal path may have completed concurrently; callbacks retry.
--
-- Grant: service_role ONLY. An authenticated-callable version would let any
-- member fabricate completion with an arbitrary SID.

create or replace function public.complete_sms_send_system(
  p_outbox_id    uuid,
  p_provider_sid text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox      public.message_outbox%rowtype;
  v_interaction public.interactions%rowtype;
  v_party_type  text;
  v_party_id    uuid;
begin
  perform set_config('audit.actor', 'system:twilio-status', true);

  -- Lock the outbox row. Definer context bypasses member RLS.
  select * into v_outbox
    from public.message_outbox
   where id = p_outbox_id
  for update;

  -- Idempotent: not found or already past 'sending' → silent return.
  -- The normal synchronous path may have completed concurrently; callbacks retry.
  if not found then
    return;
  end if;

  if v_outbox.status <> 'sending' then
    return;
  end if;

  -- Counterparty from whichever ref is set (check constraint guarantees exactly one).
  if v_outbox.tenant_id is not null then
    v_party_type := 'tenant';
    v_party_id   := v_outbox.tenant_id;
  else
    v_party_type := 'vendor';
    v_party_id   := v_outbox.vendor_id;
  end if;

  -- Append the immutable journal entry.
  -- actor = 'system:twilio-status': the webhook is the mechanical writer.
  -- author_type = outbox.author_type: preserves WHO originally authored the send
  -- (landlord or agent) so capacity survives the crash window.
  insert into public.interactions (
    account_id,
    actor,
    author_type,
    approved_by,
    approval_ref,
    entry_type,
    external_ref,
    kind,
    channel,
    direction,
    party_type,
    party_id,
    party_label,
    body,
    occurred_at,
    corrects_id,
    correction_kind,
    tenancy_id,
    maintenance_request_id,
    area_id,
    work_order_id,
    vendor_id
  ) values (
    v_outbox.account_id,
    'system:twilio-status',
    v_outbox.author_type,
    null,
    v_outbox.approval_ref,
    null,
    p_provider_sid,
    'communication',
    'sms',
    'outbound',
    v_party_type,
    v_party_id,
    null,
    v_outbox.body,
    now(),
    null,
    null,
    v_outbox.tenancy_id,
    v_outbox.maintenance_request_id,
    null,
    v_outbox.work_order_id,
    v_outbox.vendor_id
  )
  returning * into v_interaction;

  -- Mark outbox sent and link the journal row. Both writes in one transaction —
  -- the ADR-0007 atomicity guarantee of option C, applied to the recovery path.
  update public.message_outbox
     set status         = 'sent',
         provider_sid   = p_provider_sid,
         interaction_id = v_interaction.id,
         updated_at     = now()
   where id = p_outbox_id;
end;
$$;

-- Revoke from public/anon/authenticated first, then grant only to service_role.
revoke execute on function public.complete_sms_send_system(uuid, text) from public;
revoke execute on function public.complete_sms_send_system(uuid, text) from anon;
revoke execute on function public.complete_sms_send_system(uuid, text) from authenticated;
grant execute on function public.complete_sms_send_system(uuid, text) to service_role;

-- ============================================================================
-- (D) update_sms_delivery
-- ============================================================================
--
-- Monotonic delivery-state advancement driven by Twilio status callbacks.
-- Rank order: sending(0) < sent(1) < delivered(2); terminal: failed/undeliverable
-- reachable from sending or sent. Out-of-order or duplicate callbacks → silent
-- return (Twilio retries and reorders). The CALLER maps Twilio statuses to
-- outbox statuses before calling this function.
--
-- Invariant: provider_sid must match the outbox row's provider_sid (null-safe).
-- If outbox.provider_sid is null, the crash-window recovery (complete_sms_send_system)
-- must run first; this function returns silently in that case.

create or replace function public.update_sms_delivery(
  p_outbox_id    uuid,
  p_provider_sid text,
  p_status       text,
  p_error_code   text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox    public.message_outbox%rowtype;
  v_cur_rank  int;
  v_new_rank  int;
  v_terminals text[] := array['failed', 'undeliverable'];
begin
  perform set_config('audit.actor', 'system:twilio-status', true);

  select * into v_outbox
    from public.message_outbox
   where id = p_outbox_id
  for update;

  if not found then
    return;
  end if;

  -- SID guard: if outbox.provider_sid is null, complete_sms_send_system must
  -- run first (crash-window recovery). Return silently — the caller is expected
  -- to call complete_sms_send_system before update_sms_delivery.
  if v_outbox.provider_sid is null then
    return;
  end if;

  -- SID mismatch: unexpected but handle defensively.
  if v_outbox.provider_sid <> p_provider_sid then
    return;
  end if;

  -- Assign monotonic ranks. terminal statuses share rank 9 to simplify
  -- the comparison: a terminal row stays terminal regardless of input.
  v_cur_rank := case v_outbox.status
    when 'sending'       then 0
    when 'sent'          then 1
    when 'delivered'     then 2
    when 'failed'        then 9
    when 'undeliverable' then 9
    else 99
  end;

  v_new_rank := case p_status
    when 'sending'       then 0
    when 'sent'          then 1
    when 'delivered'     then 2
    when 'failed'        then 9
    when 'undeliverable' then 9
    else -1  -- unknown input → ignore
  end;

  -- Unknown status input → ignore.
  if v_new_rank = -1 then
    return;
  end if;

  -- Already terminal → no further transitions.
  if v_cur_rank = 9 then
    return;
  end if;

  -- Monotonic guard: incoming rank <= current rank → already at this state or
  -- beyond. Silent return (Twilio retries + reorders callbacks).
  if v_new_rank <= v_cur_rank then
    return;
  end if;

  -- Apply the transition.
  update public.message_outbox
     set status       = p_status,
         error_code   = case when p_status = any(v_terminals) then p_error_code else error_code end,
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end,
         updated_at   = now()
   where id = p_outbox_id;
end;
$$;

revoke execute on function public.update_sms_delivery(uuid, text, text, text) from public;
revoke execute on function public.update_sms_delivery(uuid, text, text, text) from anon;
revoke execute on function public.update_sms_delivery(uuid, text, text, text) from authenticated;
grant execute on function public.update_sms_delivery(uuid, text, text, text) to service_role;

-- ============================================================================
-- (E) reconcile_message_outbox
-- ============================================================================
--
-- Janitor that parks stale 'sending' rows in 'needs_reconcile' for documented
-- manual recovery (docs/agent-runbook.md).
--
-- NEVER auto-retries a send. NEVER marks failed. The provider response is lost;
-- there is no SQL-side way to know whether Twilio accepted. Rows park in
-- 'needs_reconcile' until an operator checks the Twilio console/Messages API
-- and either:
--   (a) calls complete_sms_send_system manually with the known SID, then
--       update_sms_delivery for the current delivery state, OR
--   (b) marks the row failed after confirming nothing was sent.
--
-- The status callback path (update_sms_delivery after complete_sms_send_system)
-- is the automated backstop; the janitor is the fallback for rows where the
-- callback also never arrived.

create or replace function public.reconcile_message_outbox(
  p_stale_seconds int default 3600
)
returns table (parked int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor  text := 'system:cron:janitor';
  v_parked int  := 0;
begin
  perform set_config('audit.actor', v_actor, true);

  -- Park stale 'sending' rows: these have been in-flight longer than
  -- p_stale_seconds with no provider callback. The outbox_id is in the
  -- Twilio callback URL; if callbacks arrive later they still complete the
  -- row correctly via complete_sms_send_system + update_sms_delivery.
  update public.message_outbox
     set status     = 'needs_reconcile',
         updated_at = now()
   where status     = 'sending'
     and updated_at < now() - make_interval(secs => p_stale_seconds);
  get diagnostics v_parked = row_count;

  parked := v_parked;
  return next;
end;
$$;

revoke execute on function public.reconcile_message_outbox(int) from public;
revoke execute on function public.reconcile_message_outbox(int) from anon;
revoke execute on function public.reconcile_message_outbox(int) from authenticated;
grant execute on function public.reconcile_message_outbox(int) to service_role;

-- ============================================================================
-- (F) capture_inbound_sms
-- ============================================================================
--
-- SECURITY DEFINER RPC called from the inbound webhook handler (api/src/admin/).
-- Sets audit.actor='system:twilio-inbound' before the insert, following the
-- intake.ts pattern: actor set inside the RPC so the chain attribute is always
-- 'system:twilio-inbound' regardless of who calls the function at the
-- PostgREST layer. Service-role only.
--
-- Parameters:
--   p_account_id   uuid     -- matched account
--   p_author_type  text     -- 'tenant' or 'vendor' (from matching result)
--   p_party_type   text     -- 'tenant' or 'vendor'
--   p_party_id     uuid     -- matched tenant or vendor id
--   p_channel      text     -- 'sms'
--   p_body         text     -- message body (may be null)
--   p_occurred_at  timestamptz
--   p_external_ref text     -- Twilio MessageSid

create or replace function public.capture_inbound_sms(
  p_account_id   uuid,
  p_author_type  text,
  p_party_type   text,
  p_party_id     uuid,
  p_body         text,
  p_occurred_at  timestamptz,
  p_external_ref text
)
returns public.interactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_interaction public.interactions%rowtype;
begin
  -- Set audit.actor before any write so the chain records the correct actor.
  -- This mirrors the intake RPC pattern in submit_intake_with_attachment.
  perform set_config('audit.actor', 'system:twilio-inbound', true);

  insert into public.interactions (
    account_id,
    actor,
    author_type,
    approved_by,
    approval_ref,
    entry_type,
    external_ref,
    kind,
    channel,
    direction,
    party_type,
    party_id,
    party_label,
    body,
    occurred_at,
    corrects_id,
    correction_kind,
    tenancy_id,
    maintenance_request_id,
    area_id,
    work_order_id,
    vendor_id
  ) values (
    p_account_id,
    'system:twilio-inbound',
    p_author_type,
    null,
    null,
    null,
    p_external_ref,
    'communication',
    'sms',
    'inbound',
    p_party_type,
    p_party_id,
    null,
    p_body,
    p_occurred_at,
    null,
    null,
    null,
    null,
    null,
    null,
    case when p_party_type = 'vendor' then p_party_id else null end
  )
  returning * into v_interaction;

  return v_interaction;
end;
$$;

revoke execute on function public.capture_inbound_sms(uuid, text, text, uuid, text, timestamptz, text) from public;
revoke execute on function public.capture_inbound_sms(uuid, text, text, uuid, text, timestamptz, text) from anon;
revoke execute on function public.capture_inbound_sms(uuid, text, text, uuid, text, timestamptz, text) from authenticated;
grant execute on function public.capture_inbound_sms(uuid, text, text, uuid, text, timestamptz, text) to service_role;
