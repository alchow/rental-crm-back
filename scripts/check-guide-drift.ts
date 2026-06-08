#!/usr/bin/env -S npx tsx
// Guide-vs-spec drift gate.
//
// docs/api-guide.md documents endpoints in markdown tables of the form
// `| `METHOD` | `path` | ... |`. The spec (openapi/openapi.json) is the
// source of truth for what's actually built -- a row in the guide with no
// matching spec entry means the guide describes something that was never
// implemented (or was implemented as a plain Hono route that never made it
// into the typed/`.openapi()` surface, e.g. the original /v1/me bug).
//
// This only checks guide -> spec (every documented row must exist in the
// spec). It does NOT check spec -> guide: several endpoints (binary
// downloads, multipart uploads) are deliberately documented as prose/code
// blocks rather than table rows, and a reverse check would flag those as
// false positives.
//
// Usage: pnpm check:guide-drift  (wired into the root `check` chain)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(ROOT, 'docs/api-guide.md');
const SPEC = path.join(ROOT, 'openapi/openapi.json');

const guideText = readFileSync(GUIDE, 'utf8');
const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as { paths: Record<string, Record<string, unknown>> };

const ROW_RE = /^\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`([^`]+)`\s*\|/gm;

// Rows in the guide are written relative to an account ("/properties",
// "/areas/{id}/...") except for the handful of top-level routes that are
// already absolute ("/v1/auth/...", "/v1/me"). Resolve both to the
// account-scoped path the spec actually registers.
function resolvePath(rawPath: string): string {
  return rawPath.startsWith('/v1/') ? rawPath : `/v1/accounts/{accountId}${rawPath}`;
}

interface Row {
  lineNo: number;
  method: Method;
  rawPath: string;
  resolved: string;
}

const rows: Row[] = [];
let m: RegExpExecArray | null;
while ((m = ROW_RE.exec(guideText))) {
  const lineNo = guideText.slice(0, m.index).split('\n').length;
  const method = m[1]!.toLowerCase() as Method;
  const rawPath = m[2]!.trim();
  rows.push({ lineNo, method, rawPath, resolved: resolvePath(rawPath) });
}

if (rows.length === 0) {
  console.error('FAIL: found zero documented endpoint rows in docs/api-guide.md -- the table regex likely needs updating.');
  process.exit(1);
}

const missing = rows.filter(({ method, resolved }) => {
  const entry = spec.paths[resolved];
  return !entry || !Object.prototype.hasOwnProperty.call(entry, method);
});

if (missing.length > 0) {
  console.error(`FAIL: ${missing.length} endpoint(s) documented in docs/api-guide.md have no matching entry in openapi/openapi.json:\n`);
  for (const { lineNo, method, rawPath, resolved } of missing) {
    console.error(`  docs/api-guide.md:${lineNo}  ${method.toUpperCase()} ${rawPath}  (resolved: ${resolved})`);
  }
  console.error(
    '\nEither the route was never wired up as a typed createRoute()/.openapi() registration\n' +
      '(see the /v1/me history -- a plain app.get() never reaches the spec), or the guide\n' +
      'documents an aspirational endpoint that was never built. Implement it, or strike the\n' +
      'row from the guide and file a ticket.',
  );
  process.exit(1);
}

console.info(`OK: all ${rows.length} endpoint rows documented in docs/api-guide.md exist in openapi/openapi.json.`);
