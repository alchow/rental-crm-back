#!/usr/bin/env bash
# Apply and verify the tenancy-adoption migration:
#   20260810000001_tenancy_adoption   (tenancy_adoptions table + guard/freeze
#                                      triggers + adopt_tenancy_history RPC)
# This interactive script is the operator action; deploys do not apply
# migrations automatically.
#
#   bash scripts/apply-tenancy-adoption-migration.sh local          # local stack
#   bash scripts/apply-tenancy-adoption-migration.sh prod           # PROD (pooler + confirm)
#   bash scripts/apply-tenancy-adoption-migration.sh snapshot prod  # pre-apply state (read-only)
#   bash scripts/apply-tenancy-adoption-migration.sh verify prod    # POST-apply only — it
#                                    names the new table/function, so on a
#                                    pre-apply DB it reports "not applied yet";
#                                    use `snapshot` to inspect a pre-apply DB.
#
# SAFETY: purely additive — a new table, two trigger functions, and one RPC.
# No existing table is altered, no data changes, nothing is backfilled, no
# grant on an existing object moves. NOT blindly re-runnable: `create table`
# has no if-not-exists guard, so a partial apply must be repaired (un-record
# the version, drop the partial objects, re-push) rather than re-pushed over.
# NOTE `db push` applies EVERY pending migration, not just this one — inspect
# the pending list before confirming. Until this apply runs, the deployed API
# degrades loudly-but-safely: GET /ledger serves `adoption: null` (PGRST205
# tolerance), POST .../adoption answers the typed-retryable 503, and the
# Field Log wizard has no backend to reveal — this apply is what turns it on.

set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { printf '\033[33m%s\033[0m' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {
  ask "$1 [y/N] "; read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Stopped — nothing applied. Re-run when ready."; exit 1; }
}

MIGRATION="db/supabase/migrations/20260810000001_tenancy_adoption.sql"
[[ -f "$MIGRATION" ]] || die "migration file not found: $MIGRATION"

# --- Resolve the target DB URL into $DB_URL --------------------------------
# local -> the running Supabase stack's DB_URL (from `supabase status`).
# prod  -> SUPABASE_DB_URL_PROD (env, else .env.local). This is the POOLER URL
#          that survived the IPv6 incident — do NOT swap in db.<ref>.supabase.co.
resolve_db_url() {
  case "$1" in
    local)
      DB_URL="$(supabase status --output env --workdir db 2>/dev/null | grep '^DB_URL=' | cut -d= -f2- | tr -d '"' || true)"
      [[ -n "$DB_URL" ]] || die "could not read DB_URL from 'supabase status' — is the local stack up? (supabase start --workdir db)"
      ;;
    prod)
      if [[ -z "${SUPABASE_DB_URL_PROD:-}" && -f .env.local ]]; then
        SUPABASE_DB_URL_PROD="$(grep '^SUPABASE_DB_URL_PROD=' .env.local | cut -d= -f2- | tr -d '"' || true)"
      fi
      [[ -n "${SUPABASE_DB_URL_PROD:-}" ]] || die "SUPABASE_DB_URL_PROD not set and not found in .env.local"
      DB_URL="$SUPABASE_DB_URL_PROD"
      ;;
    *) die "unknown target '$1' (expected: local | prod)";;
  esac
}

# --- Read-only snapshot -----------------------------------------------------
# Pre-apply facts. The migration is additive, so the three row counters must
# be unchanged by the apply; table_present tells the operator which state
# they start from.
snapshot() {
  bold "SNAPSHOT (read-only) — pre-apply state"
  read -r -d '' SNAP_SQL <<'SQL' || true
select
  (select count(*) from pg_class
     where relnamespace = 'public'::regnamespace
       and relname = 'tenancy_adoptions')::int
    as table_present,                    -- 0 pre-apply, 1 post
  (select count(*) from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'adopt_tenancy_history')::int
    as rpc_present,                      -- 0 pre-apply, 1 post
  (select count(*) from public.tenancies)::int as tenancy_rows,
  (select count(*) from public.charges)::int   as charge_rows,
  (select count(*) from public.payments)::int  as payment_rows;
SQL
  SQL="$SNAP_SQL" DB_URL="$DB_URL" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => {
        const v = r.rows[0];
        console.table(v);
        if (Number(v.table_present) === 1 && Number(v.rpc_present) === 1) {
          console.warn("NOTE: the migration appears already applied on this database — the push should list nothing pending for 20260810000001.");
        } else if (Number(v.table_present) !== Number(v.rpc_present)) {
          console.error("PARTIAL STATE: table and RPC presence disagree — repair before pushing (see the SAFETY note in this script header).");
          process.exit(1);
        } else {
          console.log("OK: pre-apply state recorded. The migration is additive; the three row counters above must be unchanged by the apply.");
        }
        return c.end();
      })
      .catch((e) => { console.error("SNAPSHOT query failed:", e.message); process.exit(1); });
  '
}

# --- Verify the schema actually landed --------------------------------------
# Asserts every invariant only this migration creates.
verify() {
  bold "VERIFY — table, force-RLS, policies, triggers, index, 15-arg invoker RPC, grants"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  (select relforcerowsecurity::int from pg_class
     where oid = 'public.tenancy_adoptions'::regclass)
    as force_rls,                        -- expect 1
  (select count(*) from pg_policy
     where polrelid = 'public.tenancy_adoptions'::regclass)::int
    as policies,                         -- expect 3 (select / insert / update)
  (select count(*) from pg_indexes
     where schemaname = 'public' and tablename = 'tenancy_adoptions'
       and indexname = 'tenancy_adoptions_one_live_per_tenancy')::int
    as one_live_unique_index,            -- expect 1 (partial, deleted_at null)
  (select count(*) from pg_trigger
     where tgrelid = 'public.tenancy_adoptions'::regclass
       and tgname in ('tenancy_adoptions_guard',
                      'tenancy_adoptions_freeze',
                      'tenancy_adoptions_audit'))::int
    as triggers,                         -- expect 3 (guard + freeze + audit)
  (select count(*) from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'adopt_tenancy_history' and pronargs = 15)::int
    as fifteen_arg_function,             -- expect 1
  (select count(*) from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'adopt_tenancy_history')::int
    as function_overloads,               -- expect 1
  (select (not prosecdef)::int from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'adopt_tenancy_history' and pronargs = 15)
    as invoker_security,                 -- expect 1: caller RLS, never definer
  (select (prosrc like '%v_seen_periods%')::int from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'adopt_tenancy_history' and pronargs = 15)
    as period_snapping_in_body,          -- expect 1: due-day grid dedupe
  (select (prosrc like '%rent_change:%')::int from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'adopt_tenancy_history' and pronargs = 15)
    as shared_lock_in_body,              -- expect 1: schedule-writer lock key
  (select has_function_privilege('authenticated',
     'public.adopt_tenancy_history(uuid, uuid, date, text, bigint, int, date, int, bigint, jsonb, jsonb, jsonb, bigint, text, boolean)'::regprocedure,
     'execute')::int)
    as authenticated_can_execute,        -- expect 1
  (select has_function_privilege('anon',
     'public.adopt_tenancy_history(uuid, uuid, date, text, bigint, int, date, int, bigint, jsonb, jsonb, jsonb, bigint, text, boolean)'::regprocedure,
     'execute')::int)
    as anon_can_execute,                 -- expect 0
  (select has_table_privilege('authenticated', 'public.tenancy_adoptions', 'delete')::int)
    as authenticated_can_delete,         -- expect 0: soft-delete only
  (select count(*) from public.tenancy_adoptions)::int
    as adoption_rows;                    -- informational: 0 right after apply
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
          Number(v.force_rls) === 1 &&
          Number(v.policies) === 3 &&
          Number(v.one_live_unique_index) === 1 &&
          Number(v.triggers) === 3 &&
          Number(v.fifteen_arg_function) === 1 &&
          Number(v.function_overloads) === 1 &&
          Number(v.invoker_security) === 1 &&
          Number(v.period_snapping_in_body) === 1 &&
          Number(v.shared_lock_in_body) === 1 &&
          Number(v.authenticated_can_execute) === 1 &&
          Number(v.anon_can_execute) === 0 &&
          Number(v.authenticated_can_delete) === 0;
        return c.end().then(() => {
          if (!ok) {
            console.error(
              "VERIFY FAILED: see the table above for which invariant is off.\n" +
              "If the version is NOT in supabase_migrations.schema_migrations, drop any partial objects, then re-run the apply.\n" +
              "If the version IS recorded but the schema is off, a re-run is a NO-OP — db push skips recorded versions. Un-record it first, then re-apply:\n" +
              "  supabase --workdir db migration repair --status reverted 20260810000001 --db-url \"$DB_URL\"");
            process.exit(1);
          }
          console.log("OK: tenancy adoption is live. adoption_rows is informational — 0 immediately after apply (nothing backfills); it grows only as landlords run the wizard.");
        });
      })
      .catch((e) => {
        if (/does not exist/.test(e.message)) {
          console.error("VERIFY query failed:", e.message);
          console.error("This usually means the migration is NOT applied yet — verify only works post-apply. Run the `snapshot` subcommand to inspect a pre-apply database.");
        } else {
          console.error("VERIFY query failed:", e.message);
        }
        process.exit(1);
      });
  '
}

# ============================================================================
apply() {
  local target="$1"
  resolve_db_url "$target"

  bold "APPLY tenancy-adoption migration -> ${target}"
  echo "Migration: 20260810000001_tenancy_adoption"
  [[ "$target" == "prod" ]] && echo "Target:    PROD (pooler)"

  snapshot

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<EOF

Confirm 20260810000001 shows as local-only (pending) above, and that every
OTHER pending row is one you intend to apply — 'supabase db push' applies
them all, in order. If a row you already applied shows as local-only, prod
history has drifted; repair it before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "\$DB_URL"
EOF
  [[ "$target" == "prod" ]] && confirm "Apply the pending migration(s) to PROD now?"

  bold "Pushing…"
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — tenancy adoption is live on this database."
  cat <<'EOF'

Next steps after this succeeds:
  1. Nothing to deploy anywhere: backend main already auto-deployed. The API
     stops answering 503 for POST .../adoption and the ledger's `adoption`
     block goes live the moment the schema exists.
  2. The Field Log adoption wizard is NOT built yet — this apply is the
     backend precondition for that work, not a user-visible change by itself.
  3. Optional live smoke test on a test account: POST an adoption on a fresh
     tenancy (past start date, one backfilled charge + payment), GET the
     ledger and confirm the adoption block + backfilled entries; confirm a
     second adoption 409s with code already_adopted.
EOF
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-tenancy-adoption-migration.sh verify [local|prod]}"; verify ;;
  snapshot)   resolve_db_url "${2:?usage: bash scripts/apply-tenancy-adoption-migration.sh snapshot [local|prod]}"; snapshot ;;
  *) echo "usage: bash scripts/apply-tenancy-adoption-migration.sh [local|prod|verify <local|prod>|snapshot <local|prod>]"; exit 2 ;;
esac
