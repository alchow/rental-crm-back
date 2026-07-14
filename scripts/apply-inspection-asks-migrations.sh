#!/usr/bin/env bash
# ============================================================================
# Apply the four inspection-asks migrations (PRs #86-#89) and verify each
# landed. Modelled on scripts/apply-note-party-migration.sh: NON-INTERACTIVE,
# `prod` alone is a DRY RUN that prints the pending set, and applying requires
# an explicit second argument.
#
#   bash scripts/apply-inspection-asks-migrations.sh local          # local stack (applies)
#   bash scripts/apply-inspection-asks-migrations.sh prod           # DRY RUN: list pending, verify nothing
#   bash scripts/apply-inspection-asks-migrations.sh prod confirm   # PROD apply (pooler URL) + verify
#   bash scripts/apply-inspection-asks-migrations.sh verify local   # verify only, no apply
#   bash scripts/apply-inspection-asks-migrations.sh verify prod
#
# Prod credentials: SUPABASE_DB_URL_PROD from the environment, else read from
# .env.local (gitignored). The URL is NEVER echoed — safe for a logged console.
# This is the POOLER URL that survived the IPv6 incident — do NOT swap in
# db.<ref>.supabase.co.
#
# The set (sequential, sorts after everything on main — no out-of-order risk):
#   20260719000001_inspection_checks_presence_merge  — rewrites both check
#     upsert RPCs (presence-merge + honest answered stamps) + draft-only heal.
#   20260719000002_inspection_checks_input_kind      — input_kind column,
#     carried through seed / checkout-copy / both upserts.
#   20260719000003_inspection_templates_provenance   — catalog_id (+backfill
#     from schema->>'form_code') and the GENERATED schema_hash.
#   20260719000004_area_inspection_layouts           — the per-unit layout
#     delta table (RLS + explicit grants + audit trigger).
#
# ORDERING vs deploys: all four are ADDITIVE and safe against the currently
# deployed code, so apply the whole set FIRST (schema leads code). #86 is
# already on main (its code never reads the new schema); #87-#89 must NOT be
# merged until this script's verify passes — #87's tenant capture form
# selects input_kind and would 500 on the missing column.
#
# `supabase db push` applies EVERY pending migration in order, not just
# these — the dry run prints the pending set so you can review it BEFORE
# re-running with `confirm`.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

MIGRATIONS=(
  "20260719000001_inspection_checks_presence_merge"
  "20260719000002_inspection_checks_input_kind"
  "20260719000003_inspection_templates_provenance"
  "20260719000004_area_inspection_layouts"
)

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

require_migration_files() {
  # Only the APPLY paths need the files on disk ('db push' reads them);
  # verify probes the live schema and works from any branch.
  for m in "${MIGRATIONS[@]}"; do
    [[ -f "db/supabase/migrations/${m}.sql" ]] || die "migration file not found: db/supabase/migrations/${m}.sql — run from a branch with the full #86-#89 stack (feat/area-inspection-layouts, or main once merged)"
  done
}

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

# --- Verify all four landed --------------------------------------------------
# node-pg via tsx (no psql dependency), SQL through an env var to dodge
# quoting hell, exactly like the sibling apply scripts. Probes DEFINITIONS and
# PRIVILEGES, not just existence — which is also how we catch a `db push`
# that silently no-ops:
#   0001: both upsert RPCs are the presence-merge form (jsonb_typeof marker);
#         the tenant DEFINER fn keeps _tenant_stamp_form_started AND is locked
#         to service_role; zero mislabeled draft rows remain (the heal ran).
#   0002: input_kind column + CHECK constraint; the seed AND checkout-copy
#         fns both mention input_kind (the checkout copy is the line that,
#         if lost, silently regresses move-outs to Yes/No).
#   0003: catalog_id column; schema_hash is a STORED GENERATED column
#         (attgenerated='s'); backfill left no cloned row without provenance.
#   0004: table exists with RLS enabled+forced, the member policy, the audit
#         trigger, the TOTAL unique constraint, and the explicit grants
#         (authenticated: select/insert/update, NO delete; anon: nothing).
verify() {
  bold "VERIFY — inspection-asks migrations 20260719000001..4"
  read -r -d '' VERIFY_SQL <<'SQL' || true
select
  -- ---- 0001: presence-merge RPCs + heal --------------------------------
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='upsert_inspection_checks'
      and pg_get_functiondef(p.oid) like '%jsonb_typeof%')::int
    as member_rpc_presence_merge,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='tenant_upsert_inspection_checks'
      and pg_get_functiondef(p.oid) like '%jsonb_typeof%'
      and pg_get_functiondef(p.oid) like '%_tenant_stamp_form_started%')::int
    as tenant_rpc_presence_merge,
  (select (not has_function_privilege('anon',          p.oid, 'execute')
       and not has_function_privilege('authenticated', p.oid, 'execute')
       and     has_function_privilege('service_role',  p.oid, 'execute'))::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='tenant_upsert_inspection_checks')
    as tenant_rpc_acl_locked,
  (select count(*) from public.inspection_checks c
     join public.inspections i on i.id = c.inspection_id and i.account_id = c.account_id
    where c.deleted_at is null and c.answered_at is not null
      and (c.value is null or jsonb_typeof(c.value) = 'null')
      and i.completed_at is null)::int
    as mislabeled_draft_rows_remaining,
  -- ---- 0002: input_kind end-to-end --------------------------------------
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='inspection_checks' and column_name='input_kind')::int
    as input_kind_column,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='seed_inspection_items_from_template'
      and pg_get_functiondef(p.oid) like '%input_kind%')::int
    as seed_carries_input_kind,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='start_checkout_from_checkin'
      and pg_get_functiondef(p.oid) like '%input_kind%')::int
    as checkout_copies_input_kind,
  -- ---- 0003: provenance --------------------------------------------------
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='inspection_templates' and column_name='catalog_id')::int
    as catalog_id_column,
  (select count(*) from pg_attribute a join pg_class t on t.oid = a.attrelid
     join pg_namespace n on n.oid = t.relnamespace
    where n.nspname='public' and t.relname='inspection_templates'
      and a.attname='schema_hash' and a.attgenerated='s')::int
    as schema_hash_generated_stored,
  (select count(*) from public.inspection_templates
    where schema->>'form_code' = 'residential-generic-v1' and catalog_id is null)::int
    as clones_missing_backfill,
  (select count(*) from public.inspection_templates where catalog_id is not null)::int
    as rows_with_catalog_id,
  -- ---- 0004: layout delta store ------------------------------------------
  (select (t.relrowsecurity and t.relforcerowsecurity)::int
     from pg_class t join pg_namespace n on n.oid = t.relnamespace
    where n.nspname='public' and t.relname='area_inspection_layouts')
    as layouts_rls_forced,
  (select count(*) from pg_policies
    where schemaname='public' and tablename='area_inspection_layouts'
      and policyname='area_inspection_layouts_member_all')::int
    as layouts_member_policy,
  (select count(*) from pg_trigger g join pg_class t on t.oid = g.tgrelid
    where t.relname='area_inspection_layouts' and g.tgname='area_inspection_layouts_audit')::int
    as layouts_audit_trigger,
  (select count(*) from pg_constraint c
    where c.conname='area_inspection_layouts_area_template_uniq' and c.contype='u')::int
    as layouts_total_unique,
  (select (has_table_privilege('authenticated','public.area_inspection_layouts','select')
       and has_table_privilege('authenticated','public.area_inspection_layouts','insert')
       and has_table_privilege('authenticated','public.area_inspection_layouts','update')
       and not has_table_privilege('authenticated','public.area_inspection_layouts','delete')
       and not has_table_privilege('anon','public.area_inspection_layouts','select')
       and not has_table_privilege('anon','public.area_inspection_layouts','insert'))::int)
    as layouts_grants_correct;
SQL
  SQL="$VERIFY_SQL" DB_URL="$DB_URL" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => {
        const v = r.rows[0];
        console.table(v);
        const want1 = [
          "member_rpc_presence_merge", "tenant_rpc_presence_merge", "tenant_rpc_acl_locked",
          "input_kind_column", "seed_carries_input_kind", "checkout_copies_input_kind",
          "catalog_id_column", "schema_hash_generated_stored",
          "layouts_rls_forced", "layouts_member_policy", "layouts_audit_trigger",
          "layouts_total_unique", "layouts_grants_correct",
        ];
        const bad = want1.filter((k) => Number(v[k]) !== 1);
        if (Number(v.mislabeled_draft_rows_remaining) !== 0) bad.push("mislabeled_draft_rows_remaining(!=0)");
        return c.end().then(() => {
          if (bad.length > 0) {
            console.error("VERIFY FAILED on: " + bad.join(", "));
            process.exit(1);
          }
          if (Number(v.clones_missing_backfill) !== 0) {
            // Clones minted between this apply and the #88 code deploy carry
            // form_code but no catalog_id (the old route did not set it).
            // Not a migration failure -- re-run the backfill once #88 is live:
            console.warn(
              "WARN: " + v.clones_missing_backfill + " clone(s) minted before the #88 deploy lack catalog_id. Heal with:\n" +
              "  update public.inspection_templates set catalog_id = schema->>\x27form_code\x27\n" +
              "   where catalog_id is null and schema->>\x27form_code\x27 in (\x27residential-generic-v1\x27);",
            );
          }
          console.log("OK: all four migrations verified (rows_with_catalog_id=" + v.rows_with_catalog_id + " backfilled).");
        });
      })
      .catch((e) => { console.error("VERIFY query failed:", e.message); process.exit(1); });
  '
}

# ============================================================================
apply() {
  local target="$1" confirmed="${2:-}"
  require_migration_files
  resolve_db_url "$target"

  bold "APPLY inspection-asks migrations -> ${target}"
  printf 'Migrations: %s\n' "${MIGRATIONS[@]}"
  [[ "$target" == "prod" ]] && echo "Target:    PROD (pooler; URL not shown)"

  bold "Pending migrations on ${target}:"
  supabase --workdir db migration list --db-url "$DB_URL"
  cat <<'EOF'

Review the list: the four 20260719 rows must show as local-only (pending) and
nothing UNEXPECTED should be pending ahead of them ('db push' applies the
whole pending set in order). If a migration you already applied shows as
local-only, prod history has drifted; repair before pushing:
  supabase --workdir db migration repair --status applied <version> --db-url "$SUPABASE_DB_URL_PROD"
EOF

  if [[ "$target" == "prod" && "$confirmed" != "confirm" ]]; then
    bold "DRY RUN — nothing applied."
    echo "To apply the pending set to PROD, re-run:"
    echo "  bash scripts/apply-inspection-asks-migrations.sh prod confirm"
    exit 0
  fi

  bold "Pushing…"
  # Reuse the repo's proven wrapper (db/ package: `supabase db push --db-url`).
  SUPABASE_DB_URL="$DB_URL" pnpm --filter ./db migrate:up

  verify
  bold "DONE — schema leads code; the merge train can proceed."
  cat <<'EOF'

Next steps after this succeeds:
  1. #86 is already merged (its code never reads the new schema; the RPC
     fixes in 0001 are live as of this apply).
  2. Merge #87 -> #88 -> #89 serially (retarget each next PR to main before
     deleting its base branch). Render auto-deploys main after each merge.
  3. After #89 lands, forward docs/inspection-asks-reply.md to the FE team —
     it tells them to regen types, drop their catalog-matching heuristic and
     defensive field round-tripping, and flip AREA_LAYOUT_SUPPORTED.
EOF
}

case "${1:-}" in
  local)  apply local ;;
  prod)   apply prod "${2:-}" ;;
  verify) resolve_db_url "${2:?usage: bash scripts/apply-inspection-asks-migrations.sh verify [local|prod]}"; verify ;;
  *) echo "usage: bash scripts/apply-inspection-asks-migrations.sh [local | prod [confirm] | verify <local|prod>]"; exit 2 ;;
esac
