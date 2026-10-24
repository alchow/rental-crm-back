create function public._billing_period_needs_history_review(p_period jsonb,p_as_of date)
returns boolean language sql immutable set search_path = public as $$
  select coalesce((p_period->>'period_start')::date <= p_as_of
    or (p_period->>'due_date')::date <= p_as_of,false)
$$;
revoke all on function public._billing_period_needs_history_review(jsonb,date) from public,anon;
grant execute on function public._billing_period_needs_history_review(jsonb,date)
  to authenticated,service_role,tenancy_date_writer;

create function public.preview_billing_setup(p_account_id uuid,p_tenancy_id uuid,p_intent jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare t public.tenancies;l public.leases;r jsonb := p_intent->'rent';d jsonb := p_intent->'deposit';
  v_schedules jsonb;v_charges jsonb;v_payments jsonb;v_allocations jsonb;v_adoptions jsonb;
  v_today date := (now() at time zone 'UTC')::date;v_mode text;v_existing_rent boolean;v_existing_money boolean;
  v_findings jsonb := '[]';v_candidates jsonb := '[]';v_history jsonb := '[]';v_period jsonb;
  v_snapshot jsonb;v_enabled boolean;v_context jsonb;v_hash text;v_start date;v_month date;v_end date;
  v_elem jsonb;v_key jsonb;v_rule text;v_next jsonb;v_count integer := 0;v_seen text[] := '{}';v_amount bigint;
  v_alloc jsonb;v_target jsonb;v_payment jsonb;v_charge_totals jsonb := '{}';v_payment_totals jsonb := '{}';
  v_available bigint;v_total bigint;v_id text;v_currency text;v_relationship jsonb;v_shared_findings jsonb;
  v_transition boolean := coalesce(p_intent->>'operation','initial') = 'transition';v_notice jsonb;
  v_ended uuid[] := '{}';v_voided uuid[] := '{}';v_schedule public.rent_schedules;v_review boolean;
begin
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then raise exception 'not_found' using errcode='P0002'; end if;
  select * into t from public.tenancies where account_id = p_account_id and id = p_tenancy_id and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if jsonb_typeof(p_intent) is distinct from 'object' or p_intent - array['rent','deposit','payments','credit_allocations','explanations','expected_context','operation'] <> '{}'
    or jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(d) is distinct from 'object'
    or coalesce(r->>'decision','') not in ('configure','defer','keep') or coalesce(d->>'decision','') not in ('record','defer','keep')
  then raise exception 'invalid: invalid billing setup intent'; end if;
  if coalesce(p_intent->>'operation','initial') not in ('initial','transition') or (v_transition and r->>'decision' <> 'configure')
  then raise exception 'invalid: a billing transition requires a complete successor instruction'; end if;
  if jsonb_typeof(coalesce(p_intent->'payments','[]')) <> 'array'
    or jsonb_typeof(coalesce(p_intent->'credit_allocations','[]')) <> 'array'
    or jsonb_typeof(coalesce(p_intent->'explanations','[]')) <> 'array'
    or jsonb_array_length(coalesce(p_intent->'payments','[]')) > 200
    or jsonb_array_length(coalesce(p_intent->'credit_allocations','[]')) > 200
  then raise exception 'invalid: invalid receipt/allocation arrays'; end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]') into v_schedules from public.rent_schedules s
    where account_id = p_account_id and tenancy_id = t.id;
  select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('balance_cents',c.amount_cents-coalesce((
    select sum(a.amount_cents) from public.payment_allocations a join public.payments p on p.id = a.payment_id
    where a.charge_id = c.id and a.voided_at is null and a.deleted_at is null and p.voided_at is null and p.deleted_at is null),0)) order by c.id),'[]')
    into v_charges from public.charges c where account_id = p_account_id and tenancy_id = t.id;
  select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('available_cents',p.amount_cents-coalesce((
    select sum(a.amount_cents) from public.payment_allocations a join public.charges c on c.id = a.charge_id
    where a.payment_id = p.id and a.voided_at is null and a.deleted_at is null and c.voided_at is null and c.deleted_at is null),0)) order by p.id),'[]')
    into v_payments from public.payments p where account_id = p_account_id and tenancy_id = t.id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') into v_allocations from public.payment_allocations a
    join public.payments p on p.id = a.payment_id where a.account_id = p_account_id and p.tenancy_id = t.id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') into v_adoptions from public.tenancy_adoptions a
    where account_id = p_account_id and tenancy_id = t.id;
  v_existing_rent := jsonb_array_length(v_schedules) > 0 or jsonb_array_length(v_adoptions) > 0
    or exists(select 1 from jsonb_array_elements(v_charges) c where c->>'type' = 'rent');
  v_existing_money := jsonb_array_length(v_charges) > 0 or jsonb_array_length(v_payments) > 0;
  v_mode := case when v_existing_rent then 'existing_rent' when r->>'decision' = 'configure'
    then case when v_existing_money then 'initial_rent_existing_money' else 'initial' end
    when d->>'decision' = 'record' or jsonb_array_length(coalesce(p_intent->'payments','[]')) > 0 then 'deposit_only' else 'deferred' end;
  select auto_charge_enabled into v_enabled from public.accounts where id = p_account_id and deleted_at is null;
  if r->>'decision' = 'configure' then
    if v_existing_rent and not v_transition then raise exception 'conflict: existing rent history requires an explicit transition or ordinary correction'; end if;
    if v_transition and not v_existing_rent then raise exception 'invalid: initial billing setup is required when no rent history exists'; end if;
    if v_transition and r->>'source_lease_id' is null and r->>'source_notice_id' is null then raise exception 'invalid: a successor needs a confirmed agreement or served notice'; end if;
    if t.status = 'ended' then raise exception 'conflict: recurring setup cannot reopen an ended tenancy'; end if;
    if r - array['decision','source_lease_id','source_notice_id','coverage_start','coverage_end','regular_anchor','due_day','amount_cents','currency',
      'grace_days','late_fee_policy','manual_basis','period_overrides','history_mode','opening_balance','charge_keys'] <> '{}'
      or (r->>'amount_cents')::bigint < 0 or (r->>'amount_cents') is null or length(coalesce(r->>'currency','')) <> 3
      or (r->>'due_day')::integer not between 1 and 28 or r->>'due_day' is null
      or r->>'coverage_start' is null or r->>'regular_anchor' is null
      or coalesce(r->>'history_mode','itemized') not in ('itemized','opening_balance')
      or jsonb_typeof(coalesce(r->'period_overrides','[]')) <> 'array' or jsonb_typeof(coalesce(r->'charge_keys','[]')) <> 'array'
      or jsonb_array_length(coalesce(r->'period_overrides','[]')) > 120 or jsonb_array_length(coalesce(r->'charge_keys','[]')) > 120
      or ((r->>'grace_days')::integer is not null and (r->>'grace_days')::integer not between 0 and 30)
      or not public._valid_recorded_term(coalesce(r->'late_fee_policy','{"kind":"unknown"}'),false)
    then raise exception 'invalid: incomplete or unsupported recurring instruction'; end if;
    v_start := (r->>'coverage_start')::date;v_end := (r->>'coverage_end')::date;
    if v_end < v_start or (r->>'regular_anchor')::date < v_start
      or (r->>'regular_anchor')::date >= (v_start+interval '1 month')::date
      or extract(day from (r->>'regular_anchor')::date) > 28
    then raise exception 'invalid: invalid coverage interval or regular anchor'; end if;
    if r->>'source_lease_id' is not null then
      select * into l from public.leases where account_id = p_account_id and tenancy_id = t.id
        and id = (r->>'source_lease_id')::uuid and deleted_at is null and voided_at is null;
      if not found then raise exception 'invalid: selected lease is outside this tenancy'; end if;
      if l.status = 'draft' then raise exception 'invalid: confirm the agreement before using it as billing basis'; end if;
      if l.rent_due_rule->>'kind' not in ('unknown','day_of_month') or (l.rent_due_rule->>'day')::integer > 28
      then raise exception 'invalid: selected agreement due rule requires manual billing'; end if;
      if v_start < l.term_start or (v_end is null and l.term_end is not null) or v_end > l.term_end then
        v_findings := v_findings||jsonb_build_array(jsonb_build_object('rule_id','billing_outside_agreement','severity','review',
          'message','Billing coverage differs from the selected agreement interval.','reason_required',true));
      end if;
      if l.rent_amount_cents <> (r->>'amount_cents')::bigint or l.rent_currency <> r->>'currency'
        or (l.rent_due_rule->>'kind' = 'day_of_month' and (l.rent_due_rule->>'day')::integer <> (r->>'due_day')::integer)
        or l.grace_days is distinct from (r->>'grace_days')::integer
        or l.late_fee_policy is distinct from coalesce(r->'late_fee_policy','{"kind":"unknown"}')
      then v_findings := v_findings||jsonb_build_array(jsonb_build_object('rule_id','billing_terms_differ','severity','review',
        'message','Confirmed billing instructions differ from the selected agreed terms.','reason_required',true)); end if;
    elsif r->>'source_notice_id' is null and length(btrim(coalesce(r->>'manual_basis',''))) not between 1 and 2000 then raise exception 'invalid: manual billing requires a recorded basis'; end if;
    if r->>'source_notice_id' is not null then
      select to_jsonb(n) into v_notice from public.notices n where n.account_id = p_account_id and n.tenancy_id = t.id
        and n.id = (r->>'source_notice_id')::uuid and n.deleted_at is null and n.served_at is not null;
      if not found then raise exception 'invalid: notice must be served and belong to the same tenancy'; end if;
    end if;
    if v_transition then
      for v_schedule in select * from public.rent_schedules s where s.account_id = p_account_id and s.tenancy_id = t.id
        and s.kind = 'rent' and s.deleted_at is null and (s.end_date is null or s.end_date >= v_start) order by s.start_date,s.id loop
        if v_schedule.start_date >= v_start then raise exception 'conflict: a planned successor already occupies this billing boundary'; end if;
        v_ended := array_append(v_ended,v_schedule.id);
        if extract(day from v_start)::integer <> (case when v_schedule.period_policy_version = 1 then v_schedule.due_day
          else extract(day from v_schedule.regular_anchor)::integer end) then
          v_findings := v_findings||jsonb_build_array(jsonb_build_object('rule_id','transition_mid_cycle','severity','error',
            'message','This transition cuts an existing coverage cycle. Review ordinary charge corrections or choose its regular coverage boundary.','reason_required',false,
            'fields',jsonb_build_array('rent.coverage_start'),'values',jsonb_build_object('schedule_id',v_schedule.id,
              'coverage_start',v_start,'regular_coverage_day',case when v_schedule.period_policy_version = 1 then v_schedule.due_day else extract(day from v_schedule.regular_anchor)::integer end)));
        end if;
      end loop;
      with recursive affected as (
        select c.id from public.charges c where c.account_id = p_account_id and c.source_schedule_id = any(v_ended)
          and c.period_start >= v_start and c.voided_at is null and c.deleted_at is null
        union select c.id from public.charges c join affected a on c.parent_charge_id = a.id
          where c.account_id = p_account_id and c.voided_at is null and c.deleted_at is null)
      select coalesce(array_agg(id),'{}') into v_voided from affected;
      if coalesce(r->>'history_mode','itemized') = 'opening_balance' then raise exception 'invalid: a successor cannot re-found an opening balance'; end if;
    end if;
    if v_start < t.start_date or (t.end_date is not null and (v_end is null or v_end > t.end_date)) then
      v_findings := v_findings||jsonb_build_array(jsonb_build_object('rule_id','billing_outside_possession','severity','review',
        'message','Billing coverage falls outside the recorded possession interval.','reason_required',true)); end if;
    if exists(select 1 from jsonb_array_elements(v_charges) c where c->>'source_schedule_id' is null
      and c->>'voided_at' is null and c->>'deleted_at' is null and c->>'type' <> 'deposit') then
      v_findings := v_findings||jsonb_build_array(jsonb_build_object('rule_id','manual_history_overlap','severity','review',
        'message','Existing manual obligations may overlap; their IDs are preserved and are not covered by schedule uniqueness.','reason_required',true)); end if;
    if coalesce(r->>'history_mode','itemized') = 'opening_balance' then
      if v_existing_money or r->'opening_balance' is null or (r->'opening_balance'->>'amount_cents') is null
        or length(btrim(coalesce(r->'opening_balance'->>'basis',''))) not between 1 and 200
        or jsonb_array_length(coalesce(r->'charge_keys','[]')) > 0 or jsonb_array_length(coalesce(p_intent->'payments','[]')) > 0
      then raise exception 'invalid: opening balance needs a virgin timeline, testimony and no itemized charges or receipts'; end if;
    elsif r->'opening_balance' is not null then raise exception 'invalid: opening balance and itemized history are exclusive'; end if;
    v_snapshot := jsonb_build_object('version',1,'source',case when l.id is null then 'manual' else 'lease' end,
      'agreement',case when l.id is null then null else to_jsonb(l) end,'notice',v_notice,'billing',r-'period_overrides'-'charge_keys'-'opening_balance',
      'manual_basis',r->>'manual_basis');
    v_month := date_trunc('month',v_start)::date;
    if v_start < v_month+(extract(day from (r->>'regular_anchor')::date)::integer-1) then v_month := (v_month-interval '1 month')::date; end if;
    while v_month <= date_trunc('month',greatest(v_today,v_start))::date loop
      v_count := v_count+1;if v_count > 120 then raise exception 'invalid: at most 120 historical billing cycles'; end if;
      v_period := public._billing_period(r,to_char(v_month,'YYYY-MM'));
      if v_period is not null then
        select value into v_key from jsonb_array_elements(coalesce(r->'charge_keys','[]')) where value->>'cycle_key' = v_period->>'cycle_key';
        v_period := v_period||jsonb_build_object('draft_key',coalesce(v_key->>'draft_key','rent_'||replace(v_period->>'cycle_key','-','_')));
        if (v_period->>'needs_override')::boolean then v_findings := v_findings||jsonb_build_array(jsonb_build_object(
          'rule_id','partial_period:'||(v_period->>'cycle_key'),'severity','error','message','Confirm the amount or no-charge concession for the exact partial coverage interval.','reason_required',false)); end if;
        v_review := public._billing_period_needs_history_review(v_period,v_today);
        if not v_review and
          ((v_period->>'needs_override')::boolean or v_period->>'reason' is not null) then
          v_history := v_history||jsonb_build_array(v_period-'needs_override'||jsonb_build_object('is_elapsed',false));
        end if;
        if v_review then
          v_history := v_history||jsonb_build_array(v_period-'needs_override'||jsonb_build_object('is_elapsed',true));
        end if;
      end if;
      v_month := (v_month+interval '1 month')::date;
    end loop;
    for v_key in select value from jsonb_array_elements(coalesce(r->'charge_keys','[]')) loop
      v_period := public._billing_period(r,v_key->>'cycle_key');
      if v_period is null then raise exception 'invalid: selected cycle outside schedule coverage'; end if;
      if (v_period->>'needs_override')::boolean then raise exception 'invalid: selected partial cycle needs a confirmed override'; end if;
      v_period := v_period||jsonb_build_object('draft_key',v_key->>'draft_key');
      if v_key->>'cycle_key' = any(v_seen) then raise exception 'invalid: duplicate selected cycle'; end if;
      v_seen := array_append(v_seen,v_key->>'cycle_key');
      v_candidates := v_candidates||jsonb_build_array(v_period-'needs_override');
    end loop;
    v_seen := '{}';
    for v_elem in select value from jsonb_array_elements(coalesce(r->'period_overrides','[]')) loop
      if v_elem->>'cycle_key' = any(v_seen) then raise exception 'invalid: duplicate override cycle'; end if;
      v_seen := array_append(v_seen,v_elem->>'cycle_key');
      v_period := public._billing_period(r,v_elem->>'cycle_key');
      if v_period is null then raise exception 'invalid: override outside coverage'; end if;
      if public._billing_period_needs_history_review(v_period,v_today)
        and not exists(select 1 from jsonb_array_elements(v_history) h where h->>'cycle_key' = v_period->>'cycle_key') then
        v_history := v_history||jsonb_build_array(v_period-'needs_override'||jsonb_build_object('is_elapsed',true,
          'draft_key','rent_'||replace(v_period->>'cycle_key','-','_')));
      end if;
    end loop;
    -- Validate the final partial cycle even when its due date is in the future.
    if v_end is not null then
      v_month := date_trunc('month',v_end)::date;
      if v_end < v_month+(extract(day from (r->>'regular_anchor')::date)::integer-1) then v_month := (v_month-interval '1 month')::date; end if;
      v_period := public._billing_period(r,to_char(v_month,'YYYY-MM'));
      if v_period is not null and (v_period->>'period_start')::date > v_today and
        ((v_period->>'needs_override')::boolean or v_period->>'reason' is not null) and
        not exists(select 1 from jsonb_array_elements(v_history) h where h->>'cycle_key' = v_period->>'cycle_key') then
        v_history := v_history||jsonb_build_array(v_period-'needs_override'||jsonb_build_object(
          'is_elapsed',public._billing_period_needs_history_review(v_period,v_today),
          'draft_key','rent_'||replace(v_period->>'cycle_key','-','_')));
      end if;
      if (v_period->>'needs_override')::boolean then v_findings := v_findings||jsonb_build_array(jsonb_build_object(
        'rule_id','final_partial_period:'||(v_period->>'cycle_key'),'severity','error','message','Confirm the final partial coverage amount or concession.','reason_required',false)); end if;
    end if;
    for v_period in select value from jsonb_array_elements(v_history) loop
      if (v_period->>'is_elapsed')::boolean and coalesce(r->>'history_mode','itemized') = 'itemized'
        and (v_period->>'amount_cents')::bigint > 0 and not exists(
          select 1 from jsonb_array_elements(coalesce(r->'charge_keys','[]')) k where k->>'cycle_key' = v_period->>'cycle_key') then
        v_findings := v_findings||jsonb_build_array(jsonb_build_object('rule_id','history_review:'||(v_period->>'cycle_key'),
          'severity','error','message','Review each cycle whose coverage has started or rent is already due before committing itemized history.','reason_required',false));
      end if;
    end loop;
    v_month := date_trunc('month',greatest(v_today,v_start))::date;
    for v_count in -1..2 loop
      v_period := public._billing_period(r,to_char((v_month+make_interval(months=>v_count))::date,'YYYY-MM'));
      if v_period is not null and (v_period->>'due_date')::date >= v_today
        and (v_next is null or (v_period->>'due_date')::date < (v_next->>'due_date')::date) then v_next := v_period; end if;
    end loop;
  end if;
  if d->>'decision' = 'record' then
    if d - array['decision','draft_key','amount_cents','currency','due_date','description'] <> '{}'
      or (d->>'amount_cents')::bigint is null or (d->>'amount_cents')::bigint <= 0 or length(coalesce(d->>'currency','')) <> 3
      or d->>'due_date' is null then raise exception 'invalid: deposit obligation requires an actual due date, amount and currency'; end if;
    if exists(select 1 from jsonb_array_elements(v_charges) c where c->>'type' = 'deposit' and c->>'voided_at' is null and c->>'deleted_at' is null)
    then raise exception 'conflict: reuse the existing deposit obligation by ID'; end if;
    v_candidates := v_candidates||jsonb_build_array(jsonb_build_object('draft_key',d->>'draft_key','type','deposit',
      'period_start',null,'period_end',null,'due_date',(d->>'due_date')::date,'amount_cents',(d->>'amount_cents')::bigint,'currency',d->>'currency'));
  end if;
  if r->>'decision' = 'configure' then
    v_shared_findings := public._tenancy_date_findings(public._tenancy_date_facts(t),to_jsonb(l),
      jsonb_build_object('start_date',r->>'coverage_start','end_date',r->>'coverage_end'),
      case when d->>'decision' = 'record' then jsonb_build_array(jsonb_build_object('id',null,'due_date',d->>'due_date')) else '[]'::jsonb end);
    select coalesce(jsonb_agg(f),'[]') into v_findings from jsonb_array_elements(v_findings) f
      where f->>'rule_id' not in ('billing_outside_agreement','billing_outside_possession');
  elsif d->>'decision' = 'record' then
    v_shared_findings := public._tenancy_date_findings(public._tenancy_date_facts(t),null,null,
      jsonb_build_array(jsonb_build_object('id',null,'due_date',d->>'due_date')));
  end if;
  if r->>'decision' = 'configure' or d->>'decision' = 'record' then
    v_findings := v_findings||public._applicable_date_findings(p_account_id,p_tenancy_id,v_shared_findings);
  end if;
  v_seen := '{}';
  for v_elem in select value from jsonb_array_elements(v_candidates) loop
    if coalesce(v_elem->>'draft_key','') !~ '^[A-Za-z0-9_-]{1,100}$' or v_elem->>'draft_key' = any(v_seen)
    then raise exception 'invalid: invalid or duplicate charge draft key'; end if;
    v_seen := array_append(v_seen,v_elem->>'draft_key');
  end loop;
  v_seen := '{}';
  for v_elem in select value from jsonb_array_elements(coalesce(p_intent->'payments','[]')) loop
    if v_elem - array['draft_key','amount_cents','currency','received_at','method','reference','notes','allocations'] <> '{}'
      or coalesce(v_elem->>'draft_key','') !~ '^[A-Za-z0-9_-]{1,100}$' or v_elem->>'draft_key' = any(v_seen)
      or (v_elem->>'amount_cents')::bigint is null or (v_elem->>'amount_cents')::bigint <= 0
      or length(coalesce(v_elem->>'currency','')) <> 3 or v_elem->>'received_at' is null
      or (case when (v_elem->>'received_at') ~ '^\d{4}-\d{2}-\d{2}$'
        then (v_elem->>'received_at')::date > v_today
        else (v_elem->>'received_at')::timestamptz > clock_timestamp() end)
      or coalesce(v_elem->>'method','') not in ('cash','check','ach','card','zelle_venmo','money_order','other')
      or jsonb_typeof(coalesce(v_elem->'allocations','[]')) <> 'array' or jsonb_array_length(coalesce(v_elem->'allocations','[]')) > 120
    then raise exception 'invalid: invalid receipt or duplicate receipt key'; end if;
    v_seen := array_append(v_seen,v_elem->>'draft_key');v_total := 0;
    for v_alloc in select value from jsonb_array_elements(coalesce(v_elem->'allocations','[]')) loop
      if (v_alloc ? 'charge_key') = (v_alloc ? 'charge_id') or (v_alloc->>'amount_cents')::bigint <= 0
        or v_alloc->>'amount_cents' is null then raise exception 'invalid: allocation requires one charge reference and positive amount'; end if;
      if v_alloc ? 'charge_key' then
        select value into v_target from jsonb_array_elements(v_candidates) where value->>'draft_key' = v_alloc->>'charge_key';
        v_id := 'new:'||(v_alloc->>'charge_key');v_available := (v_target->>'amount_cents')::bigint;
      else
        select value into v_target from jsonb_array_elements(v_charges) where value->>'id' = v_alloc->>'charge_id'
          and value->>'voided_at' is null and value->>'deleted_at' is null;
        v_id := v_alloc->>'charge_id';v_available := (v_target->>'balance_cents')::bigint;
      end if;
      if v_target is null or v_target->>'currency' <> v_elem->>'currency' then raise exception 'invalid: allocation target missing or currency mismatch'; end if;
      v_amount := (v_alloc->>'amount_cents')::bigint;v_total := v_total+v_amount;
      v_amount := coalesce((v_charge_totals->>v_id)::bigint,0)+v_amount;
      if v_amount > v_available then raise exception 'invalid: allocations exceed charge balance'; end if;
      v_charge_totals := v_charge_totals||jsonb_build_object(v_id,v_amount);
    end loop;
    if v_total > (v_elem->>'amount_cents')::bigint then raise exception 'invalid: allocations exceed receipt'; end if;
  end loop;
  for v_alloc in select value from jsonb_array_elements(coalesce(p_intent->'credit_allocations','[]')) loop
    if (v_alloc ? 'charge_key') = (v_alloc ? 'charge_id') or (v_alloc->>'amount_cents')::bigint <= 0
      or v_alloc->>'amount_cents' is null then raise exception 'invalid: allocation requires one charge reference and positive amount'; end if;
    select value into v_payment from jsonb_array_elements(v_payments) where value->>'id' = v_alloc->>'payment_id'
      and value->>'voided_at' is null and value->>'deleted_at' is null;
    if v_payment is null then raise exception 'invalid: existing credit outside tenancy'; end if;
    if v_alloc ? 'charge_key' then
      select value into v_target from jsonb_array_elements(v_candidates) where value->>'draft_key' = v_alloc->>'charge_key';
      v_id := 'new:'||(v_alloc->>'charge_key');v_available := (v_target->>'amount_cents')::bigint;
    else
      select value into v_target from jsonb_array_elements(v_charges) where value->>'id' = v_alloc->>'charge_id'
        and value->>'voided_at' is null and value->>'deleted_at' is null;
      v_id := v_alloc->>'charge_id';v_available := (v_target->>'balance_cents')::bigint;
    end if;
    if v_target is null or v_target->>'currency' <> v_payment->>'currency' then raise exception 'invalid: allocation target missing or currency mismatch'; end if;
    v_amount := coalesce((v_charge_totals->>v_id)::bigint,0)+(v_alloc->>'amount_cents')::bigint;
    if v_amount > v_available then raise exception 'invalid: allocations exceed charge balance'; end if;
    v_charge_totals := v_charge_totals||jsonb_build_object(v_id,v_amount);
    v_id := v_alloc->>'payment_id';v_amount := coalesce((v_payment_totals->>v_id)::bigint,0)+(v_alloc->>'amount_cents')::bigint;
    if v_amount > (v_payment->>'available_cents')::bigint then raise exception 'invalid: allocations exceed existing credit'; end if;
    v_payment_totals := v_payment_totals||jsonb_build_object(v_id,v_amount);
  end loop;
  for v_elem in select value from jsonb_array_elements(v_findings) where value->>'severity' = 'review' and not coalesce((value->>'explained')::boolean,false) loop
    if not exists(select 1 from jsonb_array_elements(coalesce(p_intent->'explanations','[]')) e
      where e->>'rule_id' = v_elem->>'rule_id' and length(btrim(coalesce(e->>'reason',''))) between 1 and 2000) then
      v_findings := v_findings||jsonb_build_array(jsonb_build_object('rule_id','reason_required:'||(v_elem->>'rule_id'),
        'severity','error','message','Record a reason for the reviewed date or terms difference.','reason_required',false)); end if;
  end loop;
  v_context := jsonb_build_object('as_of_date',v_today,'tenancy',to_jsonb(t),'lease',to_jsonb(l),
    'schedules',v_schedules,'charges',v_charges,'payments',v_payments,'allocations',v_allocations,'adoptions',v_adoptions,
    'auto_charge_enabled',coalesce(v_enabled,false),'notice',v_notice);
  v_hash := encode(sha256(convert_to(v_context::text,'UTF8')),'hex');
  return jsonb_build_object('version',1,'as_of_date',v_today,'clock_basis','UTC','context_fingerprint',v_hash,
    'mode',v_mode,'auto_charge_enabled',coalesce(v_enabled,false),'charge_candidates',v_candidates,'history_periods',v_history,
    'findings',v_findings,'existing',jsonb_build_object('schedules',v_schedules,'charges',v_charges,'payments',v_payments),
    'terms_snapshot',v_snapshot,'can_commit',not exists(select 1 from jsonb_array_elements(v_findings) f where f->>'severity' = 'error'),
    'next_scheduled_action',case when v_enabled then v_next else null end,
    'transition',case when v_transition then jsonb_build_object('ended_schedule_ids',v_ended,'voided_charge_ids',v_voided) else null end);
end $$;
revoke all on function public.preview_billing_setup(uuid,uuid,jsonb) from public,anon;
grant execute on function public.preview_billing_setup(uuid,uuid,jsonb) to authenticated,service_role,tenancy_date_writer;
grant execute on function public._billing_period(jsonb,text),public._valid_recorded_term(jsonb,boolean) to tenancy_date_writer;

create function public.record_billing_setup_explanations(p_account_id uuid,p_tenancy_id uuid,p_intent jsonb,
  p_context_fingerprint text,p_request_key text,p_request_fingerprint text) returns void
language plpgsql security definer set search_path = public as $$
declare v_preview jsonb;e jsonb;t public.tenancies;v_context jsonb;v_relationship jsonb;v_finding jsonb;
begin
  if public._tenancy_date_actor() is null or not exists(select 1 from public.account_members m where m.account_id = p_account_id
    and m.user_id = public._tenancy_date_actor() and m.deleted_at is null and m.role in ('owner','manager'))
  then raise exception 'not authorized' using errcode='42501'; end if;
  v_preview := public.preview_billing_setup(p_account_id,p_tenancy_id,p_intent);
  if v_preview->>'context_fingerprint' <> p_context_fingerprint then raise exception 'conflict: billing context changed'; end if;
  select * into t from public.tenancies where account_id = p_account_id and id = p_tenancy_id and deleted_at is null;
  for e in select value from jsonb_array_elements(coalesce(p_intent->'explanations','[]')) loop
    if not exists(select 1 from jsonb_array_elements(v_preview->'findings') f where f->>'rule_id' = e->>'rule_id' and f->>'severity' = 'review')
      or length(btrim(coalesce(e->>'reason',''))) not between 1 and 2000
    then raise exception 'invalid: explanation must justify a current verified finding'; end if;
    select value into v_finding from jsonb_array_elements(v_preview->'findings') where value->>'rule_id' = e->>'rule_id';
    v_relationship := jsonb_build_object('rule_id',e->>'rule_id','lease_id',p_intent->'rent'->>'source_lease_id',
      'lease',v_preview->'terms_snapshot'->'agreement','possession_start',t.start_date,'possession_end',t.end_date,
      'coverage_start',p_intent->'rent'->>'coverage_start','coverage_end',p_intent->'rent'->>'coverage_end',
      'billing_terms',(p_intent->'rent')-'period_overrides'-'charge_keys'-'opening_balance');
    v_context := jsonb_build_object('version',2,'billing_setup',v_preview,'relationship',v_relationship,
      'relationship_fingerprint',coalesce(v_finding->>'relationship_fingerprint',encode(sha256(convert_to(v_relationship::text,'UTF8')),'hex')));
    insert into public.tenancy_date_records(account_id,tenancy_id,kind,before_facts,after_facts,context_snapshot,
      context_fingerprint,reason_code,reason_note,created_by,request_key,request_fingerprint,response_body)
    values(p_account_id,p_tenancy_id,'explanation',public._tenancy_date_facts(t),public._tenancy_date_facts(t),v_context,
      p_context_fingerprint,'other',btrim(e->>'reason'),public._tenancy_date_actor(),
      p_request_key||':'||(e->>'rule_id'),p_request_fingerprint,'{}');
  end loop;
end $$;
grant create on schema public to tenancy_date_writer;
alter function public.record_billing_setup_explanations(uuid,uuid,jsonb,text,text,text) owner to tenancy_date_writer;
revoke create on schema public from tenancy_date_writer;
revoke all on function public.record_billing_setup_explanations(uuid,uuid,jsonb,text,text,text) from public,anon;
grant execute on function public.record_billing_setup_explanations(uuid,uuid,jsonb,text,text,text) to authenticated,service_role;
grant select on public.leases,public.notices,public.charges,public.payments,public.payment_allocations,public.tenancy_adoptions,public.accounts,public.rent_schedule_period_overrides to tenancy_date_writer;

create function public.commit_billing_setup(p_account_id uuid,p_tenancy_id uuid,p_intent jsonb,
  p_idempotency_key text,p_request_fingerprint text) returns jsonb
language plpgsql set search_path = public as $$
declare k public.idempotency_keys;v_preview jsonb;r jsonb := p_intent->'rent';d jsonb := p_intent->'deposit';
  v_schedule_id uuid;v_adoption_id uuid;v_charge_ids jsonb := '{}';v_payment_ids jsonb := '{}';v_alloc_ids uuid[] := '{}';
  e jsonb;a jsonb;v_id uuid;v_payment uuid;v_charge uuid;v_result jsonb;v_terms jsonb;
  v_ended uuid[] := '{}';v_voided uuid[] := '{}';
begin
  select * into k from public.idempotency_keys where account_id = p_account_id and key = p_idempotency_key for update;
  if not found or k.request_fingerprint is distinct from p_request_fingerprint then raise exception 'invalid: idempotency claim missing or mismatched'; end if;
  if k.completed_at is not null then return k.body; end if;
  if auth.uid() is null or not exists(select 1 from public.account_members m where m.account_id = p_account_id
    and m.user_id = auth.uid() and m.deleted_at is null and m.role in ('owner','manager'))
  then raise exception 'not authorized' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||p_tenancy_id::text,0));
  v_preview := public.preview_billing_setup(p_account_id,p_tenancy_id,p_intent);
  if p_intent->>'expected_context' is distinct from v_preview->>'context_fingerprint' then raise exception 'conflict: billing context changed'; end if;
  if not (v_preview->>'can_commit')::boolean then raise exception 'invalid: review all elapsed/partial periods and required reasons'; end if;
  perform public.record_billing_setup_explanations(p_account_id,p_tenancy_id,p_intent,v_preview->>'context_fingerprint',p_idempotency_key,p_request_fingerprint);
  if p_intent->>'operation' = 'transition' then
    select coalesce(array_agg(value::uuid),'{}') into v_ended from jsonb_array_elements_text(v_preview->'transition'->'ended_schedule_ids');
    select coalesce(array_agg(value::uuid),'{}') into v_voided from jsonb_array_elements_text(v_preview->'transition'->'voided_charge_ids');
    update public.rent_schedules set end_date = (r->>'coverage_start')::date-1,updated_at = clock_timestamp()
      where account_id = p_account_id and id = any(v_ended);
    update public.charges set voided_at = clock_timestamp(),void_reason = 'Superseded by confirmed billing instruction '||p_idempotency_key,updated_at = clock_timestamp()
      where account_id = p_account_id and id = any(v_voided);
  end if;
  if r->>'decision' = 'configure' then
    if v_preview->>'mode' = 'initial' and (r->>'history_mode' = 'opening_balance' or exists(
      select 1 from jsonb_array_elements(v_preview->'history_periods') h where coalesce((h->>'is_elapsed')::boolean,false))) then
      insert into public.tenancy_adoptions(account_id,tenancy_id,adoption_date,opening_balance_cents,currency,balance_basis)
      values(p_account_id,p_tenancy_id,(v_preview->>'as_of_date')::date,
        coalesce((r->'opening_balance'->>'amount_cents')::bigint,0),r->>'currency',r->'opening_balance'->>'basis') returning id into v_adoption_id;
    end if;
    insert into public.rent_schedules(account_id,tenancy_id,kind,amount_cents,currency,due_day,start_date,end_date,
      source_lease_id,source_notice_id,grace_days,late_fee_cents,period_policy_version,regular_anchor,terms_snapshot,manual_basis)
    values(p_account_id,p_tenancy_id,'rent',(r->>'amount_cents')::bigint,r->>'currency',(r->>'due_day')::integer,
      (r->>'coverage_start')::date,(r->>'coverage_end')::date,(r->>'source_lease_id')::uuid,(r->>'source_notice_id')::uuid,(r->>'grace_days')::integer,
      case when r->'late_fee_policy'->>'kind' = 'fixed' and r->'late_fee_policy'->>'currency' = r->>'currency'
        then (r->'late_fee_policy'->>'amount_cents')::bigint else null end,2,(r->>'regular_anchor')::date,
      jsonb_build_object('late_fee_policy',coalesce(r->'late_fee_policy','{"kind":"unknown"}')),r->>'manual_basis') returning id into v_schedule_id;
    for e in select value from jsonb_array_elements(coalesce(r->'period_overrides','[]')) loop
      insert into public.rent_schedule_period_overrides(account_id,tenancy_id,schedule_id,cycle_key,period_start,period_end,due_date,amount_cents,reason)
      values(p_account_id,p_tenancy_id,v_schedule_id,e->>'cycle_key',(e->>'period_start')::date,(e->>'period_end')::date,
        (e->>'due_date')::date,(e->>'amount_cents')::bigint,e->>'reason');
    end loop;
  end if;
  for e in select value from jsonb_array_elements(v_preview->'charge_candidates') loop
    if (e->>'amount_cents')::bigint = 0 then continue; end if;
    insert into public.charges(account_id,tenancy_id,type,amount_cents,currency,due_date,period_start,period_end,source_schedule_id,cycle_key,description)
    values(p_account_id,p_tenancy_id,e->>'type',(e->>'amount_cents')::bigint,e->>'currency',(e->>'due_date')::date,
      (e->>'period_start')::date,(e->>'period_end')::date,case when e->>'type' = 'rent' then v_schedule_id else null end,
      e->>'cycle_key',case when e->>'type' = 'deposit' then coalesce(d->>'description','Security deposit') else e->>'reason' end)
    returning id into v_id;
    v_charge_ids := v_charge_ids||jsonb_build_object(e->>'draft_key',v_id);
  end loop;
  for e in select value from jsonb_array_elements(coalesce(p_intent->'payments','[]')) loop
    insert into public.payments(account_id,tenancy_id,amount_cents,currency,received_at,method,reference,notes)
    values(p_account_id,p_tenancy_id,(e->>'amount_cents')::bigint,e->>'currency',
      case when (e->>'received_at') ~ '^\d{4}-\d{2}-\d{2}$' then
        ((e->>'received_at')::date::timestamp+interval '12 hours') at time zone 'UTC'
      else (e->>'received_at')::timestamptz end,
      e->>'method',e->>'reference',e->>'notes') returning id into v_payment;
    v_payment_ids := v_payment_ids||jsonb_build_object(e->>'draft_key',v_payment);
    for a in select value from jsonb_array_elements(coalesce(e->'allocations','[]')) loop
      v_charge := coalesce((a->>'charge_id')::uuid,(v_charge_ids->>(a->>'charge_key'))::uuid);
      if v_charge is null then raise exception 'invalid: charge reference did not create an obligation'; end if;
      insert into public.payment_allocations(account_id,payment_id,charge_id,amount_cents)
      values(p_account_id,v_payment,v_charge,(a->>'amount_cents')::bigint) returning id into v_id;
      v_alloc_ids := array_append(v_alloc_ids,v_id);
    end loop;
  end loop;
  for a in select value from jsonb_array_elements(coalesce(p_intent->'credit_allocations','[]')) loop
    v_charge := coalesce((a->>'charge_id')::uuid,(v_charge_ids->>(a->>'charge_key'))::uuid);
    if v_charge is null then raise exception 'invalid: charge reference did not create an obligation'; end if;
    insert into public.payment_allocations(account_id,payment_id,charge_id,amount_cents)
    values(p_account_id,(a->>'payment_id')::uuid,v_charge,(a->>'amount_cents')::bigint) returning id into v_id;
    v_alloc_ids := array_append(v_alloc_ids,v_id);
  end loop;
  insert into public.tenancy_onboarding_progress(account_id,tenancy_id,rent_decision,deposit_decision)
  values(p_account_id,p_tenancy_id,case when r->>'decision' = 'configure' then 'configured' when r->>'decision' = 'defer' then 'deferred' else 'pending' end,
    case when d->>'decision' = 'record' then 'configured' when d->>'decision' = 'defer' then 'deferred' else 'pending' end)
  on conflict(account_id,tenancy_id) do update set
    rent_decision = case when r->>'decision' = 'keep' then tenancy_onboarding_progress.rent_decision else excluded.rent_decision end,
    deposit_decision = case when d->>'decision' = 'keep' then tenancy_onboarding_progress.deposit_decision else excluded.deposit_decision end,
    revision = tenancy_onboarding_progress.revision+1,updated_at = clock_timestamp();
  v_result := jsonb_build_object('schedule_id',v_schedule_id,'charge_ids',v_charge_ids,'payment_ids',v_payment_ids,
    'allocation_ids',to_jsonb(v_alloc_ids),'adoption_id',v_adoption_id,'progress',public.get_tenancy_onboarding_progress(p_account_id,p_tenancy_id),
    'ended_schedule_ids',v_ended,'voided_charge_ids',v_voided,'rent_schedule',
    (select to_jsonb(s) from public.rent_schedules s where s.account_id = p_account_id and s.id = v_schedule_id));
  update public.idempotency_keys set status_code = 201,body = v_result,completed_at = clock_timestamp()
  where account_id = p_account_id and key = p_idempotency_key;
  return v_result;
end $$;
revoke all on function public.commit_billing_setup(uuid,uuid,jsonb,text,text) from public,anon;
grant execute on function public.commit_billing_setup(uuid,uuid,jsonb,text,text) to authenticated,service_role;
