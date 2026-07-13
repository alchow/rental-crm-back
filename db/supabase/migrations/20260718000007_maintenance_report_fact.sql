-- Immutable maintenance-report provenance.
--
-- A generic inbound interaction is not necessarily the report that opened a
-- maintenance request. The report link is therefore captured only when BOTH
-- rows are born in the same transaction:
--
--   request INSERT -> inbound root interaction INSERT -> immutable link INSERT
--
-- This covers the landlord RPC and both service-role tenant-intake RPCs. It
-- deliberately does not backfill legacy requests or attach later follow-ups.

create table public.maintenance_request_reports (
  id                     uuid primary key default gen_random_uuid(),
  account_id             uuid not null,
  maintenance_request_id uuid not null,
  interaction_id         uuid not null,
  created_at             timestamptz not null default now(),
  foreign key (account_id, maintenance_request_id)
    references public.maintenance_requests(account_id, id) on delete restrict,
  foreign key (account_id, interaction_id)
    references public.interactions(account_id, id) on delete restrict,
  unique (account_id, id),
  unique (account_id, maintenance_request_id),
  unique (account_id, interaction_id)
);

create index maintenance_request_reports_account_created_idx
  on public.maintenance_request_reports (account_id, created_at, id);

alter table public.maintenance_request_reports enable row level security;
alter table public.maintenance_request_reports force row level security;

create policy maintenance_request_reports_member_select
  on public.maintenance_request_reports
  for select
  using (account_id in (
    select m.account_id
      from public.account_members m
     where m.user_id = (select auth.uid())
       and m.deleted_at is null
  ));

-- The nested trigger below owns the only normal write path. In particular,
-- service_role is not left with a direct INSERT grant that could manufacture
-- provenance independently of the request + interaction transaction.
revoke all on public.maintenance_request_reports
  from public, anon, authenticated, service_role;
grant select on public.maintenance_request_reports
  to authenticated, service_role;

create or replace function public._reject_maintenance_request_report_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'maintenance report facts are immutable'
    using errcode = 'check_violation';
end;
$$;

create trigger maintenance_request_reports_immutable
  before update or delete on public.maintenance_request_reports
  for each row execute function public._reject_maintenance_request_report_mutation();

create trigger maintenance_request_reports_audit
  after insert or update or delete on public.maintenance_request_reports
  for each row execute function public._emit_event();

create or replace function public._capture_maintenance_request_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_xmin xid;
  v_interaction_xmin xid;
begin
  if NEW.maintenance_request_id is null
     or NEW.kind <> 'communication'
     or NEW.direction <> 'inbound'
     or NEW.corrects_id is not null
     or NEW.deleted_at is not null then
    return NEW;
  end if;

  select mr.xmin
    into v_request_xmin
    from public.maintenance_requests mr
   where mr.account_id = NEW.account_id
     and mr.id = NEW.maintenance_request_id;

  if not found then
    return NEW;
  end if;

  select i.xmin
    into v_interaction_xmin
    from public.interactions i
   where i.account_id = NEW.account_id
     and i.id = NEW.id;

  -- xmin is the transaction (or PL/pgSQL exception-block subtransaction) that
  -- inserted each row. Comparing the two rows, rather than comparing either
  -- one with pg_current_xact_id(), also covers the landlord RPC: its exception
  -- handler runs the request + journal writes in one shared subtransaction.
  -- A later follow-up necessarily carries a different xmin.
  if not found or v_request_xmin is distinct from v_interaction_xmin then
    return NEW;
  end if;

  insert into public.maintenance_request_reports (
    account_id, maintenance_request_id, interaction_id
  ) values (
    NEW.account_id, NEW.maintenance_request_id, NEW.id
  )
  on conflict (account_id, maintenance_request_id) do nothing;

  return NEW;
end;
$$;

create trigger interactions_capture_maintenance_request_report
  after insert on public.interactions
  for each row execute function public._capture_maintenance_request_report();

-- Trigger functions are not application RPCs. Remove Supabase's default
-- EXECUTE grants explicitly; PostgreSQL trigger invocation does not need them.
revoke all on function public._capture_maintenance_request_report()
  from public, anon, authenticated, service_role;
revoke all on function public._reject_maintenance_request_report_mutation()
  from public, anon, authenticated, service_role;

-- Reporter reads now follow the immutable link. Do not filter the linked
-- interaction on deleted_at: a soft deletion is an audited lifecycle event,
-- not permission to rewrite who originally reported the request.
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
         i.attestation as reporter_attestation
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
