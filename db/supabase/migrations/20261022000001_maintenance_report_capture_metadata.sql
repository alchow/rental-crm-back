-- Capture facts describe the recorded source, not the truth of a tenant allegation.
-- Existing rows stay unknown. Historical bodies and timestamps are never rewritten.
do $$
declare prior_view text;
begin
  select pg_get_viewdef('public.interactions_with_chain'::regclass, true) into prior_view;
  alter table public.interactions add column capture_metadata jsonb;
  execute format('create or replace view public.interactions_with_chain with (security_invoker = true) as select previous.*, origin.capture_metadata from (%s) previous join public.interactions origin on origin.account_id = previous.account_id and origin.id = previous.id', rtrim(prior_view, E';\n '));
end;
$$;

alter table public.interactions add constraint interactions_capture_metadata_shape check (
  capture_metadata is null or coalesce((
    jsonb_typeof(capture_metadata) = 'object' and
    capture_metadata ?& array['method', 'time_basis', 'text_basis'] and
    capture_metadata->>'method' in ('manual', 'tenant_submission', 'provider', 'import', 'unknown') and
    capture_metadata->>'time_basis' in ('supplied', 'provider', 'recorded_default', 'unknown') and
    capture_metadata->>'text_basis' in ('summary', 'source_text', 'unknown')
  ), false)
);

-- Only new records are classified; no historical evidence is backfilled.
create function public._capture_known_source() returns trigger
language plpgsql set search_path = public as $$
begin
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
create trigger interactions_capture_metadata_source before insert on public.interactions
for each row execute function public._capture_known_source();
revoke all on function public._capture_known_source() from public, anon, authenticated, service_role;

create function public._reject_capture_metadata_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.capture_metadata is distinct from old.capture_metadata then
    raise exception 'interaction capture metadata is immutable' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger interactions_capture_metadata_immutable before update on public.interactions
for each row execute function public._reject_capture_metadata_change();
revoke all on function public._reject_capture_metadata_change() from public, anon, authenticated, service_role;

create or replace function public.journal_with_participants(
  p_account_id   uuid,
  p_entry        jsonb,
  p_participants jsonb
)
returns public.interactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_author_type text;
  v_interaction public.interactions%rowtype;
  v_count       int;
  r             record;
begin
  -- Self-defense: live member of the account.
  select m.role into v_role
    from public.account_members m
   where m.user_id = auth.uid()
     and m.account_id = p_account_id
     and m.deleted_at is null;
  if auth.uid() is null or v_role is null then
    raise exception 'not authorized to journal for this account'
      using errcode = '42501';
  end if;

  -- Agent principals are refused OUTRIGHT: an agent's communications are
  -- journaled (with their cast) by the verified comms paths, and an agent
  -- note carries no cast — so an agent calling this could only be
  -- fabricating an unverifiable record of who was contacted. (The capacity
  -- trigger would also reject the insert — external_ref is required on
  -- agent communications and this path never carries one — but the intent
  -- deserves its own explicit gate, not a fortunate trigger interaction.)
  if v_role = 'agent' then
    raise exception 'agent principals may not journal manual participants'
      using errcode = '42501';
  end if;

  -- Capacity from the principal, never from the caller's body.
  v_author_type := 'landlord';

  -- Only communications carry a cast (notes structurally have no party;
  -- agent_events are workflow exhaust).
  if coalesce(p_entry->>'kind', 'communication') <> 'communication' then
    raise exception 'participants are only recordable on communication entries'
      using errcode = '22023';
  end if;

  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then
    raise exception 'participants must be a json array'
      using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_participants);
  if v_count < 1 or v_count > 20 then
    raise exception 'participants must contain between 1 and 20 entries'
      using errcode = '22023';
  end if;

  insert into public.interactions (
    account_id, actor, author_type, kind, channel, direction,
    party_type, party_id, party_label, body, occurred_at, attestation,
    tenancy_id, maintenance_request_id, area_id, work_order_id, vendor_id, capture_metadata
  ) values (
    p_account_id,
    'user:' || auth.uid(),
    v_author_type,
    'communication',
    p_entry->>'channel',
    p_entry->>'direction',
    coalesce(p_entry->>'party_type', 'unspecified'),
    nullif(p_entry->>'party_id', '')::uuid,
    p_entry->>'party_label',
    p_entry->>'body',
    coalesce((p_entry->>'occurred_at')::timestamptz, now()),
    'attested',
    nullif(p_entry->>'tenancy_id', '')::uuid,
    nullif(p_entry->>'maintenance_request_id', '')::uuid,
    nullif(p_entry->>'area_id', '')::uuid,
    nullif(p_entry->>'work_order_id', '')::uuid,
    nullif(p_entry->>'vendor_id', '')::uuid,
    jsonb_build_object(
      'method', 'manual',
      'time_basis', case when p_entry ? 'report_time_supplied' then
        case when (p_entry->>'report_time_supplied')::boolean then 'supplied' else 'recorded_default' end
        when p_entry ? 'occurred_at' then 'supplied' else 'recorded_default' end,
      'text_basis', case when coalesce((p_entry->>'report_source_text')::boolean, false) then 'source_text' else 'summary' end
    )
  )
  returning * into v_interaction;

  for r in
    select e->>'role'                       as role,
           e->>'party_type'                 as party_type,
           nullif(e->>'party_id', '')::uuid as party_id,
           e->>'address'                    as address,
           e->>'label'                      as label
      from jsonb_array_elements(p_participants) e
  loop
    if r.role is null or r.role not in ('sender', 'recipient', 'cc', 'attendee') then
      raise exception 'invalid participant role: %', coalesce(r.role, '(null)')
        using errcode = '22023';
    end if;
    -- 'platform' is reserved for the verified comms paths: a manual entry
    -- has no wire leg to claim.
    if r.party_type is null or r.party_type not in
       ('tenant', 'landlord_user', 'vendor', 'agent', 'inspector', 'other', 'unknown') then
      raise exception 'invalid participant party_type: %', coalesce(r.party_type, '(null)')
        using errcode = '22023';
    end if;
    insert into public.interaction_participants
      (account_id, interaction_id, role, party_type, party_id, address, label, source)
    values
      (p_account_id, v_interaction.id, r.role, r.party_type, r.party_id,
       r.address, r.label, 'capture');
  end loop;

  return v_interaction;
end;
$$;


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
        'report_time_supplied', p_reported_at is not null,
        'report_source_text', p_report_body is not null,
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
         i.capture_metadata as reporter_capture_metadata
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
    ) sender on true;

revoke all on public.maintenance_requests_with_reporter
  from public, anon, authenticated, service_role;
grant select on public.maintenance_requests_with_reporter
  to authenticated, service_role;


notify pgrst, 'reload schema';
