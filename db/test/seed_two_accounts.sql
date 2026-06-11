-- ----------------------------------------------------------------------------
-- Isolation-test seed: two accounts (A, B), each owned by one user, each with
-- a row in EVERY domain table. The test then logs in as A and asserts it
-- cannot see a single row from B, on every table.
--
-- Fixed UUIDs so the TS test can reference them without round-tripping:
--
--   account A : 11111111-1111-1111-1111-111111111111
--   account B : 22222222-2222-2222-2222-222222222222
--   user A    : aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
--   user B    : bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
--
-- These uuid strings parse fine even though they're not version-4 compliant;
-- postgres' uuid type doesn't enforce the version/variant bits.
-- ----------------------------------------------------------------------------

-- The seed runs as the postgres superuser (bypasses RLS for the inserts).
-- The actual isolation test then SET ROLE authenticated and runs queries
-- under the policy regime.

do $$
declare
  -- Identity
  v_acc_a  uuid := '11111111-1111-1111-1111-111111111111';
  v_acc_b  uuid := '22222222-2222-2222-2222-222222222222';
  v_user_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_user_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  -- Per-account entity ids — declared then assigned in begin so we can
  -- reuse them across many inserts.
  v_prop_a uuid; v_prop_b uuid;
  v_unit_a uuid; v_unit_b uuid;
  v_common_a uuid; v_common_b uuid;
  v_tenant_a uuid; v_tenant_b uuid;
  v_tenancy_a uuid; v_tenancy_b uuid;
  v_tt_a uuid; v_tt_b uuid;
  v_lease_a uuid; v_lease_b uuid;
  v_vendor_a uuid; v_vendor_b uuid;
  v_asset_a uuid; v_asset_b uuid;
  v_req_a uuid; v_req_b uuid;
  v_wo_a uuid; v_wo_b uuid;
  v_tpl_a uuid; v_tpl_b uuid;
  v_insp_a uuid; v_insp_b uuid;
  v_item_a uuid; v_item_b uuid;
  v_att_a uuid; v_att_b uuid;
  v_int_a uuid; v_int_b uuid;
  v_notice_a uuid; v_notice_b uuid;
  v_st_a uuid; v_st_b uuid;
  v_rs_a uuid; v_rs_b uuid;
  v_charge_a uuid; v_charge_b uuid;
  v_pay_a uuid; v_pay_b uuid;
begin
  -- Identity
  insert into auth.users (id, email) values
    (v_user_a, 'alice@example.com'),
    (v_user_b, 'bob@example.com');

  insert into public.accounts (id, name) values
    (v_acc_a, 'Account A'),
    (v_acc_b, 'Account B');

  insert into public.users (id, display_name) values
    (v_user_a, 'Alice'),
    (v_user_b, 'Bob');

  insert into public.account_members (account_id, user_id, role) values
    (v_acc_a, v_user_a, 'owner'),
    (v_acc_b, v_user_b, 'owner');

  -- Places
  v_prop_a := gen_random_uuid(); v_prop_b := gen_random_uuid();
  insert into public.properties (id, account_id, name) values
    (v_prop_a, v_acc_a, 'A House'),
    (v_prop_b, v_acc_b, 'B House');

  v_unit_a := gen_random_uuid(); v_unit_b := gen_random_uuid();
  v_common_a := gen_random_uuid(); v_common_b := gen_random_uuid();
  insert into public.areas (id, account_id, property_id, kind, name) values
    (v_unit_a,   v_acc_a, v_prop_a, 'unit',    'A Unit 1'),
    (v_unit_b,   v_acc_b, v_prop_b, 'unit',    'B Unit 1'),
    (v_common_a, v_acc_a, v_prop_a, 'hallway', 'A Hallway'),
    (v_common_b, v_acc_b, v_prop_b, 'hallway', 'B Hallway');

  insert into public.unit_details (area_id, account_id, bedrooms, bathrooms, sqft) values
    (v_unit_a, v_acc_a, 2, 1.0, 700),
    (v_unit_b, v_acc_b, 1, 1.0, 500);

  -- Tenants & occupancy
  v_tenant_a := gen_random_uuid(); v_tenant_b := gen_random_uuid();
  insert into public.tenants (id, account_id, full_name) values
    (v_tenant_a, v_acc_a, 'Tina A'),
    (v_tenant_b, v_acc_b, 'Tomas B');

  v_tenancy_a := gen_random_uuid(); v_tenancy_b := gen_random_uuid();
  insert into public.tenancies (id, account_id, area_id, start_date, status) values
    (v_tenancy_a, v_acc_a, v_unit_a, '2026-01-01', 'active'),
    (v_tenancy_b, v_acc_b, v_unit_b, '2026-01-01', 'active');

  v_tt_a := gen_random_uuid(); v_tt_b := gen_random_uuid();
  insert into public.tenancy_tenants (id, account_id, tenancy_id, tenant_id, role) values
    (v_tt_a, v_acc_a, v_tenancy_a, v_tenant_a, 'primary'),
    (v_tt_b, v_acc_b, v_tenancy_b, v_tenant_b, 'primary');

  v_lease_a := gen_random_uuid(); v_lease_b := gen_random_uuid();
  insert into public.leases (
    id, account_id, tenancy_id, term_start, term_end,
    rent_amount_cents, rent_currency, deposit_amount_cents, deposit_currency, status
  ) values
    (v_lease_a, v_acc_a, v_tenancy_a, '2026-01-01', '2026-12-31',
       120000, 'USD', 120000, 'USD', 'active'),
    (v_lease_b, v_acc_b, v_tenancy_b, '2026-01-01', '2026-12-31',
        90000, 'USD',  90000, 'USD', 'active');

  -- Vendors & assets
  v_vendor_a := gen_random_uuid(); v_vendor_b := gen_random_uuid();
  insert into public.vendors (id, account_id, name) values
    (v_vendor_a, v_acc_a, 'A Plumbing'),
    (v_vendor_b, v_acc_b, 'B Plumbing');

  v_asset_a := gen_random_uuid(); v_asset_b := gen_random_uuid();
  insert into public.assets (id, account_id, area_id, name, kind) values
    (v_asset_a, v_acc_a, v_unit_a, 'A Water Heater', 'water_heater'),
    (v_asset_b, v_acc_b, v_unit_b, 'B Water Heater', 'water_heater');

  -- Maintenance
  v_req_a := gen_random_uuid(); v_req_b := gen_random_uuid();
  insert into public.maintenance_requests (
    id, account_id, area_id, asset_id, opened_by, title, severity, status
  ) values
    (v_req_a, v_acc_a, v_unit_a, v_asset_a, v_user_a, 'A leak', 'routine', 'open'),
    (v_req_b, v_acc_b, v_unit_b, v_asset_b, v_user_b, 'B leak', 'routine', 'open');

  v_wo_a := gen_random_uuid(); v_wo_b := gen_random_uuid();
  insert into public.work_orders (
    id, account_id, maintenance_request_id, area_id, vendor_id, summary, status
  ) values
    (v_wo_a, v_acc_a, v_req_a, v_unit_a, v_vendor_a, 'Dispatch A plumber', 'scheduled'),
    (v_wo_b, v_acc_b, v_req_b, v_unit_b, v_vendor_b, 'Dispatch B plumber', 'scheduled');

  -- Inspections
  v_tpl_a := gen_random_uuid(); v_tpl_b := gen_random_uuid();
  insert into public.inspection_templates (id, account_id, name) values
    (v_tpl_a, v_acc_a, 'A Move-in'),
    (v_tpl_b, v_acc_b, 'B Move-in');

  v_insp_a := gen_random_uuid(); v_insp_b := gen_random_uuid();
  insert into public.inspections (
    id, account_id, area_id, template_id, performed_by, performed_at
  ) values
    (v_insp_a, v_acc_a, v_unit_a, v_tpl_a, v_user_a, '2026-01-15T10:00:00Z'),
    (v_insp_b, v_acc_b, v_unit_b, v_tpl_b, v_user_b, '2026-01-15T10:00:00Z');

  v_item_a := gen_random_uuid(); v_item_b := gen_random_uuid();
  insert into public.inspection_items (
    id, account_id, inspection_id, label, condition
  ) values
    (v_item_a, v_acc_a, v_insp_a, 'Kitchen faucet', 'ok'),
    (v_item_b, v_acc_b, v_insp_b, 'Kitchen faucet', 'ok');

  -- Attachments & interactions
  v_att_a := gen_random_uuid(); v_att_b := gen_random_uuid();
  insert into public.attachments (
    id, account_id, entity_type, entity_id, storage_path, content_hash
  ) values
    (v_att_a, v_acc_a, 'maintenance_request', v_req_a,
       'a/req/photo.jpg', repeat('a', 64)),
    (v_att_b, v_acc_b, 'maintenance_request', v_req_b,
       'b/req/photo.jpg', repeat('b', 64));

  v_int_a := gen_random_uuid(); v_int_b := gen_random_uuid();
  insert into public.interactions (
    id, account_id, actor, party_type, party_id, channel, direction,
    body, occurred_at, tenancy_id, area_id
  ) values
    (v_int_a, v_acc_a, 'user:' || v_user_a::text, 'tenant', v_tenant_a,
       'phone', 'inbound', 'A called about leak',  '2026-02-01T09:00:00Z',
       v_tenancy_a, v_unit_a),
    (v_int_b, v_acc_b, 'user:' || v_user_b::text, 'tenant', v_tenant_b,
       'phone', 'inbound', 'B called about leak',  '2026-02-01T09:00:00Z',
       v_tenancy_b, v_unit_b);

  -- Notices & scheduled tasks
  v_notice_a := gen_random_uuid(); v_notice_b := gen_random_uuid();
  insert into public.notices (
    id, account_id, tenancy_id, notice_type, served_at
  ) values
    (v_notice_a, v_acc_a, v_tenancy_a, 'entry_notice', '2026-02-10T12:00:00Z'),
    (v_notice_b, v_acc_b, v_tenancy_b, 'entry_notice', '2026-02-10T12:00:00Z');

  v_st_a := gen_random_uuid(); v_st_b := gen_random_uuid();
  insert into public.scheduled_tasks (
    id, account_id, area_id, kind, recurrence, next_run
  ) values
    (v_st_a, v_acc_a, v_unit_a, 'smoke_detector_test', 'P6M', '2026-07-01T12:00:00Z'),
    (v_st_b, v_acc_b, v_unit_b, 'smoke_detector_test', 'P6M', '2026-07-01T12:00:00Z');

  -- Rent subledger
  v_rs_a := gen_random_uuid(); v_rs_b := gen_random_uuid();
  insert into public.rent_schedules (
    id, account_id, tenancy_id, kind, amount_cents, currency, due_day, start_date
  ) values
    (v_rs_a, v_acc_a, v_tenancy_a, 'rent', 120000, 'USD', 1, '2026-01-01'),
    (v_rs_b, v_acc_b, v_tenancy_b, 'rent',  90000, 'USD', 1, '2026-01-01');

  v_charge_a := gen_random_uuid(); v_charge_b := gen_random_uuid();
  insert into public.charges (
    id, account_id, tenancy_id, type, amount_cents, currency, due_date,
    source_schedule_id, period_start, period_end
  ) values
    (v_charge_a, v_acc_a, v_tenancy_a, 'rent', 120000, 'USD', '2026-02-01',
       v_rs_a, '2026-02-01', '2026-02-28'),
    (v_charge_b, v_acc_b, v_tenancy_b, 'rent',  90000, 'USD', '2026-02-01',
       v_rs_b, '2026-02-01', '2026-02-28');

  v_pay_a := gen_random_uuid(); v_pay_b := gen_random_uuid();
  insert into public.payments (
    id, account_id, tenancy_id, amount_cents, currency, received_at,
    method, payer_tenant_id
  ) values
    (v_pay_a, v_acc_a, v_tenancy_a, 70000, 'USD', '2026-02-03T12:00:00Z',
       'check', v_tenant_a),
    (v_pay_b, v_acc_b, v_tenancy_b, 50000, 'USD', '2026-02-03T12:00:00Z',
       'check', v_tenant_b);

  insert into public.payment_allocations (
    account_id, payment_id, charge_id, amount_cents
  ) values
    (v_acc_a, v_pay_a, v_charge_a, 70000),
    (v_acc_b, v_pay_b, v_charge_b, 50000);
end $$;

-- Phase 3 (ADR-0002): establish a chain watermark per account so the
-- isolation sweep sees chain_watermarks populated for BOTH accounts (its
-- per-table "own rows > 0" requirement). Uses the real sweep, which also
-- verifies the just-seeded chains end-to-end.
select public.verify_chain_sweep('11111111-1111-1111-1111-111111111111');
select public.verify_chain_sweep('22222222-2222-2222-2222-222222222222');
