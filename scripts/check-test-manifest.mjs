#!/usr/bin/env node
/* global console, process */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'api/package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'api/test/test-manifest.json'), 'utf8'));
const expectedGroups = ['unit', 'integration', 'manual'];

const unknownGroups = Object.keys(manifest).filter((group) => !expectedGroups.includes(group));
if (unknownGroups.length > 0) {
  console.error(`FAIL: unknown test-manifest group(s): ${unknownGroups.join(', ')}`);
  process.exit(1);
}

const classified = new Map();
for (const group of expectedGroups) {
  const entries = manifest[group];
  if (!Array.isArray(entries)) {
    console.error(`FAIL: test-manifest group '${group}' must be an array.`);
    process.exit(1);
  }
  for (const entry of entries) {
    if (!entry || typeof entry.script !== 'string' || typeof entry.description !== 'string') {
      console.error(`FAIL: every '${group}' entry needs string script + description fields.`);
      process.exit(1);
    }
    const prior = classified.get(entry.script);
    if (prior) {
      console.error(`FAIL: ${entry.script} is classified in both '${prior}' and '${group}'.`);
      process.exit(1);
    }
    classified.set(entry.script, group);
  }
}

const scripts = Object.keys(pkg.scripts)
  .filter((name) => name.startsWith('test:'))
  .sort();
const missing = scripts.filter((name) => !classified.has(name));
const stale = [...classified.keys()].filter((name) => !scripts.includes(name)).sort();

if (missing.length > 0 || stale.length > 0) {
  if (missing.length > 0)
    console.error(`FAIL: unclassified API test scripts: ${missing.join(', ')}`);
  if (stale.length > 0)
    console.error(`FAIL: manifest entries without package scripts: ${stale.join(', ')}`);
  console.error(
    'Classify each test as unit, integration, or manual in api/test/test-manifest.json.',
  );
  process.exit(1);
}

console.info(
  `OK: all ${scripts.length} API test scripts are classified ` +
    `(${expectedGroups.map((group) => `${group}=${manifest[group].length}`).join(', ')}).`,
);
