#!/usr/bin/env bash
# ============================================================================
# Agent-API deploy orchestrator (docs/agent-api-plan.md, executed 2026-06-12).
#
# RUN IN A REGULAR TERMINAL WINDOW (Terminal.app / iTerm) — the script asks
# confirmation questions, which one-shot consoles can't answer.
#
# Stages are independent; run them when ready:
#
#   bash scripts/deploy-agent-api.sh deploy    # migrations -> push -> verify
#   bash scripts/deploy-agent-api.sh agent     # create agent user + membership
#   bash scripts/deploy-agent-api.sh           # all of the above in order
#
# `deploy` is safe without the agent user: no request can classify as the
# agent principal until the agent's role='agent' account membership row exists
# (ADR-0009; the AGENT_USER_ID env var was retired in phase 0). Nothing
# changes for the live PWA.
#
# WHY THE ORDER INSIDE `deploy` IS LOAD-BEARING: Render does NOT run DB
# migrations, and the new code writes columns prod does not have yet — so
# migrations MUST be applied to prod BEFORE the code push, or live journal
# writes break.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

# Public URL of the prod API (Render). Override by exporting API_BASE_URL.
API_BASE_URL="${API_BASE_URL:-https://rental-crm-api.onrender.com}"

# Prod DB connection string from .env.local unless already exported. This is
# the pooler URL that survived the IPv6 incident — do not swap it for the
# direct db.<ref>.supabase.co host.
if [[ -z "${SUPABASE_DB_URL_PROD:-}" && -f .env.local ]]; then
  SUPABASE_DB_URL_PROD="$(grep '^SUPABASE_DB_URL_PROD=' .env.local | cut -d= -f2- || true)"
fi

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { printf '\033[33m%s\033[0m' "$*"; }

confirm() {
  ask "$1 [y/N] "
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Stopped. Completed stages are safe; re-run this stage when ready."; exit 1; }
}

# Run a SQL statement against prod via node-pg (no psql dependency).
prod_sql() {
  SQL="$1" DB_URL="$SUPABASE_DB_URL_PROD" npx tsx -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DB_URL });
    c.connect()
      .then(() => c.query(process.env.SQL!))
      .then((r) => { if (r.rows?.length) console.table(r.rows); return c.end(); })
      .catch((e) => { console.error("SQL failed:", e.message); process.exit(1); });
  '
}

need_prod_db() {
  [[ -n "${SUPABASE_DB_URL_PROD:-}" ]] || { echo "FATAL: SUPABASE_DB_URL_PROD not set and not found in .env.local"; exit 1; }
}

# ============================================================================
stage_deploy() {
# ============================================================================
  bold "DEPLOY 1/3 — preflight"
  need_prod_db
  local branch; branch="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "main" ]] || { echo "FATAL: on branch '$branch', expected main"; exit 1; }
  [[ -z "$(git status --porcelain)" ]] || { echo "FATAL: working tree not clean — commit or stash first"; exit 1; }
  echo "OK: clean main at $(git rev-parse --short HEAD). Target: $API_BASE_URL"

  bold "DEPLOY 2/3 — apply migrations to PROD (before the code push)"
  echo "Pending migrations on prod:"
  npx supabase --workdir db migration list --db-url "$SUPABASE_DB_URL_PROD"
  cat <<'EOF'

EXPECTED pending set — exactly these four, nothing else:
  20260616000001_journal_authorship_capacity
  20260616000002_agent_role_idempotency_ttl
  20260616000003_messaging
  20260616000004_inbound_messaging

If OTHER rows show as local-only, STOP — prod history has drifted. Repair
each missing version with:
  npx supabase --workdir db migration repair --status applied <version> --db-url "$SUPABASE_DB_URL_PROD"
EOF
  confirm "Pending set is exactly the four agent-api migrations — apply to prod now?"
  SUPABASE_DB_URL="$SUPABASE_DB_URL_PROD" pnpm --filter ./db migrate:up
  echo "OK: prod schema ahead of prod code (additive — live app unaffected)."

  bold "DEPLOY 3/3 — push main (Render auto-deploys), verify live"
  confirm "Push main to origin and trigger the prod deploy?"
  git push origin main
  echo "Waiting for the new build (capabilities.heic_decode key present in"
  echo "the new code; polling every 15s, up to 15 min)..."
  for i in $(seq 1 60); do
    if curl -sf --max-time 10 "$API_BASE_URL/healthz" | grep -q '"heic_decode"'; then
      echo "OK: new build is live. The agent principal stays off until the 'agent'"
      echo "stage inserts its role='agent' membership. The PWA sees no change."
      return 0
    fi
    [[ "$i" == 60 ]] && { echo "TIMED OUT — check Render deploy logs, then re-run: bash scripts/deploy-agent-api.sh deploy"; exit 1; }
    sleep 15
  done
}

# ============================================================================
stage_agent() {
# ============================================================================
  bold "AGENT — create the service-account user + membership"
  need_prod_db
  cat <<'EOF'
In the SUPABASE DASHBOARD (prod project):
  Authentication -> Users -> Add user
    email:     agent@prod.internal
    password:  use the generated one below; store it in your password
               manager — the agent service logs in with it
    check "Auto Confirm User"
EOF
  echo "Suggested password (random):  $(openssl rand -base64 24)"
  echo
  ask "Paste the new user's UUID (from the dashboard user list): "
  read -r AGENT_USER_ID
  [[ "$AGENT_USER_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "FATAL: that does not look like a UUID"; exit 1; }

  echo "Accounts on prod:"
  prod_sql "select id, name from public.accounts where deleted_at is null order by created_at"
  ask "Account UUID to enable the agent for (re-run this stage for more): "
  read -r ACCOUNT_ID
  [[ "$ACCOUNT_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "FATAL: not a UUID"; exit 1; }

  prod_sql "insert into public.account_members (account_id, user_id, role)
            values ('$ACCOUNT_ID', '$AGENT_USER_ID', 'agent')
            on conflict (account_id, user_id) do nothing"
  cat <<EOF
OK: membership in place (role=agent) — that row IS the activation gate
(ADR-0009). The agent can act for this account as soon as it logs in; there
is NO AGENT_USER_ID env var to set (retired in ADR-0009 phase 0).

Hand to the agent-service team: the email + password, account id(s)
enabled, and openapi/openapi.json.
EOF
}

case "${1:-all}" in
  deploy) stage_deploy ;;
  agent)  stage_agent ;;
  all)    stage_deploy; stage_agent ;;
  *) echo "usage: bash scripts/deploy-agent-api.sh [deploy|agent|all]"; exit 2 ;;
esac
