#!/usr/bin/env bash
# ============================================================================
# One-time provisioning for the off-platform DB backup workflows
# (.github/workflows/db-backup-15min.yml + db-backup-daily.yml).
# Full context & the fully-manual path: docs/backup-recovery-runbook.md.
#
# RUN IN A REGULAR TERMINAL (Terminal.app / iTerm) — it asks questions and
# reads secrets from stdin, which one-shot consoles can't answer.
#
# Stages are independent; run them when ready:
#
#   bash scripts/setup-backups.sh role      # create backup_reader + verify
#   bash scripts/setup-backups.sh secrets   # push the 9 GitHub Actions secrets
#   bash scripts/setup-backups.sh verify    # dispatch both workflows, tail them
#   bash scripts/setup-backups.sh           # all of the above, in order
#
# TWO STEPS THIS SCRIPT CANNOT DO (dashboard-only) — do them FIRST:
#   A. Cloudflare R2 -> create a bucket (e.g. rental-crm-backups) and an API
#      token scoped to it with object read / write / DELETE (delete is needed
#      for retention pruning). Note the S3 endpoint + access key id + secret.
#   B. Supabase -> Project Settings -> Storage -> S3 access keys -> generate.
#      Note the endpoint, region, access key id, and secret.
#
# Values are read from the environment / .env.local if present, otherwise the
# script prompts for them (secrets are read with `read -rs` — never echoed,
# never written to disk). Nothing here is committed.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

REPO="alchow/rental-crm-back"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { printf '\033[33m%s\033[0m' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

confirm() {
  ask "$1 [y/N] "; read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Stopped. Completed stages are safe; re-run when ready."; exit 1; }
}

# Load .env.local (KEY=VALUE lines) into the environment without clobbering
# anything already exported.
load_env_local() {
  [[ -f .env.local ]] || return 0
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [[ -z "${!k:-}" ]] && export "$k=$v"
  done < <(grep -E '^[A-Z_][A-Z0-9_]*=' .env.local || true)
}

# prompt_var VAR "Human prompt"  -> sets VAR if not already set (visible input)
prompt_var() {
  local var="$1" prompt="$2"
  [[ -n "${!var:-}" ]] && return 0
  ask "$prompt: "; read -r val; export "$var=$val"
}

# prompt_secret VAR "Human prompt" -> sets VAR if not already set (hidden input)
prompt_secret() {
  local var="$1" prompt="$2"
  [[ -n "${!var:-}" ]] && return 0
  ask "$prompt (hidden): "; read -rs val; echo; export "$var=$val"
}

# Run SQL against a connection string via node-pg (no psql dependency, matching
# scripts/deploy-agent-api.sh). Prints result rows as a table.
run_sql() {
  local url="$1" sql="$2"
  DB_URL="$url" SQL="$sql" npx --yes tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then((r) => { if (r.rows?.length) console.table(r.rows); return c.end(); })
      .catch((e) => { console.error("SQL failed:", e.message); process.exit(1); });
  '
}

# Return 0 (quietly) if the SQL succeeds, non-zero if it errors. Used for the
# best-effort auth-readability probe.
try_sql() {
  local url="$1" sql="$2"
  DB_URL="$url" SQL="$sql" npx --yes tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL))
      .then(() => c.end())
      .catch(() => process.exit(1));
  ' >/dev/null 2>&1
}

# ============================================================================
stage_role() {
# ============================================================================
  bold "ROLE 1/3 — create the read-only backup_reader role"
  command -v openssl >/dev/null || die "openssl not found (needed to generate the role password)"

  # Admin connection that can CREATE ROLE + GRANT (Supabase's postgres user).
  # Get it from Supabase Dashboard -> Connect -> the 'postgres' connection
  # string. NOT the least-privilege SUPABASE_DB_URL import role.
  prompt_secret ADMIN_DB_URL "Admin (postgres) DB connection string"
  [[ -n "${ADMIN_DB_URL:-}" ]] || die "ADMIN_DB_URL is required for this stage"

  # Hex password -> only [0-9a-f], so it is safe to interpolate into DDL and to
  # drop into a URL without escaping.
  local pw; pw="$(openssl rand -hex 24)"

  bold "ROLE 2/3 — apply DDL"
  echo "Creating role backup_reader (idempotent) and granting pg_read_all_data..."
  run_sql "$ADMIN_DB_URL" "
    do \$\$
    begin
      if not exists (select from pg_roles where rolname = 'backup_reader') then
        create role backup_reader login password '$pw';
      else
        alter role backup_reader login password '$pw';
      end if;
    end \$\$;
    grant pg_read_all_data to backup_reader;
  "
  ok "backup_reader ready."

  # Build BACKUP_DB_URL by swapping the userinfo of the admin URL for
  # backup_reader:<pw>. We reuse the admin host/port/db so the connection is a
  # direct or session-pooler endpoint (whatever the admin URL was).
  local backup_url
  backup_url="$(ADMIN_DB_URL="$ADMIN_DB_URL" BR_PW="$pw" npx --yes tsx -e '
    const u = new URL(process.env.ADMIN_DB_URL);
    u.username = "backup_reader";
    u.password = process.env.BR_PW;
    process.stdout.write(u.toString());
  ')"
  export BACKUP_DB_URL="$backup_url"

  bold "ROLE 3/3 — verify BACKUP_DB_URL"
  # Hard-fail on the transaction pooler: pg_dump cannot run there.
  local port; port="$(node -e 'process.stdout.write(new URL(process.argv[1]).port||"5432")' "$backup_url")"
  [[ "$port" == "6543" ]] && die "BACKUP_DB_URL points at the transaction pooler (port 6543). pg_dump fails there — use the direct (5432) or session-pooler URL. Fix the admin URL and re-run."
  echo "port $port (not the transaction pooler) — good."

  echo "Reading public schema as backup_reader..."
  run_sql "$backup_url" "select count(*) as public_tables from information_schema.tables where table_schema='public';"

  if try_sql "$backup_url" "select 1 from auth.users limit 1"; then
    ok "backup_reader can read auth.users — the auth-identities dump will be captured."
  else
    echo "NOTE: backup_reader cannot read auth.users. The workflow's auth dump degrades to a warning; login identities will not be in backups (see runbook Gotchas + Restore §A)."
  fi

  bold "BACKUP_DB_URL (store this — the 'secrets' stage will set it as a GitHub secret):"
  echo "$backup_url"
  echo
  echo "It is now exported in this shell, so you can chain: bash scripts/setup-backups.sh secrets"
}

# ============================================================================
stage_secrets() {
# ============================================================================
  bold "SECRETS — set the 9 GitHub Actions repo secrets on $REPO"

  prompt_secret BACKUP_DB_URL                    "BACKUP_DB_URL (backup_reader connection; from the 'role' stage)"
  prompt_var    BACKUP_S3_ENDPOINT               "BACKUP_S3_ENDPOINT (e.g. https://<accountid>.r2.cloudflarestorage.com)"
  prompt_var    BACKUP_S3_BUCKET                 "BACKUP_S3_BUCKET (e.g. rental-crm-backups)"
  prompt_secret BACKUP_S3_ACCESS_KEY_ID          "BACKUP_S3_ACCESS_KEY_ID (R2 token key id)"
  prompt_secret BACKUP_S3_SECRET_ACCESS_KEY      "BACKUP_S3_SECRET_ACCESS_KEY (R2 token secret)"
  prompt_var    SUPABASE_STORAGE_S3_ENDPOINT     "SUPABASE_STORAGE_S3_ENDPOINT (https://wywfplbylmpfafxyaqpq.storage.supabase.co/storage/v1/s3)"
  prompt_secret SUPABASE_STORAGE_S3_ACCESS_KEY_ID     "SUPABASE_STORAGE_S3_ACCESS_KEY_ID"
  prompt_secret SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY "SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY"
  prompt_var    SUPABASE_STORAGE_S3_REGION       "SUPABASE_STORAGE_S3_REGION (region shown on the Storage S3-keys page)"

  local names=(
    BACKUP_DB_URL BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET
    BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY
    SUPABASE_STORAGE_S3_ENDPOINT SUPABASE_STORAGE_S3_ACCESS_KEY_ID
    SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY SUPABASE_STORAGE_S3_REGION
  )

  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    confirm "Set all 9 secrets on $REPO via gh now?"
    for n in "${names[@]}"; do
      # Pipe the value on stdin (gh reads stdin when no --body/--body-file is
      # given). Do NOT use `--body -`: that sets the secret to the literal
      # string "-" and ignores stdin.
      [[ -n "${!n:-}" ]] || die "$n is empty — refusing to store a blank secret. Re-run and provide a value."
      printf '%s' "${!n}" | gh secret set "$n" --repo "$REPO"
      ok "set $n"
    done
    echo; gh secret list --repo "$REPO"
  else
    bold "gh CLI not available/authed — run these yourself (values are in your shell):"
    for n in "${names[@]}"; do
      echo "  gh secret set $n --repo $REPO   # (paste the $n value)"
    done
    echo
    echo "Or add them in the GitHub UI: Settings -> Secrets and variables -> Actions."
  fi
}

# ============================================================================
stage_verify() {
# ============================================================================
  bold "VERIFY — dispatch both workflows and tail the runs"
  command -v gh >/dev/null && gh auth status >/dev/null 2>&1 \
    || die "gh CLI required for this stage. Alternatively dispatch from the Actions tab (see runbook §2.5)."

  echo "Triggering db-backup-15min..."
  gh workflow run db-backup-15min.yml --repo "$REPO"
  echo "Triggering db-backup-daily with verify_restore=true..."
  gh workflow run db-backup-daily.yml --repo "$REPO" -f verify_restore=true

  echo "Recent runs (watch them go green; ctrl-C to stop watching):"
  sleep 4
  gh run list --repo "$REPO" --limit 5
  echo
  echo "Confirm a db-<stamp>.dump landed under pg/15min/ in the bucket, and that"
  echo "the daily 'verify-restore' job passed. Then MERGE this branch to main —"
  echo "scheduled workflows only fire from the default branch."
}

# ============================================================================
load_env_local
case "${1:-all}" in
  role)    stage_role ;;
  secrets) stage_secrets ;;
  verify)  stage_verify ;;
  all)     stage_role; stage_secrets; stage_verify ;;
  *)       die "unknown stage '$1' (use: role | secrets | verify | <none>)" ;;
esac
ok "Done: ${1:-all}."
