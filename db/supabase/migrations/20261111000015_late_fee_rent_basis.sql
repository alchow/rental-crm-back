begin;

-- Late terms for rent charges (ADR-0013/0015 amendments):
-- 1. A percent late fee is a percent of the monthly rent in force for the charge's period
--    (its schedule's amount), not of the charge, so a partial month does not shrink it.
-- 2. A move-out replacement charge has no schedule of its own (charges_replacement_shape),
--    so it takes the schedule and terms of the charge it replaces: same grace, same fee.
create or replace function pg_temp.patched(p_body text, p_anchor text, p_replacement text, p_count integer default 1)
returns text language plpgsql as $$
declare found_count integer := (length(p_body) - length(replace(p_body, p_anchor, ''))) / length(p_anchor);
begin
  if found_count <> p_count then
    raise exception 'migration anchor matched % times, expected %: %', found_count, p_count, p_anchor;
  end if;
  return replace(p_body, p_anchor, p_replacement);
end;
$$;

-- _charge_late_terms plus monthly_rent_cents (null without a schedule).
create function public._rent_charge_terms(p_account_id uuid, p_schedule_id uuid, p_terms jsonb, p_replaces_charge_id uuid)
returns jsonb language sql stable set search_path = public as $$
  select public._charge_late_terms(p_account_id, coalesce(p_schedule_id, root.source_schedule_id),
      coalesce(p_terms, root.terms_snapshot))
    || jsonb_build_object('monthly_rent_cents', s.amount_cents)
  from (select 1) one
  left join public.charges root on p_schedule_id is null and root.account_id = p_account_id and root.id = p_replaces_charge_id
  left join public.rent_schedules s on s.account_id = p_account_id and s.id = coalesce(p_schedule_id, root.source_schedule_id)
$$;
revoke all on function public._rent_charge_terms(uuid,uuid,jsonb,uuid) from public, anon;
grant execute on function public._rent_charge_terms(uuid,uuid,jsonb,uuid) to authenticated, service_role;

do $migration$
declare body text;
begin
  body := pg_get_functiondef('public._owed_summaries_base(uuid,uuid)'::regprocedure);
  body := pg_temp.patched(body,
    $old$public._charge_late_terms(b.account_id, b.source_schedule_id, b.terms_snapshot)$old$,
    $new$public._rent_charge_terms(b.account_id, b.source_schedule_id, b.terms_snapshot, b.replaces_charge_id)$new$);
  execute body;

  body := pg_get_functiondef('public.late_fee_suggestions(uuid,uuid)'::regprocedure);
  body := pg_temp.patched(body,
    $old$public._charge_late_terms(c.account_id, c.source_schedule_id, c.terms_snapshot) as terms$old$,
    $new$public._rent_charge_terms(c.account_id, c.source_schedule_id, c.terms_snapshot, c.replaces_charge_id) as terms$new$);
  body := pg_temp.patched(body,
    $old$round(r.amount_cents * (r.terms->'late_fee_policy'->>'percent')::numeric / 100)$old$,
    $new$round(coalesce((r.terms->>'monthly_rent_cents')::bigint, r.amount_cents)
          * (r.terms->'late_fee_policy'->>'percent')::numeric / 100)$new$);
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
