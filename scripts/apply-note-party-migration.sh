#!/usr/bin/env bash
# ============================================================================
# Apply the note-party migration (20260717000001_note_party) and verify it
# landed. Modelled on scripts/apply-rent-change-migration.sh: NON-INTERACTIVE,
# `prod` alone is a DRY RUN that prints the pending set, and applying requires
# an explicit second argument.
#
#   bash scripts/apply-note-party-migration.sh local          # local stack (applies)
#   bash scripts/apply-note-party-migration.sh prod           # DRY RUN: list pending, verify nothing
#   bash scripts/apply-note-party-migration.sh prod confirm   # PROD apply (pooler URL) + verify
#   bash scripts/apply-note-party-migration.sh verify local   # verify only, no apply
#   bash scripts/apply-note-party-migration.sh verify prod
#
# Prod credentials: SUPABASE_DB_URL_PROD from the environment, else read from
# .env.local (gitignored). The URL is NEVER echoed — safe for a logged console.
# This is the POOLER URL that survived the IPv6 incident — do NOT swap in
# db.<ref>.supabase.co.
#
# The migration is a single CHECK-constraint swap (interactions_note_fields):
# a note keeps direction='none' but MAY now carry a party under the same
# id-coherence rule communications use. No data migration — every existing
# note (party_type='none', party_id/party_label null) is valid under the
# relaxed check, so the ADD CONSTRAINT validation pass cannot fail on
# legacy rows. Safe to apply BEFORE or AFTER the code deploy: the old code
# never sends a party on a note, and the new code's zod/handler layers are
# a strict superset of the old shape.
#
# ORDERING: 20260717000001 deliberately sorts BEFORE the 20260718xxxxxx set
# (money_semantics reserved the slot — see its header comment). If prod has
# already applied any 20260718 migration, `supabase db push` will refuse the
# out-of-order insert; re-run with APPLY_INCLUDE_ALL=1 to pass --include-all
# after reviewing that 20260717000001 is the ONLY out-of-order file.
#
# `supabase db push` applies EVERY pending migration in order, not just this
# one — the dry run prints the pending set so you can review it BEFORE
# re-running with `confirm`.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATION="20260717000001_note_party"
MIGRATION_FILE="db/supabase/migrations/${MIGRATION}.sql"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$MIGRATION_FILE" ]] || die "migration file not found: $MIGRATION_FILE"

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

# --- Verify the constraint swap landed --------------------------------------
# node-pg via tsx (no psql dependency — macOS dev boxes lack it), SQL through
# an env var to dodge quoting hell, exactly like the sibling apply scripts.
# Probes the CONSTRAINT DEFINITIONS, not just existence — which is also how
# we catch a `db push` that silently no-ops:
#   * interactions_note_fields must be the RELAXED form: it mentions
#     'unspecified' (the new id-coherence arm) and no longer pins party_label
#     (the old shape forced party_type='none' + party_id/party_label null).
#   * interactions_unspecified_comm_only must still exist — it is what keeps
#     'unspecified' unreachable on a note (defense in depth).
verify() {
  bold "VERIFY — interactions_note_fields relaxed, unspecified_comm_only intact"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  -- the relaxed note-fields check: new arm present, old party pins gone
  (select count(*) from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'interactions'
       and c.conname = 'interactions_note_fields'
       and pg_get_constraintdef(c.oid) like '%unspecified%'
       and pg_get_constraintdef(c.oid) not like '%party_label%')::int
    as note_fields_relaxed,
  -- the old (pre-migration) form, which must be GONE
  (select count(*) from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'interactions'
       and c.conname = 'interactions_note_fields'
       and pg_get_constraintdef(c.oid) like '%party_label%')::int
    as note_fields_old_form,
  -- defense in depth: 'unspecified' stays communication-only
  (select count(*) from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'interactions'
       and c.conname = 'interactions_unspecified_comm_only')::int
    as unspecified_comm_only,
  -- note/channel equivalence untouched by the swap
  (select count(*) from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'interactions'
       and c.conname = 'interactions_note_shape')::int
    as note_shape;
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
          Number(v.note_fields_relaxed) === 1 &&
          Number(v.note_fields_old_form) === 0 &&
          Number(v.unspecified_comm_only) === 1 &&
          Number(v.note_shape) === 1;
        return c.end().then(() => {
          if (!ok) {
            console.error("VERIFY FAILED: interactions_note_fields is missing or still the pre-migration form (party pinned to none), or a sibling constraint is gone.");
            process.exit(1);
          }
          console.log("OK: interactions_note_fields relaxed (party allowed, id-coherence enforced); unspecified_comm_only + note_shape intact.");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1" confirmed="${2:-}"
  resolve_db_url "$target"

  bold "APPLY note-party migration -> ${target}"
  echo "Migration: $MIGRATION"
  [[ "$target" == "prod" ]] && echo "Target:    PROD (pooler; URL not shown)"

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<EOF

Review the list: ${MIGRATION} must show as local-only (pending). It sorts
BEFORE the 20260718xxxxxx set (the slot was reserved — see the
money_semantics header). If any 20260718 row is ALREADY applied on remote,
'supabase db push' refuses the out-of-order insert; after confirming
${MIGRATION} is the only out-of-order file, re-run with:
  APPLY_INCLUDE_ALL=1 bash scripts/apply-note-party-migration.sh ${target} confirm
If a migration you already applied shows as local-only, prod history has
drifted; repair before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "\$SUPABASE_DB_URL_PROD"
EOF

  if [[ "$target" == "prod" && "$confirmed" != "confirm" ]]; then
    bold "DRY RUN — nothing applied."
    echo "To apply the pending set to PROD, re-run:"
    echo "  bash scripts/apply-note-party-migration.sh prod confirm"
    exit 0
  fi

  bold "Pushing…"
  if [[ "${APPLY_INCLUDE_ALL:-}" == "1" ]]; then
    supabase --workdir db db push --db-url "$DB_URL" --include-all
  else
    # Reuse the repo's proven wrapper (db/ package: `supabase db push --db-url`).
    SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up
  fi

  verify
  bold "DONE — the relaxed check is live."
  cat <<'EOF'

Next steps after this succeeds:
  1. Backend code is already on main (PR #81; Render auto-deploys the API).
  2. Tell the FE team: flip NOTE_PARTY_SUPPORTED = true (their planned
     follow-up) — Note+person now persists instead of 400ing after "Done".
  3. Known deferred gap (commented at deriveSingleParticipant): party-carrying
     notes do not match GET /interactions?party_id= until the participant-cast
     fast-follow; the FE filters client-side, so nothing depends on it.
EOF
}

case "${1:-}" in
  local)  apply local ;;
  prod)   apply prod "${2:-}" ;;
  verify) resolve_db_url "${2:?usage: bash scripts/apply-note-party-migration.sh verify [local|prod]}"; verify ;;
  *) echo "usage: bash scripts/apply-note-party-migration.sh [local | prod [confirm] | verify <local|prod>]"; exit 2 ;;
esac
