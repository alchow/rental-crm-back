-- ----------------------------------------------------------------------------
-- Phase 2: data spine + default-deny tenant isolation.
--
-- Scope: identity/account, places, occupancy, leases, rent subledger, and
-- the remaining domain tables. RLS is force-enabled on every table and a
-- default-deny + per-account membership policy is applied. NO audit triggers
-- here -- that's Phase 3 (events table + AFTER INSERT/UPDATE/DELETE on every
-- domain table + per-account hash chain + verify_chain).
--
-- Naming: snake_case throughout. PKs are uuid via gen_random_uuid(). Money is
-- integer minor units (*_cents) + explicit *_currency. Soft-delete columns
-- (deleted_at) are declared now; the tombstone-event integration is Phase 3.
--
-- Cross-tenant integrity: child rows declare account_id explicitly and use a
-- composite FK (account_id, parent_id) -> parent(account_id, id) so a row
-- cannot point at a parent in another account. This is the data-layer mirror
-- of the application-layer account scoping.
-- ----------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. Identity / account
-- ============================================================================

create table public.accounts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Profile mirror of auth.users. Populated on signup (Phase 4).
create table public.users (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create table public.account_members (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner', 'manager', 'viewer')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (account_id, user_id)
);
create index account_members_account_id_idx on public.account_members (account_id);
create index account_members_user_id_idx    on public.account_members (user_id);

-- Composite uniqueness so child tables can FK on (account_id, id).
alter table public.accounts add constraint accounts_account_id_id_uk unique (id);

-- ----------------------------------------------------------------------------
-- Helper: is the current auth user a (non-deleted) member of this account?
-- security invoker so account_members' own RLS still applies (users see their
-- own membership rows; no cross-user reads).
-- ----------------------------------------------------------------------------
create or replace function public.is_account_member(p_account_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.account_members m
    where m.account_id = p_account_id
      and m.user_id    = (select auth.uid())
      and m.deleted_at is null
  );
$$;

-- ============================================================================
-- 2. Places: properties, areas (unit-as-area), unit_details
-- ============================================================================

create table public.properties (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null,
  name        text not null check (length(name) between 1 and 200),
  address     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  foreign key (account_id) references public.accounts(id) on delete restrict,
  -- Composite uniqueness so child tables can FK on (account_id, id).
  unique (account_id, id)
);
create index properties_account_id_idx on public.properties (account_id);

create table public.areas (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null,
  property_id  uuid not null,
  kind         text not null check (kind in (
                 'unit',
                 'entrance', 'hallway', 'stairwell',
                 'basement_mechanical', 'laundry', 'parking',
                 'roof', 'exterior_grounds', 'common_other'
               )),
  name         text not null check (length(name) between 1 and 200),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  -- Composite FK enforces area.account_id = property.account_id at the DB.
  foreign key (account_id, property_id) references public.properties(account_id, id) on delete restrict,
  unique (account_id, id)
);
create index areas_account_id_idx  on public.areas (account_id);
create index areas_property_id_idx on public.areas (property_id);
create index areas_kind_idx        on public.areas (kind);

-- 1:1 extension for unit-only attributes. Trigger enforces area.kind = 'unit'.
create table public.unit_details (
  area_id    uuid primary key,
  account_id uuid not null,
  bedrooms   int  check (bedrooms is null or bedrooms >= 0),
  bathrooms  numeric(3,1) check (bathrooms is null or bathrooms >= 0),
  sqft       int  check (sqft is null or sqft >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (account_id, area_id) references public.areas(account_id, id) on delete cascade
);
create index unit_details_account_id_idx on public.unit_details (account_id);

create or replace function public._assert_area_is_unit()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  select kind into v_kind from public.areas where id = new.area_id;
  if v_kind is null then
    raise exception 'area % not found', new.area_id;
  end if;
  if v_kind <> 'unit' then
    raise exception 'area % has kind %, expected unit', new.area_id, v_kind;
  end if;
  return new;
end;
$$;

create trigger unit_details_area_kind_check
  before insert or update of area_id on public.unit_details
  for each row execute function public._assert_area_is_unit();

-- ============================================================================
-- 3. Tenants
-- ============================================================================

create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts(id) on delete restrict,
  full_name   text not null check (length(full_name) between 1 and 200),
  emails      text[] not null default '{}',
  phones      text[] not null default '{}',
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (account_id, id)
);
create index tenants_account_id_idx on public.tenants (account_id);

-- ============================================================================
-- 4. Occupancy & contract: tenancies, tenancy_tenants, leases
-- ============================================================================

create table public.tenancies (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null,
  area_id     uuid not null,
  start_date  date not null,
  end_date    date,
  status      text not null check (status in ('upcoming', 'active', 'ended', 'holdover')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  foreign key (account_id, area_id) references public.areas(account_id, id) on delete restrict,
  check (end_date is null or end_date >= start_date),
  unique (account_id, id)
);
create index tenancies_account_id_idx on public.tenancies (account_id);
create index tenancies_area_id_idx    on public.tenancies (area_id);
create index tenancies_status_idx     on public.tenancies (status);

create trigger tenancies_area_kind_check
  before insert or update of area_id on public.tenancies
  for each row execute function public._assert_area_is_unit();

create table public.tenancy_tenants (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null,
  tenancy_id   uuid not null,
  tenant_id    uuid not null,
  role         text not null check (role in ('primary', 'occupant', 'guarantor')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  foreign key (account_id, tenancy_id) references public.tenancies(account_id, id) on delete cascade,
  foreign key (account_id, tenant_id)  references public.tenants(account_id, id)   on delete restrict,
  unique (tenancy_id, tenant_id, role)
);
create index tenancy_tenants_account_id_idx on public.tenancy_tenants (account_id);
create index tenancy_tenants_tenancy_id_idx on public.tenancy_tenants (tenancy_id);
create index tenancy_tenants_tenant_id_idx  on public.tenancy_tenants (tenant_id);

-- Leases: zero, one, or many per tenancy. A tenancy never requires a lease.
create table public.leases (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null,
  tenancy_id            uuid not null,
  term_start            date not null,
  term_end              date,
  rent_amount_cents     bigint not null check (rent_amount_cents >= 0),
  rent_currency         text   not null check (length(rent_currency) = 3),
  deposit_amount_cents  bigint not null default 0 check (deposit_amount_cents >= 0),
  deposit_currency      text,
  document              jsonb not null default '{}'::jsonb,
  status                text not null check (status in ('draft', 'active', 'expired', 'superseded')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  foreign key (account_id, tenancy_id) references public.tenancies(account_id, id) on delete restrict,
  check (term_end is null or term_end >= term_start),
  check (deposit_amount_cents = 0 or deposit_currency is not null),
  unique (account_id, id)
);
create index leases_account_id_idx on public.leases (account_id);
create index leases_tenancy_id_idx on public.leases (tenancy_id);

-- ============================================================================
-- 5. Vendors, assets
-- ============================================================================

create table public.vendors (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts(id) on delete restrict,
  name        text not null check (length(name) between 1 and 200),
  contact     jsonb not null default '{}'::jsonb,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (account_id, id)
);
create index vendors_account_id_idx on public.vendors (account_id);

create table public.assets (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null,
  area_id      uuid not null,
  name         text not null check (length(name) between 1 and 200),
  kind         text not null check (length(kind)  between 1 and 100),
  attributes   jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  foreign key (account_id, area_id) references public.areas(account_id, id) on delete restrict,
  unique (account_id, id)
);
create index assets_account_id_idx on public.assets (account_id);
create index assets_area_id_idx    on public.assets (area_id);

-- ============================================================================
-- 6. Maintenance flow: maintenance_requests, work_orders
-- ============================================================================

create table public.maintenance_requests (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  area_id       uuid not null,
  asset_id      uuid,
  opened_by     uuid references auth.users(id) on delete set null,
  -- An inbound tenant intake records its token id here (Phase 7). Null for landlord-initiated.
  intake_token  text,
  title         text not null check (length(title) between 1 and 200),
  description   text,
  severity      text not null check (severity in ('low', 'medium', 'high', 'urgent')),
  status        text not null check (status in ('open', 'triaged', 'in_progress', 'resolved', 'closed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (account_id, area_id)  references public.areas(account_id, id)  on delete restrict,
  foreign key (account_id, asset_id) references public.assets(account_id, id) on delete set null,
  unique (account_id, id)
);
create index maintenance_requests_account_id_idx on public.maintenance_requests (account_id);
create index maintenance_requests_area_id_idx    on public.maintenance_requests (area_id);
create index maintenance_requests_status_idx     on public.maintenance_requests (status);

create table public.work_orders (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid not null,
  maintenance_request_id  uuid,
  area_id                 uuid not null,
  vendor_id               uuid,
  summary                 text not null check (length(summary) between 1 and 500),
  status                  text not null check (status in ('scheduled', 'in_progress', 'completed', 'cancelled')),
  scheduled_for           timestamptz,
  completed_at            timestamptz,
  cost_cents              bigint check (cost_cents is null or cost_cents >= 0),
  cost_currency           text   check (cost_currency is null or length(cost_currency) = 3),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  foreign key (account_id, maintenance_request_id)
    references public.maintenance_requests(account_id, id) on delete set null,
  foreign key (account_id, area_id)   references public.areas(account_id, id)   on delete restrict,
  foreign key (account_id, vendor_id) references public.vendors(account_id, id) on delete set null,
  check ((cost_cents is null) = (cost_currency is null)),
  unique (account_id, id)
);
create index work_orders_account_id_idx on public.work_orders (account_id);
create index work_orders_request_id_idx on public.work_orders (maintenance_request_id);
create index work_orders_area_id_idx    on public.work_orders (area_id);

-- ============================================================================
-- 7. Inspections
-- ============================================================================

create table public.inspection_templates (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete restrict,
  name         text not null check (length(name) between 1 and 200),
  -- schema: jsonb description of items (label, group, expected condition values, etc.)
  schema       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (account_id, id)
);
create index inspection_templates_account_id_idx on public.inspection_templates (account_id);

create table public.inspections (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  area_id       uuid not null,
  template_id   uuid,
  performed_by  uuid references auth.users(id) on delete set null,
  performed_at  timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (account_id, area_id)     references public.areas(account_id, id)                on delete restrict,
  foreign key (account_id, template_id) references public.inspection_templates(account_id, id) on delete set null,
  unique (account_id, id)
);
create index inspections_account_id_idx  on public.inspections (account_id);
create index inspections_area_id_idx     on public.inspections (area_id);
create index inspections_template_id_idx on public.inspections (template_id);

create table public.inspection_items (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null,
  inspection_id  uuid not null,
  label          text not null check (length(label) between 1 and 200),
  condition      text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  foreign key (account_id, inspection_id) references public.inspections(account_id, id) on delete cascade,
  unique (account_id, id)
);
create index inspection_items_account_id_idx    on public.inspection_items (account_id);
create index inspection_items_inspection_id_idx on public.inspection_items (inspection_id);

-- ============================================================================
-- 8. Attachments (polymorphic) + interactions
-- ============================================================================

create table public.attachments (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.accounts(id) on delete restrict,
  entity_type    text not null check (length(entity_type) between 1 and 100),
  entity_id      uuid not null,
  storage_path   text not null check (length(storage_path) between 1 and 1024),
  content_hash   text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  mime_type      text,
  size_bytes     bigint check (size_bytes is null or size_bytes >= 0),
  uploaded_by    uuid references auth.users(id) on delete set null,
  -- Server-set; immutable in Phase 3 via the audit spine.
  received_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  unique (account_id, id)
);
create index attachments_account_id_idx on public.attachments (account_id);
create index attachments_entity_idx     on public.attachments (entity_type, entity_id);

-- interactions: single channel-aware contact log. occurred_at is user-stated
-- (editable, audit-tracked). logged_at is server-set; the immutable-from-client
-- guarantee is enforced by Phase 3's audit spine.
create table public.interactions (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid not null references public.accounts(id) on delete restrict,
  -- actor format: 'user:<uuid>' | 'tenant:<token_id>' | 'system' | 'other:<label>'
  actor                   text not null check (length(actor) between 1 and 200),
  party_type              text not null check (party_type in ('tenant', 'vendor', 'inspector', 'other')),
  party_id                uuid,
  party_label             text,
  channel                 text not null check (channel in (
                            'in_person', 'phone', 'voicemail',
                            'sms', 'email', 'letter', 'in_app'
                          )),
  direction               text not null check (direction in ('inbound', 'outbound')),
  body                    text,
  occurred_at             timestamptz not null,
  logged_at               timestamptz not null default now(),
  tenancy_id              uuid,
  maintenance_request_id  uuid,
  area_id                 uuid,
  work_order_id           uuid,
  vendor_id               uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  foreign key (account_id, tenancy_id)             references public.tenancies(account_id, id)             on delete set null,
  foreign key (account_id, maintenance_request_id) references public.maintenance_requests(account_id, id) on delete set null,
  foreign key (account_id, area_id)                references public.areas(account_id, id)                on delete set null,
  foreign key (account_id, work_order_id)          references public.work_orders(account_id, id)          on delete set null,
  foreign key (account_id, vendor_id)              references public.vendors(account_id, id)              on delete set null,
  unique (account_id, id)
);
create index interactions_account_id_idx   on public.interactions (account_id);
create index interactions_occurred_at_idx  on public.interactions (occurred_at);
create index interactions_tenancy_idx      on public.interactions (tenancy_id)             where tenancy_id is not null;
create index interactions_request_idx      on public.interactions (maintenance_request_id) where maintenance_request_id is not null;

-- ============================================================================
-- 9. Notices, scheduled_tasks
-- ============================================================================

create table public.notices (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  tenancy_id    uuid not null,
  notice_type   text not null check (length(notice_type) between 1 and 100),
  served_at     timestamptz,
  served_method text,
  body          text,
  document      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (account_id, tenancy_id) references public.tenancies(account_id, id) on delete restrict,
  unique (account_id, id)
);
create index notices_account_id_idx on public.notices (account_id);
create index notices_tenancy_id_idx on public.notices (tenancy_id);

create table public.scheduled_tasks (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null,
  area_id     uuid,
  asset_id    uuid,
  kind        text not null check (length(kind) between 1 and 100),
  -- recurrence: either a cron expression or an iso8601 interval; opaque here, parsed in Phase 9
  recurrence  text not null check (length(recurrence) between 1 and 200),
  next_run    timestamptz,
  last_run    timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  foreign key (account_id, area_id)  references public.areas(account_id, id)  on delete cascade,
  foreign key (account_id, asset_id) references public.assets(account_id, id) on delete cascade,
  check (area_id is not null or asset_id is not null),
  unique (account_id, id)
);
create index scheduled_tasks_account_id_idx on public.scheduled_tasks (account_id);
create index scheduled_tasks_next_run_idx   on public.scheduled_tasks (next_run);

-- ============================================================================
-- 10. Rent subledger: rent_schedules, charges, payments, payment_allocations
-- ============================================================================

create table public.rent_schedules (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null,
  tenancy_id   uuid not null,
  kind         text not null check (length(kind) between 1 and 50),
  amount_cents bigint not null check (amount_cents >= 0),
  currency     text   not null check (length(currency) = 3),
  due_day      int    not null check (due_day between 1 and 28),
  start_date   date not null,
  end_date     date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  foreign key (account_id, tenancy_id) references public.tenancies(account_id, id) on delete cascade,
  check (end_date is null or end_date >= start_date),
  unique (account_id, id)
);
create index rent_schedules_account_id_idx on public.rent_schedules (account_id);
create index rent_schedules_tenancy_id_idx on public.rent_schedules (tenancy_id);

create table public.charges (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null,
  tenancy_id          uuid not null,
  type                text not null check (type in (
                        'rent', 'late_fee', 'deposit', 'utility',
                        'parking', 'repair_chargeback', 'nsf_fee', 'other'
                      )),
  amount_cents        bigint not null check (amount_cents >= 0),
  currency            text   not null check (length(currency) = 3),
  due_date            date not null,
  period_start        date,
  period_end          date,
  description         text,
  source_schedule_id  uuid,
  -- Void is a state, not a delete. The original row stays. A reversing entry
  -- (e.g., nsf_fee) is recorded as a separate charge in Phase 6.
  voided_at           timestamptz,
  void_reason         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  foreign key (account_id, tenancy_id)         references public.tenancies(account_id, id)      on delete restrict,
  foreign key (account_id, source_schedule_id) references public.rent_schedules(account_id, id) on delete set null,
  check (period_start is null or period_end is null or period_end >= period_start),
  unique (account_id, id)
);
create index charges_account_id_idx on public.charges (account_id);
create index charges_tenancy_id_idx on public.charges (tenancy_id);
create index charges_due_date_idx   on public.charges (due_date);

create table public.payments (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null,
  tenancy_id         uuid not null,
  amount_cents       bigint not null check (amount_cents >= 0),
  currency           text   not null check (length(currency) = 3),
  received_at        timestamptz not null,
  method             text not null check (method in (
                       'cash', 'check', 'ach', 'card',
                       'zelle_venmo', 'money_order', 'other'
                     )),
  reference          text,
  payer_tenant_id    uuid,
  processor_ref      text,
  notes              text,
  idempotency_key    text,
  -- Reversal-not-mutation: bounced check / mis-entered cash = void this row
  -- and record a reversing entry (negative payment) in Phase 6.
  voided_at          timestamptz,
  void_reason        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  foreign key (account_id, tenancy_id)      references public.tenancies(account_id, id) on delete restrict,
  foreign key (account_id, payer_tenant_id) references public.tenants(account_id, id)   on delete set null,
  unique (account_id, id),
  -- Idempotency is per-account, not global.
  unique (account_id, idempotency_key)
);
create index payments_account_id_idx  on public.payments (account_id);
create index payments_tenancy_id_idx  on public.payments (tenancy_id);
create index payments_received_at_idx on public.payments (received_at);

create table public.payment_allocations (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null,
  payment_id    uuid not null,
  charge_id     uuid not null,
  amount_cents  bigint not null check (amount_cents >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  foreign key (account_id, payment_id) references public.payments(account_id, id) on delete cascade,
  foreign key (account_id, charge_id)  references public.charges(account_id, id)  on delete restrict,
  unique (payment_id, charge_id)
);
create index payment_allocations_account_id_idx on public.payment_allocations (account_id);
create index payment_allocations_payment_id_idx on public.payment_allocations (payment_id);
create index payment_allocations_charge_id_idx  on public.payment_allocations (charge_id);

-- ============================================================================
-- 11. Default-deny RLS + per-account policies
--
-- Pattern:
--   - alter table ... enable row level security;
--   - alter table ... force row level security;     (covers owners too)
--   - create policy <name> on <table> for all
--       using       (is_account_member(account_id))
--       with check  (is_account_member(account_id));
--
-- account_members itself has a narrower self-only SELECT policy; insert/update
-- of memberships happens via the API admin path (Phase 4+).
-- accounts has a member-only SELECT (you can see accounts you belong to).
-- users (profile mirror) has a self-only policy keyed off auth.uid().
-- ============================================================================

-- 1. accounts: member-only SELECT. Writes via admin path.
alter table public.accounts enable row level security;
alter table public.accounts force  row level security;
create policy accounts_member_select on public.accounts
  for select using (public.is_account_member(id));

-- 2. users (profile mirror): users see and edit only their own row.
alter table public.users enable row level security;
alter table public.users force  row level security;
create policy users_self_select on public.users
  for select using (id = (select auth.uid()));
create policy users_self_update on public.users
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- Insert happens via the admin path on signup (Phase 4); no public insert.

-- 3. account_members: members see ONLY their own membership rows.
alter table public.account_members enable row level security;
alter table public.account_members force  row level security;
create policy account_members_self_select on public.account_members
  for select using (user_id = (select auth.uid()));
-- All other operations via admin path.

-- 4. All remaining domain tables: full per-account access (members can CRUD
--    rows in accounts they belong to). Role-based gating (viewer/manager/
--    owner) is layered in later phases as needed.
do $$
declare
  t text;
  tables text[] := array[
    'properties', 'areas', 'unit_details',
    'tenants', 'tenancies', 'tenancy_tenants', 'leases',
    'vendors', 'assets',
    'maintenance_requests', 'work_orders',
    'inspection_templates', 'inspections', 'inspection_items',
    'attachments', 'interactions',
    'notices', 'scheduled_tasks',
    'rent_schedules', 'charges', 'payments', 'payment_allocations'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format($f$create policy %I on public.%I
                       for all
                       using      (public.is_account_member(account_id))
                       with check (public.is_account_member(account_id))$f$,
                   t || '_member_all', t);
  end loop;
end $$;

-- ============================================================================
-- 12. Force-RLS assertion: every public table must have RLS on AND at least
--     one policy. Migration fails loudly if anything is missing.
-- ============================================================================

do $$
declare
  no_rls text;
  no_policy text;
begin
  -- Tables in public without RLS enabled.
  select string_agg(c.relname, ', ')
  into no_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;
  if no_rls is not null then
    raise exception 'phase 2: tables in public without RLS enabled: %', no_rls;
  end if;

  -- Tables in public with RLS enabled but no policies.
  select string_agg(c.relname, ', ')
  into no_policy
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not exists (
      select 1 from pg_policy p where p.polrelid = c.oid
    );
  if no_policy is not null then
    raise exception 'phase 2: tables in public without any RLS policy: %', no_policy;
  end if;
end $$;
