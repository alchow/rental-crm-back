#!/usr/bin/env bash
# ============================================================================
# Apply the rent-schedule delete-guard migration
# (20260706000002_rent_schedule_delete_guard, PR #68) and verify it landed.
# Modelled on scripts/apply-rent-change-migration.sh: NON-INTERACTIVE gating —
# `prod` alone is a DRY RUN that prints the pending set; applying requires an
# explicit second argument. (`db push` itself still asks one y/N in a TTY.)
#
#   bash scripts/apply-delete-guard-migration.sh local          # local stack (applies)
#   bash scripts/apply-delete-guard-migration.sh prod           # DRY RUN: list pending, apply nothing
#   bash scripts/apply-delete-guard-migration.sh prod confirm   # PROD apply (pooler URL) + verify
#   bash scripts/apply-delete-guard-migration.sh verify local   # verify only, no apply
#   bash scripts/apply-delete-guard-migration.sh verify prod
#
# Prod credentials: SUPABASE_DB_URL_PROD from the environment, else read from
# .env.local (gitignored). The URL is never PRINTED by this script (safe for a
# logged console), though like every `supabase --db-url` invocation it is
# briefly visible in the local process table (ps argv) — same as the sibling
# scripts. This is the POOLER URL that survived the IPv6 incident — do NOT
# swap in db.<ref>.supabase.co.
#
# ORDERING QUIRK (why this script does NOT reuse `pnpm --filter ./db
# migrate:up`): this migration is stamped 20260706000002, which sorts BEFORE
# the already-applied future-dated persona migrations (20260707000001 ..
# 20260709000002). A plain `supabase db push` refuses to insert a migration
# behind the remote head; `--include-all` is the documented escape hatch and
# is exactly right here — the file is genuinely new everywhere. The dry run
# prints the pending set so you can review it first: on prod it must show
# EXACTLY this one migration as local-only. If anything else shows pending,
# STOP — history has drifted; repair before pushing:
#   supabase --workdir db migration repair --status applied <version> --db-url "$SUPABASE_DB_URL_PROD"
#
# The migration is ADDITIVE and safe ahead of the code deploy: one BEFORE
# UPDATE trigger that rejects soft-deleting a rent_schedule while non-voided
# charges reference it. Nothing in the deployed API soft-deletes schedules
# today (the DELETE route ships with PR #68), so the only writes it can newly
# reject are direct-PostgREST soft-deletes — which were the unguarded hole it
# exists to close.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="20260706000002_rent_schedule_delete_guard"
MIGRATION_FILE="db/supabase/migrations/${MIGRATION}.sql"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$MIGRATION_FILE" ]] || die "migration file not found: $MIGRATION_FILE (are you on the PR #68 branch?)"

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

# --- Verify the objects exist ------------------------------------------------
# node-pg via tsx (no psql dependency — macOS dev boxes lack it), SQL through
# an env var to dodge quoting hell, exactly like the sibling apply scripts.
# Non-zero exit on any mismatch — which is also how we catch a `db push` that
# silently no-ops.
verify() {
  bold "VERIFY — delete-guard trigger + function + migration history row"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  -- the guard function
  (select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname = '_reject_schedule_delete_with_live_charges')::int
    as guard_fn,
  -- the BEFORE UPDATE trigger on rent_schedules (existence + not-internal is
  -- the check; the name/relname pair is unique)
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where t.tgname = 'rent_schedules_reject_delete_with_live_charges'
       and c.relname = 'rent_schedules'
       and not t.tgisinternal)::int
    as guard_trigger,
  -- and the older sibling trigger it stacks behind (name order = fire order)
  (select count(*) from pg_trigger
     where tgname = 'rent_schedules_guard' and not tgisinternal)::int
    as advisory_lock_trigger,
  -- the history row, so `migration list` agrees local == remote afterwards
  (select count(*) from supabase_migrations.schema_migrations
     where version = '20260706000002')::int
    as history_row;
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
          Number(v.guard_fn) === 1 &&
          Number(v.guard_trigger) === 1 &&
          Number(v.advisory_lock_trigger) === 1 &&
          Number(v.history_row) === 1;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: the guard function/trigger is missing or the migration history row was not recorded.");
            process.exit(1);
          }
          console.log("OK: _reject_schedule_delete_with_live_charges + its BEFORE UPDATE trigger present (stacked after rent_schedules_guard), history row recorded.");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1" confirmed="${2:-}"
  resolve_db_url "$target"

  bold "APPLY delete-guard migration -> ${target}"
  echo "Migration: $MIGRATION"
  [[ "$target" == "prod" ]] && echo "Target:    PROD (pooler; URL not shown)"

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"

  # Stronger than eyeballing the list: --dry-run prints the EXACT set that
  # `db push --include-all` would apply, connecting but writing nothing.
  # Exits 0 on success (verified on CLI 2.105), so a failure here halts the
  # script (set -e) before any confirm push.
  bold "Exact push set (db push --include-all --dry-run):"
  supabase --workdir db db push --include-all --dry-run --db-url "$DB_URL"
  cat <<EOF

Review both views: ${MIGRATION} must be the ONLY migration in the push set.
It sorts BEFORE the applied persona migrations (20260707..20260709) — that is
expected and why the push uses --include-all. If ANYTHING ELSE appears in the
push set, STOP and repair history first (see the header of this script).
EOF

  if [[ "$target" == "prod" && "$confirmed" != "confirm" ]]; then
    bold "DRY RUN — nothing applied."
    echo "To apply the pending set to PROD, re-run:"
    echo "  bash scripts/apply-delete-guard-migration.sh prod confirm"
    exit 0
  fi

  bold "Pushing (with --include-all for the out-of-order insert)…"
  supabase --workdir db db push --include-all --db-url "$DB_URL"

  verify
  bold "DONE — schema is ahead of code (additive; the API's DELETE route arrives with PR #68)."
  cat <<'EOF'

Next steps after this succeeds:
  1. Merge PR #68 (Render auto-deploys the API).
  2. Forward docs/rent-changes-fe-reply.md to the FE team and have them
     regenerate types from openapi/openapi.json.
  3. Optional smoke: create a throwaway schedule on a test tenancy, DELETE it
     (expect 204), then try deleting a schedule with a live charge
     (expect 409 schedule_has_charges).
EOF
}

case "${1:-}" in
  local)  apply local ;;
  prod)   apply prod "${2:-}" ;;
  verify) resolve_db_url "${2:?usage: bash scripts/apply-delete-guard-migration.sh verify [local|prod]}"; verify ;;
  *) echo "usage: bash scripts/apply-delete-guard-migration.sh [local | prod [confirm] | verify <local|prod>]"; exit 2 ;;
esac
