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

# Search TypeScript/JavaScript sources only. Exclude:
#   - the allowed quarantine
#   - this script itself
#   - generated artifacts and dependencies / dotenv files
#   - api/test/api-isolation.test.ts: sets process.env from supabase status so
#     the app under test sees the same env it gets in CI. The variable name is
#     ASSIGNED, never read into a client constructor.
#   - api/test/attachments.test.ts / intake.test.ts / phase9.test.ts /
#     phase10.test.ts / phase11.test.ts / phase12.test.ts /
#     interactions-journal.test.ts / agent-grants.test.ts /
#     agent-tokens.test.ts: integration tests that read rows back via the
#     admin client to verify what the system actually stored (audit
#     attribution, storage path, derived_from chain, byte-for-byte
#     immutability of corrected interactions, unreachable fixture states like
#     a soft-deleted membership, agent grant membership lifecycle, agent token
#     exchange, document access events, and RLS-denial mapping).
#     These are TEST code, never shipped; the quarantine defends production
#     runtime, and verification of that runtime sits on the other side of the
#     boundary by design.
#   - api/test/imports.test.ts / imports-live.test.ts: same shape as
#     api-isolation.test.ts -- assigns process.env from supabase status so the
#     app under test (and its raw-pg executor pool) sees the same env it gets
#     in CI. The variable name is ASSIGNED, never read into a client
#     constructor in these files.
#   - openapi/emit.ts: same shape -- assigns a placeholder to process.env so
#     the env schema parse succeeds at spec-emit time. No client is built.
EXCLUDES=(
  ':!api/src/admin/**'
  ':!scripts/lint-service-role.sh'
  ':!sdk/src/generated/**'
  ':!**/dist/**'
  ':!**/build/**'
  ':!**/node_modules/**'
  ':!.env*'
  ':!.env.example'
  ':!api/test/api-isolation.test.ts'
  #   - api/test/search.test.ts: same shape as api-isolation.test.ts -- assigns
  #     process.env from supabase status so the app under test (whose signup
  #     path uses the admin GoTrue API) sees the CI env. ASSIGNED, never read
  #     into a client constructor in this file.
  ':!api/test/search.test.ts'
  ':!api/test/attachments.test.ts'
  ':!api/test/documents.test.ts'
  ':!api/test/intake.test.ts'
  ':!api/test/phase9.test.ts'
  ':!api/test/phase10.test.ts'
  ':!api/test/phase11.test.ts'
  ':!api/test/phase12.test.ts'
  ':!api/test/interactions-journal.test.ts'
  ':!api/test/agent-principal.test.ts'
  ':!api/test/agent-grants.test.ts'
  ':!api/test/agent-tokens.test.ts'
  #   - api/test/agent-membership-divergence.test.ts: induces an out-of-band
  #     agent-membership soft-delete via the admin client and reads the row back
  #     to assert the grant<->membership invariant (the 2026-06-25 incident
  #     regression). TEST code; assigns process.env from supabase status and
  #     uses the admin client only to set up/verify an unreachable fixture state.
  ':!api/test/agent-membership-divergence.test.ts'
  ':!api/test/events-feed.test.ts'
  ':!api/test/imports.test.ts'
  ':!api/test/imports-live.test.ts'
  # api/test/ledger.test.ts / bench-import.ts: same shape as
  # api-isolation.test.ts -- assign process.env (ledger: from supabase
  # status; bench: a placeholder so the admin env schema parses) so the code
  # under test sees the env it gets in CI. ASSIGNED, never read into a
  # client constructor in these files.
  ':!api/test/ledger.test.ts'
  ':!api/test/bench-import.ts'
  ':!openapi/emit.ts'
)

violations=0
for pattern in "${PATTERNS[@]}"; do
  # --untracked: catch NEW files before they're committed -- the gate ran
  # clean locally twice while a fresh test file violated it, because plain
  # git grep only scans tracked content.
  if matches=$(git grep --untracked -nE -- "$pattern" -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' "${EXCLUDES[@]}" 2>/dev/null); then
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
