#!/usr/bin/env bash
# ============================================================================
# Apply the instrument-anchored-rent-changes migration
# (20260706000001_instrument_anchored_rent_changes) and verify it landed.
# Modelled on scripts/apply-auto-charge-migration.sh, but NON-INTERACTIVE so
# it can run from a one-shot console (e.g. Claude Code's `!` prefix):
# instead of y/N prompts, `prod` alone is a DRY RUN that prints the pending
# set, and applying requires an explicit second argument.
#
#   bash scripts/apply-rent-change-migration.sh local          # local stack (applies)
#   bash scripts/apply-rent-change-migration.sh prod           # DRY RUN: list pending, verify nothing
#   bash scripts/apply-rent-change-migration.sh prod confirm   # PROD apply (pooler URL) + verify
#   bash scripts/apply-rent-change-migration.sh verify local   # verify only, no apply
#   bash scripts/apply-rent-change-migration.sh verify prod
#
# Prod credentials: SUPABASE_DB_URL_PROD from the environment, else read from
# .env.local (gitignored). The URL is NEVER echoed — safe for a logged console.
# This is the POOLER URL that survived the IPv6 incident — do NOT swap in
# db.<ref>.supabase.co.
#
# The migration is ADDITIVE (nullable provenance columns + two SECURITY
# INVOKER functions + guard/reject triggers), so it is safe to apply to prod
# BEFORE the code deploy — nothing reads the new objects until PR #60's code
# ships, and the new triggers only reject writes that were previously corrupt
# (cross-tenancy anchors, mutating anchored instruments, resurrecting
# superseded leases). ORDERING: it must apply AFTER
# 20260704000002_auto_rent_charging (detect_rent_drift reads
# accounts.auto_charge_enabled; change_tenancy_rent voids charges the advance
# generator created).
#
# `supabase db push` applies EVERY pending migration in order, not just this
# one — the dry run prints the pending set so you can review it BEFORE
# re-running with `confirm`.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="20260706000001_instrument_anchored_rent_changes"
MIGRATION_FILE="db/supabase/migrations/${MIGRATION}.sql"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$MIGRATION_FILE" ]] || die "migration file not found: $MIGRATION_FILE"

# --- Resolve the target DB URL into $DB_URL --------------------------------
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

# --- Verify the objects exist with the right security posture --------------
# node-pg via tsx (no psql dependency — macOS dev boxes lack it), SQL through
# an env var to dodge quoting hell, exactly like the sibling apply scripts.
# Non-zero exit on any mismatch — which is also how we catch a `db push` that
# silently no-ops. The o_voided_charge_ids probe pins the REVIEW-FIXED
# function revision (the pre-review draft returned only three columns).
verify() {
  bold "VERIFY — provenance columns + RPCs (invoker, non-anon) + guard/reject triggers"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  -- the three provenance columns
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'rent_schedules'
       and column_name in ('source_lease_id', 'source_notice_id', 'change_reason'))::int
    as provenance_cols,
  -- change_tenancy_rent exists, is SECURITY INVOKER, and is the review-fixed
  -- revision (returns o_voided_charge_ids)
  (select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname = 'change_tenancy_rent'
       and not pr.prosecdef
       and pg_get_function_result(pr.oid) like '%o_voided_charge_ids%')::int
    as change_rent_fn,
  -- detect_rent_drift exists and is SECURITY INVOKER
  (select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname = 'detect_rent_drift'
       and not pr.prosecdef)::int
    as drift_fn,
  -- neither function is anon-executable (authenticated IS allowed: INVOKER+RLS)
  (select coalesce(bool_or(has_function_privilege('anon', pr.oid, 'execute')), false)
     from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('change_tenancy_rent', 'detect_rent_drift'))
    as anon_leaky,
  (select coalesce(bool_and(has_function_privilege('authenticated', pr.oid, 'execute')), false)
     from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('change_tenancy_rent', 'detect_rent_drift'))
    as auth_can_execute,
  -- the per-tenancy write-serialization + anchor-tenancy guard, and the two
  -- anchored-instrument reject triggers
  (select count(*) from pg_trigger
     where tgname in ('rent_schedules_guard',
                      'notices_reject_anchored_mutation',
                      'leases_reject_anchored_mutation')
       and not tgisinternal)::int
    as guard_triggers,
  -- the partial provenance indexes
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname in ('rent_schedules_source_lease_id_idx',
                         'rent_schedules_source_notice_id_idx'))::int
    as provenance_idx;
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
          Number(v.provenance_cols) === 3 &&
          Number(v.change_rent_fn) === 1 &&
          Number(v.drift_fn) === 1 &&
          v.anon_leaky === false &&
          v.auth_can_execute === true &&
          Number(v.guard_triggers) === 3 &&
          Number(v.provenance_idx) === 2;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: migration not fully applied, a pre-review function revision is live (no o_voided_charge_ids), a trigger is missing, or grants are wrong.");
            process.exit(1);
          }
          console.log("OK: provenance columns + review-fixed change_tenancy_rent + detect_rent_drift (both INVOKER, anon revoked) + all 3 guard/reject triggers + partial indexes present.");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1" confirmed="${2:-}"
  resolve_db_url "$target"

  bold "APPLY rent-change migration -> ${target}"
  echo "Migration: $MIGRATION"
  [[ "$target" == "prod" ]] && echo "Target:    PROD (pooler; URL not shown)"

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<EOF

Review the list: ${MIGRATION} must show as local-only (pending), AFTER
20260704000002_auto_rent_charging (already applied to prod). 'supabase db
push' applies EVERY pending row above in order — if one you already applied
shows as local-only, prod history has drifted; repair before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "\$SUPABASE_DB_URL_PROD"
EOF

  if [[ "$target" == "prod" && "$confirmed" != "confirm" ]]; then
    bold "DRY RUN — nothing applied."
    echo "To apply the pending set to PROD, re-run:"
    echo "  bash scripts/apply-rent-change-migration.sh prod confirm"
    exit 0
  fi

  bold "Pushing…"
  # Reuse the repo's proven wrapper (db/ package: `supabase db push --db-url`).
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — schema is ahead of code (additive; nothing reads the new objects until PR #60 deploys)."
  cat <<'EOF'

Next steps after this succeeds:
  1. Merge PR #60 (Render auto-deploys the API).
  2. Tell the FE team: lease PATCH no longer accepts rent_amount_cents /
     rent_currency (echoed-unchanged values are tolerated; a change is 400 ->
     use POST /tenancies/{tenancyId}/rent-changes).
  3. Optional smoke: run one instrument-anchored change on a test tenancy and
     confirm the successor schedule carries source_lease_id/source_notice_id,
     then check the next cron run's rent_drift_detected output.
EOF
}

case "${1:-}" in
  local)  apply local ;;
  prod)   apply prod "${2:-}" ;;
  verify) resolve_db_url "${2:?usage: bash scripts/apply-rent-change-migration.sh verify [local|prod]}"; verify ;;
  *) echo "usage: bash scripts/apply-rent-change-migration.sh [local | prod [confirm] | verify <local|prod>]"; exit 2 ;;
esac
