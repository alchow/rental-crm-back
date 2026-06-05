#!/usr/bin/env bash
# Regression test for the ESLint admin-client quarantine rule.
#
# The rule forbids importing **/admin/supabase-admin* anywhere in api/src/
# except inside api/src/admin/. Without a runtime check, the rule could
# silently regress (e.g. a future eslint upgrade renames the rule, or the
# files-glob is mistyped). This script:
#
#   1. plants a violating import in api/src/middleware/__quarantine_fixture__.ts
#   2. runs ESLint and expects it to FAIL with the admin-quarantine message
#   3. removes the fixture regardless of outcome
#   4. exits 0 only if both expectations held

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FIXTURE="api/src/middleware/__quarantine_fixture__.ts"
mkdir -p "$(dirname "$FIXTURE")"

cleanup() {
  rm -f "$FIXTURE"
}
trap cleanup EXIT

cat > "$FIXTURE" <<'TS'
// Planted by scripts/test-admin-quarantine.sh; the ESLint rule should reject
// this import. If you see this file outside that script's lifetime, delete it.
import { getAdminClient } from '../admin/supabase-admin';
export const _illegal = getAdminClient;
TS

set +e
output=$(pnpm exec eslint "$FIXTURE" 2>&1)
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "FAIL: ESLint allowed the planted admin-client import."
  echo "      The admin quarantine rule has regressed."
  exit 1
fi

if ! echo "$output" | grep -q "no-restricted-imports"; then
  echo "FAIL: ESLint exited non-zero but not via no-restricted-imports:"
  echo "$output"
  exit 1
fi

if ! echo "$output" | grep -q "quarantined to src/admin"; then
  echo "FAIL: ESLint message did not match the expected admin-quarantine text."
  echo "      Got:"
  echo "$output"
  exit 1
fi

echo "OK: ESLint admin quarantine rule fires on cross-boundary imports."
