-- ----------------------------------------------------------------------------
-- Phase 3 (architecture plan, ADR-0002): chain watermarks — the sweep becomes
-- O(new events) instead of O(entire history).
--
-- verify_chain_sweep re-walked every account's full event chain from event #1
-- on every tick. The watermark records "verified intact through account_seq N
-- with chain hash H at time T"; the next sweep resumes from N.
--
-- SECURITY TRADE-OFF (deliberate, documented in docs/adr/0002):
--   * Tamper AFTER the watermark: caught immediately by the incremental walk.
--   * Tamper AT/BEHIND the watermark: NOT caught by the incremental walk --
--     the rows behind N are attested by the watermark, not re-read. Healing:
--     the sweep AUTOMATICALLY runs a FULL verify whenever the watermark's
--     last_full_at is older than 24h, so the detection window for
--     behind-watermark tamper is bounded by that cadence. The evidence-export
--     banner (verify_chain via export-pdf.ts) remains a FULL verification --
--     the artifact a court sees never relies on the watermark.
--   * The watermark row itself is operational state, not evidence: an
--     attacker with DB-owner power can move it -- but that attacker can also
--     rewrite events; the chain hash + the bounded full-verify cadence is
--     the detection story for both, unchanged from Phase 11.
-- ----------------------------------------------------------------------------

create table public.chain_watermarks (
  account_id         uuid primary key references public.accounts(id) on delete cascade,
  -- The chain verifies intact through this account_seq...
  last_verified_seq  bigint not null check (last_verified_seq >= 1),
  -- ...whose event_hash was this (the resume anchor for the next walk).
  last_verified_hash bytea  not null,
  -- Last time ANY verification (incremental or full) succeeded through seq.
  verified_at        timestamptz not null default now(),
  -- Last time a FULL from-genesis verification succeeded. The sweep forces a
  -- full pass when this is older than 24h (the behind-watermark detection
  -- cadence).
  last_full_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.chain_watermarks enable row level security;
alter table public.chain_watermarks force  row level security;

-- Members can SEE their account's verification state (same transparency as
-- chain_verification_alerts). Writes happen only inside the SECURITY DEFINER
-- sweep/verify functions below.
create policy chain_watermarks_member_select on public.chain_watermarks
  for select using (public.is_account_member(account_id));

revoke insert, update, delete on public.chain_watermarks from public;
revoke insert, update, delete on public.chain_watermarks from anon, authenticated;

-- Deliberately NOT audited (no _emit_event trigger): the watermark is DERIVED
-- verification state, not evidence. Auditing each sweep tick would append an
-- event per account per tick to the very chain being verified -- the chain
-- would grow because we looked at it.

-- ============================================================================
-- verify_chain_incremental: resume from the watermark.
--
-- Same three checks as verify_chain (gap-free account_seq, prev linkage,
-- hash recomputation) over only the events AFTER last_verified_seq. The
-- anchor event (seq = last_verified_seq) is re-read and must still carry the
-- recorded hash; if it doesn't (watermark drifted from events -- tamper or
-- manual surgery), fall back to a FULL verify.
-- Advances the watermark on success. Returns events_checked so callers and
-- tests can see the O(new events) property directly.
-- ============================================================================

create or replace function public.verify_chain_incremental(p_account_id uuid)
returns table (
  ok               boolean,
  broken_at        uuid,
  broken_event_no  bigint,
  reason           text,
  events_checked   bigint
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  wm          record;
  e           record;
  v_prev      bytea  := decode(repeat('00', 32), 'hex'); -- genesis
  v_start     bigint := 0;
  v_n         bigint;
  v_checked   bigint := 0;
  v_full      record;
  v_canonical jsonb;
  v_expected  bytea;
  v_did_full  boolean := false;
begin
  select w.last_verified_seq, w.last_verified_hash
    into wm
    from public.chain_watermarks w
   where w.account_id = p_account_id;

  if found then
    -- Anchor re-check: the event the watermark points at must still exist
    -- with the recorded hash. O(1) via the (account_id, account_seq) index.
    perform 1 from public.events ev
      where ev.account_id = p_account_id
        and ev.account_seq = wm.last_verified_seq
        and ev.event_hash  = wm.last_verified_hash;
    if not found then
      -- Watermark and events disagree: full verify, and report its verdict.
      select vc.ok, vc.broken_at, vc.broken_event_no, vc.reason
        into v_full from public.verify_chain(p_account_id) vc;
      v_did_full := true;
      if not v_full.ok then
        ok := false; broken_at := v_full.broken_at;
        broken_event_no := v_full.broken_event_no;
        reason := 'watermark anchor mismatch; full verify: ' || coalesce(v_full.reason, 'broken');
        events_checked := (select count(*) from public.events where account_id = p_account_id);
        return next; return;
      end if;
      -- Full verify passed (e.g. watermark was stale garbage): rebuild it
      -- from the chain head below.
      select ev.account_seq, ev.event_hash into v_start, v_prev
        from public.events ev where ev.account_id = p_account_id
        order by ev.account_seq desc limit 1;
    else
      v_prev  := wm.last_verified_hash;
      v_start := wm.last_verified_seq;
    end if;
  end if;

  -- A walk that starts at genesis (no usable watermark) IS a full
  -- verification; record it as such so the sweep's 24h cadence is honest.
  if v_start = 0 then
    v_did_full := true;
  end if;

  v_n := v_start;
  for e in
    select ev.id, ev.account_id, ev.account_seq, ev.entity_type, ev.entity_id,
           ev.event_type, ev.payload, ev.occurred_at, ev.prev_event_hash, ev.event_hash
      from public.events ev
     where ev.account_id = p_account_id and ev.account_seq > v_start
     order by ev.account_seq asc
  loop
    v_n := v_n + 1;
    v_checked := v_checked + 1;

    if e.account_seq <> v_n then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := format('account_seq gap at position %s: row has account_seq %s', v_n, e.account_seq);
      events_checked := v_checked;
      return next; return;
    end if;

    if e.prev_event_hash is distinct from v_prev then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := 'prev_event_hash mismatch';
      events_checked := v_checked;
      return next; return;
    end if;

    v_canonical := jsonb_build_object(
      'account_id',  e.account_id,
      'account_seq', e.account_seq,
      'entity_id',   e.entity_id,
      'entity_type', e.entity_type,
      'event_type',  e.event_type,
      'occurred_at', e.occurred_at,
      'payload',     e.payload,
      'prev',        encode(v_prev, 'hex')
    );
    v_expected := digest(v_canonical::text, 'sha256');
    if e.event_hash is distinct from v_expected then
      ok := false; broken_at := e.id; broken_event_no := v_n;
      reason := 'event_hash recomputation mismatch';
      events_checked := v_checked;
      return next; return;
    end if;

    v_prev := e.event_hash;
  end loop;

  -- Verified through v_n; advance the watermark (if the chain has any events).
  if v_n >= 1 then
    insert into public.chain_watermarks
      (account_id, last_verified_seq, last_verified_hash, verified_at, last_full_at)
    values
      (p_account_id, v_n, v_prev, now(), case when v_did_full then now() else to_timestamp(0) end)
    on conflict (account_id) do update
      set last_verified_seq  = excluded.last_verified_seq,
          last_verified_hash = excluded.last_verified_hash,
          verified_at        = now(),
          last_full_at       = case when v_did_full then now()
                                    else public.chain_watermarks.last_full_at end,
          updated_at         = now();
  end if;

  ok := true; broken_at := null; broken_event_no := null; reason := null;
  events_checked := v_checked;
  return next;
end;
$$;

grant execute on function public.verify_chain_incremental(uuid) to service_role;

-- ============================================================================
-- verify_chain_sweep: same alert contract as Phase 11, now O(new events).
--
-- Incremental by default; FULL from-genesis verification when the
-- watermark's last_full_at is older than 24h (or no watermark exists). The
-- alert insert/resolve behavior is unchanged.
-- ============================================================================

create or replace function public.verify_chain_sweep(p_account_id uuid)
returns table (
  ok               boolean,
  alert_inserted   boolean,
  alerts_resolved  int
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor    text := 'system:cron:chain_sweep';
  v_result   record;
  v_inserted boolean := false;
  v_resolved int := 0;
  v_need_full boolean;
  v_head     record;
begin
  perform set_config('audit.actor', v_actor, true);

  select (w.account_id is null or w.last_full_at < now() - interval '24 hours')
    into v_need_full
    from (select 1) one
    left join public.chain_watermarks w on w.account_id = p_account_id;

  if v_need_full then
    select vc.ok, vc.broken_at, vc.broken_event_no, vc.reason
      into v_result from public.verify_chain(p_account_id) vc;
    if v_result.ok then
      select ev.account_seq, ev.event_hash into v_head
        from public.events ev where ev.account_id = p_account_id
        order by ev.account_seq desc limit 1;
      if v_head.account_seq is not null then
        insert into public.chain_watermarks
          (account_id, last_verified_seq, last_verified_hash, verified_at, last_full_at)
        values (p_account_id, v_head.account_seq, v_head.event_hash, now(), now())
        on conflict (account_id) do update
          set last_verified_seq  = excluded.last_verified_seq,
              last_verified_hash = excluded.last_verified_hash,
              verified_at        = now(),
              last_full_at       = now(),
              updated_at         = now();
      end if;
    end if;
  else
    select vi.ok, vi.broken_at, vi.broken_event_no, vi.reason
      into v_result from public.verify_chain_incremental(p_account_id) vi;
  end if;

  if v_result.ok then
    update public.chain_verification_alerts
       set resolved_at = now(), updated_at = now()
     where account_id = p_account_id
       and resolved_at is null;
    get diagnostics v_resolved = row_count;
  else
    insert into public.chain_verification_alerts
      (account_id, broken_event_id, broken_event_no, reason)
    values
      (p_account_id, v_result.broken_at, v_result.broken_event_no,
       coalesce(v_result.reason, 'verify reported broken with no reason'))
    on conflict (account_id, broken_event_no) do update
      set last_detected_at = now(),
          updated_at       = now(),
          reason           = excluded.reason,
          -- Re-detection REOPENS a previously-resolved alert. The Phase 11
          -- sweep left resolved_at untouched on conflict, so a break that
          -- was resolved and later re-detected at the same position stayed
          -- silently "resolved" -- surfaced by the watermark DoD tests.
          resolved_at      = null;
    select (created_at = updated_at) into v_inserted
      from public.chain_verification_alerts
     where account_id = p_account_id and broken_event_no = v_result.broken_event_no;
  end if;

  ok               := v_result.ok;
  alert_inserted   := v_inserted;
  alerts_resolved  := v_resolved;
  return next;
end;
$$;
