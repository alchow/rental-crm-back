-- Reporter provenance is derived from the journal, not copied onto the mutable
-- maintenance request. The first inbound root interaction is the report fact;
-- its immutable participant cast is the reporter snapshot.

create or replace view public.maintenance_requests_with_reporter
  with (security_invoker = true) as
  select mr.*,
         report.interaction_id as reporter_interaction_id,
         coalesce(sender.party_type, report.party_type) as reporter_party_type,
         coalesce(sender.party_id, report.party_id) as reporter_party_id,
         coalesce(sender.label, report.party_label) as reporter_label,
         sender.address as reporter_address,
         report.channel as reporter_channel,
         report.occurred_at as reported_at,
         report.attestation as reporter_attestation
    from public.maintenance_requests mr
    left join lateral (
      select i.id as interaction_id,
             i.party_type,
             i.party_id,
             i.party_label,
             i.channel,
             i.occurred_at,
             i.attestation
        from public.interactions i
       where i.account_id = mr.account_id
         and i.maintenance_request_id = mr.id
         and i.kind = 'communication'
         and i.direction = 'inbound'
         and i.corrects_id is null
         and i.deleted_at is null
       -- `occurred_at` is the reporter's claimed event time and can be
       -- backfilled. `logged_at` is immutable server time, so the first
       -- captured source cannot be displaced by a later backdated entry.
       order by i.logged_at asc, i.id asc
       limit 1
    ) report on true
    left join lateral (
      select ip.party_type, ip.party_id, ip.label, ip.address
        from public.interaction_participants ip
       where ip.account_id = mr.account_id
         and ip.interaction_id = report.interaction_id
         and ip.role = 'sender'
       order by ip.created_at asc, ip.id asc
       limit 1
    ) sender on true;

grant select on public.maintenance_requests_with_reporter to authenticated, service_role;

-- Landlord capture path. One Postgres transaction creates the operational
-- request and the evidentiary report interaction + participant cast.
create or replace function public.create_maintenance_request_with_report(
  p_account_id         uuid,
  p_area_id            uuid,
  p_asset_id           uuid,
  p_title              text,
  p_description        text,
  p_severity           text,
  p_report_party_type  text,
  p_report_party_id    uuid,
  p_report_label       text,
  p_report_address     text,
  p_report_channel     text,
  p_reported_at        timestamptz,
  p_report_body        text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_request public.maintenance_requests%rowtype;
  v_interaction public.interactions%rowtype;
  v_headline_party_type text;
begin
  if p_report_party_type not in (
    'tenant', 'landlord_user', 'vendor', 'agent', 'inspector', 'other', 'unknown'
  ) then
    raise exception 'invalid: reporter party_type is not recognized';
  end if;
  if p_report_party_id is null and nullif(p_report_label, '') is null
     and nullif(p_report_address, '') is null then
    raise exception 'invalid: reporter needs party_id, label, or address';
  end if;
  if p_report_channel not in ('in_person', 'phone', 'voicemail', 'sms', 'email', 'letter', 'in_app') then
    raise exception 'invalid: report channel is not recognized';
  end if;

  insert into public.maintenance_requests (
    account_id, area_id, asset_id, opened_by, title, description, severity, status
  ) values (
    p_account_id, p_area_id, p_asset_id, auth.uid(), p_title, p_description, p_severity, 'open'
  )
  returning * into v_request;

  -- The legacy row slot has a narrower vocabulary than the participant cast.
  -- Keep the exact reporter type in the cast and use `other` only as the
  -- backward-compatible headline for landlord_user/agent/unknown.
  v_headline_party_type := case
    when p_report_party_type in ('tenant', 'vendor', 'inspector', 'other')
      then p_report_party_type
    else 'other'
  end;

  select *
    into v_interaction
    from public.journal_with_participants(
      p_account_id,
      jsonb_build_object(
        'channel', p_report_channel,
        'direction', 'inbound',
        'party_type', v_headline_party_type,
        'party_id', p_report_party_id,
        'party_label', p_report_label,
        'body', coalesce(p_report_body, p_description, p_title),
        'occurred_at', coalesce(p_reported_at, now()),
        'maintenance_request_id', v_request.id,
        'area_id', p_area_id
      ),
      jsonb_build_array(jsonb_build_object(
        'role', 'sender',
        'party_type', p_report_party_type,
        'party_id', p_report_party_id,
        'address', p_report_address,
        'label', p_report_label
      ))
    );

  return jsonb_build_object(
    'maintenance_request_id', v_request.id,
    'interaction_id', v_interaction.id
  );
exception
  when foreign_key_violation then
    raise exception 'not_found: area_id or asset_id does not belong to this account';
end;
$$;

revoke all on function public.create_maintenance_request_with_report(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, text, timestamptz, text
) from public, anon;
grant execute on function public.create_maintenance_request_with_report(
  uuid, uuid, uuid, text, text, text, text, uuid, text, text, text, timestamptz, text
) to authenticated;

notify pgrst, 'reload schema';
