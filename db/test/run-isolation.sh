#!/usr/bin/env bash
# Local runner for the Phase 2 isolation test. CI runs the same steps but
# uses GitHub Actions' `services:` block to host Postgres; here we spin up
# our own ephemeral container so the loop is fast on a dev machine.
#
# Usage:  bash db/test/run-isolation.sh
#         (run from anywhere — script normalises CWD)

set -euo pipefail

# Paths
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="$ROOT/db"
MIGRATIONS="$DB/supabase/migrations"
COMPAT="$DB/test/supabase_compat.sql"
SEED="$DB/test/seed_two_accounts.sql"
TEST="$DB/test/isolation.test.ts"

# Use a non-standard port so we don't fight whatever's already on 5432.
PORT="${TEST_PG_PORT:-5499}"
CONTAINER="rentalcrm-isolation-$$"
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${PORT}/postgres"

cleanup() {
  local rc=$?
  if docker ps -aq --filter "name=${CONTAINER}" | grep -q .; then
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

echo ">> launching ephemeral postgres on :${PORT} (container=${CONTAINER})"
docker run -d --rm \
  --name "${CONTAINER}" \
  -e POSTGRES_PASSWORD=postgres \
  -p "${PORT}:5432" \
  postgres:16-alpine >/dev/null

echo ">> waiting for postgres to accept connections"
for i in $(seq 1 60); do
  if docker exec "${CONTAINER}" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    echo "postgres did not become ready in 60s"
    docker logs "${CONTAINER}" | tail -40
    exit 1
  fi
done

# psql is run inside the container so we don't require a host-side psql.
run_sql() {
  local file="$1"
  docker exec -i "${CONTAINER}" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$file" >/dev/null
}

echo ">> supabase compat primer"
run_sql "$COMPAT"

echo ">> apply migrations"
shopt -s nullglob
for f in $(ls "$MIGRATIONS"/*.sql | sort); do
  echo "   - $(basename "$f")"
  run_sql "$f"
done
shopt -u nullglob

echo ">> seed two-account fixture"
run_sql "$SEED"

echo ">> run isolation test (green path: expect 0 leaks)"
cd "$ROOT"
DATABASE_URL="$DATABASE_URL" pnpm --filter ./db test:isolation

# Meaningfulness check: a passing test on its own isn't evidence the test
# would notice a leak. Plant a deliberately broken policy on one table and
# confirm the test catches it. This codifies "red on leak" as a property of
# the harness, not just a claim.
echo ""
echo ">> meaningfulness check: planting leaky policy on public.properties"
docker exec -i "${CONTAINER}" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
drop policy properties_member_all on public.properties;
create policy properties_leak on public.properties for all using (true) with check (true);
SQL

set +e
DATABASE_URL="$DATABASE_URL" pnpm --filter ./db test:isolation
leak_rc=$?
set -e

# Restore the real policy for any subsequent runs against the same DB.
docker exec -i "${CONTAINER}" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
drop policy properties_leak on public.properties;
create policy properties_member_all on public.properties
  for all using (public.is_account_member(account_id))
  with check (public.is_account_member(account_id));
SQL

if [ "$leak_rc" -eq 0 ]; then
  echo "FAIL: isolation test passed under a leaky policy on public.properties."
  echo "      The test is not meaningful — fix the harness."
  exit 1
fi
echo ">> meaningfulness check PASS: planted leak was detected"

# Phase 3 audit-spine DoD checks. Same DB; runs after the seed so the events
# table already has the seed-derived chain populated.
echo ""
echo ">> run audit-spine DoD checks"
DATABASE_URL="$DATABASE_URL" pnpm --filter ./db test:audit

# Phase 6 money-spine DoD: derived balance, reversal, allocation integrity,
# concurrent allocations, deposit segregation.
echo ""
echo ">> run money-spine DoD checks"
DATABASE_URL="$DATABASE_URL" pnpm --filter ./db test:money
