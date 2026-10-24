-- Current occupancy reads use UTC possession entitlement even before status materialization.
CREATE OR REPLACE FUNCTION "public"."search_entities"("p_account_id" "uuid", "p_q" "text", "p_types" "text"[], "p_exclude" "text"[], "p_limit" integer) RETURNS TABLE("entity_type" "text", "entity_id" "uuid", "title" "text", "subtitle" "text", "score" real, "context" "jsonb")
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_q       text;
  v_pattern text;
begin
  if char_length(btrim(p_q)) < 2 then
    return;
  end if;

  v_q := public.normalize_search_text(p_q);
  if char_length(v_q) < 1 then
    return;
  end if;
  v_pattern := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  select
    s.entity_type, s.entity_id, s.title, s.subtitle, s.score,
    case
      -- tenant: current unit + property + is_primary + the tenant's OTHER tenancies.
      when s.entity_type = 'tenant' then (
        select jsonb_build_object(
          'kind',           'tenant',
          'unit_name',      ar.name,
          'property_name',  pr.name,
          'area_id',        ar.id,
          'tenancy_id',     tn.id,
          'tenancy_status', tn.status,
          'is_primary',     (tt.role = 'primary'),
          'other_tenancies', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'tenancy_id',     tn2.id,
                'unit_name',      ar2.name,
                'property_name',  pr2.name,
                'tenancy_status', tn2.status,
                'is_primary',     (tt2.role = 'primary')
              )
              order by tn2.start_date desc, tn2.id desc
            )
            from public.tenancy_tenants tt2
            join public.tenancy_current  tn2 on tn2.id = tt2.tenancy_id  and tn2.account_id = p_account_id and tn2.deleted_at is null
            join public.areas      ar2 on ar2.id = tn2.area_id     and ar2.account_id = p_account_id and ar2.deleted_at is null
            join public.properties pr2 on pr2.id = ar2.property_id and pr2.account_id = p_account_id and pr2.deleted_at is null
            where tt2.tenant_id  = s.entity_id
              and tt2.account_id = p_account_id
              and tt2.deleted_at is null
              and tn2.id <> tn.id
          ), '[]'::jsonb)
        )
        from public.tenancy_tenants tt
        join public.tenancy_current  tn on tn.id = tt.tenancy_id  and tn.account_id = p_account_id and tn.deleted_at is null
        join public.areas      ar on ar.id = tn.area_id     and ar.account_id = p_account_id and ar.deleted_at is null
        join public.properties pr on pr.id = ar.property_id and pr.account_id = p_account_id and pr.deleted_at is null
        where tt.tenant_id  = s.entity_id
          and tt.account_id = p_account_id
          and tt.deleted_at is null
        order by (tn.status in ('active','holdover')) desc, tn.start_date desc, tn.id desc
        limit 1
      )
      -- area: property disambiguator + occupancy + the active-tenancy handoff.
      when s.entity_type = 'area' then (
        select jsonb_build_object(
          'kind',              'area',
          'property_id',       p.id,
          'property_name',     p.name,
          'address',           nullif(p.address->>'line1', ''),
          'area_kind',         a.kind,
          'active_tenancy_id', act.tenancy_id,
          'tenant_names',      coalesce(act.tenant_names, array[]::text[]),
          'occupancy_status',  case when act.tenancy_id is not null then 'occupied' else 'vacant' end
        )
        from public.areas a
        join public.properties p
          on p.id = a.property_id and p.account_id = p_account_id and p.deleted_at is null
        left join lateral (
          select
            tn2.id as tenancy_id,
            array_remove(
              array_agg(te.full_name order by (tt2.role = 'primary') desc, te.full_name),
              null
            ) as tenant_names
          from public.tenancy_current tn2
          left join public.tenancy_tenants tt2
            on tt2.tenancy_id = tn2.id and tt2.account_id = p_account_id and tt2.deleted_at is null
          left join public.tenants te
            on te.id = tt2.tenant_id and te.account_id = p_account_id and te.deleted_at is null
          where tn2.area_id    = a.id
            and tn2.account_id = p_account_id
            and tn2.deleted_at is null
            and tn2.status in ('active', 'holdover')
          group by tn2.id, tn2.start_date
          order by tn2.start_date desc, tn2.id desc
          limit 1
        ) act on true
        where a.id = s.entity_id and a.account_id = p_account_id and a.deleted_at is null
      )
      -- property: address + unit count (the within-account disambiguators).
      when s.entity_type = 'property' then (
        select jsonb_build_object(
          'kind',       'property',
          'address',    nullif(p.address->>'line1', ''),
          'unit_count', (
            select count(*)::int
            from public.areas a
            where a.property_id = p.id and a.account_id = p_account_id
              and a.kind = 'unit' and a.deleted_at is null
          )
        )
        from public.properties p
        where p.id = s.entity_id and p.account_id = p_account_id and p.deleted_at is null
      )
      -- maintenance_request: status/severity/date + location ids + the latest
      -- assigned vendor + the area's current tenancy (DERIVED scope hint).
      when s.entity_type = 'maintenance_request' then (
        select jsonb_build_object(
          'kind',               'maintenance_request',
          'status',             m.status,
          'severity',           m.severity,
          'created_at',         m.created_at,
          'area_id',            m.area_id,
          'unit_name',          a.name,
          'property_name',      p.name,
          'assigned_vendor_id', wo.vendor_id,
          'tenancy_id',         act.tenancy_id
        )
        from public.maintenance_requests m
        join public.areas      a on a.id = m.area_id     and a.account_id = p_account_id and a.deleted_at is null
        join public.properties p on p.id = a.property_id and p.account_id = p_account_id and p.deleted_at is null
        left join lateral (
          select wo.vendor_id
          from public.work_orders wo
          where wo.maintenance_request_id = m.id
            and wo.account_id = p_account_id
            and wo.deleted_at is null
            and wo.vendor_id is not null
          order by wo.created_at desc
          limit 1
        ) wo on true
        left join lateral (
          select tn.id as tenancy_id
          from public.tenancy_current tn
          where tn.area_id = a.id and tn.account_id = p_account_id and tn.deleted_at is null
            and tn.status in ('active', 'holdover')
          order by tn.start_date desc, tn.id desc
          limit 1
        ) act on true
        where m.id = s.entity_id and m.account_id = p_account_id and m.deleted_at is null
      )
      -- vendor: outreach target + work-order history ("the vendor we used last time").
      when s.entity_type = 'vendor' then (
        select jsonb_build_object(
          'kind',         'vendor',
          'contact',      nullif(coalesce(v.contact->>'email', v.contact->>'phone'), ''),
          'last_used_at', wh.last_used_at,
          'job_count',    coalesce(wh.job_count, 0)
        )
        from public.vendors v
        left join lateral (
          select
            max(coalesce(wo.completed_at, wo.scheduled_for, wo.created_at)) as last_used_at,
            count(*)::int                                                   as job_count
          from public.work_orders wo
          where wo.vendor_id = v.id and wo.account_id = p_account_id and wo.deleted_at is null
        ) wh on true
        where v.id = s.entity_id and v.account_id = p_account_id and v.deleted_at is null
      )
      else null
    end as context
  from (
    -- ---- tenants ---------------------------------------------------------
    select
      'tenant'::text as entity_type,
      t.id           as entity_id,
      t.full_name    as title,
      nullif(array_to_string(t.emails, ', '), '') as subtitle,
      word_similarity(v_q, public.normalize_search_text(public.tenant_search_text(t.full_name, t.emails)))::real as score
    from public.tenants t
    where t.deleted_at is null
      and t.account_id = p_account_id
      and (p_types   is null or 'tenant' = any(p_types))
      and (p_exclude is null or 'tenant' <> all(p_exclude))
      and public.normalize_search_text(public.tenant_search_text(t.full_name, t.emails)) ilike v_pattern escape '\'

    union all

    -- ---- vendors ---------------------------------------------------------
    select
      'vendor'::text as entity_type,
      v.id           as entity_id,
      v.name         as title,
      nullif(coalesce(v.contact->>'email', v.contact->>'phone'), '') as subtitle,
      word_similarity(v_q, public.normalize_search_text(v.name || ' ' || coalesce(v.contact->>'email','') || ' ' || coalesce(v.contact->>'phone','')))::real as score
    from public.vendors v
    where v.deleted_at is null
      and v.account_id = p_account_id
      and (p_types   is null or 'vendor' = any(p_types))
      and (p_exclude is null or 'vendor' <> all(p_exclude))
      and public.normalize_search_text(v.name || ' ' || coalesce(v.contact->>'email','') || ' ' || coalesce(v.contact->>'phone','')) ilike v_pattern escape '\'

    union all

    -- ---- properties ------------------------------------------------------
    select
      'property'::text as entity_type,
      p.id             as entity_id,
      p.name           as title,
      nullif(p.address->>'line1', '') as subtitle,
      word_similarity(v_q, public.normalize_search_text(p.name || ' ' || coalesce(p.address->>'line1','')))::real as score
    from public.properties p
    where p.deleted_at is null
      and p.account_id = p_account_id
      and (p_types   is null or 'property' = any(p_types))
      and (p_exclude is null or 'property' <> all(p_exclude))
      and public.normalize_search_text(p.name || ' ' || coalesce(p.address->>'line1','')) ilike v_pattern escape '\'

    union all

    -- ---- areas -----------------------------------------------------------
    select
      'area'::text as entity_type,
      a.id         as entity_id,
      a.name       as title,
      a.kind       as subtitle,
      word_similarity(v_q, public.normalize_search_text(a.name))::real as score
    from public.areas a
    where a.deleted_at is null
      and a.account_id = p_account_id
      and (p_types   is null or 'area' = any(p_types))
      and (p_exclude is null or 'area' <> all(p_exclude))
      and public.normalize_search_text(a.name) ilike v_pattern escape '\'

    union all

    -- ---- maintenance_requests --------------------------------------------
    select
      'maintenance_request'::text as entity_type,
      m.id                        as entity_id,
      m.title                     as title,
      m.status                    as subtitle,
      word_similarity(v_q, public.normalize_search_text(m.title))::real as score
    from public.maintenance_requests m
    where m.deleted_at is null
      and m.account_id = p_account_id
      and (p_types   is null or 'maintenance_request' = any(p_types))
      and (p_exclude is null or 'maintenance_request' <> all(p_exclude))
      and public.normalize_search_text(m.title) ilike v_pattern escape '\'
  ) s
  order by s.score desc, s.title asc, s.entity_type asc
  limit greatest(p_limit, 0);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."_persona_find_or_create_thread"("p_account_id" "uuid", "p_cp_type" "text", "p_cp_id" "uuid", "p_cp_address" "text", "p_subject" "text", "p_reply_domain" "text", "p_landlord_user_id" "uuid" DEFAULT NULL::"uuid", "p_landlord_address" "text" DEFAULT NULL::"text", "p_parent_thread_id" "uuid" DEFAULT NULL::"uuid", "p_parent_tenancy_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("thread_id" "uuid", "cp_participant_id" "uuid", "tenancy_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  v_thread_id  uuid;
  v_part_id    uuid;
  v_tenancy_id uuid;
  v_ll_id      uuid;
  v_ll_email   text;
  v_ll_part_id uuid;
begin
  -- (a) Parent-named thread: reuse only while active with the party aboard.
  if p_parent_thread_id is not null then
    select t.id, t.tenancy_id into v_thread_id, v_tenancy_id
      from public.comm_threads t
     where t.account_id = p_account_id
       and t.id = p_parent_thread_id
       and t.status = 'active';
    if v_thread_id is not null then
      select p.id into v_part_id
        from public.comm_thread_participants p
       where p.account_id = p_account_id
         and p.thread_id = p_parent_thread_id
         and p.party_type = p_cp_type
         and p.party_id = p_cp_id
         and p.left_at is null
       order by p.created_at
       limit 1;
      if v_part_id is not null then
        thread_id := v_thread_id; cp_participant_id := v_part_id; tenancy_id := v_tenancy_id;
        return next;
        return;
      end if;
    end if;
    v_thread_id := null; v_tenancy_id := null;
    -- Closed thread / departed participant: fall through, but only into the
    -- parent's own tenancy (below) — never an unrelated conversation.
  end if;

  -- A tenant with parent context but no usable tenancy is unroutable here:
  -- the caller triages instead of guessing.
  if p_cp_type = 'tenant'
     and p_parent_thread_id is not null
     and p_parent_tenancy_id is null then
    return;
  end if;

  select b.thread_id, b.participant_id into v_thread_id, v_part_id
    from public.thread_channel_bindings b
    join public.comm_threads t
      on t.account_id = b.account_id and t.id = b.thread_id
    join public.comm_thread_participants p
      on p.id = b.participant_id
   where b.account_id = p_account_id
     and b.channel = 'email'
     and b.active
     and b.participant_address = p_cp_address
     and t.status = 'active'
     and t.mode = 'bridged'
     and p.party_type = p_cp_type
     and p.party_id = p_cp_id
     and p.left_at is null
     and (p_parent_tenancy_id is null or t.tenancy_id = p_parent_tenancy_id)
   order by t.updated_at desc
   limit 1;

  if v_thread_id is not null then
    select t.tenancy_id into v_tenancy_id
      from public.comm_threads t
     where t.account_id = p_account_id and t.id = v_thread_id;
    thread_id := v_thread_id; cp_participant_id := v_part_id; tenancy_id := v_tenancy_id;
    return next;
    return;
  end if;

  if p_reply_domain is null or length(p_reply_domain) < 3 then
    raise exception 'p_reply_domain is required to create a thread'
      using errcode = '22023';
  end if;

  if p_cp_type = 'tenant' then
    if p_parent_tenancy_id is not null then
      -- The parent's tenancy IS the conversation scope. No inference.
      v_tenancy_id := p_parent_tenancy_id;
    else
      select tn.id into v_tenancy_id
        from public.tenancy_tenants tt
        join public.tenancy_current tn
          on tn.account_id = tt.account_id and tn.id = tt.tenancy_id
       where tt.account_id = p_account_id
         and tt.tenant_id = p_cp_id
         and tt.deleted_at is null
         and tn.deleted_at is null
         and tn.status in ('active', 'holdover')
       order by (tn.status = 'active') desc, tn.start_date desc
       limit 1;
    end if;
  end if;

  insert into public.comm_threads (account_id, kind, mode, channel, subject, tenancy_id)
  values (
    p_account_id,
    case when p_cp_type = 'vendor' then 'vendor' else 'bridged_tenant' end,
    'bridged',
    'email',
    nullif(left(coalesce(p_subject, ''), 998), ''),
    v_tenancy_id
  )
  returning id into v_thread_id;

  insert into public.comm_thread_participants (account_id, thread_id, party_type, party_id)
  values (p_account_id, v_thread_id, p_cp_type, p_cp_id)
  returning id into v_part_id;

  insert into public.thread_channel_bindings
    (account_id, thread_id, participant_id, participant_address, reply_address)
  values (
    p_account_id, v_thread_id, v_part_id, p_cp_address,
    't-' || encode(extensions.gen_random_bytes(16), 'hex') || '@' || lower(p_reply_domain)
  );

  -- Landlord participant: the initiating landlord when known, else the owner.
  v_ll_id := p_landlord_user_id;
  if v_ll_id is null then
    select m.user_id into v_ll_id
      from public.account_members m
     where m.account_id = p_account_id
       and m.role = 'owner'
       and m.deleted_at is null
     order by m.created_at
     limit 1;
  end if;

  if v_ll_id is not null then
    insert into public.comm_thread_participants (account_id, thread_id, party_type, party_id)
    values (p_account_id, v_thread_id, 'landlord_user', v_ll_id)
    returning id into v_ll_part_id;

    v_ll_email := p_landlord_address;
    if v_ll_email is null then
      -- Live claims only; prefer human_link, then verified, then newest.
      select ci.address into v_ll_email
        from public.channel_identities ci
       where ci.account_id = p_account_id
         and ci.channel = 'email'
         and ci.party_type = 'landlord_user'
         and ci.party_id = v_ll_id
         and ci.superseded_at is null
       order by (ci.source = 'human_link') desc,
                (ci.verified_at is not null
                  or ci.source in ('thread_rebind', 'parent_recipient', 'authoritative_import')) desc,
                ci.created_at desc, ci.id
       limit 1;
    end if;

    if v_ll_email is not null then
      insert into public.thread_channel_bindings
        (account_id, thread_id, participant_id, participant_address, reply_address)
      values (
        p_account_id, v_thread_id, v_ll_part_id, v_ll_email,
        't-' || encode(extensions.gen_random_bytes(16), 'hex') || '@' || lower(p_reply_domain)
      );
    end if;
  end if;

  thread_id := v_thread_id; cp_participant_id := v_part_id; tenancy_id := v_tenancy_id;
  return next;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."rent_rollup"("p_account_id" "uuid", "p_statuses" "text"[] DEFAULT ARRAY['active'::"text", 'holdover'::"text"], "p_as_of" "date" DEFAULT ((now() at time zone 'UTC')::date)) RETURNS TABLE("tenancy_id" "uuid", "status" "text", "currency" "text", "rent_balance_cents" bigint, "deposit_balance_cents" bigint, "unapplied_credit_cents" bigint, "non_deposit_overdue_cents" bigint, "non_deposit_due_today_cents" bigint, "non_deposit_upcoming_cents" bigint, "deposit_owed_cents" bigint, "deposit_held_cents" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  with t as (
    select id, public.effective_tenancy_status(tenancies.status,tenancies.start_date) as status
      from public.tenancies
     where account_id = p_account_id
       and deleted_at is null
       and public.effective_tenancy_status(tenancies.status,tenancies.start_date) = any(coalesce(p_statuses, array['active', 'holdover']))
  ),
  live_charges as (
    select c.id, c.tenancy_id, c.type, c.amount_cents, c.due_date
      from public.charges c
      join t on t.id = c.tenancy_id
     where c.account_id = p_account_id
       and c.deleted_at is null
       and c.voided_at is null
  ),
  live_payments as (
    select p.tenancy_id, sum(p.amount_cents) as received
      from public.payments p
      join t on t.id = p.tenancy_id
     where p.account_id = p_account_id
       and p.deleted_at is null
       and p.voided_at is null
     group by p.tenancy_id
  ),
  active_allocations_by_charge as (
    select c.id as charge_id, c.tenancy_id, sum(a.amount_cents) as allocated
      from public.payment_allocations a
      join live_charges c on c.id = a.charge_id
      join public.payments p
        on p.account_id = a.account_id
       and p.id = a.payment_id
       and p.tenancy_id = c.tenancy_id
     where a.account_id = p_account_id
       and a.deleted_at is null
       and a.voided_at is null
       and p.deleted_at is null
       and p.voided_at is null
     group by c.id, c.tenancy_id
  ),
  charge_balances as (
    select c.*,
           coalesce(a.allocated, 0)::bigint as allocated,
           (c.amount_cents - coalesce(a.allocated, 0))::bigint as open_balance
      from live_charges c
      left join active_allocations_by_charge a on a.charge_id = c.id
  ),
  money as (
    select cb.tenancy_id,
           coalesce(sum(cb.open_balance) filter (where cb.type <> 'deposit'), 0)::bigint
             as rent_balance,
           coalesce(sum(cb.open_balance) filter (where cb.type = 'deposit'), 0)::bigint
             as deposit_owed,
           coalesce(sum(cb.allocated) filter (where cb.type = 'deposit'), 0)::bigint
             as deposit_held,
           coalesce(sum(cb.open_balance) filter (
             where cb.type <> 'deposit' and cb.due_date < p_as_of
           ), 0)::bigint as overdue,
           coalesce(sum(cb.open_balance) filter (
             where cb.type <> 'deposit' and cb.due_date = p_as_of
           ), 0)::bigint as due_today,
           coalesce(sum(cb.open_balance) filter (
             where cb.type <> 'deposit' and cb.due_date > p_as_of
           ), 0)::bigint as upcoming,
           coalesce(sum(cb.allocated), 0)::bigint as total_allocated
      from charge_balances cb
     group by cb.tenancy_id
  ),
  currencies as (
    select t.id as tenancy_id,
           (select min(c.currency) from public.charges c
             where c.account_id = p_account_id and c.tenancy_id = t.id
               and c.deleted_at is null) as charge_currency,
           (select min(p.currency) from public.payments p
             where p.account_id = p_account_id and p.tenancy_id = t.id
               and p.deleted_at is null) as payment_currency
      from t
  )
  select t.id,
         t.status,
         coalesce(cu.charge_currency, cu.payment_currency),
         coalesce(m.rent_balance, 0)::bigint,
         coalesce(m.deposit_owed, 0)::bigint,
         (coalesce(lp.received, 0) - coalesce(m.total_allocated, 0))::bigint,
         coalesce(m.overdue, 0)::bigint,
         coalesce(m.due_today, 0)::bigint,
         coalesce(m.upcoming, 0)::bigint,
         coalesce(m.deposit_owed, 0)::bigint,
         coalesce(m.deposit_held, 0)::bigint
    from t
    left join money         m  on m.tenancy_id = t.id
    left join live_payments lp on lp.tenancy_id = t.id
    left join currencies    cu on cu.tenancy_id = t.id
   where t.status <> 'ended'
      or coalesce(m.rent_balance, 0) <> 0
      or coalesce(m.deposit_owed, 0) <> 0
      or coalesce(m.deposit_held, 0) <> 0
      or (coalesce(lp.received, 0) - coalesce(m.total_allocated, 0)) <> 0
$$;

revoke all on function public._persona_find_or_create_thread(uuid,text,uuid,text,text,text,uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public._persona_find_or_create_thread(uuid,text,uuid,text,text,text,uuid,text,uuid,uuid) to service_role;
