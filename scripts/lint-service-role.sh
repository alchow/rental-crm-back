#!/usr/bin/env bash

# The shipped runtime may only reference the service-role credential/client
# inside api/src/admin/. Tests intentionally use privileged clients to create
# otherwise unreachable fixtures, so this production boundary scans api/src
# rather than maintaining a per-test exception list.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PATTERNS=(
  'SUPABASE_SERVICE_ROLE_KEY'
  "['\"]service_role['\"]"
)
SOURCE_PATHSPEC=':(glob)api/src/**/*.ts'

# Guard the guard: Git's plain `api/src/**/*.ts` pathspec omits files directly
# under api/src. app.ts is intentionally checked here because it is the most
# load-bearing top-level runtime file.
if ! git ls-files -- "$SOURCE_PATHSPEC" | grep -qx 'api/src/app.ts'; then
  echo "FAIL: service-role source pathspec does not include api/src/app.ts." >&2
  exit 1
fi

violations=0
for pattern in "${PATTERNS[@]}"; do
  if matches=$(git grep --untracked -nE -- "$pattern" -- \
    "$SOURCE_PATHSPEC" \
    ':!api/src/admin/**' 2>/dev/null); then
    echo "Service-role reference outside api/src/admin/:"
    echo "$matches"
    violations=$((violations + 1))
  fi
done

if [[ "$violations" -gt 0 ]]; then
  echo
  echo "FAIL: shipped service-role references must live only in api/src/admin/."
  echo "      Tests may use admin clients for fixtures; routes/middleware may not."
  exit 1
fi

echo "OK: no shipped service-role references outside api/src/admin/."
