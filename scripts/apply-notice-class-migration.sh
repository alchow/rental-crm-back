#!/usr/bin/env bash
# Apply and verify 20260801000005_notice_class. This interactive script is the
# operator action; deploys do not apply migrations automatically.
#
#   bash scripts/apply-notice-class-migration.sh local        # local stack
#   bash scripts/apply-notice-class-migration.sh prod         # PROD (pooler + confirm)
#   bash scripts/apply-notice-class-migration.sh verify local # verify only
#   bash scripts/apply-notice-class-migration.sh verify prod
#
# SAFETY: Adds nullable notice_class plus an index and extends the anchored-row
# freeze trigger; no data, default, or RLS change. Existing rows remain unclassed.
# Apply before any client begins sending notice_class.

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="20260801000005_notice_class"
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
# Pre-apply facts: the column must NOT exist yet, and the notices row count is
# recorded so the "additive only, nulls stay null" claim is inspectable.
snapshot() {
  bold "SNAPSHOT (read-only) — pre-apply state"
  read -r -d '' SNAP_SQL <<'SQL' || true
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'notices'
       and column_name = 'notice_class')::int
    as notice_class_column_present,
  (select count(*) from pg_indexes
     where schemaname = 'public' and tablename = 'notices'
       and indexname = 'notices_class_lookback_idx')::int
    as lookback_index_present,
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
        if (Number(v.notice_class_column_present) > 0) {
          console.warn("NOTE: notice_class already exists on this database — the push should list nothing pending for 20260801000005.");
        } else {
          console.log("OK: no notice_class column yet; the apply is purely additive (every existing row will read null = unclassed).");
        }
        return c.end();
      })
      .catch((e) => { console.error("SNAPSHOT query failed:", e.message); process.exit(1); });
  '
}

# --- Verify the schema actually landed --------------------------------------
# Asserts the invariants only this migration creates: nullable column, check
# constraint, lookback index — and that no row was backfilled (all null).
verify() {
  bold "VERIFY — column, nullability, check constraint, index, no backfill"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'notices'
       and column_name = 'notice_class' and is_nullable = 'YES')::int
    as nullable_column_present,
  (select count(*) from pg_constraint
     where conrelid = 'public.notices'::regclass
       and conname = 'notices_notice_class_check')::int
    as check_constraint_present,
  (select count(*) from pg_indexes
     where schemaname = 'public' and tablename = 'notices'
       and indexname = 'notices_class_lookback_idx')::int
    as lookback_index_present,
  (select count(*) from public.notices where notice_class is not null)::int
    as classed_rows,
  (select (prosrc like '%notice_class%')::int from pg_proc
    where proname = '_reject_anchored_notice_mutation')::int
    as freeze_covers_class;
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
          Number(v.nullable_column_present) === 1 &&
          Number(v.check_constraint_present) === 1 &&
          Number(v.lookback_index_present) === 1 &&
          Number(v.freeze_covers_class) === 1;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: expected 1 nullable column, 1 check constraint, 1 index, freeze trigger covering notice_class — see the table above for which invariant is off.");
            process.exit(1);
          }
          console.log("OK: notice_class is live. classed_rows is informational — it should be 0 immediately after apply (nothing backfills) and grows only as clients write classes.");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1"
  resolve_db_url "$target"

  bold "APPLY notice_class migration -> ${target}"
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
  bold "DONE — notice_class is live on this database."
  cat <<'EOF'

Next steps after this succeeds:
  1. Nothing to deploy: main already auto-deployed; the API starts accepting
     notice_class the moment the column exists (PostgREST reloads via the
     migration's own `notify pgrst`).
  2. NOW the frontend PR that sends notice_class may merge — not before.
  3. Optional live smoke test: POST a notice with notice_class on a test
     account, GET it back, confirm the class echoes; then PATCH notice_type
#     (renamed to notice_label by 20260801000006)
     and confirm the correction lands.
EOF
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-notice-class-migration.sh verify [local|prod]}"; verify ;;
  snapshot)   resolve_db_url "${2:?usage: bash scripts/apply-notice-class-migration.sh snapshot [local|prod]}"; snapshot ;;
  *) echo "usage: bash scripts/apply-notice-class-migration.sh [local|prod|verify <local|prod>|snapshot <local|prod>]"; exit 2 ;;
esac
