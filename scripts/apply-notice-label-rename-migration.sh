#!/usr/bin/env bash
# Apply and verify 20260801000006_notice_label_rename. This interactive script
# is the operator action; deploys do not apply migrations automatically.
#
#   bash scripts/apply-notice-label-rename-migration.sh local        # local stack
#   bash scripts/apply-notice-label-rename-migration.sh prod         # PROD (pooler + confirm)
#   bash scripts/apply-notice-label-rename-migration.sh verify local # verify only
#   bash scripts/apply-notice-label-rename-migration.sh verify prod
#
# SAFETY: metadata-only rename (notice_type -> notice_label) on an effectively
# empty table, plus the renames that must follow it: the length-check
# constraint name and the anchored-row freeze trigger body (function text does
# not follow a column rename). No data, RLS, or semantic change.
#
# ORDERING (BREAKING window, accepted at current usage): after backend main
# deploys and until this applies, notices WRITES 500 (blocking rent changes
# and incident warnings too) and READS break as well — incident case files
# citing a notice 500, evidence exports fail on cited notices. APPLY
# PROMPTLY, then merge the frontend rename (the old frontend 400s on creates
# until it deploys).

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="20260801000006_notice_label_rename"
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

# --- Read-only snapshot -----------------------------------------------------
snapshot() {
  bold "SNAPSHOT (read-only) — pre-apply state"
  read -r -d '' SNAP_SQL <<'SQL' || true
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'notices'
       and column_name = 'notice_type')::int
    as old_column_present,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'notices'
       and column_name = 'notice_label')::int
    as new_column_present,
  (select count(*) from public.notices)::int
    as notices_rows;
SQL
  SQL="$SNAP_SQL" DB_URL="$DB_URL" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => {
        const v = r.rows[0];
        console.table(v);
        if (Number(v.new_column_present) > 0) {
          console.warn("NOTE: notice_label already exists — the push should list nothing pending for 20260801000006.");
        } else {
          console.log("OK: notice_type present, notice_label absent — the rename is pending.");
        }
        return c.end();
      })
      .catch((e) => { console.error("SNAPSHOT query failed:", e.message); process.exit(1); });
  '
}

# --- Verify the rename actually landed --------------------------------------
verify() {
  bold "VERIFY — rename landed: column, constraint name, trigger body"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'notices'
       and column_name = 'notice_label')::int
    as new_column_present,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'notices'
       and column_name = 'notice_type')::int
    as old_column_present,
  (select count(*) from pg_constraint
     where conrelid = 'public.notices'::regclass
       and conname = 'notices_notice_label_check')::int
    as check_constraint_present,
  (select ((prosrc like '%notice_label%') and (prosrc not like '%notice_type%'))::int
     from pg_proc
    where proname = '_reject_anchored_notice_mutation'
      and pronamespace = 'public'::regnamespace)::int
    as freeze_reads_label;
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
          Number(v.new_column_present) === 1 &&
          Number(v.old_column_present) === 0 &&
          Number(v.check_constraint_present) === 1 &&
          Number(v.freeze_reads_label) === 1;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: expected notice_label present, notice_type gone, renamed check constraint, freeze trigger reading notice_label — see the table above.");
            process.exit(1);
          }
          console.log("OK: the rename is live — notice_label everywhere, notice_type gone, freeze trigger updated.");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1"
  resolve_db_url "$target"

  bold "APPLY notice_label rename -> ${target}"
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
EOF
  [[ "$target" == "prod" ]] && confirm "Apply the pending migration(s) to PROD now?"

  bold "Pushing…"
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — the notice_label rename is live on this database."
  cat <<'EOF'

Next steps after this succeeds:
  1. Nothing to deploy: main already auto-deployed; notices routes recover
     the moment the rename exists (PostgREST reloads via notify pgrst).
  2. NOW the frontend rename PR may merge — not before (the old frontend
     400s on notice creates until it deploys).
  3. Optional live smoke test: POST a notice on a test account and confirm
     notice_label echoes back.
EOF
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-notice-label-rename-migration.sh verify [local|prod]}"; verify ;;
  snapshot)   resolve_db_url "${2:?usage: bash scripts/apply-notice-label-rename-migration.sh snapshot [local|prod]}"; snapshot ;;
  *) echo "usage: bash scripts/apply-notice-label-rename-migration.sh [local|prod|verify <local|prod>|snapshot <local|prod>]"; exit 2 ;;
esac
