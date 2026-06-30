#!/usr/bin/env bash
# Fails if any non-allowlisted public SECURITY DEFINER function in the database
# is executable by the `anon` or `authenticated` role.
# Mirrors the CI guard at db/test/check_definer_grants.sql.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/check-definer-grants.sh   # explicit DB
#   ./scripts/check-definer-grants.sh                               # local Supabase stack
#
# Resolution order: psql + DATABASE_URL -> psql + `supabase status` DB_URL ->
# (no host psql, e.g. macOS) run inside the local supabase_db_* container.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$ROOT/db/test/check_definer_grants.sql"

if command -v psql >/dev/null 2>&1; then
  if [ -n "${DATABASE_URL:-}" ]; then
    echo "Checking SECURITY DEFINER grants via DATABASE_URL..."
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$GUARD"
  else
    echo "No DATABASE_URL set; resolving DB_URL from local Supabase stack..."
    DB_URL="$(supabase status --output env --workdir "$ROOT/db" 2>/dev/null \
      | grep '^DB_URL=' | cut -d= -f2-)"
    if [ -z "$DB_URL" ]; then
      echo "ERROR: could not resolve DB_URL from 'supabase status'." \
           "Is the local Supabase stack running?" >&2
      exit 1
    fi
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$GUARD"
  fi
else
  # No host psql (common on macOS dev boxes). Fall back to the running local
  # Supabase database container.
  CID="$(docker ps --filter 'name=supabase_db_' --format '{{.Names}}' 2>/dev/null | head -1)"
  if [ -z "$CID" ]; then
    echo "ERROR: 'psql' not on PATH and no running supabase_db_* container found." \
         "Install psql (brew install libpq) or start the local Supabase stack." >&2
    exit 1
  fi
  echo "psql not found; running guard inside container $CID..."
  docker exec -i "$CID" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$GUARD"
fi

echo "OK: SECURITY DEFINER grant check passed."
