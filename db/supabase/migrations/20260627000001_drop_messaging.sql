-- ----------------------------------------------------------------------------
-- Forward-only teardown of the Twilio/SMS messaging machinery.
--
-- Removes everything created by:
--   20260616000003_messaging.sql        (message_outbox, sms_opt_outs,
--                                         is_phone_opted_out, complete_sms_send,
--                                         fail_sms_send, _enforce_agent_capacity,
--                                         interactions_with_chain w/ outbox join)
--   20260616000004_inbound_messaging.sql (twilio_inbound_raw,
--                                         complete_sms_send_system,
--                                         update_sms_delivery,
--                                         reconcile_message_outbox,
--                                         capture_inbound_sms,
--                                         author_type 'vendor' widening)
--
-- KEPT deliberately:
--   * The generic 'sms' channel value in interactions (it predates Twilio; a
--     landlord may still log "texted the tenant" by hand).
--   * interactions.author_type value 'vendor' — historical vendor-authored
--     rows must not be orphaned; the value stays valid.
--
-- The immutable interactions journal is never mutated. interactions_with_chain
-- is recreated WITHOUT the message_outbox join, restoring the shape from
-- 20260617000001 (i.* still carries references_interaction_id).
-- ----------------------------------------------------------------------------

-- ============================================================================
-- (1) Recreate interactions_with_chain WITHOUT the message_outbox join.
--     Must run before message_outbox is dropped (the live view references it).
--     Verbatim from 20260617000001 minus o.status / o.delivered_at and the
--     left join to message_outbox.
-- ============================================================================
drop view public.interactions_with_chain;
create view public.interactions_with_chain
  with (security_invoker = true) as
  select i.*,
         c.id as superseded_by_id,
         (c.id is null) as is_head
  from public.interactions i
  left join public.interactions c on c.corrects_id = i.id;

grant select on public.interactions_with_chain to authenticated, service_role;

-- ============================================================================
-- (2) Drop the agent-capacity backstop trigger + function.
--     Its load-bearing invariant ("an agent communication must carry a
--     provider SID") existed only because the Twilio send pipeline was the
--     sole producer of agent-authored communications. The app-layer firewall
--     (api/src/routes/_lib/agent-firewall.ts) already forbids agents from
--     appending kind='communication' at all, so this DB shadow is now dead.
-- ============================================================================
drop trigger if exists interactions_enforce_agent_capacity on public.interactions;
drop function if exists public._enforce_agent_capacity();

-- ============================================================================
-- (3) Drop the inbound/webhook RPCs (20260616000004).
-- ============================================================================
drop function if exists public.capture_inbound_sms(uuid, text, text, uuid, text, timestamptz, text);
drop function if exists public.reconcile_message_outbox(int);
drop function if exists public.update_sms_delivery(uuid, text, text, text);
drop function if exists public.complete_sms_send_system(uuid, text);

-- ============================================================================
-- (4) Drop the outbound completion RPCs (20260616000003).
-- ============================================================================
drop function if exists public.fail_sms_send(uuid, text, text);
drop function if exists public.complete_sms_send(uuid, text);
drop function if exists public.is_phone_opted_out(text);

-- ============================================================================
-- (5) Drop the tables. Indexes, the message_outbox audit trigger, RLS
--     policies, and FK/CHECK constraints drop implicitly with each table.
--     twilio_inbound_raw first (no dependents), then message_outbox (the view
--     no longer references it after step 1), then sms_opt_outs.
-- ============================================================================
drop table if exists public.twilio_inbound_raw;
drop table if exists public.message_outbox;
drop table if exists public.sms_opt_outs;

-- ============================================================================
-- (6) interactions.author_type: 'vendor' is RETAINED. No constraint change.
-- ============================================================================
