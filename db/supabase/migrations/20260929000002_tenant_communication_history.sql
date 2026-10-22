-- Person scope follows the immutable journal cast, never today's thread membership.
create or replace function public.tenant_communication_records(
  p_account_id uuid, p_tenant_id uuid, p_snapshot timestamptz,
  p_captured_only boolean default true
) returns setof public.interactions_with_chain
language sql stable security invoker set search_path = public
as $$
  with recursive selected(id) as (
    select i.id from public.interactions i
    where i.account_id = p_account_id and i.corrects_id is null
      and not exists (select 1 from public.comm_outbox o where o.account_id = i.account_id
        and o.interaction_id = i.id and o.relay_of_interaction_id is not null)
      and i.created_at <= p_snapshot
      and (not p_captured_only or (i.thread_id is not null and i.channel in ('sms', 'email') and i.kind = 'communication'))
      and (i.party_type = 'tenant' and i.party_id = p_tenant_id
        or exists (select 1 from public.interaction_participants p
          where p.account_id = i.account_id and p.interaction_id = i.id
            and p.party_type = 'tenant' and p.party_id = p_tenant_id))
    union
    select i.id from public.interactions i join selected s on i.corrects_id = s.id
    where i.account_id = p_account_id and i.created_at <= p_snapshot
  )
  select v.* from public.interactions_with_chain v join selected s on s.id = v.id
  where v.account_id = p_account_id;
$$;
revoke all on function public.tenant_communication_records(uuid, uuid, timestamptz, boolean) from public, anon;
grant execute on function public.tenant_communication_records(uuid, uuid, timestamptz, boolean) to authenticated, service_role;

alter table public.evidence_exports
  add column tenant_id uuid,
  add column timezone text not null default 'UTC',
  add constraint evidence_exports_tenant_account_fkey foreign key (account_id, tenant_id)
    references public.tenants(account_id, id);
alter table public.evidence_exports drop constraint evidence_exports_check1;
alter table public.evidence_exports add constraint evidence_exports_scope_check
  check (tenancy_id is not null or area_id is not null or tenant_id is not null);
