-- Cleanup (Phase 2.1 follow-through): the synchronous-era RPC was kept for
-- one deploy cycle so migrations could land before the API. The async API
-- (complete_evidence_export) is live in production as of 2026-06-11; this
-- drops the dead path.

drop function if exists public.record_evidence_export(
  uuid, uuid, uuid, text, text, bigint, uuid, uuid, date, date,
  timestamptz, boolean, text, uuid
);
