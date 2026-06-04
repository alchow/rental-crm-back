#!/usr/bin/env bash
# Fails if the Supabase service-role key/client is referenced outside api/src/admin/.
# This is the enforcement floor for the privileged-operations boundary: the
# service-role key bypasses RLS, so any reference outside its quarantine is
# treated as a security incident, not a style issue.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Patterns that indicate a service-role reference.
# - The env var name itself
# - The literal string "service_role" used as a Supabase client option
PATTERNS=(
  'SUPABASE_SERVICE_ROLE_KEY'
  '["'"'"']service_role["'"'"']'
)

# Search TypeScript/JavaScript sources only. Exclude the allowed quarantine,
# this script itself, generated artifacts, dependencies, and the dotenv files.
EXCLUDES=(
  ':!api/src/admin/**'
  ':!scripts/lint-service-role.sh'
  ':!sdk/src/generated/**'
  ':!**/dist/**'
  ':!**/build/**'
  ':!**/node_modules/**'
  ':!.env*'
  ':!.env.example'
)

violations=0
for pattern in "${PATTERNS[@]}"; do
  if matches=$(git grep -nE -- "$pattern" -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' "${EXCLUDES[@]}" 2>/dev/null); then
    echo "Service-role reference outside api/src/admin/:"
    echo "$matches"
    violations=$((violations + 1))
  fi
done

if [ "$violations" -gt 0 ]; then
  echo
  echo "FAIL: service-role references must live only in api/src/admin/."
  echo "      The service-role key bypasses RLS — keep it quarantined."
  exit 1
fi

echo "OK: no service-role references outside api/src/admin/."
