#!/usr/bin/env bash
# ============================================================================
# Apply the journal hardening migrations (20260801000003 + 20260801000004)
# and verify they landed. Modelled on scripts/apply-incidents-migration.sh.
#
# NOTHING IN THIS REPO RUNS THIS FOR YOU. Migrations are not auto-applied on
# deploy; an operator runs this deliberately, in a regular terminal
# (Terminal.app / iTerm), because it asks confirmation questions a one-shot
# console cannot answer.
#
#   bash scripts/apply-journal-hardening-migrations.sh local        # local stack
#   bash scripts/apply-journal-hardening-migrations.sh prod         # PROD (pooler + confirm)
#   bash scripts/apply-journal-hardening-migrations.sh verify local # verify only
#   bash scripts/apply-journal-hardening-migrations.sh verify prod
#
# WHAT IT CHANGES (journal hardening + party filter, PR #123, 2026-08-01)
#   1. 20260801000003 — REVOKE UPDATE/DELETE/TRUNCATE on public.interactions
#      from anon/authenticated: the append-only journal becomes a grant fact,
#      not a route-surface fact. Two new CHECKs close verified drift holes
#      (no party_type='none' on a communication; a note's party_id needs a
#      concrete role). The migration carries its own precheck DO block and
#      FAILS LOUDLY, with row counts, if any existing row violates.
#   2. 20260801000004 — list_interactions_for_party matches the row-slot
#      party as well as the cast, so party-carrying notes and correction
#      heads show up under GET /interactions?party_id=. The obsolete 11-arg
#      overload from 20260716000001 is dropped.
#
# WHY THE APPLY IS SAFE
# No API path uses the revoked verbs (no PATCH/DELETE routes exist on
# interactions; the two legitimate UPDATE writers are SECURITY DEFINER and
# run as the table owner). The RPC redefinition keeps the same 12-arg
# signature the deployed code already calls, and the dropped 11-arg overload
# has had no caller since the property-aware release. Independently
# Fable-reviewed (APPROVE) + 42/42 integration suites on the migrated stack.
#
# ORDERING: code-first happened (main auto-deployed with PR #123). Nothing
# 500s pre-apply — the party filter simply lacks its new matches until the
# schema lands. Apply promptly so the contract text and behavior agree.
#
# `supabase db push` applies EVERY pending migration in order, not just
# these — the script prints the pending set and makes you confirm it first.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

M1="20260801000003_journal_write_hardening"
M2="20260801000004_party_filter_row_slot"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { printf '\033[33m%s\033[0m' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {
  ask "$1 [y/N] "; read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Stopped — nothing applied. Re-run when ready."; exit 1; }
}

[[ -f "db/supabase/migrations/${M1}.sql" ]] || die "migration file not found: ${M1}.sql"
[[ -f "db/supabase/migrations/${M2}.sql" ]] || die "migration file not found: ${M2}.sql"

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
# Pre-apply facts. The violating-row counts are the load-bearing ones: the
# migration's own precheck aborts on nonzero, so a nonzero HERE means stop and
# investigate (such rows are evidence the direct-write bypass was used).
snapshot() {
  bold "SNAPSHOT (read-only) — pre-apply state"
  read -r -d '' SNAP_SQL <<'SQL' || true
select
  (select count(*) from public.interactions
    where kind = 'communication' and party_type = 'none')::int
    as violating_comm_none_rows,
  (select count(*) from public.interactions
    where channel = 'note' and party_id is not null
      and party_type not in ('tenant','vendor','inspector','other'))::int
    as violating_note_party_rows,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'interactions'
      and privilege_type in ('UPDATE','DELETE','TRUNCATE')
      and grantee in ('anon','authenticated'))::int
    as member_write_grants,
  (select count(*) from pg_proc
    where proname = 'list_interactions_for_party'
      and pronamespace = 'public'::regnamespace)::int
    as party_rpc_overloads,
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
        const dirty = Number(v.violating_comm_none_rows) + Number(v.violating_note_party_rows);
        if (dirty > 0) {
          console.error("STOP: " + dirty + " row(s) violate the new CHECKs — the push WILL abort (by design, with diagnostics). These rows are evidence of a direct member-JWT write bypass; investigate them before applying. Do not delete journal rows to make this pass.");
          process.exit(1);
        }
        if (Number(v.member_write_grants) === 0 && Number(v.party_rpc_overloads) === 1) {
          console.warn("NOTE: hardening already applied on this database — the push should list nothing pending for 20260801000003/4.");
        } else {
          console.log("OK: no violating rows; pre-apply grants/overloads as expected (" + v.member_write_grants + " member write grants to revoke, " + v.party_rpc_overloads + " RPC overload(s) -> 1).");
        }
        return c.end();
      })
      .catch((e) => { console.error("SNAPSHOT query failed:", e.message); process.exit(1); });
  '
}

# --- Verify the schema actually landed --------------------------------------
# Asserts the invariants only these migrations create: zero member write
# grants, both CHECKs present + validated (note_fields with the concrete-role
# list), exactly one 12-arg RPC whose body carries the row-slot leg, and a
# clean table under both predicates.
verify() {
  bold "VERIFY — grants, CHECK constraints, RPC overloads, row cleanliness"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'interactions'
      and privilege_type in ('UPDATE','DELETE','TRUNCATE')
      and grantee in ('anon','authenticated'))::int
    as member_write_grants,
  (select count(*) from pg_constraint
    where conrelid = 'public.interactions'::regclass and convalidated
      and conname = 'interactions_comm_party_named')::int
    as comm_party_check,
  (select count(*) from pg_constraint
    where conrelid = 'public.interactions'::regclass and convalidated
      and conname = 'interactions_note_fields'
      and pg_get_constraintdef(oid) like '%inspector%')::int
    as note_fields_check_tightened,
  (select count(*) from pg_proc
    where proname = 'list_interactions_for_party'
      and pronamespace = 'public'::regnamespace)::int
    as party_rpc_overloads,
  (select count(*) from pg_proc
    where proname = 'list_interactions_for_party'
      and pronamespace = 'public'::regnamespace and pronargs = 12
      and pg_get_functiondef(oid) like '%v.party_id = p_party_id%')::int
    as rpc_has_row_slot_leg,
  (select count(*) from public.interactions
    where (kind = 'communication' and party_type = 'none')
       or (channel = 'note' and party_id is not null
           and party_type not in ('tenant','vendor','inspector','other')))::int
    as violating_rows;
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
          Number(v.member_write_grants) === 0 &&
          Number(v.comm_party_check) === 1 &&
          Number(v.note_fields_check_tightened) === 1 &&
          Number(v.party_rpc_overloads) === 1 &&
          Number(v.rpc_has_row_slot_leg) === 1 &&
          Number(v.violating_rows) === 0;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: expected 0 member write grants, both CHECKs validated (note_fields tightened), exactly one 12-arg RPC with the row-slot leg, 0 violating rows — see the table above for which invariant is off.");
            process.exit(1);
          }
          console.log("OK: journal hardening is live — append-only is a grant fact, both drift holes are closed at the DB, and ?party_id now sees notes and correction heads.");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1"
  resolve_db_url "$target"

  bold "APPLY journal hardening migrations -> ${target}"
  echo "Migrations: $M1, $M2"
  [[ "$target" == "prod" ]] && echo "Target:     PROD (pooler)"

  snapshot

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<EOF

Confirm ${M1} and ${M2} show as local-only (pending) above, and that every
OTHER pending row is one you intend to apply — 'supabase db push' applies them
all, in order. If a row you already applied shows as local-only, prod history
has drifted; repair it before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "\$DB_URL"
EOF
  [[ "$target" == "prod" ]] && confirm "Apply the pending migration(s) to PROD now?"

  bold "Pushing…"
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — journal hardening is live on this database."
  cat <<'EOF'

Next steps after this succeeds:
  1. Nothing to deploy: main already auto-deployed with PR #123; the party
     filter picks up its new matches the moment the RPC body lands
     (PostgREST reloads via the migration's own `notify pgrst`).
  2. Optional live smoke test on a test account: log a note naming a tenant
     (party_type + party_id), then GET /interactions?party_id=<them> — the
     note should appear; a member-JWT PATCH of any journal row via PostgREST
     should return 42501.
  3. Heads-up for FE/agent teams is in the PR #123 body: any out-of-repo
     direct member-JWT journal mutation now gets 42501.
EOF
}

case "${1:-}" in
  local|prod) apply "$1" ;;
  verify)     resolve_db_url "${2:?usage: bash scripts/apply-journal-hardening-migrations.sh verify [local|prod]}"; verify ;;
  snapshot)   resolve_db_url "${2:?usage: bash scripts/apply-journal-hardening-migrations.sh snapshot [local|prod]}"; snapshot ;;
  *) echo "usage: bash scripts/apply-journal-hardening-migrations.sh [local|prod|verify <local|prod>|snapshot <local|prod>]"; exit 2 ;;
esac
