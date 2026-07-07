-- ----------------------------------------------------------------------------
-- interactions_with_chain: pick up interactions.rfc822_message_id.
--
-- 20260707000002 added rfc822_message_id to interactions (populated on both
-- inbound captures and completed sends via complete_send), but the view's
-- `i.*` column list was frozen when it was last recreated (20260703000003) —
-- so every read through the view (thread detail messages, journal reads)
-- silently drops the column. Native email threading needs it there: the
-- transport derives In-Reply-To / References for thread-leg sends from the
-- Message-IDs of the thread's journal rows, which it reads via getThread.
--
-- Definition below is VERBATIM from 20260703000003 (G); only the re-creation
-- refreshes `i.*`. Recreate-don't-alter is this view's established churn
-- pattern (20260616000001, 20260701000004, 20260703000003).
-- ----------------------------------------------------------------------------

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
