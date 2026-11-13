begin;

-- Owner decision 2026-11-12 (ADR-0012 amendment): a future-month rent change may rest
-- on the landlord's own statement. It is recorded as basis_kind 'landlord_statement',
-- never presented as an instrument, and preview warns that the landlord must document
-- the change to the tenant (rent_change_undocumented, acknowledged like other warnings).
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

-- PROVENANCE: what a schedule step rests on. lease and notice mirror the instrument
-- columns; landlord_statement has no instrument and keeps the landlord's note.
alter table public.rent_schedules
  add column basis_kind text check (basis_kind in ('lease', 'notice', 'landlord_statement')),
  add column basis_note text check (basis_note is null or length(btrim(basis_note)) between 1 and 2000),
  add constraint rent_schedules_landlord_statement_basis check (
    basis_kind is distinct from 'landlord_statement' or (source_lease_id is null and source_notice_id is null));

do $migration$
declare body text; lease_count integer; notice_count integer;
begin
  update public.rent_schedules set basis_kind = case when source_lease_id is not null then 'lease' else 'notice' end
    where basis_kind is null and (source_lease_id is not null or source_notice_id is not null);
  select count(*) filter (where basis_kind = 'lease'), count(*) filter (where basis_kind = 'notice')
    into lease_count, notice_count from public.rent_schedules;
  raise notice 'rent schedules: % rest on a lease, % on a notice', lease_count, notice_count;

  body := pg_get_functiondef('public.preview_billing_setup_facts(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  body := pg_temp.patched(body,
    'if v_transition and r->>''source_lease_id'' is null and r->>''source_notice_id'' is null then raise exception',
    'if v_transition and r->>''source_lease_id'' is null and r->>''source_notice_id'' is null
      and coalesce(r->''basis''->>''kind'','''') <> ''landlord_statement'' then raise exception');
  body := pg_temp.patched(body,
    '''opening_balance'',''charge_keys'',''follows_lease''] <> ''{}''',
    '''opening_balance'',''charge_keys'',''follows_lease'',''basis''] <> ''{}''');
  body := pg_temp.patched(body,
    '    v_start := (r->>''coverage_start'')::date;v_end := (r->>''coverage_end'')::date;',
    $patch$    v_start := (r->>'coverage_start')::date;v_end := (r->>'coverage_end')::date;
    if r ? 'basis' then
      if jsonb_typeof(r->'basis') <> 'object' or (r->'basis') - array['kind','note'] <> '{}'
        or r->'basis'->>'kind' is distinct from 'landlord_statement'
        or (r->'basis' ? 'note' and (jsonb_typeof(r->'basis'->'note') <> 'string'
          or length(btrim(r->'basis'->>'note')) not between 1 and 2000))
        or r->>'source_lease_id' is not null or r->>'source_notice_id' is not null or not v_transition then
        raise exception 'invalid: a landlord-statement rent change is a transition with no lease or notice';
      end if;
      if date_trunc('month', v_start) <= date_trunc('month', public._account_date(p_account_id)) then
        raise exception 'invalid: a rent change on the landlord''s statement starts in a future month';
      end if;
      v_findings := v_findings || jsonb_build_array(jsonb_build_object('rule_id','rent_change_undocumented',
        'severity','review','reason_required',false,'fields',jsonb_build_array('rent.basis'),
        'values',jsonb_build_object('effective_date',v_start,'amount_cents',(r->>'amount_cents')::bigint),
        'message','This rent change has no lease or served notice behind it. Document it to the tenant in writing before it takes effect.'));
    end if;$patch$);
  body := pg_temp.patched(body,
    'or f->>''rule_id'' in (''billing_outside_agreement'',''billing_outside_possession'',''billing_terms_differ'') then',
    'or f->>''rule_id'' in (''billing_outside_agreement'',''billing_outside_possession'',''billing_terms_differ'',''rent_change_undocumented'') then');
  -- INVARIANT: this change only adds a future step; it never voids rent a payment covers.
  body := pg_temp.patched(body,
    '      select coalesce(array_agg(id),''{}'') into v_voided from affected;',
    $patch$      select coalesce(array_agg(id),'{}') into v_voided from affected;
      if r->'basis'->>'kind' = 'landlord_statement' and exists (select 1 from public.payment_allocations a
          join public.payments p on p.account_id = a.account_id and p.id = a.payment_id
        where a.account_id = p_account_id and a.charge_id = any(v_voided) and a.voided_at is null and a.deleted_at is null
          and p.voided_at is null and p.deleted_at is null) then
        raise exception 'conflict: a payment is applied to rent this change would replace; review that rent first';
      end if;$patch$);
  execute body;

  body := pg_get_functiondef('public.commit_billing_setup(uuid,uuid,jsonb,text,text)'::regprocedure);
  body := pg_temp.patched(body, 'regular_anchor,terms_snapshot,manual_basis,billing_due_rule,short_month_policy,follows_lease)',
    'regular_anchor,terms_snapshot,manual_basis,billing_due_rule,short_month_policy,follows_lease,basis_kind,basis_note)');
  body := pg_temp.patched(body, ',(r->>''follows_lease'')::boolean) returning id into v_schedule_id',
    $patch$,(r->>'follows_lease')::boolean,
      case when r->'basis'->>'kind' = 'landlord_statement' then 'landlord_statement'
        when r->>'source_lease_id' is not null then 'lease' when r->>'source_notice_id' is not null then 'notice' end,
      r->'basis'->>'note') returning id into v_schedule_id$patch$);
  execute body;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
