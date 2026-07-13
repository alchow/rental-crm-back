-- Atomic, evidence-preserving tenancy ending.
--
-- Data flow:
--   caller JWT -> end_tenancy() -> immutable ending fact -> tenancy status/end
--              -> rent schedules stop in the same transaction -> audit events
--
-- A cancellation before move-in has two different dates:
--   * tenancy_endings.effective_date = when the cancellation took effect
--   * tenancies.end_date = start_date, to preserve the tenancy date invariant
-- Keeping those facts separate avoids falsifying the occupancy record merely to
-- satisfy `tenancies.end_date >= tenancies.start_date`.

create table public.tenancy_endings (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null,
  tenancy_id            uuid not null,
  kind                   text not null check (kind in ('ended', 'cancelled_before_move_in')),
  effective_date         date not null,
  initiated_by           text not null default 'unknown'
                         check (initiated_by in ('tenant', 'landlord', 'mutual', 'unknown')),
  reason_code            text not null default 'other',
  reason_note            text check (reason_note is null or length(reason_note) between 1 and 2000),
  source_notice_id       uuid,
  source_interaction_id  uuid,
  created_by             uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at             timestamptz not null default now(),
  foreign key (account_id, tenancy_id)
    references public.tenancies(account_id, id) on delete restrict,
  foreign key (account_id, source_notice_id)
    references public.notices(account_id, id) on delete restrict,
  foreign key (account_id, source_interaction_id)
    references public.interactions(account_id, id) on delete restrict,
  unique (account_id, id),
  unique (account_id, tenancy_id),
  check (
    (kind = 'ended' and reason_code in (
      'notice', 'abandonment', 'fixed_term_completed', 'mutual_surrender', 'other'
    ))
    or
    (kind = 'cancelled_before_move_in' and reason_code in (
      'applicant_withdrew', 'landlord_withdrew', 'other'
    ))
  )
);

create index tenancy_endings_account_created_idx
  on public.tenancy_endings (account_id, created_at, id);

alter table public.tenancy_endings enable row level security;
alter table public.tenancy_endings force row level security;

create policy tenancy_endings_member_select on public.tenancy_endings
  for select using (public.is_account_member(account_id));

-- INSERT is needed by the SECURITY INVOKER RPC so RLS stays the authorization
-- floor. The trigger below prevents a member from bypassing the workflow with a
-- direct PostgREST insert.
create policy tenancy_endings_member_insert on public.tenancy_endings
  for insert with check (public.is_account_member(account_id));

grant select, insert on public.tenancy_endings to authenticated;
revoke update, delete on public.tenancy_endings from anon, authenticated;

create or replace function public._guard_tenancy_ending_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('app.tenancy_end_workflow', true), '') <> '1' then
    raise exception 'tenancy endings must be created through end_tenancy()'
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

create trigger tenancy_endings_workflow_guard
  before insert on public.tenancy_endings
  for each row execute function public._guard_tenancy_ending_insert();

create or replace function public._reject_tenancy_ending_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'tenancy ending facts are immutable'
    using errcode = 'check_violation';
end;
$$;

create trigger tenancy_endings_immutable
  before update or delete on public.tenancy_endings
  for each row execute function public._reject_tenancy_ending_mutation();

create trigger tenancy_endings_audit
  after insert or update or delete on public.tenancy_endings
  for each row execute function public._emit_event();

-- Replace the old cascade, which could attempt end_date < start_date on a
-- future schedule and abort the whole tenancy update. New rules:
--
--   normal end:
--     schedule starts on/before end -> truncate to the end date
--     future schedule, no live charge -> soft-delete
--     future schedule with a live charge -> preserve for explicit correction
--
--   cancelled before move-in:
--     any schedule without a live charge -> soft-delete
--     schedule with a live charge -> preserve for explicit void/correction
--
-- In all cases the ended-tenancy predicate in generate_rent_charges prevents
-- future generation immediately, including for preserved rows.
create or replace function public._end_rent_schedules_on_tenancy_end()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end date;
  v_kind text;
begin
  if NEW.status = 'ended' and OLD.status is distinct from NEW.status then
    v_end := coalesce(NEW.end_date, current_date);

    select te.kind
      into v_kind
      from public.tenancy_endings te
     where te.account_id = NEW.account_id
       and te.tenancy_id = NEW.id;

    if v_kind = 'cancelled_before_move_in' then
      update public.rent_schedules s
         set deleted_at = now(),
             updated_at = now()
       where s.account_id = NEW.account_id
         and s.tenancy_id = NEW.id
         and s.deleted_at is null
         and not exists (
           select 1
             from public.charges ch
            where ch.account_id = s.account_id
              and ch.source_schedule_id = s.id
              and ch.voided_at is null
              and ch.deleted_at is null
         );
    else
      update public.rent_schedules s
         set end_date = v_end,
             updated_at = now()
       where s.account_id = NEW.account_id
         and s.tenancy_id = NEW.id
         and s.deleted_at is null
         and s.start_date <= v_end
         and (s.end_date is null or s.end_date > v_end);

      update public.rent_schedules s
         set deleted_at = now(),
             updated_at = now()
       where s.account_id = NEW.account_id
         and s.tenancy_id = NEW.id
         and s.deleted_at is null
         and s.start_date > v_end
         and not exists (
           select 1
             from public.charges ch
            where ch.account_id = s.account_id
              and ch.source_schedule_id = s.id
              and ch.voided_at is null
              and ch.deleted_at is null
         );
    end if;
  end if;

  return NEW;
end;
$$;

-- The trigger already exists; CREATE OR REPLACE above changes its behavior.

create or replace function public.end_tenancy(
  p_account_id           uuid,
  p_tenancy_id           uuid,
  p_kind                 text,
  p_effective_date       date,
  p_initiated_by         text default 'unknown',
  p_reason_code          text default 'other',
  p_reason_note          text default null,
  p_source_notice_id     uuid default null,
  p_source_interaction_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tenancy public.tenancies%rowtype;
  v_ending public.tenancy_endings%rowtype;
  v_tenancy_end date;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenancy_end:' || p_tenancy_id::text, 0));

  select *
    into v_tenancy
    from public.tenancies
   where account_id = p_account_id
     and id = p_tenancy_id
     and deleted_at is null
   for update;

  if v_tenancy.id is null then
    raise exception 'not_found: tenancy';
  end if;
  if v_tenancy.status = 'ended' then
    raise exception 'conflict: tenancy already ended';
  end if;
  if p_effective_date is null then
    raise exception 'invalid: effective_date is required';
  end if;
  if p_kind not in ('ended', 'cancelled_before_move_in') then
    raise exception 'invalid: kind must be ended or cancelled_before_move_in';
  end if;
  if p_initiated_by not in ('tenant', 'landlord', 'mutual', 'unknown') then
    raise exception 'invalid: initiated_by is not recognized';
  end if;

  if p_kind = 'cancelled_before_move_in' then
    if v_tenancy.status <> 'upcoming' then
      raise exception 'conflict: cancellation before move-in requires an upcoming tenancy';
    end if;
    if p_effective_date > v_tenancy.start_date then
      raise exception 'invalid: cancellation effective_date must be on or before start_date';
    end if;
    if p_reason_code not in ('applicant_withdrew', 'landlord_withdrew', 'other') then
      raise exception 'invalid: reason_code is not valid for cancelled_before_move_in';
    end if;
    v_tenancy_end := v_tenancy.start_date;
  else
    if v_tenancy.status not in ('active', 'holdover') then
      raise exception 'conflict: ending requires an active or holdover tenancy';
    end if;
    if p_effective_date < v_tenancy.start_date then
      raise exception 'invalid: ending effective_date cannot be before start_date';
    end if;
    if p_reason_code not in (
      'notice', 'abandonment', 'fixed_term_completed', 'mutual_surrender', 'other'
    ) then
      raise exception 'invalid: reason_code is not valid for ended';
    end if;
    v_tenancy_end := p_effective_date;
  end if;

  if p_source_notice_id is not null and not exists (
    select 1
      from public.notices n
     where n.account_id = p_account_id
       and n.id = p_source_notice_id
       and n.tenancy_id = p_tenancy_id
       and n.deleted_at is null
  ) then
    raise exception 'not_found: source notice';
  end if;

  if p_source_interaction_id is not null and not exists (
    select 1
      from public.interactions i
     where i.account_id = p_account_id
       and i.id = p_source_interaction_id
       and i.tenancy_id = p_tenancy_id
       and i.deleted_at is null
  ) then
    raise exception 'not_found: source interaction';
  end if;

  perform set_config('app.tenancy_end_workflow', '1', true);

  insert into public.tenancy_endings (
    account_id, tenancy_id, kind, effective_date, initiated_by, reason_code,
    reason_note, source_notice_id, source_interaction_id
  ) values (
    p_account_id, p_tenancy_id, p_kind, p_effective_date, p_initiated_by,
    p_reason_code, p_reason_note, p_source_notice_id, p_source_interaction_id
  )
  returning * into v_ending;

  -- Insert the ending first. The tenancy update trigger can then distinguish a
  -- cancellation from a normal end while stopping schedules atomically.
  update public.tenancies
     set status = 'ended',
         end_date = v_tenancy_end,
         updated_at = now()
   where account_id = p_account_id
     and id = p_tenancy_id
  returning * into v_tenancy;

  return jsonb_build_object(
    'tenancy', to_jsonb(v_tenancy),
    'ending', to_jsonb(v_ending)
  );
exception
  when unique_violation then
    raise exception 'conflict: tenancy already has an ending record';
end;
$$;

revoke all on function public.end_tenancy(uuid, uuid, text, date, text, text, text, uuid, uuid)
  from public, anon;
grant execute on function public.end_tenancy(uuid, uuid, text, date, text, text, text, uuid, uuid)
  to authenticated;

notify pgrst, 'reload schema';
