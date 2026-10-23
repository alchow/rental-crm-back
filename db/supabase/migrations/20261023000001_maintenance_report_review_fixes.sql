-- Capture claims are assigned by trusted writers, never by a direct caller insert.
create or replace function public._capture_known_source() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.capture_metadata is not null then
      raise exception 'capture metadata requires a trusted write path' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.capture_metadata is not null or new.corrects_id is not null then return new; end if;
  if new.attestation = 'provider_verified' then
    new.capture_metadata := jsonb_build_object('method', 'provider', 'time_basis', 'unknown', 'text_basis', 'source_text');
  elsif new.author_type = 'tenant' and new.actor like 'tenant:%' then
    new.capture_metadata := jsonb_build_object('method', 'tenant_submission', 'time_basis', 'unknown', 'text_basis', 'source_text');
  elsif new.attestation = 'imported' then
    new.capture_metadata := jsonb_build_object('method', 'import', 'time_basis', 'unknown', 'text_basis', 'unknown');
  end if;
  return new;
end;
$$;

create or replace view public.maintenance_requests_with_reporter
  with (security_invoker = true) as
  select mr.*,
         report.interaction_id as reporter_interaction_id,
         coalesce(sender.party_type, i.party_type) as reporter_party_type,
         coalesce(sender.party_id, i.party_id) as reporter_party_id,
         coalesce(sender.label, i.party_label) as reporter_label,
         sender.address as reporter_address,
         i.channel as reporter_channel,
         i.occurred_at as reported_at,
         i.attestation as reporter_attestation,
         i.logged_at as reporter_logged_at,
         i.capture_metadata as reporter_capture_metadata,
         coalesce(current_report.correction_kind = 'retract', false) as reporter_withdrawn
    from public.maintenance_requests mr
    left join public.maintenance_request_reports report
      on report.account_id = mr.account_id
     and report.maintenance_request_id = mr.id
    left join public.interactions i
      on i.account_id = report.account_id
     and i.id = report.interaction_id
    left join lateral (
      select ip.party_type, ip.party_id, ip.label, ip.address
        from public.interaction_participants ip
       where ip.account_id = report.account_id
         and ip.interaction_id = report.interaction_id
         and ip.role = 'sender'
       order by ip.created_at asc, ip.id asc
       limit 1
    ) sender on true
    left join lateral (
      with recursive revisions as (
        select original.id, original.correction_kind
          from public.interactions original
         where original.account_id = report.account_id and original.id = report.interaction_id
        union all
        select child.id, child.correction_kind
          from public.interactions child
          join revisions parent on child.corrects_id = parent.id
         where child.account_id = report.account_id
      )
      select revision.correction_kind from revisions revision
       where not exists (
         select 1 from public.interactions child
          where child.account_id = report.account_id and child.corrects_id = revision.id
       )
    ) current_report on true;


-- Caller JWT/RLS remains the authorization floor for both records and receipts.
create function public.create_maintenance_request_idempotent(
  p_account_id uuid, p_idempotency_key text, p_request_fingerprint text, p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  receipt record;
  request_id uuid;
  report jsonb := p_payload->'report';
  row_data jsonb;
  result jsonb;
begin
  select * into receipt from public.idempotency_keys
   where account_id = p_account_id and key = p_idempotency_key for update;
  if not found then raise exception 'idempotency_key_not_claimed' using errcode = 'P0002'; end if;
  if receipt.request_fingerprint is distinct from p_request_fingerprint then
    raise exception 'idempotency_fingerprint_mismatch' using errcode = '23514';
  end if;
  if receipt.completed_at is not null then return receipt.body; end if;

  if report is not null and report <> 'null'::jsonb then
    select (public.create_maintenance_request_with_report(
      p_account_id, (p_payload->>'area_id')::uuid, (p_payload->>'asset_id')::uuid,
      p_payload->>'title', p_payload->>'description', p_payload->>'severity',
      report->>'party_type', (report->>'party_id')::uuid, report->>'label',
      report->>'address', report->>'channel', (report->>'reported_at')::timestamptz,
      report->>'body'
    )->>'maintenance_request_id')::uuid into request_id;
  else
    insert into public.maintenance_requests(account_id, area_id, asset_id, opened_by, title, description, severity, status)
    values (p_account_id, (p_payload->>'area_id')::uuid, (p_payload->>'asset_id')::uuid,
      auth.uid(), p_payload->>'title', p_payload->>'description', p_payload->>'severity', 'open')
    returning id into request_id;
  end if;

  select to_jsonb(mr) into row_data from public.maintenance_requests_with_reporter mr
   where account_id = p_account_id and id = request_id;
  if row_data is null then raise exception 'created request is not readable'; end if;
  result := (row_data - array['reporter_interaction_id', 'reporter_party_type', 'reporter_party_id',
    'reporter_label', 'reporter_address', 'reporter_channel', 'reported_at', 'reporter_attestation',
    'reporter_logged_at', 'reporter_capture_metadata', 'reporter_withdrawn']) || jsonb_build_object(
    'reported_by', case when row_data->>'reporter_interaction_id' is null then null else jsonb_build_object(
      'source', 'interaction', 'interaction_id', row_data->'reporter_interaction_id',
      'party_type', row_data->'reporter_party_type', 'party_id', row_data->'reporter_party_id',
      'label', row_data->'reporter_label', 'address', row_data->'reporter_address',
      'channel', row_data->'reporter_channel', 'reported_at', row_data->'reported_at',
      'attestation', row_data->'reporter_attestation', 'logged_at', row_data->'reporter_logged_at',
      'capture_metadata', row_data->'reporter_capture_metadata', 'withdrawn', row_data->'reporter_withdrawn'
    ) end);
  update public.idempotency_keys set status_code = 201, body = result, completed_at = now()
   where account_id = p_account_id and key = p_idempotency_key
     and request_fingerprint = p_request_fingerprint and completed_at is null;
  if not found then raise exception 'idempotency_completion_lost' using errcode = '23514'; end if;
  return result;
end;
$$;
revoke all on function public.create_maintenance_request_idempotent(uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_maintenance_request_idempotent(uuid, text, text, jsonb) to authenticated;
notify pgrst, 'reload schema';
