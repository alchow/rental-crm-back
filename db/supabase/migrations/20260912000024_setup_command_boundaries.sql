begin;

create role tenancy_setup_writer nologin inherit nobypassrls;
grant authenticated to tenancy_setup_writer;
grant tenancy_setup_writer to postgres;
grant usage,create on schema public to tenancy_setup_writer;

-- SECURITY: only setup commands can turn a private draft into completed evidence; caller JWT RLS still applies.
revoke all on public.tenancy_setup_sessions from anon,authenticated;
grant select on public.tenancy_setup_sessions to authenticated;
grant select,insert,update on public.tenancy_setup_sessions to tenancy_setup_writer;
revoke insert on public.tenancy_setup_confirmations from service_role;
revoke insert(account_id,setup_session_id,tenancy_id,lease_id,setup_snapshot,review_snapshot,entered_by)
  on public.tenancy_setup_confirmations from authenticated;
grant select,insert on public.tenancy_setup_confirmations to tenancy_setup_writer;
grant execute on function public._save_date_warning_confirmations(uuid,uuid,jsonb,jsonb,jsonb,text,text,jsonb,uuid)
  to tenancy_setup_writer;

create function public._guard_setup_confirmation_writer() returns trigger
language plpgsql set search_path=public as $$
begin
  if current_user<>'tenancy_setup_writer' then raise exception 'setup confirmation requires the setup command' using errcode='42501';end if;
  return NEW;
end $$;
revoke all on function public._guard_setup_confirmation_writer() from public,anon,authenticated,service_role;
create trigger tenancy_setup_confirmations_writer before insert on public.tenancy_setup_confirmations
  for each row execute function public._guard_setup_confirmation_writer();

create or replace function public._guard_setup_session_identity() returns trigger
language plpgsql set search_path=public as $$
begin
  if TG_OP='UPDATE' then
    if (NEW.id,NEW.account_id,NEW.area_id,NEW.tenancy_id,NEW.created_at)
      is distinct from (OLD.id,OLD.account_id,OLD.area_id,OLD.tenancy_id,OLD.created_at) then
      raise exception 'invalid: setup identity is immutable';end if;
    if OLD.completed_at is not null and (NEW.payload,NEW.revision,NEW.result,NEW.completed_at,NEW.expires_at)
      is distinct from (OLD.payload,OLD.revision,OLD.result,OLD.completed_at,OLD.expires_at) then
      raise exception 'conflict: completed setup facts are immutable';end if;
    if (NEW.completed_at,NEW.result) is distinct from (OLD.completed_at,OLD.result) and current_user<>'tenancy_setup_writer' then
      raise exception 'setup completion requires the setup command' using errcode='42501';end if;
  elsif NEW.completed_at is not null or NEW.result is not null then
    raise exception 'setup sessions must start as drafts' using errcode='42501';
  end if;
  return NEW;
end $$;
drop trigger tenancy_setup_sessions_identity on public.tenancy_setup_sessions;
create trigger tenancy_setup_sessions_identity before insert or update on public.tenancy_setup_sessions
  for each row execute function public._guard_setup_session_identity();

create function public._normalize_billing_setup_intent(p_intent jsonb) returns jsonb
language plpgsql immutable set search_path=public as $$
declare r jsonb:=p_intent->'rent';rule jsonb;policy text;
begin
  -- INVARIANT: preview and stored schedules use the same complete monthly rule, including compatibility inputs.
  if r->>'decision'<>'configure' then return p_intent;end if;
  rule:=coalesce(nullif(r->'billing_due_rule','null'::jsonb),
    jsonb_build_object('kind','day_of_month','day',(r->>'due_day')::integer));
  if not public._valid_recorded_term(rule,true) or rule->>'kind' not in ('day_of_month','last_day') then
    raise exception 'invalid: confirm a calculable monthly due rule';end if;
  policy:=coalesce(r->>'short_month_policy','last_day');
  if policy not in ('last_day','manual') then raise exception 'invalid: unsupported short-month policy';end if;
  r:=r||jsonb_build_object('billing_due_rule',rule,'short_month_policy',policy,
    'due_day',case when rule->>'kind'='last_day' then 31 else (rule->>'day')::integer end);
  return jsonb_set(p_intent,'{rent}',r);
end $$;
revoke all on function public._normalize_billing_setup_intent(jsonb) from public,anon;
grant execute on function public._normalize_billing_setup_intent(jsonb) to authenticated,service_role,tenancy_date_writer;

create function public._normalize_setup_agreement(p_agreement jsonb,p_existing jsonb) returns jsonb
language plpgsql immutable set search_path=public as $$
declare kind text:=p_agreement->>'change_kind';a jsonb;
begin
  if kind in ('reuse','billing_only') then
    if p_existing->>'id' is null or p_existing->>'status'='draft' then raise exception 'invalid: select a confirmed agreement';end if;
    return p_existing;
  end if;
  if kind not in ('new','correction','renewal') or kind is null then raise exception 'invalid: select an agreement action';end if;
  if kind in ('correction','renewal') and p_existing->>'id' is null then raise exception 'invalid: select the predecessor agreement';end if;
  if kind='new' and p_existing->>'id' is not null then raise exception 'invalid: use correction or renewal for a saved agreement';end if;
  a:=p_agreement||jsonb_build_object(
    'rent_due_rule',coalesce(p_agreement->'rent_due_rule','{"kind":"unknown"}'),
    'late_fee_policy',coalesce(p_agreement->'late_fee_policy','{"kind":"unknown"}'),
    'deposit_knowledge',coalesce(p_agreement->>'deposit_knowledge','unknown'),
    'agreement_kind',case when kind='correction' then p_existing->>'agreement_kind' when kind='renewal' then 'renewal' else 'original' end,
    'predecessor_lease_id',case when kind='correction' then p_existing->'predecessor_lease_id' when kind='renewal' then p_existing->'id' else null end);
  if not public._valid_recorded_term(a->'rent_due_rule',true) or not public._valid_recorded_term(a->'late_fee_policy',false)
    or (a->>'deposit_knowledge'='none' and (a->>'deposit_amount_cents')::bigint<>0)
    or (a->>'deposit_knowledge'='amount' and (a->>'deposit_amount_cents')::bigint<=0)
  then raise exception 'invalid: check the recorded agreement terms';end if;
  return a;
end $$;
revoke all on function public._normalize_setup_agreement(jsonb,jsonb) from public,anon;
grant execute on function public._normalize_setup_agreement(jsonb,jsonb) to authenticated,service_role;

create function public._setup_tenancy_date_change(p_account uuid,p_tenancy uuid,p_setup jsonb) returns jsonb
language plpgsql stable set search_path=public as $$
declare t public.tenancies;changes jsonb:='{}';ctx jsonb;payload jsonb;review jsonb;
begin
  select * into t from public.tenancies where account_id=p_account and id=p_tenancy and deleted_at is null;
  if not found then raise exception 'not_found' using errcode='P0002';end if;
  if t.start_date is distinct from (p_setup->'tenancy'->>'start_date')::date then changes:=changes||jsonb_build_object('start_date',p_setup->'tenancy'->'start_date');end if;
  if t.end_date is distinct from (p_setup->'tenancy'->>'end_date')::date then changes:=changes||jsonb_build_object('end_date',p_setup->'tenancy'->'end_date');end if;
  if t.start_date_basis<>'possession_entitlement' then changes:=changes||'{"start_date_basis":"possession_entitlement"}'::jsonb;end if;
  if changes='{}' then return null;end if;
  ctx:=public.get_tenancy_date_context(p_account,p_tenancy);
  payload:=jsonb_build_object('changes',changes,'expected_date_revision',ctx->'facts'->'date_revision',
    'expected_context_fingerprint',ctx->'context_fingerprint','reason_code','other','reason_note',coalesce(p_setup->>'move_in_note',''));
  review:=public.preview_tenancy_date_correction(p_account,p_tenancy,payload);
  return jsonb_build_object('payload',payload||jsonb_build_object('expected_resulting_status',review->'proposed'->'status'),'review',review);
end $$;
revoke all on function public._setup_tenancy_date_change(uuid,uuid,jsonb) from public,anon;
grant execute on function public._setup_tenancy_date_change(uuid,uuid,jsonb) to authenticated,service_role;

create function public._setup_relationship_findings(p_account uuid,p_tenancy jsonb,p_lease jsonb,p_billing jsonb,p_setup jsonb) returns jsonb
language plpgsql stable set search_path=public as $$
declare facts jsonb:=public._tenancy_date_facts(jsonb_populate_record(null::public.tenancies,p_tenancy));
  relationships jsonb;deposits jsonb;s jsonb;context text;
begin
  select coalesce(jsonb_agg(c),'[]') into deposits from jsonb_array_elements(p_billing->'existing'->'charges') c
    where c->>'type'='deposit' and c->>'voided_at' is null and c->>'deleted_at' is null;
  if p_setup->'billing'->'rent'->>'decision'='configure' then
    relationships:=public._tenancy_date_findings(facts,null,null,deposits);
  else
    relationships:=public._tenancy_date_findings(facts,p_lease,null,deposits);
  end if;
  if p_setup->'billing'->'rent'->>'decision'='keep' then
    for s in select value from jsonb_array_elements(p_billing->'existing'->'schedules') where value->>'deleted_at' is null loop
      relationships:=relationships||public._tenancy_date_findings(facts,p_lease,s,'[]');
    end loop;
  end if;
  select coalesce(jsonb_agg(f),'[]') into relationships from (select distinct value as f from jsonb_array_elements(relationships)) unique_findings;
  context:=encode(sha256(convert_to(jsonb_build_object('tenancy',p_tenancy,'lease',p_lease,'billing',p_billing->'context_fingerprint')::text,'UTF8')),'hex');
  return public._review_date_warnings(p_account,(p_tenancy->>'id')::uuid,
    public._scope_relationship_warnings(relationships,facts,context),'[]');
end $$;
revoke all on function public._setup_relationship_findings(uuid,jsonb,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public._setup_relationship_findings(uuid,jsonb,jsonb,jsonb,jsonb) to authenticated,service_role;


CREATE OR REPLACE FUNCTION "public"."preview_billing_setup_facts"("p_account_id" "uuid", "p_tenancy_id" "uuid", "p_intent" "jsonb", "p_tenancy" "jsonb", "p_lease" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $_$
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
  p_intent:=public._normalize_billing_setup_intent(p_intent);r:=p_intent->'rent';
  if public._tenancy_date_actor() is null or not public.is_account_member(p_account_id) then raise exception 'not_found' using errcode='P0002'; end if;
  if p_tenancy is null then
    select * into t from public.tenancies where account_id=p_account_id and id=p_tenancy_id and deleted_at is null;
    if not found then raise exception 'not_found' using errcode='P0002';end if;
  else
    t:=jsonb_populate_record(null::public.tenancies,p_tenancy);
    if t.account_id is distinct from p_account_id or t.id is distinct from p_tenancy_id or not exists(select 1 from public.areas where account_id=p_account_id and id=t.area_id and deleted_at is null) then raise exception 'not_found' using errcode='P0002';end if;
  end if;
  if jsonb_typeof(p_intent) is distinct from 'object' or p_intent - array['rent','deposit','payments','credit_allocations','explanations','expected_context','operation','warning_acknowledgements'] <> '{}'
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
      'grace_days','late_fee_policy','billing_due_rule','short_month_policy','manual_basis','period_overrides','history_mode','opening_balance','charge_keys'] <> '{}'
      or (r->>'amount_cents')::bigint < 0 or (r->>'amount_cents') is null or length(coalesce(r->>'currency','')) <> 3
      or (r->>'due_day')::integer not between 1 and 31 or r->>'due_day' is null
      or r->>'coverage_start' is null or r->>'regular_anchor' is null
      or coalesce(r->>'history_mode','itemized') not in ('itemized','opening_balance')
      or jsonb_typeof(coalesce(r->'period_overrides','[]')) <> 'array' or jsonb_typeof(coalesce(r->'charge_keys','[]')) <> 'array'
      or jsonb_array_length(coalesce(r->'period_overrides','[]')) > 120 or jsonb_array_length(coalesce(r->'charge_keys','[]')) > 120
      or ((r->>'grace_days')::integer is not null and (r->>'grace_days')::integer < 0)
      or not public._valid_recorded_term(coalesce(r->'late_fee_policy','{"kind":"unknown"}'),false)
    then raise exception 'invalid: incomplete or unsupported recurring instruction'; end if;
    v_start := (r->>'coverage_start')::date;v_end := (r->>'coverage_end')::date;
    if v_end < v_start or (r->>'regular_anchor')::date < v_start
      or (r->>'regular_anchor')::date >= (v_start+interval '1 month')::date
      or extract(day from (r->>'regular_anchor')::date) > 28
    then raise exception 'invalid: invalid coverage interval or regular anchor'; end if;
    if r->>'source_lease_id' is not null then
      if p_lease is null then
        select * into l from public.leases where account_id=p_account_id and tenancy_id=t.id and id=(r->>'source_lease_id')::uuid and deleted_at is null and voided_at is null;
        if not found then raise exception 'invalid: selected lease is outside this tenancy';end if;
      else
        l:=jsonb_populate_record(null::public.leases,p_lease);
        if l.account_id is distinct from p_account_id or l.tenancy_id is distinct from t.id or l.id is distinct from (r->>'source_lease_id')::uuid then raise exception 'invalid: selected lease is outside this tenancy';end if;
      end if;
      if l.status = 'draft' then raise exception 'invalid: confirm the agreement before using it as billing basis'; end if;
      if coalesce(r->'billing_due_rule',jsonb_build_object('kind','day_of_month','day',(r->>'due_day')::integer))->>'kind' not in ('day_of_month','last_day') then raise exception 'invalid: confirm a calculable monthly due rule'; end if;
      if v_start < l.term_start or (v_end is null and l.term_end is not null) or v_end > l.term_end then
        v_findings := v_findings||jsonb_build_array(jsonb_build_object('rule_id','billing_outside_agreement','severity','review',
          'message','Billing coverage differs from the selected agreement interval.','reason_required',true));
      end if;
      if l.rent_amount_cents <> (r->>'amount_cents')::bigint or l.rent_currency <> r->>'currency'
        or (l.rent_due_rule->>'kind' <> 'unknown' and l.rent_due_rule is distinct from coalesce(r->'billing_due_rule',jsonb_build_object('kind','day_of_month','day',(r->>'due_day')::integer)))
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
  select coalesce(jsonb_agg(case when f?'relationship_fingerprint' or f->>'rule_id' in ('billing_outside_agreement','billing_outside_possession','billing_terms_differ') then
    public._date_warning(f->>'rule_id',jsonb_build_object('type','tenancy','id',p_tenancy_id),coalesce(array(select jsonb_array_elements_text(f->'fields')),array['rent.coverage_start']),
      jsonb_build_object('finding',f,'rent',r,'deposit',d,'as_of_date',v_today),public._date_warning_message(f),encode(sha256(convert_to(jsonb_build_object('tenancy',to_jsonb(t),'lease',to_jsonb(l),'schedules',v_schedules,'charges',v_charges,'payments',v_payments,'allocations',v_allocations,'intent',p_intent-array['warning_acknowledgements','expected_context'])::text,'UTF8')),'hex')) else f end),'[]') into v_findings from jsonb_array_elements(v_findings) f;
  v_seen := '{}';
  for v_elem in select value from jsonb_array_elements(v_candidates) loop
    if coalesce(v_elem->>'draft_key','') !~ '^[A-Za-z0-9_-]{1,100}$' or v_elem->>'draft_key' = any(v_seen)
    then raise exception 'invalid: invalid or duplicate charge draft key'; end if;
    v_seen := array_append(v_seen,v_elem->>'draft_key');
  end loop;
  v_seen := '{}';
  for v_elem in select value from jsonb_array_elements(coalesce(p_intent->'payments','[]')) loop
    if v_elem - array['draft_key','amount_cents','currency','received_at','method','reference','notes','allocations','receipt_date_unknown','entry_source'] <> '{}'
      or coalesce(v_elem->>'draft_key','') !~ '^[A-Za-z0-9_-]{1,100}$' or v_elem->>'draft_key' = any(v_seen)
      or (v_elem->>'amount_cents')::bigint is null or (v_elem->>'amount_cents')::bigint <= 0
      or length(coalesce(v_elem->>'currency','')) <> 3 or ((v_elem->>'received_at' is null) <> coalesce((v_elem->>'receipt_date_unknown')::boolean,false))

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
  for v_elem in select value from jsonb_array_elements(v_findings) where value->>'severity' = 'review' and value->>'rule_id' not in ('billing_outside_agreement','billing_outside_possession','billing_terms_differ') and not coalesce((value->>'confirmation_required')::boolean,false) and not coalesce((value->>'explained')::boolean,false) loop
    if not exists(select 1 from jsonb_array_elements(coalesce(p_intent->'explanations','[]')) e
      where e->>'rule_id' = v_elem->>'rule_id' and length(btrim(coalesce(e->>'reason',''))) between 1 and 2000) then
      v_findings := v_findings||jsonb_build_array(jsonb_build_object('rule_id','reason_required:'||(v_elem->>'rule_id'),
        'severity','error','message','Record a reason for the reviewed date or terms difference.','reason_required',false)); end if;
  end loop;
  v_context := jsonb_build_object('as_of_date',v_today,'tenancy',to_jsonb(t),'lease',to_jsonb(l),
    'schedules',v_schedules,'charges',v_charges,'payments',v_payments,'allocations',v_allocations,'adoptions',v_adoptions,
    'auto_charge_enabled',coalesce(v_enabled,false),'notice',v_notice);
  v_hash := encode(sha256(convert_to(v_context::text,'UTF8')),'hex');
  for v_elem in select value from jsonb_array_elements(coalesce(p_intent->'payments','[]')) loop
    v_findings:=v_findings||public._receipt_date_warning(p_account_id,p_tenancy_id,v_elem,v_hash);
  end loop;
  select coalesce(jsonb_agg(f),'[]') into v_shared_findings from jsonb_array_elements(v_findings) f where coalesce((f->>'confirmation_required')::boolean,false);
  v_shared_findings:=public._review_date_warnings(p_account_id,p_tenancy_id,v_shared_findings,coalesce(p_intent->'warning_acknowledgements','[]'));
  select coalesce(jsonb_agg(f),'[]') into v_findings from jsonb_array_elements(v_findings) f where not coalesce((f->>'confirmation_required')::boolean,false);
  v_findings:=v_findings||v_shared_findings;
  return jsonb_build_object('version',1,'as_of_date',v_today,'clock_basis','UTC','context_fingerprint',v_hash,
    'mode',v_mode,'auto_charge_enabled',coalesce(v_enabled,false),'charge_candidates',v_candidates,'history_periods',v_history,
    'findings',v_findings,'existing',jsonb_build_object('schedules',v_schedules,'charges',v_charges,'payments',v_payments),
    'terms_snapshot',v_snapshot,'can_commit',not exists(select 1 from jsonb_array_elements(v_findings) f where f->>'severity' = 'error' or (coalesce((f->>'confirmation_required')::boolean,false) and not (f->>'confirmed')::boolean)),
    'next_scheduled_action',case when v_enabled then v_next else null end,
    'transition',case when v_transition then jsonb_build_object('ended_schedule_ids',v_ended,'voided_charge_ids',v_voided) else null end);
end $_$;

CREATE OR REPLACE FUNCTION "public"."commit_billing_setup"("p_account_id" "uuid", "p_tenancy_id" "uuid", "p_intent" "jsonb", "p_idempotency_key" "text", "p_request_fingerprint" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare k public.idempotency_keys;v_preview jsonb;r jsonb := p_intent->'rent';d jsonb := p_intent->'deposit';
  v_schedule_id uuid;v_adoption_id uuid;v_charge_ids jsonb := '{}';v_payment_ids jsonb := '{}';v_alloc_ids uuid[] := '{}';
  e jsonb;a jsonb;v_id uuid;v_payment uuid;v_charge uuid;v_result jsonb;v_terms jsonb;
  v_ended uuid[] := '{}';v_voided uuid[] := '{}';
begin
  p_intent:=public._normalize_billing_setup_intent(p_intent);r:=p_intent->'rent';
  select * into k from public.idempotency_keys where account_id = p_account_id and key = p_idempotency_key for update;
  if not found or k.request_fingerprint is distinct from p_request_fingerprint then raise exception 'invalid: idempotency claim missing or mismatched'; end if;
  if k.completed_at is not null then return k.body; end if;
  if public._tenancy_date_actor() is null or not exists(select 1 from public.account_members m where m.account_id = p_account_id
    and m.user_id = public._tenancy_date_actor() and m.deleted_at is null and m.role in ('owner','manager'))
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
      source_lease_id,source_notice_id,grace_days,late_fee_cents,period_policy_version,regular_anchor,terms_snapshot,manual_basis,billing_due_rule,short_month_policy)
    values(p_account_id,p_tenancy_id,'rent',(r->>'amount_cents')::bigint,r->>'currency',(r->>'due_day')::integer,
      (r->>'coverage_start')::date,(r->>'coverage_end')::date,(r->>'source_lease_id')::uuid,(r->>'source_notice_id')::uuid,(r->>'grace_days')::integer,
      case when r->'late_fee_policy'->>'kind' = 'fixed' and r->'late_fee_policy'->>'currency' = r->>'currency'
        then (r->'late_fee_policy'->>'amount_cents')::bigint else null end,case when r?'billing_due_rule' or (r->>'due_day')::integer>28 then 3 else 2 end,(r->>'regular_anchor')::date,
      jsonb_build_object('late_fee_policy',coalesce(r->'late_fee_policy','{"kind":"unknown"}')),r->>'manual_basis',r->'billing_due_rule',case when r?'billing_due_rule' then coalesce(r->>'short_month_policy','last_day') else null end) returning id into v_schedule_id;
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
    insert into public.payments(account_id,tenancy_id,amount_cents,currency,received_at,method,reference,notes,receipt_date_unknown,entry_source)
    values(p_account_id,p_tenancy_id,(e->>'amount_cents')::bigint,e->>'currency',
      case when (e->>'received_at') ~ '^\d{4}-\d{2}-\d{2}$' then
        ((e->>'received_at')::date::timestamp+interval '12 hours') at time zone 'UTC'
      else (e->>'received_at')::timestamptz end,
      e->>'method',e->>'reference',e->>'notes',coalesce((e->>'receipt_date_unknown')::boolean,false),coalesce(e->>'entry_source','manual')) returning id into v_payment;
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
  perform public._save_date_warning_confirmations(p_account_id,p_tenancy_id,(select coalesce(jsonb_agg(f),'[]') from jsonb_array_elements(v_preview->'findings') f where coalesce((f->>'confirmation_required')::boolean,false)),
    coalesce(p_intent->'warning_acknowledgements','[]'),v_preview||jsonb_build_object('saved_schedule_id',v_schedule_id),p_idempotency_key,p_request_fingerprint,v_payment_ids);
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
end $_$;

CREATE OR REPLACE FUNCTION "public"."preview_tenancy_setup_session"("p_account_id" "uuid", "p_id" "uuid", "p_setup" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare d public.tenancy_setup_sessions;actual_t public.tenancies;old_l public.leases;
  t jsonb;l jsonb;billing jsonb;r jsonb;preview jsonb;cycles jsonb;payments jsonb:='[]';
  p jsonb;c jsonb;targets jsonb;allocs jsonb;remaining jsonb:='{}';amount_left bigint;available bigint;applied bigint;ref text;
  people_context jsonb:='[]';person jsonb;existing_person jsonb;fingerprint text;today date:=(now() at time zone 'UTC')::date;
  tenant_id uuid;date_change jsonb;relationship_findings jsonb;extra_findings jsonb;
begin
  if auth.uid() is null or not public.is_account_member(p_account_id) then raise exception 'not_found' using errcode='P0002';end if;
  select * into d from public.tenancy_setup_sessions where account_id=p_account_id and id=p_id and expires_at>now();
  if not found then raise exception 'not_found' using errcode='P0002';end if;
  if d.completed_at is not null then raise exception 'conflict: setup already completed';end if;
  if p_setup->'document'->>'receipt_id' is not null then
    if not exists(select 1 from public.document_upload_receipts u where u.account_id=p_account_id
      and u.id=(p_setup->'document'->>'receipt_id')::uuid and u.setup_session_id=d.id and u.uploaded_by=auth.uid()
      and u.mime_type='application/pdf' and u.stored_at is not null and u.prune_claimed_at is null
      and u.derived_from_receipt_id is not distinct from (p_setup->'document'->>'original_receipt_id')::uuid)
    or (p_setup->'document'->>'original_receipt_id' is not null and not exists(
      select 1 from public.document_upload_receipts u where u.account_id=p_account_id
      and u.id=(p_setup->'document'->>'original_receipt_id')::uuid and u.setup_session_id=d.id and u.uploaded_by=auth.uid()
      and u.stored_at is not null and u.prune_claimed_at is null))
    then raise exception 'not_found: setup document' using errcode='P0002';end if;
  end if;
  if jsonb_typeof(p_setup->'people')<>'array' or jsonb_array_length(p_setup->'people') not between 1 and 50 then raise exception 'invalid: add at least one person';end if;
  for person in select value from jsonb_array_elements(p_setup->'people') loop
    if person->>'tenant_id' is not null then
      select to_jsonb(x) into existing_person from public.tenants x where account_id=p_account_id and id=(person->>'tenant_id')::uuid and deleted_at is null;
      if existing_person is null then raise exception 'not_found' using errcode='P0002';end if;
      people_context:=people_context||jsonb_build_array(existing_person);
    elsif length(btrim(coalesce(person->>'full_name',''))) not between 1 and 200 then raise exception 'invalid: enter each person''s name';end if;
  end loop;
  if d.tenancy_id is not null then
    select * into actual_t from public.tenancies where account_id=p_account_id and id=d.tenancy_id and area_id=d.area_id and deleted_at is null;
    if not found or actual_t.status='ended' then raise exception 'conflict: tenancy is unavailable or ended';end if;
  end if;
  tenant_id:=coalesce(d.tenancy_id,d.id);
  t:=coalesce(to_jsonb(actual_t),'{}')||jsonb_build_object('id',tenant_id,'account_id',p_account_id,'area_id',d.area_id,
    'start_date',p_setup->'tenancy'->'start_date','end_date',p_setup->'tenancy'->'end_date',
    'start_date_basis','possession_entitlement','status',public.effective_tenancy_status(coalesce(actual_t.status,'upcoming'),(p_setup->'tenancy'->>'start_date')::date,today));
  if (t->>'start_date') is null or (t->>'end_date')::date<(t->>'start_date')::date then raise exception 'invalid: check move-in and planned ending dates';end if;
  l:=p_setup->'agreement';
  if l->>'existing_id' is not null then
    select * into old_l from public.leases where account_id=p_account_id and tenancy_id=tenant_id and id=(l->>'existing_id')::uuid and voided_at is null and deleted_at is null;
    if not found then raise exception 'not_found' using errcode='P0002';end if;
  end if;
  if l->>'change_kind' in ('correction','renewal') and length(btrim(coalesce(p_setup->>'change_reason',''))) not between 1 and 500 then raise exception 'invalid: say what changed';end if;
  l:=public._normalize_setup_agreement(l,to_jsonb(old_l));
  l:=l||jsonb_build_object('account_id',p_account_id,'tenancy_id',tenant_id,'status',coalesce(l->>'status','active'));
  if (l->>'rent_amount_cents')::bigint<=0 or length(l->>'rent_currency')<>3 or (l->>'term_start') is null or
    (l->>'term_end')::date<(l->>'term_start')::date or not public._valid_recorded_term(l->'rent_due_rule',true)
    or not public._valid_recorded_term(l->'late_fee_policy',false) then raise exception 'invalid: check the agreed rent and lease terms';end if;
  billing:=public._normalize_billing_setup_intent(p_setup->'billing');r:=billing->'rent';
  if r->>'decision'='configure' then
    r:=r||jsonb_build_object('source_lease_id',l->'id');
    billing:=jsonb_set(billing,'{rent}',r);
  end if;
  billing:=jsonb_set(billing,'{operation}',to_jsonb(case when coalesce((p_setup->>'transition')::boolean,false) then 'transition' else 'initial' end));
  -- The server chooses exact periods before matching; no provisional financial rows are inserted.
  preview:=public.preview_billing_setup_facts(p_account_id,tenant_id,billing||jsonb_build_object('payments','[]'::jsonb),t,l);
  if r->>'decision'='configure' and r->>'history_mode'<>'opening_balance' then
    cycles:=coalesce(r->'charge_keys','[]');
    for c in select value from jsonb_array_elements(preview->'history_periods') where coalesce((value->>'is_elapsed')::boolean,false) loop
      if not exists(select 1 from jsonb_array_elements(cycles) x where x->>'cycle_key'=c->>'cycle_key')
        and not exists(select 1 from jsonb_array_elements(preview->'findings') finding where finding->>'severity'='error'
          and finding->>'rule_id' in ('partial_period:'||(c->>'cycle_key'),'final_partial_period:'||(c->>'cycle_key'))) then
        cycles:=cycles||jsonb_build_array(jsonb_build_object('cycle_key',c->>'cycle_key','draft_key',c->>'draft_key'));
      end if;
    end loop;
    r:=jsonb_set(r,'{charge_keys}',cycles);billing:=jsonb_set(billing,'{rent}',r);
    preview:=public.preview_billing_setup_facts(p_account_id,tenant_id,billing||jsonb_build_object('payments','[]'::jsonb),t,l);
  end if;
  targets:=coalesce(preview->'charge_candidates','[]')||(select coalesce(jsonb_agg(value),'[]') from jsonb_array_elements(preview->'existing'->'charges') where value->>'voided_at' is null and value->>'deleted_at' is null and (value->>'balance_cents')::bigint>0
    and not exists(select 1 from jsonb_array_elements_text(coalesce(preview->'transition'->'voided_charge_ids','[]')) cancelled(charge_id) where cancelled.charge_id=(value->>'id')));
  for p in select value from jsonb_array_elements(coalesce(billing->'payments','[]')) with ordinality order by value->>'received_at' nulls last,ordinality loop
    amount_left:=(p->>'amount_cents')::bigint;allocs:='[]';
    for c in select value from jsonb_array_elements(targets) where value->>'currency'=p->>'currency' and value->>'type'=coalesce(p_setup->'receipt_purposes'->>(p->>'draft_key'),'rent') order by value->>'due_date',coalesce(value->>'draft_key',value->>'id') loop
      ref:=coalesce(c->>'draft_key',c->>'id');
      available:=coalesce((remaining->>ref)::bigint,(c->>'balance_cents')::bigint,(c->>'amount_cents')::bigint);
      applied:=least(available,amount_left);
      if applied>0 then
        allocs:=allocs||jsonb_build_array(jsonb_build_object(case when c?'draft_key' then 'charge_key' else 'charge_id' end,ref,'amount_cents',applied));
        remaining:=remaining||jsonb_build_object(ref,available-applied);amount_left:=amount_left-applied;
      end if;
      exit when amount_left=0;
    end loop;
    payments:=payments||jsonb_build_array(p||jsonb_build_object('allocations',allocs,'entry_source','entered_at_setup'));
  end loop;
  billing:=jsonb_set(billing,'{payments}',payments);
  preview:=public.preview_billing_setup_facts(p_account_id,tenant_id,billing,t,l);
  relationship_findings:=public._setup_relationship_findings(p_account_id,t,l,preview,p_setup);
  extra_findings:=relationship_findings;
  if d.tenancy_id is not null then
    date_change:=public._setup_tenancy_date_change(p_account_id,d.tenancy_id,p_setup);
    extra_findings:=extra_findings||coalesce(date_change->'review'->'findings','[]');
    select extra_findings||coalesce(jsonb_agg(jsonb_build_object('rule_id',blocker,'severity','error','message',blocker,'reason_required',false)),'[]')
      into extra_findings from jsonb_array_elements_text(coalesce(date_change->'review'->'blockers','[]')) blockers(blocker);
  end if;
  if p_setup->'agreement'->>'change_kind'='correction' and exists(select 1 from public.rent_schedules s
    where s.account_id=p_account_id and s.source_lease_id=old_l.id and s.deleted_at is null
      and (s.amount_cents<>(l->>'rent_amount_cents')::bigint or s.currency<>l->>'rent_currency')) then
    extra_findings:=extra_findings||jsonb_build_array(jsonb_build_object('rule_id','agreement_correction_schedule_conflict','severity','error',
      'message','The selected agreement anchors different billing terms; record a renewal and explicit billing transition instead.','reason_required',false));
  end if;
  preview:=jsonb_set(preview,'{findings}',preview->'findings'||extra_findings);
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('setup',p_setup,'current_tenancy',to_jsonb(actual_t),
    'current_lease',to_jsonb(old_l),'people',people_context,
    'members',(select coalesce(jsonb_agg(to_jsonb(member) order by member.id),'[]') from public.tenancy_tenants member where member.account_id=p_account_id and member.tenancy_id=d.tenancy_id and member.deleted_at is null),'billing_context',preview->'context_fingerprint','today',today)::text,'UTF8')),'hex');
  return preview||jsonb_build_object('setup_context',fingerprint,'draft_revision',d.revision,'proposed_tenancy',t,'proposed_agreement',l,
    'billing_intent',billing,'date_change',date_change,'setup_relationship_findings',relationship_findings,'can_confirm',not exists(select 1 from jsonb_array_elements(preview->'findings') f where f->>'severity'='error'));
end $$;

CREATE OR REPLACE FUNCTION "public"."commit_tenancy_setup_session"("p_account_id" "uuid", "p_id" "uuid", "p_setup" "jsonb", "p_expected_context" "text", "p_accept_warnings" boolean, "p_idempotency_key" "text", "p_request_fingerprint" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare d public.tenancy_setup_sessions;k public.idempotency_keys;review jsonb;fresh jsonb;billing jsonb;ack jsonb;
  t public.tenancies;person jsonb;person_id uuid;member_id uuid;people_ids uuid[]:='{}';parties jsonb:='[]';
  agreed jsonb;p_kind text;doc jsonb;doc_id uuid;lease_id uuid;money jsonb;v_result jsonb;first_person boolean:=true;
  date_review jsonb;date_payload jsonb;child_key text;notes jsonb:=coalesce(p_setup->'warning_notes','{}');
begin
  if auth.uid() is null or not exists(select 1 from public.account_members where account_id=p_account_id and user_id=auth.uid() and deleted_at is null and role in ('owner','manager')) then raise exception 'not_found' using errcode='P0002';end if;
  select * into k from public.idempotency_keys where account_id=p_account_id and key=p_idempotency_key for update;
  if not found or k.request_fingerprint is distinct from p_request_fingerprint then raise exception 'invalid: idempotency claim missing';end if;
  if k.completed_at is not null then return k.body;end if;
  select * into d from public.tenancy_setup_sessions where account_id=p_account_id and id=p_id for update;
  if not found then raise exception 'not_found' using errcode='P0002';end if;
  if d.completed_at is not null then raise exception 'conflict: setup already completed';end if;
  perform pg_advisory_xact_lock(hashtextextended('tenancy_identity:'||p_account_id::text||':'||d.area_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('rent_change:'||coalesce(d.tenancy_id,d.id)::text,0));
  review:=public.preview_tenancy_setup_session(p_account_id,p_id,p_setup);
  if review->>'setup_context' is distinct from p_expected_context then raise exception 'conflict: setup context changed; review again';end if;
  if not (review->>'can_confirm')::boolean then raise exception 'invalid: fix the blocking findings before confirming';end if;
  if p_accept_warnings is distinct from true then raise exception 'invalid: confirm the reviewed setup and listed differences';end if;
  if d.tenancy_id is null then
    insert into public.tenancies(id,account_id,area_id,start_date,end_date,start_date_basis,status)
      values(d.id,p_account_id,d.area_id,(review->'proposed_tenancy'->>'start_date')::date,
        (review->'proposed_tenancy'->>'end_date')::date,'possession_entitlement',review->'proposed_tenancy'->>'status') returning * into t;
  else
    select * into t from public.tenancies where account_id=p_account_id and id=d.tenancy_id and deleted_at is null for update;
    if review->'date_change' is not null and review->'date_change'<>'null'::jsonb then
      date_payload:=review->'date_change'->'payload';date_review:=review->'date_change'->'review';
      select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('relationship_fingerprint',f->'relationship_fingerprint','note',notes->>(f->>'rule_id')))),'[]') into ack
        from jsonb_array_elements(date_review->'findings') f where coalesce((f->>'confirmation_required')::boolean,false);
      child_key:=p_idempotency_key||'_dates';perform public.claim_idempotency_key(p_account_id,child_key,p_request_fingerprint);
      perform public.correct_tenancy_dates(p_account_id,t.id,child_key,p_request_fingerprint,date_payload||jsonb_build_object('warning_acknowledgements',ack));
    end if;
  end if;
  select * into t from public.tenancies where account_id=p_account_id and id=t.id;
  for person in select value from jsonb_array_elements(p_setup->'people') loop
    person_id:=coalesce((person->>'tenant_id')::uuid,(person->>'key')::uuid);
    if person->>'tenant_id' is null then
      insert into public.tenants(id,account_id,full_name,phones,emails)
      values(person_id,p_account_id,btrim(person->>'full_name'),array(select jsonb_array_elements_text(coalesce(person->'phones','[]'))),array(select jsonb_array_elements_text(coalesce(person->'emails','[]'))));
    elsif not exists(select 1 from public.tenants where id=person_id and account_id=p_account_id and deleted_at is null) then raise exception 'not_found' using errcode='P0002';end if;
    if person_id=any(people_ids) then raise exception 'invalid: the same person was added twice';end if;
    people_ids:=array_append(people_ids,person_id);
    select id into member_id from public.tenancy_tenants where account_id=p_account_id and tenancy_id=t.id and tenant_id=person_id and deleted_at is null order by created_at limit 1;
    if member_id is null then
      insert into public.tenancy_tenants(account_id,tenancy_id,tenant_id,role)
        values(p_account_id,t.id,person_id,case when first_person and not exists(select 1 from public.tenancy_tenants where tenancy_id=t.id and deleted_at is null and role='primary') then 'primary' else 'occupant' end);
    end if;
    parties:=parties||jsonb_build_array(jsonb_build_object('tenant_id',person_id));
    first_person:=false;
  end loop;
  -- DATA FLOW: the reviewed people list replaces occupant membership; guarantors retain their separate role.
  update public.tenancy_tenants set deleted_at=clock_timestamp(),updated_at=clock_timestamp() where account_id=p_account_id and tenancy_id=t.id and deleted_at is null and not(tenant_id=any(people_ids)) and role<>'guarantor';
  if not exists(select 1 from public.tenancy_tenants where account_id=p_account_id and tenancy_id=t.id and deleted_at is null and role='primary') then
    update public.tenancy_tenants set role='primary',updated_at=clock_timestamp() where id=(select id from public.tenancy_tenants where account_id=p_account_id and tenancy_id=t.id and tenant_id=people_ids[1] and deleted_at is null limit 1);
  end if;
  agreed:=review->'proposed_agreement';p_kind:=p_setup->'agreement'->>'change_kind';
  if p_setup->'document'->>'receipt_id' is not null then
    if p_setup->'document'->>'original_receipt_id' is not null then
      doc:=public.create_tenancy_document_from_image(p_account_id,t.id,'lease',coalesce(p_setup->'document'->>'name','Lease'),false,
        (p_setup->'document'->>'original_receipt_id')::uuid,(p_setup->'document'->>'receipt_id')::uuid);
    else
      doc:=public.create_tenancy_document_from_upload(p_account_id,t.id,'lease',coalesce(p_setup->'document'->>'name','Lease'),false,(p_setup->'document'->>'receipt_id')::uuid);
    end if;
    doc_id:=(doc->'document'->>'id')::uuid;
    agreed:=jsonb_set(agreed,'{terms_source}',jsonb_build_object('kind','document','document_id',doc_id));
  end if;
  if p_kind in ('reuse','billing_only') then lease_id:=(agreed->>'id')::uuid;
  elsif p_kind='correction' then
    select o_replacement_id into lease_id from public.replace_lease_terms(p_account_id,(p_setup->'agreement'->>'existing_id')::uuid,p_setup->>'change_reason',
      (agreed->>'term_start')::date,(agreed->>'term_end')::date,(agreed->>'rent_amount_cents')::bigint,agreed->>'rent_currency',
      (agreed->>'deposit_amount_cents')::bigint,agreed->>'deposit_currency',coalesce(agreed->'document','{}')||jsonb_build_object('parties',parties),agreed);
  else
    insert into public.leases(id,account_id,tenancy_id,status,term_start,term_end,rent_amount_cents,rent_currency,deposit_amount_cents,deposit_currency,
      rent_due_rule,grace_days,late_fee_policy,deposit_knowledge,terms_source,agreement_kind,predecessor_lease_id,document)
    values((agreed->>'id')::uuid,p_account_id,t.id,'active',(agreed->>'term_start')::date,(agreed->>'term_end')::date,
      (agreed->>'rent_amount_cents')::bigint,agreed->>'rent_currency',coalesce((agreed->>'deposit_amount_cents')::bigint,0),agreed->>'deposit_currency',
      agreed->'rent_due_rule',(agreed->>'grace_days')::integer,agreed->'late_fee_policy',agreed->>'deposit_knowledge',nullif(agreed->'terms_source','null'::jsonb),
      agreed->>'agreement_kind',(agreed->>'predecessor_lease_id')::uuid,
      coalesce(agreed->'document','{}')||jsonb_build_object('parties',parties,'setup_session_id',d.id,'change_reason',p_setup->>'change_reason')) returning id into lease_id;
  end if;
  billing:=review->'billing_intent';
  if billing->'rent'->>'decision'='configure' then billing:=jsonb_set(billing,'{rent,source_lease_id}',to_jsonb(lease_id));end if;
  fresh:=public.preview_billing_setup(p_account_id,t.id,billing);
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('relationship_fingerprint',f->'relationship_fingerprint','note',notes->>(f->>'rule_id')))),'[]') into ack
    from jsonb_array_elements(fresh->'findings') f where coalesce((f->>'confirmation_required')::boolean,false);
  billing:=billing||jsonb_build_object('expected_context',fresh->'context_fingerprint','warning_acknowledgements',ack);
  -- INVARIANT: nested billing and final setup share one claim and transaction; only the complete setup result is replayed.
  money:=public.commit_billing_setup(p_account_id,t.id,billing,p_idempotency_key,p_request_fingerprint);
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('relationship_fingerprint',f->'relationship_fingerprint','note',notes->>(f->>'rule_id')))),'[]') into ack
    from jsonb_array_elements(review->'setup_relationship_findings') f where coalesce((f->>'confirmation_required')::boolean,false);
  perform public._save_date_warning_confirmations(p_account_id,t.id,
    (select coalesce(jsonb_agg(f),'[]') from jsonb_array_elements(review->'setup_relationship_findings') f where coalesce((f->>'confirmation_required')::boolean,false)),
    ack,jsonb_build_object('setup_session_id',d.id,'context_fingerprint',review->>'setup_context'),p_idempotency_key||'_setup',p_request_fingerprint);
  perform public.update_tenancy_onboarding_progress(p_account_id,t.id,jsonb_build_object('selected_lease_id',lease_id,'agreement_confirmed',true));
  if coalesce((p_setup->>'save_defaults')::boolean,false) then
    insert into public.account_rent_defaults(account_id,grace_days,late_fee_policy) values(p_account_id,(agreed->>'grace_days')::integer,agreed->'late_fee_policy')
      on conflict(account_id) do update set grace_days=excluded.grace_days,late_fee_policy=excluded.late_fee_policy,updated_at=clock_timestamp();
  end if;
  insert into public.tenancy_setup_confirmations(account_id,setup_session_id,tenancy_id,lease_id,setup_snapshot,review_snapshot,entered_by)
  values(p_account_id,d.id,t.id,lease_id,p_setup,review||jsonb_build_object('committed_lease_id',lease_id,'document_id',doc_id),auth.uid());
  v_result:=jsonb_build_object('session_id',d.id,'tenancy_id',t.id,'lease_id',lease_id,'status',t.status,'billing',money);
  update public.tenancy_setup_sessions set completed_at=clock_timestamp(),result=v_result,updated_at=clock_timestamp(),revision=revision+1 where id=d.id;
  update public.idempotency_keys set status_code=201,body=v_result,completed_at=clock_timestamp() where account_id=p_account_id and key=p_idempotency_key;
  return v_result;
end $$;

CREATE OR REPLACE FUNCTION "public"."save_tenancy_setup_session"("p_account_id" "uuid", "p_id" "uuid", "p_area_id" "uuid", "p_tenancy_id" "uuid", "p_revision" bigint, "p_payload" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare d public.tenancy_setup_sessions;
begin
  if auth.uid() is null or not exists(select 1 from public.account_members where account_id=p_account_id and user_id=auth.uid() and deleted_at is null and role in ('owner','manager')) then raise exception 'not_found' using errcode='P0002';end if;
  if not exists(select 1 from public.areas where id=p_area_id and account_id=p_account_id and kind='unit' and deleted_at is null) then raise exception 'not_found' using errcode='P0002';end if;
  if p_tenancy_id is not null and not exists(select 1 from public.tenancies where id=p_tenancy_id and account_id=p_account_id and area_id=p_area_id and deleted_at is null) then raise exception 'not_found' using errcode='P0002';end if;
  insert into public.tenancy_setup_sessions(id,account_id,area_id,tenancy_id,payload)
    values(p_id,p_account_id,p_area_id,p_tenancy_id,p_payload) on conflict(id) do nothing;
  select * into d from public.tenancy_setup_sessions where account_id=p_account_id and id=p_id for update;
  if not found then raise exception 'not_found' using errcode='P0002';end if;
  if d.area_id<>p_area_id or d.tenancy_id is distinct from p_tenancy_id or d.revision<>p_revision or d.completed_at is not null or d.expires_at<=clock_timestamp() then raise exception 'conflict: setup draft changed';end if;
  update public.tenancy_setup_sessions set payload=p_payload,revision=revision+1,updated_at=clock_timestamp(),expires_at=clock_timestamp()+interval '90 days'
    where id=d.id returning * into d;
  return to_jsonb(d);
end $$;

CREATE OR REPLACE FUNCTION "public"."_guard_setup_upload_binding"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if NEW.setup_session_id is not null then
    if OLD.prune_claimed_at is not null then raise exception 'conflict: upload cleanup has started; upload the document again';end if;
    perform 1 from public.tenancy_setup_sessions where account_id=NEW.account_id and id=NEW.setup_session_id
      and completed_at is null and expires_at>clock_timestamp() for key share;
    if not found then raise exception 'not_found: active setup session' using errcode='P0002';end if;
  end if;
  return NEW;
end $$;

alter function public.save_tenancy_setup_session(uuid,uuid,uuid,uuid,bigint,jsonb) owner to tenancy_setup_writer;
alter function public.commit_tenancy_setup_session(uuid,uuid,jsonb,text,boolean,text,text) owner to tenancy_setup_writer;
alter function public._guard_setup_upload_binding() owner to tenancy_setup_writer;
revoke create on schema public from tenancy_setup_writer;
revoke all on function public.save_tenancy_setup_session(uuid,uuid,uuid,uuid,bigint,jsonb) from public,anon;
revoke all on function public.commit_tenancy_setup_session(uuid,uuid,jsonb,text,boolean,text,text) from public,anon;
grant execute on function public.save_tenancy_setup_session(uuid,uuid,uuid,uuid,bigint,jsonb),
  public.commit_tenancy_setup_session(uuid,uuid,jsonb,text,boolean,text,text) to authenticated;
revoke all on function public._guard_setup_upload_binding() from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
