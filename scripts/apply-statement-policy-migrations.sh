#!/usr/bin/env bash
# Apply and verify the two statement-redesign migrations, in order:
#   20260801000007_statement_late_fee_policy   (grace/fee policy, charge parenting)
#   20260801000008_nonpayment_notice_class     (fifth notice_class member)
# This interactive script is the operator action; deploys do not apply
# migrations automatically.
#
#   bash scripts/apply-statement-policy-migrations.sh local        # local stack
#   bash scripts/apply-statement-policy-migrations.sh prod         # PROD (pooler + confirm)
#   bash scripts/apply-statement-policy-migrations.sh verify local # verify only
#   bash scripts/apply-statement-policy-migrations.sh verify prod
#
# SAFETY: both migrations are additive and re-runnable (guards in-file). No
# data change, no default, no RLS change, nothing mints charges. Until this
# apply runs, the deployed API answers 503 for requests naming the policy
# columns and 400 for a nonpayment_demand write — loud, not corrupting.
# Apply before any frontend that sends the new fields merges.

set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { printf '\033[33m%s\033[0m' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {
  ask "$1 [y/N] "; read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Stopped — nothing applied. Re-run when ready."; exit 1; }
}

for f in db/supabase/migrations/20260801000007_statement_late_fee_policy.sql \
         db/supabase/migrations/20260801000008_nonpayment_notice_class.sql; do
  [[ -f "$f" ]] || die "migration file not found: $f"
done

# --- Resolve the target DB URL into $DB_URL --------------------------------
# local -> the running Supabase stack's DB_URL (from `supabase status`).
# prod  -> SUPABASE_DB_URL_PROD (env, else .env.local). This is the POOLER URL
#          that survived the IPv6 incident — do NOT swap in db.<ref>.supabase.co.
resolve_db_url() {
  case "$1" in
    local)
      DB_URL="$(supabase status --output env --workdir db 2>/dev/null | grep '^DB_URL=' | cut -d= -f2- | tr -d '"')"
      [[ -n "$DB_URL" ]] || die "could not read DB_URL from 'supabase status' — is the local stack up? (supabase start --workdir db)"
      ;;
    prod)
      if [[ -z "${SUPABASE_DB_URL_PROD:-}" && -f .env.local ]]; then
        SUPABASE_DB_URL_PROD="$(grep '^SUPABASE_DB_URL_PROD=' .env.local | cut -d= -f2- || true)"
      fi
      [[ -n "${SUPABASE_DB_URL_PROD:-}" ]] || die "SUPABASE_DB_URL_PROD not set and not found in .env.local"
      DB_URL="$SUPABASE_DB_URL_PROD"
      ;;
    *) die "unknown target '$1' (expected: local | prod)";;
  esac
}

# --- Read-only snapshot -----------------------------------------------------
# Pre-apply facts. Both migrations are re-runnable, so "already present" is a
# note, not an error — but the operator should know which state they start from.
snapshot() {
  bold "SNAPSHOT (read-only) — pre-apply state"
  read -r -d '' SNAP_SQL <<'SQL' || true
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'rent_schedules'
       and column_name in ('grace_days', 'late_fee_cents'))::int
    as policy_columns_present,           -- 0 pre-apply, 2 post
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'charges'
       and column_name = 'parent_charge_id')::int
    as parent_column_present,            -- 0 pre-apply, 1 post
  (select count(*) from pg_constraint
     where conrelid = 'public.notices'::regclass
       and conname = 'notices_notice_class_check'
       and pg_get_constraintdef(oid) like '%nonpayment_demand%')::int
    as class_has_nonpayment_member,      -- 0 pre-apply, 1 post
  (select count(*) from public.rent_schedules)::int as rent_schedule_rows,
  (select count(*) from public.charges)::int        as charge_rows,
  (select count(*) from public.notices)::int        as notice_rows;
SQL
  SQL="$SNAP_SQL" DB_URL="$DB_URL" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => {
        const v = r.rows[0];
        console.table(v);
        if (Number(v.policy_columns_present) === 2 && Number(v.class_has_nonpayment_member) === 1) {
          console.warn("NOTE: both migrations already applied on this database — the push should list nothing pending for 20260801000007/8.");
        } else {
          console.log("OK: pre-apply state recorded. Both migrations are additive; row counts above must be unchanged by the apply.");
        }
        return c.end();
      })
      .catch((e) => { console.error("SNAPSHOT query failed:", e.message); process.exit(1); });
  '
}

# --- Verify the schema actually landed --------------------------------------
# Asserts every invariant only these two migrations create, plus no-backfill.
verify() {
  bold "VERIFY — columns, constraints, index, 12-arg function, class member, no backfill"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'rent_schedules'
       and column_name in ('grace_days', 'late_fee_cents') and is_nullable = 'YES')::int
    as policy_columns_nullable,          -- expect 2
  (select count(*) from pg_constraint
     where conrelid = 'public.rent_schedules'::regclass
       and conname in ('rent_schedules_grace_days_check', 'rent_schedules_late_fee_cents_check'))::int
    as policy_check_constraints,         -- expect 2
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'charges'
       and column_name = 'parent_charge_id' and is_nullable = 'YES')::int
    as parent_column_nullable,           -- expect 1
  (select count(*) from pg_constraint
     where conrelid = 'public.charges'::regclass
       and conname in ('charges_parent_charge_fk', 'charges_parent_not_self'))::int
    as parent_constraints,               -- expect 2
  (select count(*) from pg_indexes
     where schemaname = 'public' and tablename = 'charges'
       and indexname = 'charges_one_live_late_fee_per_parent')::int
    as live_fee_unique_index,            -- expect 1
  (select count(*) from pg_proc
     where proname = 'change_tenancy_rent' and pronargs = 12)::int
    as twelve_arg_function,              -- expect 1 (and exactly one overload)
  (select count(*) from pg_proc where proname = 'change_tenancy_rent')::int
    as function_overloads,               -- expect 1
  (select count(*) from pg_constraint
     where conrelid = 'public.notices'::regclass
       and conname = 'notices_notice_class_check'
       and pg_get_constraintdef(oid) like '%nonpayment_demand%')::int
    as class_has_nonpayment_member,      -- expect 1
  (select count(*) from public.rent_schedules
     where grace_days is not null or late_fee_cents is not null)::int
    as policy_set_rows,                  -- informational: 0 right after apply
  (select count(*) from public.charges where parent_charge_id is not null)::int
    as parented_rows,                    -- informational: 0 right after apply
  (select count(*) from public.notices where notice_class = 'nonpayment_demand')::int
    as nonpayment_rows;                  -- informational: 0 right after apply
SQL
  SQL="$VERIFY_SQL" DB_URL="$DB_URL" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => {
        const v = r.rows[0];
        console.table(v);
        const ok =
          Number(v.policy_columns_nullable) === 2 &&
          Number(v.policy_check_constraints) === 2 &&
          Number(v.parent_column_nullable) === 1 &&
          Number(v.parent_constraints) === 2 &&
          Number(v.live_fee_unique_index) === 1 &&
          Number(v.twelve_arg_function) === 1 &&
          Number(v.function_overloads) === 1 &&
          Number(v.class_has_nonpayment_member) === 1;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: see the table above for which invariant is off. Both migrations are re-runnable — fix the cause and re-run the apply.");
            process.exit(1);
          }
          console.log("OK: statement policy + nonpayment_demand are live. The three *_rows counters are informational — all 0 immediately after apply (nothing backfills); they grow only as landlords set policy, assert fees, and serve notices.");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1"
  resolve_db_url "$target"

  bold "APPLY statement-policy migrations -> ${target}"
  echo "Migrations: 20260801000007_statement_late_fee_policy, 20260801000008_nonpayment_notice_class (in order)"
  [[ "$target" == "prod" ]] && echo "Target:     PROD (pooler)"

  snapshot

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<EOF

Confirm BOTH 20260801000007 and 20260801000008 show as local-only (pending)
above, 0007 listed before 0008, and that every OTHER pending row is one you
intend to apply — 'supabase db push' applies them all, in order. If a row you
already applied shows as local-only, prod history has drifted; repair it
before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "\$DB_URL"
EOF
  [[ "$target" == "prod" ]] && confirm "Apply the pending migration(s) to PROD now?"

  bold "Pushing…"
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — statement policy and nonpayment_demand are live on this database."
  cat <<'EOF'

Next steps after this succeeds:
  1. Nothing to deploy: main already auto-deployed; the API stops answering
     503/400 for the new surfaces the moment the schema exists.
  2. NOW the frontend work that sends the new fields may merge — the hero PR
     feature-detects (grace_days on a schedule response is its capability
     signal), so it is safe in either order, but the policy UI only appears
     once this apply has run.
  3. In the frontend repo, run `bun run api:types` and commit the regenerated
     schema.d.ts so the local extension types can retire.
  4. Optional live smoke test on a test account: PATCH a rent schedule with
     {"grace_days": 5, "late_fee_cents": 8500}, GET it back; POST a late_fee
     charge with parent_charge_id and confirm a second one 409s.
EOF
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-statement-policy-migrations.sh verify [local|prod]}"; verify ;;
  snapshot)   resolve_db_url "${2:?usage: bash scripts/apply-statement-policy-migrations.sh snapshot [local|prod]}"; snapshot ;;
  *) echo "usage: bash scripts/apply-statement-policy-migrations.sh [local|prod|verify <local|prod>|snapshot <local|prod>]"; exit 2 ;;
esac
