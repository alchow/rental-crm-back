#!/usr/bin/env bash
# ============================================================================
# Apply the incidents migration (20260801000002_incidents) and verify it
# landed. Modelled on scripts/apply-auto-charge-default-on-migration.sh.
#
# NOTHING IN THIS REPO RUNS THIS FOR YOU. Migrations are not auto-applied on
# deploy; an operator runs this deliberately, in a regular terminal
# (Terminal.app / iTerm), because it asks confirmation questions a one-shot
# console cannot answer.
#
#   bash scripts/apply-incidents-migration.sh local        # local stack
#   bash scripts/apply-incidents-migration.sh prod         # PROD (pooler + confirm)
#   bash scripts/apply-incidents-migration.sh verify local # verify only
#   bash scripts/apply-incidents-migration.sh verify prod
#
# WHAT IT CHANGES (incidents feature, PRs #119/#120/#121, 2026-08-01)
#   1. New table public.incidents  — evidence-grade tenant case records.
#      description/occurred_at are trigger-frozen; write RLS is owner/manager.
#   2. New table public.incident_items — typed evidence citations
#      (interaction | maintenance_request | notice | inspection), insert +
#      soft-unlink only, hard delete trigger-rejected.
#   3. New trigger ON public.interactions
#      (interactions_reject_linked_evidence_mutation): a journal entry cited
#      by a LIVE incident item freezes its probative fields and cannot be
#      deleted until the citation is unlinked.
#
# WHY THE APPLY IS SAFE
# Everything is additive. The one change to an EXISTING table is the
# interactions trigger, and it only ever blocks an UPDATE/DELETE of a row
# that a live incident_items citation points at — and no citations can exist
# before these tables do, so nothing changes for any current flow at apply
# time. The snapshot below confirms zero incidents tables pre-apply and
# prints the interactions row count for the record.
#
# ORDERING: code-first happened (main auto-deployed with the API surface).
# The /incidents routes 500 until this applies; every other route is
# unaffected. Apply promptly.
#
# `supabase db push` applies EVERY pending migration in order, not just this
# one — the script prints the pending set and makes you confirm it first.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="20260801000002_incidents"
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
# Pre-apply facts: the incidents tables must NOT exist yet, and the
# interactions row count is recorded so the "additive only" claim is
# inspectable (none of those rows can be cited, so none can freeze).
snapshot() {
  bold "SNAPSHOT (read-only) — pre-apply state"
  read -r -d '' SNAP_SQL <<'SQL' || true
select
  (select count(*) from information_schema.tables
     where table_schema = 'public'
       and table_name in ('incidents', 'incident_items'))::int
    as incidents_tables_present,
  (select count(*) from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
    where c.relname = 'interactions'
      and t.tgname = 'interactions_reject_linked_evidence_mutation')::int
    as freeze_trigger_present,
  (select count(*) from public.interactions)::int
    as interactions_rows;
SQL
  SQL="$SNAP_SQL" DB_URL="$DB_URL" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => {
        const v = r.rows[0];
        console.table(v);
        if (Number(v.incidents_tables_present) > 0 || Number(v.freeze_trigger_present) > 0) {
          console.warn("NOTE: incidents objects already exist on this database — the push should list nothing pending for 20260801000002.");
        } else {
          console.log("OK: no incidents objects yet; the apply is purely additive (no interaction row can be cited before the tables exist).");
        }
        return c.end();
      })
      .catch((e) => { console.error("SNAPSHOT query failed:", e.message); process.exit(1); });
  '
}

# --- Verify the schema actually landed --------------------------------------
# Asserts the invariants only this migration creates: both tables with FORCE
# RLS, 3 policies each, the five guard triggers, and no client DELETE grant.
verify() {
  bold "VERIFY — tables, FORCE RLS, policies, triggers, grants"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('incidents','incident_items')
      and c.relrowsecurity and c.relforcerowsecurity)::int
    as tables_with_force_rls,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('incidents','incident_items'))::int
    as policy_count,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname in ('incidents_frozen_fields','incidents_no_delete',
                       'incident_items_unlink_only','incident_items_no_delete',
                       'interactions_reject_linked_evidence_mutation'))::int
    as guard_triggers,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('incidents','incident_items')
      and privilege_type = 'DELETE'
      and grantee in ('anon','authenticated','service_role'))::int
    as client_delete_grants;
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
          Number(v.tables_with_force_rls) === 2 &&
          Number(v.policy_count) === 6 &&
          Number(v.guard_triggers) === 5 &&
          Number(v.client_delete_grants) === 0;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: expected 2 FORCE-RLS tables, 6 policies, 5 guard triggers, 0 client DELETE grants — see the table above for which invariant is off.");
            process.exit(1);
          }
          console.log("OK: incidents schema is live — evidence-grade posture verified (frozen testimony, unlink-only citations, no client DELETE anywhere).");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1"
  resolve_db_url "$target"

  bold "APPLY incidents migration -> ${target}"
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
  bold "DONE — the incidents feature is live on this database."
  cat <<'EOF'

Next steps after this succeeds:
  1. Nothing to deploy: main already auto-deployed; the /incidents routes
     start working the moment this schema exists (PostgREST reloads via the
     migration's own `notify pgrst`).
  2. Optional live smoke test: create + fetch an incident on a test account
     via the API, then delete nothing — dismissal is the only exit by design.
  3. Front-end can build against docs/api-guide.md §Incidents.
EOF
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-incidents-migration.sh verify [local|prod]}"; verify ;;
  snapshot)   resolve_db_url "${2:?usage: bash scripts/apply-incidents-migration.sh snapshot [local|prod]}"; snapshot ;;
  *) echo "usage: bash scripts/apply-incidents-migration.sh [local|prod|verify <local|prod>|snapshot <local|prod>]"; exit 2 ;;
esac
