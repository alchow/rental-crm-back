#!/usr/bin/env node
/* global console, process */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(TEST_DIR, 'test-manifest.json'), 'utf8'));
const group = process.argv[2];
const entries = manifest[group];

if (!Array.isArray(entries)) {
  console.error(`Unknown test group: ${group ?? '<missing>'}`);
  console.error(`Available groups: ${Object.keys(manifest).join(', ')}`);
  process.exit(2);
}

for (const [index, entry] of entries.entries()) {
  console.info(`\n[${index + 1}/${entries.length}] ${entry.script} — ${entry.description}`);
  const result = spawnSync('pnpm', ['run', entry.script], {
    cwd: path.resolve(TEST_DIR, '..'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.info(`\nOK: ${entries.length} ${group} test scripts passed.`);
