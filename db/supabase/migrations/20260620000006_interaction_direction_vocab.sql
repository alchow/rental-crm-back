-- ----------------------------------------------------------------------------
-- Interaction direction vocabulary: add 'mutual' and 'unspecified'.
--
-- WHY. A communication previously had to declare inbound/outbound. For a
-- genuine two-way contact (a doorstep negotiation, a back-and-forth call) that
-- binary is artificial, and FORCING it manufactures a fact the landlord may
-- not reliably know -- unreliable data is a liability in an evidence record,
-- not an asset. Two additions make the field honest without eroding the
-- structure the legally-operative one-way records depend on:
--
--   'mutual'       a real two-way communication (the flow went both ways).
--   'unspecified'  a communication whose direction was not stated. The API
--                  stores this when the client omits direction
--                  (routes/interactions.ts). Distinct from 'none', which is
--                  the NON-communication sentinel.
--
-- inbound/outbound keep their exact meaning, so "notices I served" (outbound)
-- and "complaints/notices I received" (inbound) stay structurally queryable.
--
-- SCOPE. This is the ONLY constraint that changes. 'none' remains reserved for
-- note/import/agent_event via interactions_direction_none_check, and the
-- note/agent_event shape constraints already pin those channels to 'none' --
-- so 'mutual'/'unspecified' are admissible ONLY on real communication channels,
-- with no further check needed. Additive and backward-compatible: every
-- existing row and the inbound/outbound/none vocabulary are untouched, so no
-- data backfill and no chain churn (ADR-0008: a constraint swap writes no rows).
-- ----------------------------------------------------------------------------

alter table public.interactions drop constraint interactions_direction_check;
alter table public.interactions add constraint interactions_direction_check
  check (direction in ('inbound', 'outbound', 'mutual', 'unspecified', 'none'));
