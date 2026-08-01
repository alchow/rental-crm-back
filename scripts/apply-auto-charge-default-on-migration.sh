#!/usr/bin/env bash
# ============================================================================
# Apply the auto-charge default-ON migration
# (20260801000001_auto_charge_default_on) and verify it landed. Modelled on
# scripts/apply-auto-charge-migration.sh.
#
# NOTHING IN THIS REPO RUNS THIS FOR YOU. Migrations are not auto-applied on
# deploy; an operator runs this deliberately, in a regular terminal
# (Terminal.app / iTerm), because it asks confirmation questions a one-shot
# console cannot answer.
#
#   bash scripts/apply-auto-charge-default-on-migration.sh local        # local stack
#   bash scripts/apply-auto-charge-default-on-migration.sh prod         # PROD (pooler + confirm)
#   bash scripts/apply-auto-charge-default-on-migration.sh verify local # verify only
#   bash scripts/apply-auto-charge-default-on-migration.sh verify prod
#
# WHAT IT CHANGES (ADR-0011 amendment, 2026-08-01)
#   1. accounts.auto_charge_enabled DEFAULT false -> true (catalog only).
#   2. One-shot backfill of live accounts still holding the false default.
#   3. A rewritten column comment.
#
# WHY THE BACKFILL IS SAFE
# The generator only mints a charge where a LIVE rent schedule covers the
# period, so flipping the flag on an account with no schedules bills nothing.
# At the time this was written, every account carrying the false default had
# ZERO live rent schedules, and both accounts that DO have schedules were
# already flag-on. Re-verify with the fleet snapshot this script prints BEFORE
# you confirm the apply — if the "flag_off_with_schedules" count is not 0, stop
# and talk to those landlords first: those accounts would start billing on the
# next 08:00 UTC generator run.
#
# ORDERING: this migration is independent of the API code. The running app
# reads and writes the same column either way, so schema-first (the usual
# order here) is fine.
#
# `supabase db push` applies EVERY pending migration in order, not just this
# one — the script prints the pending set and makes you confirm it first.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="20260801000001_auto_charge_default_on"
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

# --- Read-only fleet snapshot ----------------------------------------------
# The number that decides whether the backfill is a no-op in billing terms:
# how many flag-OFF accounts hold a live rent schedule. Anything above 0 means
# the apply will start billing somebody. Run this BEFORE applying.
snapshot() {
  bold "FLEET SNAPSHOT (read-only) — who the backfill would switch on"
  read -r -d '' SNAP_SQL <<'SQL' || true
select
  (select count(*) from public.accounts where deleted_at is null)::int
    as live_accounts,
  (select count(*) from public.accounts
     where deleted_at is null and auto_charge_enabled)::int
    as flag_on,
  (select count(*) from public.accounts
     where deleted_at is null and not auto_charge_enabled)::int
    as flag_off,
  (select count(distinct a.id) from public.accounts a
     join public.rent_schedules s
       on s.account_id = a.id and s.deleted_at is null
    where a.deleted_at is null and not a.auto_charge_enabled)::int
    as flag_off_with_schedules;
SQL
  SQL="$SNAP_SQL" DB_URL="$DB_URL" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => {
        const v = r.rows[0];
        console.table(v);
        if (Number(v.flag_off_with_schedules) > 0) {
          console.warn(
            `WARNING: ${v.flag_off_with_schedules} flag-off account(s) hold a live rent schedule. ` +
            "Applying will start billing them on the next 08:00 UTC generator run.",
          );
        } else {
          console.log("OK: no flag-off account holds a live rent schedule — the backfill changes no billing behaviour today.");
        }
        return c.end();
      })
      .catch((e) => { console.error("SNAPSHOT query failed:", e.message); process.exit(1); });
  '
}

# --- Verify the default actually moved -------------------------------------
# The column default is the one thing ONLY this migration sets, so it is also
# how we catch a `db push` that silently no-opped. The post-apply flag counts
# are printed but NOT asserted: a landlord may legitimately opt out later.
verify() {
  bold "VERIFY — column default + backfill result"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  (select c.column_default from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'accounts'
       and c.column_name = 'auto_charge_enabled')
    as column_default,
  (select count(*) from public.accounts
     where deleted_at is null and not auto_charge_enabled)::int
    as flag_off_live,
  (select count(distinct a.id) from public.accounts a
     join public.rent_schedules s
       on s.account_id = a.id and s.deleted_at is null
    where a.deleted_at is null and not a.auto_charge_enabled)::int
    as flag_off_with_schedules,
  (select left(d.description, 60) from pg_description d
     join pg_class cl on cl.oid = d.objoid
     join pg_namespace n on n.oid = cl.relnamespace
     join pg_attribute at on at.attrelid = cl.oid and at.attnum = d.objsubid
    where n.nspname = 'public' and cl.relname = 'accounts'
      and at.attname = 'auto_charge_enabled')
    as comment_head;
SQL
  SQL="$VERIFY_SQL" DB_URL="$DB_URL" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => {
        const v = r.rows[0];
        console.table(v);
        const ok = String(v.column_default) === "true";
        return c.end().then(() => {
          if (!ok) {
            console.error(`VERIFY FAILED: accounts.auto_charge_enabled default is ${String(v.column_default)}, expected true — the migration did not apply.`);
            process.exit(1);
          }
          console.log("OK: auto_charge_enabled now defaults to true; new accounts bill without any extra call.");
          console.log(`Live accounts still opted out: ${v.flag_off_live} (of which ${v.flag_off_with_schedules} hold a live rent schedule).`);
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1"
  resolve_db_url "$target"

  bold "APPLY auto-charge default-ON migration -> ${target}"
  echo "Migration: $MIGRATION"
  [[ "$target" == "prod" ]] && echo "Target:    PROD (pooler)"

  snapshot

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<EOF

Confirm ${MIGRATION} shows as local-only (pending) above, and that every OTHER
pending row is one you intend to apply — 'supabase db push' applies them all,
in order. If a row you already applied shows as local-only, prod history has
drifted; repair it before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "\$DB_URL"

Read the snapshot above once more. flag_off_with_schedules = 0 means this apply
changes no billing behaviour today; anything else means it starts billing real
tenants on the next generator run.
EOF
  [[ "$target" == "prod" ]] && confirm "Apply the pending migration(s) to PROD now?"

  bold "Pushing…"
  # Reuse the repo's proven wrapper (db/ package: `supabase db push --db-url`).
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — automatic rent charging is now the default for this database."
  cat <<'EOF'

Next steps after this succeeds:
  1. Nothing to deploy: the API reads/writes the same column either way.
  2. Spot-check the next daily run (08:00 UTC) — or force one immediately:
       pnpm --filter ./api charges:generate
     Then audit the created rows: charges attributed 'system:cron:rent',
     one per (source_schedule_id, period_start).
  3. The backfill's own audit events are attributed
     'system:migration:20260801000001_auto_charge_default_on' on public.events.
EOF
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-auto-charge-default-on-migration.sh verify [local|prod]}"; verify ;;
  snapshot)   resolve_db_url "${2:?usage: bash scripts/apply-auto-charge-default-on-migration.sh snapshot [local|prod]}"; snapshot ;;
  *) echo "usage: bash scripts/apply-auto-charge-default-on-migration.sh [local|prod|verify <local|prod>|snapshot <local|prod>]"; exit 2 ;;
esac
