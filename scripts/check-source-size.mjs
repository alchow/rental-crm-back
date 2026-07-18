#!/usr/bin/env node
/* global console, process */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(ROOT, 'api/src');
const MAX_LINES = 1000;
const EXCLUDED = new Set([path.join(SOURCE_ROOT, 'supabase/database.types.ts')]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : [];
  });
}

const oversized = sourceFiles(SOURCE_ROOT)
  .filter((file) => !EXCLUDED.has(file))
  .map((file) => {
    const source = readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
    return { file: path.relative(ROOT, file), lines };
  })
  .filter(({ lines }) => lines > MAX_LINES)
  .sort((a, b) => b.lines - a.lines);

if (oversized.length > 0) {
  console.error(`FAIL: handwritten API source modules may not exceed ${MAX_LINES} lines:`);
  for (const { file, lines } of oversized) console.error(`  ${lines}  ${file}`);
  console.error('Split route groups or domain services behind a stable facade.');
  process.exit(1);
}

console.info(`OK: handwritten API source modules are at most ${MAX_LINES} lines.`);
