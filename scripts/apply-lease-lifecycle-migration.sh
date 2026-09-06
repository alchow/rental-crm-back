#!/usr/bin/env bash
# Apply and verify the lease-lifecycle migration:
#   20260810000002_lease_lifecycle   (voided_at / void_reason / corrects_lease_id
#                                     on leases + lifecycle guard + replace_lease RPC)
# This interactive script is the operator action; deploys do not apply
# migrations automatically.
#
#   bash scripts/apply-lease-lifecycle-migration.sh local          # local stack
#   bash scripts/apply-lease-lifecycle-migration.sh prod           # PROD (pooler + confirm)
#   bash scripts/apply-lease-lifecycle-migration.sh snapshot prod  # pre-apply state (read-only)
#   bash scripts/apply-lease-lifecycle-migration.sh verify prod    # POST-apply only — it
#                                    names the new function, so on a pre-apply
#                                    DB it reports "not applied yet"; use
#                                    `snapshot` to inspect a pre-apply DB.
#
# SAFETY: three nullable columns, two CHECKs, one FK and one index are ADDED to
# public.leases; the anchoring trigger/function are dropped and replaced by the
# lifecycle guard; _rent_schedules_guard, change_tenancy_rent and
# detect_rent_drift are replaced in place (same signatures); replace_lease is new. No row changes, nothing is
# backfilled, no existing grant moves. NOT blindly re-runnable: `add column` has
# no if-not-exists guard, so a partial apply must be repaired (un-record the
# version, drop the partial objects, re-push) rather than re-pushed over; the
# function drop/create steps alone are re-runnable.
# NOTE `db push` applies EVERY pending migration, not just this one — inspect
# the pending list before confirming. Schema first, code second (ADR-0012
# order): until this apply runs, the new void/replace routes and any PATCH of
# the new fields fail (missing columns / RPC), while reads keep working.

set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { printf '\033[33m%s\033[0m' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {
  ask "$1 [y/N] "; read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Stopped — nothing applied. Re-run when ready."; exit 1; }
}

MIGRATION="db/supabase/migrations/20260810000002_lease_lifecycle.sql"
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
# Pre-apply facts. The migration adds columns and swaps functions, so the row
# counters must be unchanged by the apply; the presence flags tell the operator
# which state they start from.
snapshot() {
  bold "SNAPSHOT (read-only) — pre-apply state"
  read -r -d '' SNAP_SQL <<'SQL' || true
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'leases'
       and column_name in ('voided_at', 'void_reason', 'corrects_lease_id'))::int
    as lifecycle_columns,                -- 0 pre-apply, 3 post
  (select count(*) from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = 'replace_lease')::int
    as rpc_present,                      -- 0 pre-apply, 1 post
  (select count(*) from pg_trigger
     where tgrelid = 'public.leases'::regclass
       and tgname = 'leases_reject_anchored_mutation')::int
    as old_trigger_present,              -- 1 pre-apply, 0 post
  (select count(*) from public.leases)::int         as lease_rows,
  (select count(*) from public.rent_schedules)::int as schedule_rows;
SQL
  SQL="$SNAP_SQL" DB_URL="$DB_URL" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => {
        const v = r.rows[0];
        console.table(v);
        const cols = Number(v.lifecycle_columns), rpc = Number(v.rpc_present), old = Number(v.old_trigger_present);
        if (cols === 3 && rpc === 1 && old === 0) {
          console.warn("NOTE: the migration appears already applied on this database — the push should list nothing pending for 20260810000002.");
        } else if (cols !== 0 || rpc !== 0 || old !== 1) {
          console.error("PARTIAL STATE: columns, RPC and old-trigger presence disagree — repair before pushing (see the SAFETY note in this script header).");
          process.exit(1);
        } else {
          console.log("OK: pre-apply state recorded. The migration changes no rows; the two row counters above must be unchanged by the apply.");
        }
        return c.end();
      })
      .catch((e) => { console.error("SNAPSHOT query failed:", e.message); process.exit(1); });
  '
}

# --- Verify the schema actually landed --------------------------------------
# Asserts every check in the migration's VERIFICATION block.
verify() {
  bold "VERIFY — columns, CHECKs, FK, index, guard trigger, function bodies, invoker RPC, grants"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'leases'
       and column_name in ('voided_at', 'void_reason', 'corrects_lease_id'))::int
    as lifecycle_columns,                -- expect 3
  (select (pg_get_constraintdef(oid) like '%(voided_at IS NULL) = (void_reason IS NULL)%')::int
     from pg_constraint
    where conrelid = 'public.leases'::regclass
      and conname = 'leases_void_reason_pairs_check')
    as void_reason_pairs_check,          -- expect 1
  (select (pg_get_constraintdef(oid) like '%(corrects_lease_id IS NULL) OR (corrects_lease_id <> id)%')::int
     from pg_constraint
    where conrelid = 'public.leases'::regclass
      and conname = 'leases_corrects_self_check')
    as corrects_self_check,              -- expect 1
  (select count(*) from pg_constraint
     where conrelid = 'public.leases'::regclass
       and conname = 'leases_corrects_lease_fk'
       and contype = 'f'
       and confrelid = 'public.leases'::regclass)::int
    as corrects_lease_fk,                -- expect 1 (account-safe self FK)
  (select count(*) from pg_indexes
     where schemaname = 'public' and tablename = 'leases'
       and indexname = 'leases_corrects_lease_id_idx')::int
    as corrects_lease_index,             -- expect 1
  (select count(*) from pg_trigger
     where tgrelid = 'public.leases'::regclass
       and tgname = 'leases_guard'
       and (tgtype & 4) > 0 and (tgtype & 16) > 0)::int
    as guard_trigger_insert_update,      -- expect 1
  (select count(*) from pg_trigger
     where tgrelid = 'public.leases'::regclass
       and tgname = 'leases_reject_anchored_mutation')::int
    as old_trigger_present,              -- expect 0
  (select count(*) from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = '_reject_anchored_lease_mutation')::int
    as old_function_present,             -- expect 0
  (select (prosrc like '%rent_change:%' and prosrc like '%is frozen%'
           and prosrc like '%is voided%' and prosrc like '%corrects_lease_id%')::int
     from pg_proc
    where pronamespace = 'public'::regnamespace and proname = '_leases_guard')
    as guard_body,                       -- expect 1: lock key + all three rules
  (select (prosrc like '%non-draft%'
           and prosrc like '%is distinct from OLD.source_lease_id%')::int from pg_proc
     where pronamespace = 'public'::regnamespace and proname = '_rent_schedules_guard')
    as schedule_guard_body,              -- expect 1: draft/voided anchors refused, only when the anchor changes
  (select count(*) from pg_proc
     where pronamespace = 'public'::regnamespace and proname = 'change_tenancy_rent')::int
    as rent_change_overloads,            -- expect 1
  (select bool_and(prosrc like '%source lease is voided%'
                   and prosrc ~ 'status\s+=\s+''active''\s+and voided_at is null')::int from pg_proc
     where pronamespace = 'public'::regnamespace and proname = 'change_tenancy_rent')
    as rent_change_body,                 -- expect 1: voided source refused, voided leases never superseded
  (select (prosrc like '%voided_at is null%')::int from pg_proc
     where pronamespace = 'public'::regnamespace and proname = 'detect_rent_drift')
    as drift_body,                       -- expect 1: voided leases are not drift
  (select count(*) from pg_proc
     where pronamespace = 'public'::regnamespace and proname = 'replace_lease')::int
    as replace_lease_present,            -- expect 1
  (select (not prosecdef)::int from pg_proc
     where pronamespace = 'public'::regnamespace and proname = 'replace_lease')
    as invoker_security,                 -- expect 1: caller RLS, never definer
  (select has_function_privilege('authenticated',
     'public.replace_lease(uuid, uuid, text, date, date, bigint, text, bigint, text, jsonb)'::regprocedure,
     'execute')::int)
    as authenticated_can_execute,        -- expect 1
  (select has_function_privilege('anon',
     'public.replace_lease(uuid, uuid, text, date, date, bigint, text, bigint, text, jsonb)'::regprocedure,
     'execute')::int)
    as anon_can_execute,                 -- expect 0
  (select count(*) from public.leases where voided_at is not null)::int
    as voided_leases;                    -- informational: 0 right after apply
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
          Number(v.lifecycle_columns) === 3 &&
          Number(v.void_reason_pairs_check) === 1 &&
          Number(v.corrects_self_check) === 1 &&
          Number(v.corrects_lease_fk) === 1 &&
          Number(v.corrects_lease_index) === 1 &&
          Number(v.guard_trigger_insert_update) === 1 &&
          Number(v.old_trigger_present) === 0 &&
          Number(v.old_function_present) === 0 &&
          Number(v.guard_body) === 1 &&
          Number(v.schedule_guard_body) === 1 &&
          Number(v.rent_change_overloads) === 1 &&
          Number(v.rent_change_body) === 1 &&
          Number(v.drift_body) === 1 &&
          Number(v.replace_lease_present) === 1 &&
          Number(v.invoker_security) === 1 &&
          Number(v.authenticated_can_execute) === 1 &&
          Number(v.anon_can_execute) === 0;
        return c.end().then(() => {
          if (!ok) {
            console.error(
              "VERIFY FAILED: see the table above for which invariant is off.\n" +
              "If the version is NOT in supabase_migrations.schema_migrations, drop any partial objects, then re-run the apply.\n" +
              "If the version IS recorded but the schema is off, a re-run is a NO-OP — db push skips recorded versions. Un-record it first, then re-apply:\n" +
              "  supabase --workdir db migration repair --status reverted 20260810000002 --db-url \"$DB_URL\"");
            process.exit(1);
          }
          console.log("OK: lease lifecycle is live. voided_leases is informational — 0 immediately after apply (nothing backfills); it grows only as landlords void or replace leases.");
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

  bold "APPLY lease-lifecycle migration -> ${target}"
  echo "Migration: 20260810000002_lease_lifecycle"
  [[ "$target" == "prod" ]] && echo "Target:    PROD (pooler)"

  snapshot

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<EOF2

Confirm 20260810000002 shows as local-only (pending) above, and that every
OTHER pending row is one you intend to apply — 'supabase db push' applies
them all, in order. If a row you already applied shows as local-only, prod
history has drifted; repair it before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "\$DB_URL"
EOF2
  [[ "$target" == "prod" ]] && confirm "Apply the pending migration(s) to PROD now?"

  bold "Pushing…"
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — lease lifecycle is live on this database."
  cat <<'EOF2'

Next steps after this succeeds:
  1. Deploy (or confirm auto-deploy of) the backend that ships the lease
     lifecycle routes — POST .../leases/{id}/void and .../replace, the PATCH
     mutability rules and the removed DELETE — so API and schema agree.
  2. Tell the frontend the §26 reply is live (docs/lease-lifecycle-fe-reply.md):
     removal is a void with a reason; a correction is a replace.
  3. Optional live smoke test on a test account: PATCH rent on an active lease
     and confirm 409 code lease_executed; void an unanchored lease and confirm
     it still appears in the list with voided_at set; void an anchored lease
     and confirm 409 code instrument_anchored.
EOF2
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-lease-lifecycle-migration.sh verify [local|prod]}"; verify ;;
  snapshot)   resolve_db_url "${2:?usage: bash scripts/apply-lease-lifecycle-migration.sh snapshot [local|prod]}"; snapshot ;;
  *) echo "usage: bash scripts/apply-lease-lifecycle-migration.sh [local|prod|verify <local|prod>|snapshot <local|prod>]"; exit 2 ;;
esac
