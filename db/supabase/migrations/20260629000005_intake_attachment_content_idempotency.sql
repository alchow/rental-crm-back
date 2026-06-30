-- ----------------------------------------------------------------------------
-- Intake RPC: content-addressed idempotency for the attachment insert(s).
--
-- 20260629000001 added the partial unique index
--   attachments_content_idem_idx (account_id, entity_type, entity_id, content_hash)
--     where deleted_at is null
-- so re-uploading identical bytes to the same entity returns the existing row
-- instead of creating a duplicate. The app-level upload path (uploadAttachment
-- in api/src/admin/storage.ts) was taught to dedupe; the unified intake RPC
-- submit_intake_with_attachment was NOT, so it still did a blind INSERT.
--
-- Failure it caused: a tenant re-submits the SAME title+area (the request
-- dedupes onto the existing open maintenance_request) WITH the same photo
-- bytes. The attachment insert then collides with the new unique index on
-- (account, 'maintenance_requests', <same request id>, <same content_hash>)
-- and the whole RPC aborts with 23505 -> the API returns 500. It should
-- instead dedupe the photo onto the existing row and return 201.
--
-- Fix: make both attachment INSERTs idempotent the same way the app path is --
-- ON CONFLICT ... DO NOTHING against the partial unique index, then fall back
-- to SELECTing the live row's id when the insert was a no-op. The conflict
-- target MUST repeat the index predicate (`where deleted_at is null`) so it
-- matches the partial index. Atomicity is preserved: request + interaction +
-- attachment(s) still commit in one transaction.
--
-- This is a pure CREATE OR REPLACE of the function from
-- 20260605000010_phase9_cron_intake_heic.sql; only the two attachment inserts
-- changed. DB-only and backward-compatible (the API already maps the returned
-- attachment_id/deduped), but like the sibling 20260629000001-04 it must be
-- applied to prod BEFORE the API deploys.
-- ----------------------------------------------------------------------------
create or replace function public.submit_intake_with_attachment(
  p_account_id        uuid,
  p_tenancy_id        uuid,
  p_area_id           uuid,
  p_title             text,
  p_description       text,
  p_severity          text,
  p_occurred_at       timestamptz,
  p_actor             text,
  p_attachment_hash       text,
  p_attachment_mime       text,
  p_attachment_size       bigint,
  p_attachment_path       text,
  p_derivative_hash       text default null,
  p_derivative_mime       text default null,
  p_derivative_size       bigint default null,
  p_derivative_path       text default null
)
returns table (
  maintenance_request_id  uuid,
  interaction_id          uuid,
  attachment_id           uuid,
  derivative_id           uuid,
  deduped                 boolean
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_existing_req   uuid;
  v_new_req        uuid;
  v_interaction_id uuid;
  v_attachment_id  uuid;
  v_derivative_id  uuid;
  v_deduped        boolean := false;
begin
  perform set_config('audit.actor', p_actor, true);

  select id into v_existing_req
    from public.maintenance_requests
    where account_id = p_account_id
      and area_id    = p_area_id
      and status     = 'open'
      and title      = p_title
      and deleted_at is null
    limit 1;

  if v_existing_req is not null then
    v_new_req := v_existing_req;
    v_deduped := true;
  else
    insert into public.maintenance_requests
      (account_id, area_id, title, description, severity, status, intake_token)
    values
      (p_account_id, p_area_id, p_title, p_description, p_severity, 'open', p_actor)
    returning id into v_new_req;
  end if;

  insert into public.interactions
    (account_id, actor, party_type, channel, direction, body,
     occurred_at, tenancy_id, maintenance_request_id, area_id)
  values
    (p_account_id, p_actor, 'tenant', 'in_app', 'inbound',
     p_description, p_occurred_at, p_tenancy_id, v_new_req, p_area_id)
  returning id into v_interaction_id;

  if p_attachment_hash is not null then
    -- Content idempotency: re-submitting the same bytes to the same (deduped)
    -- request must reuse the existing attachment row, not collide on
    -- attachments_content_idem_idx. DO NOTHING returns no row on conflict;
    -- fall back to the live row's id below.
    insert into public.attachments
      (account_id, entity_type, entity_id, storage_path, content_hash,
       mime_type, size_bytes, uploaded_by)
    values
      (p_account_id, 'maintenance_requests', v_new_req, p_attachment_path,
       p_attachment_hash, p_attachment_mime, p_attachment_size, null)
    on conflict (account_id, entity_type, entity_id, content_hash)
      where deleted_at is null
      do nothing
    returning id into v_attachment_id;

    if v_attachment_id is null then
      select id into v_attachment_id
        from public.attachments
       where account_id  = p_account_id
         and entity_type = 'maintenance_requests'
         and entity_id   = v_new_req
         and content_hash = p_attachment_hash
         and deleted_at is null
       order by received_at, created_at, id
       limit 1;
    end if;

    if p_derivative_hash is not null then
      insert into public.attachments
        (account_id, entity_type, entity_id, storage_path, content_hash,
         mime_type, size_bytes, uploaded_by, derived_from)
      values
        (p_account_id, 'maintenance_requests', v_new_req, p_derivative_path,
         p_derivative_hash, p_derivative_mime, p_derivative_size, null,
         v_attachment_id)
      on conflict (account_id, entity_type, entity_id, content_hash)
        where deleted_at is null
        do nothing
      returning id into v_derivative_id;

      if v_derivative_id is null then
        select id into v_derivative_id
          from public.attachments
         where account_id  = p_account_id
           and entity_type = 'maintenance_requests'
           and entity_id   = v_new_req
           and content_hash = p_derivative_hash
           and deleted_at is null
         order by received_at, created_at, id
         limit 1;
      end if;
    end if;
  end if;

  maintenance_request_id := v_new_req;
  interaction_id         := v_interaction_id;
  attachment_id          := v_attachment_id;
  derivative_id          := v_derivative_id;
  deduped                := v_deduped;
  return next;
end;
$$;
