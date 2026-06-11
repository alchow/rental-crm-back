-- ----------------------------------------------------------------------------
-- Phase 2.1 (architecture plan): async evidence exports.
--
-- POST /evidence-exports no longer renders the bundle in-request. The
-- evidence_exports row IS the job: it is INSERTed up front (status='queued',
-- by the member's own client under RLS, so the audit event carries
-- actor='user:<uuid>' natively), an in-process runner builds the PDF, and
-- completion lands atomically via complete_evidence_export below.
--
-- Status machine:
--   queued  -> running -> done
--                      -> failed   (error column says why; client may retry
--                                   by POSTing a new export)
-- queued/running rows found at boot are marked failed by the API ("server
-- restarted before processing") -- the in-process queue does not survive a
-- restart, and a truthful failed-state beats a forever-pending row.
--
-- The artifact columns (attachment_id, chain_verified, chain_message) are
-- therefore nullable until completion. generated_at keeps its default; it is
-- provisional on a queued row and overwritten with the real render timestamp
-- at completion.
-- ----------------------------------------------------------------------------

alter table public.evidence_exports
  add column status text not null default 'done'
    check (status in ('queued', 'running', 'done', 'failed')),
  add column error text;
-- default 'done' backfills every pre-async row (they all completed in-request);
-- the API sets status explicitly from here on.

alter table public.evidence_exports alter column chain_verified drop not null;
alter table public.evidence_exports alter column chain_message  drop not null;
alter table public.evidence_exports alter column attachment_id  drop not null;

-- A completed row must actually be complete; a pending/failed row must not
-- masquerade as done.
alter table public.evidence_exports add constraint evidence_exports_done_is_complete
  check (
    status <> 'done'
    or (attachment_id is not null and chain_verified is not null and chain_message is not null)
  );

create index evidence_exports_pending_idx
  on public.evidence_exports (status) where status in ('queued', 'running');

-- ============================================================================
-- complete_evidence_export: the atomic completion write.
--
-- One txn: (i) the bundle's attachment row; (ii) the export row flipped to
-- done with the artifact fields. audit.actor is pinned to the exporter read
-- off the row, so both audit events attribute the export to the operator who
-- requested it (the runner calls this via service_role; auth.uid() is NULL).
-- Operational transitions (running, failed) are plain service-role UPDATEs
-- and audit as 'system' -- only the completed artifact needs operator
-- attribution.
-- ============================================================================

create or replace function public.complete_evidence_export(
  p_evidence_export_id uuid,
  p_attachment_id      uuid,
  p_storage_path       text,
  p_content_hash       text,
  p_size_bytes         bigint,
  p_generated_at       timestamptz,
  p_chain_verified     boolean,
  p_chain_message      text
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_account  uuid;
  v_exporter uuid;
begin
  select account_id, exporter into v_account, v_exporter
  from public.evidence_exports
  where id = p_evidence_export_id and deleted_at is null
  for update;
  if v_account is null then
    raise exception 'evidence export % not found', p_evidence_export_id;
  end if;

  perform set_config(
    'audit.actor',
    case when v_exporter is not null then 'user:' || v_exporter::text else 'system' end,
    true
  );

  -- Attachment first; its entity_id points at the export row (polymorphic,
  -- not a FK), and the export row's composite FK on attachment_id is then
  -- satisfiable within the same txn.
  insert into public.attachments
    (id, account_id, entity_type, entity_id, storage_path, content_hash,
     mime_type, size_bytes, uploaded_by)
  values
    (p_attachment_id, v_account, 'evidence_export', p_evidence_export_id,
     p_storage_path, p_content_hash, 'application/pdf', p_size_bytes, v_exporter);

  update public.evidence_exports
     set attachment_id  = p_attachment_id,
         generated_at   = p_generated_at,
         chain_verified = p_chain_verified,
         chain_message  = p_chain_message,
         status         = 'done',
         error          = null,
         updated_at     = now()
   where id = p_evidence_export_id;
end;
$$;

grant execute on function public.complete_evidence_export(
  uuid, uuid, text, text, bigint, timestamptz, boolean, text
) to service_role;

-- record_evidence_export (the synchronous-era RPC) is intentionally KEPT for
-- one deploy cycle: migrations apply before the API deploys, and the old API
-- still calls it in the window between. Drop it in the next cleanup migration
-- once the async API is live.
