#!/usr/bin/env bash
# ============================================================================
# Agent-API deploy orchestrator (docs/agent-api-plan.md, executed 2026-06-12).
#
# Run from the repo root:   bash scripts/deploy-agent-api.sh
#
# WHY A SCRIPT: the deploy order is load-bearing. Render does NOT run DB
# migrations, and the new code writes columns prod does not have yet — so
# migrations MUST be applied to prod BEFORE the code push, or live journal
# writes break. This script enforces that order and pauses for the steps
# only a human with dashboard access can do.
#
# Phases (each gated by a confirmation prompt; safe to re-run — every phase
# is idempotent or read-only until you confirm):
#   A. Preflight        — clean main, prod DB URL present
#   B. Prod migrations  — list pending, confirm they are exactly the 4 new
#                         agent-api migrations, apply
#   C. Push + deploy    — git push origin main; poll /healthz until the new
#                         code is live (the capabilities.messaging key only
#                         exists in the new build)
#   D. Agent user       — create the service-account auth user (Supabase
#                         dashboard) + insert account memberships (scripted)
#   E. Render env       — AGENT_USER_ID + TWILIO_* + PUBLIC_BASE_URL
#                         (dashboard); poll healthz until configured
#   F. Janitor          — schedule reconcile_message_outbox via pg_cron
#   G. Smoke test       — pointer to the runbook procedure (manual, uses a
#                         phone you control)
#
# What you need at hand before starting:
#   * Supabase dashboard access (prod project) — for creating the agent user
#   * Render dashboard access — for env vars
#   * Twilio Console access — Account SID, Auth Token, Messaging Service SID
#     (10DLC registration completed)
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

# The public URL of the prod API (Render). Override if yours differs:
#   API_BASE_URL=https://my-api.example.com bash scripts/deploy-agent-api.sh
API_BASE_URL="${API_BASE_URL:-https://rental-crm-api.onrender.com}"

# Prod DB connection string. Pulled from .env.local (SUPABASE_DB_URL_PROD)
# unless already exported. This is the pooler URL that survived the IPv6
# incident — do not swap it for the direct db.<ref>.supabase.co host.
if [[ -z "${SUPABASE_DB_URL_PROD:-}" && -f .env.local ]]; then
  SUPABASE_DB_URL_PROD="$(grep '^SUPABASE_DB_URL_PROD=' .env.local | cut -d= -f2- || true)"
fi

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { printf '\033[33m%s\033[0m' "$*"; }

confirm() {
  ask "$1 [y/N] "
  read -r reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Stopped. Re-run when ready — completed phases are safe to repeat."; exit 1; }
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

# ============================================================================
bold "PHASE A — preflight"
# ============================================================================

[[ -n "${SUPABASE_DB_URL_PROD:-}" ]] || { echo "FATAL: SUPABASE_DB_URL_PROD not set and not found in .env.local"; exit 1; }

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || { echo "FATAL: on branch '$branch', expected main"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "FATAL: working tree not clean — commit or stash first"; exit 1; }

echo "OK: on clean main at $(git rev-parse --short HEAD); prod DB URL present."
echo "Target API: $API_BASE_URL"

# ============================================================================
bold "PHASE B — apply migrations to PROD (must happen before the code push)"
# ============================================================================

echo "Pending migrations on prod (local-only rows are about to be applied):"
npx supabase --workdir db migration list --db-url "$SUPABASE_DB_URL_PROD"

echo
echo "EXPECTED pending set — exactly these four, nothing else:"
echo "  20260616000001_journal_authorship_capacity"
echo "  20260616000002_agent_role_idempotency_ttl"
echo "  20260616000003_messaging"
echo "  20260616000004_inbound_messaging"
echo
echo "If OTHER rows show as local-only, STOP: prod's migration history has"
echo "drifted (same issue we repaired locally). Fix with, per missing version:"
echo "  npx supabase --workdir db migration repair --status applied <version> --db-url \"\$SUPABASE_DB_URL_PROD\""
echo "then re-run this script."
confirm "Pending set is exactly the four agent-api migrations — apply to prod now?"

SUPABASE_DB_URL="$SUPABASE_DB_URL_PROD" pnpm --filter ./db migrate:up
echo "OK: prod schema is ahead of prod code (additive — live app unaffected)."

# ============================================================================
bold "PHASE C — push main (Render auto-deploys)"
# ============================================================================

confirm "Push main to origin and trigger the prod deploy?"
git push origin main

echo "Waiting for the new build to come live (capabilities.messaging key"
echo "only exists in the new code; polling every 15s, up to 15 min)..."
for i in $(seq 1 60); do
  if curl -sf --max-time 10 "$API_BASE_URL/healthz" | grep -q '"messaging"'; then
    echo "OK: new build is live."
    break
  fi
  [[ "$i" == 60 ]] && { echo "TIMED OUT — check the Render dashboard deploy logs, then re-run (phases A-B re-confirm fast)."; exit 1; }
  sleep 15
done

# ============================================================================
bold "PHASE D — create the agent service-account user + memberships"
# ============================================================================

cat <<'EOF'
In the SUPABASE DASHBOARD (prod project):
  Authentication -> Users -> Add user
    email:     agent@prod.internal
    password:  generate a strong one (next line) and store it in your
               password manager — the agent service will log in with it
    check "Auto Confirm User"
EOF
echo "Suggested password (random):  $(openssl rand -base64 24)"
echo
ask "Paste the new user's UUID (from the dashboard user list): "
read -r AGENT_USER_ID
[[ "$AGENT_USER_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "FATAL: that does not look like a UUID"; exit 1; }

echo "Accounts on prod:"
prod_sql "select id, name from public.accounts where deleted_at is null order by created_at"

ask "Account UUID to enable the agent for (one for now; re-run this phase for more): "
read -r ACCOUNT_ID
[[ "$ACCOUNT_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "FATAL: not a UUID"; exit 1; }

prod_sql "insert into public.account_members (account_id, user_id, role)
          values ('$ACCOUNT_ID', '$AGENT_USER_ID', 'agent')
          on conflict (account_id, user_id) do nothing"
echo "OK: membership in place (role=agent)."

# ============================================================================
bold "PHASE E — Render environment variables"
# ============================================================================

cat <<EOF
In the RENDER DASHBOARD -> rental-crm-api -> Environment, add:

  AGENT_USER_ID                 $AGENT_USER_ID
  TWILIO_ACCOUNT_SID            (Twilio Console, starts AC)
  TWILIO_AUTH_TOKEN             (Twilio Console)
  TWILIO_MESSAGING_SERVICE_SID  (Twilio Console, starts MG)
  PUBLIC_BASE_URL               $API_BASE_URL        <- no trailing slash

Saving restarts the service. ALSO, in the TWILIO CONSOLE on the Messaging
Service: set the inbound webhook to POST $API_BASE_URL/v1/twilio/inbound
and enable Advanced Opt-Out.
EOF
confirm "Env vars saved in Render and Twilio webhook configured?"

echo "Polling healthz until messaging reports configured..."
for i in $(seq 1 40); do
  if curl -sf --max-time 10 "$API_BASE_URL/healthz" | grep -q '"configured":true'; then
    echo "OK: messaging configured."
    break
  fi
  [[ "$i" == 40 ]] && { echo "Not configured after 10 min — check the env vars and service logs."; exit 1; }
  sleep 15
done

# ============================================================================
bold "PHASE F — schedule the reconcile janitor (pg_cron)"
# ============================================================================

confirm "Schedule reconcile_message_outbox every 15 minutes via pg_cron?"
prod_sql "create extension if not exists pg_cron"
prod_sql "select cron.schedule('reconcile-message-outbox', '*/15 * * * *',
          \$\$select public.reconcile_message_outbox(3600)\$\$)" \
  || echo "pg_cron scheduling failed — schedule it from Supabase Dashboard -> Database -> Cron Jobs instead (SQL: select public.reconcile_message_outbox(3600))"

# ============================================================================
bold "PHASE G — smoke test (manual; uses a phone you control)"
# ============================================================================

cat <<'EOF'
Run the 7-step real-credential smoke test in docs/agent-runbook.md
("Real-credential smoke test"). The critical step is #4: replaying a send
with the SAME Idempotency-Key must NOT deliver a second SMS.

Deploy complete. Remaining (not deploy-blocking):
  * Give the agent-service team: the agent email + password (secret
    manager), the account id(s) enabled, and openapi/openapi.json.
  * Ask them for core-api-agent-extension.yaml to reconcile against.
  * Lovable: default-case rendering for unknown journal kinds; label the
    'agent' member role.
EOF
