#!/usr/bin/env bash
# ============================================================================
# Apply the automatic-rent-charging migration (20260704000002_auto_rent_charging)
# and verify it landed. Modelled on scripts/apply-engagement-migration.sh.
#
# RUN IN A REGULAR TERMINAL (Terminal.app / iTerm) — it asks confirmation
# questions a one-shot console can't answer.
#
#   bash scripts/apply-auto-charge-migration.sh local        # local Supabase stack
#   bash scripts/apply-auto-charge-migration.sh prod         # PROD (pooler URL + confirm)
#   bash scripts/apply-auto-charge-migration.sh verify local # verify only, no apply
#   bash scripts/apply-auto-charge-migration.sh verify prod
#
# The migration is ADDITIVE (a new nullable-defaulted column + a column grant +
# a replaced DEFINER RPC + a new trigger), so it is safe to apply to prod BEFORE
# the code deploy — the live app never touches the new objects until the new
# code ships, and no account is billed until its owner flips auto_charge_enabled
# (default false). Order is the same as every migration here: schema first,
# code second.
#
# `supabase db push` applies EVERY pending migration in order, not just this
# one — the script prints the pending set and makes you confirm it first.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="20260704000002_auto_rent_charging"
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

# --- Verify the objects exist AND the DEFINER generator is locked ----------
# node-pg via tsx (no psql dependency — macOS dev boxes lack it), passing SQL
# through an env var exactly like apply-engagement-migration.sh to dodge
# quoting hell. Non-zero exit on any mismatch — which is also how we catch a
# `db push` that silently no-ops.
verify() {
  bold "VERIFY — column + column grant + generator lockdown + end cascade"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  -- the opt-in column
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'accounts'
       and column_name = 'auto_charge_enabled')::int
    as opt_in_col,
  -- a user JWT (authenticated) may UPDATE that column ...
  has_column_privilege('authenticated', 'public.accounts', 'auto_charge_enabled', 'UPDATE')
    as auth_can_write_flag,
  -- ... but NOT other account columns (column grant, not a trigger)
  has_column_privilege('authenticated', 'public.accounts', 'name', 'UPDATE')
    as auth_can_write_name,
  -- the advance-timing generator exists ...
  (select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname = 'generate_rent_charges')::int
    as generator_fn,
  -- ... and is service_role-only (never anon/authenticated-executable)
  (select coalesce(bool_or(
             has_function_privilege('anon', pr.oid, 'execute')
          or has_function_privilege('authenticated', pr.oid, 'execute')), false)
     from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname = 'generate_rent_charges')
    as generator_leaky,
  -- the tenancy-end cascade trigger
  (select count(*) from pg_trigger
     where tgname = 'tenancies_end_rent_schedules_on_end' and not tgisinternal)::int
    as end_cascade_trigger;
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
          Number(v.opt_in_col) === 1 &&
          v.auth_can_write_flag === true &&
          v.auth_can_write_name === false &&
          Number(v.generator_fn) === 1 &&
          v.generator_leaky === false &&
          Number(v.end_cascade_trigger) === 1;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: migration not fully applied, the column grant is wrong, or the generator is anon/authenticated-executable.");
            process.exit(1);
          }
          console.log("OK: auto_charge_enabled present + user-writable (name is not), generate_rent_charges present and service_role-only, end-cascade trigger installed.");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1"
  resolve_db_url "$target"

  bold "APPLY auto-charge migration -> ${target}"
  echo "Migration: $MIGRATION"
  [[ "$target" == "prod" ]] && echo "Target:    PROD (pooler)"

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<EOF

Confirm ${MIGRATION} shows as local-only (pending) above, and that every OTHER
pending row is one you intend to apply — 'supabase db push' applies them all,
in order. NOTE: 20260704000002_auto_rent_charging must apply AFTER
20260704000001_account_email_branding — it extends that migration's accounts
UPDATE column grant. If a row you already applied shows as local-only, prod
history has drifted; repair it before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "\$DB_URL"
EOF
  [[ "$target" == "prod" ]] && confirm "Apply the pending migration(s) to PROD now?"

  bold "Pushing…"
  # Reuse the repo's proven wrapper (db/ package: `supabase db push --db-url`).
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — schema is ahead of code (additive; no account bills until its owner opts in)."
  cat <<'EOF'

Next steps after this succeeds:
  1. Deploy the API code (merge PR #58 / Render) so the /settings route ships.
  2. In Render, set the `rent-charge-generator` cron env vars:
     SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL.
  3. Opt one account in (Settings toggle, or PATCH /v1/accounts/{id}/settings),
     let a cycle run, then audit charges attributed 'system:cron:rent'.
     To see a run immediately instead of waiting for 08:00 UTC:
       pnpm --filter ./api charges:generate
EOF
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-auto-charge-migration.sh verify [local|prod]}"; verify ;;
  *) echo "usage: bash scripts/apply-auto-charge-migration.sh [local|prod|verify <local|prod>]"; exit 2 ;;
esac
