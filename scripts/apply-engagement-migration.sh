#!/usr/bin/env bash
# ============================================================================
# Apply the inspection-engagement migration (20260701000001_inspection_engagement)
# and verify it landed. Modelled on scripts/deploy-agent-api.sh.
#
# RUN IN A REGULAR TERMINAL (Terminal.app / iTerm) — it asks confirmation
# questions a one-shot console can't answer.
#
#   bash scripts/apply-engagement-migration.sh local        # local Supabase stack
#   bash scripts/apply-engagement-migration.sh prod         # PROD (pooler URL + confirm)
#   bash scripts/apply-engagement-migration.sh verify local # verify only, no apply
#   bash scripts/apply-engagement-migration.sh verify prod
#
# The migration is ADDITIVE (nullable columns + a new table + new/replaced
# DEFINER RPCs), so it is safe to apply to prod BEFORE the code deploy — the
# live app never touches the new objects until the new code ships. Order is the
# same as every migration here: schema first, code second.
#
# `supabase db push` applies EVERY pending migration in order, not just this
# one — the script prints the pending set and makes you confirm it first.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="20260701000001_inspection_engagement"
MIGRATION_FILE="db/supabase/migrations/${MIGRATION}.sql"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { printf '\033[33m%s\033[0m' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {
  ask "$1 [y/N] "; read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Stopped — nothing applied. Re-run when ready."; exit 1; }
}

[[ -f "$MIGRATION_FILE" ]] || die "migration file not found: $MIGRATION_FILE"

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

# --- Verify the objects exist AND the new DEFINER fns are locked ------------
# node-pg via tsx (no psql dependency — macOS dev boxes lack it), passing SQL
# through an env var exactly like deploy-agent-api.sh's prod_sql to dodge
# quoting hell. Non-zero exit on any mismatch — which is also how we catch a
# `db push` that silently no-ops (a known CLI quirk; see tenancy-status-advance).
verify() {
  bold "VERIFY — schema objects + DEFINER lockdown"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'inspections'
       and column_name in ('link_delivered_at','form_opened_at','form_started_at','submitted_at'))::int
    as inspection_cols,
  (to_regclass('public.inspection_room_confirmations') is not null)
    as confirmations_table,
  (select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('tenant_mark_form_opened','tenant_confirm_inspection_room','_tenant_stamp_form_started'))::int
    as new_fns,
  (select coalesce(bool_or(
             has_function_privilege('anon', pr.oid, 'execute')
          or has_function_privilege('authenticated', pr.oid, 'execute')), false)
     from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in (
         -- 3 new + 5 replaced tenant DEFINER fns whose ACLs this migration (re-)asserts
         'tenant_mark_form_opened','tenant_confirm_inspection_room','_tenant_stamp_form_started',
         'tenant_update_inspection_item','tenant_upsert_inspection_checks','tenant_submit_inspection',
         'tenant_attach_inspection_item_photo','tenant_upsert_inspection_items'))
    as any_leaky;
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
          Number(v.inspection_cols) === 4 &&
          v.confirmations_table === true &&
          Number(v.new_fns) === 3 &&
          v.any_leaky === false;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: migration not fully applied, or a new DEFINER fn is anon/authenticated-executable.");
            process.exit(1);
          }
          console.log("OK: 4 columns + confirmations table + 3 DEFINER fns present and service_role-only.");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1"
  resolve_db_url "$target"

  bold "APPLY engagement migration -> ${target}"
  echo "Migration: $MIGRATION"
  [[ "$target" == "prod" ]] && echo "Target:    PROD (pooler)"

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<EOF

Confirm ${MIGRATION} shows as local-only (pending) above, and that every OTHER
pending row is one you intend to apply — 'supabase db push' applies them all,
in order. If a row you already applied shows as local-only, prod history has
drifted; repair it before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "\$DB_URL"
EOF
  [[ "$target" == "prod" ]] && confirm "Apply the pending migration(s) to PROD now?"

  bold "Pushing…"
  # Reuse the repo's proven wrapper (db/ package: `supabase db push --db-url`).
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — schema is ahead of code (additive; live app unaffected until the code deploy)."
  [[ "$target" == "prod" ]] && echo "Next: deploy the API code (git push / Render) AFTER this succeeded."
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-engagement-migration.sh verify [local|prod]}"; verify ;;
  *) echo "usage: bash scripts/apply-engagement-migration.sh [local|prod|verify <local|prod>]"; exit 2 ;;
esac
