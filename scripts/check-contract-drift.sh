#!/usr/bin/env bash
# Contract-drift gate.
#
# The committed openapi.json + sdk/src/generated/types.ts ARE the contract;
# the API code is just one of several callers that must match them. This
# script regenerates both from the live Hono app and asserts they're
# byte-identical to what's committed. Any diff means a route was added,
# removed, or its schema shifted -- regenerate, review, and commit.
#
# Usage: pnpm check:drift  (wired in the root package.json's check chain)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SPEC="openapi/openapi.json"
TYPES="sdk/src/generated/types.ts"

if [ ! -f "$SPEC" ]; then
  echo "FAIL: $SPEC missing — run 'pnpm --filter ./openapi emit' first."
  exit 1
fi
if [ ! -f "$TYPES" ]; then
  echo "FAIL: $TYPES missing — run 'pnpm --filter ./sdk generate' first."
  exit 1
fi

# Stash the committed copies somewhere safe so we can compare without
# leaving a regenerated artifact behind on success.
TMPDIR="$(mktemp -d)"
trap "rm -rf '$TMPDIR'" EXIT
cp "$SPEC" "$TMPDIR/openapi.committed.json"
cp "$TYPES" "$TMPDIR/types.committed.ts"

# Regenerate.
pnpm --filter ./openapi emit > /dev/null
pnpm --filter ./sdk generate > /dev/null

DRIFT=0

if ! diff -q "$TMPDIR/openapi.committed.json" "$SPEC" > /dev/null 2>&1; then
  echo "FAIL: openapi.json drift detected."
  diff -u "$TMPDIR/openapi.committed.json" "$SPEC" | head -40
  DRIFT=1
fi

if ! diff -q "$TMPDIR/types.committed.ts" "$TYPES" > /dev/null 2>&1; then
  echo "FAIL: sdk/src/generated/types.ts drift detected."
  diff -u "$TMPDIR/types.committed.ts" "$TYPES" | head -40
  DRIFT=1
fi

if [ "$DRIFT" -ne 0 ]; then
  echo
  echo "Regenerate and commit:"
  echo "  pnpm --filter ./openapi emit"
  echo "  pnpm --filter ./sdk generate"
  echo "  git add openapi/openapi.json sdk/src/generated/types.ts"
  exit 1
fi

echo "OK: openapi.json + sdk types match the live route surface."
