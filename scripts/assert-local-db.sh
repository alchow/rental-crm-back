#!/usr/bin/env bash
# Guard: refuse to let a destructive local migrate command touch a non-local
# database. `migrate:reset` runs `supabase db reset`, which DROPS AND RECREATES
# the target — catastrophic against production.
#
# `SUPABASE_DB_URL` legitimately points at PROD in the deployed Render
# environment (the onboarding-import executor connects with it, see
# api/src/admin/db-pool.ts). The hazard is a local `.env.local` that inherits
# that prod value and then runs a migrate script against it. This guard makes
# the destructive path safe by construction: it only proceeds when the target
# is a LOCAL supabase database. Deliberate PROD migrations go exclusively
# through the guarded apply scripts (scripts/apply-*-migration.sh), which use
# `SUPABASE_DB_URL_PROD`, dry-run by default, and require an explicit `confirm`.
set -euo pipefail

url="${SUPABASE_DB_URL:-}"
if [ -z "$url" ]; then
  echo "assert-local-db: SUPABASE_DB_URL is empty." >&2
  echo "  Set it to your LOCAL supabase db url, e.g. from:" >&2
  echo "    supabase status --workdir db   ->   DB_URL" >&2
  echo "    (typically postgresql://postgres:postgres@127.0.0.1:54322/postgres)" >&2
  exit 1
fi

# Local hosts only. Matches the host between '@' and the ':port'.
case "$url" in
  *@127.0.0.1:* | *@localhost:* | *@0.0.0.0:* | *@\[::1\]:*) exit 0 ;;
esac

masked="$(printf '%s' "$url" | sed -E 's#(://[^:]+:)[^@]*(@)#\1***\2#')"
echo "assert-local-db: REFUSING — SUPABASE_DB_URL is not a local database:" >&2
echo "    $masked" >&2
echo "  migrate:reset DROPS the target database; migrate scripts here run against LOCAL only." >&2
echo "  To apply a migration to PROD, use the guarded apply scripts:" >&2
echo "    scripts/apply-*-migration.sh prod confirm   (dry-run by default; uses SUPABASE_DB_URL_PROD)" >&2
exit 1
