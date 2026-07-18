#!/usr/bin/env node
/* global console, process */

import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'db/supabase/migrations');
const rawName = process.argv.slice(2).join('_').trim().toLowerCase();
const slug = rawName.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

if (!slug) {
  console.error('usage: pnpm db:migration:new <descriptive-name>');
  process.exit(2);
}

const versions = readdirSync(MIGRATIONS)
  .map((name) => /^(\d{14})_[a-z0-9_]+\.sql$/.exec(name)?.[1])
  .filter(Boolean)
  .map(BigInt);

if (versions.length === 0) {
  console.error('FAIL: no existing migrations found; refusing to invent a baseline version.');
  process.exit(1);
}

// The repository has intentionally pre-allocated future versions. Increment
// the repository maximum instead of using wall-clock time, which could sort a
// new migration before an already-applied migration.
const next = (versions.reduce((max, value) => (value > max ? value : max)) + 1n).toString();
const filename = `${next}_${slug}.sql`;
const target = path.join(MIGRATIONS, filename);

writeFileSync(
  target,
  `-- ${slug.replaceAll('_', ' ')}\n-- Forward-only migration. Add scope, invariants, grants, and verification notes.\n\n`,
  { flag: 'wx' },
);

console.info(path.relative(ROOT, target));
